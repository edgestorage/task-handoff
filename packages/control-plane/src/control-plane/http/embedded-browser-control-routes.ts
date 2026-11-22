import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  EmbeddedBrowserAccessRequestViewSchema,
  EmbeddedBrowserCreationContextSnapshotSchema,
  EmbeddedBrowserDefaultContextClaimRequestSchema,
  EmbeddedBrowserDefaultContextClaimResultSchema,
  EmbeddedBrowserAccessViewSchema,
  EmbeddedBrowserSourceDeltaSchema,
  EmbeddedBrowserSourceRegistrationRequestSchema,
  EmbeddedBrowserSourceRegistrationViewSchema,
  EmbeddedBrowserSourceSnapshotSchema,
  EmbeddedBrowserSourceSnapshotCommitSchema,
  type EmbeddedBrowserSource,
} from "@task-handoff/protocol/embedded-browser-control";
import {
  controlledInstanceEmbeddedBrowserChannelCapabilities,
  supportsControlledInstanceEmbeddedBrowserChannel,
} from "@task-handoff/protocol/control-plane";
import type { ControlPlaneService } from "../application/service.ts";
import { assertCan, instanceScopeAllows, type ControlPlaneUserAuthorizationContext } from "../auth/authorization.ts";
import type { ControlPlaneAuth } from "../auth/service.ts";
import type { AuthorizationConnectionRegistry } from "../auth/authorization-connections.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import {
  EmbeddedBrowserChannelAccessService,
  type EmbeddedBrowserChannelAccess,
} from "../instances/embedded-browser-channel-access.ts";
import { PUBLIC_CONTROL_PLANE_ROUTE } from "./auth-boundary.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";
import { IdParamsSchema } from "./route-params.ts";

const BrowserAccessGrantRequestSchema = z.object({
  requestRef: z.string().trim().min(1).max(240).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
}).strip();
const BrowserAccessRequestDecisionSchema = z.object({
  expectedRevision: z.number().int().nonnegative().optional(),
}).strip();
const BrowserAccessRequestParamsSchema = z.object({
  id: z.string().trim().min(1),
  requestRef: z.string().trim().min(1).max(240),
}).strip();

export type RegisterEmbeddedBrowserControlRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  auth: ControlPlaneAuth;
  authorizationConnections: AuthorizationConnectionRegistry;
  events: ControlPlaneEventBus;
  access?: EmbeddedBrowserChannelAccessService;
};

type ProxySocket = {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  off: (event: string, listener: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  send: (data: unknown, options?: { binary?: boolean }) => void;
  close: (code?: number, reason?: string) => void;
  readyState: number;
};

type ProxyHttpInit = { method?: string; headers?: Record<string, string>; body?: string | Buffer };

export function registerEmbeddedBrowserControlRoutes(options: RegisterEmbeddedBrowserControlRoutesOptions) {
  const { app, service, auth, authorizationConnections, events } = options;
  const access = options.access || new EmbeddedBrowserChannelAccessService();

  const authorizeInstance = async (actor: ControlPlaneUserAuthorizationContext, instanceId: string) => {
    const instance = await service.requireControlledInstance(instanceId, true);
    if (!instanceScopeAllows(actor.nodeScope, actor.instanceScope, instanceId, instance.nodeId)) {
      throw Object.assign(new Error("Controlled instance is not visible to this actor."), { statusCode: 404, code: "CONTROL_PLANE_RESOURCE_NOT_VISIBLE" });
    }
    assertCan(actor, "interactive-access", { type: "instance", id: instanceId, instanceId, nodeId: instance.nodeId });
    if (!supportsControlledInstanceEmbeddedBrowserChannel(instance.capabilities)) {
      throw Object.assign(new Error("Embedded browser control is not supported by this instance."), { statusCode: 409, code: "BROWSER_CHANNEL_UNSUPPORTED" });
    }
    return instance;
  };

  const authorizeTargetCdpInstance = async (actor: ControlPlaneUserAuthorizationContext, instanceId: string) => {
    const instance = await authorizeInstance(actor, instanceId);
    if (!controlledInstanceEmbeddedBrowserChannelCapabilities(instance.capabilities).targetCdp) {
      throw Object.assign(new Error("Browser Target CDP is not supported by this instance."), {
        statusCode: 409,
        code: "BROWSER_OPERATION_UNSUPPORTED",
      });
    }
    return instance;
  };

  const proxyData = async <T = unknown>(instanceId: string, actor: ControlPlaneUserAuthorizationContext, path: string, init: ProxyHttpInit = {}): Promise<T> => {
    const response = await service.proxyInstanceHttp(instanceId, path, {
      ...init,
      headers: instanceChannelHeaders(service, actor, init.headers, init.body !== undefined),
    });
    return readProxyData(response) as T;
  };

  app.post("/api/controlled-instances/:id/browser-control/sources", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const actor = requireUserActor(request);
    await authorizeInstance(actor, id);
    const body = EmbeddedBrowserSourceRegistrationRequestSchema.parse(request.body);
    const registered = await proxyData<unknown>(id, actor, "/api/browser-control/sources", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const { source, registryEpoch, registryRevision } = EmbeddedBrowserSourceRegistrationViewSchema.parse(registered);
    const connection = access.create({
      instanceId: id,
      sourceRef: source.sourceRef,
      generation: source.generation,
      authorization: { userId: actor.userId, authorizationRevision: actor.authorizationRevision },
    });
    return { data: { source, connection: publicConnection(connection, registryEpoch, registryRevision) } };
  });

  app.put("/api/controlled-instances/:id/browser-control/sources/:sourceRef/snapshot", async (request) => {
    const { id, sourceRef } = sourceParams(request.params);
    const actor = requireUserActor(request);
    await authorizeInstance(actor, id);
    const body = EmbeddedBrowserSourceSnapshotSchema.parse(request.body);
    if (body.sourceRef !== sourceRef) throw sourceMismatch();
    const commit = await proxyData(id, actor, `/api/browser-control/sources/${encodeURIComponent(sourceRef)}/snapshot`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return { data: EmbeddedBrowserSourceSnapshotCommitSchema.parse(commit) };
  });

  app.post("/api/controlled-instances/:id/browser-control/sources/:sourceRef/deltas", async (request) => {
    const { id, sourceRef } = sourceParams(request.params);
    const actor = requireUserActor(request);
    await authorizeInstance(actor, id);
    const body = EmbeddedBrowserSourceDeltaSchema.parse(request.body);
    if (body.sourceRef !== sourceRef) throw sourceMismatch();
    const revision = await proxyData(id, actor, `/api/browser-control/sources/${encodeURIComponent(sourceRef)}/deltas`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { data: { revision } };
  });

  app.delete("/api/controlled-instances/:id/browser-control/sources/:sourceRef", async (request) => {
    const { id, sourceRef } = sourceParams(request.params);
    const actor = requireUserActor(request);
    await authorizeInstance(actor, id);
    await proxyData(id, actor, `/api/browser-control/sources/${encodeURIComponent(sourceRef)}`, { method: "DELETE" });
    access.closeInstance(id);
    return { data: {} };
  });

  app.get("/api/controlled-instances/:id/browser-control/access", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const actor = requireUserActor(request);
    await authorizeInstance(actor, id);
    return { data: EmbeddedBrowserAccessViewSchema.parse(await proxyData(id, actor, "/api/browser-control/access")) };
  });

  app.post("/api/controlled-instances/:id/browser-control/access", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const actor = requireUserActor(request);
    await authorizeInstance(actor, id);
    const body = BrowserAccessGrantRequestSchema.parse(request.body ?? {});
    return { data: EmbeddedBrowserAccessViewSchema.parse(await proxyData(id, actor, "/api/browser-control/access", { method: "POST", body: JSON.stringify(body) })) };
  });

  app.post("/api/controlled-instances/:id/browser-control/access-requests/:requestRef/deny", async (request) => {
    const { id, requestRef } = BrowserAccessRequestParamsSchema.parse(request.params);
    const actor = requireUserActor(request);
    await authorizeInstance(actor, id);
    const body = BrowserAccessRequestDecisionSchema.parse(request.body ?? {});
    const result = await proxyData(id, actor, `/api/browser-control/access-requests/${encodeURIComponent(requestRef)}/deny`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { data: EmbeddedBrowserAccessRequestViewSchema.parse(result) };
  });

  app.delete("/api/controlled-instances/:id/browser-control/access", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const actor = requireUserActor(request);
    await authorizeInstance(actor, id);
    return { data: await proxyData(id, actor, "/api/browser-control/access", { method: "DELETE" }) };
  });

  app.get("/api/controlled-instances/:id/browser-control/creation-context", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const actor = requireUserActor(request);
    await authorizeTargetCdpInstance(actor, id);
    const sourceRef = optionalQueryParam(request.query, "sourceRef");
    const snapshot = await proxyData(id, actor, creationContextPath(sourceRef));
    return { data: EmbeddedBrowserCreationContextSnapshotSchema.parse(snapshot) };
  });

  app.put("/api/controlled-instances/:id/browser-control/creation-context", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const actor = requireUserActor(request);
    await authorizeTargetCdpInstance(actor, id);
    const body = EmbeddedBrowserDefaultContextClaimRequestSchema.parse(request.body ?? {});
    const result = await proxyData(id, actor, creationContextPath(body.sourceRef, body.expectedRevision), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return { data: EmbeddedBrowserDefaultContextClaimResultSchema.parse(result) };
  });

  app.delete("/api/controlled-instances/:id/browser-control/creation-context", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const actor = requireUserActor(request);
    await authorizeTargetCdpInstance(actor, id);
    const body = deleteCreationContextRequest(request);
    const result = await proxyData(id, actor, creationContextPath(body.sourceRef, body.expectedRevision), {
      method: "DELETE",
      body: JSON.stringify(body),
    });
    return { data: result };
  });

  app.get("/browser-channel-relay", { websocket: true, config: PUBLIC_CONTROL_PLANE_ROUTE }, async (socket, request) => {
    const proxySocket = socket as unknown as ProxySocket;
    let releaseAccess: (() => void) | undefined;
    let releaseAuthorization: (() => void) | undefined;
    const bufferedMessages: Array<[unknown, boolean]> = [];
    const bufferMessage = (data: unknown, isBinary = false) => bufferedMessages.push([data, Boolean(isBinary)]);
    proxySocket.on("message", bufferMessage);
    try {
      const channelAccess = access.consume(browserChannelAuthorizationToken(request.headers.authorization));
      if (auth.enabled?.() !== false) {
        await auth.assertAppAccessAuthorization({
          ...channelAccess.authorization,
          instanceId: channelAccess.instanceId,
          nodeId: (await service.requireControlledInstance(channelAccess.instanceId, true)).nodeId,
        });
      }
      const close = () => proxySocket.close(4001, "Browser channel authorization ended.");
      releaseAccess = access.track(channelAccess, close);
      releaseAuthorization = authorizationConnections.track(channelAccess.authorization, close);
      proxySocket.on("close", () => { releaseAccess?.(); releaseAuthorization?.(); });
      await service.proxyInstanceWebSocket(
        channelAccess.instanceId,
        proxySocket as never,
        "/api/browser-control/relay",
        [],
        {
          "x-task-handoff-control-plane-id": service.proxyPrivateStore.controlPlaneId(),
          "x-task-handoff-user-id": channelAccess.authorization.userId,
        },
      );
      proxySocket.off("message", bufferMessage);
      for (const [data, isBinary] of bufferedMessages.splice(0)) proxySocket.emit("message", data, isBinary);
    } catch {
      proxySocket.off("message", bufferMessage);
      bufferedMessages.length = 0;
      releaseAccess?.();
      releaseAuthorization?.();
      proxySocket.close(1008, "Browser channel access is invalid or unavailable.");
    }
  });

  events.on((event) => {
    if (!["instance.stopped", "instance.deleted", "instance.restarted"].includes(event.type)) return;
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    if (typeof payload.instanceId === "string") access.closeInstance(payload.instanceId);
  });

  return access;
}

function instanceChannelHeaders(
  service: ControlPlaneService,
  actor: ControlPlaneUserAuthorizationContext,
  extra?: Record<string, string>,
  hasBody = false,
) {
  return {
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...(extra || {}),
    "x-task-handoff-control-plane-id": service.proxyPrivateStore.controlPlaneId(),
    "x-task-handoff-user-id": actor.userId,
  };
}

async function readProxyData(response: { status: number; body: ReadableStream<Uint8Array> | null }) {
  let payload: {
    data?: unknown;
    error?: {
      code?: string;
      message?: string;
      details?: unknown;
      retryable?: boolean;
      execution?: string;
      creationRef?: string;
      expiresAt?: string;
      revision?: number;
      defaultBrowserContextId?: string;
    };
  } = {};
  if (response.body) {
    try { payload = await new Response(response.body).json() as typeof payload; } catch {}
  }
  if (response.status < 200 || response.status >= 300) {
    const error = payload.error || {};
    const upstreamDetails = error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details as Record<string, unknown>
      : undefined;
    const details = {
      ...(upstreamDetails || {}),
      ...(error.execution ? { execution: error.execution } : {}),
      ...(error.creationRef ? { creationRef: error.creationRef } : {}),
      ...(error.expiresAt ? { expiresAt: error.expiresAt } : {}),
      ...(error.revision !== undefined ? { revision: error.revision } : {}),
      ...(error.defaultBrowserContextId ? { defaultBrowserContextId: error.defaultBrowserContextId } : {}),
    };
    throw Object.assign(new Error(payload.error?.message || `Controlled instance browser channel request failed with HTTP ${response.status}.`), {
      statusCode: response.status,
      code: payload.error?.code || "BROWSER_CHANNEL_REQUEST_FAILED",
      ...(Object.keys(details).length ? { details } : {}),
      ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    });
  }
  return payload.data;
}

function publicConnection(access: EmbeddedBrowserChannelAccess, registryEpoch: string, registryRevision: number) {
  return {
    accessId: access.accessId,
    token: access.token,
    expiresAt: access.expiresAt,
    relayPath: "/browser-channel-relay" as const,
    sourceRef: access.sourceRef,
    generation: access.generation,
    registryEpoch,
    registryRevision,
  };
}

function browserChannelAuthorizationToken(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("BrowserControl ")) return "";
  return value.slice("BrowserControl ".length).trim();
}

function requireUserActor(request: FastifyRequest): ControlPlaneUserAuthorizationContext {
  const actor = controlPlaneRequestActor(request);
  if (actor?.type === "user") return actor;
  throw Object.assign(new Error("A signed-in Control Plane user is required."), { statusCode: 403, code: "BROWSER_CHANNEL_USER_REQUIRED" });
}

function sourceParams(params: unknown) {
  const value = params as { id: string; sourceRef: string };
  const { id } = IdParamsSchema.parse({ id: value.id });
  return { id, sourceRef: requiredParam(value.sourceRef, "sourceRef") };
}

function requiredParam(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error(`${name} is invalid.`), { statusCode: 400, code: "BROWSER_CHANNEL_INPUT_INVALID" });
  return value.trim();
}

function optionalQueryParam(query: unknown, name: string) {
  if (!query || typeof query !== "object" || Array.isArray(query)) return undefined;
  const value = (query as Record<string, unknown>)[name];
  return value === undefined ? undefined : requiredParam(value, name);
}

function deleteCreationContextRequest(request: FastifyRequest) {
  const body = request.body;
  if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length) {
    return EmbeddedBrowserDefaultContextClaimRequestSchema.parse(body);
  }
  const sourceRef = optionalQueryParam(request.query, "sourceRef");
  const expectedRevision = optionalQueryParam(request.query, "expectedRevision");
  if (!sourceRef) throw Object.assign(new Error("sourceRef is required."), { statusCode: 400, code: "BROWSER_CHANNEL_INPUT_INVALID" });
  if (!expectedRevision || !/^(0|[1-9]\d*)$/.test(expectedRevision)) {
    throw Object.assign(new Error("expectedRevision is invalid."), { statusCode: 400, code: "BROWSER_CHANNEL_INPUT_INVALID" });
  }
  return { sourceRef, expectedRevision: Number(expectedRevision) };
}

function creationContextPath(sourceRef?: string, expectedRevision?: number) {
  const params = new URLSearchParams();
  if (sourceRef) params.set("sourceRef", sourceRef);
  if (expectedRevision !== undefined) params.set("expectedRevision", String(expectedRevision));
  const query = params.toString();
  return `/api/browser-control/creation-context${query ? `?${query}` : ""}`;
}

function sourceMismatch() {
  return Object.assign(new Error("Browser source identity does not match the request path."), { statusCode: 400, code: "BROWSER_SOURCE_MISMATCH" });
}
