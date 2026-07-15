import type Fastify from "fastify";
import type WebSocket from "ws";

export type NodeAgentInjectResponse = Awaited<ReturnType<ReturnType<typeof Fastify>["inject"]>>;

export function websocketPayload(data: WebSocket.RawData, isBinary: boolean) {
  return isBinary ? data : data.toString();
}

type NodeAgentProxyMethod = "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT" | "OPTIONS";

const NODE_AGENT_PROXY_METHODS = new Set<NodeAgentProxyMethod>(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT", "OPTIONS"]);

export function nodeAgentProxyMethod(value: unknown): NodeAgentProxyMethod {
  return typeof value === "string" && NODE_AGENT_PROXY_METHODS.has(value.toUpperCase() as NodeAgentProxyMethod)
    ? value.toUpperCase() as NodeAgentProxyMethod
    : "GET";
}
