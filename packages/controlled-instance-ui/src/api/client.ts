import ky from "ky";
import type { HTTPError } from "ky";
import { useAuthStore } from "../stores/auth";
import { publicApiBaseUrl } from "./base";

export const api = ky.create({
  prefixUrl: publicApiBaseUrl(),
  timeout: 30_000,
  hooks: {
    beforeRequest: [
      (request) => {
        const token = useAuthStore().token;
        if (token) {
          request.headers.set("Authorization", `Bearer ${token}`);
        }
      },
    ],
  },
});

type ErrorPayload = {
  error?: {
    code?: string;
    message?: string;
  };
};

export class ApiError extends Error {
  code: string;
  status?: number;

  constructor(message: string, code = "API_ERROR", status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
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
        throw new ApiError(message, payload.error?.code, response.status);
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

export async function getApiData<T>(path: string): Promise<T> {
  const payload = await withApiError(api.get(path).json<{ data: T }>());
  return payload.data;
}

export async function postApiData<T>(path: string, body?: unknown): Promise<T> {
  const payload = await withApiError(api.post(path, { json: body ?? {} }).json<{ data: T }>());
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
