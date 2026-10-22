import WebSocket from "ws";
import { decodeNodeTunnelRequestBody } from "@task-handoff/protocol/control-plane";
import {
  bridgeWebSockets,
  closeWebSocket,
  normalizeWebSocketCloseCode,
  normalizeWebSocketCloseReason,
} from "@task-handoff/protocol/websocket-bridge";
import { nodeAgentProxyMethod, type NodeAgentInjectResponse } from "../transport/proxy-utils.ts";

/**
 * Minimal ws-like socket the tunnel protocol runs on. The reverse-tunnel
 * WebSocket, the cloud-relay channel socket and every auxiliary stream socket
 * (HTTP response streams, bridged WebSockets) all satisfy this port.
 */
export type NodeTunnelSessionSocket = {
  readyState: number;
  send(data: string | Buffer, options?: { binary?: boolean; compress?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
};

export type NodeTunnelEventForwardSocket = { send(data: string): void };

export type NodeTunnelSessionEventForwarder = {
  addOutput(socket: NodeTunnelEventForwardSocket, options?: { expectsTransientSubscription?: boolean; legacyFallbackMs?: number }): () => void;
  setOutputSubscription?(socket: NodeTunnelEventForwardSocket, input: unknown, eventEnvelopeVersion?: unknown, aiSessionHierarchy?: unknown): boolean;
};

export type NodeTunnelSessionHost = {
  log: {
    warn(data: Record<string, unknown>, message: string): void;
  };
  inject(input: {
    method: ReturnType<typeof nodeAgentProxyMethod>;
    url: string;
    headers: Record<string, string>;
    payload?: string | Buffer;
    signal?: AbortSignal;
  }): Promise<NodeAgentInjectResponse>;
  nodeAgentEventForwarder?: NodeTunnelSessionEventForwarder;
  currentListenerPort(): number | string;
};

export type NodeTunnelSessionOptions = {
  nodeId: string;
  /** Main socket carrying the tunnel protocol. */
  socket: NodeTunnelSessionSocket;
  host: NodeTunnelSessionHost;
  /** Dials the auxiliary socket for one stream: an HTTP response stream or a bridged WebSocket. */
  openAuxSocket(streamId: string, kind: "http" | "websocket"): Promise<NodeTunnelSessionSocket>;
  /** Builds the final headers (incoming init headers plus local node-agent auth) for one injected request. */
  buildLocalHeaders(route: string, method: string, body: string | Buffer | undefined, headers: Record<string, string>): Record<string, string>;
  /** URL the host injects for one local node-agent route: path-only for reverse tunnels, absolute for relay hosts. */
  injectUrl(route: string): string;
  /**
   * Sends one HTTP stream frame. Transports whose socket exposes a flush
   * callback (the reverse-tunnel WebSocket) resolve after the write, keeping
   * backpressure on large response bodies; relay channels send synchronously.
   */
  sendFrame?(socket: NodeTunnelSessionSocket, data: string | Buffer, binary: boolean): void | Promise<void>;
  /** Reverse tunnels identify as soon as the socket opens; relay channels wait for control-plane.hello. */
  identifyOnOpen: boolean;
  /** Relay sessions treat binary main-channel frames as a protocol error. */
  rejectBinaryMainFrames?: boolean;
  /** Relay channels answer unknown messages with node-agent.error; reverse tunnels stay silent. */
  respondToUnsupportedMessages?: boolean;
  labels: {
    /** e.g. "reverse tunnel" — reads as `node agent ${topic} message rejected`. */
    topic: string;
    /** e.g. "Reverse tunnel" — prefixes protocol error messages. */
    displayName: string;
    /** Error code returned when the local node agent cannot be reached, e.g. NODE_AGENT_REVERSE_INJECT_FAILED. */
    injectFailureCode: string;
    /** Fixed local teardown reason; defaults to the peer's close reason. */
    disconnectReason?: string;
  };
};

function decodeLocalRequestBody(value: unknown): string | Buffer | undefined {
  const body = decodeNodeTunnelRequestBody(value);
  // `Buffer` is itself a `Uint8Array`, so check it first: a Node-side decode
  // already returns a Buffer and must not be copied per proxied body.
  if (Buffer.isBuffer(body)) return body;
  return body instanceof Uint8Array
    ? Buffer.from(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength)
    : body;
}

function socketIsOpen(socket: NodeTunnelSessionSocket) {
  return socket.readyState === ((socket as { OPEN?: number }).OPEN ?? 1);
}

type TunnelStream = {
  upstream: WebSocket;
  socket: NodeTunnelSessionSocket;
};

type HttpStream = {
  socket: NodeTunnelSessionSocket;
  controller: AbortController;
};

/**
 * The node end of one tunnel protocol session. It serves the same
 * `control-plane.*` message set for every transport that carries it: injects
 * requests into the local node agent, streams HTTP responses, bridges proxied
 * WebSockets and forwards events. The transport only supplies the main socket,
 * the auxiliary-channel dialer and its auth/label details.
 */
export class NodeTunnelSessionServer {
  private readonly options: NodeTunnelSessionOptions;
  private readonly streams = new Map<string, TunnelStream>();
  private readonly httpStreams = new Map<string, HttpStream>();
  private readonly requests = new Map<string, AbortController>();
  private disposeEventForwarderOutput?: () => void;
  private identified = false;
  private disposed = false;

  constructor(options: NodeTunnelSessionOptions) {
    this.options = options;
  }

  /** Wires the protocol onto the main socket. */
  attach() {
    this.options.socket.on("message", (raw, isBinary) => {
      void this.handleMainMessage(raw, Boolean(isBinary)).catch((error) => {
        this.options.host.log.warn({
          nodeId: this.options.nodeId,
          error: error instanceof Error ? error.message : String(error),
        }, `node agent ${this.options.labels.topic} message rejected`);
        try {
          this.options.socket.send(JSON.stringify({ type: "node-agent.error", code: "INVALID_TUNNEL_MESSAGE" }));
        } catch {
          // The tunnel may have closed while the invalid message was being handled.
        }
      });
    });
    if (this.options.identifyOnOpen) {
      this.options.socket.on("open", () => this.identify());
    }
    this.options.socket.on("close", () => this.dispose(this.options.labels.disconnectReason ?? "closed"));
  }

  /**
   * Control frames are best-effort once the transport starts tearing down.
   * Closing a bridged upstream WebSocket synchronously notifies this session,
   * which must not turn a normal channel shutdown into an uncaught send error.
   */
  private sendMain(message: Record<string, unknown>) {
    if (this.disposed) return false;
    try {
      this.options.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Sends node-agent.identify once; safe to call from both the socket-open hook and control-plane.hello. */
  identify() {
    if (this.disposed || this.identified) return;
    this.identified = true;
    this.sendMain({ type: "node-agent.identify", nodeId: this.options.nodeId, serverTime: new Date().toISOString() });
    // A current Control Plane sends its precise demand right after attach; hold
    // the legacy stream briefly so reconnect ordering cannot wake every producer.
    this.disposeEventForwarderOutput = this.options.host.nodeAgentEventForwarder?.addOutput(this.options.socket, { legacyFallbackMs: 1_000 });
  }

  /** Tears down every stream this session owns. Idempotent. */
  dispose(reason: string) {
    if (this.disposed) return;
    this.disposed = true;
    for (const streamId of [...this.streams.keys()]) this.closeStream(streamId, 1001, reason);
    for (const [streamId, stream] of this.httpStreams) {
      this.httpStreams.delete(streamId);
      stream.controller.abort();
      stream.socket.close(1001, reason);
    }
    for (const [requestId, controller] of this.requests) {
      this.requests.delete(requestId);
      controller.abort();
    }
    this.disposeEventForwarderOutput?.();
    this.disposeEventForwarderOutput = undefined;
  }

  private localNodeAgentHttpUrl(route: string) {
    const path = route.startsWith("/") ? route : `/${route}`;
    return new URL(`/api/node-agent${path}`, `http://127.0.0.1:${this.options.host.currentListenerPort()}`);
  }

  private localNodeAgentWsUrl(route: string) {
    const url = this.localNodeAgentHttpUrl(route);
    url.protocol = "ws:";
    return url;
  }

  private closeStream(streamId: string, code?: unknown, reason?: unknown) {
    const stream = this.streams.get(streamId);
    this.streams.delete(streamId);
    if (!stream) return;
    closeWebSocket(stream.upstream, code, reason);
    closeWebSocket(stream.socket, code, reason);
  }

  private async handleMainMessage(raw: unknown, isBinary: boolean) {
    if (this.disposed) return;
    if (isBinary && this.options.rejectBinaryMainFrames) {
      throw new Error(`${this.options.labels.displayName} main channel does not accept binary frames.`);
    }
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      this.sendMain({ type: "node-agent.error", code: "INVALID_JSON" });
      return;
    }
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    if (record.type === "control-plane.hello") {
      this.identify();
      return;
    }
    if (record.type === "control-plane.event-subscribe") {
      this.options.host.nodeAgentEventForwarder?.setOutputSubscription?.(this.options.socket, record.aiSessionTransient, record.eventEnvelopeVersion, record.aiSessionHierarchy);
      return;
    }
    if (record.type === "control-plane.request.cancel") {
      const requestId = typeof record.requestId === "string" ? record.requestId : "";
      this.requests.get(requestId)?.abort();
      this.requests.delete(requestId);
      return;
    }
    if (record.type === "control-plane.request") {
      await this.handleRequest(record);
      return;
    }
    if (record.type === "control-plane.http.open") {
      this.handleHttpOpen(record);
      return;
    }
    if (record.type === "control-plane.http.cancel") {
      const streamId = typeof record.streamId === "string" ? record.streamId : "";
      const stream = this.httpStreams.get(streamId);
      if (!stream) return;
      this.httpStreams.delete(streamId);
      stream.controller.abort();
      stream.socket.close(1000, typeof record.reason === "string" ? record.reason : "HTTP stream canceled.");
      return;
    }
    if (record.type === "control-plane.websocket.open") {
      this.handleWebSocketOpen(record);
      return;
    }
    if (record.type === "control-plane.websocket.close") {
      const streamId = typeof record.streamId === "string" ? record.streamId : "";
      this.closeStream(streamId, typeof record.code === "number" ? record.code : 1000, typeof record.reason === "string" ? record.reason : "");
      return;
    }
    if (this.options.respondToUnsupportedMessages) {
      this.sendMain({ type: "node-agent.error", code: "UNSUPPORTED_MESSAGE" });
    }
  }

  private async handleRequest(record: Record<string, unknown>) {
    const requestId = typeof record.requestId === "string" ? record.requestId : "";
    const init = record.init && typeof record.init === "object" ? record.init as Record<string, unknown> : {};
    const route = typeof record.route === "string" && record.route.startsWith("/") ? record.route : "/health";
    const headers = init.headers && typeof init.headers === "object" ? init.headers as Record<string, string> : {};
    const method = nodeAgentProxyMethod(init.method);
    let body: string | Buffer | undefined;
    try {
      body = decodeLocalRequestBody(init.body);
    } catch (error) {
      this.options.host.log.warn({
        nodeId: this.options.nodeId,
        messageType: record.type,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      }, `node agent ${this.options.labels.topic} request body rejected`);
      this.sendMain({
        type: "node-agent.response",
        requestId,
        status: 400,
        error: {
          code: "NODE_TUNNEL_REQUEST_BODY_INVALID",
          message: `${this.options.labels.displayName} request body does not match the negotiated protocol.`,
        },
      });
      return;
    }
    const controller = new AbortController();
    this.requests.set(requestId, controller);
    try {
      const response = await this.options.host.inject({
        method,
        url: this.options.injectUrl(route),
        headers: this.options.buildLocalHeaders(route, method, body, headers),
        payload: body,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      this.sendMain({
        type: "node-agent.response",
        requestId,
        status: response.statusCode,
        headers: response.headers,
        body: response.body,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      this.sendMain({
        type: "node-agent.response",
        requestId,
        status: 502,
        error: {
          code: this.options.labels.injectFailureCode,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.requests.delete(requestId);
    }
  }

  private handleHttpOpen(record: Record<string, unknown>) {
    const streamId = typeof record.streamId === "string" ? record.streamId : "";
    const route = typeof record.route === "string" && record.route.startsWith("/") ? record.route : "/health";
    const init = record.init && typeof record.init === "object" ? record.init as Record<string, unknown> : {};
    const requestHeaders = init.headers && typeof init.headers === "object" ? init.headers as Record<string, string> : {};
    const method = nodeAgentProxyMethod(init.method);
    let body: string | Buffer | undefined;
    try {
      body = decodeLocalRequestBody(init.body);
    } catch (error) {
      this.options.host.log.warn({
        nodeId: this.options.nodeId,
        messageType: record.type,
        streamId,
        error: error instanceof Error ? error.message : String(error),
      }, `node agent ${this.options.labels.topic} request body rejected`);
      this.sendMain({ type: "node-agent.error", code: "NODE_TUNNEL_REQUEST_BODY_INVALID", streamId });
      return;
    }
    const controller = new AbortController();
    void (async () => {
      let socket: NodeTunnelSessionSocket;
      try {
        socket = await this.options.openAuxSocket(streamId, "http");
      } catch (error) {
        this.options.host.log.warn({
          nodeId: this.options.nodeId,
          streamId,
          error: error instanceof Error ? error.message : String(error),
        }, `node agent ${this.options.labels.topic} stream channel rejected`);
        return;
      }
      if (this.disposed) {
        socket.close(1001, `${this.options.labels.displayName} closed.`);
        return;
      }
      const abort = () => {
        controller.abort();
        this.httpStreams.delete(streamId);
      };
      socket.on("close", abort);
      socket.on("error", abort);
      this.httpStreams.set(streamId, { socket, controller });
      const sendFrame = (data: string | Buffer, binary = false) => {
        if (this.options.sendFrame) return this.options.sendFrame(socket, data, binary);
        socket.send(data, { binary, compress: false });
      };
      try {
        const response = await fetch(this.localNodeAgentHttpUrl(route), {
          method,
          headers: this.options.buildLocalHeaders(route, method, body, requestHeaders),
          body: body as unknown as BodyInit,
          signal: controller.signal,
        });
        await sendFrame(JSON.stringify({ type: "node-agent.http.head", streamId, status: response.status, headers: Object.fromEntries(response.headers.entries()) }));
        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await sendFrame(Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength), true);
          }
        }
        await sendFrame(JSON.stringify({ type: "node-agent.http.end", streamId }));
        socket.close(1000, "HTTP stream completed.");
      } catch (error) {
        if (socketIsOpen(socket)) {
          try {
            await sendFrame(JSON.stringify({ type: "node-agent.http.error", streamId, message: error instanceof Error ? error.message : String(error) }));
          } catch {
            // The stream socket closed between the readyState check and the send.
          }
          socket.close(1011, "HTTP stream failed.");
        }
      } finally {
        this.httpStreams.delete(streamId);
      }
    })();
  }

  private handleWebSocketOpen(record: Record<string, unknown>) {
    const streamId = typeof record.streamId === "string" ? record.streamId : "";
    const route = typeof record.route === "string" ? record.route : "";
    const protocols = Array.isArray(record.protocols) ? record.protocols.filter((item): item is string => typeof item === "string") : undefined;
    void (async () => {
      let socket: NodeTunnelSessionSocket;
      try {
        socket = await this.options.openAuxSocket(streamId, "websocket");
      } catch (error) {
        this.options.host.log.warn({
          nodeId: this.options.nodeId,
          streamId,
          error: error instanceof Error ? error.message : String(error),
        }, `node agent ${this.options.labels.topic} websocket channel rejected`);
        // The reverse-tunnel client used to report an auxiliary dial failure
        // through the bridge's client-error path; keep that main-channel error
        // so an older Control Plane closes the downstream socket immediately
        // instead of waiting for its pending-channel timeout.
        try {
          this.sendMain({
            type: "node-agent.websocket.error",
            streamId,
            message: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // The session may already be closed.
        }
        return;
      }
      if (this.disposed) {
        socket.close(1001, `${this.options.labels.displayName} closed.`);
        return;
      }
      try {
        const headers = this.options.buildLocalHeaders(route, "GET", undefined, {});
        const upstream = protocols?.length
          ? new WebSocket(this.localNodeAgentWsUrl(route), protocols, { headers })
          : new WebSocket(this.localNodeAgentWsUrl(route), { headers });
        this.streams.set(streamId, { upstream, socket });
        upstream.on("open", () => {
          // WebSocket lifecycle control stays on the main channel; the
          // auxiliary channel carries only upstream bytes, never control JSON.
          this.sendMain({ type: "node-agent.websocket.open", streamId, protocol: upstream.protocol });
        });
        bridgeWebSockets(socket, upstream, {
          pendingFrameLimit: 256,
          upstreamOpenTimeoutMs: 10_000,
          onClientClose: () => {
            this.streams.delete(streamId);
          },
          onClientError: (error) => {
            this.streams.delete(streamId);
            this.sendMain({
              type: "node-agent.websocket.error",
              streamId,
              message: error instanceof Error ? error.message : String(error),
            });
          },
          onUpstreamClose: (code, reason) => {
            this.streams.delete(streamId);
            const closeCode = normalizeWebSocketCloseCode(code);
            const closeReason = normalizeWebSocketCloseReason(reason);
            this.sendMain({
              type: "node-agent.websocket.close",
              streamId,
              ...(closeCode === undefined ? {} : { code: closeCode }),
              ...(closeReason ? { reason: closeReason } : {}),
            });
          },
          onUpstreamError: (error) => {
            this.streams.delete(streamId);
            this.sendMain({
              type: "node-agent.websocket.error",
              streamId,
              message: error instanceof Error ? error.message : String(error),
            });
          },
        });
      } catch (error) {
        this.sendMain({
          type: "node-agent.websocket.error",
          streamId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }
}
