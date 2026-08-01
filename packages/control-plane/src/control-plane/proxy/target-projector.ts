import type { Node } from "@task-handoff/protocol/control-plane";
import type { ProxyTargetSnapshot } from "@task-handoff/protocol/control-plane-proxy";

export type ControlPlaneProxyTarget = ProxyTargetSnapshot["target"] & {
  manageable: boolean;
};

const MAX_PROXY_TARGET_BYTES = 256 * 1024;

export function projectControlPlaneProxyTarget(node: Node, tunnelConnected: boolean): ControlPlaneProxyTarget {
  const tunnelOnline = node.connectionMode === "reverse-wss" && tunnelConnected;
  const status = tunnelOnline ? "online" : node.status;
  return {
    id: node.id,
    name: node.name || node.id,
    status,
    health: node.health,
    ...(node.lastSeenAt ? { lastSeenAt: node.lastSeenAt } : {}),
    capabilities: sanitizeJsonProjection(node.capabilities || {}, MAX_PROXY_TARGET_BYTES),
    manageable: node.connectionEnabled !== false && (tunnelOnline || status === "online"),
  };
}

function sanitizeJsonProjection(value: unknown, maxBytes: number) {
  const seen = new WeakSet<object>();
  let budget = maxBytes;
  let nodes = 0;
  const consume = (text: string) => {
    budget -= Buffer.byteLength(text, "utf8");
    if (budget < 0) throw targetProjectionError("Proxy target projection byte limit exceeded.", { resource: "target-projection-bytes", limit: maxBytes });
  };
  const visit = (input: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 16_384 || depth > 24) throw targetProjectionError("Proxy target projection complexity limit exceeded.");
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") { consume(input); return input; }
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input !== "object") return undefined;
    if (seen.has(input)) throw targetProjectionError("Proxy target projection contains a cycle.", undefined, false);
    seen.add(input);
    if (Array.isArray(input)) {
      const output = input.map((item) => visit(item, depth + 1) ?? null);
      seen.delete(input);
      return output;
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      consume(key);
      const sanitized = visit(item, depth + 1);
      if (sanitized !== undefined) output[key] = sanitized;
    }
    seen.delete(input);
    return output;
  };
  return visit(value, 0) as Record<string, unknown>;
}

function targetProjectionError(message: string, details?: Record<string, unknown>, retryable = true) {
  return Object.assign(new Error(message), {
    code: "CONTROL_PLANE_PROXY_RESOURCE_LIMIT",
    statusCode: 429,
    retryable,
    ...(details ? { details } : {}),
  });
}

export function publicControlPlaneProxyTarget(target: ControlPlaneProxyTarget): ProxyTargetSnapshot["target"] {
  const { manageable: _manageable, ...projection } = target;
  return projection;
}
