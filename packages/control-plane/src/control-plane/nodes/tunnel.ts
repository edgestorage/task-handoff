import { z } from "zod";
import { PassThrough, Readable } from "node:stream";
import { WebSocket as WsClient } from "ws";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  InstanceLifecycleEventType,
  InstanceLifecycleSnapshotSchema,
  InstanceResourceMetricsEventType,
  InstanceResourceMetricsSchema,
  type InstanceLifecycleSnapshot,
  type InstanceResourceMetrics,
  type Node,
} from "@task-handoff/protocol/control-plane";
import { SessionStreamsHelloSchema, type SessionStreamsHello } from "@task-handoff/protocol/events";
import { bridgeWebSockets, type WebSocketLike } from "@task-handoff/protocol/websocket-bridge";
import type { ControlPlaneService } from "../application/service.ts";
import type { NodeAgentTransport } from "./client.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import { createNodeAgentHmacHeaders, hmacHeadersFromRecord, sha256Hex, signNodeAgentRequest, timingSafeHexEqual, NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS } from "../../shared/security/node-agent-auth.ts";
import { createNodeAgentIpcWebSocket, parseNodeAgentIpcEndpoint } from "../../shared/transport/node-agent-ipc.ts";
import { EventConnectionRetryTimer, eventConnectionSafetyIntervalMs } from "../../shared/events/connection-retry.ts";

const NodeAgentTunnelQuerySchema = z
  .object({
    nodeId: z.string().trim().min(1).max(120),
  })
  .strict();

type NodeAgentSocket = {
  send: (data: string | Buffer) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  readyState: number;
};

type TunnelErrorPayload = {
  code: string;
  message: string;
};

function nodeAgentRemoteAuth(node: Node) {
  return node.auth.mode === "paired-hmac" && node.auth.secret
    ? { keyId: node.auth.keyId, secret: node.auth.secret }
    : undefined;
}

function requireNodeAgentRemoteKeyId(node: Node, keyId: string | undefined) {
  if (!keyId) {
    throw Object.assign(new Error(`Node ${node.id} paired-HMAC auth is missing keyId.`), { statusCode: 500, code: "NODE_AGENT_REMOTE_KEY_ID_MISSING" });
  }
  return keyId;
}

function nodeAgentLocalStaticToken(node: Node) {
  if (node.connectionMode !== "local-ipc" && node.connectionMode !== "local-loopback") {
    return undefined;
  }
  return node.auth.mode === "local-static-key" ? node.auth.secret : undefined;
}

function createDirectNodeAgentAuthHeaders(node: Node, input: { method: string; pathWithQuery: string }) {
  const remoteAuth = nodeAgentRemoteAuth(node);
  if (remoteAuth) {
    return createNodeAgentHmacHeaders({
      nodeId: node.id,
      keyId: requireNodeAgentRemoteKeyId(node, remoteAuth.keyId),
      secret: remoteAuth.secret,
      method: input.method,
      pathWithQuery: input.pathWithQuery,
    });
  }
  const token = nodeAgentLocalStaticToken(node);
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

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
  const pathWithQuery = request.url || `/api/node-agent/tunnel?nodeId=${encodeURIComponent(node.id)}`;
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
  private readonly sockets = new Map<string, {
    socket: { send: (data: string) => void; readyState?: number };
    pending: Map<string, { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
    streams: Map<string, { downstream: WebSocketLike; upstream?: WebSocketLike; pendingFrames: Array<{ data: unknown; isBinary: boolean }> }>;
    httpStreams: Map<string, { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; body?: PassThrough; socket?: NodeAgentSocket; settled: boolean }>;
  }>();
  private readonly events?: ControlPlaneEventBus;
  private readonly onStreamsHello?: (instanceId: string, hello: SessionStreamsHello) => void | Promise<void>;
  private readonly validateInstanceScope?: (nodeId: string, instanceId: string) => boolean | Promise<boolean>;
  private readonly validatedInstanceScopes = new Map<string, number>();

  constructor(events?: ControlPlaneEventBus, options: {
    onStreamsHello?: (instanceId: string, hello: SessionStreamsHello) => void | Promise<void>;
    validateInstanceScope?: (nodeId: string, instanceId: string) => boolean | Promise<boolean>;
  } = {}) {
    this.events = events;
    this.onStreamsHello = options.onStreamsHello;
    this.validateInstanceScope = options.validateInstanceScope;
  }

  attach(nodeId: string, socket: { send: (data: string) => void; readyState?: number; on?: (event: string, listener: (...args: unknown[]) => void) => void }) {
    const current = this.sockets.get(nodeId);
    if (current) {
      for (const entry of current.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`Reverse tunnel for node ${nodeId} was replaced.`));
      }
      for (const [streamId, stream] of current.streams) {
        current.streams.delete(streamId);
        stream.downstream.close(1011, "Reverse tunnel was replaced.");
      }
      for (const stream of current.httpStreams.values()) {
        clearTimeout(stream.timer);
        stream.body?.destroy(new Error(`Reverse tunnel for node ${nodeId} was replaced.`));
        if (!stream.settled) stream.reject(new Error(`Reverse tunnel for node ${nodeId} was replaced.`));
      }
    }
    const pending = new Map<string, { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    this.sockets.set(nodeId, { socket, pending, streams: new Map(), httpStreams: new Map() });
    socket.on?.("close", () => this.detach(nodeId, socket));
    socket.on?.("error", () => this.detach(nodeId, socket));
  }

  detach(nodeId: string, socket?: { send: (data: string) => void }) {
    const current = this.sockets.get(nodeId);
    if (!current || (socket && current.socket !== socket)) {
      return;
    }
    this.sockets.delete(nodeId);
    for (const entry of current.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Reverse tunnel for node ${nodeId} disconnected.`));
    }
    for (const [streamId, stream] of current.streams) {
      current.streams.delete(streamId);
      stream.downstream.close(1011, "Reverse tunnel disconnected.");
    }
    for (const stream of current.httpStreams.values()) {
      clearTimeout(stream.timer);
      stream.body?.destroy(new Error(`Reverse tunnel for node ${nodeId} disconnected.`));
      if (!stream.settled) stream.reject(new Error(`Reverse tunnel for node ${nodeId} disconnected.`));
    }
  }

  handleMessage(nodeId: string, message: Record<string, unknown>) {
    if (this.handleNodeAgentEvent(nodeId, message)) {
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

  private handleNodeAgentEvent(nodeId: string, message: Record<string, unknown>) {
    const type = typeof message.type === "string" ? message.type : "";
    if (type === "node-agent.streams.hello") {
      const instanceId = typeof message.instanceId === "string" ? message.instanceId : "";
      const hello = SessionStreamsHelloSchema.safeParse(message.payload);
      if (instanceId && hello.success) void this.onStreamsHello?.(instanceId, hello.data);
      return true;
    }
    if (!type.startsWith("node-agent.event.")) {
      return false;
    }
    const event = message.event && typeof message.event === "object" && !Array.isArray(message.event) ? message.event as Record<string, unknown> : undefined;
    const eventType = typeof event?.type === "string" ? event.type : "";
    if (!eventType) {
      return true;
    }
    const payload = "payload" in event ? event.payload : {};
    const scope = event.scope && typeof event.scope === "object" && !Array.isArray(event.scope) ? event.scope as Record<string, unknown> : {};
    const forwardedInstanceId = typeof message.instanceId === "string" ? message.instanceId : undefined;
    if (eventType === InstanceResourceMetricsEventType.Snapshot) {
      const metrics = InstanceResourceMetricsSchema.safeParse(payload);
      const scopeInstanceId = typeof scope.instanceId === "string" ? scope.instanceId : typeof event.instanceId === "string" ? event.instanceId : forwardedInstanceId;
      if (!metrics.success || metrics.data.instanceId !== scopeInstanceId) return true;
      void this.publishValidatedMetrics(nodeId, metrics.data, scope);
      return true;
    }
    if (eventType === InstanceLifecycleEventType.Snapshot) {
      const lifecycle = InstanceLifecycleSnapshotSchema.safeParse(payload);
      const scopeInstanceId = typeof scope.instanceId === "string" ? scope.instanceId : typeof event.instanceId === "string" ? event.instanceId : forwardedInstanceId;
      if (!lifecycle.success || lifecycle.data.instanceId !== scopeInstanceId) return true;
      void this.publishValidatedLifecycle(nodeId, lifecycle.data, scope);
      return true;
    }
    this.events?.publish(eventType, payload, {
      topic: typeof event.topic === "string" ? event.topic : undefined,
      scope: {
        ...scope,
        nodeId,
        instanceId: typeof scope.instanceId === "string" ? scope.instanceId : typeof event.instanceId === "string" ? event.instanceId : forwardedInstanceId,
      },
    });
    return true;
  }

  private async publishValidatedMetrics(nodeId: string, metrics: InstanceResourceMetrics, scope: Record<string, unknown>) {
    const valid = await this.isValidatedInstanceScope(nodeId, metrics.instanceId);
    if (!valid) return;
    this.events?.publish(InstanceResourceMetricsEventType.Snapshot, metrics, {
      topic: "instances",
      scope: { ...scope, nodeId, instanceId: metrics.instanceId },
    });
  }

  private async publishValidatedLifecycle(nodeId: string, lifecycle: InstanceLifecycleSnapshot, scope: Record<string, unknown>) {
    const valid = await this.isValidatedInstanceScope(nodeId, lifecycle.instanceId);
    if (!valid) return;
    this.events?.publish(InstanceLifecycleEventType.Snapshot, lifecycle, {
      topic: "instances",
      scope: { ...scope, nodeId, instanceId: lifecycle.instanceId },
    });
  }

  private async isValidatedInstanceScope(nodeId: string, instanceId: string) {
    const cacheKey = `${nodeId}:${instanceId}`;
    const now = Date.now();
    if ((this.validatedInstanceScopes.get(cacheKey) || 0) > now) return true;
    let valid = false;
    try {
      valid = Boolean(await this.validateInstanceScope?.(nodeId, instanceId));
    } catch {
      valid = false;
    }
    if (valid) this.validatedInstanceScopes.set(cacheKey, now + 30_000);
    return valid;
  }

  async request(node: { id: string }, route: string, init: RequestInit = {}) {
    const current = this.sockets.get(node.id);
    if (!current) {
      const error = new Error(`Reverse tunnel for node ${node.id} is not connected.`);
      Object.assign(error, { statusCode: 503, code: "NODE_AGENT_REVERSE_TUNNEL_OFFLINE" });
      throw error;
    }
    const requestId = createRequestId();
    const body = typeof init.body === "string" ? init.body : init.body === undefined || init.body === null ? undefined : String(init.body);
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
      const timer = setTimeout(() => {
        current.pending.delete(requestId);
        const error = new Error(`Reverse tunnel request to ${node.id}${route} timed out.`);
        Object.assign(error, { statusCode: 504, code: "NODE_AGENT_REVERSE_REQUEST_TIMEOUT" });
        reject(error);
      }, 30_000);
      current.pending.set(requestId, { resolve, reject, timer });
      current.socket.send(JSON.stringify(payload));
    });
  }

  async requestStream(node: { id: string }, route: string, init: RequestInit = {}) {
    const current = this.sockets.get(node.id);
    if (!current) {
      throw Object.assign(new Error(`Reverse tunnel for node ${node.id} is not connected.`), { statusCode: 503, code: "NODE_AGENT_REVERSE_TUNNEL_OFFLINE" });
    }
    const streamId = createRequestId();
    const body = typeof init.body === "string" ? init.body : init.body === undefined || init.body === null ? undefined : String(init.body);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        current.httpStreams.delete(streamId);
        reject(Object.assign(new Error(`Reverse tunnel stream to ${node.id}${route} timed out.`), { statusCode: 504, code: "NODE_AGENT_REVERSE_STREAM_TIMEOUT" }));
      }, 30_000);
      current.httpStreams.set(streamId, { resolve, reject, timer, settled: false });
      current.socket.send(JSON.stringify({
        type: "control-plane.http.open",
        streamId,
        route,
        init: { method: init.method || "GET", headers: requestHeaders(init.headers), body },
      }));
    });
  }

  attachHttpStream(nodeId: string, streamId: string, socket: NodeAgentSocket) {
    const current = this.sockets.get(nodeId);
    const stream = current?.httpStreams.get(streamId);
    if (!current || !stream) {
      socket.close(1008, "Unknown reverse HTTP stream.");
      return false;
    }
    stream.socket = socket;
    const fail = (error: Error) => {
      clearTimeout(stream.timer);
      current.httpStreams.delete(streamId);
      if (!stream.settled) {
        stream.settled = true;
        stream.reject(error);
      } else {
        stream.body?.destroy(error);
      }
    };
    socket.on("message", (raw: unknown, isBinary: unknown) => {
      if (isBinary) {
        if (!stream.body) return fail(new Error("Reverse HTTP stream received data before response headers."));
        if (!stream.body.write(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))) {
          (socket as NodeAgentSocket & { pause?: () => void }).pause?.();
          stream.body.once("drain", () => (socket as NodeAgentSocket & { resume?: () => void }).resume?.());
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
          if (current.httpStreams.delete(streamId) && socket.readyState === 1) socket.close(1000, "HTTP consumer closed.");
        });
        stream.resolve(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers }));
        return;
      }
      if (message.type === "node-agent.http.end") {
        current.httpStreams.delete(streamId);
        stream.body?.end();
        if (!stream.settled) fail(new Error("Reverse HTTP stream ended before response headers."));
        return;
      }
      if (message.type === "node-agent.http.error") {
        fail(new Error(typeof message.message === "string" ? message.message : "Reverse HTTP stream failed."));
      }
    });
    socket.on("close", () => {
      if (current.httpStreams.has(streamId)) fail(new Error("Reverse HTTP stream disconnected."));
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
        current.streams.delete(streamId);
        downstream.close(1011, "Reverse tunnel send failed.");
      }
    };
    const entry = { downstream, pendingFrames: [] as Array<{ data: unknown; isBinary: boolean }> };
    current.streams.set(streamId, entry);
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
        current.streams.delete(streamId);
        stream.upstream?.close(typeof code === "number" ? code : 1000, Buffer.isBuffer(reason) ? reason.toString("utf8") : typeof reason === "string" ? reason : "");
        sendTunnel({
          type: "control-plane.websocket.close",
          streamId,
          code: typeof code === "number" ? code : 1000,
          reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : typeof reason === "string" ? reason : "",
        });
      }
    });
    downstream.on("error", () => {
      const stream = current.streams.get(streamId);
      if (stream) {
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
        current.streams.delete(streamId);
      },
      onClientError: () => {
        current.streams.delete(streamId);
      },
      onUpstreamClose: () => {
        current.streams.delete(streamId);
      },
      onUpstreamError: () => {
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
      current?.streams.delete(streamId);
      stream.downstream.close(typeof message.code === "number" ? message.code : 1000, typeof message.reason === "string" ? message.reason : "");
      return true;
    }
    if (type === "node-agent.websocket.error") {
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
    get: (path: string, options: { websocket: true }, handler: (socket: NodeAgentSocket, request: { query?: unknown; params?: unknown; headers: Record<string, unknown>; url?: string }) => void) => void;
  };
  service: ControlPlaneService;
  nodeAgentTunnel: ControlPlaneNodeAgentTunnelTransport;
  errorPayload: (error: unknown) => TunnelErrorPayload;
}) {
  const { app, service, nodeAgentTunnel, errorPayload } = options;

  app.get("/api/node-agent/tunnel", { websocket: true }, (socket, request) => {
    try {
      const parsed = NodeAgentTunnelQuerySchema.parse(request.query);
      const node = service.requireNode(parsed.nodeId);
      verifyTunnelHmac(node, request);
      nodeAgentTunnel.attach(node.id, socket);

      socket.send(
        JSON.stringify({
          type: "control-plane.hello",
          protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
          nodeId: node.id,
          serverTime: new Date().toISOString(),
          capabilities: {
            reverseTunnel: "request-response",
            httpResponseStreaming: true,
            lifecycleCommands: true,
            instanceApiProxy: true,
          },
        }),
      );

      socket.on("message", (raw) => {
        let message: unknown;
        try {
          message = JSON.parse(String(raw));
        } catch {
          socket.send(JSON.stringify({ type: "control-plane.error", code: "INVALID_JSON" }));
          return;
        }
        const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
        if (nodeAgentTunnel.handleMessage(node.id, record)) {
          return;
        }
        if (record.type === "node-agent.ping") {
          socket.send(
            JSON.stringify({
              type: "control-plane.pong",
              nodeId: node.id,
              serverTime: new Date().toISOString(),
            }),
          );
          return;
        }
        if (record.type === "node-agent.identify") {
          socket.send(
            JSON.stringify({
              type: "control-plane.identified",
              nodeId: node.id,
              serverTime: new Date().toISOString(),
            }),
          );
          return;
        }
        socket.send(JSON.stringify({ type: "control-plane.error", code: "UNSUPPORTED_MESSAGE" }));
      });
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

  app.get("/api/node-agent/tunnel/streams/:streamId", { websocket: true }, (socket, request) => {
    try {
      const parsed = NodeAgentTunnelQuerySchema.parse(request.query);
      const node = service.requireNode(parsed.nodeId);
      verifyTunnelHmac(node, request);
      const streamId = (request.params as { streamId: string }).streamId;
      nodeAgentTunnel.attachWebSocketStream(node.id, streamId, socket);
    } catch (error) {
      const payload = errorPayload(error);
      socket.close(1008, payload.message);
    }
  });

  app.get("/api/node-agent/tunnel/http-streams/:streamId", { websocket: true }, (socket, request) => {
    try {
      const parsed = NodeAgentTunnelQuerySchema.parse(request.query);
      const node = service.requireNode(parsed.nodeId);
      verifyTunnelHmac(node, request);
      const streamId = (request.params as { streamId: string }).streamId;
      nodeAgentTunnel.attachHttpStream(node.id, streamId, socket);
    } catch (error) {
      const payload = errorPayload(error);
      socket.close(1008, payload.message);
    }
  });
}
