export const MOBILE_EVENT_STREAM_ROUTE = "/api/events?aiSessionTransient=1&resourceMetricsScope=1";

const RELAY_SESSION_BOOTSTRAP_PATH = "/api/v1/relay-sessions/bootstrap";
const RELAY_SESSION_CONFIRM_PATH = /^\/api\/v1\/relay-selections\/[^/]+\/confirm$/;

/**
 * Cloud endpoint failover may replay only Relay establishment mutations that
 * carry an idempotency key. Other authenticated POSTs are never retried.
 */
export function isReplayableRelaySessionMutation(method: string, pathname: string, headers?: HeadersInit) {
  if (method !== "POST" || !hasHeader(headers, "idempotency-key")) return false;
  return pathname === RELAY_SESSION_BOOTSTRAP_PATH || RELAY_SESSION_CONFIRM_PATH.test(pathname);
}

function hasHeader(headers: HeadersInit | undefined, name: string) {
  if (!headers) return false;
  const normalized = name.toLowerCase();
  const candidate = headers as { get?: (key: string) => string | null };
  if (typeof candidate.get === "function") return Boolean(candidate.get(normalized));
  if (Array.isArray(headers)) return headers.some(([key, value]) => key.toLowerCase() === normalized && Boolean(value));
  return Object.entries(headers as Record<string, string>).some(([key, value]) => key.toLowerCase() === normalized && Boolean(value));
}
