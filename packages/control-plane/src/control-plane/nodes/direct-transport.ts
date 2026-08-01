import type { Node } from "@task-handoff/protocol/control-plane";
import { bridgeWebSockets, type WebSocketLike } from "@task-handoff/protocol/websocket-bridge";
import { WebSocket as WsClient } from "ws";
import { createDirectNodeAgentAuthHeaders } from "../../shared/security/node-agent-auth.ts";
import {
  assertLocalIpcSocketOwnedByCurrentUser,
  createNodeAgentIpcWebSocket,
  fetchNodeAgentIpc,
  parseNodeAgentIpcEndpoint,
} from "../../shared/transport/node-agent-ipc.ts";
import type { NodeAgentTransport, NodeAgentWebSocket } from "./client.ts";

type FetchImpl = typeof fetch;

export type DirectNodeAgentTransportOptions = {
  openWebSocket?: (
    node: Node,
    route: string,
    protocols: string | string[] | undefined,
    headers: Record<string, string>,
  ) => WebSocketLike;
};

export async function fetchDirectNodeAgentEndpoint(
  fetchImpl: FetchImpl,
  endpoint: string,
  route: string,
  init: RequestInit = {},
) {
  const ipcPath = parseNodeAgentIpcEndpoint(endpoint);
  if (ipcPath) {
    assertLocalIpcSocketOwnedByCurrentUser(ipcPath);
    return fetchNodeAgentIpc(ipcPath, route, init);
  }
  return fetchImpl(`${endpoint.replace(/\/$/, "")}/api/node-agent${route}`, init);
}

function requireDirectNodeAgentEndpoint(node: Node) {
  const endpoint = node.controlEndpoint || node.endpoint;
  if (!endpoint) {
    const error = new Error("Node agent direct HTTP mode requires an endpoint.");
    Object.assign(error, { statusCode: 400, code: "NODE_AGENT_ENDPOINT_REQUIRED" });
    throw error;
  }
  return endpoint;
}

function openDirectNodeAgentWebSocket(
  node: Node,
  route: string,
  protocols: string | string[] | undefined,
  headers: Record<string, string>,
) {
  const endpoint = requireDirectNodeAgentEndpoint(node);
  const ipcPath = parseNodeAgentIpcEndpoint(endpoint);
  const pathWithQuery = `/api/node-agent${route}`;
  if (ipcPath) {
    assertLocalIpcSocketOwnedByCurrentUser(ipcPath);
    return createNodeAgentIpcWebSocket(ipcPath, route, protocols, headers);
  }
  const url = new URL(pathWithQuery, endpoint.replace(/\/$/, ""));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return protocols
    ? new WsClient(url.toString(), protocols, { headers })
    : new WsClient(url.toString(), { headers });
}

function directNodeAgentHeaders(
  node: Node,
  input: { method: string; pathWithQuery: string; body?: string | Buffer },
  headers?: HeadersInit,
) {
  const merged = new Headers(headers);
  const authHeaders = createDirectNodeAgentAuthHeaders(node, input);
  for (const [name, value] of Object.entries(authHeaders)) {
    if (name === "authorization" && merged.has(name)) continue;
    merged.set(name, value);
  }
  return Object.fromEntries(merged.entries());
}

export function createDirectNodeAgentTransport(fetchImpl: FetchImpl = fetch, options: DirectNodeAgentTransportOptions = {}): NodeAgentTransport {
  const openWebSocket = options.openWebSocket || openDirectNodeAgentWebSocket;
  const request = async (node: Node, route: string, init: RequestInit = {}) => {
    const endpoint = requireDirectNodeAgentEndpoint(node);
    const method = init.method || "GET";
    const body = typeof init.body === "string" || init.body instanceof Buffer
      ? init.body
      : init.body === undefined || init.body === null
        ? undefined
        : String(init.body);
    const headers = directNodeAgentHeaders(node, {
      method,
      pathWithQuery: `/api/node-agent${route}`,
      body: body || "",
    }, init.headers);
    return fetchDirectNodeAgentEndpoint(fetchImpl, endpoint, route, {
      ...init,
      body,
      headers,
    });
  };

  return {
    request,
    requestStream: request,
    proxyWebSocket(node: Node, socket: NodeAgentWebSocket, route: string, protocols?: string | string[], headers: Record<string, string> = {}) {
      const pathWithQuery = `/api/node-agent${route}`;
      const mergedHeaders = directNodeAgentHeaders(node, { method: "GET", pathWithQuery }, headers);
      bridgeWebSockets(socket, openWebSocket(node, route, protocols, mergedHeaders), {
        onUpstreamError: () => socket.close(1011, "Instance websocket proxy failed."),
        onUpstreamErrorBeforeOpen: () => true,
      });
    },
  };
}
