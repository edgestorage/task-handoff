import WebSocket from "ws";
import { createNodeAgentHmacHeaders } from "../../shared/security/node-agent-auth.ts";
import { NodeTunnelSessionServer, type NodeTunnelSessionHost, type NodeTunnelSessionSocket } from "../tunnel-session/server.ts";
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
    addOutput(socket: NodeTunnelSessionSocket, options?: { expectsTransientSubscription?: boolean; legacyFallbackMs?: number }): () => void;
    setOutputSubscription?(socket: NodeTunnelSessionSocket, input: unknown, eventEnvelopeVersion?: unknown, aiSessionHierarchy?: unknown): boolean;
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

function normalizedRoute(route: string) {
  return route.startsWith("/") ? route : `/${route}`;
}

/**
 * Dials one auxiliary reverse-tunnel WebSocket (`/streams/:id` or
 * `/http-streams/:id`) and resolves once it is open, so the shared session can
 * treat every transport's auxiliary channel alike.
 */
function dialStreamSocket(url: URL, headers: Record<string, string>) {
  return new Promise<NodeTunnelSessionSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const onOpen = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onClose = (code?: number, reason?: unknown) => {
      cleanup();
      const detail = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "");
      reject(new Error(`Reverse tunnel stream closed before it opened${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}.`));
    };
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("open", onOpen);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

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
  socket.on("error", (error) => {
    app.log.warn({
      nodeId: input.nodeId,
      tunnelUrl: `${url.origin}${url.pathname}`,
      error: error instanceof Error ? error.message : String(error),
    }, "node agent reverse tunnel connection failed");
  });
  const currentListenerPort = () => typeof input.port === "function" ? input.port() : input.port;
  const controlPlaneStreamUrl = (streamId: string, kind: "http" | "websocket") => {
    const streamUrl = new URL(url);
    const segment = kind === "http" ? "http-streams" : "streams";
    streamUrl.pathname = `${streamUrl.pathname.replace(/\/$/, "")}/${segment}/${encodeURIComponent(streamId)}`;
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
  const localAuthHeaders = (route: string, method: string, body: string | Buffer | undefined) => input.secret && input.keyId
    ? createNodeAgentHmacHeaders({
        nodeId: input.nodeId,
        keyId: input.keyId,
        secret: input.secret,
        method,
        pathWithQuery: `/api/node-agent${normalizedRoute(route)}`,
        body,
      })
    : input.token
      ? { authorization: `Bearer ${input.token}` }
      : {};
  const host: NodeTunnelSessionHost = {
    log: app.log,
    inject: (request) => app.inject(request),
    ...(app.nodeAgentEventForwarder ? { nodeAgentEventForwarder: app.nodeAgentEventForwarder } : {}),
    currentListenerPort,
  };
  const session = new NodeTunnelSessionServer({
    nodeId: input.nodeId,
    socket,
    host,
    openAuxSocket: (streamId, kind) => {
      const streamUrl = controlPlaneStreamUrl(streamId, kind);
      return dialStreamSocket(streamUrl, controlPlaneStreamHeaders(streamUrl));
    },
    sendFrame: (streamSocket, data, binary) => new Promise<void>((resolve, reject) => {
      (streamSocket as WebSocket).send(data, { binary, compress: false }, (error) => error ? reject(error) : resolve());
    }),
    buildLocalHeaders: (route, method, body, headers) => ({ ...headers, ...localAuthHeaders(route, method, body) }),
    injectUrl: (route) => `/api/node-agent${normalizedRoute(route)}`,
    identifyOnOpen: true,
    labels: {
      topic: "reverse tunnel",
      displayName: "Reverse tunnel",
      injectFailureCode: "NODE_AGENT_REVERSE_INJECT_FAILED",
      disconnectReason: "Reverse tunnel disconnected.",
    },
  });
  session.attach();
  return socket;
}
