import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyServerOptions } from "fastify";
import { z } from "zod";
import { AiSessionUnreadEventType } from "@task-handoff/protocol/ai-sessions";
import { CONTROL_PLANE_PROTOCOL_VERSION, ImagePullTerminalEventType, type BuildInfo } from "@task-handoff/protocol/control-plane";
import { packageVersionResolver } from "@task-handoff/core/core/package-version";
import { SESSION_STREAM_PROTOCOL_VERSION, SessionStreamsHelloEventType } from "@task-handoff/protocol/events";
import { CONTROL_PLANE_SESSION_COOKIE, ControlPlaneAuth, type ControlPlaneAuthOptions } from "../auth/service.ts";
import { ControlPlaneService, type ControlPlaneServiceOptions } from "../application/service.ts";
import { ControlPlaneChatGatewayRuntime } from "../chat/gateway/runtime.ts";
import { ControlPlaneEventBus } from "../events/bus.ts";
import { AiSessionAttachmentStore } from "../sessions/ai-session-attachments.ts";
import { ControlPlaneNodeAgentTunnelTransport, ControlPlaneNodeEventSubscriber } from "../nodes/tunnel.ts";
import { controlPlaneStorePaths } from "../persistence/paths.ts";
import { acquireControlPlaneSingletonLock, defaultControlPlaneSingletonLockPath } from "../process/singleton-lock.ts";
import { assertCan, type ControlPlaneAction, type ControlPlaneActor, type ControlPlaneResource } from "../auth/authorization.ts";
import { registerControlPlaneManagementRoutes } from "./management-routes.ts";
import { registerInstanceProxyRoutes } from "./instance-proxy-routes.ts";
import { ControlPlaneAiSessionAggregator } from "../sessions/ai-session-aggregator.ts";
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
import { projectControlPlaneProxyTarget, publicControlPlaneProxyTarget } from "../proxy/target-projector.ts";
import { ControlPlaneIdentityService } from "../identity/service.ts";

export type CreateControlPlaneAppOptions = {
  dataDir?: string;
  staticDir?: string;
  logger?: FastifyServerOptions["logger"];
  service?: ControlPlaneServiceOptions;
  auth?: ControlPlaneAuthOptions;
  proxyOrigin?: string;
};

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

function defaultStaticDir() {
  return path.resolve(process.cwd(), "packages", "control-plane-ui", "dist");
}

function envFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function controlPlaneDiagnosticLogsEnabled() {
  return envFlag(process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS);
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
  const user = credential.clientType === "mobile"
    ? await auth.userForMobileSessionToken(credential.token)
    : await auth.userForSessionToken(credential.token);
  return user ? { type: "user" as const, userId: user.id, role: user.role } : undefined;
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
  if (path.startsWith("/api/control-plane/settings")) {
    return { action: method === "GET" ? "read" : "manage-settings", resource: { type: "control-plane-settings" } };
  }
  if (path === "/api/auth/mobile/logout" || path.startsWith("/api/auth/mobile/sessions")) {
    return undefined;
  }
  if (path.startsWith("/api/models")) {
    return { action: method === "GET" ? "read" : "manage-secrets", resource: { type: "model" } };
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
    if (/\/apps\/sessions\/[^/]+\/access$/.test(path)) return { action: "read", resource: { type: "instance" } };
    if (path.includes("/ai-sessions")) {
      if (path.includes("/triggers")) return { action, resource: { type: "trigger" } };
      if (method === "POST" && /\/ai-sessions$/.test(path)) return { action: "send-message", resource: { type: "ai-session" } };
      if (path.endsWith("/approval")) return { action: "approve", resource: { type: "ai-session" } };
      if (path.endsWith("/interrupt")) return { action: "interrupt", resource: { type: "ai-session" } };
      if (path.endsWith("/resume") || path.endsWith("/commands") || path.includes("/messages") || path.includes("/queue/")) {
        return { action: "send-message", resource: { type: "ai-session" } };
      }
      if (path.endsWith("/read") || path.endsWith("/mentions/files")) {
        return { action: "read", resource: { type: "ai-session" } };
      }
      return { action, resource: { type: "ai-session" } };
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
    return { action, resource: { type: "runtime" } };
  }
  if (path.startsWith("/api/triggers")) {
    return { action, resource: { type: "trigger" } };
  }
  // Unknown read routes remain visible to viewer roles. Unknown mutations are
  // fail-closed for non-admin actors instead of silently degrading to read.
  return { action, resource: { type: "control-plane-settings" } };
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
  const service = new ControlPlaneService(paths, { ...options.service, logger: app.log });
  const auth = new ControlPlaneAuth(paths, options.auth);
  const identity = new ControlPlaneIdentityService(
    paths.identitySigningPath,
    () => service.proxyPrivateStore.controlPlaneId(),
    (message, details) => app.log.warn(details, message),
  );
  const events = new ControlPlaneEventBus();
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
    logger: app.log,
    recoverDelta: (instanceId, streamId, sinceRevision) => service.recoverAiSessionDelta(instanceId, streamId, sinceRevision),
    recoverSnapshot: (instanceId) => service.recoverAiSessionSnapshot(instanceId),
    onRecoveredEvent: (event) => events.publish(event.type, event.payload),
  });
  aiSessionAggregator.onSnapshot((update) => aiSessionUnread.reconcile(update.instanceId, update.aiSessions));
  const appSessionAggregator = new ControlPlaneAppSessionAggregator({
    bootstrap: () => service.bootstrapAppSessionsFromInstances(),
    logger: app.log,
    recoverDelta: (instanceId, streamId, sinceRevision) => service.recoverAppSessionDelta(instanceId, streamId, sinceRevision),
    recoverSnapshot: (instanceId) => service.recoverAppSessionSnapshot(instanceId),
    onRecoveredEvent: (event) => events.publish(event.type, event.payload),
  });
  service.setAppSessionSnapshotProvider((options) => appSessionAggregator.list(options));
  service.setAiSessionSnapshotProvider((options) => aiSessionAggregator.list(options));
  events.on((event) => {
    imagePullProgress.handle(event);
    if (event.type === "instance.deleted") {
      const instanceId = event.payload && typeof event.payload === "object" && "instanceId" in event.payload
        ? String((event.payload as { instanceId?: unknown }).instanceId || "")
        : "";
      if (instanceId) {
        appSessionAggregator.removeInstance(instanceId);
        aiSessionAggregator.removeInstance(instanceId);
        aiSessionUnread.removeInstance(instanceId);
      }
    }
  });
  const aiSessionAttachments = new AiSessionAttachmentStore();
  app.addHook("onClose", async () => {
    aiSessionAttachments.dispose();
  });
  const nodeAgentTunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: (nodeId, instanceId) => service.nodeOwnsInstance(nodeId, instanceId),
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
    logger: app.log,
    onStateChanged: (node) => events.publish(
      "node.proxy-state.updated",
      { nodeId: node.id, proxyState: node.proxyState },
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
  service.init();
  identity.init();
  let pairingRecoveryInFlight: Promise<void> | undefined;
  let pairingRecoveryTimer: ReturnType<typeof setInterval> | undefined;
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
  auth.init();
  const chatGateway = new ControlPlaneChatGatewayRuntime(service, options.service?.fetchImpl, { aiSessions: aiSessionAggregator, logger: app.log });
  chatGateway.startEnabled();
  const nodeEventSubscriber = new ControlPlaneNodeEventSubscriber(service, nodeAgentTunnel, { safetyIntervalMs: Number(process.env.TASK_HANDOFF_EVENT_CONNECTION_SAFETY_INTERVAL_MS) || undefined, logger: app.log });
  nodeEventSubscriber.start();
  await app.register(cookie);
  await app.register(websocket);
  app.addHook("onClose", async () => {
    if (pairingRecoveryTimer) clearInterval(pairingRecoveryTimer);
    await pairingRecoveryInFlight?.catch(() => undefined);
    imagePullProgress.close();
    proxyEventHub.stop();
    proxyStateSubscriber.stop();
    nodeEventSubscriber.stop();
    chatGateway.stopAll();
  });

  const diagnosticLogsEnabled = controlPlaneDiagnosticLogsEnabled();

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
    // Machine routes opt out of UI sessions explicitly. Their handlers remain
    // responsible for binding credentials or paired node HMAC authentication.
    if (authBoundary === "proxy-binding" || authBoundary === "node-tunnel") {
      return;
    }
    const isPublicRoute = authBoundary === "public" || (authBoundary === "public-ui" && isPublicUiPath(request.url));
    if (!auth.enabled() || isPublicRoute) {
      const actor = await actorForRequest(auth, requestSessionCredential(request));
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
    const authorization = routeAuthorization(request.method, securityUrl);
    if (authorization) {
      assertCan(actor, authorization.action, authorization.resource);
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

  app.get("/api/health", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async () => ({
    data: {
      ok: true,
      role: "control-plane",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      build: buildInfo(),
      dataDir: paths.dataDir,
      serverTime: new Date().toISOString(),
    },
  }));

  app.get("/api/control-plane/identity", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async () => (
    identity.publicDocument(auth.enabled() ? "required" : "disabled")
  ));

  app.get("/api/session-streams/diagnostics", async () => ({
    data: {
      aiSessions: aiSessionAggregator.diagnostics(),
      aiSessionActions: service.aiSessionActionDiagnostics(),
      appSessions: appSessionAggregator.diagnostics(),
      nodeConnections: nodeEventSubscriber.diagnostics(),
    },
  }));

  app.get("/install-node-agent.sh", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.type("text/x-shellscript; charset=utf-8");
    return nodeAgentInstallScript();
  });

  app.get("/api/events", { websocket: true }, async (socket) => {
    const pendingFrames: string[] = [];
    let handshakeSent = false;
    const gatedSocket = {
      get readyState() { return socket.readyState; },
      OPEN: socket.OPEN,
      send(value: string) {
        if (handshakeSent) socket.send(value);
        else pendingFrames.push(value);
      },
      on(event: "close" | "message", listener: (value?: unknown) => void) {
        socket.on(event, listener);
      },
    };
    events.connect(gatedSocket);
    const [aiStreams, appStreams] = await Promise.all([
      aiSessionAggregator.streamDescriptors(),
      appSessionAggregator.streamDescriptors(),
    ]);
    events.send(socket, SessionStreamsHelloEventType, {
      protocolVersion: SESSION_STREAM_PROTOCOL_VERSION,
      streams: [...aiStreams, ...appStreams],
    });
    handshakeSent = true;
    for (const frame of pendingFrames) socket.send(frame);
    for (const snapshot of imagePullProgress.snapshots()) {
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
  app.post("/api/auth/mobile/logout", async (request) => {
    const credential = requestSessionCredential(request);
    return { data: auth.logout(credential.clientType === "mobile" ? credential.token : undefined) };
  });
  app.get("/api/auth/mobile/sessions", async (request, reply) => {
    const sessions = auth.mobileSessions(requestSessionCredential(request).token);
    return sessions ? { data: sessions } : reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to access mobile sessions." },
    });
  });
  app.delete("/api/auth/mobile/sessions/:id", async (request, reply) => {
    const params = z.object({ id: z.string().trim().min(1) }).parse(request.params);
    const revoked = auth.revokeMobileSession(requestSessionCredential(request).token, params.id);
    return revoked === undefined ? reply.code(401).send({
      error: { code: "CONTROL_PLANE_AUTH_REQUIRED", message: "Sign in to revoke mobile sessions." },
    }) : { data: { revoked } };
  });
  app.post("/api/auth/logout", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
    const result = auth.logout(request.cookies[CONTROL_PLANE_SESSION_COOKIE]);
    reply.clearCookie(CONTROL_PLANE_SESSION_COOKIE, { path: "/" });
    return { data: result };
  });

  app.get("/api/control-plane/status", async () => ({
    data: {
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      build: buildInfo(),
      storage: paths,
    },
  }));
  app.get("/api/control-plane/settings", async () => ({ data: service.getSettings() }));
  app.patch("/api/control-plane/settings", async (request) => ({ data: service.updateSettings(request.body || {}) }));

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
    nodeAgentTunnel,
    nodeEventSubscriber,
    errorPayload: controlPlaneErrorPayload,
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
    actorId: async (request) => {
      const actor = await actorForRequest(auth, requestSessionCredential(request));
      if (!actor) return "system:unknown";
      if (actor.type === "user") return `user:${actor.userId}`;
      if (actor.type === "system") return `system:${actor.reason}`;
      return `chat-bridge:${actor.bridgeId}`;
    },
  });

  registerInstanceProxyRoutes({ app, service });

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
