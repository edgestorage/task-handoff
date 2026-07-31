import type { Node } from "@task-handoff/protocol/control-plane";
import { bridgeWebSockets } from "@task-handoff/protocol/websocket-bridge";
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
  const authHeaders = createDirectNodeAgentAuthHeaders(node, {
    method: "GET",
    pathWithQuery,
  });
  if (ipcPath) {
    assertLocalIpcSocketOwnedByCurrentUser(ipcPath);
    return createNodeAgentIpcWebSocket(ipcPath, route, protocols, { ...headers, ...authHeaders });
  }
  const url = new URL(pathWithQuery, endpoint.replace(/\/$/, ""));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return protocols
    ? new WsClient(url.toString(), protocols, { headers: { ...headers, ...authHeaders } })
    : new WsClient(url.toString(), { headers: { ...headers, ...authHeaders } });
}

export function createDirectNodeAgentTransport(fetchImpl: FetchImpl = fetch): NodeAgentTransport {
  const request = async (node: Node, route: string, init: RequestInit = {}) => {
    const endpoint = requireDirectNodeAgentEndpoint(node);
    const method = init.method || "GET";
    const body = typeof init.body === "string" || init.body instanceof Buffer
      ? init.body
      : init.body === undefined || init.body === null
        ? undefined
        : String(init.body);
    const authHeaders = createDirectNodeAgentAuthHeaders(node, {
      method,
      pathWithQuery: `/api/node-agent${route}`,
      body: body || "",
    });
    return fetchDirectNodeAgentEndpoint(fetchImpl, endpoint, route, {
      ...init,
      body,
      headers: {
        ...(init.headers || {}),
        ...authHeaders,
      },
    });
  };

  return {
    request,
    requestStream: request,
    proxyWebSocket(node: Node, socket: NodeAgentWebSocket, route: string, protocols?: string | string[], headers: Record<string, string> = {}) {
      bridgeWebSockets(socket, openDirectNodeAgentWebSocket(node, route, protocols, headers), {
        onUpstreamError: () => socket.close(1011, "Instance websocket proxy failed."),
        onUpstreamErrorBeforeOpen: () => true,
      });
    },
  };
}
