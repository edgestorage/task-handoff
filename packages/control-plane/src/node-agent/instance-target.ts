import type { ControlledInstance } from "@task-handoff/protocol/control-plane";

function invalidTarget(instance: ControlledInstance, message: string) {
  return Object.assign(new Error(`Instance ${instance.id} has an invalid node-owned web endpoint: ${message}`), {
    statusCode: 409,
    code: "NODE_INSTANCE_WEB_ENDPOINT_INVALID",
  });
}

/**
 * Resolve the endpoint assigned by the node-agent runtime adapter.
 *
 * Controlled-instance reports never own this value. Rechecking the internal
 * record here also prevents a legacy poisoned snapshot from becoming an SSRF
 * primitive before runtime convergence has refreshed it.
 */
export function nodeLocalInstanceWebBase(instance: ControlledInstance, authoritativeWeb?: string) {
  const webBase = authoritativeWeb || (instance.runtime?.kind === "local" && instance.runtime.port
    ? `http://127.0.0.1:${instance.runtime.port}`
    : undefined);
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
