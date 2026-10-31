import { Readable, Transform } from "node:stream";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { bridgeWebSockets } from "@task-handoff/protocol/websocket-bridge";
import { INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL } from "@task-handoff/protocol/instance-shell";
import { ProxyRequestSchema } from "../schemas.ts";
import {
  INSTANCE_PROXY_REQUEST_BODY_LIMIT,
  instanceProxyResponseLimit,
  proxyRequestBody,
  proxyResponseHeaders,
  proxyWebSocketProtocols,
  readResponseBodyWithLimit,
} from "../instance-proxy-codec.ts";
import { appendServerTiming, serverTimingDuration, TRACE_ID_HEADER } from "../../shared/http/server-timing.ts";

type Diagnostic = (data: Record<string, unknown>, message: string) => void;

const EARLY_CLIENT_FRAME_LIMIT = 256;
const EARLY_CLIENT_FRAME_MAX_BYTES = 8 * 1024 * 1024;
const EARLY_CLIENT_FRAME_TOTAL_MAX_BYTES = 16 * 1024 * 1024;

function websocketFrameBytes(value: unknown) {
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return Buffer.byteLength(typeof value === "string" ? value : String(value), "utf8");
}

export function createInstanceProxyMetrics() {
  return {
    requests: 0,
    active: 0,
    completed: 0,
    aborted: 0,
    limitRejected: 0,
    responseBytes: 0,
    totalDurationMs: 0,
    maxResponseBytes: instanceProxyResponseLimit(),
  };
}

type ProxyMetrics = ReturnType<typeof createInstanceProxyMetrics>;

type Options = {
  fetchImpl: typeof fetch;
  metrics: ProxyMetrics;
  instanceBase(id: string): string | Promise<string>;
  syncModelEnvironment(id: string): Promise<unknown>;
  webSocketUpstreamHeaders?(id: string, path: string): Record<string, string> | Promise<Record<string, string>>;
  /** Test seam; production always constructs the real `ws` client. */
  webSocketFactory?: (
    url: URL,
    protocols: string[] | undefined,
    options: { perMessageDeflate: boolean; headers: Record<string, string> },
  ) => WebSocket;
  diagnostic: Diagnostic;
};

function normalizedPath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

function tooLarge(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, maxBytes: number) {
  return reply.code(502).send({
    error: { code: "INSTANCE_PROXY_RESPONSE_TOO_LARGE", message: `Instance response exceeds ${maxBytes} bytes.` },
  });
}

async function fetchInstanceUpstream(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  context: { instanceId: string; method: string; path: string; diagnostic: Diagnostic },
) {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    context.diagnostic({
      instanceId: context.instanceId,
      action: "proxy.upstream.failed",
      method: context.method,
      path: context.path,
      error: error instanceof Error ? error.message : String(error),
    }, "node instance proxy upstream unavailable");
    throw Object.assign(new Error(`Instance ${context.instanceId} web endpoint is not reachable.`), {
      statusCode: 502,
      code: "INSTANCE_PROXY_UPSTREAM_UNREACHABLE",
      retryable: true,
      cause: error,
    });
  }
}

export function registerInstanceProxyRoutes(app: FastifyInstance, options: Options) {
  const { fetchImpl, metrics, diagnostic } = options;
  const createWebSocket = options.webSocketFactory ?? ((url, protocols, socketOptions) => protocols
    ? new WebSocket(url, protocols, socketOptions)
    : new WebSocket(url, socketOptions));

  app.post("/api/node-agent/instances/:id/proxy", async (request, reply) => {
    const startedAt = performance.now();
    const id = (request.params as { id: string }).id;
    const parsed = ProxyRequestSchema.parse(request.body);
    const instanceBase = await options.instanceBase(id);
    const proxyPath = normalizedPath(parsed.path);
    if (parsed.method === "POST" && proxyPath === "/api/apps/sessions") await options.syncModelEnvironment(id);
    diagnostic({ instanceId: id, action: "proxy", method: parsed.method, path: proxyPath, instanceBase }, "node instance proxy requested");
    const response = await fetchInstanceUpstream(fetchImpl, `${instanceBase}${proxyPath}`, {
      method: parsed.method,
      headers: { ...parsed.headers },
      body: proxyRequestBody(parsed),
    }, { instanceId: id, method: parsed.method, path: proxyPath, diagnostic });
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const text = await response.text();
    const durationMs = performance.now() - startedAt;
    const traceId = response.headers.get(TRACE_ID_HEADER) || parsed.headers[TRACE_ID_HEADER];
    const serverTiming = appendServerTiming(
      response.headers.get("server-timing"),
      serverTimingDuration("node_proxy", durationMs),
    );
    reply.header("server-timing", serverTiming);
    if (traceId) reply.header(TRACE_ID_HEADER, traceId);
    diagnostic({ instanceId: id, action: "proxy", method: parsed.method, path: proxyPath, statusCode: response.status, contentType, durationMs, traceId }, "node instance proxy completed");
    reply.code(response.status).type(contentType).send(text);
  });

  app.post("/api/node-agent/instances/:id/proxy/stream", { bodyLimit: INSTANCE_PROXY_REQUEST_BODY_LIMIT }, async (request, reply) => {
    const startedAt = Date.now();
    metrics.requests += 1;
    metrics.active += 1;
    const controller = new AbortController();
    let responseBytes = 0;
    let streaming = false;
    let finalized = false;
    const finalize = (outcome: "completed" | "aborted") => {
      if (finalized) return;
      finalized = true;
      metrics.active -= 1;
      metrics.totalDurationMs += Date.now() - startedAt;
      metrics.responseBytes += responseBytes;
      metrics[outcome] += 1;
    };
    const abort = () => {
      controller.abort();
      if (streaming) finalize("aborted");
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    try {
      const id = (request.params as { id: string }).id;
      const parsed = ProxyRequestSchema.parse(request.body);
      const instanceBase = await options.instanceBase(id);
      const proxyPath = normalizedPath(parsed.path);
      diagnostic({ instanceId: id, action: "proxy.stream", method: parsed.method, path: proxyPath, instanceBase }, "node instance streaming proxy requested");
      const response = await fetchInstanceUpstream(fetchImpl, `${instanceBase}${proxyPath}`, {
        method: parsed.method,
        headers: { ...parsed.headers },
        body: proxyRequestBody(parsed),
        signal: controller.signal,
      }, { instanceId: id, method: parsed.method, path: proxyPath, diagnostic });
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > metrics.maxResponseBytes) {
        metrics.limitRejected += 1;
        controller.abort();
        return tooLarge(reply, metrics.maxResponseBytes);
      }
      reply.code(response.status);
      for (const [key, value] of Object.entries(proxyResponseHeaders(response.headers))) reply.header(key, value);
      if (!response.body || parsed.method === "HEAD") {
        finalize("completed");
        return reply.send();
      }
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          responseBytes += chunk.length;
          if (responseBytes > metrics.maxResponseBytes) {
            metrics.limitRejected += 1;
            controller.abort();
            callback(Object.assign(new Error("Instance proxy response limit exceeded."), { code: "INSTANCE_PROXY_RESPONSE_TOO_LARGE" }));
            return;
          }
          callback(null, chunk);
        },
      });
      streaming = true;
      limiter.once("end", () => finalize("completed"));
      limiter.once("error", () => finalize("aborted"));
      return reply.send(Readable.fromWeb(response.body as never).pipe(limiter));
    } catch (error) {
      finalize("aborted");
      throw error;
    } finally {
      request.raw.off("aborted", abort);
      if (!streaming) finalize("completed");
    }
  });

  app.post("/api/node-agent/instances/:id/proxy/raw", { bodyLimit: INSTANCE_PROXY_REQUEST_BODY_LIMIT }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = ProxyRequestSchema.parse(request.body);
    const instanceBase = await options.instanceBase(id);
    const proxyPath = normalizedPath(parsed.path);
    diagnostic({ instanceId: id, action: "proxy.raw", method: parsed.method, path: proxyPath, instanceBase }, "node instance raw proxy requested");
    const response = await fetchInstanceUpstream(fetchImpl, `${instanceBase}${proxyPath}`, {
      method: parsed.method,
      headers: { ...parsed.headers },
      body: proxyRequestBody(parsed),
    }, { instanceId: id, method: parsed.method, path: proxyPath, diagnostic });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > metrics.maxResponseBytes) {
      metrics.limitRejected += 1;
      await response.body?.cancel("Instance proxy response limit exceeded.").catch(() => undefined);
      return tooLarge(reply, metrics.maxResponseBytes);
    }
    let bytes: Buffer;
    try {
      bytes = await readResponseBodyWithLimit(response, metrics.maxResponseBytes);
    } catch (error) {
      if (!(error instanceof Error) || (error as Error & { code?: string }).code !== "INSTANCE_PROXY_RESPONSE_TOO_LARGE") throw error;
      metrics.limitRejected += 1;
      return tooLarge(reply, metrics.maxResponseBytes);
    }
    diagnostic({ instanceId: id, action: "proxy.raw", method: parsed.method, path: proxyPath, statusCode: response.status, byteLength: bytes.length }, "node instance raw proxy completed");
    return { data: { status: response.status, headers: proxyResponseHeaders(response.headers), bodyBase64: bytes.toString("base64") } };
  });

  app.get("/api/node-agent/instances/:id/proxy/ws/*", { websocket: true }, async (socket, request) => {
    const id = (request.params as { id: string; "*": string }).id;
    const suffix = (request.params as { id: string; "*": string })["*"] || "";
    const queryIndex = request.url.indexOf("?");
    const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
    // Fastify completes the downstream upgrade before this async handler resumes.
    // Capture frames synchronously so an immediate Instance Shell `start` is not
    // emitted while instance/credential resolution is still pending below.
    const earlyClientFrames: Array<{ data: unknown; isBinary: boolean }> = [];
    let earlyClientBytes = 0;
    let capturingEarlyClientFrames = true;
    const captureEarlyClientFrame = (message: unknown, isBinary = false) => {
      if (!capturingEarlyClientFrames) return;
      const bytes = websocketFrameBytes(message);
      if (bytes > EARLY_CLIENT_FRAME_MAX_BYTES
        || earlyClientFrames.length >= EARLY_CLIENT_FRAME_LIMIT
        || earlyClientBytes + bytes > EARLY_CLIENT_FRAME_TOTAL_MAX_BYTES) {
        capturingEarlyClientFrames = false;
        socket.close(1013, "Instance websocket proxy pending frame limit exceeded.");
        return;
      }
      earlyClientBytes += bytes;
      earlyClientFrames.push({ data: message, isBinary: Boolean(isBinary) });
    };
    socket.on("message", captureEarlyClientFrame);
    let upstream: WebSocket | undefined;
    try {
      const instanceBase = await options.instanceBase(id);
      const upstreamUrl = new URL(`/${suffix}${query}`, `${instanceBase}/`);
      upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
      const protocols = proxyWebSocketProtocols(request.headers);
      const proxyPath = `/${suffix}`;
      if (proxyPath === "/api/internal/instance-shell" && (protocols?.length !== 1 || protocols[0] !== INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL)) {
        socket.close(1002, "Instance shell subprotocol is required.");
        return;
      }
      const upstreamHeaders = await options.webSocketUpstreamHeaders?.(id, proxyPath) || {};
      diagnostic({ instanceId: id, action: "proxy.ws", path: `/${suffix}${query}`, upstreamUrl: upstreamUrl.toString(), protocols: protocols || [] }, "node instance websocket proxy opening");
      upstream = createWebSocket(upstreamUrl, protocols, { perMessageDeflate: false, headers: upstreamHeaders });
      upstream.on("open", () => {
        diagnostic({ instanceId: id, action: "proxy.ws", path: `/${suffix}${query}` }, "node instance websocket proxy opened");
      });
      upstream.on("close", () => {
        diagnostic({ instanceId: id, action: "proxy.ws", path: `/${suffix}${query}` }, "node instance websocket proxy closed");
      });
      upstream.on("error", (error) => {
        diagnostic({ instanceId: id, action: "proxy.ws", path: `/${suffix}${query}`, error: error instanceof Error ? error.message : String(error) }, "node instance websocket proxy failed");
      });
      capturingEarlyClientFrames = false;
      socket.off("message", captureEarlyClientFrame);
      if (socket.readyState !== WebSocket.OPEN) {
        upstream.close();
        return;
      }
      // The node-agent websocket can open before the controlled-instance
      // websocket. Bridge immediately so early client frames (notably the
      // browser-tunnel hello) are queued until the instance is ready.
      bridgeWebSockets(socket as any, upstream, {
        upstreamOpenTimeoutMs: 10_000,
        initialClientFrames: earlyClientFrames.splice(0),
      });
    } catch (error) {
      capturingEarlyClientFrames = false;
      socket.off("message", captureEarlyClientFrame);
      diagnostic({ instanceId: id, action: "proxy.ws", path: `/${suffix}${query}`, error: error instanceof Error ? error.message : String(error) }, "node instance websocket endpoint unavailable");
      upstream?.close();
      socket.close(1011, "Instance websocket endpoint is not reachable.");
    }
  });
}
