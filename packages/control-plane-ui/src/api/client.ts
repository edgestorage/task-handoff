import ky from "ky";
import type { HTTPError } from "ky";

export const api = ky.create({
  prefixUrl: "/api",
  timeout: 30_000,
});

const urlApi = ky.create({
  timeout: 30_000,
});

type ErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
  };
};

export class ApiError extends Error {
  code: string;
  status?: number;
  details?: Record<string, unknown>;
  retryable?: boolean;

  constructor(message: string, code = "API_ERROR", status?: number, details?: Record<string, unknown>, retryable?: boolean) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }
}

async function withApiError<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error && typeof error === "object" && "response" in error) {
      const response = (error as HTTPError).response;
      try {
        const payload = (await response.clone().json()) as ErrorPayload;
        const message = payload.error?.message || `${response.status} ${response.statusText}`;
        throw new ApiError(message, payload.error?.code, response.status, payload.error?.details, payload.error?.retryable);
      } catch (parseError) {
        if (parseError instanceof ApiError) {
          throw parseError;
        }
      }
      throw new ApiError(`${response.status} ${response.statusText}`, "HTTP_ERROR", response.status);
    }
    throw error;
  }
}

export async function getApiData<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> {
  const payload = await withApiError(api.get(path, options).json<{ data: T }>());
  return payload.data;
}

export async function getApiPayload<T, M = unknown>(path: string, options?: { signal?: AbortSignal }): Promise<{ data: T; meta?: M }> {
  return withApiError(api.get(path, options).json<{ data: T; meta?: M }>());
}

export async function postApiData<T>(path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const payload = await withApiError(api.post(path, { json: body ?? {}, ...options }).json<{ data: T }>());
  return payload.data;
}

export async function patchApiData<T>(path: string, body?: unknown): Promise<T> {
  const payload = await withApiError(api.patch(path, { json: body ?? {} }).json<{ data: T }>());
  return payload.data;
}

export async function deleteApiData<T>(path: string): Promise<T> {
  const payload = await withApiError(api.delete(path).json<{ data: T }>());
  return payload.data;
}

export async function getUrlData<T>(url: string, options?: { signal?: AbortSignal }): Promise<T> {
  const payload = await withApiError(urlApi.get(url, options).json<{ data: T }>());
  return payload.data;
}

export async function postUrlData<T>(url: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const payload = await withApiError(urlApi.post(url, { json: body ?? {}, ...options }).json<{ data: T }>());
  return payload.data;
}

export async function putUrlData<T>(url: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const payload = await withApiError(urlApi.put(url, { json: body ?? {}, ...options }).json<{ data: T }>());
  return payload.data;
}

export async function deleteUrlData<T>(url: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const payload = await withApiError(urlApi.delete(url, { json: body, ...options }).json<{ data: T }>());
  return payload.data;
}
