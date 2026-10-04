import type { ControlPlaneService } from "../application/service.ts";

/**
 * Node Agent 请求边界：把 Node 的结构化错误（code / statusCode / details）原样带过 Control Plane，
 * 让调用方拿到与直连 Node 一致的错误契约，而不是被压成泛化的网关错误。
 */
export async function nodeJson(service: ControlPlaneService, nodeId: string, route: string, init: RequestInit = {}) {
  const node = service.requireNode(nodeId);
  const transport = service.resolveNodeAgentTransport(node);
  const response = await transport.request(node, route, init);
  const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: { code?: string; message?: string; details?: Record<string, unknown>; retryable?: boolean } };
  if (!response.ok) {
    throw Object.assign(new Error(payload.error?.message || `Node agent request failed with HTTP ${response.status}.`), {
      statusCode: response.status,
      code: payload.error?.code || "NODE_AGENT_REQUEST_FAILED",
      ...(payload.error?.details ? { details: payload.error.details } : {}),
      ...(payload.error?.retryable !== undefined ? { retryable: payload.error.retryable } : {}),
    });
  }
  return payload.data;
}
