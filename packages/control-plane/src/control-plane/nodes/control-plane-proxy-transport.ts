import crypto from "node:crypto";
import {
  CONTROL_PLANE_PROXY_AUTH_HEADERS,
  CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
  ControlPlaneProxyErrorCode,
  NodeAgentProxyRouteSchema,
  ProxyCorrelationIdSchema,
  type ProxyNodeCredential,
} from "@task-handoff/protocol/control-plane-proxy";
import type { Node } from "@task-handoff/protocol/control-plane";
import { bridgeWebSockets, type WebSocketLike } from "@task-handoff/protocol/websocket-bridge";
import { WebSocket as WsClient } from "ws";
import type { NodeAgentTransport, NodeAgentWebSocket } from "./client.ts";

type FetchImpl = typeof fetch;

export type ControlPlaneProxyCredentialProvider = (node: Node) => ProxyNodeCredential | undefined;

export type ControlPlaneProxyNodeAgentTransportOptions = {
  credentialForNode: ControlPlaneProxyCredentialProvider;
  fetchImpl?: FetchImpl;
  openWebSocket?: (url: string, protocols: string | string[] | undefined, headers: Record<string, string>) => WebSocketLike;
};

function structuredTransportError(message: string, code: string, statusCode: number, cause?: unknown) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  Object.assign(error, { code, statusCode, retryable: statusCode >= 500 });
  return error;
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || (error as Error & { code?: string }).code === "ABORT_ERR");
}

function requireProxyCredential(node: Node, provider: ControlPlaneProxyCredentialProvider) {
  if (node.connectionPath.kind !== "control-plane-proxy") {
    throw structuredTransportError("Control-plane proxy transport requires a proxy connection path.", "CONTROL_PLANE_PROXY_CONFIGURATION_INVALID", 400);
  }
  const credential = provider(node);
  if (!credential) {
    throw structuredTransportError("Control-plane proxy credential is missing.", "CONTROL_PLANE_PROXY_CREDENTIAL_REQUIRED", 503);
  }
  if (credential.nodeId !== node.id
    || credential.proxyBindingId !== node.connectionPath.proxyBindingId
    || credential.targetNodeId !== node.connectionPath.targetNodeId) {
    throw structuredTransportError("Control-plane proxy credential does not match the node connection identity.", "CONTROL_PLANE_PROXY_CREDENTIAL_MISMATCH", 409);
  }
  return credential;
}

export function controlPlaneProxyAuthenticationHeaders(credential: ProxyNodeCredential, headers?: HeadersInit) {
  const merged = new Headers(headers);
  merged.set(CONTROL_PLANE_PROXY_AUTH_HEADERS.protocolVersion, CONTROL_PLANE_PROXY_PROTOCOL_VERSION);
  merged.set(CONTROL_PLANE_PROXY_AUTH_HEADERS.sourceControlPlaneId, credential.sourceControlPlaneId);
  merged.set(CONTROL_PLANE_PROXY_AUTH_HEADERS.bindingKeyId, credential.bindingKeyId);
  merged.set(CONTROL_PLANE_PROXY_AUTH_HEADERS.credential, credential.credential);
  const requestId = ProxyCorrelationIdSchema.safeParse(merged.get("x-request-id"));
  merged.set("x-request-id", requestId.success ? requestId.data : `proxy_request_${crypto.randomUUID().replace(/-/g, "")}`);
  return Object.fromEntries(merged.entries());
}

function normalizedRoute(route: string) {
  const parsed = NodeAgentProxyRouteSchema.safeParse(route);
  if (parsed.success) return parsed.data;
  const error = structuredTransportError("Control-plane proxy route is invalid.", ControlPlaneProxyErrorCode.RouteInvalid, 400);
  Object.assign(error, { issues: parsed.error.issues });
  throw error;
}

export function controlPlaneProxyHttpUrl(credential: ProxyNodeCredential, route: string) {
  const parsedRoute = new URL(normalizedRoute(route), "https://node-agent.invalid");
  const url = new URL(
    `/api/node-proxy/bindings/${encodeURIComponent(credential.proxyBindingId)}/http${parsedRoute.pathname}`,
    credential.proxyOrigin,
  );
  url.search = parsedRoute.search;
  return url;
}

export function controlPlaneProxyWebSocketUrl(credential: ProxyNodeCredential, route: string) {
  const url = new URL(
    `/api/node-proxy/bindings/${encodeURIComponent(credential.proxyBindingId)}/websocket`,
    credential.proxyOrigin,
  );
  url.protocol = "wss:";
  url.searchParams.set("route", normalizedRoute(route));
  return url;
}

function defaultOpenWebSocket(url: string, protocols: string | string[] | undefined, headers: Record<string, string>) {
  return protocols
    ? new WsClient(url, protocols, { headers })
    : new WsClient(url, { headers });
}

export class ControlPlaneProxyNodeAgentTransport implements NodeAgentTransport {
  private readonly credentialForNode: ControlPlaneProxyCredentialProvider;
  private readonly fetchImpl: FetchImpl;
  private readonly openWebSocket: NonNullable<ControlPlaneProxyNodeAgentTransportOptions["openWebSocket"]>;

  constructor(options: ControlPlaneProxyNodeAgentTransportOptions) {
    this.credentialForNode = options.credentialForNode;
    this.fetchImpl = options.fetchImpl || fetch;
    this.openWebSocket = options.openWebSocket || defaultOpenWebSocket;
  }

  private async fetch(node: Node, route: string, init: RequestInit = {}) {
    const credential = requireProxyCredential(node, this.credentialForNode);
    const url = controlPlaneProxyHttpUrl(credential, route);
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: controlPlaneProxyAuthenticationHeaders(credential, init.headers),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw structuredTransportError(
        `Trusted control-plane proxy ${credential.proxyOrigin} is unavailable.`,
        "CONTROL_PLANE_PROXY_UNAVAILABLE",
        503,
        error,
      );
    }
  }

  request(node: Node, route: string, init: RequestInit = {}) {
    return this.fetch(node, route, init);
  }

  requestStream(node: Node, route: string, init: RequestInit = {}) {
    return this.fetch(node, route, init);
  }

  proxyWebSocket(
    node: Node,
    socket: NodeAgentWebSocket,
    route: string,
    protocols?: string | string[],
    headers: Record<string, string> = {},
  ) {
    const credential = requireProxyCredential(node, this.credentialForNode);
    const upstream = this.openWebSocket(
      controlPlaneProxyWebSocketUrl(credential, route).toString(),
      protocols,
      controlPlaneProxyAuthenticationHeaders(credential, headers),
    );
    bridgeWebSockets(socket, upstream, {
      onUpstreamError: () => socket.close(1011, "Control-plane proxy websocket failed."),
      onUpstreamErrorBeforeOpen: () => true,
    });
  }
}
