import crypto from "node:crypto";
import { once } from "node:events";
import { Transform, type Readable, type Writable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ControlledInstance, ModelProtocol } from "@task-handoff/protocol/control-plane";
import {
  NodeModelRelayResolver,
  parseModelRelayRoutePathname,
  type ModelRelayRouteResolution,
} from "../relay-routes.ts";
import { MODEL_RELAY_ERROR_CODES, modelRelayError } from "./errors.ts";
import { upstreamRequestHeaders, upstreamResponseHeaders } from "./header-policy.ts";
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

export type ModelRelayServiceOptions = {
  resolver: NodeModelRelayResolver;
  adapters?: ModelRelayAdapter[];
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
    let requestBytes = 0;
    const preparation = await adapter.prepareRequest({
      body: hasBody ? request.raw : undefined,
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
    let bodyTimer: NodeJS.Timeout | undefined;
    const armBodyTimer = () => {
      if (bodyTimer) clearTimeout(bodyTimer);
      bodyTimer = setTimeout(() => {
        abortReason = firstChunk ? "first-byte-timeout" : "idle-timeout";
        controller.abort();
      }, firstChunk ? this.limits.firstByteTimeoutMs : this.limits.idleTimeoutMs);
    };
    if (responseBody) armBodyTimer();
    try {
      if (responseBody) {
        for await (const chunk of responseBody) {
          if (firstChunk) {
            firstChunk = false;
            armBodyTimer();
          } else {
            armBodyTimer();
          }
          responseBytes += chunk.length;
          if (abortReason === "client") break;
          if (!reply.raw.write(chunk)) await waitForDrain(reply.raw);
        }
      }
      if (!abortReason) reply.raw.end();
      else reply.raw.destroy();
    } catch (error) {
      reply.raw.destroy();
      this.log?.warn({
        ...context,
        status: upstream.status,
        reason: abortReason || "upstream-stream-error",
        ...(error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? { code: (error as { code: string }).code } : {}),
        latencyMs: Date.now() - startedAt,
        requestBytes,
        responseBytes,
        relayEnabled: this.resolver.relayEnabled(),
      }, "model relay stream interrupted");
      // The response has already started; the only safe diagnosis is the
      // stream close, never an injected error body.
      return;
    } finally {
      if (bodyTimer) clearTimeout(bodyTimer);
      reply.raw.off("close", onClientClose);
      this.activeControllers.delete(controller);
    }
    this.logCompleted(startedAt, {
      ...context,
      status: upstream.status,
      requestBytes,
      responseBytes,
    });
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
