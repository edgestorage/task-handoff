import type { ModelProtocol } from "@task-handoff/protocol/control-plane";

/**
 * Hop-by-hop, framing and routing headers that must never cross the relay in
 * either direction. The node derives upstream routing from the assigned model
 * entity only, so caller-supplied routing/forwarding/auth headers are dropped
 * instead of being validated.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  // hop-by-hop / framing
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "expect",
  // host & forwarding
  "host", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", "via",
  // downstream authentication; upstream auth is injected from the private model record
  "authorization", "x-api-key", "cookie",
  // caller-supplied provider routing
  "x-provider", "x-upstream", "x-upstream-url", "x-target-endpoint", "x-api-base-url", "x-model-endpoint", "x-relay-target", "x-original-url",
  // let the HTTP client negotiate and transparently decode the upstream encoding
  "accept-encoding",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "trailer", "transfer-encoding", "upgrade",
  // fetch already decoded the body, so the upstream framing headers are stale
  "content-encoding", "content-length",
  "set-cookie", "cookie",
  // never redirect a controlled instance to an upstream-chosen location
  "location",
  "server", "x-powered-by",
]);

function appendHeader(target: Record<string, string>, name: string, value: string | string[] | undefined) {
  if (value === undefined) return;
  const joined = Array.isArray(value) ? value.join(", ") : value;
  if (!joined) return;
  target[name] = joined;
}

/**
 * Project inbound instance headers onto the upstream request. Only the
 * assigned entity's credential is added; the protocol picks its wire shape so
 * an OpenAI-style key never doubles as an Anthropic x-api-key.
 */
export function upstreamRequestHeaders(
  inbound: Record<string, string | string[] | undefined>,
  input: { protocol: ModelProtocol; credential: string },
) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(inbound)) {
    if (STRIPPED_REQUEST_HEADERS.has(name)) continue;
    appendHeader(headers, name, value);
  }
  if (input.protocol === "anthropic-messages") {
    headers["x-api-key"] = input.credential;
    delete headers.authorization;
  } else {
    headers.authorization = `Bearer ${input.credential}`;
    delete headers["x-api-key"];
  }
  return headers;
}

export function upstreamResponseHeaders(headers: Headers) {
  const projected: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    projected[name] = value;
  }
  return projected;
}
