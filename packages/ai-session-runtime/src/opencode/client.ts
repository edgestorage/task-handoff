import type { z } from "zod";
import {
  OpenCodeBooleanSchema,
  OpenCodeGlobalEventSchema,
  OpenCodeGlobalSessionListSchema,
  OpenCodeHealthSchema,
  OpenCodeMessageListSchema,
  OpenCodePermissionListSchema,
  OpenCodeSessionListSchema,
  OpenCodeSessionSchema,
  OpenCodeSessionStatusMapSchema,
  type OpenCodeGlobalEvent,
} from "./wire";

export type OpenCodeConnection = {
  endpoint: string;
  headers: Record<string, string>;
};

export type OpenCodePromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; filename?: string; url: string };

export type OpenCodeModelRef = { providerID: string; modelID: string; variant?: string };

export class OpenCodeHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly method: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeHttpError";
  }
}

export class OpenCodeClient {
  constructor(private readonly connection: () => OpenCodeConnection | Promise<OpenCodeConnection>) {}

  health() {
    return this.request("/global/health", OpenCodeHealthSchema);
  }

  listSessions(directory: string) {
    return this.request("/session", OpenCodeSessionListSchema, { directory, query: { scope: "project", limit: 100 } });
  }

  listGlobalSessions(cursor?: string) {
    return this.requestPage("/experimental/session", OpenCodeGlobalSessionListSchema, {
      query: { archived: false, limit: 100, ...(cursor ? { cursor } : {}) },
    });
  }

  getSession(sessionID: string, directory: string) {
    return this.request(`/session/${encodeURIComponent(sessionID)}`, OpenCodeSessionSchema, { directory });
  }

  status(directory: string) {
    return this.request("/session/status", OpenCodeSessionStatusMapSchema, { directory });
  }

  messages(sessionID: string, directory: string) {
    return this.request(`/session/${encodeURIComponent(sessionID)}/message`, OpenCodeMessageListSchema, {
      directory,
      query: { limit: 0 },
    });
  }

  permissions(directory: string) {
    return this.request("/permission", OpenCodePermissionListSchema, { directory });
  }

  createSession(directory: string, model?: OpenCodeModelRef) {
    return this.request("/session", OpenCodeSessionSchema, {
      method: "POST",
      directory,
      body: model ? { model: { id: model.modelID, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) } } : {},
    });
  }

  forkSession(sessionID: string, directory: string, messageID?: string) {
    return this.request(`/session/${encodeURIComponent(sessionID)}/fork`, OpenCodeSessionSchema, {
      method: "POST",
      directory,
      body: messageID ? { messageID } : {},
    });
  }

  archiveSession(sessionID: string, directory: string) {
    return this.request(`/session/${encodeURIComponent(sessionID)}`, OpenCodeSessionSchema, {
      method: "PATCH",
      directory,
      body: { time: { archived: Date.now() } },
    });
  }

  deleteSession(sessionID: string, directory: string) {
    return this.request(`/session/${encodeURIComponent(sessionID)}`, OpenCodeBooleanSchema, { method: "DELETE", directory });
  }

  abort(sessionID: string, directory: string) {
    return this.request(`/session/${encodeURIComponent(sessionID)}/abort`, OpenCodeBooleanSchema, { method: "POST", directory });
  }

  async promptAsync(sessionID: string, directory: string, messageID: string, parts: OpenCodePromptPart[], model?: OpenCodeModelRef) {
    await this.request(`/session/${encodeURIComponent(sessionID)}/prompt_async`, undefined, {
      method: "POST",
      directory,
      body: { messageID, parts, ...(model ? { model: { providerID: model.providerID, modelID: model.modelID }, ...(model.variant ? { variant: model.variant } : {}) } : {}) },
    });
  }

  replyPermission(requestID: string, directory: string, reply: "once" | "reject") {
    return this.request(`/permission/${encodeURIComponent(requestID)}/reply`, OpenCodeBooleanSchema, {
      method: "POST",
      directory,
      body: { reply },
    });
  }

  async subscribeGlobal(
    listener: (event: OpenCodeGlobalEvent) => void | Promise<void>,
    signal: AbortSignal,
  ) {
    const connection = await this.connection();
    const response = await fetch(new URL("/global/event", normalizedEndpoint(connection.endpoint)), {
      headers: { accept: "text/event-stream", ...connection.headers },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new OpenCodeHttpError(response.status, "GET", "/global/event", await responseText(response));
    }
    await consumeOpenCodeSse(response.body, listener, signal);
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T> | undefined,
    options: { method?: string; directory?: string; query?: Record<string, string | number | boolean>; body?: unknown } = {},
  ): Promise<T> {
    const { data } = await this.requestPage(path, schema, options);
    return data;
  }

  private async requestPage<T>(
    path: string,
    schema: z.ZodType<T> | undefined,
    options: { method?: string; directory?: string; query?: Record<string, string | number | boolean>; body?: unknown } = {},
  ): Promise<{ data: T; nextCursor?: string }> {
    const connection = await this.connection();
    const url = new URL(path, normalizedEndpoint(connection.endpoint));
    if (options.directory) url.searchParams.set("directory", options.directory);
    for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, String(value));
    const method = options.method || "GET";
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...connection.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) throw new OpenCodeHttpError(response.status, method, path, await responseText(response));
    const raw = response.status === 204 ? undefined : await response.json();
    return {
      data: schema ? schema.parse(raw) : raw as T,
      nextCursor: response.headers.get("x-next-cursor") || undefined,
    };
  }
}

export async function consumeOpenCodeSse(
  stream: ReadableStream<Uint8Array>,
  listener: (event: OpenCodeGlobalEvent) => void | Promise<void>,
  signal: AbortSignal,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (!signal.aborted) {
    const result = await reader.read();
    pending += decoder.decode(result.value, { stream: !result.done });
    let boundary = sseBoundary(pending);
    while (boundary) {
      const frame = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary.length);
      const data = frame.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) await listener(OpenCodeGlobalEventSchema.parse(JSON.parse(data)));
      boundary = sseBoundary(pending);
    }
    if (result.done) break;
  }
}

function normalizedEndpoint(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

async function responseText(response: Response) {
  const text = await response.text().catch(() => "");
  return text.slice(0, 4000) || `OpenCode returned HTTP ${response.status}.`;
}

function sseBoundary(value: string) {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}
