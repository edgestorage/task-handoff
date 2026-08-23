import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable, Transform } from "node:stream";
import type { ControlPlaneService } from "../application/service.ts";
import type { ControlPlaneAuth } from "../auth/service.ts";
import { CONTROL_PLANE_SESSION_COOKIE } from "../auth/service.ts";
import { PUBLIC_CONTROL_PLANE_ROUTE } from "./auth-boundary.ts";
import { PROXY_HOP_BY_HOP_HEADERS, proxyWebSocketHeaders, proxyWebSocketProtocols } from "@task-handoff/core/core/http-proxy";
import { CONTROL_PLANE_CREDENTIAL_HEADERS } from "./proxy-headers.ts";
import type { AuthorizationConnectionRegistry } from "../auth/authorization-connections.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";

const DECODED_RESPONSE_HEADERS = new Set(["content-encoding"]);
const INSTANCE_WEBSOCKET_BLOCKED_HEADERS = new Set(["host", ...CONTROL_PLANE_CREDENTIAL_HEADERS]);
const MAX_PROXY_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

export type RegisterInstanceProxyRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  auth: ControlPlaneAuth;
  authorizationConnections: AuthorizationConnectionRegistry;
};

export function registerInstanceProxyRoutes({ app, service, auth, authorizationConnections }: RegisterInstanceProxyRoutesOptions) {
  registerRawProxyBodyParsers(app);

  const appAccessTarget = async (token: string, mode: "tty" | "vnc" | "web", suffix = "") => {
    const access = service.resolveAppAccessToken(token, mode);
    if (access.authorization) auth.assertAppAccessAuthorization(access.authorization);
    return service.appAccessProxyTarget(token, mode, suffix);
  };

  const trackSocket = (socket: ProxySocket, binding: { userId: string; authorizationRevision: number } | undefined) => {
    if (!binding) return;
    const release = authorizationConnections.track(binding, () => socket.close(4001, "Authorization changed."));
    socket.on("close", release);
  };

  const proxyInstanceWebSocket = async (socket: ProxySocket, request: ProxyRequest) => {
    const params = request.params as { id: string; "*": string };
    const suffix = params["*"] || "";
    const queryIndex = request.url.indexOf("?");
    const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
    try {
      const actor = controlPlaneRequestActor(request as FastifyRequest);
      trackSocket(socket, actor?.type === "user" ? actor : undefined);
      await service.proxyInstanceWebSocket(params.id, socket, `/${suffix}${query}`, proxyWebSocketProtocols(request.headers), instanceProxyWebSocketHeaders(request.headers));
    } catch {
      socket.close(1011, "Instance websocket endpoint is not reachable.");
    }
  };

  app.get("/api/app-access/session", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request) => {
    const token = queryToken(request.url);
    const mode = (request.query as { mode?: string }).mode === "vnc" ? "vnc" : (request.query as { mode?: string }).mode === "web" ? "web" : "tty";
    const target = await appAccessTarget(token, mode);
    return {
      data: {
        mode,
        instance: {
          id: target.instance.id,
          name: target.instance.name,
          projectId: target.instance.projectId,
          projectName: typeof target.instance.sourceSnapshot.name === "string" ? target.instance.sourceSnapshot.name : undefined,
        },
        session: target.session,
        expiresAt: target.access.expiresAt,
        ttySocketPath: mode === "tty" ? `/apps/access/tty/ws?token=${encodeURIComponent(token)}` : undefined,
        vncFramePath: mode === "vnc" ? vncAccessFrameUrl(token, target.access.sessionId, target.session) : undefined,
      },
    };
  });

  app.get("/apps/access/tty/ws", { websocket: true, config: PUBLIC_CONTROL_PLANE_ROUTE }, async (socket, request) => {
    try {
      const target = await appAccessTarget(queryToken(request.url), "tty");
      trackSocket(socket, target.access.authorization);
      await service.proxyInstanceWebSocket(target.instance.id, socket, target.path, proxyWebSocketProtocols(request.headers), instanceProxyWebSocketHeaders(request.headers));
    } catch {
      socket.close(1011, "TTY access link is invalid or expired.");
    }
  });

  const proxyVncAccessWebSocket = async (socket: ProxySocket, request: ProxyRequest) => {
    const params = request.params as { token?: string; "*": string };
    try {
      const target = await appAccessTarget(params.token || queryToken(request.url), "vnc", params["*"] || "");
      trackSocket(socket, target.access.authorization);
      await service.proxyInstanceWebSocket(target.instance.id, socket, target.path, proxyWebSocketProtocols(request.headers), instanceProxyWebSocketHeaders(request.headers));
    } catch {
      socket.close(1011, "VNC access link is invalid or expired.");
    }
  };

  app.route({
    method: "GET",
    url: "/apps/access/vnc/proxy/*",
    config: PUBLIC_CONTROL_PLANE_ROUTE,
    wsHandler: proxyVncAccessWebSocket,
    handler: async (request, reply) => {
      const params = request.params as { "*": string };
      const target = await appAccessTarget(queryToken(request.url), "vnc", params["*"] || "");
      const proxied = await proxyInstanceHttp(service, reply, target.instance.id, target.path, {
        method: request.method,
        headers: proxyHeaders(request.headers),
      });
      return replyInstanceProxyResponse(reply, proxied, target.instance.id, target.path);
    },
  });

  app.route({
    method: "GET",
    url: "/apps/access/vnc/:token/proxy/*",
    config: PUBLIC_CONTROL_PLANE_ROUTE,
    wsHandler: proxyVncAccessWebSocket,
    handler: async (request, reply) => {
      const params = request.params as { token: string; "*": string };
      const target = await appAccessTarget(params.token, "vnc", params["*"] || "");
      const proxied = await proxyInstanceHttp(service, reply, target.instance.id, target.path, {
        method: request.method,
        headers: proxyHeaders(request.headers),
      });
      return replyInstanceProxyResponse(reply, proxied, target.instance.id, target.path);
    },
  });

  app.all("/instances/:id", { bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
    const params = request.params as { id: string };
    if (request.method === "GET" || request.method === "HEAD") {
      return reply.redirect(`${instancePublicBase(params.id)}/`);
    }
    const proxied = await proxyInstanceHttp(service, reply, params.id, "/", {
      method: request.method,
      headers: proxyHeaders(request.headers),
      body: await requestBody(request.body),
    });
    return replyInstanceProxyResponse(reply, proxied, params.id, "/");
  });

  app.route({
    method: "GET",
    url: "/instances/:id/*",
    wsHandler: proxyInstanceWebSocket,
    handler: async (request, reply) => {
      const params = request.params as { id: string; "*": string };
      const suffix = params["*"] || "";
      const queryIndex = request.url.indexOf("?");
      const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
      const proxiedPath = `/${suffix}${query}`;
      const proxied = await proxyInstanceHttp(service, reply, params.id, proxiedPath, {
        method: request.method,
        headers: proxyHeaders(request.headers),
      });
      return replyInstanceProxyResponse(reply, proxied, params.id, proxiedPath);
    },
  });

  app.route({
    method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/instances/:id/*",
    bodyLimit: 64 * 1024 * 1024,
    handler: async (request, reply) => {
      const params = request.params as { id: string; "*": string };
      const suffix = params["*"] || "";
      const queryIndex = request.url.indexOf("?");
      const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
      const proxied = await proxyInstanceHttp(service, reply, params.id, `/${suffix}${query}`, {
        method: request.method,
        headers: proxyHeaders(request.headers),
        body: await requestBody(request.body),
      });
      return replyProxyResponse(reply, proxied);
    },
  });
}

type ProxySocket = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  send: (data: unknown, options?: { binary?: boolean }) => void;
  close: (code?: number, reason?: string) => void;
  readyState: number;
};

type ProxyRequest = {
  params: unknown;
  url: string;
  headers: Record<string, unknown>;
};

function proxyHeaders(headers: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(headers)
      .flatMap(([key, value]) => {
        const lower = key.toLowerCase();
        if (PROXY_HOP_BY_HOP_HEADERS.has(lower) || lower === "authorization" || typeof value === "undefined") return [];
        const text = Array.isArray(value) ? value.join(", ") : String(value);
        if (lower !== "cookie") return [[key, text]];
        const forwarded = withoutControlPlaneSessionCookie(text);
        return forwarded ? [[key, forwarded]] : [];
      }),
  );
}

function withoutControlPlaneSessionCookie(value: string) {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && part.slice(0, part.indexOf("=")).trim() !== CONTROL_PLANE_SESSION_COOKIE)
    .join("; ");
}

function instanceProxyWebSocketHeaders(headers: Record<string, unknown>) {
  return proxyWebSocketHeaders(proxyHeaders(headers), { blockedHeaders: INSTANCE_WEBSOCKET_BLOCKED_HEADERS });
}

type StreamingProxyResponse = { status: number; headers: Record<string, string>; body: ReadableStream<Uint8Array> | null };

function proxyInstanceHttp(
  service: ControlPlaneService,
  reply: FastifyReply,
  instanceId: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  reply.raw.once("close", abort);
  return service.proxyInstanceHttp(instanceId, path, { ...init, signal: controller.signal });
}

function replyProxyResponse(reply: FastifyReply, response: StreamingProxyResponse, transform?: Transform) {
  for (const [key, value] of Object.entries(response.headers)) {
    const lower = key.toLowerCase();
    if (!PROXY_HOP_BY_HOP_HEADERS.has(lower) && !DECODED_RESPONSE_HEADERS.has(lower)) {
      reply.header(key, value);
    }
  }
  if (!response.body) return reply.code(response.status).send();
  const readable = Readable.fromWeb(response.body as never);
  reply.raw.once("close", () => readable.destroy());
  return reply.code(response.status).send(transform ? readable.pipe(transform) : readable);
}

function instancePublicBase(instanceId: string) {
  return `/instances/${encodeURIComponent(instanceId)}`;
}

function injectInstancePublicBase(html: string, publicBase: string) {
  if (html.includes("__TASK_HANDOFF_PUBLIC_BASE__")) {
    return html;
  }
  const injection = `<script>window.__TASK_HANDOFF_PUBLIC_BASE__=${JSON.stringify(publicBase)};</script>`;
  return /<head(\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${injection}`)
    : `${injection}\n${html}`;
}

function instancePublicBaseTransform(publicBase: string) {
  const prefixChunks: Buffer[] = [];
  let prefixLength = 0;
  let decided = false;
  const decide = (stream: Transform, final = false) => {
    if (decided) return;
    const prefix = Buffer.concat(prefixChunks, prefixLength).toString("utf8");
    const head = /<head(\s[^>]*)?>/i.exec(prefix);
    if (!head && !final && prefixLength < 64 * 1024) return;
    decided = true;
    stream.push(injectInstancePublicBase(prefix, publicBase));
    prefixChunks.length = 0;
    prefixLength = 0;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (decided) {
        this.push(chunk);
      } else {
        prefixChunks.push(Buffer.from(chunk));
        prefixLength += chunk.length;
        decide(this);
      }
      callback();
    },
    flush(callback) {
      decide(this, true);
      callback();
    },
  });
}

function shouldInjectInstancePublicBase(proxiedPath: string, contentType: string) {
  const pathname = proxiedPath.split("?", 1)[0] || "/";
  return contentType.toLowerCase().includes("text/html") && !pathname.startsWith("/api/");
}

function replyInstanceProxyResponse(reply: FastifyReply, response: StreamingProxyResponse, instanceId: string, proxiedPath: string) {
  const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
  const transform = shouldInjectInstancePublicBase(proxiedPath, contentType) ? instancePublicBaseTransform(instancePublicBase(instanceId)) : undefined;
  return replyProxyResponse(reply, response, transform);
}

async function requestBody(body: unknown) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof URLSearchParams) return body.toString();
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const value of body as AsyncIterable<unknown>) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      length += chunk.length;
      if (length > MAX_PROXY_REQUEST_BODY_BYTES) {
        throw Object.assign(new Error("Instance proxy request body exceeds the configured limit."), {
          statusCode: 413,
          code: "INSTANCE_PROXY_REQUEST_TOO_LARGE",
        });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  }
  return typeof body === "string" ? body : body === undefined || body === null ? undefined : JSON.stringify(body);
}

function registerRawProxyBodyParsers(app: FastifyInstance) {
  for (const contentType of ["application/octet-stream", "application/x-www-form-urlencoded"]) {
    addRawProxyBodyParser(app, contentType);
  }
  addRawProxyBodyParser(app, /^multipart\/form-data(?:;.*)?$/i);
}

function addRawProxyBodyParser(app: FastifyInstance, contentType: string | RegExp) {
  if (typeof contentType === "string" && app.hasContentTypeParser(contentType)) return;
  try {
    app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  } catch (error) {
    if (error instanceof Error && /Content type parser .* already present/i.test(error.message)) return;
    throw error;
  }
}

function queryToken(url: string) {
  const parsed = new URL(url, "http://control-plane.local");
  return parsed.searchParams.get("token") || "";
}

export function vncAccessFrameUrl(token: string, sessionId: string, session: Record<string, unknown>) {
  const encodedToken = encodeURIComponent(token);
  const encodedSessionId = encodeURIComponent(sessionId);
  const accessBase = `apps/access/vnc/${encodedToken}/proxy`;
  const vnc = session.vnc && typeof session.vnc === "object" ? session.vnc as Record<string, unknown> : {};
  const backend = typeof vnc.backend === "string" ? vnc.backend : "";
  return backend === "kasmvnc"
    ? `/${accessBase}/api/apps/sessions/${encodedSessionId}/web/`
    : `/${accessBase}/api/novnc/vnc.html?path=${encodeURIComponent(`${accessBase}/api/apps/sessions/${encodedSessionId}/vnc`)}&autoconnect=1&resize=scale`;
}
