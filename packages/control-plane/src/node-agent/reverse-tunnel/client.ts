import WebSocket from "ws";
import { decodeNodeTunnelRequestBody } from "@task-handoff/protocol/control-plane";
import { bridgeWebSockets, closeWebSocket, normalizeWebSocketCloseCode, normalizeWebSocketCloseReason } from "@task-handoff/protocol/websocket-bridge";
import { createNodeAgentHmacHeaders } from "../../shared/security/node-agent-auth.ts";
import { nodeAgentProxyMethod, type NodeAgentInjectResponse } from "../transport/proxy-utils.ts";

export type ReverseTunnelHost = {
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
  nodeAgentEventForwarder?: {
    addOutput(socket: WebSocket, options?: { expectsTransientSubscription?: boolean; legacyFallbackMs?: number }): () => void;
    setOutputSubscription?(socket: WebSocket, input: unknown, eventEnvelopeVersion?: unknown): boolean;
  };
  nodeAgentState?: {
    currentListenerPort: number;
  };
};

export type ReverseTunnelConnectionInput = {
  tunnelUrl: string;
  nodeId: string;
  port: number | string | (() => number | string);
  token?: string;
  keyId?: string;
  secret?: string;
};

export function connectReverseTunnel(app: ReverseTunnelHost, input: ReverseTunnelConnectionInput) {
  const url = new URL(input.tunnelUrl);
  url.searchParams.set("nodeId", input.nodeId);
  const tunnelHeaders = input.secret
    ? createNodeAgentHmacHeaders({
        nodeId: input.nodeId,
        keyId: input.keyId,
        secret: input.secret,
        method: "GET",
        pathWithQuery: `${url.pathname}${url.search}`,
      })
    : {};
  const socket = new WebSocket(url, { headers: tunnelHeaders });
  const streams = new Map<string, { upstream?: WebSocket; tunnel?: WebSocket; close: (code?: number, reason?: string) => void }>();
  const httpStreams = new Map<string, { tunnel: WebSocket; controller: AbortController }>();
  const requests = new Map<string, AbortController>();
  let disposeEventForwarderOutput: (() => void) | undefined;
  socket.on("error", (error) => {
    app.log.warn({
      nodeId: input.nodeId,
      tunnelUrl: `${url.origin}${url.pathname}`,
      error: error instanceof Error ? error.message : String(error),
    }, "node agent reverse tunnel connection failed");
  });
  const localNodeAgentWsUrl = (route: string) => {
    const path = route.startsWith("/") ? route : `/${route}`;
    const port = typeof input.port === "function" ? input.port() : input.port;
    const localUrl = new URL(`/api/node-agent${path}`, `http://127.0.0.1:${port}`);
    localUrl.protocol = "ws:";
    return localUrl;
  };
  const localNodeAgentHttpUrl = (route: string) => {
    const path = route.startsWith("/") ? route : `/${route}`;
    const port = typeof input.port === "function" ? input.port() : input.port;
    return new URL(`/api/node-agent${path}`, `http://127.0.0.1:${port}`);
  };
  const localNodeAgentRequestHeaders = (
    route: string,
    method: string,
    body: string | Buffer | undefined,
    headers: Record<string, string> = {},
  ) => {
    const path = route.startsWith("/") ? route : `/${route}`;
    const authHeaders = input.secret && input.keyId
      ? createNodeAgentHmacHeaders({
          nodeId: input.nodeId,
          keyId: input.keyId,
          secret: input.secret,
          method,
          pathWithQuery: `/api/node-agent${path}`,
          body,
        })
      : input.token
        ? { authorization: `Bearer ${input.token}` }
        : {};
    return { ...headers, ...authHeaders };
  };
  const controlPlaneStreamUrl = (streamId: string) => {
    const streamUrl = new URL(url);
    streamUrl.pathname = `${streamUrl.pathname.replace(/\/$/, "")}/streams/${encodeURIComponent(streamId)}`;
    return streamUrl;
  };
  const controlPlaneHttpStreamUrl = (streamId: string) => {
    const streamUrl = new URL(url);
    streamUrl.pathname = `${streamUrl.pathname.replace(/\/$/, "")}/http-streams/${encodeURIComponent(streamId)}`;
    return streamUrl;
  };
  const controlPlaneStreamHeaders = (streamUrl: URL) => input.secret
    ? createNodeAgentHmacHeaders({
        nodeId: input.nodeId,
        keyId: input.keyId,
        secret: input.secret,
        method: "GET",
        pathWithQuery: `${streamUrl.pathname}${streamUrl.search}`,
      })
    : {};
  const closeStream = (streamId: string, code?: unknown, reason?: unknown) => {
    const stream = streams.get(streamId);
    streams.delete(streamId);
    if (stream?.upstream) closeWebSocket(stream.upstream, code, reason);
    if (stream?.tunnel) closeWebSocket(stream.tunnel, code, reason);
  };
  const sendHttpFrame = (tunnel: WebSocket, data: string | Buffer, binary = false) => new Promise<void>((resolve, reject) => {
    tunnel.send(data, { binary, compress: false }, (error) => error ? reject(error) : resolve());
  });
  socket.on("open", () => {
    socket.send(JSON.stringify({ type: "node-agent.identify", nodeId: input.nodeId, serverTime: new Date().toISOString() }));
    // A current control-plane sends its precise demand immediately after attach.
    // Hold the legacy stream briefly so reconnect ordering cannot wake every
    // transient producer; v0.0.21 peers still fall back to the full stream.
    disposeEventForwarderOutput = app.nodeAgentEventForwarder?.addOutput(socket, { legacyFallbackMs: 1_000 });
  });
  socket.on("close", () => {
    for (const streamId of streams.keys()) {
      closeStream(streamId, 1001, "Reverse tunnel disconnected.");
    }
    for (const [streamId, stream] of httpStreams) {
      httpStreams.delete(streamId);
      stream.controller.abort();
      closeWebSocket(stream.tunnel, 1001, "Reverse tunnel disconnected.");
    }
    for (const [requestId, controller] of requests) {
      requests.delete(requestId);
      controller.abort();
    }
    disposeEventForwarderOutput?.();
    disposeEventForwarderOutput = undefined;
  });
  const handleMessage = async (raw: unknown) => {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      socket.send(JSON.stringify({ type: "node-agent.error", code: "INVALID_JSON" }));
      return;
    }
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    if (record.type === "control-plane.event-subscribe") {
      app.nodeAgentEventForwarder?.setOutputSubscription?.(socket, record.aiSessionTransient, record.eventEnvelopeVersion);
      return;
    }
    if (record.type === "control-plane.http.open") {
      const streamId = typeof record.streamId === "string" ? record.streamId : "";
      const route = typeof record.route === "string" && record.route.startsWith("/") ? record.route : "/health";
      const init = record.init && typeof record.init === "object" ? record.init as Record<string, unknown> : {};
      const requestHeaders = init.headers && typeof init.headers === "object" ? init.headers as Record<string, string> : {};
      const method = nodeAgentProxyMethod(init.method);
      let body: string | Buffer | undefined;
      try {
        body = decodeNodeTunnelRequestBody(init.body);
      } catch (error) {
        app.log.warn({
          nodeId: input.nodeId,
          messageType: record.type,
          streamId,
          error: error instanceof Error ? error.message : String(error),
        }, "node agent reverse tunnel request body rejected");
        socket.send(JSON.stringify({ type: "node-agent.error", code: "NODE_TUNNEL_REQUEST_BODY_INVALID", streamId }));
        return;
      }
      const controller = new AbortController();
      const streamUrl = controlPlaneHttpStreamUrl(streamId);
      const tunnel = new WebSocket(streamUrl, { headers: controlPlaneStreamHeaders(streamUrl) });
      httpStreams.set(streamId, { tunnel, controller });
      tunnel.on("open", async () => {
        try {
          const response = await fetch(localNodeAgentHttpUrl(route), {
            method,
            headers: localNodeAgentRequestHeaders(route, method, body, requestHeaders),
            body: Buffer.isBuffer(body) ? new Uint8Array(body) : body,
            signal: controller.signal,
          });
          await sendHttpFrame(tunnel, JSON.stringify({ type: "node-agent.http.head", streamId, status: response.status, headers: Object.fromEntries(response.headers.entries()) }));
          if (response.body) {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await sendHttpFrame(tunnel, Buffer.from(value), true);
            }
          }
          await sendHttpFrame(tunnel, JSON.stringify({ type: "node-agent.http.end", streamId }));
          tunnel.close(1000, "HTTP stream completed.");
        } catch (error) {
          if (tunnel.readyState === WebSocket.OPEN) {
            await sendHttpFrame(tunnel, JSON.stringify({ type: "node-agent.http.error", streamId, message: error instanceof Error ? error.message : String(error) })).catch(() => undefined);
            tunnel.close(1011, "HTTP stream failed.");
          }
        } finally {
          httpStreams.delete(streamId);
        }
      });
      tunnel.on("close", () => {
        controller.abort();
        httpStreams.delete(streamId);
      });
      tunnel.on("error", () => controller.abort());
      return;
    }
    if (record.type === "control-plane.http.cancel") {
      const streamId = typeof record.streamId === "string" ? record.streamId : "";
      const stream = httpStreams.get(streamId);
      if (!stream) return;
      httpStreams.delete(streamId);
      stream.controller.abort();
      closeWebSocket(stream.tunnel, 1000, typeof record.reason === "string" ? record.reason : "HTTP stream canceled.");
      return;
    }
    if (record.type === "control-plane.websocket.open") {
      const streamId = typeof record.streamId === "string" ? record.streamId : "";
      const route = typeof record.route === "string" ? record.route : "";
      const protocols = Array.isArray(record.protocols) ? record.protocols.filter((item): item is string => typeof item === "string") : undefined;
      try {
        const headers = localNodeAgentRequestHeaders(route, "GET", undefined);
        const upstream = protocols?.length ? new WebSocket(localNodeAgentWsUrl(route), protocols, { headers }) : new WebSocket(localNodeAgentWsUrl(route), { headers });
        const streamUrl = controlPlaneStreamUrl(streamId);
        const tunnel = new WebSocket(streamUrl, { headers: controlPlaneStreamHeaders(streamUrl) });
        streams.set(streamId, {
          upstream,
          tunnel,
          close: (code = 1000, reason = "") => {
            closeWebSocket(upstream, code, reason);
            closeWebSocket(tunnel, code, reason);
          },
        });
        upstream.on("open", () => {
          socket.send(JSON.stringify({ type: "node-agent.websocket.open", streamId, protocol: upstream.protocol }));
        });
        bridgeWebSockets(tunnel, upstream, {
          pendingFrameLimit: 256,
          upstreamOpenTimeoutMs: 10_000,
          onClientClose: () => {
            streams.delete(streamId);
          },
          onClientError: (error) => {
            streams.delete(streamId);
            socket.send(JSON.stringify({
              type: "node-agent.websocket.error",
              streamId,
              message: error instanceof Error ? error.message : String(error),
            }));
          },
          onUpstreamClose: (code, reason) => {
            streams.delete(streamId);
            const closeCode = normalizeWebSocketCloseCode(code);
            const closeReason = normalizeWebSocketCloseReason(reason);
            socket.send(JSON.stringify({
              type: "node-agent.websocket.close",
              streamId,
              ...(closeCode === undefined ? {} : { code: closeCode }),
              ...(closeReason ? { reason: closeReason } : {}),
            }));
          },
          onUpstreamError: (error) => {
            streams.delete(streamId);
            socket.send(JSON.stringify({
              type: "node-agent.websocket.error",
              streamId,
              message: error instanceof Error ? error.message : String(error),
            }));
          },
        });
      } catch (error) {
        socket.send(JSON.stringify({
          type: "node-agent.websocket.error",
          streamId,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      return;
    }
    if (record.type === "control-plane.websocket.close") {
      const streamId = typeof record.streamId === "string" ? record.streamId : "";
      closeStream(streamId, typeof record.code === "number" ? record.code : 1000, typeof record.reason === "string" ? record.reason : "");
      return;
    }
    if (record.type === "control-plane.request.cancel") {
      const requestId = typeof record.requestId === "string" ? record.requestId : "";
      requests.get(requestId)?.abort();
      requests.delete(requestId);
      return;
    }
    if (record.type === "control-plane.request") {
      const requestId = typeof record.requestId === "string" ? record.requestId : "";
      const init = record.init && typeof record.init === "object" ? record.init as Record<string, unknown> : {};
      const route = typeof record.route === "string" && record.route.startsWith("/") ? record.route : "/health";
      const headers = init.headers && typeof init.headers === "object" ? init.headers as Record<string, string> : {};
      const method = nodeAgentProxyMethod(init.method);
      let body: string | Buffer | undefined;
      try {
        body = decodeNodeTunnelRequestBody(init.body);
      } catch (error) {
        app.log.warn({
          nodeId: input.nodeId,
          messageType: record.type,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        }, "node agent reverse tunnel request body rejected");
        socket.send(JSON.stringify({
          type: "node-agent.response",
          requestId,
          status: 400,
          error: {
            code: "NODE_TUNNEL_REQUEST_BODY_INVALID",
            message: "Reverse tunnel request body does not match the negotiated protocol.",
          },
        }));
        return;
      }
      const controller = new AbortController();
      requests.set(requestId, controller);
      try {
        const response = await app.inject({
          method,
          url: `/api/node-agent${route}`,
          headers: localNodeAgentRequestHeaders(route, method, body, headers),
          payload: body,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        socket.send(JSON.stringify({
          type: "node-agent.response",
          requestId,
          status: response.statusCode,
          headers: response.headers,
          body: response.body,
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        socket.send(JSON.stringify({
          type: "node-agent.response",
          requestId,
          status: 502,
          error: {
            code: "NODE_AGENT_REVERSE_INJECT_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      } finally {
        requests.delete(requestId);
      }
    }
  };
  socket.on("message", (raw) => {
    void handleMessage(raw).catch((error) => {
      app.log.warn({
        nodeId: input.nodeId,
        error: error instanceof Error ? error.message : String(error),
      }, "node agent reverse tunnel message rejected");
      try {
        socket.send(JSON.stringify({ type: "node-agent.error", code: "INVALID_TUNNEL_MESSAGE" }));
      } catch {
        // The tunnel may have closed while the invalid message was being handled.
      }
    });
  });
  return socket;
}
