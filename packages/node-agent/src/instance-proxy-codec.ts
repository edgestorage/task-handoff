const DECODED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"]);

export { proxyWebSocketProtocols } from "@task-handoff/core/core/http-proxy";

export const INSTANCE_PROXY_REQUEST_BODY_LIMIT = 64 * 1024 * 1024;
const DEFAULT_INSTANCE_PROXY_RESPONSE_LIMIT = 64 * 1024 * 1024;

export function proxyResponseHeaders(headers: Headers) {
  return Object.fromEntries(
    [...headers.entries()].filter(([key]) => !DECODED_RESPONSE_HEADERS.has(key.toLowerCase())),
  );
}

export function proxyRequestBody(parsed: { body?: string; bodyBase64?: string }) {
  return parsed.bodyBase64 ? Buffer.from(parsed.bodyBase64, "base64") : parsed.body;
}

export function instanceProxyResponseLimit() {
  const configured = Number(process.env.TASK_HANDOFF_INSTANCE_PROXY_MAX_RESPONSE_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_INSTANCE_PROXY_RESPONSE_LIMIT;
}

export async function readResponseBodyWithLimit(response: Response, maxBytes: number) {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let length = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel("Instance proxy response limit exceeded.").catch(() => undefined);
      throw Object.assign(new Error("Instance proxy response limit exceeded."), {
        code: "INSTANCE_PROXY_RESPONSE_TOO_LARGE",
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}
