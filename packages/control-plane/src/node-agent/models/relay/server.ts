import crypto from "node:crypto";
import { once } from "node:events";
import { Readable, Transform, type Writable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  defaultNodeAgentModelRelayImagePruning,
  type ControlledInstance,
  type ModelProtocol,
  type NodeAgentModelRelayImagePruningConfig,
} from "@task-handoff/protocol/control-plane";
import {
  NodeModelRelayResolver,
  parseModelRelayRoutePathname,
  type ModelRelayRouteResolution,
} from "../relay-routes.ts";
import { MODEL_RELAY_ERROR_CODES, modelRelayError } from "./errors.ts";
import { upstreamRequestHeaders, upstreamResponseHeaders } from "./header-policy.ts";
import { ImagePruningBodyError, pruneModelRelayImages } from "./image-pruning.ts";
import { resolveModelRelayLimits, type ModelRelayLimits } from "./limits.ts";
import { ModelRelayAdapterRegistry, type ModelRelayAdapter, type ModelRelayUpstreamPlan } from "./types.ts";

const MODEL_RELAY_BASE_PATH = "/api/node-agent/model-relay/instances/:instanceId/routes/:routeId/v1";
const RELAY_METHODS = ["GET", "POST", "HEAD", "PUT", "PATCH", "DELETE"] as const;

type RelayLog = {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  debug(data: Record<string, unknown>, message: string): void;
};

/**
 * The relay only needs URL + init passthrough, so it accepts both the global
 * fetch and test doubles without dragging DOM stream types into the service.
 */
type ModelRelayFetch = (url: string, init: Record<string, unknown>) => Promise<Response>;

type AbortReason = "client" | "shutdown" | "headers-timeout" | "first-byte-timeout" | "idle-timeout";

function credentialDigest(value: string) {
  return crypto.createHash("sha256").update(value).digest();
}

/** Constant-time credential comparison that never branches on secret length. */
export function modelRelayCredentialMatches(provided: string, expected: string) {
  return crypto.timingSafeEqual(credentialDigest(provided), credentialDigest(expected));
}

function bearerCredential(headers: Record<string, unknown>) {
  const value = headers.authorization;
  if (typeof value !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || undefined;
}

function apiKeyCredential(headers: Record<string, unknown>) {
  const value = headers["x-api-key"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function protocolCredential(headers: Record<string, unknown>, protocol: ModelProtocol) {
  return protocol === "anthropic-messages" ? apiKeyCredential(headers) : bearerCredential(headers);
}

function countedStream(source: Readable, onBytes: (count: number) => void) {
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
  // The source error also destroys the counter. The HTTP client may detach its
  // listener at the same moment, so keep a local listener to avoid an
  // uncaughtException from the duplicated error.
  counter.on("error", () => undefined);
  source.once("error", (error) => counter.destroy(error));
  return source.pipe(counter);
}

/**
 * Machine-readable description of a transport failure. Only class names and
 * short codes leave the relay: free-form error messages can echo endpoint
 * hosts, addresses or credentials, so they are never logged.
 */
function relayErrorDiagnostics(error: unknown) {
  const describe = (value: unknown) => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as { name?: unknown; code?: unknown };
    const name = typeof record.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(record.name) ? record.name : undefined;
    const code = typeof record.code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(record.code) ? record.code : undefined;
    return name || code ? { name, code } : undefined;
  };
  const failure = describe(error);
  const cause = describe((error as { cause?: unknown } | null | undefined)?.cause);
  return {
    ...(failure?.name ? { errorName: failure.name } : {}),
    ...(failure?.code ? { code: failure.code } : {}),
    ...(cause?.name ? { causeName: cause.name } : {}),
    ...(cause?.code ? { causeCode: cause.code } : {}),
  };
}

function waitForDrain(socket: Writable) {
  return new Promise<void>((resolve) => {
    const done = () => {
      socket.off("drain", done);
      socket.off("close", done);
      resolve();
    };
    socket.once("drain", done);
    socket.once("close", done);
  });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const IMAGE_PRUNING_OPERATIONS = new Set([
  "chat.completions.create",
  "responses.create",
  "messages.create",
  "messages.count_tokens",
]);

type ImagePruningMetadata = {
  imagePruningOutcome?: string;
  sourceRequestBytes?: number;
  removedImages?: number;
  retainedImages?: number;
  imagePruningMs?: number;
};

type PreparedRelayBody = {
  body: Readable;
  metadata: ImagePruningMetadata;
};

type BufferedRelayBody = {
  chunks: Buffer[];
  totalBytes: number;
  overflow: boolean;
  buffer?: Buffer;
  remainder?: Readable;
};

function singleHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function requestContentLength(headers: FastifyRequest["headers"]) {
  const raw = singleHeader(headers["content-length"]);
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function hasRequestContentEncoding(headers: FastifyRequest["headers"]) {
  const encoding = singleHeader(headers["content-encoding"])?.trim().toLowerCase();
  return Boolean(encoding && encoding !== "identity");
}

function isJsonRequest(headers: FastifyRequest["headers"]) {
  const contentType = singleHeader(headers["content-type"])?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json";
}

function bufferRequestBody(source: Readable, maxBytes: number): Promise<BufferedRelayBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const cleanup = () => {
      source.off("data", onData);
      source.off("end", onEnd);
      source.off("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      totalBytes += buffer.length;
      if (totalBytes <= maxBytes) return;
      settled = true;
      source.pause();
      cleanup();
      resolve({ chunks, totalBytes, overflow: true, remainder: source });
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ chunks, totalBytes, overflow: false, buffer: Buffer.concat(chunks, totalBytes) });
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    source.on("data", onData);
    source.once("end", onEnd);
    source.once("error", onError);
  });
}

function replayBufferedBody(chunks: Buffer[], remainder?: Readable) {
  return Readable.from((async function* replay() {
    for (const chunk of chunks) yield chunk;
    if (!remainder) return;
    for await (const chunk of remainder) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  })(), { objectMode: false });
}

class ImagePruningGate {
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  async acquire(timeoutMs: number): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return this.releaseOnce();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(modelRelayError(503, MODEL_RELAY_ERROR_CODES.busy, "The node model relay image pruning queue is full; retry later.", { retryable: true }));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.releaseOnce());
      } else {
        this.active = Math.max(0, this.active - 1);
      }
    };
  }
}

export type ModelRelayServiceOptions = {
  resolver: NodeModelRelayResolver;
  adapters?: ModelRelayAdapter[];
  imagePruning?: () => NodeAgentModelRelayImagePruningConfig;
  limits?: Partial<ModelRelayLimits>;
  fetchImpl?: typeof fetch;
  log?: RelayLog;
};

/**
 * The relay data plane. Authentication, switch/assignment resolution, header
 * policy, timeouts and concurrency all happen here; protocol-specific model
 * rewriting lives behind {@link ModelRelayAdapter}.
 */
export class ModelRelayService {
  private readonly resolver: NodeModelRelayResolver;
  private readonly adapters: ModelRelayAdapterRegistry;
  private readonly limits: ModelRelayLimits;
  private readonly fetchImpl: ModelRelayFetch;
  private readonly imagePruning: () => NodeAgentModelRelayImagePruningConfig;
  private readonly imagePruningGate: ImagePruningGate;
  private readonly log?: RelayLog;
  private closing = false;
  private activeTotal = 0;
  private readonly activeByInstance = new Map<string, number>();
  private readonly activeControllers = new Set<AbortController>();

  constructor(options: ModelRelayServiceOptions) {
    this.resolver = options.resolver;
    this.adapters = new ModelRelayAdapterRegistry(options.adapters);
    this.limits = { ...resolveModelRelayLimits(), ...options.limits };
    this.fetchImpl = (options.fetchImpl || fetch) as ModelRelayFetch;
    this.imagePruning = options.imagePruning || defaultNodeAgentModelRelayImagePruning;
    this.imagePruningGate = new ImagePruningGate(this.limits.maxConcurrentImagePruning);
    this.log = options.log;
  }

  registerAdapter(adapter: ModelRelayAdapter) {
    this.adapters.register(adapter);
  }

  protocolCapabilities() {
    return this.adapters.protocols();
  }

  registerRoutes(app: FastifyInstance) {
    const handler = (request: FastifyRequest, reply: FastifyReply) => this.handle(request, reply);
    app.register(async (scope) => {
      // Relay bodies are piped to the upstream unchanged (after bounded name
      // resolution); never let Fastify buffer a full generation request.
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser(/^.*$/, (_request, payload, done) => done(null, payload));
      for (const url of [MODEL_RELAY_BASE_PATH, `${MODEL_RELAY_BASE_PATH}/*`]) {
        scope.route({ method: [...RELAY_METHODS], url, handler });
      }
    });
    // preClose runs before Fastify waits for open connections, which is the
    // only point where an in-flight relay stream can be drained and aborted.
    // onClose would deadlock behind a never-ending upstream generation.
    app.addHook("preClose", async () => {
      await this.shutdown();
    });
  }

  /** Stop accepting relay traffic, drain active streams, then abort the rest. */
  async shutdown() {
    this.closing = true;
    await this.drainActive();
  }

  /**
   * Bounded drain for configuration changes such as disabling the relay
   * switch: in-flight streams finish if they complete quickly, the rest are
   * aborted so no stream keeps flowing through a disabled data plane.
   */
  async drainActive() {
    const deadline = Date.now() + this.limits.shutdownDrainMs;
    while (this.activeTotal > 0 && Date.now() < deadline) await delay(20);
    for (const controller of this.activeControllers) controller.abort();
  }

  private tryAcquire(instanceId: string) {
    if (this.closing) {
      throw modelRelayError(503, MODEL_RELAY_ERROR_CODES.shuttingDown, "The node model relay is shutting down.");
    }
    if (this.activeTotal >= this.limits.maxConcurrentRequests) return false;
    if ((this.activeByInstance.get(instanceId) || 0) >= this.limits.maxConcurrentRequestsPerInstance) return false;
    this.activeTotal += 1;
    this.activeByInstance.set(instanceId, (this.activeByInstance.get(instanceId) || 0) + 1);
    return true;
  }

  private release(instanceId: string) {
    this.activeTotal = Math.max(0, this.activeTotal - 1);
    const current = this.activeByInstance.get(instanceId) || 0;
    if (current <= 1) this.activeByInstance.delete(instanceId);
    else this.activeByInstance.set(instanceId, current - 1);
  }

  private async handle(request: FastifyRequest, reply: FastifyReply) {
    const startedAt = Date.now();
    const url = request.url;
    const queryIndex = url.indexOf("?");
    const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
    const search = queryIndex === -1 ? "" : url.slice(queryIndex);
    const parsedRoute = parseModelRelayRoutePathname(pathname);
    if (!parsedRoute) {
      throw modelRelayError(404, MODEL_RELAY_ERROR_CODES.routeNotFound, "The requested model relay route does not exist.");
    }
    const headerBytes = Object.entries(request.headers).reduce((total, [name, value]) => (
      total + name.length + (Array.isArray(value) ? value.join(", ").length : value?.length || 0)
    ), 0);
    if (headerBytes > this.limits.maxRequestHeaderBytes) {
      throw modelRelayError(431, MODEL_RELAY_ERROR_CODES.requestHeadersTooLarge, "The relay request headers are too large.");
    }

    let instance: ControlledInstance;
    try {
      instance = this.resolver.instance(parsedRoute.instanceId);
    } catch {
      throw modelRelayError(404, MODEL_RELAY_ERROR_CODES.routeNotFound, "The requested model relay route does not exist.");
    }
    // Authentication happens before any switch/assignment lookup so an
    // unauthenticated caller cannot observe relay state.
    const candidate = bearerCredential(request.headers) ?? apiKeyCredential(request.headers);
    if (!candidate || !modelRelayCredentialMatches(candidate, instance.registrationToken)) {
      throw modelRelayError(401, MODEL_RELAY_ERROR_CODES.unauthorized, "Model relay credentials are invalid for this instance.");
    }
    if (!this.tryAcquire(parsedRoute.instanceId)) {
      throw modelRelayError(429, MODEL_RELAY_ERROR_CODES.busy, "The node model relay is at capacity; retry later.", { retryable: true });
    }

    const context: Record<string, unknown> = {
      instanceId: parsedRoute.instanceId,
      routeId: parsedRoute.routeId,
      operation: "unknown",
      protocol: undefined,
      modelEntityId: undefined,
    };
    try {
      const resolution = this.resolver.resolveRoute(parsedRoute.instanceId, parsedRoute.routeId);
      context.protocol = resolution.protocol;
      context.modelEntityId = resolution.model.id;
      // The credential must arrive in the protocol's wire shape: OpenAI-style
      // routes use Bearer, Anthropic routes use x-api-key.
      if (!protocolCredential(request.headers, resolution.protocol)) {
        throw modelRelayError(401, MODEL_RELAY_ERROR_CODES.unauthorized, "Model relay credentials are invalid for this instance.");
      }
      const adapter = this.adapters.get(resolution.protocol);
      if (!adapter) {
        throw modelRelayError(404, MODEL_RELAY_ERROR_CODES.operationNotAllowed, "The node does not relay this model protocol.");
      }
      const plan = adapter.planOperation({
        method: request.method,
        operationPath: parsedRoute.operationPath,
        search,
        model: resolution.model,
      });
      context.operation = plan.name;
      if (plan.kind === "reject") {
        throw modelRelayError(plan.status, plan.code, plan.message);
      }
      if (plan.kind === "synthetic") {
        reply.code(plan.status).headers(plan.headers || {}).send(plan.body ?? "");
        this.logCompleted(startedAt, { ...context, status: plan.status, requestBytes: 0, responseBytes: plan.body ? Buffer.byteLength(plan.body) : 0 });
        return;
      }
      await this.proxyUpstream(request, reply, resolution, adapter, plan, context, startedAt);
    } catch (error) {
      const status = error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
      const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "MODEL_RELAY_ERROR";
      this.log?.warn({
        ...context,
        status,
        code,
        ...relayErrorDiagnostics(error),
        latencyMs: Date.now() - startedAt,
        relayEnabled: this.resolver.relayEnabled(),
      }, "model relay request failed");
      if (reply.raw.headersSent || reply.raw.writableEnded) return;
      throw error;
    } finally {
      this.release(parsedRoute.instanceId);
    }
  }

  private logCompleted(startedAt: number, fields: Record<string, unknown>) {
    this.log?.info({
      ...fields,
      latencyMs: Date.now() - startedAt,
      relayEnabled: this.resolver.relayEnabled(),
    }, "model relay request completed");
  }

  private async prepareImagePrunedBody(
    request: FastifyRequest,
    plan: ModelRelayUpstreamPlan,
    protocol: ModelProtocol,
    hasBody: boolean,
  ): Promise<PreparedRelayBody> {
    const original = request.raw;
    if (!hasBody) return { body: original, metadata: {} };
    const settings = this.imagePruning();
    if (!settings.enabled) return { body: original, metadata: {} };
    if (!IMAGE_PRUNING_OPERATIONS.has(plan.name)) {
      return { body: original, metadata: { imagePruningOutcome: "not-applicable" } };
    }
    const contentLength = requestContentLength(request.headers);
    if (contentLength === undefined) {
      return { body: original, metadata: { imagePruningOutcome: "unknown-length" } };
    }
    if (contentLength <= settings.triggerBodyBytes) {
      return {
        body: original,
        metadata: { imagePruningOutcome: "below-threshold", sourceRequestBytes: contentLength },
      };
    }
    if (hasRequestContentEncoding(request.headers)) {
      return {
        body: original,
        metadata: { imagePruningOutcome: "compressed", sourceRequestBytes: contentLength },
      };
    }
    if (!isJsonRequest(request.headers)) {
      return {
        body: original,
        metadata: { imagePruningOutcome: "non-json", sourceRequestBytes: contentLength },
      };
    }
    if (contentLength > settings.maxInspectBytes) {
      if (settings.onTooLarge === "passthrough") {
        return {
          body: original,
          metadata: { imagePruningOutcome: "too-large-passthrough", sourceRequestBytes: contentLength },
        };
      }
      throw modelRelayError(
        413,
        MODEL_RELAY_ERROR_CODES.imagePruningBodyTooLarge,
        "The model relay request body exceeds the image-pruning inspection limit.",
        { maxInspectBytes: settings.maxInspectBytes },
      );
    }

    const startedAt = Date.now();
    const release = await this.imagePruningGate.acquire(this.limits.imagePruningQueueTimeoutMs);
    try {
      if (this.closing) {
        throw modelRelayError(503, MODEL_RELAY_ERROR_CODES.shuttingDown, "The node model relay is shutting down.");
      }
      const read = await bufferRequestBody(original, settings.maxInspectBytes);
      if (read.overflow || read.totalBytes > contentLength) {
        if (settings.onTooLarge === "passthrough") {
          return {
            body: replayBufferedBody(read.chunks, read.remainder),
            metadata: {
              imagePruningOutcome: "too-large-passthrough",
              sourceRequestBytes: read.totalBytes,
              imagePruningMs: Date.now() - startedAt,
            },
          };
        }
        throw modelRelayError(
          413,
          MODEL_RELAY_ERROR_CODES.imagePruningBodyTooLarge,
          "The model relay request body exceeds the image-pruning inspection limit.",
          { maxInspectBytes: settings.maxInspectBytes },
        );
      }
      const body = read.buffer ?? Buffer.concat(read.chunks, read.totalBytes);
      let json: unknown;
      try {
        const text = body.toString("utf8");
        json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      } catch {
        throw modelRelayError(
          400,
          MODEL_RELAY_ERROR_CODES.imagePruningInvalidBody,
          "The model relay request body is not valid JSON for image pruning.",
        );
      }
      let pruned;
      try {
        pruned = pruneModelRelayImages(protocol, json, settings.keepLatestImages);
      } catch (error) {
        if (error instanceof ImagePruningBodyError) {
          throw modelRelayError(
            400,
            MODEL_RELAY_ERROR_CODES.imagePruningInvalidBody,
            "The model relay request structure is not safe for image pruning.",
          );
        }
        throw modelRelayError(500, MODEL_RELAY_ERROR_CODES.imagePruningFailed, "The model relay could not prune request images.");
      }
      const metadata: ImagePruningMetadata = {
        imagePruningOutcome: pruned.changed ? "applied" : "unchanged",
        sourceRequestBytes: contentLength,
        removedImages: pruned.removedImages,
        retainedImages: pruned.retainedImages,
        imagePruningMs: Date.now() - startedAt,
      };
      const outgoing = pruned.changed ? Buffer.from(JSON.stringify(pruned.json), "utf8") : body;
      return { body: Readable.from(outgoing, { objectMode: false }), metadata };
    } catch (error) {
      if (error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number") throw error;
      throw modelRelayError(500, MODEL_RELAY_ERROR_CODES.imagePruningFailed, "The model relay could not inspect request images.");
    } finally {
      release();
    }
  }

  private async proxyUpstream(
    request: FastifyRequest,
    reply: FastifyReply,
    resolution: ModelRelayRouteResolution,
    adapter: ModelRelayAdapter,
    plan: ModelRelayUpstreamPlan,
    context: Record<string, unknown>,
    startedAt: number,
  ) {
    const model = resolution.model;
    const targetUrl = this.allowedUpstreamUrl(plan.url, model.endpoint);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const imagePrepared = await this.prepareImagePrunedBody(request, plan, resolution.protocol, hasBody);
    Object.assign(context, imagePrepared.metadata);
    let requestBytes = 0;
    const preparation = await adapter.prepareRequest({
      body: hasBody ? imagePrepared.body : undefined,
      plan,
      model,
      resolveUpstreamModelName: (externalName) => this.resolver.resolveUpstreamModelName(model, externalName),
      maxPrologueBytes: this.limits.maxRequestPrologueBytes,
    });
    const upstreamBody = preparation.body
      ? countedStream(preparation.body, (count) => { requestBytes += count; })
      : undefined;

    const controller = new AbortController();
    this.activeControllers.add(controller);
    let abortReason: AbortReason | undefined;
    const onClientClose = () => {
      if (!reply.raw.writableEnded) {
        abortReason = "client";
        controller.abort();
      }
    };
    reply.raw.once("close", onClientClose);
    const headerTimer = setTimeout(() => {
      abortReason = "headers-timeout";
      controller.abort();
    }, this.limits.responseHeadersTimeoutMs);

    let upstream: Response;
    try {
      upstream = await this.fetchImpl(targetUrl, {
        method: plan.method,
        headers: upstreamRequestHeaders(request.headers, { protocol: resolution.protocol, credential: model.key }),
        body: upstreamBody,
        ...(upstreamBody ? { duplex: "half" } : {}),
        redirect: "manual",
        signal: controller.signal,
      } as Record<string, unknown>);
    } catch (error) {
      clearTimeout(headerTimer);
      reply.raw.off("close", onClientClose);
      this.activeControllers.delete(controller);
      if (abortReason === "client") {
        this.log?.debug({ ...context, status: 499 }, "model relay client closed before upstream response");
        return;
      }
      if (abortReason === "shutdown" || this.closing) {
        this.log?.debug({ ...context, status: 503 }, "model relay aborted for node-agent shutdown");
        return;
      }
      if (abortReason === "headers-timeout") {
        throw modelRelayError(504, MODEL_RELAY_ERROR_CODES.upstreamTimeout, "The upstream model endpoint did not respond in time.", { phase: "headers" });
      }
      // Request-body rewriting failures (unknown/duplicate model fields surfacing
      // while the body streams) must keep their structured status and code.
      if (error && typeof error === "object" && typeof (error as { statusCode?: unknown }).statusCode === "number") throw error;
      throw modelRelayError(502, MODEL_RELAY_ERROR_CODES.upstreamUnavailable, "The upstream model endpoint could not be reached.");
    }
    clearTimeout(headerTimer);

    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => undefined);
      reply.raw.off("close", onClientClose);
      this.activeControllers.delete(controller);
      throw modelRelayError(502, MODEL_RELAY_ERROR_CODES.upstreamRedirect, "The upstream model endpoint attempted a redirect.");
    }

    const responseHeaders = upstreamResponseHeaders(upstream.headers);
    const upstreamBodyStream = upstream.body as unknown as Readable | null;
    // The upstream decides the actual framing: a client can request streaming
    // without the endpoint answering with SSE, and vice versa.
    const responseMode = plan.responseMode !== "raw" && /text\/event-stream/i.test(upstream.headers.get("content-type") || "")
      ? "sse"
      : plan.responseMode;
    const responseBody = upstream.ok && responseMode !== "raw" && upstreamBodyStream
      ? adapter.prepareResponse({
        body: upstreamBodyStream,
        plan: { ...plan, responseMode },
        model,
        externalModelName: preparation.externalModelName,
        upstreamModelName: preparation.upstreamModelName,
        maxResponseEventBytes: this.limits.maxResponseEventBytes,
        onDiagnostic: (diagnostic) => this.log?.warn({ ...context, code: diagnostic.code }, "model relay response diagnostic"),
      })
      : upstreamBodyStream;

    reply.hijack();
    reply.raw.writeHead(upstream.status, responseHeaders);
    let responseBytes = 0;
    let firstChunk = true;
    let firstChunkAt = 0;
    let lastChunkAt = 0;
    let bodyTimer: NodeJS.Timeout | undefined;
    const armBodyTimer = () => {
      if (bodyTimer) clearTimeout(bodyTimer);
      bodyTimer = setTimeout(() => {
        abortReason = firstChunk ? "first-byte-timeout" : "idle-timeout";
        controller.abort();
      }, firstChunk ? this.limits.firstByteTimeoutMs : this.limits.idleTimeoutMs);
    };
    if (responseBody) armBodyTimer();
    // Every terminating stream reports the same timing shape so a log reader
    // can tell "who stopped first" without guessing: `reason` names the side,
    // the error class/code names the failure, and the chunk timings separate a
    // mid-stream reset from a silent idle gap.
    const streamFields = () => ({
      ...context,
      status: upstream.status,
      ...(firstChunkAt ? { firstChunkMs: firstChunkAt - startedAt } : {}),
      ...(lastChunkAt ? { lastChunkMs: lastChunkAt - startedAt, msSinceLastChunk: Date.now() - lastChunkAt } : {}),
      upstreamContentType: upstream.headers.get("content-type") || undefined,
      upstreamContentEncoding: upstream.headers.get("content-encoding") || undefined,
      requestBytes,
      responseBytes,
      relayEnabled: this.resolver.relayEnabled(),
    });
    let outcome: "completed" | AbortReason = "completed";
    try {
      if (responseBody) {
        for await (const chunk of responseBody) {
          const chunkAt = Date.now();
          if (firstChunk) {
            firstChunk = false;
            firstChunkAt = chunkAt;
            armBodyTimer();
          } else {
            armBodyTimer();
          }
          lastChunkAt = chunkAt;
          responseBytes += chunk.length;
          if (abortReason === "client") break;
          if (!reply.raw.write(chunk)) await waitForDrain(reply.raw);
        }
      }
      outcome = abortReason || "completed";
      if (outcome === "completed") reply.raw.end();
      else reply.raw.destroy();
    } catch (error) {
      reply.raw.destroy();
      // `reason: "upstream-stream-error"` means the upstream socket failed
      // before any relay timeout fired, i.e. the model endpoint dropped the
      // connection first. `client` and the *-timeout reasons are relay-side.
      this.log?.warn({
        ...streamFields(),
        reason: abortReason || "upstream-stream-error",
        ...relayErrorDiagnostics(error),
        latencyMs: Date.now() - startedAt,
      }, "model relay stream interrupted");
      // The response has already started; the only safe diagnosis is the
      // stream close, never an injected error body.
      return;
    } finally {
      if (bodyTimer) clearTimeout(bodyTimer);
      reply.raw.off("close", onClientClose);
      this.activeControllers.delete(controller);
    }
    if (outcome === "completed") {
      this.logCompleted(startedAt, { ...context, status: upstream.status, requestBytes, responseBytes });
    } else {
      // A client hang-up or a post-header abort must not masquerade as a
      // completed request the way the old success-only path let it.
      this.log?.debug({ ...streamFields(), reason: outcome, latencyMs: Date.now() - startedAt }, "model relay stream ended");
    }
  }

  private allowedUpstreamUrl(plannedUrl: string, endpoint: string) {
    let base: URL;
    let target: URL;
    try {
      base = new URL(endpoint);
      target = new URL(plannedUrl);
    } catch {
      throw modelRelayError(502, MODEL_RELAY_ERROR_CODES.upstreamUnavailable, "The assigned model endpoint is not a valid upstream URL.");
    }
    // The adapter fixes the operation path; this is defense in depth against a
    // compromised adapter turning the relay into an arbitrary proxy.
    if (target.origin !== base.origin) {
      throw modelRelayError(502, MODEL_RELAY_ERROR_CODES.operationNotAllowed, "The relay operation resolved outside the assigned model endpoint.");
    }
    return target.toString();
  }
}
