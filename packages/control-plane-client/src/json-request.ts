export function jsonRequest(method: string, body?: unknown, signal?: AbortSignal): RequestInit {
  if (body === undefined) {
    return signal === undefined ? { method } : { method, signal };
  }
  return {
    method,
    ...(signal === undefined ? {} : { signal }),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
