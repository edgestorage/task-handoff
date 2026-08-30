export const PROXY_HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function proxyWebSocketProtocols(headers: Record<string, unknown>) {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "sec-websocket-protocol");
  const value = entry?.[1];
  const text = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
  const protocols = text.split(",").map((protocol) => protocol.trim()).filter(Boolean);
  return protocols.length ? protocols : undefined;
}

export function proxyWebSocketHeaders(
  headers: Record<string, unknown>,
  options: { blockedHeaders?: ReadonlySet<string> } = {},
) {
  return Object.fromEntries(Object.entries(headers).flatMap(([key, value]) => {
    const lower = key.toLowerCase();
    if (value === undefined || options.blockedHeaders?.has(lower)) return [];
    if (lower.startsWith("sec-websocket-") && lower !== "sec-websocket-origin") return [];
    return [[key, Array.isArray(value) ? value.join(", ") : String(value)]];
  }));
}
