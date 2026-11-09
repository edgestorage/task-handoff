import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import {
  DESKTOP_FALLBACK_ACTOR_HEADER,
  DESKTOP_FALLBACK_DEVICE_HEADER,
  DESKTOP_FALLBACK_GENERATION_HEADER,
  DESKTOP_FALLBACK_TARGET_HEADER,
  DESKTOP_FALLBACK_VIEWER_HEADER,
  DesktopAttachSchema,
  DesktopFallbackAttachSchema,
  DesktopFallbackRoleSchema,
  DesktopManagedOperationSchema,
  DesktopManagedSchemas,
  DesktopManagedSignalSchema,
  desktopManagedEndpoint,
} from "@task-handoff/runtime-shared/remote-desktop-managed";

/** Authenticated node management transport only. No browser headers, target URL,
 * registration token or arbitrary IPC command is accepted from the caller. */
export function registerManagedDesktopRoutes(app: FastifyInstance, options: {
  instanceBase(id: string): string | Promise<string>;
  instanceCredential(id: string): string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: URL, protocols: string, options: {
    perMessageDeflate: boolean;
    maxPayload: number;
    headers: Record<string, string>;
  }) => WebSocket;
}) {
  const boundary = { logLevel: "silent" as const, bodyLimit: 16 * 1024 };
  app.post("/api/node-agent/instances/:id/remote-desktop/:operation", boundary, async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const { id, operation: raw } = request.params as { id: string; operation: string };
    const operation = DesktopManagedOperationSchema.parse(raw);
    const body = DesktopManagedSchemas[operation].parse(request.body);
    const endpoint = desktopManagedEndpoint(operation);
    const base = await options.instanceBase(id);
    const response = await (options.fetchImpl ?? fetch)(`${base}${endpoint.path}`, {
      method: endpoint.method,
      headers: { "content-type": "application/json", authorization: `Bearer ${options.instanceCredential(id)}` },
      ...(endpoint.method === "GET" ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    // Window metadata can be larger than the command, but never unbounded.
    const length = Number(response.headers.get("content-length"));
    if (length > 600 * 1024) throw new Error("REMOTE_DESKTOP_RESPONSE_LIMIT");
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      if (reader) for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 600 * 1024) throw new Error("REMOTE_DESKTOP_RESPONSE_LIMIT");
        chunks.push(value);
      }
    } finally { await reader?.cancel().catch(() => undefined); }
    return reply.code(response.status).type("application/json").send(Buffer.concat(chunks).toString("utf8"));
  });
  app.get("/api/node-agent/instances/:id/remote-desktop/attach", { ...boundary, websocket: true }, (socket, request) => {
    let upstream: WebSocket | undefined; let closed = false; let attached = false;
    let count = 0; let candidates = 0; let rateAt = performance.now();
    const pending: string[] = [];
    const end = () => { if (closed) return; closed = true; clearTimeout(deadline); pending.length = 0; upstream?.close(); };
    const fail = () => socket.close(1008, "REMOTE_DESKTOP_SIGNAL_INVALID");
    const deadline = setTimeout(fail, 10_000);
    socket.on("close", end); socket.on("error", end);
    socket.on("message", (data, binary) => {
      try {
        if (closed) return;
        const now = performance.now(); if (now - rateAt >= 1000) { rateAt = now; count = 0; }
        if (binary || (Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0) : data.byteLength) > 512 * 1024 || ++count > 64) throw new Error();
        const raw = JSON.parse(data.toString());
        const message = attached ? DesktopManagedSignalSchema.parse(raw) : DesktopAttachSchema.parse(raw);
        attached = true;
        if ("type" in message && message.type === "candidate" && ++candidates > 256) throw new Error();
        const frame = JSON.stringify(message);
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(frame);
        else { if (pending.length >= 8) throw new Error(); pending.push(frame); }
      } catch { fail(); }
    });
    void (async () => {
      const { id } = request.params as { id: string };
      const base = await options.instanceBase(id); if (closed) return;
      const url = new URL("/api/internal/remote-desktop/attach", base);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      upstream = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024, headers: { authorization: `Bearer ${options.instanceCredential(id)}` } });
      upstream.on("open", () => {
        clearTimeout(deadline); if (closed) { upstream?.close(); return; }
        for (const frame of pending.splice(0)) upstream!.send(frame);
      });
      upstream.on("message", (data, binary) => {
        if (closed) return;
        if (binary || (Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0) : data.byteLength) > 512 * 1024 || socket.bufferedAmount > 1024 * 1024) { fail(); return; }
        socket.send(data.toString());
      });
      upstream.on("close", () => socket.close(1000, "Remote desktop signaling ended."));
      upstream.on("error", () => socket.close(1011, "REMOTE_DESKTOP_UPSTREAM_UNAVAILABLE"));
    })().catch(() => socket.close(1011, "REMOTE_DESKTOP_UPSTREAM_UNAVAILABLE"));
  });
  /** One role-parameterized route owns both fallback sockets. Media and control
   * remain separate TCP connections; they share this proxy chain and context
   * injection so no second browser -> instance transport exists. */
  app.get("/api/node-agent/instances/:id/remote-desktop/fallback/:role", { ...boundary, websocket: true }, (socket, request) => {
    let upstream: WebSocket | undefined;
    let closed = false;
    let opened = false;
    const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
    let pendingBytes = 0;
    const role = DesktopFallbackRoleSchema.safeParse((request.params as { role: string }).role);
    const protocol = String(request.headers["sec-websocket-protocol"] ?? "").trim();
    const expected = role.success
      ? role.data === "media"
        ? "taskhandoff.remote-desktop.fallback.media.v1"
        : "taskhandoff.remote-desktop.fallback.control.v1"
      : "";
    const viewer = header(request, DESKTOP_FALLBACK_VIEWER_HEADER);
    const generation = header(request, DESKTOP_FALLBACK_GENERATION_HEADER);
    const actor = header(request, DESKTOP_FALLBACK_ACTOR_HEADER);
    const device = header(request, DESKTOP_FALLBACK_DEVICE_HEADER);
    const target = header(request, DESKTOP_FALLBACK_TARGET_HEADER);
    let attach: ReturnType<typeof DesktopFallbackAttachSchema.parse> | undefined;
    if (role.success) {
      try {
        attach = DesktopFallbackAttachSchema.parse({
          type: "fallback.attach",
          role: role.data,
          fallbackGeneration: generation,
          viewerSessionId: viewer,
          actorId: actor,
          deviceSessionId: device,
          captureTarget: JSON.parse(target ?? ""),
        });
      } catch {
        attach = undefined;
      }
    }
    const end = () => {
      if (closed) return;
      closed = true;
      pending.length = 0;
      upstream?.close();
    };
    socket.on("close", end);
    socket.on("error", end);
    if (!role.success || protocol !== expected || !attach) {
      socket.close(1008, "REMOTE_DESKTOP_FALLBACK_CONTEXT_INVALID");
      return;
    }
    socket.on("message", (data, binary) => {
      if (closed) return;
      const size = Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0) : data.byteLength;
      if (size > 64 * 1024) { socket.close(1009, "REMOTE_DESKTOP_FALLBACK_FRAME_TOO_LARGE"); end(); return; }
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary });
        return;
      }
      pendingBytes += size;
      if (pending.length >= 64 || pendingBytes > 256 * 1024) {
        socket.close(1013, "REMOTE_DESKTOP_FALLBACK_PENDING_LIMIT");
        end();
        return;
      }
      pending.push({ data, binary });
    });
    void (async () => {
      const { id } = request.params as { id: string };
      const base = await options.instanceBase(id);
      if (closed) return;
      const url = new URL(`/api/internal/remote-desktop/fallback/${role.data}`, base);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      upstream = (options.webSocketFactory ?? ((target, protocols, init) => new WebSocket(target, protocols, init)))(url, expected, {
        perMessageDeflate: false,
        maxPayload: 128 * 1024,
        headers: { authorization: `Bearer ${options.instanceCredential(id)}` },
      });
      upstream.on("open", () => {
        if (closed || !upstream) { upstream?.close(); return; }
        opened = true;
        upstream.send(JSON.stringify(attach));
        for (const frame of pending.splice(0)) upstream.send(frame.data, { binary: frame.binary });
        pendingBytes = 0;
      });
      upstream.on("message", (data, binary) => {
        if (closed) return;
        if (socket.bufferedAmount > 256 * 1024) {
          socket.close(1013, "REMOTE_DESKTOP_FALLBACK_BACKPRESSURE");
          end();
          return;
        }
        socket.send(data, { binary });
      });
      upstream.on("close", () => {
        if (!opened) socket.close(1011, "REMOTE_DESKTOP_FALLBACK_UPSTREAM_UNAVAILABLE");
        else socket.close(1000, "Remote desktop fallback ended.");
      });
      upstream.on("error", () => {
        if (!opened) socket.close(1011, "REMOTE_DESKTOP_FALLBACK_UPSTREAM_UNAVAILABLE");
      });
    })().catch(() => socket.close(1011, "REMOTE_DESKTOP_FALLBACK_UPSTREAM_UNAVAILABLE"));
  });
}

function header(request: { headers: Record<string, unknown> }, name: string) {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}
