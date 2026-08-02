import { z } from "zod";
import { PassThrough, Readable } from "node:stream";
import { WebSocket as WsClient } from "ws";
import {
  encodeNodeTunnelRequestBody,
  type Node,
} from "@task-handoff/protocol/control-plane";
import type { EventEnvelope, SessionStreamsHello } from "@task-handoff/protocol/events";
import { bridgeWebSockets, closeWebSocket, normalizeWebSocketCloseCode, normalizeWebSocketCloseReason, type WebSocketLike } from "@task-handoff/protocol/websocket-bridge";
import type { ControlPlaneService } from "../application/service.ts";
import type { NodeAgentTransport } from "./client.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import { createDirectNodeAgentAuthHeaders, hmacHeadersFromRecord, sha256Hex, signNodeAgentRequest, timingSafeHexEqual, NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS, NODE_TUNNEL_API_PATH } from "../../shared/security/node-agent-auth.ts";
import { NODE_TUNNEL_ROUTE } from "../http/auth-boundary.ts";
import { createNodeAgentIpcWebSocket, parseNodeAgentIpcEndpoint } from "../../shared/transport/node-agent-ipc.ts";
import { EventConnectionRetryTimer, eventConnectionSafetyIntervalMs } from "../../shared/events/connection-retry.ts";
import { NodeTunnelIngress, type NodeAgentTunnelSocket } from "./tunnel-ingress.ts";
import { NodeTunnelEventRouter } from "./tunnel-event-router.ts";

const NodeAgentTunnelQuerySchema = z
  .object({
    nodeId: z.string().trim().min(1).max(120),
  })
  .strict();

type ReverseTunnelSocket = {
  send: (data: string) => void;
  close?: (code?: number, reason?: string) => void;
  readyState?: number;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
};

type ReverseHttpStreamEntry = {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  body?: PassThrough;
  socket?: NodeAgentTunnelSocket;
  settled: boolean;
  finalized: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type ReversePendingRequest = {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type ReverseTunnelConnection = {
  socket: ReverseTunnelSocket;
  pending: Map<string, ReversePendingRequest>;
  streams: Map<string, { downstream: WebSocketLike; upstream?: WebSocketLike; pendingFrames: Array<{ data: unknown; isBinary: boolean }> }>;
  httpStreams: Map<string, ReverseHttpStreamEntry>;
  pendingChannels: Map<string, PendingNodeTunnelChannel>;
};

export type PendingNodeTunnelChannel = {
  id: string;
  attach: (socket: NodeAgentTunnelSocket) => boolean;
  cancel: (error: Error, reason: string) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type TunnelErrorPayload = {
  code: string;
  message: string;
};

function createRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const usedTunnelNonces = new Map<string, number>();

function verifyTunnelHmac(node: Node, request: { headers: Record<string, unknown>; url?: string }) {
  if (node.auth.mode !== "paired-hmac" || !node.auth.keyId || !node.auth.secret) {
    const error = new Error("Reverse tunnel requires paired-HMAC node auth.");
    Object.assign(error, { statusCode: 401, code: "NODE_AGENT_TUNNEL_REQUIRES_PAIRED_HMAC" });
    throw error;
  }
  const headers = hmacHeadersFromRecord(request.headers);
  if (headers.nodeId !== node.id) {
    throw Object.assign(new Error("Invalid reverse tunnel node id."), { statusCode: 401, code: "NODE_AGENT_TUNNEL_NODE_MISMATCH" });
  }
  if (headers.keyId !== node.auth.keyId) {
    throw Object.assign(new Error("Invalid reverse tunnel key id."), { statusCode: 401, code: "NODE_AGENT_TUNNEL_KEY_INVALID" });
  }
  const timestampMs = Date.parse(headers.timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS) {
    throw Object.assign(new Error("Reverse tunnel timestamp is outside the allowed window."), { statusCode: 401, code: "NODE_AGENT_TUNNEL_TIMESTAMP_INVALID" });
  }
  const cutoff = Date.now() - NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS;
  for (const [key, expiresAt] of usedTunnelNonces) {
    if (expiresAt <= cutoff) {
      usedTunnelNonces.delete(key);
    }
  }
  const nonceKey = `${node.id}:${headers.keyId}:${headers.nonce}`;
  if (!headers.nonce || usedTunnelNonces.has(nonceKey)) {
    throw Object.assign(new Error("Reverse tunnel nonce is invalid."), { statusCode: 401, code: "NODE_AGENT_TUNNEL_NONCE_INVALID" });
  }
  const bodySha256 = sha256Hex("");
  if (headers.bodySha256 !== bodySha256) {
    throw Object.assign(new Error("Reverse tunnel body hash is invalid."), { statusCode: 401, code: "NODE_AGENT_TUNNEL_BODY_HASH_INVALID" });
  }
  const pathWithQuery = request.url || `${NODE_TUNNEL_API_PATH}?nodeId=${encodeURIComponent(node.id)}`;
  const expected = signNodeAgentRequest(node.auth.secret, {
    keyId: headers.keyId,
    method: "GET",
    pathWithQuery,
    timestamp: headers.timestamp,
    nonce: headers.nonce,
    bodySha256,
  });
  if (!timingSafeHexEqual(headers.signature, expected)) {
    throw Object.assign(new Error("Reverse tunnel signature is invalid."), { statusCode: 401, code: "NODE_AGENT_TUNNEL_SIGNATURE_INVALID" });
  }
  usedTunnelNonces.set(nonceKey, Date.now() + NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS);
}

function requestHeaders(headers: HeadersInit | undefined) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

export class ControlPlaneNodeAgentTunnelTransport implements NodeAgentTransport {
  private readonly sockets = new Map<string, ReverseTunnelConnection>();
  private readonly eventRouter: NodeTunnelEventRouter;
  private readonly httpStreamHeaderTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly auxiliaryAttachTimeoutMs: number;

  constructor(events?: ControlPlaneEventBus, options: {
    onStreamsHello?: (instanceId: string, hello: SessionStreamsHello) => void | Promise<void>;
    onSessionEvent?: (event: EventEnvelope) => boolean;
    validateInstanceScope?: (nodeId: string, instanceId: string) => boolean | Promise<boolean>;
    httpStreamHeaderTimeoutMs?: number;
    requestTimeoutMs?: number;
    auxiliaryAttachTimeoutMs?: number;
  } = {}) {
    this.eventRouter = new NodeTunnelEventRouter({
      events,
      onStreamsHello: options.onStreamsHello,
      onSessionEvent: options.onSessionEvent,
      validateInstanceScope: options.validateInstanceScope,
    });
    this.httpStreamHeaderTimeoutMs = options.httpStreamHeaderTimeoutMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.auxiliaryAttachTimeoutMs = options.auxiliaryAttachTimeoutMs ?? 30_000;
  }

  attach(nodeId: string, socket: ReverseTunnelSocket) {
    const current = this.sockets.get(nodeId);
    if (current?.socket === socket) return;
    if (current) this.invalidateInstanceScope({ nodeId });
    const pending = new Map<string, ReversePendingRequest>();
    const next: ReverseTunnelConnection = {
      socket,
      pending,
      streams: new Map(),
      httpStreams: new Map(),
      pendingChannels: new Map(),
    };
    this.sockets.set(nodeId, next);
    socket.on?.("close", () => this.detach(nodeId, socket));
    socket.on?.("error", () => this.detach(nodeId, socket));
    if (current && current.socket !== socket) {
      this.finalizeConnection(current, new Error(`Reverse tunnel for node ${nodeId} was replaced.`), "Reverse tunnel was replaced.", true);
    }
  }

  detach(nodeId: string, socket?: ReverseTunnelSocket) {
    const current = this.sockets.get(nodeId);
    if (!current || (socket && current.socket !== socket)) {
      return;
    }
    this.sockets.delete(nodeId);
    this.invalidateInstanceScope({ nodeId });
    this.finalizeConnection(current, new Error(`Reverse tunnel for node ${nodeId} disconnected.`), "Reverse tunnel disconnected.", true);
  }

  disconnect(nodeId: string, reason = "Node connection disabled locally.") {
    const current = this.sockets.get(nodeId);
    if (!current) return false;
    this.detach(nodeId, current.socket);
    current.socket.close?.(1000, reason);
    return true;
  }

  connected(nodeId: string) {
    return this.sockets.has(nodeId);
  }

  private finalizeConnection(connection: ReverseTunnelConnection, error: Error, reason: string, closeMainSocket: boolean) {
    for (const requestId of [...connection.pending.keys()]) this.cancelPendingRequest(connection, requestId, error, false);
    for (const [streamId, stream] of connection.streams) {
      connection.streams.delete(streamId);
      stream.downstream.close(1011, reason);
    }
    for (const streamId of [...connection.httpStreams.keys()]) {
      this.cancelHttpStream(connection, streamId, error, reason, false);
    }
    for (const pending of connection.pendingChannels.values()) clearTimeout(pending.timer);
    connection.pendingChannels.clear();
    if (closeMainSocket && connection.socket.close && connection.socket.readyState !== 3) {
      try {
        connection.socket.close(1000, reason);
      } catch {
        // Connection state is already finalized even if the transport cannot close cleanly.
      }
    }
  }

  isCurrentSocket(nodeId: string, socket: { send: (data: string) => void }) {
    return this.sockets.get(nodeId)?.socket === socket;
  }

  handleSocketMessage(nodeId: string, socket: { send: (data: string) => void }, message: Record<string, unknown>) {
    if (!this.isCurrentSocket(nodeId, socket)) return undefined;
    return this.handleMessage(nodeId, message);
  }

  handleMessage(nodeId: string, message: Record<string, unknown>) {
    if (this.eventRouter.handle(nodeId, message)) {
      return true;
    }
    if (this.handleWebSocketMessage(nodeId, message)) {
      return true;
    }
    if (message.type !== "node-agent.response") {
      return false;
    }
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    const current = this.sockets.get(nodeId);
    const entry = current?.pending.get(requestId);
    if (!entry || !current) {
      return true;
    }
    current.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    const status = Number(message.status) || 502;
    const headers = message.headers && typeof message.headers === "object" ? message.headers as Record<string, string> : {};
    const body = typeof message.body === "string" ? message.body : "";
    if (message.error && typeof message.error === "object") {
      const record = message.error as Record<string, unknown>;
      const error = new Error(typeof record.message === "string" ? record.message : `Reverse tunnel request failed with HTTP ${status}`);
      Object.assign(error, { statusCode: status, code: typeof record.code === "string" ? record.code : "NODE_AGENT_REVERSE_REQUEST_FAILED" });
      entry.reject(error);
      return true;
    }
    entry.resolve(new Response(body, { status, headers }));
    return true;
  }

  invalidateInstanceScope(input: { nodeId?: string; instanceId?: string } = {}) {
    this.eventRouter.invalidate(input);
  }

  instanceScopeDiagnostics() {
    return this.eventRouter.diagnostics();
  }

  async request(node: { id: string }, route: string, init: RequestInit = {}) {
    const current = this.sockets.get(node.id);
    if (!current) {
      const error = new Error(`Reverse tunnel for node ${node.id} is not connected.`);
      Object.assign(error, { statusCode: 503, code: "NODE_AGENT_REVERSE_TUNNEL_OFFLINE" });
      throw error;
    }
    const requestId = createRequestId();
    const body = encodeNodeTunnelRequestBody(init.body);
    const payload = {
      type: "control-plane.request",
      requestId,
      route,
      init: {
        method: init.method || "GET",
        headers: requestHeaders(init.headers),
        body,
      },
    };
    return new Promise<Response>((resolve, reject) => {
      let entry: ReversePendingRequest;
      const timer = setTimeout(() => {
        const error = new Error(`Reverse tunnel request to ${node.id}${route} timed out.`);
        Object.assign(error, { statusCode: 504, code: "NODE_AGENT_REVERSE_REQUEST_TIMEOUT" });
        this.cancelPendingRequest(current, requestId, error);
      }, this.requestTimeoutMs);
      entry = {
        resolve,
        reject,
        timer,
        signal: init.signal || undefined,
      };
      if (init.signal) {
        entry.onAbort = () => {
          this.cancelPendingRequest(
            current,
            requestId,
            Object.assign(new Error("Reverse tunnel request was aborted."), { name: "AbortError", code: "ABORT_ERR" }),
          );
        };
        init.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      current.pending.set(requestId, entry);
      if (init.signal?.aborted) {
        entry.onAbort?.();
        return;
      }
      try {
        current.socket.send(JSON.stringify(payload));
      } catch (error) {
        this.cancelPendingRequest(current, requestId, error instanceof Error ? error : new Error(String(error)), false);
      }
    });
  }

  private cancelPendingRequest(
    current: ReverseTunnelConnection,
    requestId: string,
    error: Error,
    notifyNode = true,
  ) {
    const entry = current.pending.get(requestId);
    if (!entry) return false;
    current.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    entry.reject(error);
    if (notifyNode) {
      try {
        current.socket.send(JSON.stringify({ type: "control-plane.request.cancel", requestId }));
      } catch {
        // The request is already settled locally even if the tunnel closed concurrently.
      }
    }
    return true;
  }

  async requestStream(node: { id: string }, route: string, init: RequestInit = {}) {
    const current = this.sockets.get(node.id);
    if (!current) {
      throw Object.assign(new Error(`Reverse tunnel for node ${node.id} is not connected.`), { statusCode: 503, code: "NODE_AGENT_REVERSE_TUNNEL_OFFLINE" });
    }
    const streamId = createRequestId();
    const body = encodeNodeTunnelRequestBody(init.body);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancelHttpStream(
          current,
          streamId,
          Object.assign(new Error(`Reverse tunnel stream to ${node.id}${route} timed out.`), { statusCode: 504, code: "NODE_AGENT_REVERSE_STREAM_TIMEOUT" }),
          "Reverse HTTP stream header timeout.",
        );
      }, this.httpStreamHeaderTimeoutMs);
      const stream: ReverseHttpStreamEntry = { resolve, reject, timer, settled: false, finalized: false, signal: init.signal || undefined };
      current.httpStreams.set(streamId, stream);
      this.registerPendingChannel(current, {
        id: streamId,
        attach: (socket) => this.attachHttpStreamChannel(node.id, streamId, socket),
        cancel: (error, reason) => { this.cancelHttpStream(current, streamId, error, reason); },
      }, "Reverse HTTP channel attach timed out.");
      if (init.signal) {
        stream.onAbort = () => this.cancelHttpStream(
          current,
          streamId,
          Object.assign(new Error("Reverse HTTP stream consumer disconnected."), { name: "AbortError", code: "ABORT_ERR" }),
          "HTTP consumer disconnected.",
        );
        init.signal.addEventListener("abort", stream.onAbort, { once: true });
        if (init.signal.aborted) {
          stream.onAbort();
          return;
        }
      }
      try {
        current.socket.send(JSON.stringify({
          type: "control-plane.http.open",
          streamId,
          route,
          init: { method: init.method || "GET", headers: requestHeaders(init.headers), body },
        }));
      } catch (error) {
        this.cancelHttpStream(current, streamId, error instanceof Error ? error : new Error(String(error)), "Reverse tunnel send failed.", false);
      }
    });
  }

  private cancelHttpStream(current: ReverseTunnelConnection, streamId: string, error: Error, reason: string, notifyNode = true) {
    const stream = current.httpStreams.get(streamId);
    if (!stream || stream.finalized) return false;
    stream.finalized = true;
    current.httpStreams.delete(streamId);
    this.removePendingChannel(current, streamId);
    clearTimeout(stream.timer);
    if (stream.signal && stream.onAbort) stream.signal.removeEventListener("abort", stream.onAbort);
    if (!stream.settled) {
      stream.settled = true;
      stream.reject(error);
    } else {
      stream.body?.destroy(error);
    }
    if (stream.socket?.readyState === 1) stream.socket.close(1000, reason);
    if (notifyNode) {
      try {
        current.socket.send(JSON.stringify({ type: "control-plane.http.cancel", streamId, reason }));
      } catch {
        // The child socket close above still cancels an already-bound node request.
      }
    }
    return true;
  }

  private completeHttpStream(current: ReverseTunnelConnection, streamId: string) {
    const stream = current.httpStreams.get(streamId);
    if (!stream || stream.finalized) return false;
    stream.finalized = true;
    current.httpStreams.delete(streamId);
    this.removePendingChannel(current, streamId);
    clearTimeout(stream.timer);
    if (stream.signal && stream.onAbort) stream.signal.removeEventListener("abort", stream.onAbort);
    stream.body?.end();
    return true;
  }

  attachAuxiliary(nodeId: string, channelId: string, socket: NodeAgentTunnelSocket) {
    const current = this.sockets.get(nodeId);
    const pending = current?.pendingChannels.get(channelId);
    if (!current || !pending) {
      socket.close(1008, "Unknown reverse tunnel channel.");
      return false;
    }
    this.removePendingChannel(current, channelId);
    return pending.attach(socket);
  }

  private registerPendingChannel(current: ReverseTunnelConnection, pending: PendingNodeTunnelChannel, reason: string) {
    this.removePendingChannel(current, pending.id);
    pending.timer = setTimeout(() => {
      if (current.pendingChannels.get(pending.id) !== pending) return;
      current.pendingChannels.delete(pending.id);
      pending.cancel(Object.assign(new Error(reason), { code: "NODE_AGENT_REVERSE_CHANNEL_ATTACH_TIMEOUT" }), reason);
    }, this.auxiliaryAttachTimeoutMs);
    pending.timer.unref?.();
    current.pendingChannels.set(pending.id, pending);
  }

  private removePendingChannel(current: ReverseTunnelConnection, channelId: string) {
    const pending = current.pendingChannels.get(channelId);
    if (pending?.timer) clearTimeout(pending.timer);
    current.pendingChannels.delete(channelId);
    return pending;
  }

  attachHttpStream(nodeId: string, streamId: string, socket: NodeAgentTunnelSocket) {
    return this.attachAuxiliary(nodeId, streamId, socket);
  }

  private attachHttpStreamChannel(nodeId: string, streamId: string, socket: NodeAgentTunnelSocket) {
    const current = this.sockets.get(nodeId);
    const stream = current?.httpStreams.get(streamId);
    if (!current || !stream) {
      socket.close(1008, "Unknown reverse HTTP stream.");
      return false;
    }
    stream.socket = socket;
    const fail = (error: Error) => {
      this.cancelHttpStream(current, streamId, error, "Reverse HTTP stream failed.");
    };
    socket.on("message", (raw: unknown, isBinary: unknown) => {
      if (stream.finalized || current.httpStreams.get(streamId) !== stream) return;
      if (isBinary) {
        if (!stream.body) return fail(new Error("Reverse HTTP stream received data before response headers."));
        if (!stream.body.write(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))) {
          (socket as NodeAgentTunnelSocket & { pause?: () => void }).pause?.();
          stream.body.once("drain", () => (socket as NodeAgentTunnelSocket & { resume?: () => void }).resume?.());
        }
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        fail(new Error("Reverse HTTP stream sent invalid JSON control data."));
        return;
      }
      if (message.type === "node-agent.http.head") {
        if (stream.settled) return;
        clearTimeout(stream.timer);
        const status = Number(message.status) || 502;
        const headers = message.headers && typeof message.headers === "object" ? message.headers as Record<string, string> : {};
        const body = new PassThrough({ highWaterMark: 64 * 1024 });
        stream.body = body;
        stream.settled = true;
        body.once("close", () => {
          this.cancelHttpStream(current, streamId, new Error("Reverse HTTP stream consumer closed."), "HTTP consumer closed.");
        });
        stream.resolve(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers }));
        return;
      }
      if (message.type === "node-agent.http.end") {
        if (!stream.settled) {
          fail(new Error("Reverse HTTP stream ended before response headers."));
        } else {
          this.completeHttpStream(current, streamId);
        }
        return;
      }
      if (message.type === "node-agent.http.error") {
        fail(new Error(typeof message.message === "string" ? message.message : "Reverse HTTP stream failed."));
      }
    });
    socket.on("close", () => {
      fail(new Error("Reverse HTTP stream disconnected."));
    });
    socket.on("error", () => fail(new Error("Reverse HTTP stream failed.")));
    return true;
  }

  proxyWebSocket(
    node: Node,
    downstream: WebSocketLike,
    route: string,
    protocols?: string | string[],
    headers: Record<string, string> = {},
  ) {
    const nodeId = node.id;
    const current = this.sockets.get(nodeId);
    if (!current) {
      downstream.close(1011, "Reverse tunnel is not connected.");
      return;
    }
    const streamId = createRequestId();
    const sendTunnel = (payload: Record<string, unknown>) => {
      try {
        current.socket.send(JSON.stringify(payload));
      } catch {
        this.removePendingChannel(current, streamId);
        current.streams.delete(streamId);
        downstream.close(1011, "Reverse tunnel send failed.");
      }
    };
    const entry = { downstream, pendingFrames: [] as Array<{ data: unknown; isBinary: boolean }> };
    current.streams.set(streamId, entry);
    this.registerPendingChannel(current, {
      id: streamId,
      attach: (socket) => this.attachWebSocketStreamChannel(nodeId, streamId, socket),
      cancel: (_error, reason) => {
        this.removePendingChannel(current, streamId);
        current.streams.delete(streamId);
        downstream.close(1011, reason);
      },
    }, "Reverse websocket channel attach timed out.");
    sendTunnel({
      type: "control-plane.websocket.open",
      streamId,
      route,
      protocols: Array.isArray(protocols) ? protocols : protocols ? [protocols] : [],
      headers,
    });
    downstream.on("message", (data, isBinary) => {
      const stream = current.streams.get(streamId);
      if (!stream) {
        return;
      }
      if (stream.upstream) {
        return;
      }
      if (stream.pendingFrames.length >= 256) {
        this.removePendingChannel(current, streamId);
        current.streams.delete(streamId);
        downstream.close(1011, "Reverse websocket stream pending frame limit exceeded.");
        sendTunnel({ type: "control-plane.websocket.close", streamId, code: 1011, reason: "Reverse websocket stream pending frame limit exceeded." });
        return;
      }
      stream.pendingFrames.push({ data, isBinary: Boolean(isBinary) });
    });
    downstream.on("close", (code, reason) => {
      const stream = current.streams.get(streamId);
      if (stream) {
        this.removePendingChannel(current, streamId);
        current.streams.delete(streamId);
        const closeCode = normalizeWebSocketCloseCode(code);
        const closeReason = normalizeWebSocketCloseReason(reason);
        if (stream.upstream) closeWebSocket(stream.upstream, closeCode, closeReason);
        sendTunnel({
          type: "control-plane.websocket.close",
          streamId,
          ...(closeCode === undefined ? {} : { code: closeCode }),
          ...(closeReason ? { reason: closeReason } : {}),
        });
      }
    });
    downstream.on("error", () => {
      const stream = current.streams.get(streamId);
      if (stream) {
        this.removePendingChannel(current, streamId);
        current.streams.delete(streamId);
        stream.upstream?.close(1011, "Downstream websocket failed.");
        sendTunnel({ type: "control-plane.websocket.close", streamId, code: 1011, reason: "Downstream websocket failed." });
      }
    });
  }

  attachWebSocketStream(
    nodeId: string,
    streamId: string,
    upstream: WebSocketLike,
  ) {
    return this.attachAuxiliary(nodeId, streamId, upstream as NodeAgentTunnelSocket);
  }

  private attachWebSocketStreamChannel(
    nodeId: string,
    streamId: string,
    upstream: WebSocketLike,
  ) {
    const current = this.sockets.get(nodeId);
    const stream = current?.streams.get(streamId);
    if (!current || !stream) {
      upstream.close(1008, "Unknown reverse websocket stream.");
      return false;
    }
    stream.upstream = upstream;
    for (const frame of stream.pendingFrames.splice(0)) {
      upstream.send(frame.data, { binary: frame.isBinary });
    }
    bridgeWebSockets(stream.downstream, upstream, {
      pendingFrameLimit: 256,
      onClientClose: () => {
        this.removePendingChannel(current, streamId);
        current.streams.delete(streamId);
      },
      onClientError: () => {
        this.removePendingChannel(current, streamId);
        current.streams.delete(streamId);
      },
      onUpstreamClose: () => {
        this.removePendingChannel(current, streamId);
        current.streams.delete(streamId);
      },
      onUpstreamError: () => {
        this.removePendingChannel(current, streamId);
        current.streams.delete(streamId);
      },
    });
    return true;
  }

  private handleWebSocketMessage(nodeId: string, message: Record<string, unknown>) {
    const type = typeof message.type === "string" ? message.type : "";
    if (!type.startsWith("node-agent.websocket.")) {
      return false;
    }
    const current = this.sockets.get(nodeId);
    const streamId = typeof message.streamId === "string" ? message.streamId : "";
    const stream = current?.streams.get(streamId);
    if (!stream) {
      return true;
    }
    if (type === "node-agent.websocket.close") {
      if (current) this.removePendingChannel(current, streamId);
      current?.streams.delete(streamId);
      closeWebSocket(stream.downstream, message.code, message.reason);
      return true;
    }
    if (type === "node-agent.websocket.error") {
      if (current) this.removePendingChannel(current, streamId);
      current?.streams.delete(streamId);
      stream.downstream.close(1011, typeof message.message === "string" ? message.message : "Reverse websocket proxy failed.");
      return true;
    }
    return true;
  }
}

export class ControlPlaneNodeEventSubscriber {
  private readonly sockets = new Map<string, WsClient>();
  private readonly socketUrls = new Map<string, string>();
  private readonly retries = new Map<string, { timer: EventConnectionRetryTimer; url?: string }>();
  private readonly service: ControlPlaneService;
  private readonly tunnel: ControlPlaneNodeAgentTunnelTransport;
  private readonly safetyIntervalMs: number;
  private readonly logger?: { info?: (data: Record<string, unknown>, message?: string) => void };
  private reconnectAttempts = 0;
  private safetyReconciliations = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    service: ControlPlaneService,
    tunnel: ControlPlaneNodeAgentTunnelTransport,
    options: { safetyIntervalMs?: number; logger?: { info?: (data: Record<string, unknown>, message?: string) => void } } = {},
  ) {
    this.service = service;
    this.tunnel = tunnel;
    this.safetyIntervalMs = eventConnectionSafetyIntervalMs(options.safetyIntervalMs);
    this.logger = options.logger;
  }

  start() {
    this.sync();
    this.timer = setInterval(() => {
      this.safetyReconciliations += 1;
      this.sync();
    }, this.safetyIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const socket of this.sockets.values()) {
      socket.close();
    }
    this.sockets.clear();
    this.socketUrls.clear();
    for (const retry of this.retries.values()) retry.timer.cancel();
    this.retries.clear();
  }

  syncNow() {
    this.sync();
  }

  diagnostics() {
    return { reconnectAttempts: this.reconnectAttempts, safetyReconciliations: this.safetyReconciliations, activeConnections: this.sockets.size, pendingRetries: [...this.retries.values()].filter((entry) => entry.timer.pending).length, safetyIntervalMs: this.safetyIntervalMs };
  }

  private sync() {
    const active = new Set<string>();
    for (const node of this.service.listNodes()) {
      const url = this.nodeEventsUrl(node);
      if (!url) {
        continue;
      }
      active.add(node.id);
      const scheduledRetry = this.retries.get(node.id);
      if (scheduledRetry?.timer.pending && scheduledRetry.url !== url) {
        scheduledRetry.timer.cancel();
        this.retries.delete(node.id);
      }
      if (this.socketUrls.get(node.id) !== url && this.sockets.has(node.id)) {
        this.sockets.get(node.id)?.close();
        this.sockets.delete(node.id);
      }
      if (!this.sockets.has(node.id) && !this.retries.get(node.id)?.timer.pending) {
        this.connect(node, url);
      }
    }
    for (const [nodeId, socket] of this.sockets) {
      if (!active.has(nodeId)) {
        socket.close();
        this.sockets.delete(nodeId);
        this.socketUrls.delete(nodeId);
        const retry = this.retries.get(nodeId);
        retry?.timer.cancel();
        this.retries.delete(nodeId);
      }
    }
    for (const [nodeId, retry] of this.retries) {
      if (!active.has(nodeId)) {
        retry.timer.cancel();
        this.retries.delete(nodeId);
        this.socketUrls.delete(nodeId);
      }
    }
  }

  private connect(node: Node, url: string) {
    const ipcPath = parseNodeAgentIpcEndpoint(url);
    const pathWithQuery = "/api/node-agent/events";
    const parsedUrl = ipcPath ? undefined : new URL(url);
    const authHeaders = createDirectNodeAgentAuthHeaders(node, {
      method: "GET",
      pathWithQuery: parsedUrl ? `${parsedUrl.pathname}${parsedUrl.search}` : pathWithQuery,
    });
    const socket = ipcPath
      ? createNodeAgentIpcWebSocket(ipcPath, "/events", undefined, authHeaders)
      : new WsClient(url, {
          headers: authHeaders,
        });
    this.sockets.set(node.id, socket);
    this.socketUrls.set(node.id, url);
    socket.on("open", () => {
      const retry = this.retries.get(node.id);
      retry?.timer.reset();
      this.retries.set(node.id, { timer: retry?.timer || new EventConnectionRetryTimer(), url });
    });
    socket.on("message", (raw) => {
      if (this.sockets.get(node.id) !== socket) return;
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const record = message as Record<string, unknown>;
        const forwardedMessage = typeof record.type === "string" && record.type.startsWith("node-agent.")
          ? record
          : { type: "node-agent.event.forwarded", event: record };
        this.tunnel.handleMessage(node.id, forwardedMessage);
      }
    });
    socket.on("close", () => {
      if (this.sockets.get(node.id) === socket) {
        this.sockets.delete(node.id);
        this.socketUrls.delete(node.id);
        this.scheduleReconnect(node.id);
      }
    });
    socket.on("error", () => {
      socket.close();
    });
  }

  private scheduleReconnect(nodeId: string) {
    const node = this.service.listNodes().find((candidate) => candidate.id === nodeId);
    const url = node && this.nodeEventsUrl(node);
    if (!node || !url) return;
    const current = this.retries.get(nodeId) ?? { timer: new EventConnectionRetryTimer() };
    if (current.timer.pending) return;
    current.url = url;
    const scheduled = current.timer.schedule(() => {
      if (!this.sockets.has(nodeId)) this.connect(node, url);
    });
    if (scheduled) {
      this.reconnectAttempts += 1;
      this.logger?.info?.({ nodeId, url, attempt: scheduled.attempt, delay: scheduled.delay, reconnectAttempts: this.reconnectAttempts }, "session-stream.node-connection.reconnect-scheduled");
    }
    this.retries.set(nodeId, current);
  }

  private nodeEventsUrl(node: Node) {
    if (node.connectionEnabled === false) return undefined;
    const endpoint = node.controlEndpoint || node.endpoint;
    if (!endpoint || node.connectionMode === "reverse-wss") {
      return undefined;
    }
    if (parseNodeAgentIpcEndpoint(endpoint)) {
      return endpoint;
    }
    try {
      const url = new URL("/api/node-agent/events", endpoint.replace(/\/$/, ""));
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    } catch {
      return undefined;
    }
  }
}

export function registerNodeAgentTunnelRoutes(options: {
  app: {
    get: (path: string, options: { websocket: true; config?: typeof NODE_TUNNEL_ROUTE }, handler: (socket: NodeAgentTunnelSocket, request: { query?: unknown; params?: unknown; headers: Record<string, unknown>; url?: string }) => void) => void;
    log?: { warn?: (data: Record<string, unknown>, message?: string) => void };
  };
  service: ControlPlaneService;
  nodeAgentTunnel: ControlPlaneNodeAgentTunnelTransport;
  errorPayload: (error: unknown) => TunnelErrorPayload;
}) {
  const { app, service, nodeAgentTunnel, errorPayload } = options;
  const ingress = new NodeTunnelIngress(nodeAgentTunnel);
  const requireTunnelEnabled = (node: Node) => {
    if (node.connectionEnabled === false) {
      const error = new Error("Node agent connection is disabled locally.");
      Object.assign(error, { statusCode: 409, code: "NODE_AGENT_CONNECTION_DISABLED" });
      throw error;
    }
  };

  app.get(NODE_TUNNEL_API_PATH, { websocket: true, config: NODE_TUNNEL_ROUTE }, (socket, request) => {
    try {
      const parsed = NodeAgentTunnelQuerySchema.parse(request.query);
      const node = service.requireNode(parsed.nodeId);
      verifyTunnelHmac(node, request);
      requireTunnelEnabled(node);
      ingress.attachMain(node.id, socket);
    } catch (error) {
      const payload = errorPayload(error);
      socket.send(
        JSON.stringify({
          type: "control-plane.error",
          code: payload.code,
          message: payload.message,
        }),
      );
      socket.close(1008, payload.message);
    }
  });

  app.get(`${NODE_TUNNEL_API_PATH}/streams/:streamId`, { websocket: true, config: NODE_TUNNEL_ROUTE }, (socket, request) => {
    try {
      const parsed = NodeAgentTunnelQuerySchema.parse(request.query);
      const node = service.requireNode(parsed.nodeId);
      verifyTunnelHmac(node, request);
      requireTunnelEnabled(node);
      const streamId = (request.params as { streamId: string }).streamId;
      ingress.attachAuxiliary(node.id, streamId, socket);
    } catch (error) {
      const payload = errorPayload(error);
      socket.close(1008, payload.message);
    }
  });

  app.get(`${NODE_TUNNEL_API_PATH}/channels/:channelId`, { websocket: true, config: NODE_TUNNEL_ROUTE }, (socket, request) => {
    try {
      const parsed = NodeAgentTunnelQuerySchema.parse(request.query);
      const node = service.requireNode(parsed.nodeId);
      verifyTunnelHmac(node, request);
      requireTunnelEnabled(node);
      const channelId = (request.params as { channelId: string }).channelId;
      ingress.attachAuxiliary(node.id, channelId, socket);
    } catch (error) {
      const payload = errorPayload(error);
      socket.close(1008, payload.message);
    }
  });

  app.get(`${NODE_TUNNEL_API_PATH}/http-streams/:streamId`, { websocket: true, config: NODE_TUNNEL_ROUTE }, (socket, request) => {
    try {
      const parsed = NodeAgentTunnelQuerySchema.parse(request.query);
      const node = service.requireNode(parsed.nodeId);
      verifyTunnelHmac(node, request);
      requireTunnelEnabled(node);
      const streamId = (request.params as { streamId: string }).streamId;
      ingress.attachAuxiliary(node.id, streamId, socket);
    } catch (error) {
      const payload = errorPayload(error);
      socket.close(1008, payload.message);
    }
  });
}
