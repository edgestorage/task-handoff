import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Node } from "@task-handoff/protocol/control-plane";
import {
  CONTROL_PLANE_PROXY_APPLICATION_REQUEST_HEADERS,
  CONTROL_PLANE_PROXY_APPLICATION_RESPONSE_HEADERS,
  CONTROL_PLANE_PROXY_AUTH_HEADERS,
  CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
  ControlPlaneProxyErrorCode,
  NodeAgentProxyRouteSchema,
  ProxyCorrelationIdSchema,
  ProxyTargetSnapshotSchema,
  type PublicProxyBinding as ProxyBinding,
  type ProxyTargetSnapshot,
} from "@task-handoff/protocol/control-plane-proxy";
import { z } from "zod";
import type { NodeAgentTransport, NodeAgentWebSocket } from "../nodes/client.ts";
import { ControlPlaneNodeProxyRuntime } from "../proxy/runtime.ts";
import { ControlPlaneProxyEventHub } from "../proxy/event-hub.ts";
import { publicControlPlaneProxyTarget } from "../proxy/target-projector.ts";
import type { ControlPlaneProxyTarget } from "../proxy/target-projector.ts";
import { PROXY_BINDING_ROUTE } from "./auth-boundary.ts";

const BindingParamsSchema = z.object({ bindingId: z.string().trim().min(1).max(160) }).passthrough();
const WebSocketQuerySchema = z.object({ route: NodeAgentProxyRouteSchema }).strict();
const EventsQuerySchema = z.object({ sinceRevision: z.coerce.number().int().nonnegative() }).strict();
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection", "cookie", "host", "keep-alive", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const MAX_PROXY_SNAPSHOT_BYTES = 512 * 1024;

export type NodeProxyAuthority = {
  authenticateBinding(bindingId: string, input: { sourceControlPlaneId: string; bindingKeyId: string; credential: string }): ProxyBinding;
  revokeBinding(bindingId: string): ProxyBinding;
};

export type NodeProxyTargetResolver = (targetNodeId: string) => {
  node: Node;
  transport: NodeAgentTransport;
} | Promise<{
  node: Node;
  transport: NodeAgentTransport;
}>;

export type RegisterNodeProxyRoutesOptions = {
  app: FastifyInstance;
  authority: NodeProxyAuthority;
  resolveTarget: NodeProxyTargetResolver;
  projectTarget: (targetNodeId: string) => ControlPlaneProxyTarget | undefined;
  eventHub: ControlPlaneProxyEventHub;
  runtime?: ControlPlaneNodeProxyRuntime;
  onBindingRevoked?: (binding: ProxyBinding) => void;
};

export function registerNodeProxyRoutes(options: RegisterNodeProxyRoutesOptions) {
  const { app, authority, resolveTarget, projectTarget, eventHub } = options;
  const runtime = options.runtime ?? new ControlPlaneNodeProxyRuntime();
  const httpContexts = new WeakMap<FastifyRequest, {
    binding: ProxyBinding;
    route: string;
    forwardedHeaders: Record<string, string>;
    tracked: ReturnType<ControlPlaneNodeProxyRuntime["reserveHttp"]>;
    abort: () => void;
  }>();
  const releaseHttp = (request: FastifyRequest, reply: FastifyReply) => {
    const context = httpContexts.get(request);
    if (!context) return;
    httpContexts.delete(request);
    context.tracked.release();
    request.raw.removeListener("aborted", context.abort);
    reply.raw.removeListener("close", context.abort);
  };

  app.all("/api/node-proxy/bindings/:bindingId/http/*", {
    config: PROXY_BINDING_ROUTE,
    bodyLimit: runtime.maxRequestBodyBytes,
    logLevel: "silent",
    async onRequest(request, reply) {
      try {
        const bindingId = BindingParamsSchema.parse(request.params).bindingId;
        const binding = authenticateRequest(authority, bindingId, request);
        const route = httpProxyRoute(request);
        const forwardedHeaders = applicationRequestHeaders(request.headers);
        const tracked = runtime.reserveHttp(binding.id);
        const abort = () => {
          tracked.controller.abort(Object.assign(new Error("Proxy HTTP consumer disconnected."), { name: "AbortError", code: "ABORT_ERR" }));
          releaseHttp(request, reply);
        };
        httpContexts.set(request, { binding, route, forwardedHeaders, tracked, abort });
        request.raw.once("aborted", abort);
        reply.raw.once("close", abort);
      } catch (error) {
        return sendProxyError(reply, error, request);
      }
    },
    async onError(request, reply) {
      releaseHttp(request, reply);
      const requestId = requestCorrelationId(request.headers);
      if (requestId) reply.header("x-request-id", requestId);
    },
    async onResponse(request, reply) {
      releaseHttp(request, reply);
    },
  }, async (request, reply) => {
    try {
      const context = httpContexts.get(request);
      if (!context) throw proxyRouteError(ControlPlaneProxyErrorCode.TransportFailed, "Proxy request context is unavailable.", 500, true);
      const { binding, route, forwardedHeaders, tracked, abort } = context;
      assertNoTargetOverride(binding, route, request.body);
      const body = requestBody(request.body);
      tracked.acceptRequestBody(body?.byteLength ?? 0);
      try {
        const { node, transport } = await resolveTarget(binding.targetNodeId);
        requireSameActiveBinding(authority, binding, request);
        assertTarget(binding, node);
        const response = await transport.requestStream(node, route, {
          method: request.method,
          headers: forwardedHeaders,
          ...(body ? { body: body as unknown as BodyInit } : {}),
          signal: tracked.controller.signal,
        });
        return sendProxyResponse(reply, response, tracked, abort, request, forwardedHeaders["x-request-id"]);
      } catch (error) {
        releaseHttp(request, reply);
        throw error;
      }
    } catch (error) {
      releaseHttp(request, reply);
      return sendProxyError(reply, error, request);
    }
  });

  app.get("/api/node-proxy/bindings/:bindingId/websocket", { websocket: true, logLevel: "silent", config: PROXY_BINDING_ROUTE }, async (socket, request) => {
    let wrapped: NodeAgentWebSocket | undefined;
    try {
      const bindingId = BindingParamsSchema.parse(request.params).bindingId;
      const binding = authenticateRequest(authority, bindingId, request);
      const route = WebSocketQuerySchema.parse(request.query).route;
      const { node, transport } = await resolveTarget(binding.targetNodeId);
      requireSameActiveBinding(authority, binding, request);
      assertTarget(binding, node);
      wrapped = runtime.openWebSocket(binding.id, socket);
      transport.proxyWebSocket(node, wrapped, route, webSocketProtocols(request.headers), applicationRequestHeaders(request.headers));
    } catch (error) {
      const payload = proxyErrorPayload(error);
      wrapped?.close(1008, payload.message);
      if (!wrapped) socket.close(payload.statusCode === 429 ? 1013 : payload.statusCode < 500 ? 1008 : 1011, truncateCloseReason(payload.message));
    }
  });

  app.get("/api/node-proxy/bindings/:bindingId/snapshot", { config: PROXY_BINDING_ROUTE }, async (request, reply) => {
    try {
      const bindingId = BindingParamsSchema.parse(request.params).bindingId;
      const binding = authenticateRequest(authority, bindingId, request);
      const { node } = await resolveTarget(binding.targetNodeId);
      requireSameActiveBinding(authority, binding, request);
      assertTarget(binding, node);
      const target = projectTarget(binding.targetNodeId);
      if (!target) {
        throw proxyRouteError(ControlPlaneProxyErrorCode.TargetUnavailable, "Proxy target no longer exists.", 404, false, {
          targetNodeId: binding.targetNodeId,
        });
      }
      const cursor = eventHub.cursor(binding.targetNodeId);
      const snapshot = ProxyTargetSnapshotSchema.parse({
          protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
          binding,
          streamId: cursor.streamId,
          revision: cursor.revision,
          observedAt: new Date().toISOString(),
          target: publicControlPlaneProxyTarget(target),
      });
      if (encodedJsonBytes(snapshot) > MAX_PROXY_SNAPSHOT_BYTES) {
        throw proxyRouteError(ControlPlaneProxyErrorCode.ResourceLimit, "Proxy target snapshot byte limit exceeded.", 429, true, {
          bindingId: binding.id,
          resource: "snapshot-bytes",
          limit: MAX_PROXY_SNAPSHOT_BYTES,
        });
      }
      return { data: snapshot };
    } catch (error) {
      return sendProxyError(reply, error, request);
    }
  });

  app.get("/api/node-proxy/bindings/:bindingId/events", { websocket: true, logLevel: "silent", config: PROXY_BINDING_ROUTE }, async (socket, request) => {
    let wrapped: NodeAgentWebSocket | undefined;
    let closeSubscription: (() => void) | undefined;
    let unregisterRuntimeCleanup: (() => void) | undefined;
    try {
      const bindingId = BindingParamsSchema.parse(request.params).bindingId;
      const binding = authenticateRequest(authority, bindingId, request);
      const query = EventsQuerySchema.parse(request.query);
      const { node } = await resolveTarget(binding.targetNodeId);
      requireSameActiveBinding(authority, binding, request);
      assertTarget(binding, node);
      wrapped = runtime.openWebSocket(binding.id, socket, () => closeSubscription?.());
      wrapped.on("message", () => wrapped?.close(1008, "Proxy event streams do not accept client messages."));
      const subscription = eventHub.subscribe({
        bindingId: binding.id,
        sourceControlPlaneId: binding.sourceControlPlaneId,
        targetNodeId: binding.targetNodeId,
      }, query.sinceRevision, (message) => {
        wrapped?.send(JSON.stringify(message));
      }, () => {
        wrapped?.close(1011, "Proxy event delivery failed.");
      });
      closeSubscription = subscription.close;
      unregisterRuntimeCleanup = runtime.registerBindingCleanup(binding.id, closeSubscription);
      const cleanup = () => {
        closeSubscription?.();
        unregisterRuntimeCleanup?.();
      };
      wrapped.on("close", cleanup);
      wrapped.on("error", cleanup);
      if (subscription.kind === "snapshot-required") {
        closeSubscription();
        wrapped.close(1008, "Proxy target snapshot is required.");
      } else if (wrapped.readyState !== 1) {
        closeSubscription();
      }
    } catch (error) {
      closeSubscription?.();
      unregisterRuntimeCleanup?.();
      const payload = proxyErrorPayload(error);
      wrapped?.close(1008, payload.message);
      if (!wrapped) socket.close(payload.statusCode === 429 ? 1013 : payload.statusCode < 500 ? 1008 : 1011, truncateCloseReason(payload.message));
    }
  });

  app.delete("/api/node-proxy/bindings/:bindingId", { config: PROXY_BINDING_ROUTE }, async (request, reply) => {
    try {
      const bindingId = BindingParamsSchema.parse(request.params).bindingId;
      authenticateRequest(authority, bindingId, request);
      const binding = authority.revokeBinding(bindingId);
      const closed = runtime.closeBinding(bindingId);
      options.onBindingRevoked?.(binding);
      return { data: { binding, closed } };
    } catch (error) {
      return sendProxyError(reply, error, request);
    }
  });

  return runtime;
}

function authenticateRequest(authority: NodeProxyAuthority, bindingId: string, request: Pick<FastifyRequest, "headers">) {
  const protocolVersion = header(request.headers, CONTROL_PLANE_PROXY_AUTH_HEADERS.protocolVersion);
  if (protocolVersion !== CONTROL_PLANE_PROXY_PROTOCOL_VERSION) {
    throw proxyRouteError(ControlPlaneProxyErrorCode.ProtocolUnsupported, "Control-plane proxy protocol version is unsupported.", 426, false, {
      requestedVersion: protocolVersion,
      supportedVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    });
  }
  const sourceControlPlaneId = header(request.headers, CONTROL_PLANE_PROXY_AUTH_HEADERS.sourceControlPlaneId);
  const bindingKeyId = header(request.headers, CONTROL_PLANE_PROXY_AUTH_HEADERS.bindingKeyId);
  const credential = header(request.headers, CONTROL_PLANE_PROXY_AUTH_HEADERS.credential);
  if (!sourceControlPlaneId || !bindingKeyId || !credential) {
    throw proxyRouteError(ControlPlaneProxyErrorCode.AuthenticationFailed, "Proxy binding authentication headers are incomplete.", 401);
  }
  return authority.authenticateBinding(bindingId, { sourceControlPlaneId, bindingKeyId, credential });
}

function requireSameActiveBinding(
  authority: NodeProxyAuthority,
  expected: ProxyBinding,
  request: Pick<FastifyRequest, "headers">,
) {
  const current = authenticateRequest(authority, expected.id, request);
  if (current.id !== expected.id
    || current.revision !== expected.revision
    || current.sourceControlPlaneId !== expected.sourceControlPlaneId
    || current.targetNodeId !== expected.targetNodeId
    || current.bindingKeyId !== expected.bindingKeyId
    || current.status !== "active") {
    throw proxyRouteError(
      ControlPlaneProxyErrorCode.BindingIdentityConflict,
      "Proxy binding changed while the request was being established.",
      409,
      true,
      { bindingId: expected.id, expectedRevision: expected.revision, actualRevision: current.revision },
    );
  }
}

function assertTarget(binding: ProxyBinding, node: Node) {
  if (node.id !== binding.targetNodeId) {
    throw proxyRouteError(ControlPlaneProxyErrorCode.TargetMismatch, "Proxy target resolver returned another node.", 409, false, {
      bindingId: binding.id,
      targetNodeId: binding.targetNodeId,
    });
  }
}

function assertNoTargetOverride(binding: ProxyBinding, route: string, body: unknown) {
  const query = new URL(route, "https://node-agent.invalid").searchParams;
  const values = [query.get("nodeId"), query.get("targetNodeId")];
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record.nodeId === "string") values.push(record.nodeId);
    if (typeof record.targetNodeId === "string") values.push(record.targetNodeId);
  }
  const conflict = values.find((value) => value !== null && value !== binding.targetNodeId);
  if (conflict !== undefined) {
    throw proxyRouteError(ControlPlaneProxyErrorCode.TargetMismatch, "Proxy request attempts to select a target outside its binding.", 409, false, {
      bindingId: binding.id,
      targetNodeId: binding.targetNodeId,
    });
  }
}

function httpProxyRoute(request: FastifyRequest) {
  const raw = request.raw.url || request.url;
  const match = /^\/api\/node-proxy\/bindings\/[^/]+\/http(\/[^#]*)$/.exec(raw);
  if (!match || /%(?:2f|5c)/i.test(match[1])) {
    throw proxyRouteError(ControlPlaneProxyErrorCode.RouteInvalid, "Proxy route is invalid.", 400);
  }
  const parsed = NodeAgentProxyRouteSchema.safeParse(match[1]);
  if (!parsed.success) {
    throw proxyRouteError(ControlPlaneProxyErrorCode.RouteInvalid, parsed.error.issues[0]?.message || "Proxy route is invalid.", 400);
  }
  return parsed.data;
}

function applicationRequestHeaders(headers: Record<string, unknown>) {
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-taskhandoff-node-") || lower.startsWith("x-task-handoff-node-")) {
      throw proxyRouteError(ControlPlaneProxyErrorCode.HeaderInvalid, "Caller-supplied node transport authentication headers are forbidden.", 400, false, { header: lower });
    }
  }
  const forwarded = Object.fromEntries([...CONTROL_PLANE_PROXY_APPLICATION_REQUEST_HEADERS].flatMap((name) => {
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) return [];
    const value = headers[name];
    if (value === undefined) return [];
    return [[name, Array.isArray(value) ? value.join(", ") : String(value)]];
  }));
  if (forwarded["x-request-id"] !== undefined) {
    const parsed = ProxyCorrelationIdSchema.safeParse(forwarded["x-request-id"]);
    if (!parsed.success) {
      throw proxyRouteError(ControlPlaneProxyErrorCode.HeaderInvalid, "Proxy request correlation id is invalid.", 400, false, { header: "x-request-id" });
    }
    forwarded["x-request-id"] = parsed.data;
  }
  return forwarded;
}

function applicationResponseHeaders(response: Response, requestId?: string) {
  const forwarded = Object.fromEntries([...CONTROL_PLANE_PROXY_APPLICATION_RESPONSE_HEADERS].flatMap((name) => {
    const value = response.headers.get(name);
    return value === null ? [] : [[name, value]];
  }));
  if (requestId) forwarded["x-request-id"] = requestId;
  return forwarded;
}

function sendProxyResponse(
  reply: FastifyReply,
  response: Response,
  tracked: ReturnType<ControlPlaneNodeProxyRuntime["openHttp"]>,
  abort: () => void,
  request: FastifyRequest,
  requestId?: string,
) {
  if (response.body) tracked.beginResponseStream();
  for (const [name, value] of Object.entries(applicationResponseHeaders(response, requestId))) reply.header(name, value);
  const cleanup = () => {
    tracked.release();
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  };
  if (!response.body) {
    cleanup();
    return reply.code(response.status).send();
  }
  const readable = Readable.fromWeb(response.body as never);
  tracked.controller.signal.addEventListener("abort", () => {
    const reason = tracked.controller.signal.reason;
    readable.destroy(reason instanceof Error ? reason : new Error("Proxy HTTP stream aborted."));
  }, { once: true });
  readable.on("data", (chunk) => {
    try {
      tracked.acceptResponseChunk(chunk);
    } catch (error) {
      readable.destroy(error as Error);
    }
  });
  readable.once("end", cleanup);
  readable.once("error", cleanup);
  readable.once("close", cleanup);
  reply.raw.once("close", () => readable.destroy());
  return reply.code(response.status).send(readable);
}

function sendProxyError(reply: FastifyReply, error: unknown, request?: Pick<FastifyRequest, "headers">) {
  const payload = proxyErrorPayload(error);
  const requestId = requestCorrelationId(request?.headers);
  if (requestId) reply.header("x-request-id", requestId);
  return reply.code(payload.statusCode).send({
    error: {
      code: payload.code,
      message: payload.message,
      retryable: payload.retryable,
      ...(payload.details ? { details: payload.details } : {}),
    },
  });
}

function proxyErrorPayload(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : 502;
  const knownCode = typeof record.code === "string" ? record.code : undefined;
  return {
    statusCode,
    code: knownCode || ControlPlaneProxyErrorCode.TransportFailed,
    message: error instanceof Error ? error.message : "Control-plane proxy transport failed.",
    retryable: typeof record.retryable === "boolean" ? record.retryable : statusCode >= 500,
    details: record.details && typeof record.details === "object" && !Array.isArray(record.details) ? record.details as Record<string, unknown> : undefined,
  };
}

function proxyRouteError(code: string, message: string, statusCode: number, retryable = false, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { code, statusCode, retryable, ...(details ? { details } : {}) });
}

function requestBody(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  return Buffer.from(JSON.stringify(value));
}

function header(headers: Record<string, unknown>, name: string) {
  const value = headers[name];
  return Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
}

function requestCorrelationId(headers?: Record<string, unknown>) {
  if (!headers) return undefined;
  const parsed = ProxyCorrelationIdSchema.safeParse(header(headers, "x-request-id"));
  return parsed.success ? parsed.data : undefined;
}

function encodedJsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function webSocketProtocols(headers: Record<string, unknown>) {
  const value = header(headers, "sec-websocket-protocol");
  const protocols = value.split(",").map((item) => item.trim()).filter(Boolean);
  return protocols.length ? protocols : undefined;
}

function truncateCloseReason(reason: string) {
  let value = "";
  for (const char of reason) {
    if (Buffer.byteLength(value + char) > 123) break;
    value += char;
  }
  return value;
}
