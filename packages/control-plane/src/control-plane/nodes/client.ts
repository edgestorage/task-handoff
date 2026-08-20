import { z } from "zod";
import type { Node } from "@task-handoff/protocol/control-plane";
import { safeParseResponse } from "@task-handoff/protocol/response-validation";

export type NodeAgentWebSocket = {
  on(event: string, listener: (...args: unknown[]) => void): void;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  readyState: number;
};

export type NodeAgentWebSocketControl = {
  ping?: () => void;
  onPong?: (listener: () => void) => void;
  send?: (data: unknown) => void;
};

export type NodeAgentTransport = {
  request(node: Node, route: string, init?: RequestInit): Promise<Response>;
  requestStream(node: Node, route: string, init?: RequestInit): Promise<Response>;
  proxyWebSocket(node: Node, socket: NodeAgentWebSocket, route: string, protocols?: string | string[], headers?: Record<string, string>): NodeAgentWebSocketControl | void;
};

type NodeAgentClientLogger = {
  info?: (data: unknown, message?: string) => void;
  warn?: (data: unknown, message?: string) => void;
};

export type NodeAgentClientOptions = {
  request: (node: Node, route: string, init?: RequestInit) => Promise<Response>;
  logger?: NodeAgentClientLogger;
};

export type NodeAgentScopedError = {
  nodeId: string;
  route: string;
  method: string;
  code: string;
  message: string;
  statusCode?: number;
  issues?: z.ZodIssue[];
};

export function nodeAgentScopedError(node: Node, route: string, method: string, error: unknown): NodeAgentScopedError {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return {
    nodeId: node.id,
    route: typeof record.route === "string" ? record.route : route,
    method,
    code: typeof record.code === "string" ? record.code : "NODE_AGENT_REQUEST_FAILED",
    message: error instanceof Error ? error.message : String(error),
    statusCode: typeof record.statusCode === "number" ? record.statusCode : undefined,
    issues: Array.isArray(record.issues) ? record.issues as z.ZodIssue[] : undefined,
  };
}

export class ControlPlaneNodeAgentClient {
  private readonly requestImpl: NodeAgentClientOptions["request"];
  readonly logger?: NodeAgentClientLogger;

  constructor(options: NodeAgentClientOptions) {
    this.requestImpl = options.request;
    this.logger = options.logger;
  }

  async request(node: Node, route: string, init: RequestInit = {}) {
    const method = init.method || "GET";
    let response: Response;
    try {
      response = await this.requestImpl(node, route, init);
    } catch (error) {
      this.logger?.warn?.({
        nodeId: node.id,
        route,
        method,
        error: error instanceof Error ? error.message : String(error),
        errorCode: "NODE_AGENT_TRANSPORT_FAILED",
      }, "node agent transport failed");
      throw error;
    }

    let payload: { data?: unknown; error?: { message?: string; code?: string } };
    try {
      payload = (await response.json()) as { data?: unknown; error?: { message?: string; code?: string } };
    } catch (error) {
      this.logger?.warn?.({
        nodeId: node.id,
        route,
        method,
        statusCode: response.status,
        error: error instanceof Error ? error.message : String(error),
        errorCode: "NODE_AGENT_RESPONSE_INVALID_JSON",
      }, "node agent response was not valid json");
      const wrapped = new Error(`Node agent ${node.id} returned invalid JSON for ${route}.`);
      Object.assign(wrapped, { statusCode: 502, code: "NODE_AGENT_RESPONSE_INVALID_JSON", nodeId: node.id, route });
      throw wrapped;
    }

    if (!response.ok) {
      const error = new Error(payload.error?.message || `Node agent request failed with HTTP ${response.status}`);
      Object.assign(error, { statusCode: response.status, code: payload.error?.code || "NODE_AGENT_REQUEST_FAILED", nodeId: node.id, route });
      this.logger?.warn?.({
        nodeId: node.id,
        route,
        method,
        statusCode: response.status,
        errorCode: payload.error?.code || "NODE_AGENT_REQUEST_FAILED",
        error: error.message,
      }, "node agent request failed");
      throw error;
    }

    this.logger?.info?.({ nodeId: node.id, route, method, statusCode: response.status }, "node agent request ok");
    return payload.data ?? payload;
  }

  async requestSchema<T>(node: Node, route: string, schema: z.ZodType<T>, init: RequestInit = {}) {
    return this.parse(node, route, schema, await this.request(node, route, init), init.method || "GET");
  }

  parse<T>(node: Node, route: string, schema: z.ZodType<T>, value: unknown, method = "GET") {
    const parsed = safeParseResponse(schema, value);
    if (parsed.success) {
      return parsed.data;
    }
    this.logger?.warn?.({
      nodeId: node.id,
      route,
      method,
      errorCode: "NODE_AGENT_PROTOCOL_INVALID",
      issues: parsed.error.issues,
    }, "node agent protocol response did not match schema");
    const error = new Error(`Node agent ${node.id} returned invalid protocol data for ${route}.`);
    Object.assign(error, {
      statusCode: 502,
      code: "NODE_AGENT_PROTOCOL_INVALID",
      nodeId: node.id,
      route,
      issues: parsed.error.issues,
    });
    throw error;
  }
}
