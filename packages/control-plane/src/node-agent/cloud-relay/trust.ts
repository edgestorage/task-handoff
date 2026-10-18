import { cloudEnvironmentForServiceOrigin, isTrustedCloudRelayUrl } from "../../../../../shared/cloud-environments.cjs";

function loopbackHostname(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/**
 * The node pins the cloud origin the binding command came from. HTTPS is
 * required except on loopback or when a test stack explicitly opts into plain
 * HTTP (the same escape hatch `cloud-environments.cjs` grants ad-hoc origins).
 */
export function resolveCloudOrigin(value: string, env: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw cloudOriginError("NODE_AGENT_CLOUD_RELAY_ORIGIN_INVALID", "Cloud relay origin must be a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw cloudOriginError("NODE_AGENT_CLOUD_RELAY_ORIGIN_INVALID", "Cloud relay origin must use http or https.");
  }
  if (url.protocol === "http:" && !loopbackHostname(url.hostname) && env.TASK_HANDOFF_NODE_AGENT_ALLOW_INSECURE_CLOUD_ORIGIN !== "1") {
    throw cloudOriginError("NODE_AGENT_CLOUD_RELAY_ORIGIN_INSECURE", "Cloud relay origin must use https.");
  }
  return url.origin;
}

/** A granted Relay URL is trusted only when its host belongs to the pinned cloud environment. */
export function trustedNodeRelayUrl(value: string | URL, serviceOrigin: string) {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(String(value));
  } catch {
    return false;
  }
  return isTrustedCloudRelayUrl(cloudEnvironmentForServiceOrigin(serviceOrigin), url);
}

export function cloudOriginError(code: string, message: string) {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}
