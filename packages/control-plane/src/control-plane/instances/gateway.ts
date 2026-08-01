import { controlledInstanceAcceptsTraffic, type ControlledInstance, type ControlledInstanceHeartbeat, type Node } from "@task-handoff/protocol/control-plane";
import { plainHeaders } from "../common/helpers.ts";
import type { NodeAgentTransport, NodeAgentWebSocket } from "../nodes/client.ts";

export type ControlledInstanceGatewayOptions = {
  requireNode: (nodeId: string) => Node;
  nodeAgentTransport: (node: Node) => NodeAgentTransport;
};

export type ControlledInstanceProxyHttpInit = Omit<RequestInit, "body"> & {
  body?: RequestInit["body"] | Buffer;
};

export class ControlledInstanceGateway {
  private readonly requireNode: ControlledInstanceGatewayOptions["requireNode"];
  private readonly nodeAgentTransport: ControlledInstanceGatewayOptions["nodeAgentTransport"];

  constructor(options: ControlledInstanceGatewayOptions) {
    this.requireNode = options.requireNode;
    this.nodeAgentTransport = options.nodeAgentTransport;
  }

  async request(instance: ControlledInstance, route: string, init: RequestInit = {}) {
    if (!instance.target.web || (instance.connectionStatus !== "online" && instance.agentStatus !== "online")) {
      const error = new Error(`Instance ${instance.name} is not reachable.`);
      Object.assign(error, { statusCode: 409, code: "INSTANCE_UNREACHABLE" });
      throw error;
    }
    assertInstanceAcceptsTraffic(instance);
    const node = this.requireNode(instance.nodeId);
    const response = await this.nodeAgentTransport(node).request(node, `/instances/${encodeURIComponent(instance.id)}/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: `/api/${route.replace(/^\/+/, "")}`,
        method: init.method || "GET",
        headers: plainHeaders(init.headers),
        body: requestBody(init.body),
      }),
    });
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: unknown };
    if (!response.ok) {
      const remoteError = remoteErrorPayload(payload.error);
      const message = remoteError?.message || errorMessage(payload.error) || `Instance request failed with HTTP ${response.status}`;
      const error = new Error(message);
      Object.assign(error, {
        statusCode: response.status,
        code: remoteError?.code || "INSTANCE_REQUEST_FAILED",
        ...(remoteError?.details ? { details: remoteError.details } : {}),
        instanceId: instance.id,
        nodeId: instance.nodeId,
        route,
      });
      throw error;
    }
    return payload.data ?? payload;
  }

  async proxyHttp(instance: ControlledInstance, path: string, init: ControlledInstanceProxyHttpInit = {}) {
    if (instance.connectionStatus !== "online" && instance.agentStatus !== "online") {
      const error = new Error(`Instance ${instance.name} is not reachable.`);
      Object.assign(error, { statusCode: 409, code: "INSTANCE_UNREACHABLE" });
      throw error;
    }
    if (!instance.target.web) {
      const error = new Error(`Instance ${instance.name} web endpoint is not reachable.`);
      Object.assign(error, { statusCode: 409, code: "INSTANCE_WEB_UNREACHABLE" });
      throw error;
    }
    assertInstanceAcceptsTraffic(instance);
    const node = this.requireNode(instance.nodeId);
    const response = await this.nodeAgentTransport(node).requestStream(node, `/instances/${encodeURIComponent(instance.id)}/proxy/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: init.signal,
      body: JSON.stringify({
        path,
        method: init.method || "GET",
        headers: plainHeaders(init.headers),
        ...rawProxyBody(init.body),
      }),
    });
    return {
      status: response.status || 502,
      headers: Object.fromEntries(response.headers.entries()),
      body: response.body,
    };
  }

  proxyWebSocket(instance: ControlledInstance, socket: NodeAgentWebSocket, path: string, protocols?: string | string[], headers: Record<string, string> = {}) {
    if (!instance.target.web || (instance.connectionStatus !== "online" && instance.agentStatus !== "online")) {
      const error = new Error(`Instance ${instance.name} web endpoint is not reachable.`);
      Object.assign(error, { statusCode: 409, code: "INSTANCE_WEB_UNREACHABLE" });
      throw error;
    }
    assertInstanceAcceptsTraffic(instance);
    const node = this.requireNode(instance.nodeId);
    const proxyPath = path.startsWith("/") ? path.slice(1) : path;
    this.nodeAgentTransport(node).proxyWebSocket(node, socket, `/instances/${encodeURIComponent(instance.id)}/proxy/ws/${proxyPath}`, protocols, headers);
  }

  async reportHeartbeat(instance: ControlledInstance, input: ControlledInstanceHeartbeat) {
    if (!instance.registrationToken) {
      return;
    }
    const node = this.requireNode(instance.nodeId);
    const route = `/instances/${encodeURIComponent(instance.id)}/heartbeat`;
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${instance.registrationToken}`,
      },
      body: JSON.stringify(input),
    };
    const response = await this.nodeAgentTransport(node).request(node, route, init);
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: { message?: string } };
    if (!response.ok) {
      const error = new Error(payload.error?.message || `Instance heartbeat sync failed with HTTP ${response.status}`);
      Object.assign(error, { statusCode: response.status, code: "INSTANCE_HEARTBEAT_SYNC_FAILED" });
      throw error;
    }
  }
}

function assertInstanceAcceptsTraffic(instance: ControlledInstance) {
  if (controlledInstanceAcceptsTraffic(instance)) return;
  const error = new Error(`Instance ${instance.name} is not ready.`);
  Object.assign(error, {
    statusCode: 409,
    code: "INSTANCE_NOT_READY",
    runtimePhase: instance.runtimeVersion?.phase,
  });
  throw error;
}

function errorMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : "";
}

function remoteErrorPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const code = typeof record.code === "string" && record.code.trim() ? record.code : undefined;
  const message = typeof record.message === "string" && record.message ? record.message : undefined;
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details) ? record.details as Record<string, unknown> : undefined;
  return code || message ? { code, message, details } : undefined;
}

function requestBody(body: BodyInit | null | undefined) {
  return typeof body === "string" ? body : body === undefined || body === null ? undefined : String(body);
}

function rawProxyBody(body: ControlledInstanceProxyHttpInit["body"] | null | undefined) {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { body };
  if (Buffer.isBuffer(body)) return { bodyBase64: body.toString("base64") };
  if (body instanceof Uint8Array) return { bodyBase64: Buffer.from(body).toString("base64") };
  return { body: String(body) };
}
