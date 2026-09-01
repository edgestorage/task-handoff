import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Fastify from "fastify";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { TASK_HANDOFF_WEBSOCKET_SERVER_OPTIONS } from "@task-handoff/protocol/websocket-bridge";
import { isControlPlaneCredentialHeader } from "./proxy-headers.ts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyServerOptions } from "fastify";
import { z } from "zod";
import { AiSessionUnreadEventType } from "@task-handoff/protocol/ai-sessions";
import { TtyStreamSnapshotMessageSchema } from "@task-handoff/protocol/app-sessions";
import { RelayTtySnapshotEnvelopeSchema } from "@task-handoff/cloud-contracts";
import { CONTROL_PLANE_PROTOCOL_VERSION, ControlPlaneHealthResponseSchema, ImagePullTerminalEventType, NodeStateProjectionEventSchema, type BuildInfo, type Node } from "@task-handoff/protocol/control-plane";
import { packageVersionResolver } from "@task-handoff/core/core/package-version";
import { DEFAULT_MAINTENANCE_INTERVAL_MS } from "@task-handoff/core/storage/retention";
import { SESSION_STREAM_PROTOCOL_VERSION, SessionStreamsHelloEventType, aiSessionTransientSubscriptionAccepts, type AiSessionTransientSubscription, type EventEnvelope } from "@task-handoff/protocol/events";
import { CONTROL_PLANE_SESSION_COOKIE, ControlPlaneAuth, type ControlPlaneAuthOptions } from "../auth/service.ts";
import { ControlPlaneService, type ControlPlaneServiceOptions } from "../application/service.ts";
import { ControlPlaneChatGatewayRuntime } from "../chat/gateway/runtime.ts";
import { ControlPlaneEventBus } from "../events/bus.ts";
import { AiSessionAttachmentStore } from "../sessions/ai-session-attachments.ts";
import { AiSessionAttachmentCache } from "../sessions/ai-session-attachment-cache.ts";
import { ControlPlaneNodeAgentTunnelTransport, ControlPlaneNodeEventSubscriber } from "../nodes/tunnel.ts";
import { controlPlaneStorePaths } from "../persistence/paths.ts";
import { acquireControlPlaneSingletonLock, defaultControlPlaneSingletonLockPath } from "../process/singleton-lock.ts";
import { assertCan, assertCanAccessResolvedResource, instanceScopeAllows, type ControlPlaneAction, type ControlPlaneActor, type ControlPlaneResource } from "../auth/authorization.ts";
import { resolveRequestResourceScopes } from "../auth/resource-scope.ts";
import { controlPlaneRequestActor, setControlPlaneRequestActor } from "./request-actor.ts";
import { registerControlPlaneManagementRoutes } from "./management-routes.ts";
import { registerInstanceProxyRoutes } from "./instance-proxy-routes.ts";
import { ControlPlaneAiSessionAggregator } from "../sessions/ai-session-aggregator.ts";
import { StorySessionIndex } from "../sessions/story-session-index.ts";
import { AiSessionUnreadStore } from "../sessions/ai-session-unread-store.ts";
import { ControlPlaneAppSessionAggregator } from "../sessions/app-session-aggregator.ts";
import { nodeAgentInstallScript } from "../nodes/install-script.ts";
import { ImagePullProgressProjector } from "../images/image-pull-progress.ts";
import { PUBLIC_CONTROL_PLANE_ROUTE, PUBLIC_CONTROL_PLANE_UI_ROUTE } from "./auth-boundary.ts";
import { ControlPlaneProxyStore } from "../proxy/store.ts";
import { ControlPlaneProxyService } from "../proxy/service.ts";
import { ControlPlaneNodeProxyRuntime } from "../proxy/runtime.ts";
import { ControlPlaneProxyEventHub } from "../proxy/event-hub.ts";
import { registerNodeProxyRoutes } from "./node-proxy-routes.ts";
import { ControlPlaneProxyStateSubscriber } from "../nodes/control-plane-proxy-state-subscriber.ts";
import { registerControlPlaneProxyManagementRoutes } from "./control-plane-proxy-management-routes.ts";
import { registerControlPlaneUserRoutes } from "./user-routes.ts";
import { registerControlPlaneGitCredentialRoutes } from "./git-credential-routes.ts";
import { projectControlPlaneProxyTarget, publicControlPlaneProxyTarget } from "../proxy/target-projector.ts";
import { ControlPlaneIdentityService } from "../identity/service.ts";
import { NodeConnectionRuntime } from "../nodes/connection-runtime.ts";
import { createControlPlaneDiagnosticLogger, createDiagnosticLogsArchive } from "../diagnostics/logs.ts";
import { CloudConnectivityService } from "../cloud-connectivity/service.ts";
import type { CloudConnectivityLifecycle } from "../cloud-connectivity/lifecycle.ts";
import { CloudConnectivityBackgroundRuntime } from "../cloud-connectivity/coordinator-runtime.ts";
import { AuthorizationConnectionRegistry } from "../auth/authorization-connections.ts";
import { registerBrowserRelayRoutes } from "./browser-relay-routes.ts";
import { BrowserAccessService } from "../instances/browser-access-service.ts";

export type CreateControlPlaneAppOptions = {
  dataDir?: string;
  staticDir?: string;
  logger?: FastifyServerOptions["logger"];
  service?: ControlPlaneServiceOptions;
  auth?: ControlPlaneAuthOptions;
  proxyOrigin?: string;
  cloudServiceOrigin?: string;
  allowNonProductionCloudOrigin?: boolean;
  cloudConnectivityEnabled?: boolean;
  cloudConnectivityLifecycle?: (state: CloudConnectivityService) => CloudConnectivityLifecycle;
  publishCloudBindingChallenge?: (challenge: ReturnType<CloudConnectivityService["createChallenge"]>) => Promise<void>;
};

const CLOUD_INTERNAL_ACTOR_HEADER = "x-task-handoff-cloud-internal-actor";

export type RunControlPlaneServerOptions = CreateControlPlaneAppOptions & {
  host: string;
  port: number;
};

export const ControlPlaneHttpErrorSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean().optional(),
}).strict();

export const ControlPlaneHttpErrorResponseSchema = z.object({
  error: ControlPlaneHttpErrorSchema,
}).strict();

const CLOUD_PRODUCTION_ORIGIN = "https://cloud.thandoff.com";

export function trustedCloudServiceOrigin(value: string | undefined, options: { production?: boolean; allowNonProduction?: boolean } = {}) {
  const origin = new URL(value || CLOUD_PRODUCTION_ORIGIN).origin;
  if (origin === CLOUD_PRODUCTION_ORIGIN) return origin;
  if (options.production || options.allowNonProduction !== true) throw Object.assign(new Error("Non-production cloud service origin is not trusted by this build."), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  return origin;
}

function defaultStaticDir() {
  return path.resolve(process.cwd(), "packages", "control-plane-ui", "dist");
}

function envFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function controlPlaneDiagnosticLogsEnabled() {
  return envFlag(process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS);
}

function nodeStateProjection(node: Node & {
  connectionPhase?: "connecting" | "handshaking" | "healthy" | "reconnecting" | "suspect" | "offline";
  connectionDiagnostics?: {
    pingRttMs?: number;
    pingRttP95Ms?: number;
    consecutiveReconnects: number;
    nextRetryAt?: string;
  };
}) {
  return NodeStateProjectionEventSchema.parse({
    nodeId: node.id,
    status: node.status,
    health: node.health,
    lastSeenAt: node.lastSeenAt ?? null,
    connectionPhase: node.connectionPhase ?? null,
    connectionDiagnostics: node.connectionDiagnostics ?? null,
    proxyState: node.proxyState ?? null,
  });
}

function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

const packageVersion = packageVersionResolver("@task-handoff/control-plane");

function buildInfo(): BuildInfo {
  return {
    component: "control-plane",
    packageName: "@task-handoff/control-plane",
    packageVersion: packageVersion(),
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    buildId: optionalEnv("TASK_HANDOFF_BUILD_ID"),
    builtAt: optionalEnv("TASK_HANDOFF_BUILT_AT"),
    gitCommit: optionalEnv("TASK_HANDOFF_GIT_COMMIT"),
    imageRef: optionalEnv("TASK_HANDOFF_IMAGE_REF"),
    imageDigest: optionalEnv("TASK_HANDOFF_IMAGE_DIGEST"),
  };
}

const STATIC_MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function staticFilePath(staticDir: string, relativePath: string) {
  const resolvedRoot = path.resolve(staticDir);
  const resolvedFile = path.resolve(resolvedRoot, relativePath);
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    return undefined;
  }
  return fs.existsSync(resolvedFile) && fs.statSync(resolvedFile).isFile() ? resolvedFile : undefined;
}

function sendStaticFile(reply: FastifyReply, staticDir: string, relativePath: string) {
  const filePath = staticFilePath(staticDir, relativePath);
  if (!filePath) {
    return reply.code(404).send({
      error: {
        code: "STATIC_FILE_NOT_FOUND",
        message: `${relativePath} was not found in the Control Plane UI static directory.`,
      },
    });
  }
  reply.header("cache-control", "no-store");
  reply.type(STATIC_MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream");
  return reply.send(fs.createReadStream(filePath));
}

export function controlPlaneErrorPayload(error: unknown) {
  if (error instanceof z.ZodError) {
    return {
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
    };
  }
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return {
    statusCode: typeof record.statusCode === "number" ? record.statusCode : 500,
    code: typeof record.code === "string" ? record.code : "CONTROL_PLANE_ERROR",
    message: error instanceof Error ? error.message : String(error),
    ...(record.details && typeof record.details === "object" && !Array.isArray(record.details) ? { details: record.details } : {}),
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
    ...(typeof record.retryAfterSeconds === "number" ? { retryAfterSeconds: record.retryAfterSeconds } : {}),
  };
}

function disabledAuthActor(): ControlPlaneActor {
  return { type: "system", reason: "auth-disabled" };
}

function isPublicUiPath(url: string) {
  const path = url.split("?")[0] || "/";
  return !path.startsWith("/api/") && path !== "/api" && !path.startsWith("/instances/") && path !== "/instances";
}

type RequestSessionCredential = { token: string | undefined; clientType: "web" | "mobile" };

function requestSessionCredential(request: FastifyRequest): RequestSessionCredential {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    return { token: match?.[1], clientType: "mobile" };
  }
  return { token: request.cookies[CONTROL_PLANE_SESSION_COOKIE], clientType: "web" };
}

async function actorForRequest(auth: ControlPlaneAuth, credential: RequestSessionCredential) {
  if (!auth.enabled()) {
    return disabledAuthActor();
  }
  return auth.authorizationForSessionToken(credential.token, credential.clientType);
}

const ROUTES_WITHOUT_RBAC = new Set([
  "/api/auth/session",
  "/api/auth/bootstrap-admin",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/mobile/login",
  "/api/control-plane/identity",
  "/api/health",
  "/api/events",
  "/api/access/me",
  "/api/auth/external/callback",
]);

export function routeAuthorization(method: string, url: string): { action: ControlPlaneAction; resource: ControlPlaneResource } | undefined {
  const path = url.split("?")[0] || "/";
  if (!path.startsWith("/api/")) {
    return undefined;
  }
  if (ROUTES_WITHOUT_RBAC.has(path)) {
    return undefined;
  }
  const action = actionForHttpMethod(method);
  if (path === "/api/control-plane/diagnostic-logs/export") {
    return { action: "manage-settings", resource: { type: "control-plane-settings" } };
  }
  if (path === "/api/session-streams/diagnostics") {
    return { action: "manage-settings", resource: { type: "control-plane-settings" } };
  }
  if (path.startsWith("/api/control-plane/settings")) {
    return { action: method === "GET" ? "read" : "manage-settings", resource: { type: "control-plane-settings" } };
  }
  if (path === "/api/auth/mobile/logout" || path.startsWith("/api/auth/mobile/sessions")) {
    return undefined;
  }
  if (path === "/api/auth/password") {
    return undefined;
  }
  if (path.startsWith("/api/auth/external/")) return undefined;
  if (path.startsWith("/api/users")) {
    return { action: method === "GET" ? "read" : "manage-members", resource: { type: path.includes("/sessions") ? "user-session" : "user" } };
  }
  if (path.startsWith("/api/roles") || path === "/api/permissions") {
    return { action: method === "GET" ? "read" : "update", resource: { type: "role" } };
  }
  if (path.startsWith("/api/identity-providers")) {
    return { action: method === "GET" ? "read" : "update", resource: { type: "identity-provider" } };
  }
  if (path.startsWith("/api/external-identity-approvals")) {
    return { action: method === "GET" ? "read" : "manage-members", resource: { type: "identity-approval" } };
  }
  if (path.startsWith("/api/models")) {
    return { action: method === "GET" ? "read" : "manage-secrets", resource: { type: "model" } };
  }
  if (path.startsWith("/api/git-credentials")) {
    return { action: "manage-secrets", resource: { type: "secret" } };
  }
  if (path.startsWith("/api/chat-gateway/bridges")) {
    return { action: method === "GET" ? "read" : "manage-secrets", resource: { type: "chat-bridge" } };
  }
  if (path === "/api/chat-gateway/messages" || path === "/api/chat-gateway/actions") {
    return { action: "send-message", resource: { type: "ai-session" } };
  }
  if (path === "/api/chat-gateway/poll-ai-sessions") {
    return { action: "manage-settings", resource: { type: "chat-bridge" } };
  }
  if (path === "/api/ai-session-attachments") {
    return { action: "send-message", resource: { type: "ai-session" } };
  }
  if (path === "/api/node-join/invites") {
    return { action: "manage-node-auth", resource: { type: "node" } };
  }
  if (path.startsWith("/api/control-plane-proxy")) {
    return { action: method === "GET" ? "read" : "manage-node-auth", resource: { type: "node" } };
  }
  if (path.startsWith("/api/nodes")) {
    if (/\/(runtimes|local-folders)(\/|$)/.test(path)) {
      return { action, resource: { type: "runtime" } };
    }
    return { action: method === "GET" ? "read" : "manage-node-auth", resource: { type: "node" } };
  }
  if (path.startsWith("/api/controlled-instances")) {
    if (/\/apps\/sessions\/[^/]+\/access$/.test(path)) return { action: "interactive-access", resource: { type: "app-session" } };
    if (path.includes("/ai-sessions")) {
      if (path.includes("/triggers")) return { action, resource: { type: "trigger-deployment" } };
      if (/\/messages\/[^/]+\/attachments\/[^/]+\/content$/.test(path)) return { action: "read-file-content", resource: { type: "attachment" } };
      if (method === "POST" && /\/ai-sessions$/.test(path)) return { action: "send-message", resource: { type: "ai-session" } };
      if (path.endsWith("/approval")) return { action: "approve", resource: { type: "ai-session" } };
      if (path.endsWith("/interrupt")) return { action: "interrupt", resource: { type: "ai-session" } };
      if (path.endsWith("/resume") || path.endsWith("/fork") || path.endsWith("/commands") || path.includes("/messages") || path.includes("/queue/")) {
        return { action: "send-message", resource: { type: "ai-session" } };
      }
      if (path.endsWith("/read") || path.endsWith("/mentions/files")) {
        return { action: "read", resource: { type: "ai-session" } };
      }
      if (path.endsWith("/open-app") || path.endsWith("/close")) return { action: "update", resource: { type: "ai-session" } };
      if (method === "GET" || method === "HEAD") return { action: "read", resource: { type: "ai-session" } };
      return { action: "manage-settings", resource: { type: "control-plane-settings" } };
    }
    if (path.includes("/start")) return { action: "start", resource: { type: "instance" } };
    if (path.includes("/stop")) return { action: "stop", resource: { type: "instance" } };
    if (path.includes("/restart")) return { action: "restart", resource: { type: "instance" } };
    if (/\/config-sync(?:\/|$)/.test(path)) return { action: "update", resource: { type: "instance" } };
    return { action, resource: { type: "instance" } };
  }
  if (path.startsWith("/api/projects")) {
    return { action, resource: { type: "project" } };
  }
  if (path.startsWith("/api/images") || path.startsWith("/api/image-options") || path.startsWith("/api/market")) {
    return { action, resource: { type: "image" } };
  }
  if (path.startsWith("/api/triggers")) {
    if (path.endsWith("/apply")) return { action: "create", resource: { type: "trigger-deployment" } };
    return { action, resource: { type: "trigger-template" } };
  }
  // Collection reads use a non-sensitive global directory policy and must be
  // filtered by their handler. Unknown mutations fail closed as settings.
  return method === "GET" || method === "HEAD"
    ? { action: "read", resource: { type: "public-directory" } }
    : { action, resource: { type: "control-plane-settings" } };
}

function actionForHttpMethod(method: string): ControlPlaneAction {
  if (method === "GET" || method === "HEAD") return "read";
  if (method === "POST") return "create";
  if (method === "PATCH" || method === "PUT") return "update";
  if (method === "DELETE") return "delete";
  return "read";
}

export async function createControlPlaneApp(options: CreateControlPlaneAppOptions = {}) {
  const paths = controlPlaneStorePaths(options.dataDir);
  const app = Fastify({ logger: options.logger ?? true });
  await app.register(compress, {
    encodings: ["br", "gzip", "deflate"],
    globalDecompression: false,
    threshold: 1024,
  });
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  const events = new ControlPlaneEventBus();
  const authorizationConnections = new AuthorizationConnectionRegistry();
  const browserAccess = new BrowserAccessService();
  const cloudConnectivityEnabled = options.cloudConnectivityEnabled ?? process.env.TASK_HANDOFF_CLOUD_CONNECTIVITY_ENABLED !== "0";
  let diagnosticLogsEnabled = controlPlaneDiagnosticLogsEnabled();
  const diagnosticLogger = createControlPlaneDiagnosticLogger(paths.logsDir, () => diagnosticLogsEnabled, app.log);
  const nodeConnectionRuntime = new NodeConnectionRuntime();
  const service = new ControlPlaneService(paths, {
    ...options.service,
    logger: diagnosticLogger,
    nodeConnectionRuntime,
    onFleetStateChanged: (state) => {
      options.service?.onFleetStateChanged?.(state);
      events.publish("node.fleet.updated", state, {
        topic: state.resource === "instances" ? "instances" : state.resource === "models" ? "models" : "node.runtime",
        scope: { nodeId: state.nodeId },
      });
    },
  });
  nodeConnectionRuntime.onChange((observation) => events.publish(
    "node.connection.updated",
    nodeStateProjection(service.requirePublicNode(observation.nodeId)),
    {
      topic: "node.state",
      scope: { nodeId: observation.nodeId },
    },
  ));
  const auth = new ControlPlaneAuth(paths, {
    ...options.auth,
    onUserAuthorizationChanged: (change) => {
      events.invalidateUserAuthorization(change.userId, change.authorizationRevision);
      authorizationConnections.invalidate(change.userId, change.authorizationRevision);
      options.auth?.onUserAuthorizationChanged?.(change);
    },
  });
  const identity = new ControlPlaneIdentityService(
    paths.identitySigningPath,
    () => service.proxyPrivateStore.controlPlaneId(),
    (message, details) => app.log.warn(details, message),
  );
  const cloudConnectivity = new CloudConnectivityService({
    statePath: paths.cloudConnectivityPath,
    identity,
    serviceOrigin: trustedCloudServiceOrigin(options.cloudServiceOrigin || process.env.TASK_HANDOFF_CLOUD_SERVICE_ORIGIN, { production: process.env.NODE_ENV === "production", allowNonProduction: options.allowNonProductionCloudOrigin === true || process.env.TASK_HANDOFF_CLOUD_ENV === "staging" }),
  });
  const cloudRelayActors = new Map<string, ControlPlaneActor>();
  const cloudRelayBridge = {
    async request(actor: ControlPlaneActor, input: { path: string; method: string; headers: Record<string, string>; body?: unknown }) {
      const method = String(input?.method || "GET").toUpperCase();
      const requestPath = String(input?.path || "");
      const authorization = routeAuthorization(method, requestPath);
      if (!requestPath.startsWith("/api/") || !authorization || ROUTES_WITHOUT_RBAC.has(requestPath.split("?")[0])) {
        throw Object.assign(new Error("Cloud access route is not available."), { code: "CLOUD_ROUTE_FORBIDDEN", statusCode: 403 });
      }
      assertCan(actor, authorization.action, authorization.resource);
      const token = crypto.randomBytes(32).toString("base64url");
      cloudRelayActors.set(token, actor);
      try {
        const headers = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([name]) => {
          const lower = name.toLowerCase();
          return !isControlPlaneCredentialHeader(lower) && !["host", "connection", "upgrade", CLOUD_INTERNAL_ACTOR_HEADER].includes(lower);
        }).map(([name, value]) => [name, String(value)]));
        const response = await app.inject({ method: method as any, url: requestPath, headers: { ...headers, [CLOUD_INTERNAL_ACTOR_HEADER]: token }, ...(input.body === undefined ? {} : { payload: input.body as any }) });
        let body: unknown; try { body = response.json(); } catch { body = response.body; }
        return { status: response.statusCode, body };
      } finally { cloudRelayActors.delete(token); }
    },
    subscribe(actor: ControlPlaneActor, topics: string[], listener: (event: EventEnvelope) => void, aiSessionTransient?: AiSessionTransientSubscription) {
      if (actor.type !== "cloud-account") throw Object.assign(new Error("Cloud account actor required."), { code: "CLOUD_ACTOR_REQUIRED" });
      // The relay decoder supplies ["*"] when the legacy field is absent.
      // An explicit empty list means the last consumer has unsubscribed.
      const selected = new Set(topics);
      if (!selected.size) return () => undefined;
      // Compatibility for v0.0.21 cloud clients: absence of the additive model
      // retains topic-derived legacy demand. Current mobile clients are precise.
      const stopEvents = events.on((event) => {
        if ((selected.has("*") || selected.has(event.topic) || selected.has(event.type)) && aiSessionTransientSubscriptionAccepts(aiSessionTransient, event)) listener(event);
      });
      // Install delivery before publishing upstream demand so a synchronous
      // source replay cannot overtake this relay consumer.
      const stopTransientDemand = aiSessionTransient
        ? events.registerAiSessionTransientDemand(aiSessionTransient)
        : events.registerLegacyAiSessionTransientDemand(selected);
      return () => {
        stopEvents();
        stopTransientDemand();
      };
    },
    async openTty(actor: ControlPlaneActor, input: { instanceId: string; sessionId: string }, listener: (message: any) => void) {
      const instanceId = String(input?.instanceId || ""); const sessionId = String(input?.sessionId || "");
      assertCan(actor, "proxy", { type: "instance", id: instanceId, instanceId });
      if (!instanceId || !sessionId) throw Object.assign(new Error("TTY target is required."), { code: "TTY_TARGET_REQUIRED", statusCode: 400 });
      const callbacks = new Map<string, Set<(...args: any[]) => void>>();
      const emit = (name: string, ...args: any[]) => { for (const callback of callbacks.get(name) ?? []) callback(...args); };
      let closed = false;
      const socket = {
        readyState: 1,
        on(name: string, callback: (...args: any[]) => void) { const current = callbacks.get(name) ?? new Set(); current.add(callback); callbacks.set(name, current); },
        send(raw: unknown) { try { const value = JSON.parse(String(raw)); if (value.type === "snapshot") { const snapshot = TtyStreamSnapshotMessageSchema.parse(value); listener(RelayTtySnapshotEnvelopeSchema.parse({ type: "tty-snapshot", data: snapshot.data, pendingEscape: snapshot.pendingEscape, cols: snapshot.cols, rows: snapshot.rows })); } else if (value.type === "output") listener({ type: "tty-output", data: value.data }); else if (value.type === "resize") listener({ type: "tty-resize", body: { cols: value.cols, rows: value.rows } }); else if (value.type === "exit") listener({ type: "tty-exit", code: value.code, signal: value.signal }); else if (value.type === "error") listener({ type: "tty-error" }); } catch { listener({ type: "tty-error" }); } },
        close() { if (closed) return; closed = true; emit("close"); listener({ type: "tty-closed" }); },
      };
      await service.proxyInstanceWebSocket(instanceId, socket as any, `/api/apps/sessions/${encodeURIComponent(sessionId)}/tty`, [], {});
      return { send(data: string) { if (!closed) emit("message", Buffer.from(JSON.stringify({ type: "input", data }))); }, resize(cols: number, rows: number) { if (!closed && Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) emit("message", Buffer.from(JSON.stringify({ type: "resize", cols, rows }))); }, close() { socket.close(); } };
    },
  };
  const cloudConnectivityRuntime = new CloudConnectivityBackgroundRuntime({ state: cloudConnectivity, identity, relayBridge: cloudRelayBridge });
  const cloudConnectivityLifecycle = options.cloudConnectivityLifecycle?.(cloudConnectivity) ?? cloudConnectivityRuntime.lifecycle;
  const publishCloudBindingChallenge = options.publishCloudBindingChallenge ?? ((challenge: ReturnType<CloudConnectivityService["createChallenge"]>) => cloudConnectivityRuntime.publishBindingChallenge(challenge));
  const imagePullProgress = new ImagePullProgressProjector(events);
  const aiSessionUnread = new AiSessionUnreadStore(paths, {
    onChanged: (state) => queueMicrotask(() => events.publish(AiSessionUnreadEventType.Updated, state, {
      topic: "ai.sessions",
      scope: { instanceId: state.instanceId, sessionId: state.sessionId },
    })),
  });
  aiSessionUnread.init();
  const aiSessionAggregator = new ControlPlaneAiSessionAggregator({
    bootstrap: () => service.bootstrapAiSessionsFromInstances(),
    logger: diagnosticLogger,
    recoverDelta: (instanceId, streamId, sinceRevision) => service.recoverAiSessionDelta(instanceId, streamId, sinceRevision),
    recoverSnapshot: (instanceId) => service.recoverAiSessionSnapshot(instanceId),
    onRecoveredEvent: (event) => events.publish(event.type, event.payload),
  });
  const storySessionIndex = new StorySessionIndex();
  aiSessionAggregator.onSnapshot((update) => {
    aiSessionUnread.reconcile(update.instanceId, update.aiSessions);
    storySessionIndex.replaceInstance(update.instanceId, update.aiSessions);
  });
  const appSessionAggregator = new ControlPlaneAppSessionAggregator({
    bootstrap: () => service.bootstrapAppSessionsFromInstances(),
    logger: diagnosticLogger,
    recoverDelta: (instanceId, streamId, sinceRevision) => service.recoverAppSessionDelta(instanceId, streamId, sinceRevision),
    recoverSnapshot: (instanceId) => service.recoverAppSessionSnapshot(instanceId),
    onRecoveredEvent: (event) => events.publish(event.type, event.payload),
  });
  service.setAppSessionSnapshotProvider((options) => appSessionAggregator.list(options));
  service.setAiSessionSnapshotProvider((options) => aiSessionAggregator.list(options));
  const aiSessionAttachmentCache = new AiSessionAttachmentCache(paths.dataDir, {
    onWarning: (reason) => app.log.warn(reason),
  });
  events.on((event) => {
    imagePullProgress.handle(event);
    if (event.type === "instance.deleted" || event.type === "instance.updated") {
      const instanceId = event.payload && typeof event.payload === "object" && "instanceId" in event.payload
        ? String((event.payload as { instanceId?: unknown }).instanceId || "")
        : "";
      if (instanceId) {
        if (event.type === "instance.deleted") {
          appSessionAggregator.removeInstance(instanceId);
          aiSessionAggregator.removeInstance(instanceId);
          storySessionIndex.removeInstance(instanceId);
          aiSessionUnread.removeInstance(instanceId);
        }
        aiSessionAttachmentCache.removeInstance(instanceId);
      }
    }
  });
  const aiSessionAttachments = new AiSessionAttachmentStore();
  app.addHook("onClose", async () => {
    aiSessionAttachments.dispose();
  });
  const nodeAgentTunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    connectionRuntime: nodeConnectionRuntime,
    validateInstanceScope: (nodeId, instanceId) => service.nodeOwnsInstance(nodeId, instanceId),
    onInstanceLifecycle: (nodeId, lifecycle) => service.applyInstanceLifecycle(nodeId, lifecycle),
    onStreamsHello: (instanceId, hello) => {
      for (const descriptor of hello.streams) {
        if (descriptor.topic === "ai.sessions") aiSessionAggregator.advertiseStream(instanceId, descriptor);
        if (descriptor.topic === "app.sessions") appSessionAggregator.advertiseStream(instanceId, descriptor);
      }
    },
    onSessionEvent: (event) => event.type.startsWith("app-session.")
      ? appSessionAggregator.handleEvent(event)
      : aiSessionAggregator.handleEvent(event),
  });
  const explicitProxyOrigin = options.proxyOrigin || process.env.TASK_HANDOFF_CONTROL_PLANE_PROXY_ORIGIN;
  const projectProxyTarget = (nodeId: string) => {
    const node = service.nodes.get(nodeId);
    return node
      ? projectControlPlaneProxyTarget(node, nodeAgentTunnel.connected(node.id))
      : undefined;
  };
  const proxy = new ControlPlaneProxyService(
    new ControlPlaneProxyStore(paths.proxyAuthorityPath, (message, details) => app.log.warn(details, message)),
    {
      get: projectProxyTarget,
    },
    {
      proxyOrigin: explicitProxyOrigin,
      proxyOriginProvider: () => service.getSettings().publicBaseUrl,
    },
  );
  const proxyRuntime = new ControlPlaneNodeProxyRuntime();
  const proxyEventHub = new ControlPlaneProxyEventHub(events, {
    projectTarget: (targetNodeId) => {
      const target = projectProxyTarget(targetNodeId);
      return target ? publicControlPlaneProxyTarget(target) : undefined;
    },
  });
  const proxyStateSubscriber = new ControlPlaneProxyStateSubscriber(service, {
    fetchImpl: options.service?.fetchImpl,
    logger: diagnosticLogger,
    onStateChanged: (node) => events.publish(
      "node.proxy-state.updated",
      nodeStateProjection(node),
      { topic: "node.state", scope: { nodeId: node.id } },
    ),
  });
  events.on((event) => {
    if (event.type === "node.created" || event.type === "node.updated" || event.type === "node.deleted") {
      proxyStateSubscriber.syncNow();
    }
    if (event.type === "instance.created" || event.type === "instance.updated" || event.type === "instance.deleted") {
      const instanceId = event.payload && typeof event.payload === "object" && "instanceId" in event.payload
        ? String((event.payload as { instanceId?: unknown }).instanceId || "")
        : "";
      if (instanceId) nodeAgentTunnel.invalidateInstanceScope({ instanceId });
    }
    if (event.type === "node.deleted") {
      const nodeId = event.payload && typeof event.payload === "object" && "nodeId" in event.payload
        ? String((event.payload as { nodeId?: unknown }).nodeId || "")
        : "";
      if (nodeId) {
        nodeAgentTunnel.invalidateInstanceScope({ nodeId });
        const revoked = proxy.revokeTarget(nodeId);
        for (const binding of revoked.bindings) {
          proxyRuntime.closeBinding(binding.id, "Proxy target was deleted.");
          events.publish("control-plane-proxy.binding.updated", { binding }, { topic: "control-plane-proxy", scope: { nodeId } });
        }
      }
    }
  });
  service.setNodeAgentTransport(nodeAgentTunnel);
  await auth.init();
  service.init();
  diagnosticLogsEnabled = service.diagnosticLogsEnabled();
  identity.init();
  cloudConnectivity.init();
  if (cloudConnectivityEnabled) cloudConnectivityRuntime.start();
  let pairingRecoveryInFlight: Promise<void> | undefined;
  let pairingRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  let persistenceMaintenanceTimer: ReturnType<typeof setInterval> | undefined;
  const recoverPendingPairings = () => {
    if (pairingRecoveryInFlight) return pairingRecoveryInFlight;
    const recovery = service.recoverPendingPairingRevokes().then(() => undefined);
    pairingRecoveryInFlight = recovery;
    void recovery.then(() => {
      if (pairingRecoveryInFlight === recovery) pairingRecoveryInFlight = undefined;
    }, () => {
      if (pairingRecoveryInFlight === recovery) pairingRecoveryInFlight = undefined;
    });
    return recovery;
  };
  await recoverPendingPairings().catch((error) => app.log.warn({ error }, "pending node pairing recovery failed"));
  proxy.init();
  proxyStateSubscriber.start();
  await service.syncLocalNodeConnection().catch(() => undefined);
  const chatGateway = new ControlPlaneChatGatewayRuntime(service, options.service?.fetchImpl, {
    aiSessions: aiSessionAggregator,
    logger: diagnosticLogger,
    diagnosticLogsEnabled: () => diagnosticLogsEnabled,
  });
  chatGateway.startEnabled();
  const nodeEventSubscriber = new ControlPlaneNodeEventSubscriber(service, nodeAgentTunnel, {
    safetyIntervalMs: Number(process.env.TASK_HANDOFF_EVENT_CONNECTION_SAFETY_INTERVAL_MS) || undefined,
    logger: diagnosticLogger,
    connectionRuntime: nodeConnectionRuntime,
  });
  const stopAiSessionTransientDemand = events.onAiSessionTransientDemand((demand) => {
    nodeEventSubscriber.setAiSessionTransientDemand(demand);
  });
  nodeEventSubscriber.start();
  await app.register(cookie);
  await app.register(websocket, { options: TASK_HANDOFF_WEBSOCKET_SERVER_OPTIONS });
  app.addHook("onClose", async () => {
    await cloudConnectivityRuntime.stop();
    if (pairingRecoveryTimer) clearInterval(pairingRecoveryTimer);
    if (persistenceMaintenanceTimer) clearInterval(persistenceMaintenanceTimer);
    await pairingRecoveryInFlight?.catch(() => undefined);
    imagePullProgress.close();
    proxyEventHub.stop();
    proxyStateSubscriber.stop();
    nodeEventSubscriber.stop();
    stopAiSessionTransientDemand();
    chatGateway.stopAll();
    service.dispose();
    await auth.close();
  });

  app.setErrorHandler((error, request, reply) => {
    const payload = controlPlaneErrorPayload(error);
    if (payload.retryAfterSeconds !== undefined) {
      reply.header("retry-after", String(payload.retryAfterSeconds));
    }
    if (diagnosticLogsEnabled || payload.statusCode >= 500) {
      const log = payload.statusCode >= 500 ? app.log.error.bind(app.log) : app.log.warn.bind(app.log);
      log(
        {
          method: request.method,
          url: request.url,
          statusCode: payload.statusCode,
          errorCode: payload.code,
          error: payload.message,
        },
        "control plane request failed",
      );
    }
    reply.code(payload.statusCode).send(ControlPlaneHttpErrorResponseSchema.parse({
      error: {
        code: payload.code,
        message: payload.message,
        ...(payload.details ? { details: payload.details } : {}),
        ...(payload.retryable !== undefined ? { retryable: payload.retryable } : {}),
      },
    }));
  });

  app.addHook("preHandler", async (request, reply) => {
    // Fastify matches percent-decoded paths, while request.url retains the raw
    // client encoding. Security decisions must use the matched route template
    // so an encoded segment such as /%61pi cannot be mistaken for a public UI
    // path after Fastify has routed it to /api.
    const matchedRoute = request.routeOptions.url;
    const securityUrl = matchedRoute && matchedRoute !== "*" ? matchedRoute : request.url;
    const authBoundary = request.routeOptions.config.controlPlaneAuthBoundary;
    const internalActorToken = request.headers[CLOUD_INTERNAL_ACTOR_HEADER];
    const cloudActor = typeof internalActorToken === "string" ? cloudRelayActors.get(internalActorToken) : undefined;
    if (cloudActor) {
      cloudRelayActors.delete(internalActorToken as string);
      setControlPlaneRequestActor(request, cloudActor);
      const authorization = routeAuthorization(request.method, securityUrl);
      if (!authorization) throw Object.assign(new Error("Cloud access route is not authorized."), { code: "CLOUD_ROUTE_FORBIDDEN", statusCode: 403 });
      assertCan(cloudActor, authorization.action, authorization.resource);
      return;
    }
    // Machine routes opt out of UI sessions explicitly. Their handlers remain
    // responsible for binding credentials or paired node HMAC authentication.
    if (authBoundary === "proxy-binding" || authBoundary === "node-tunnel") {
      return;
    }
    const isPublicRoute = authBoundary === "public" || (authBoundary === "public-ui" && isPublicUiPath(request.url));
    if (!auth.enabled() || isPublicRoute) {
      const actor = await actorForRequest(auth, requestSessionCredential(request));
      setControlPlaneRequestActor(request, actor || disabledAuthActor());
      const authorization = routeAuthorization(request.method, securityUrl);
      if (authorization) {
        assertCan(actor || disabledAuthActor(), authorization.action, authorization.resource);
      }
      return;
    }
    const actor = await actorForRequest(auth, requestSessionCredential(request));
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "CONTROL_PLANE_AUTH_REQUIRED",
          message: "Sign in to access the Control Plane.",
        },
      });
    }
    setControlPlaneRequestActor(request, actor);
    if (actor.type === "user" && actor.requiresPasswordChange && securityUrl !== "/api/auth/password") {
      throw Object.assign(new Error("Change the temporary password before accessing the Control Plane."), {
        code: "AUTH_PASSWORD_CHANGE_REQUIRED",
        statusCode: 403,
      });
    }
    const authorization = routeAuthorization(request.method, securityUrl);
    if (authorization) {
      if (actor.type === "user") {
        assertCan(actor, authorization.action, authorization.resource);
        let scopes;
        try {
          scopes = await resolveRequestResourceScopes(service, request, securityUrl, authorization.resource, actor, authorization.action);
        } catch (error) {
          if (error && typeof error === "object" && (error as { statusCode?: number }).statusCode === 404) {
            throw Object.assign(new Error("The requested resource is not visible."), {
              statusCode: 404,
              code: "CONTROL_PLANE_RESOURCE_NOT_VISIBLE",
            });
          }
          throw error;
        }
        if (scopes?.length) {
          for (const scope of scopes) assertCanAccessResolvedResource(actor, authorization.action, authorization.resource, scope);
        }
      } else {
        assertCan(actor, authorization.action, authorization.resource);
      }
    }
  });

  const staticDir = path.resolve(options.staticDir || process.env.TASK_HANDOFF_CONTROL_PLANE_STATIC_DIR || defaultStaticDir());
  if (fs.existsSync(staticDir)) {
    app.get("/assets/*", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
      const assetPath = (request.params as { "*": string })["*"];
      return sendStaticFile(reply, staticDir, path.join("assets", assetPath || ""));
    });
    app.get("/favicon.ico", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (_request, reply) => {
      const favicon = staticFilePath(staticDir, "favicon.ico");
      return favicon ? sendStaticFile(reply, staticDir, "favicon.ico") : reply.code(204).send();
    });
  }

  app.get("/api/health", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async () => ControlPlaneHealthResponseSchema.parse({
    data: {
      ok: true,
      role: "control-plane",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      build: buildInfo(),
      serverTime: new Date().toISOString(),
    },
  }));

  app.get("/api/control-plane/identity", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async () => (
    identity.publicDocument(auth.enabled() ? "required" : "disabled")
  ));

  const requireCloudConnectivityAdmin = async (request: FastifyRequest) => {
    if (!cloudConnectivityEnabled) throw Object.assign(new Error("Cloud connectivity is disabled by feature flag."), { code: "CLOUD_CONNECTIVITY_DISABLED", statusCode: 503 });
    const actor = await actorForRequest(auth, requestSessionCredential(request)) || disabledAuthActor();
    assertCan(actor, "manage-settings", { type: "control-plane-settings" });
  };

  app.get("/api/cloud-connectivity", async (request) => {
    await requireCloudConnectivityAdmin(request);
    return { data: cloudConnectivity.snapshot() };
  });

  app.post("/api/cloud-connectivity/challenges", async (request, reply) => {
    await requireCloudConnectivityAdmin(request);
    reply.header("cache-control", "no-store");
    const challenge = cloudConnectivity.createChallenge();
    await publishCloudBindingChallenge(challenge);
    return { data: challenge };
  });

  app.post("/api/cloud-connectivity/remote-access", async (request) => {
    await requireCloudConnectivityAdmin(request);
    const input = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    return { data: cloudConnectivityLifecycle ? await cloudConnectivityLifecycle.setRemoteAccess(input.enabled) : cloudConnectivity.setRemoteAccess(input.enabled) };
  });

  app.post("/api/cloud-connectivity/disconnect", async (request) => {
    await requireCloudConnectivityAdmin(request);
    return { data: cloudConnectivityLifecycle ? await cloudConnectivityLifecycle.disconnect() : cloudConnectivity.beginRevocation() };
  });

  app.get("/api/session-streams/diagnostics", async () => ({
    data: {
      aiSessions: aiSessionAggregator.diagnostics(),
      aiSessionActions: service.aiSessionActionDiagnostics(),
      appSessions: appSessionAggregator.diagnostics(),
      nodeConnections: {
        ...nodeEventSubscriber.diagnostics(),
        runtime: nodeConnectionRuntime.diagnostics(),
      },
      eventAuthorization: events.authorizationDiagnostics(),
      browserRelay: browserAccess.diagnostics(),
    },
  }));

  app.get("/install-node-agent.sh", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.type("text/x-shellscript; charset=utf-8");
    return nodeAgentInstallScript();
  });

  app.get("/api/events", { websocket: true }, async (socket, request) => {
    const eventQuery = request.query as { aiSessionTransient?: string; resourceMetricsScope?: string; instanceId?: string };
    const eventInstanceId = typeof eventQuery.instanceId === "string" ? eventQuery.instanceId.trim() : "";
    const actor = controlPlaneRequestActor(request);
    const visibleInstances = actor?.type === "user"
      ? (await service.listControlledInstances()).filter((instance) => instanceScopeAllows(actor.nodeScope, actor.instanceScope, instance.id, instance.nodeId))
      : undefined;
    const visibleInstanceIds = visibleInstances ? new Set(visibleInstances.map((instance) => instance.id)) : undefined;
    if (eventInstanceId && visibleInstanceIds && !visibleInstanceIds.has(eventInstanceId)) {
      socket.close(4003, "The requested event scope is not visible.");
      return;
    }
    const pendingFrames: string[] = [];
    let handshakeSent = false;
    const gatedSocket = {
      get readyState() { return socket.readyState; },
      get bufferedAmount() { return socket.bufferedAmount; },
      OPEN: socket.OPEN,
      send(value: string) {
        if (handshakeSent) socket.send(value);
        else pendingFrames.push(value);
      },
      ping() {
        socket.ping();
      },
      on(event: "close" | "message", listener: (value?: unknown) => void) {
        socket.on(event, listener);
      },
      close(code?: number, reason?: string) {
        socket.close(code, reason);
      },
    };
    events.connect(gatedSocket, {
      instanceIds: eventInstanceId ? [eventInstanceId] : undefined,
      expectsTransientSubscription: eventQuery.aiSessionTransient === "1",
      expectsMetricSubscription: eventQuery.resourceMetricsScope === "1",
      ...(actor?.type === "user" ? {
        authorization: {
          userId: actor.userId,
          authorizationRevision: actor.authorizationRevision,
          permissionIds: actor.permissionIds,
          ...(actor.nodeScope.kind === "selected" ? {
            allowedNodeIds: new Set(actor.nodeScope.nodeIds),
          } : {}),
          ...((actor.instanceScope?.kind === "selected" || actor.nodeScope.kind === "selected") ? {
            allowedInstanceIds: visibleInstanceIds,
          } : {}),
        },
      } : {}),
    });
    const [aiStreams, appStreams] = await Promise.all([
      aiSessionAggregator.streamDescriptors(),
      appSessionAggregator.streamDescriptors(),
    ]);
    events.send(socket, SessionStreamsHelloEventType, {
      protocolVersion: SESSION_STREAM_PROTOCOL_VERSION,
      streams: [...aiStreams, ...appStreams].filter((stream) => (
        (!visibleInstanceIds || visibleInstanceIds.has(stream.instanceId))
        && (!eventInstanceId || stream.instanceId === eventInstanceId)
      )),
    });
    handshakeSent = true;
    for (const frame of pendingFrames) socket.send(frame);
    for (const snapshot of imagePullProgress.snapshots().filter((entry) => (
      (!visibleInstanceIds || visibleInstanceIds.has(entry.instanceId))
      && (!eventInstanceId || entry.instanceId === eventInstanceId)
    ))) {
      events.send(socket, ImagePullTerminalEventType.Snapshot, snapshot, {
        topic: "instances",
        scope: { instanceId: snapshot.instanceId },
      });
    }
  });

  app.get("/api/auth/session", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request) => {
    const credential = requestSessionCredential(request);
    return { data: await auth.currentSession(credential.token, credential.clientType) };
  });
  app.post("/api/auth/bootstrap-admin", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
    const user = await auth.bootstrapAdmin(request.body);
    return reply.code(201).send({ data: user });
  });
  app.post("/api/auth/login", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
    const result = await auth.login(request.body, { sourceId: request.ip });
    reply.setCookie(CONTROL_PLANE_SESSION_COOKIE, result.sessionToken, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      expires: new Date(result.expiresAt),
    });
    return { data: { user: result.user } };
  });
  app.post("/api/auth/mobile/login", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request) => ({
    data: await auth.loginMobile(request.body, { sourceId: request.ip }),
  }));
  app.patch("/api/auth/password", async (request, reply) => {
    const result = await auth.changePassword(request.cookies[CONTROL_PLANE_SESSION_COOKIE], request.body);
    reply.setCookie(CONTROL_PLANE_SESSION_COOKIE, result.sessionToken, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      expires: new Date(result.expiresAt),
    });
    return { data: { user: result.user } };
  });
  app.post("/api/auth/mobile/logout", async (request) => {
    const credential = requestSessionCredential(request);
    return { data: await auth.logout(credential.clientType === "mobile" ? credential.token : undefined) };
  });
  app.get("/api/auth/mobile/sessions", async (request, reply) => {
    const sessions = await auth.mobileSessions(requestSessionCredential(request).token);
    return sessions ? { data: sessions } : reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to access mobile sessions." },
    });
  });
  app.delete("/api/auth/mobile/sessions/:id", async (request, reply) => {
    const params = z.object({ id: z.string().trim().min(1) }).parse(request.params);
    const revoked = await auth.revokeMobileSession(requestSessionCredential(request).token, params.id);
    return revoked === undefined ? reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to revoke mobile sessions." },
    }) : { data: { revoked } };
  });
  app.post("/api/auth/logout", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
    const result = await auth.logout(request.cookies[CONTROL_PLANE_SESSION_COOKIE]);
    reply.clearCookie(CONTROL_PLANE_SESSION_COOKIE, { path: "/" });
    return { data: result };
  });

  app.get("/api/access/me", async (request, reply) => {
    const credential = requestSessionCredential(request);
    const access = await auth.currentAccess(credential.token, credential.clientType);
    return access ? { data: access } : reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to read Control Plane access." },
    });
  });

  registerControlPlaneUserRoutes(app, auth);
  registerControlPlaneGitCredentialRoutes(app, service);

  app.get("/api/control-plane/status", async () => ({
    data: {
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      build: buildInfo(),
      storage: paths,
    },
  }));
  app.get("/api/control-plane/settings", async () => ({ data: service.getSettings() }));
  app.patch("/api/control-plane/settings", async (request) => {
    const settings = service.updateSettings(request.body || {});
    diagnosticLogsEnabled = settings.diagnosticLogs;
    return { data: settings };
  });
  app.get("/api/control-plane/diagnostic-logs/export", async (_request, reply) => {
    const archive = await createDiagnosticLogsArchive({
      dataDir: paths.dataDir,
      nodeAgentDataDir: process.env.TASK_HANDOFF_DESKTOP_NODE_AGENT_DATA_DIR || process.env.TASK_HANDOFF_NODE_AGENT_DATA_DIR,
      diagnosticLogsEnabled,
    });
    reply.header("content-type", "application/gzip");
    reply.header("content-disposition", `attachment; filename="${archive.filename}"`);
    return reply.send(archive.stream);
  });

  app.post("/api/ai-session-attachments", { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    try {
      return reply.code(201).send({ data: aiSessionAttachments.upload(request.body) });
    } catch (error) {
      return reply.code(400).send({
        error: {
          code: "AI_SESSION_ATTACHMENT_INVALID",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  registerControlPlaneManagementRoutes({
    app,
    service,
    events,
    appSessionAggregator,
    aiSessionAggregator,
    aiSessionUnread,
    chatGateway,
    aiSessionAttachments,
    aiSessionAttachmentCache,
    nodeAgentTunnel,
    nodeEventSubscriber,
    errorPayload: controlPlaneErrorPayload,
    onInstanceDeleted: async (instanceId) => {
      if (!auth.enabled()) return;
      const affectedUserIds = await auth.users.removeInstanceFromAccessScopes(instanceId);
      for (const userId of affectedUserIds) await auth.notifyAuthorizationChanged(userId);
    },
  });

  registerNodeProxyRoutes({
    app,
    authority: proxy,
    resolveTarget: (targetNodeId) => {
      const node = service.requireNode(targetNodeId);
      return { node, transport: service.resolveNodeAgentTransport(node) };
    },
    projectTarget: projectProxyTarget,
    runtime: proxyRuntime,
    eventHub: proxyEventHub,
    onBindingRevoked: (binding) => events.publish("control-plane-proxy.binding.updated", {
      binding,
      audit: { action: "binding.revoke", actor: `control-plane:${binding.sourceControlPlaneId}` },
    }, { topic: "control-plane-proxy", scope: { nodeId: binding.targetNodeId } }),
  });
  registerControlPlaneProxyManagementRoutes({
    app,
    service,
    proxy,
    runtime: proxyRuntime,
    events,
    syncNodeEvents: () => nodeEventSubscriber.syncNow(),
    actorId: async (request) => {
      const actor = await actorForRequest(auth, requestSessionCredential(request));
      if (!actor) return "system:unknown";
      if (actor.type === "user") return `user:${actor.userId}`;
      if (actor.type === "system") return `system:${actor.reason}`;
      if (actor.type === "cloud-account") return `cloud-account:${actor.accountId}:${actor.deviceSessionId}`;
      return `chat-bridge:${actor.bridgeId}`;
    },
  });

  registerInstanceProxyRoutes({ app, service, auth, authorizationConnections });
  registerBrowserRelayRoutes({ app, service, auth, authorizationConnections, events, browserAccess });

  app.get("*", { config: PUBLIC_CONTROL_PLANE_UI_ROUTE }, async (_request, reply) =>
    fs.existsSync(staticDir)
      ? sendStaticFile(reply, staticDir, "index.html")
      : reply.code(404).send({
          error: {
            code: "CONTROL_PLANE_UI_NOT_BUILT",
            message: "Control plane API is running, but the Web UI static directory was not found.",
          },
        }),
  );

  pairingRecoveryTimer = setInterval(() => {
    void recoverPendingPairings().catch((error) => app.log.warn({ error }, "pending node pairing recovery failed"));
  }, 30_000);
  pairingRecoveryTimer.unref();
  persistenceMaintenanceTimer = setInterval(() => {
    service.runPersistenceMaintenance();
  }, DEFAULT_MAINTENANCE_INTERVAL_MS);
  persistenceMaintenanceTimer.unref();
  return app;
}

export async function runControlPlaneServer(options: RunControlPlaneServerOptions) {
  const paths = controlPlaneStorePaths(options.dataDir);
  const lock = acquireControlPlaneSingletonLock(defaultControlPlaneSingletonLockPath(), {
    dataDir: paths.dataDir,
    host: options.host,
    port: options.port,
  });
  try {
    const app = await createControlPlaneApp(options);
    app.addHook("onClose", async () => {
      lock.release();
    });
    await app.listen({ host: options.host, port: options.port });
  } catch (error) {
    lock.release();
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw Object.assign(
        new Error(`Control plane port ${options.host}:${options.port} is already in use.`),
        { statusCode: 409, code: "CONTROL_PLANE_PORT_IN_USE", cause: error },
      );
    }
    throw error;
  }
}
