import type { FastifyInstance, FastifyReply } from "fastify";
import type { ControlPlaneService } from "../application/service.ts";

const HOP_BY_HOP_HEADERS = new Set(["connection", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const DECODED_RESPONSE_HEADERS = new Set(["content-encoding"]);

export type RegisterInstanceProxyRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
};

export function registerInstanceProxyRoutes({ app, service }: RegisterInstanceProxyRoutesOptions) {
  registerRawProxyBodyParsers(app);

  const proxyInstanceWebSocket = async (socket: ProxySocket, request: ProxyRequest) => {
    const params = request.params as { id: string; "*": string };
    const suffix = params["*"] || "";
    const queryIndex = request.url.indexOf("?");
    const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
    try {
      await service.proxyInstanceWebSocket(params.id, socket, `/${suffix}${query}`, proxyWebSocketProtocols(request.headers), proxyWebSocketHeaders(request.headers));
    } catch {
      socket.close(1011, "Instance websocket endpoint is not reachable.");
    }
  };

  app.get("/api/app-access/session", async (request) => {
    const token = queryToken(request.url);
    const mode = (request.query as { mode?: string }).mode === "vnc" ? "vnc" : (request.query as { mode?: string }).mode === "web" ? "web" : "tty";
    const target = await service.appAccessProxyTarget(token, mode);
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

  app.get("/apps/access/tty/ws", { websocket: true }, async (socket, request) => {
    try {
      const target = await service.appAccessProxyTarget(queryToken(request.url), "tty");
      await service.proxyInstanceWebSocket(target.instance.id, socket, target.path, proxyWebSocketProtocols(request.headers), proxyWebSocketHeaders(request.headers));
    } catch {
      socket.close(1011, "TTY access link is invalid or expired.");
    }
  });

  const proxyVncAccessWebSocket = async (socket: ProxySocket, request: ProxyRequest) => {
    const params = request.params as { "*": string };
    try {
      const target = await service.appAccessProxyTarget(queryToken(request.url), "vnc", params["*"] || "");
      await service.proxyInstanceWebSocket(target.instance.id, socket, target.path, proxyWebSocketProtocols(request.headers), proxyWebSocketHeaders(request.headers));
    } catch {
      socket.close(1011, "VNC access link is invalid or expired.");
    }
  };

  app.route({
    method: "GET",
    url: "/apps/access/vnc/proxy/*",
    wsHandler: proxyVncAccessWebSocket,
    handler: async (request, reply) => {
      const params = request.params as { "*": string };
      const target = await service.appAccessProxyTarget(queryToken(request.url), "vnc", params["*"] || "");
      const proxied = await service.proxyInstanceHttp(target.instance.id, target.path, {
        method: request.method,
        headers: proxyHeaders(request.headers),
      });
      return replyInstanceProxyResponse(reply, proxied, target.instance.id, target.path);
    },
  });

  app.all("/instances/:id", async (request, reply) => {
    const params = request.params as { id: string };
    if (request.method === "GET" || request.method === "HEAD") {
      return reply.redirect(`${instancePublicBase(params.id)}/`);
    }
    const proxied = await service.proxyInstanceHttp(params.id, "/", {
      method: request.method,
      headers: proxyHeaders(request.headers),
      body: requestBody(request.body),
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
      const proxied = await service.proxyInstanceHttp(params.id, proxiedPath, {
        method: request.method,
        headers: proxyHeaders(request.headers),
      });
      return replyInstanceProxyResponse(reply, proxied, params.id, proxiedPath);
    },
  });

  app.route({
    method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/instances/:id/*",
    handler: async (request, reply) => {
      const params = request.params as { id: string; "*": string };
      const suffix = params["*"] || "";
      const queryIndex = request.url.indexOf("?");
      const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
      const proxied = await service.proxyInstanceHttp(params.id, `/${suffix}${query}`, {
        method: request.method,
        headers: proxyHeaders(request.headers),
        body: requestBody(request.body),
      });
      return replyProxyResponse(reply, proxied);
    },
  });
}

type ProxySocket = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  send: (data: unknown) => void;
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
      .filter(([key, value]) => !HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && typeof value !== "undefined")
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value)]),
  );
}

function proxyWebSocketHeaders(headers: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(proxyHeaders(headers)).filter(([key]) => {
      const lower = key.toLowerCase();
      if (lower === "host" || lower === "cookie" || lower === "authorization") {
        return false;
      }
      return !lower.startsWith("sec-websocket-") || lower === "sec-websocket-origin";
    }),
  );
}

function proxyWebSocketProtocols(headers: Record<string, unknown>) {
  const value = headers["sec-websocket-protocol"];
  const text = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
  const protocols = text
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  return protocols.length ? protocols : undefined;
}

function replyProxyResponse(reply: FastifyReply, response: { status: number; headers: Record<string, string>; body: Buffer }) {
  for (const [key, value] of Object.entries(response.headers)) {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower) && !DECODED_RESPONSE_HEADERS.has(lower)) {
      reply.header(key, value);
    }
  }
  return reply.code(response.status).send(response.body);
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

function shouldInjectInstancePublicBase(proxiedPath: string, contentType: string) {
  const pathname = proxiedPath.split("?", 1)[0] || "/";
  return contentType.toLowerCase().includes("text/html") && !pathname.startsWith("/api/");
}

function replyInstanceProxyResponse(reply: FastifyReply, response: { status: number; headers: Record<string, string>; body: Buffer }, instanceId: string, proxiedPath: string) {
  const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
  const body = shouldInjectInstancePublicBase(proxiedPath, contentType)
    ? Buffer.from(injectInstancePublicBase(response.body.toString("utf8"), instancePublicBase(instanceId)), "utf8")
    : response.body;
  return replyProxyResponse(reply, { ...response, body });
}

function requestBody(body: unknown) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof URLSearchParams) return body.toString();
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

function vncAccessFrameUrl(token: string, sessionId: string, session: Record<string, unknown>) {
  const encodedToken = encodeURIComponent(token);
  const encodedSessionId = encodeURIComponent(sessionId);
  const vnc = session.vnc && typeof session.vnc === "object" ? session.vnc as Record<string, unknown> : {};
  const backend = typeof vnc.backend === "string" ? vnc.backend : "";
  return backend === "kasmvnc"
    ? `/apps/access/vnc/proxy/api/apps/sessions/${encodedSessionId}/web/?token=${encodedToken}`
    : `/apps/access/vnc/proxy/api/novnc/vnc.html?token=${encodedToken}&path=${encodeURIComponent(`apps/access/vnc/proxy/api/apps/sessions/${encodedSessionId}/vnc?token=${encodedToken}`)}&autoconnect=1&resize=scale`;
}
