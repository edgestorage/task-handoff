import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import type { FastifyReply } from "fastify";
import type { FastifyServerOptions } from "fastify";
import { z } from "zod";
import { CONTROL_PLANE_PROTOCOL_VERSION, type BuildInfo } from "@task-handoff/protocol/control-plane";
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
import { ControlPlaneAppSessionAggregator } from "../sessions/app-session-aggregator.ts";
import { nodeAgentInstallScript } from "../nodes/install-script.ts";

export type CreateControlPlaneAppOptions = {
  dataDir?: string;
  staticDir?: string;
  logger?: FastifyServerOptions["logger"];
  service?: ControlPlaneServiceOptions;
  auth?: ControlPlaneAuthOptions;
};

export type RunControlPlaneServerOptions = CreateControlPlaneAppOptions & {
  host: string;
  port: number;
};

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

function packageVersion() {
  try {
    const moduleDir = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : __dirname;
    const packagePath = [
      // Runtime releases bundle this module into <package>/dist/cli.js.
      path.resolve(moduleDir, "..", "package.json"),
      // Node's strip-only TypeScript loader executes this source in place.
      path.resolve(moduleDir, "..", "..", "..", "package.json"),
    ].find((candidate) => fs.existsSync(candidate));
    if (!packagePath) return "unknown";
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

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

function errorPayload(error: unknown) {
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
  };
}

function isPublicControlPlaneRoute(method: string, url: string) {
  const path = url.split("?")[0];
  if (path === "/api/health" || path.startsWith("/api/auth/")) return true;
  if (method === "GET" && path === "/install-node-agent.sh") return true;
  if (method === "POST" && path === "/api/node-join/complete") return true;
  if (path === "/api/app-access/session") return true;
  if (path.startsWith("/apps/access/")) return true;
  if (path === "/favicon.ico" || path.startsWith("/assets/")) return true;
  if (method === "GET" && !path.startsWith("/api/") && !path.startsWith("/instances/")) return true;
  return false;
}

function disabledAuthActor(): ControlPlaneActor {
  return { type: "system", reason: "auth-disabled" };
}

async function actorForRequest(auth: ControlPlaneAuth, sessionToken: string | undefined) {
  if (!auth.enabled()) {
    return disabledAuthActor();
  }
  const user = await auth.userForSessionToken(sessionToken);
  return user ? { type: "user" as const, userId: user.id, role: user.role } : undefined;
}

function routeAuthorization(method: string, url: string): { action: ControlPlaneAction; resource: ControlPlaneResource } | undefined {
  const path = url.split("?")[0] || "/";
  if (!path.startsWith("/api/")) {
    return undefined;
  }
  if (path.startsWith("/api/auth/") || path === "/api/health" || path === "/api/events") {
    return undefined;
  }
  const action = actionForHttpMethod(method);
  if (path.startsWith("/api/control-plane/settings")) {
    return { action: method === "GET" ? "read" : "manage-settings", resource: { type: "control-plane-settings" } };
  }
  if (path.startsWith("/api/models")) {
    return { action: method === "GET" ? "read" : "manage-secrets", resource: { type: "model" } };
  }
  if (path.startsWith("/api/chat-gateway/bridges")) {
    return { action: method === "GET" ? "read" : "manage-secrets", resource: { type: "chat-bridge" } };
  }
  if (path === "/api/node-join/invites") {
    return { action: "manage-node-auth", resource: { type: "node" } };
  }
  if (path.startsWith("/api/nodes")) {
    if (/\/(runtimes|local-folders)(\/|$)/.test(path)) {
      return { action, resource: { type: "runtime" } };
    }
    return { action: method === "GET" ? "read" : "manage-node-auth", resource: { type: "node" } };
  }
  if (path.startsWith("/api/controlled-instances")) {
    if (path.includes("/ai-sessions/")) {
      if (path.endsWith("/approval")) return { action: "approve", resource: { type: "ai-session" } };
      if (path.endsWith("/interrupt")) return { action: "interrupt", resource: { type: "ai-session" } };
      if (path.includes("/messages") || path.includes("/queue/")) return { action: "send-message", resource: { type: "ai-session" } };
      return { action: "read", resource: { type: "ai-session" } };
    }
    if (path.includes("/start")) return { action: "start", resource: { type: "instance" } };
    if (path.includes("/stop")) return { action: "stop", resource: { type: "instance" } };
    if (path.includes("/restart")) return { action: "restart", resource: { type: "instance" } };
    if (path.includes("/config-sync/")) return { action: "update", resource: { type: "instance" } };
    return { action, resource: { type: "instance" } };
  }
  if (path.startsWith("/api/projects")) {
    return { action, resource: { type: "project" } };
  }
  if (path.startsWith("/api/images")) {
    return { action, resource: { type: "runtime" } };
  }
  if (path.startsWith("/api/triggers")) {
    return { action, resource: { type: "trigger" } };
  }
  return { action: "read", resource: { type: "control-plane-settings" } };
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
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 64 * 1024 * 1024 });
  const service = new ControlPlaneService(paths, { ...options.service, logger: app.log });
  const auth = new ControlPlaneAuth(paths, options.auth);
  const events = new ControlPlaneEventBus();
  const aiSessionAggregator = new ControlPlaneAiSessionAggregator({
    bootstrap: () => service.bootstrapAiSessionsFromInstances(),
    logger: app.log,
    recoverDelta: (instanceId, streamId, sinceRevision) => service.recoverAiSessionDelta(instanceId, streamId, sinceRevision),
    recoverSnapshot: (instanceId) => service.recoverAiSessionSnapshot(instanceId),
    onRecoveredEvent: (event) => events.publish(event.type, event.payload),
  });
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
    if (event.type === "instance.deleted") {
      const instanceId = event.payload && typeof event.payload === "object" && "instanceId" in event.payload
        ? String((event.payload as { instanceId?: unknown }).instanceId || "")
        : "";
      if (instanceId) {
        appSessionAggregator.removeInstance(instanceId);
        aiSessionAggregator.removeInstance(instanceId);
      }
    }
    appSessionAggregator.handleEvent(event);
    aiSessionAggregator.handleEvent(event);
  });
  const aiSessionAttachments = new AiSessionAttachmentStore();
  const nodeAgentTunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    onStreamsHello: (instanceId, hello) => {
      for (const descriptor of hello.streams) {
        if (descriptor.topic === "ai.sessions") aiSessionAggregator.advertiseStream(instanceId, descriptor);
        if (descriptor.topic === "app.sessions") appSessionAggregator.advertiseStream(instanceId, descriptor);
      }
    },
  });
  service.setNodeAgentTransport(nodeAgentTunnel);
  service.init();
  await service.syncLocalNodeConnection().catch(() => undefined);
  auth.init();
  const chatGateway = new ControlPlaneChatGatewayRuntime(service, options.service?.fetchImpl, { aiSessions: aiSessionAggregator, logger: app.log });
  chatGateway.startEnabled();
  const nodeEventSubscriber = new ControlPlaneNodeEventSubscriber(service, nodeAgentTunnel, { safetyIntervalMs: Number(process.env.TASK_HANDOFF_EVENT_CONNECTION_SAFETY_INTERVAL_MS) || undefined, logger: app.log });
  nodeEventSubscriber.start();
  await app.register(cookie);
  await app.register(websocket);
  app.addHook("onClose", async () => {
    nodeEventSubscriber.stop();
    chatGateway.stopAll();
  });

  const diagnosticLogsEnabled = controlPlaneDiagnosticLogsEnabled();

  app.setErrorHandler((error, request, reply) => {
    const payload = errorPayload(error);
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
    reply.code(payload.statusCode).send({
      error: {
        code: payload.code,
        message: payload.message,
      },
    });
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!auth.enabled() || isPublicControlPlaneRoute(request.method, request.url)) {
      const actor = await actorForRequest(auth, request.cookies[CONTROL_PLANE_SESSION_COOKIE]);
      const authorization = routeAuthorization(request.method, request.url);
      if (authorization) {
        assertCan(actor || disabledAuthActor(), authorization.action, authorization.resource);
      }
      return;
    }
    const actor = await actorForRequest(auth, request.cookies[CONTROL_PLANE_SESSION_COOKIE]);
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "CONTROL_PLANE_AUTH_REQUIRED",
          message: "Sign in to access the Control Plane.",
        },
      });
    }
    const authorization = routeAuthorization(request.method, request.url);
    if (authorization) {
      assertCan(actor, authorization.action, authorization.resource);
    }
  });

  const staticDir = path.resolve(options.staticDir || process.env.TASK_HANDOFF_CONTROL_PLANE_STATIC_DIR || defaultStaticDir());
  if (fs.existsSync(staticDir)) {
    app.get("/assets/*", async (request, reply) => {
      const assetPath = (request.params as { "*": string })["*"];
      return sendStaticFile(reply, staticDir, path.join("assets", assetPath || ""));
    });
    app.get("/favicon.ico", async (_request, reply) => {
      const favicon = staticFilePath(staticDir, "favicon.ico");
      return favicon ? sendStaticFile(reply, staticDir, "favicon.ico") : reply.code(204).send();
    });
  }

  app.get("/api/health", async () => ({
    data: {
      ok: true,
      role: "control-plane",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      build: buildInfo(),
      dataDir: paths.dataDir,
      serverTime: new Date().toISOString(),
    },
  }));

  app.get("/api/session-streams/diagnostics", async () => ({
    data: {
      aiSessions: aiSessionAggregator.diagnostics(),
      appSessions: appSessionAggregator.diagnostics(),
      nodeConnections: nodeEventSubscriber.diagnostics(),
    },
  }));

  app.get("/install-node-agent.sh", async (_request, reply) => {
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
  });

  app.get("/api/auth/session", async (request) => ({ data: await auth.currentSession(request.cookies[CONTROL_PLANE_SESSION_COOKIE]) }));
  app.post("/api/auth/bootstrap-admin", async (request, reply) => {
    const user = await auth.bootstrapAdmin(request.body);
    return reply.code(201).send({ data: user });
  });
  app.post("/api/auth/login", async (request, reply) => {
    const result = await auth.login(request.body);
    reply.setCookie(CONTROL_PLANE_SESSION_COOKIE, result.sessionToken, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      expires: new Date(result.expiresAt),
    });
    return { data: { user: result.user } };
  });
  app.post("/api/auth/logout", async (request, reply) => {
    const result = auth.logout(request.cookies[CONTROL_PLANE_SESSION_COOKIE]);
    reply.clearCookie(CONTROL_PLANE_SESSION_COOKIE, { path: "/" });
    return { data: result };
  });

  app.get("/api/control-plane/status", async () => ({
    data: {
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      build: buildInfo(),
      storage: paths,
      counts: {
        projects: service.listProjects().length,
        models: service.listModels().length,
        images: service.listImages().length,
        nodes: service.listNodes().length,
        nodeRuntimes: (await service.listNodeRuntimes()).length,
        controlledInstances: (await service.listControlledInstances()).length,
        chatSessions: service.listChatSessions().length,
      },
    },
  }));
  app.get("/api/control-plane/settings", async () => ({ data: service.getSettings() }));
  app.patch("/api/control-plane/settings", async (request) => ({ data: service.updateSettings(request.body || {}) }));

  app.post("/api/ai-session-attachments", async (request, reply) => {
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
    chatGateway,
    aiSessionAttachments,
    nodeAgentTunnel,
    nodeEventSubscriber,
    errorPayload,
  });

  registerInstanceProxyRoutes({ app, service });

  app.get("*", async (_request, reply) =>
    fs.existsSync(staticDir)
      ? sendStaticFile(reply, staticDir, "index.html")
      : reply.code(404).send({
          error: {
            code: "CONTROL_PLANE_UI_NOT_BUILT",
            message: "Control plane API is running, but the Web UI static directory was not found.",
          },
        }),
  );

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
    throw error;
  }
}
