import { ApiError } from "./client.ts";

type ErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
  };
};

export type XhrFactory = () => XMLHttpRequest;

function parsedPayload(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function responseError(xhr: XMLHttpRequest, payload: unknown) {
  const error = payload && typeof payload === "object" ? (payload as ErrorPayload).error : undefined;
  return new ApiError(
    error?.message || `${xhr.status} ${xhr.statusText}`.trim(),
    error?.code || "HTTP_ERROR",
    xhr.status,
    error?.details,
    error?.retryable,
  );
}

export function requestJsonWithUploadProgress(
  path: string,
  init: RequestInit,
  onUploadProgress: (progress: number) => void,
  createXhr: XhrFactory = () => new XMLHttpRequest(),
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = createXhr();
    const signal = init.signal;
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => xhr.abort();

    xhr.open(init.method || "GET", path, true);
    xhr.timeout = 30_000;
    xhr.withCredentials = init.credentials === "include";
    for (const [name, value] of new Headers(init.headers)) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onUploadProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      const payload = parsedPayload(xhr.responseText);
      finish(() => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
        else reject(responseError(xhr, payload));
      });
    };
    xhr.onerror = () => finish(() => reject(new TypeError("Failed to fetch")));
    xhr.ontimeout = () => finish(() => reject(new ApiError("Request timed out.", "REQUEST_TIMEOUT")));
    xhr.onabort = () => finish(() => reject(new DOMException("The operation was aborted.", "AbortError")));

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });

    const body = init.body;
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
      finish(() => reject(new TypeError("XMLHttpRequest upload bodies cannot be ReadableStream instances.")));
      return;
    }
    xhr.send((body ?? null) as XMLHttpRequestBodyInit | null);
  });
}
