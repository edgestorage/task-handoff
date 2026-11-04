import type { ControlledInstance } from "@task-handoff/protocol/control-plane";

function invalidTarget(instance: ControlledInstance, message: string) {
  return Object.assign(new Error(`Instance ${instance.id} has an invalid node-owned web endpoint: ${message}`), {
    statusCode: 409,
    code: "NODE_INSTANCE_WEB_ENDPOINT_INVALID",
  });
}

export type AuthoritativeInstanceWebOptions = {
  /** adapter 解析出的权威 endpoint；Controlled Instance 的上报值 MUST NOT 出现在这里。 */
  authoritativeWeb?: string;
  /** 显式声明可从实例记录回退的 runtime kind；未声明时 MUST NOT 回退。 */
  fallbackKind?: string;
  /** 显式回退 endpoint；与 fallbackKind 二选一，缺省时按 fallbackKind + runtime.port 推导。 */
  fallbackWeb?: string;
};

/**
 * Resolve the endpoint assigned by the node-agent runtime adapter.
 *
 * Controlled-instance reports never own this value. Rechecking the internal
 * record here also prevents a legacy poisoned snapshot from becoming an SSRF
 * primitive before runtime convergence has refreshed it.
 *
 * 这是实例 endpoint 的**唯一**权威入口（openspec change refactor-runtime-adapter-registry，D3）：
 * adapter 权威值优先；回退必须由显式 `fallbackKind`/`fallbackWeb` 声明，新增 runtime MUST NOT
 * 隐式继承其它 runtime 的回退语义。
 */
export function resolveAuthoritativeInstanceWeb(instance: ControlledInstance, options: AuthoritativeInstanceWebOptions = {}) {
  const declaredFallback = options.fallbackWeb
    || (options.fallbackKind && instance.runtime?.kind === options.fallbackKind && instance.runtime.port
      ? `http://127.0.0.1:${instance.runtime.port}`
      : undefined);
  const webBase = options.authoritativeWeb || declaredFallback;
  if (!webBase) {
    const error = new Error(`Instance ${instance.id} does not have a web endpoint.`);
    Object.assign(error, { statusCode: 409, code: "NODE_INSTANCE_WEB_ENDPOINT_MISSING" });
    throw error;
  }
  let url: URL;
  try {
    url = new URL(webBase);
  } catch {
    throw invalidTarget(instance, "endpoint is not a URL");
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash
  ) {
    throw invalidTarget(instance, "endpoint must be an origin-only http://127.0.0.1:<port> URL");
  }
  return url.origin;
}

/** 兼容包装：Local runtime 的显式回退语义（既有调用点保持不变）。 */
export function nodeLocalInstanceWebBase(instance: ControlledInstance, authoritativeWeb?: string) {
  return resolveAuthoritativeInstanceWeb(instance, { authoritativeWeb, fallbackKind: "local" });
}
