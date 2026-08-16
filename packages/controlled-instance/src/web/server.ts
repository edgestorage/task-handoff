import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyServerOptions } from "fastify";
import { proxyFetch } from "httpxy";
import { z } from "zod";
import { appendJsonl, processSnapshot } from "@task-handoff/core/core/diagnostics";
import { acquireLocalControlledInstanceLock } from "@task-handoff/core/core/local-controlled-instance-lock";
import { processStartIdentity } from "@task-handoff/core/core/process-singleton-lock";
import { TriggerExecutor } from "../triggers/executor";
import { TriggerManager } from "../triggers/manager";
import { TriggerStore, type TriggerCreateInput } from "../triggers/store";
import { resolveStoragePaths } from "@task-handoff/core/storage/paths";
import { AppRuntimeManager } from "@task-handoff/app-runtime/runtime";
import type { AppCatalogItem, AppLaunchOptions } from "@task-handoff/app-runtime/types";
import {
  AiSessionController,
  AiSessionCreateCoordinator,
  AiSessionForkCoordinator,
  AiSessionCloseCoordinator,
  AiSessionDiscoveryCoordinator,
  AiSessionHistoryLifecycle,
  AiSessionHistoryStore,
  AiSessionResumeCoordinator,
  AiSessionOpenAppCoordinator,
  ClaudeAppSessionBindingProvider,
  ClaudeControlSockSessionBridge,
  CodexAppServerSessionBridge,
  createAiSessionRegistry,
  TranscriptTailDiscoveryProvider,
  type AiSessionRegistry,
} from "@task-handoff/ai-session-runtime";
import { NodeAgentRegistrationClient, nodeAgentRegistrationConfigFromEnv } from "./node-agent-client";
import { nodeAgentApiRoute, publicApiRoute, registerAuth, resolveWebAuth } from "./auth";
import { AiSessionMessageDeltaCoalescer } from "./ai-session-message-delta-coalescer";
import {
  AiSessionPersistenceSettingsInputSchema,
  AiSessionPersistenceSettingsStore,
} from "./ai-session-persistence-settings";
import { WebEventBus } from "./events";
import { AppManagementManager, AppManagementRequestError } from "./app-management";
import { configSyncPresets, configSyncPrograms, listConfigSyncFolders, runConfigSync, runConfigSyncBatch } from "./config-sync";
import { ConfigSyncRequestSchema } from "@task-handoff/protocol/config-sync";
import { applyManagedCodexModelConfig } from "./codex-model-config";
import { applyManagedClaudeModelConfig } from "./claude-model-config";
import {
  controlledInstanceCapabilities,
  controlledInstanceSnapshot,
  packageVersion,
  runtimeDiagnostics,
  triggerSnapshot,
  workspaceStatus,
} from "./status";
import {
  WEB_PROXY_STARTUP_RETRY_INTERVAL_MS,
  WEB_PROXY_STARTUP_RETRY_MS,
  fetchHeadersToNode,
  fetchHeadersToOutgoing,
  isRetryableWebProxyError,
  kasmVncAuthorizationHeader,
  proxyHeaders,
  proxyPath,
  proxyWebSocketHeaders,
  proxyWebSocketProtocols,
  shouldThemeKasmVncResponse,
  sleep,
  themeKasmVncResponseBody,
} from "./web-proxy-helpers";
import {
  AI_SESSION_DELTA_RETENTION_MS,
  AiSessionEventType,
  AiSessionActionResultSchema,
  AiSessionCreateInputSchema,
  AiSessionCreateResultSchema,
  AiSessionForkInputSchema,
  AiSessionForkResultSchema,
  AiSessionCloseInputSchema,
  AiSessionCloseResultSchema,
  AiSessionOpenAppInputSchema,
  AiSessionOpenAppResultSchema,
  AiSessionApprovalInputSchema,
  AiSessionControlErrorSchema,
  AiSessionHistoryListSchema,
  AiSessionHistoryDetailSchema,
  AiSessionTimelineSchema,
  AiSessionTurnTimelineSchema,
  AiSessionDeltaResponseSchema,
  AiSessionMessageDeltaEventSchema,
  AiSessionTimelineItemEventSchema,
  type AiSessionEventReason,
  type AiSessionSnapshotEvent,
  type AiSessionsSnapshot,
  AiSessionMessageInputSchema,
  AiSessionCommandInputSchema,
  AiSessionCommandResultSchema,
  AiSessionMentionFileSearchInputSchema,
  AiSessionQueueReorderInputSchema,
  AiSessionQueueEditInputSchema,
  AiSessionResumeResultSchema,
} from "@task-handoff/protocol/ai-sessions";
import {
  APP_SESSION_DELTA_RETENTION_MS,
  AppSessionDeltaResponseSchema,
  AppSessionEventType,
  AppSessionRecordSchema,
  activeAppSessionsSnapshotFromRecords,
  appSessionsSnapshotFromRecords,
  type AppSessionPatchEvent,
  type AppSessionEventReason,
  type AppSessionRemovedEvent,
  type AppSessionSnapshotEvent,
  type AppSessionsSnapshot,
} from "@task-handoff/protocol/app-sessions";
import { TriggerSourceSchema, TriggerActionSchema, TriggerPolicySchema, TriggerTargetSchema } from "@task-handoff/protocol/triggers";
import { bridgeWebSockets } from "@task-handoff/protocol/websocket-bridge";
import { SESSION_STREAM_PROTOCOL_VERSION, SessionStreamsHelloEventType } from "@task-handoff/protocol/events";
import { AppManagementOperationRequestSchema } from "@task-handoff/protocol/control-plane";
import { registerRepositoryRoutes, repositoryWorkspaceRootsFromEnv } from "../repository/routes";

const WebSocketClient = require("ws");

type ProxyFetchInit = NonNullable<Parameters<typeof proxyFetch>[2]>;
type NodeProxyFetchInit = Omit<ProxyFetchInit, "headers" | "body"> & {
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer | string | http.IncomingMessage;
  duplex?: "half";
};

function proxyRequestInit(input: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  requestBody: Buffer | string | undefined;
  rawRequest: http.IncomingMessage;
  streamRawRequest: boolean;
}): ProxyFetchInit {
  const init: NodeProxyFetchInit = {
    method: input.method,
    headers: input.headers,
    body: input.streamRawRequest ? input.rawRequest : input.requestBody,
    ...(input.streamRawRequest ? { duplex: "half" } : {}),
  };
  return init as ProxyFetchInit;
}

function appSessionSnapshotChanges(previous: AppSessionsSnapshot, next: AppSessionsSnapshot) {
  const previousById = new Map(previous.sessions.map((session) => [session.id, session]));
  const nextById = new Map(next.sessions.map((session) => [session.id, session]));
  const changes: Array<
    | { type: "upsert"; session: AppSessionsSnapshot["sessions"][number] }
    | { type: "removed"; sessionId: string; tombstone?: AppSessionsSnapshot["sessions"][number] }
  > = [];
  for (const session of next.sessions) {
    const previousSession = previousById.get(session.id);
    if (!previousSession || JSON.stringify(previousSession) !== JSON.stringify(session)) {
      changes.push({ type: "upsert", session });
    }
  }
  for (const session of previous.sessions) {
    if (!nextById.has(session.id)) {
      changes.push({ type: "removed", sessionId: session.id, tombstone: session });
    }
  }
  return changes;
}

function readableFromWebStream(stream: NonNullable<Response["body"]>) {
  return Readable.fromWeb(stream);
}

function normalizeProxyRequestBody(value: unknown): Buffer | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Buffer.isBuffer(value) || typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

type RunWebServerOptions = {
  host: string;
  port: number;
  staticDir?: string;
};

type CreateWebAppOptions = {
  staticDir?: string;
  logger?: FastifyServerOptions["logger"];
  appRuntime?: AppRuntimeManager;
  aiSessionRegistry?: AiSessionRegistry;
  aiSessionDiscovery?: AiSessionDiscoveryCoordinator;
  codexAppServer?: CodexAppServerSessionBridge;
  appManagement?: AppManagementManager;
};

export class AiSessionRefreshScheduler {
  private requestedRevision = 0;
  private completedRevision = 0;
  private latestReason: AiSessionEventReason = "discovery-scan";
  private inFlight?: Promise<void>;

  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly publish: (reason: AiSessionEventReason) => void,
  ) {}

  request(reason: AiSessionEventReason = "discovery-scan") {
    this.requestedRevision += 1;
    this.latestReason = reason;
    if (!this.inFlight) {
      this.inFlight = this.drain().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async drain() {
    while (this.completedRevision < this.requestedRevision) {
      const targetRevision = this.requestedRevision;
      const reason = this.latestReason;
      await this.refresh();
      this.publish(reason);
      this.completedRevision = targetRevision;
    }
  }
}

function installGracefulShutdown(app: Awaited<ReturnType<typeof createWebApp>>) {
  let closing = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) {
      return;
    }
    closing = true;
    app.log.info({ signal, pid: process.pid }, "controlled instance graceful shutdown started");
    try {
      await app.close();
      app.log.info({ signal, pid: process.pid }, "controlled instance graceful shutdown completed");
      process.exitCode = 0;
    } catch (error) {
      app.log.error({ err: error, signal, pid: process.pid }, "controlled instance graceful shutdown failed");
      process.exitCode = 1;
    }
  };
  const onSigint = () => {
    void shutdown("SIGINT");
  };
  const onSigterm = () => {
    void shutdown("SIGTERM");
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  app.addHook("onClose", async () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  });
}

type AppLaunchRequestBody = AppLaunchOptions & {
  appId?: string;
};

const ConfigSyncPresetSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(120),
    projectRoot: z.string().trim().min(1).max(500),
    items: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120),
            type: z.enum(["file", "dir"]),
            projectPath: z.string().trim().min(1).max(500),
          containerPath: z.string().trim().min(1).max(500),
        })
          .strip(),
      )
      .min(1)
      .max(50),
  })
  .strip();

const ConfigSyncLegacyRequestSchema = z
  .object({
    preset: ConfigSyncPresetSchema.optional(),
  })
  .strip()
  .default({});

function websocketMessageToBuffer(message: Buffer | ArrayBuffer | Buffer[]) {
  if (Buffer.isBuffer(message)) {
    return message;
  }
  if (Array.isArray(message)) {
    return Buffer.concat(message);
  }
  return Buffer.from(message);
}

const AppLaunchSchema = z
  .object({
    appId: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_.-]*$/).optional(),
    title: z.string().trim().min(1).max(120).optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
    cwd: z.string().trim().min(1).max(512).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)).optional(),
    display: z
      .object({
        width: z.number().int().min(320).max(7680).optional(),
        height: z.number().int().min(240).max(4320).optional(),
        depth: z.union([z.literal(16), z.literal(24), z.literal(32)]).optional(),
      })
      .optional(),
    displayTarget: z
      .object({
        mode: z.enum(["isolated", "shared"]),
        id: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
        autoCreate: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

const ManagedModelEnvironmentSchema = z.object({
  OPENAI_API_KEY: z.string().max(4096).optional(),
  OPENAI_BASE_URL: z.string().max(4096).optional(),
  TASK_HANDOFF_CODEX_BASE_URL: z.string().max(4096).optional(),
  TASK_HANDOFF_CODEX_MODEL: z.string().max(4096).optional(),
  ANTHROPIC_API_KEY: z.string().max(4096).optional(),
  ANTHROPIC_BASE_URL: z.string().max(4096).optional(),
  TASK_HANDOFF_CLAUDE_MODEL: z.string().max(4096).optional(),
}).strict();

const MANAGED_MODEL_ENV_KEYS = Object.keys(ManagedModelEnvironmentSchema.shape);

function managedModelEnvironment(env: NodeJS.ProcessEnv) {
  return ManagedModelEnvironmentSchema.parse(Object.fromEntries(
    MANAGED_MODEL_ENV_KEYS.flatMap((key) => typeof env[key] === "string" ? [[key, env[key]]] : []),
  ));
}

function managedAppEnvironment(env: NodeJS.ProcessEnv) {
  const managed = managedModelEnvironment(env);
  return {
    ...managed,
    // Explicit undefined values shadow the controlled-instance process
    // environment and are omitted by child_process when Claude is launched.
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: undefined,
    ANTHROPIC_MODEL: undefined,
    CLAUDE_MODEL: undefined,
    TASK_HANDOFF_CLAUDE_MODEL: undefined,
  };
}

const AppDisplaySchema = z
  .object({
    width: z.number().int().min(320).max(7680).optional(),
    height: z.number().int().min(240).max(4320).optional(),
    depth: z.number().int().min(8).max(32).optional(),
  })
  .strip();

const AppSessionRenameSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
  })
  .strict();

const TriggerCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional(),
  source: TriggerSourceSchema,
  action: TriggerActionSchema,
  policy: TriggerPolicySchema.partial().optional(),
  deployment: z.object({
    deploymentId: z.string().trim().min(1).max(240).optional(),
    origin: z.enum(["control-plane", "controlled-instance"]).optional(),
    enabled: z.boolean().optional(),
    target: TriggerTargetSchema,
    localName: z.string().trim().min(1).max(160).optional(),
  }).strict().optional(),
}).strict();

const TriggerPatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
}).strict();

const TriggerRunRequestSchema = z.object({
  promptOverride: z.string().trim().min(1).max(20_000).optional(),
  eventSummary: z.string().trim().max(1000).optional(),
  deploymentId: z.string().trim().min(1).max(240).optional(),
}).strict().default({});

function appLaunchRequest(body: unknown = {}): { appId: string; options: AppLaunchOptions } {
  const parsed = AppLaunchSchema.parse(body || {});
  const options: AppLaunchOptions = {};
  if (parsed.title) {
    options.title = parsed.title;
  }
  if (parsed.args) {
    options.args = parsed.args;
  }
  if (parsed.cwd) {
    options.cwd = parsed.cwd;
  }
  if (parsed.env) {
    options.env = parsed.env;
  }
  if (parsed.display) {
    options.display = parsed.display;
  }
  if (parsed.displayTarget) {
    options.displayTarget = parsed.displayTarget;
  }
  return { appId: parsed.appId || "terminal-tty", options };
}

function appLaunchInvalidMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function sendAiSessionControlError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      error: AiSessionControlErrorSchema.parse({
        code: "AI_SESSION_CONTROL_INVALID",
        message: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
      }),
    });
  }
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code : "AI_SESSION_CONTROL_FAILED";
  const statusCode = typeof record.statusCode === "number"
    ? record.statusCode
    : code === "AI_SESSION_NOT_FOUND"
      ? 404
      : code === "AI_SESSION_FORK_WORKTREE_UNAVAILABLE"
        ? 409
        : 400;
  return reply.code(statusCode).send({ error: AiSessionControlErrorSchema.parse({ code, message: error instanceof Error ? error.message : String(error) }) });
}

function defaultStaticDir() {
  const candidates = [
    path.resolve(process.cwd(), "packages", "controlled-instance-ui", "dist"),
    path.resolve(__dirname, "..", "packages", "controlled-instance-ui", "dist"),
    path.resolve(__dirname, "..", "..", "..", "controlled-instance-ui", "dist"),
    path.resolve(__dirname, "..", "..", "..", "..", "packages", "controlled-instance-ui", "dist"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function envFlag(name: string, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function logControlledInstanceStart(logDir: string, dataDir: string) {
  if (!envFlag("TASK_HANDOFF_DIAGNOSTIC_LOGS")) {
    return;
  }
  try {
    const logPath = path.join(logDir, "controlled-instance.log");
    appendJsonl(logPath, {
      event: "controlled_instance_start",
      component: "controlled-instance",
      controlMode: process.env.TASK_HANDOFF_CONTROL_MODE,
      diagnosticLogs: process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS,
      dataDir,
      logDir,
      logPath,
      process: processSnapshot(),
    });
  } catch {
    // Diagnostics must never prevent the controlled instance from starting.
  }
}

function resolveNoVncRoot() {
  const configuredRoot = process.env.TASK_HANDOFF_NOVNC_ROOT?.trim();
  if (configuredRoot) {
    const root = path.resolve(configuredRoot);
    return fs.existsSync(path.join(root, "vnc.html")) ? root : undefined;
  }

  const candidates = [
    "/usr/share/novnc",
    "/usr/share/noVNC",
    "/usr/local/share/novnc",
    "/usr/local/share/noVNC",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (fs.existsSync(path.join(root, "vnc.html"))) {
      return root;
    }
  }
  return undefined;
}

function sendProxyError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, code: string, message: string, statusCode = 502) {
  return reply.code(statusCode).send({ error: { code, message } });
}

function tailTextFile(filePath: string, maxLines = 200) {
  const normalizedMaxLines = Math.min(Math.max(1, Number(maxLines) || 200), 1000);
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  return {
    path: filePath,
    lineCount: lines.length,
    tail: lines.slice(-normalizedMaxLines).join("\n"),
  };
}

async function runTriggerOnce(triggers: TriggerStore, executor: TriggerExecutor, configHash: string, input: unknown = {}) {
  const parsed = TriggerRunRequestSchema.parse(input || {});
  const entry = triggers.get(configHash);
  if (!entry) {
    throw Object.assign(new Error("Trigger not found."), { code: "TRIGGER_NOT_FOUND", statusCode: 404 });
  }
  const deployment = parsed.deploymentId
    ? entry.deployments.find((item) => (item.deploymentId || item.configHash) === parsed.deploymentId)
    : entry.deployments[0];
  if (!deployment) {
    throw Object.assign(new Error("Trigger has no deployment."), { code: "TRIGGER_DEPLOYMENT_NOT_FOUND", statusCode: 404 });
  }
  return executor.execute({ config: entry.config, deployment, eventType: "manual", eventSummary: parsed.eventSummary, promptOverride: parsed.promptOverride });
}

export async function createWebApp(options: Partial<CreateWebAppOptions> = {}) {
  const startedAt = new Date().toISOString();
  const storagePaths = resolveStoragePaths();
  const managedModelEnv = { ...process.env };
  logControlledInstanceStart(storagePaths.logDir, storagePaths.dataDir);
  applyManagedCodexModelConfig(managedModelEnv);
  applyManagedClaudeModelConfig(managedModelEnv);
  const auth = resolveWebAuth(storagePaths);
  const events = new WebEventBus();
  const appRuntime = options.appRuntime || new AppRuntimeManager(storagePaths);
  appRuntime.replaceManagedEnvironment(managedAppEnvironment(managedModelEnv));
  const app = Fastify({ logger: options.logger ?? true });
  let nodeAgentClient!: NodeAgentRegistrationClient;
  const appManagement = options.appManagement || new AppManagementManager({
    stateDir: path.join(storagePaths.runtimeDir, "app-management"),
    installBaseDir: process.env.TASK_HANDOFF_MANAGED_APP_ROOT || path.join(storagePaths.dataDir, "managed-apps"),
    sessions: () => appRuntime.listSessions(),
    publish: (event) => events.publish("app.management", event),
    warn: (message) => app.log?.warn?.({ message }, "app management persistence warning"),
    onTerminal: async () => {
      if (nodeAgentClient.enabled()) await nodeAgentClient.heartbeat();
    },
  });
  const aiSessions = options.aiSessionRegistry || createAiSessionRegistry();
  const aiSessionPersistenceSettings = new AiSessionPersistenceSettingsStore(storagePaths, (reason) => {
    app.log.warn({ reason }, "AI session persistence settings were sanitized");
  });
  const initialAiSessionPersistenceSettings = aiSessionPersistenceSettings.get();
  const aiSessionHistory = new AiSessionHistoryStore(storagePaths, {
    limit: initialAiSessionPersistenceSettings.historyLimit,
    onWarning: (warning) => app.log.warn({ warning }, "AI session history entry was sanitized"),
  });
  const aiSessionHistoryLifecycle = new AiSessionHistoryLifecycle(aiSessionHistory);
  const aiSessionController = new AiSessionController(aiSessions);
  const triggers = new TriggerStore(storagePaths);
  const triggerExecutor = new TriggerExecutor(triggers, aiSessionController);
  const triggerManager = new TriggerManager(triggers, triggerExecutor, storagePaths, (type, payload) => events.publish(type, payload));
  nodeAgentClient = new NodeAgentRegistrationClient(nodeAgentRegistrationConfigFromEnv(), () => controlledInstanceSnapshot(
    appRuntime,
    storagePaths,
    aiSessions,
    triggers,
    aiSessionController.timelineCapabilities(),
  ));

  await app.register(websocket);
  registerAuth(app, auth);

  app.addHook("onReady", async () => {
    if (nodeAgentClient.enabled()) {
      await nodeAgentClient.start();
    }
  });

  app.addHook("onClose", async () => {
    nodeAgentClient.stop();
    triggerManager.stop();
    appRuntime.dispose?.();
  });
  let aiSessionsFingerprint = "";
  const instanceId = process.env.TASK_HANDOFF_INSTANCE_ID || "standalone";
  const aiSessionStreamId = `ais_${instanceId}_${crypto.randomUUID()}`;
  const appSessionStreamId = `aps_${instanceId}_${crypto.randomUUID()}`;
  let aiSessionSnapshotRevision = 0;
  let lastAiSessionSnapshot: AiSessionsSnapshot = {
    runningCount: 0,
    waitingCount: 0,
    staleCount: 0,
    sessions: [],
    updatedAt: startedAt,
  };
  const aiSessionEventHistory: Array<{ type: typeof AiSessionEventType.Snapshot; payload: AiSessionSnapshotEvent; createdAtMs: number }> = [];
  const drainingAiSessionIds = new Set<string>();
  const aiSessionLifecycleById = new Map<string, string>();
  let aiSessionTimer: ReturnType<typeof setInterval> | undefined;
  let startupAiSessionTask: ReturnType<typeof setImmediate> | undefined;
  let appSessionsFingerprint = "";
  let appSessionSnapshotRevision = 0;
  const streamDiagnostics = { aiDiscoveryUnchanged: 0, aiDiscoveryCorrections: 0, appUnchanged: 0 };
  type AppSessionRuntimeEvent =
    | { type: typeof AppSessionEventType.Snapshot; payload: AppSessionSnapshotEvent }
    | { type: typeof AppSessionEventType.Patch; payload: AppSessionPatchEvent }
    | { type: typeof AppSessionEventType.Removed; payload: AppSessionRemovedEvent };
  const appSessionEventHistory: Array<AppSessionRuntimeEvent & { createdAtMs: number }> = [];
  let lastAppSessionSnapshot = appSessionsSnapshotFromRecords([]);
  const aiSessionDiscovery = options.aiSessionDiscovery || new AiSessionDiscoveryCoordinator();
  const configuredDeltaCoalescingWindow = process.env.TASK_HANDOFF_AI_SESSION_DELTA_COALESCE_MS;
  const aiSessionMessageDeltas = new AiSessionMessageDeltaCoalescer({
    emit: (payload) => events.publish(AiSessionEventType.MessageDelta, payload),
    windowMs: configuredDeltaCoalescingWindow === undefined
      ? undefined
      : Number(configuredDeltaCoalescingWindow),
  });
  const codexAppServer = options.codexAppServer || new CodexAppServerSessionBridge(aiSessions, {
    timelineStorePath: path.join(storagePaths.dataDir, "ai-session-timeline", "codex"),
    threadStartDefaults: {
      model: process.env.TASK_HANDOFF_CODEX_MODEL?.trim() || undefined,
      modelProvider: process.env.TASK_HANDOFF_CODEX_MODEL?.trim() ? "openai" : undefined,
    },
    onMessageDelta: (delta) => {
      const payload = AiSessionMessageDeltaEventSchema.parse({
        instanceId,
        nodeId: process.env.TASK_HANDOFF_NODE_ID,
        ...delta,
        generatedAt: new Date().toISOString(),
      });
      aiSessionMessageDeltas.push(payload);
    },
    onEventSourceClose: () => aiSessionMessageDeltas.flushAll("event-source-close"),
  });
  const retainCodexTimelineHistory = () => {
    if (typeof codexAppServer.retainTimelineHistory !== "function") return;
    try {
      codexAppServer.retainTimelineHistory([
        ...aiSessions.all()
          .filter((session) => session.agent === "codex")
          .flatMap((session) => session.providerSessionId ? [session.providerSessionId] : []),
        ...aiSessionHistory.list()
          .filter((session) => session.agent === "codex")
          .map((session) => session.providerSessionId),
      ]);
    } catch (error) {
      app.log.warn({ err: error }, "Codex Timeline persistence cleanup failed");
    }
  };
  retainCodexTimelineHistory();
  app.put<{ Body: unknown }>("/api/internal/ai-session-persistence-settings", nodeAgentApiRoute({
    code: "AI_SESSION_PERSISTENCE_SETTINGS_FORBIDDEN",
    message: "Instance registration token is required.",
  }), async (request) => {
    const next = AiSessionPersistenceSettingsInputSchema.parse(request.body || {});
    aiSessionPersistenceSettings.put(next);
    const history = aiSessionHistory.setRetentionLimit(next.historyLimit);
    retainCodexTimelineHistory();
    return { data: { applied: true, historyLimit: history.limit, removedHistoryCount: history.removed.length } };
  });
  const claudeControlSock = new ClaudeControlSockSessionBridge(aiSessions);
  aiSessionController.register(codexAppServer);
  aiSessionController.register(claudeControlSock);
  const unsubscribeTimelineItems = aiSessionController.subscribeTimelineItems((timelineItem) => {
    events.publish(AiSessionEventType.TimelineItem, AiSessionTimelineItemEventSchema.parse({
      instanceId,
      nodeId: process.env.TASK_HANDOFF_NODE_ID,
      ...timelineItem,
      generatedAt: new Date().toISOString(),
    }));
  });
  app.addHook("onClose", async () => unsubscribeTimelineItems());
  aiSessionDiscovery.register(new ClaudeAppSessionBindingProvider());
  aiSessionDiscovery.register(claudeControlSock);
  aiSessionDiscovery.register(new TranscriptTailDiscoveryProvider());
  aiSessionDiscovery.register(codexAppServer);
  const appSessionsWithSharedCodexAppServer = () => {
    const appServer = appRuntime.sharedResourceSessionAi("codex")?.appServer;
    if (!appServer) {
      return appRuntime.listSessions();
    }
    return [
      ...appRuntime.listSessions(),
      {
        id: "__shared_codex_app_server__",
        appId: "codex",
        title: "Codex app-server",
        status: "running",
        createdAt: startedAt,
        ai: { appServer },
      },
    ];
  };
  const aiSessionResume = new AiSessionResumeCoordinator({
    history: aiSessionHistory,
    registry: aiSessions,
    appSessions: appSessionsWithSharedCodexAppServer,
    startApp: (item) => appRuntime.start(item.agent, {
      cwd: item.cwd,
      aiSessionResume: {
        aiSessionId: item.id,
        providerSessionId: item.providerSessionId,
      },
    }),
    resumeProvider: async (item) => {
      await appRuntime.ensureSharedResource(item.agent);
      await codexAppServer.sync(appSessionsWithSharedCodexAppServer());
      await aiSessionController.provider(item.agent).resumeSession?.(item.providerSessionId);
    },
  });
  const aiSessionCreate = new AiSessionCreateCoordinator({
    registry: aiSessions,
    controller: aiSessionController,
    operationStorePath: path.join(storagePaths.runtimeDir, "ai-session-create-operations.json"),
    ensureProvider: async (agent) => {
      await appRuntime.ensureSharedResource(agent);
      if (agent === "codex") await codexAppServer.sync(appSessionsWithSharedCodexAppServer());
    },
    onDiagnostic: (diagnostic) => app.log.warn({ diagnostic }, "AI session create compensation"),
  });
  const repositoryAiSessionWorkspace = registerRepositoryRoutes(app, {
    appRuntime,
    aiSessions,
    aiSessionCreate,
    managedWorktreesRoot: process.env.TASK_HANDOFF_MANAGED_WORKTREES_ROOT || path.join(storagePaths.dataDir, "managed-worktrees"),
    workspaceRoots: repositoryWorkspaceRootsFromEnv(),
  });
  const aiSessionFork = new AiSessionForkCoordinator({
    registry: aiSessions,
    controller: aiSessionController,
    operationStorePath: path.join(storagePaths.runtimeDir, "ai-session-fork-operations.json"),
    ensureProvider: async (agent) => {
      await appRuntime.ensureSharedResource(agent);
      if (agent === "codex") await codexAppServer.sync(appSessionsWithSharedCodexAppServer());
    },
    prepareManagedWorktree: async (source, clientRequestId) => repositoryAiSessionWorkspace.prepareForkWorktree(source.id, clientRequestId),
    validateManagedWorktree: async (source, worktreeId, cwd) => repositoryAiSessionWorkspace.validateForkWorktree(source.id, worktreeId, cwd),
    removeManagedWorktree: async (source, worktreeId) => repositoryAiSessionWorkspace.removeForkWorktree(source.id, worktreeId),
    onDiagnostic: (diagnostic) => app.log.warn({ diagnostic }, "AI session Fork compensation"),
  });
  const aiSessionOpenApp = new AiSessionOpenAppCoordinator({
    registry: aiSessions,
    appSessions: appSessionsWithSharedCodexAppServer,
    startApp: (session) => appRuntime.start(session.agent, {
      cwd: session.cwd,
      aiSessionResume: {
        aiSessionId: session.id,
        providerSessionId: session.providerSessionId || "",
      },
    }),
    stopApp: (appSessionId) => { appRuntime.stop(appSessionId); },
  });
  const aiSessionClose = new AiSessionCloseCoordinator({
    registry: aiSessions,
    controller: aiSessionController,
    history: aiSessionHistory,
    stopApp: (appSessionId) => { appRuntime.stop(appSessionId); },
    onDiagnostic: (diagnostic) => app.log.warn({ diagnostic }, "AI session close rollback"),
  });
  let serviceClosing = false;
  const refreshAiSessions = async () => {
    if (serviceClosing) return;
    const appSessions = appSessionsWithSharedCodexAppServer();
    const activeAppIds = new Set(appSessions.filter((session) => !session.status || session.status === "running").map((session) => session.id));
    const lostBindings = aiSessions.all().flatMap((session) => {
      const appSessionId = session.appSessionId;
      return appSessionId && !activeAppIds.has(appSessionId) ? [{ session, appSessionId }] : [];
    });
    await Promise.all(lostBindings.map(async ({ session, appSessionId }) => {
      if (serviceClosing) return;
      try { await aiSessionClose.closeForAppSession(appSessionId); } catch (error: unknown) {
        app.log.warn({ err: error, aiSessionId: session.id, appSessionId }, "failed to close AI session after App exit");
      }
    }));
    aiSessions.reconcileAppSessionBindings(appSessions);
    await aiSessionDiscovery.refresh({
      registry: aiSessions,
      appSessions,
    });
    aiSessionHistoryLifecycle.activate(aiSessions.all(), appSessions);
    retainCodexTimelineHistory();
  };
  const aiSessionRefreshScheduler = new AiSessionRefreshScheduler(
    refreshAiSessions,
    (reason) => publishAiSessionSnapshot(reason),
  );
  const refreshAndPublishAiSessions = (reason: AiSessionEventReason = "discovery-scan") => (
    aiSessionRefreshScheduler.request(reason)
  );
  const createAiSessionSnapshotEvent = (snapshot: AiSessionsSnapshot, reason: AiSessionEventReason): AiSessionSnapshotEvent => ({
    meta: {
      streamId: aiSessionStreamId,
      instanceId,
      nodeId: process.env.TASK_HANDOFF_NODE_ID,
      revision: aiSessionSnapshotRevision,
      previousRevision: aiSessionSnapshotRevision > 0 ? aiSessionSnapshotRevision - 1 : undefined,
      traceId: `ais_evt_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
      generatedAt: new Date().toISOString(),
      reason,
    },
    snapshot,
  });
  const pruneAiSessionEventHistory = () => {
    const cutoff = Date.now() - AI_SESSION_DELTA_RETENTION_MS;
    while (aiSessionEventHistory.length && aiSessionEventHistory[0].createdAtMs < cutoff) {
      aiSessionEventHistory.shift();
    }
  };
  const rememberAiSessionEvent = (payload: AiSessionSnapshotEvent) => {
    aiSessionEventHistory.push({ type: AiSessionEventType.Snapshot, payload, createdAtMs: Date.now() });
    pruneAiSessionEventHistory();
  };
  const publishAiSessionSnapshot = (reason: AiSessionEventReason = "provider-event") => {
    aiSessionMessageDeltas.flushAll("authoritative-event");
    const snapshot = aiSessions.boundSnapshot(appSessionsWithSharedCodexAppServer());
    const fingerprint = JSON.stringify(snapshot.sessions);
    if (fingerprint !== aiSessionsFingerprint) {
      aiSessionsFingerprint = fingerprint;
      lastAiSessionSnapshot = snapshot;
      aiSessionSnapshotRevision += 1;
      const payload = createAiSessionSnapshotEvent(snapshot, reason);
      rememberAiSessionEvent(payload);
      events.publish(AiSessionEventType.Snapshot, payload);
      app.log.info({
        traceId: payload.meta.traceId,
        instanceId: payload.meta.instanceId,
        streamId: payload.meta.streamId,
        revision: payload.meta.revision,
        reason,
        sessionCount: snapshot.sessions.length,
        runningCount: snapshot.runningCount,
        waitingCount: snapshot.waitingCount,
      }, "ai-session.snapshot.published");
      triggerManager.handleAiSessions(snapshot);
      if (reason === "discovery-scan") {
        streamDiagnostics.aiDiscoveryCorrections += 1;
        app.log.info({ instanceId, streamId: aiSessionStreamId, revision: aiSessionSnapshotRevision, correctionCount: streamDiagnostics.aiDiscoveryCorrections }, "ai-session.discovery.corrected");
      }
    } else if (reason === "discovery-scan") {
      streamDiagnostics.aiDiscoveryUnchanged += 1;
      app.log.info({ instanceId, streamId: aiSessionStreamId, revision: aiSessionSnapshotRevision, unchangedCount: streamDiagnostics.aiDiscoveryUnchanged }, "ai-session.discovery.unchanged");
    }
  };
  const createAppSessionSnapshotEvent = (snapshot: ReturnType<typeof appSessionsSnapshotFromRecords>, reason: AppSessionEventReason): AppSessionSnapshotEvent => ({
    meta: {
      streamId: appSessionStreamId,
      instanceId,
      nodeId: process.env.TASK_HANDOFF_NODE_ID,
      revision: appSessionSnapshotRevision,
      previousRevision: appSessionSnapshotRevision > 0 ? appSessionSnapshotRevision - 1 : undefined,
      traceId: `aps_evt_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
      generatedAt: new Date().toISOString(),
      reason,
    },
    snapshot,
  });
  const pruneAppSessionEventHistory = () => {
    const cutoff = Date.now() - APP_SESSION_DELTA_RETENTION_MS;
    while (appSessionEventHistory.length && appSessionEventHistory[0].createdAtMs < cutoff) {
      appSessionEventHistory.shift();
    }
  };
  const createAppSessionMeta = (reason: AppSessionEventReason) => ({
    streamId: appSessionStreamId,
    instanceId,
    nodeId: process.env.TASK_HANDOFF_NODE_ID,
    revision: appSessionSnapshotRevision,
    previousRevision: appSessionSnapshotRevision > 0 ? appSessionSnapshotRevision - 1 : undefined,
    traceId: `aps_evt_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
    generatedAt: new Date().toISOString(),
    reason,
  });
  const createAppSessionPatchEvent = (session: AppSessionsSnapshot["sessions"][number], reason: AppSessionEventReason): AppSessionPatchEvent => ({
    meta: createAppSessionMeta(reason),
    session,
  });
  const createAppSessionRemovedEvent = (sessionId: string, tombstone: AppSessionsSnapshot["sessions"][number] | undefined, reason: AppSessionEventReason): AppSessionRemovedEvent => ({
    meta: createAppSessionMeta(reason),
    sessionId,
    tombstone,
    expiresAt: new Date(Date.now() + APP_SESSION_DELTA_RETENTION_MS).toISOString(),
  });
  const rememberAppSessionEvent = (event: AppSessionRuntimeEvent) => {
    appSessionEventHistory.push({ ...event, createdAtMs: Date.now() });
    pruneAppSessionEventHistory();
  };
  const publishAppSessionEvent = (event: AppSessionRuntimeEvent, snapshot: AppSessionsSnapshot, reason: AppSessionEventReason) => {
    rememberAppSessionEvent(event);
    events.publish(event.type, event.payload);
    app.log.info({
      traceId: event.payload.meta.traceId,
      instanceId: event.payload.meta.instanceId,
      streamId: event.payload.meta.streamId,
      revision: event.payload.meta.revision,
      reason,
      eventType: event.type,
      sessionCount: snapshot.sessions.length,
      runningCount: snapshot.runningCount,
      problemCount: snapshot.problemCount,
    }, "app-session.event.published");
  };
  const publishAppSessionSnapshot = (reason: AppSessionEventReason) => {
    const snapshot = activeAppSessionsSnapshotFromRecords(appRuntime.listSessions() as unknown as Array<Record<string, unknown>>);
    const fingerprint = JSON.stringify(snapshot.sessions);
    if (fingerprint === appSessionsFingerprint) {
      streamDiagnostics.appUnchanged += 1;
      app.log.info({
        instanceId,
        streamId: appSessionStreamId,
        revision: appSessionSnapshotRevision,
        reason,
        sessionCount: snapshot.sessions.length,
        unchangedCount: streamDiagnostics.appUnchanged,
      }, "app-session.snapshot.skipped-unchanged");
      return;
    }
    appSessionsFingerprint = fingerprint;
    const changes = appSessionSnapshotChanges(lastAppSessionSnapshot, snapshot);
    if (appSessionSnapshotRevision === 0 || changes.length !== 1) {
      appSessionSnapshotRevision += 1;
      const payload = createAppSessionSnapshotEvent(snapshot, reason);
      publishAppSessionEvent({ type: AppSessionEventType.Snapshot, payload }, snapshot, reason);
    } else {
      appSessionSnapshotRevision += 1;
      const change = changes[0];
      const event: AppSessionRuntimeEvent = change.type === "removed"
        ? { type: AppSessionEventType.Removed, payload: createAppSessionRemovedEvent(change.sessionId, change.tombstone, reason) }
        : { type: AppSessionEventType.Patch, payload: createAppSessionPatchEvent(change.session, reason) };
      publishAppSessionEvent(event, snapshot, reason);
    }
    lastAppSessionSnapshot = snapshot;
  };
  const appSessionDeltaSince = (streamId: string, sinceRevision: number) => {
    pruneAppSessionEventHistory();
    const latestRevision = appSessionSnapshotRevision;
    const earliestRetainedRevision = appSessionEventHistory[0]?.payload.meta.revision ?? latestRevision + 1;
    if (streamId !== appSessionStreamId || sinceRevision > latestRevision) {
      return AppSessionDeltaResponseSchema.parse({
        streamId: appSessionStreamId,
        instanceId,
        sinceRevision,
        latestRevision,
        earliestRetainedRevision,
        syncRequired: true,
        events: [],
      });
    }
    if (sinceRevision === latestRevision) {
      return AppSessionDeltaResponseSchema.parse({
        streamId: appSessionStreamId,
        instanceId,
        sinceRevision,
        latestRevision,
        earliestRetainedRevision,
        syncRequired: false,
        events: [],
      });
    }
    const eventsAfterRevision = appSessionEventHistory.filter((event) => event.payload.meta.revision > sinceRevision);
    const firstRevision = eventsAfterRevision[0]?.payload.meta.revision;
    const syncRequired = !eventsAfterRevision.length || firstRevision !== sinceRevision + 1;
    return AppSessionDeltaResponseSchema.parse({
      streamId: appSessionStreamId,
      instanceId,
      sinceRevision,
      latestRevision,
      earliestRetainedRevision,
      syncRequired,
      events: syncRequired ? [] : eventsAfterRevision.map((event) => ({ type: event.type, payload: event.payload })),
    });
  };
  const aiSessionDeltaSince = (streamId: string, sinceRevision: number) => {
    pruneAiSessionEventHistory();
    const latestRevision = aiSessionSnapshotRevision;
    const earliestRetainedRevision = aiSessionEventHistory[0]?.payload.meta.revision ?? latestRevision + 1;
    if (streamId !== aiSessionStreamId || sinceRevision > latestRevision) {
      return AiSessionDeltaResponseSchema.parse({
        streamId: aiSessionStreamId,
        instanceId,
        sinceRevision,
        latestRevision,
        earliestRetainedRevision,
        syncRequired: true,
        events: [],
      });
    }
    if (sinceRevision === latestRevision) {
      return AiSessionDeltaResponseSchema.parse({
        streamId: aiSessionStreamId,
        instanceId,
        sinceRevision,
        latestRevision,
        earliestRetainedRevision,
        syncRequired: false,
        events: [],
      });
    }
    const eventsAfterRevision = aiSessionEventHistory.filter((event) => event.payload.meta.revision > sinceRevision);
    const firstRevision = eventsAfterRevision[0]?.payload.meta.revision;
    const syncRequired = !eventsAfterRevision.length || firstRevision !== sinceRevision + 1;
    return AiSessionDeltaResponseSchema.parse({
      streamId: aiSessionStreamId,
      instanceId,
      sinceRevision,
      latestRevision,
      earliestRetainedRevision,
      syncRequired,
      events: syncRequired ? [] : eventsAfterRevision.map((event) => ({ type: event.type, payload: event.payload })),
    });
  };
  const drainAiSessionQueue = async (sessionId: string) => {
    if (drainingAiSessionIds.has(sessionId)) {
      return;
    }
    const session = aiSessions.get(sessionId);
    if (!session || session.status !== "idle" || !aiSessions.nextQueuedMessage(sessionId)) {
      return;
    }
    drainingAiSessionIds.add(sessionId);
    try {
      await aiSessionController.sendNextQueuedMessage(sessionId);
    } catch (error) {
      app.log.warn({ err: error, sessionId }, "failed to drain AI session message queue");
    } finally {
      drainingAiSessionIds.delete(sessionId);
      publishAiSessionSnapshot("control-action");
    }
  };
  let scheduledAiSessionPublish: ReturnType<typeof setTimeout> | undefined;
  const scheduleAiSessionPublish = () => {
    if (scheduledAiSessionPublish) {
      return;
    }
    scheduledAiSessionPublish = setTimeout(() => {
      scheduledAiSessionPublish = undefined;
      publishAiSessionSnapshot();
    }, Number(process.env.TASK_HANDOFF_AI_SESSION_PUBLISH_DEBOUNCE_MS) || 50);
  };
  const stopAiSessionChangeListener = aiSessions.onChange((changeReason) => {
    if (changeReason === "delete") retainCodexTimelineHistory();
    scheduleAiSessionPublish();
    for (const session of aiSessions.list()) {
      const previousStatus = aiSessionLifecycleById.get(session.id);
      aiSessionLifecycleById.set(session.id, session.status);
      if (previousStatus && previousStatus !== "idle" && session.status === "idle" && session.queue.pendingCount > 0) {
        void drainAiSessionQueue(session.id);
      }
    }
  });
  app.addHook("onReady", async () => {
    triggerManager.start();
    if (envFlag("TASK_HANDOFF_CODEX_APP_SERVER", false)) {
      try {
        appRuntime.ensureSharedResource("codex");
      } catch (error) {
        app.log.warn({ err: error }, "failed to start shared Codex app-server");
      }
    }
  });
  app.addHook("onReady", async () => {
    // Persisted transcript and process discovery can be expensive. It must not
    // delay the process identity endpoint used to commit Local Runtime startup.
    startupAiSessionTask = setImmediate(() => {
      startupAiSessionTask = undefined;
      if (serviceClosing) return;
      void refreshAndPublishAiSessions("startup").catch((error) => {
        app.log.warn({ err: error }, "initial AI session discovery failed");
      });
    });
    aiSessionTimer = setInterval(() => {
      void refreshAndPublishAiSessions();
    }, Number(process.env.TASK_HANDOFF_AI_SESSION_SCAN_INTERVAL_MS) || 30_000);
  });
  app.addHook("onClose", async () => {
    stopAiSessionChangeListener();
    if (startupAiSessionTask) {
      clearImmediate(startupAiSessionTask);
      startupAiSessionTask = undefined;
    }
    if (scheduledAiSessionPublish) {
      clearTimeout(scheduledAiSessionPublish);
      scheduledAiSessionPublish = undefined;
    }
    if (aiSessionTimer) {
      clearInterval(aiSessionTimer);
      aiSessionTimer = undefined;
    }
    codexAppServer.stop();
    claudeControlSock.stop();
  });
  app.addHook("preClose", async () => {
    // Provider sessions are durable user state, not process-owned resources.
    // Preserve the registry for discovery/recovery after restart; explicit App
    // exits and Close AI Session remain responsible for provider archival.
    serviceClosing = true;
    codexAppServer.stop();
    aiSessionMessageDeltas.close("service-close");
  });
  const publishAppSessionRuntimeChange = (reason: AppSessionEventReason, session: Record<string, unknown>) => {
    publishAppSessionSnapshot(reason);
    const aiReason: AiSessionEventReason = reason === "app-session-recovered" ? "discovery-scan" : reason;
    void refreshAndPublishAiSessions(aiReason).catch((error) => {
      app.log.warn({ err: error, reason, sessionId: session.id }, "failed to refresh AI sessions after app session event");
    });
  };
  appRuntime.on("created", (session) => publishAppSessionRuntimeChange("app-session-created", session));
  appRuntime.on("updated", (session) => publishAppSessionRuntimeChange("app-session-updated", session));
  appRuntime.on("deleted", (session) => publishAppSessionRuntimeChange("app-session-deleted", session));
  app.addHook("onClose", async () => {
    await appRuntime.stopAll();
  });

  const noVncRoot = resolveNoVncRoot();
  if (noVncRoot) {
    await app.register(fastifyStatic, {
      root: noVncRoot,
      prefix: "/api/novnc/",
      decorateReply: false,
    });
  } else {
    app.get("/api/novnc/*", async (_request, reply) =>
      reply.code(404).send({
        error: {
          code: "NOVNC_NOT_FOUND",
          message: "noVNC static files were not found. Install noVNC or set TASK_HANDOFF_NOVNC_ROOT to a directory containing vnc.html.",
        },
      }),
    );
  }

  const staticDir = path.resolve(options.staticDir || process.env.TASK_HANDOFF_WEB_STATIC_DIR || defaultStaticDir());
  if (fs.existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: "/",
    });
  }

  app.get("/api/health", publicApiRoute, async () => ({
    data: {
      ok: true,
      version: packageVersion(),
      startedAt,
    },
  }));

  const nodeAgentProcessRoute = nodeAgentApiRoute({
    code: "MANAGED_INSTANCE_CONTROL_FORBIDDEN",
    message: "Instance registration token is required.",
    requireControlled: true,
  });
  app.get("/api/internal/node-agent/process-identity", nodeAgentProcessRoute, async () => ({
    data: {
      instanceId,
      pid: process.pid,
      processNonce: process.env.TASK_HANDOFF_LOCAL_PROCESS_NONCE || "",
      startIdentity: processStartIdentity(process.pid),
    },
  }));

  app.post("/api/internal/node-agent/drain", nodeAgentProcessRoute, async () => {
    appRuntime.beginDrain();
    triggerExecutor.beginDrain();
    triggerManager.stop();
    await appRuntime.stopAll();
    publishAppSessionSnapshot("app-session-updated");
    await refreshAndPublishAiSessions("app-session-updated");
    if (nodeAgentClient.enabled()) {
      await nodeAgentClient.heartbeat().catch((error) => {
        app.log.warn({ err: error }, "failed to publish heartbeat after runtime drain");
      });
    }
    return { data: { drained: true, instanceId } };
  });

  app.post("/api/internal/node-agent/resume", nodeAgentProcessRoute, async () => {
    appRuntime.endDrain();
    triggerExecutor.endDrain();
    triggerManager.start();
    return { data: { resumed: true, instanceId } };
  });

  app.post("/api/internal/node-agent/shutdown", nodeAgentProcessRoute, async (_request, reply) => {
    setImmediate(() => process.kill(process.pid, "SIGTERM"));
    return reply.code(202).send({ data: { accepted: true, instanceId } });
  });

  app.get("/api/auth/status", publicApiRoute, async () => ({
    data: {
      enabled: auth.enabled,
      source: auth.source,
      tokenFile: auth.tokenFile,
    },
  }));

  app.get("/api/events", { websocket: true }, (socket) => {
    events.connect(socket);
    events.send(socket, SessionStreamsHelloEventType, {
      protocolVersion: SESSION_STREAM_PROTOCOL_VERSION,
      streams: [
        {
          topic: "ai.sessions",
          instanceId,
          streamId: aiSessionStreamId,
          latestRevision: aiSessionSnapshotRevision,
          earliestRetainedRevision: aiSessionEventHistory[0]?.payload.meta.revision ?? aiSessionSnapshotRevision + 1,
        },
        {
          topic: "app.sessions",
          instanceId,
          streamId: appSessionStreamId,
          latestRevision: appSessionSnapshotRevision,
          earliestRetainedRevision: appSessionEventHistory[0]?.payload.meta.revision ?? appSessionSnapshotRevision + 1,
        },
      ],
    });
    events.send(socket, "app.management", appManagement.snapshotEvent());
    void appManagement.refreshSnapshot()
      .then(() => appManagement.publishSnapshot())
      .catch((error) => app.log.warn({ err: error }, "failed to refresh app management ownership for event snapshot"));
  });

  app.get("/api/status", async () => {
    return {
      data: {
        version: packageVersion(),
        startedAt,
        runningAppCount: appRuntime.runningSessionCount(),
        storage: storagePaths,
      },
    };
  });

  app.get("/api/instance/status", async () => {
    const snapshot = await controlledInstanceSnapshot(
      appRuntime,
      storagePaths,
      aiSessions,
      triggers,
      aiSessionController.timelineCapabilities(),
    );
    return {
      data: {
        id: process.env.TASK_HANDOFF_INSTANCE_ID,
        name: process.env.TASK_HANDOFF_INSTANCE_NAME || os.hostname(),
        ...snapshot,
        startedAt,
      },
    };
  });

  app.get("/api/instance/capabilities", async () => ({
    data: controlledInstanceCapabilities(appRuntime, aiSessionController.timelineCapabilities()),
  }));

  app.get("/api/workspace/status", async () => ({
    data: workspaceStatus(storagePaths),
  }));

  app.get<{ Querystring: { streamId?: string; sinceRevision?: string } }>("/api/ai-sessions", async (request, reply) => {
    const sinceRevision = request.query.sinceRevision === undefined ? undefined : Number(request.query.sinceRevision);
    if (Number.isInteger(sinceRevision) && sinceRevision >= 0) {
      if (!request.query.streamId) return reply.code(400).send({ error: { code: "AI_SESSION_DELTA_INVALID", message: "streamId is required with sinceRevision." } });
      return { data: aiSessionDeltaSince(request.query.streamId, sinceRevision) };
    }
    return { data: {
      streamId: aiSessionStreamId,
      revision: aiSessionSnapshotRevision,
      lastEventAt: aiSessionEventHistory.at(-1)?.payload.meta.generatedAt || startedAt,
      snapshot: lastAiSessionSnapshot,
    } };
  });

  app.get("/api/ai-sessions/state", async () => ({
    data: {
      streamId: aiSessionStreamId,
      revision: aiSessionSnapshotRevision,
      lastEventAt: aiSessionEventHistory.at(-1)?.payload.meta.generatedAt || startedAt,
      snapshot: lastAiSessionSnapshot,
    },
  }));

  app.get("/api/triggers", async () => ({
    data: triggers.list(),
  }));

  app.get<{ Params: { configHash: string } }>("/api/triggers/:configHash", async (request, reply) => {
    const entry = triggers.get(request.params.configHash);
    return entry ? { data: entry } : reply.code(404).send({ error: { code: "TRIGGER_NOT_FOUND", message: "Trigger not found." } });
  });

  app.post<{ Body: unknown }>("/api/triggers", async (request, reply) => {
    try {
      const body = TriggerCreateSchema.parse(request.body || {}) as TriggerCreateInput;
      const created = triggers.create(body);
      triggerManager.restart();
      events.publish("trigger.created", created);
      events.publish("trigger.updated", triggerSnapshot(triggers));
      return { data: created };
    } catch (error: unknown) {
      return reply.code(400).send({ error: { code: "TRIGGER_INVALID", message: appLaunchInvalidMessage(error) } });
    }
  });

  app.patch<{ Params: { configHash: string }; Body: unknown }>("/api/triggers/:configHash", async (request, reply) => {
    try {
      const body = TriggerPatchSchema.parse(request.body || {});
      const updated = triggers.patch(request.params.configHash, body);
      if (!updated) {
        return reply.code(404).send({ error: { code: "TRIGGER_NOT_FOUND", message: "Trigger not found." } });
      }
      triggerManager.restart();
      events.publish("trigger.updated", triggers.get(request.params.configHash));
      return { data: updated };
    } catch (error: unknown) {
      return reply.code(400).send({ error: { code: "TRIGGER_INVALID", message: appLaunchInvalidMessage(error) } });
    }
  });

  app.delete<{ Params: { configHash: string } }>("/api/triggers/:configHash", async (request, reply) => {
    const deleted = triggers.delete(request.params.configHash);
    if (!deleted) {
      return reply.code(404).send({ error: { code: "TRIGGER_NOT_FOUND", message: "Trigger not found." } });
    }
    triggerManager.restart();
    events.publish("trigger.deleted", { configHash: request.params.configHash });
    events.publish("trigger.updated", triggerSnapshot(triggers));
    return { data: { deleted } };
  });

  app.delete<{ Params: { configHash: string; deploymentId: string } }>("/api/triggers/:configHash/deployments/:deploymentId", async (request, reply) => {
    const deleted = triggers.deleteDeployment(request.params.configHash, request.params.deploymentId);
    if (!deleted) {
      return reply.code(404).send({ error: { code: "TRIGGER_DEPLOYMENT_NOT_FOUND", message: "Trigger deployment not found." } });
    }
    triggerManager.restart();
    events.publish("trigger.deployment.deleted", { configHash: request.params.configHash, deploymentId: request.params.deploymentId });
    events.publish("trigger.updated", triggerSnapshot(triggers));
    return { data: { deleted } };
  });

  app.post<{ Params: { configHash: string } }>("/api/triggers/:configHash/enable", async (request, reply) => {
    const updated = triggers.setEnabled(request.params.configHash, true);
    if (!updated) {
      return reply.code(404).send({ error: { code: "TRIGGER_NOT_FOUND", message: "Trigger not found." } });
    }
    triggerManager.restart();
    events.publish("trigger.enabled", updated);
    events.publish("trigger.updated", triggerSnapshot(triggers));
    return { data: updated };
  });

  app.post<{ Params: { configHash: string } }>("/api/triggers/:configHash/disable", async (request, reply) => {
    const updated = triggers.setEnabled(request.params.configHash, false);
    if (!updated) {
      return reply.code(404).send({ error: { code: "TRIGGER_NOT_FOUND", message: "Trigger not found." } });
    }
    triggerManager.restart();
    events.publish("trigger.disabled", updated);
    events.publish("trigger.updated", triggerSnapshot(triggers));
    return { data: updated };
  });

  app.post<{ Params: { configHash: string }; Body: unknown }>("/api/triggers/:configHash/run", async (request, reply) => {
    try {
      events.publish("trigger.run.started", { configHash: request.params.configHash });
      const result = await runTriggerOnce(triggers, triggerExecutor, request.params.configHash, request.body || {});
      events.publish("trigger.run.completed", result);
      events.publish("trigger.updated", triggerSnapshot(triggers));
      return { data: result };
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "TRIGGER_RUN_FAILED";
      events.publish("trigger.run.failed", { configHash: request.params.configHash, error: appLaunchInvalidMessage(error) });
      return reply.code(code === "TRIGGER_NOT_FOUND" ? 404 : 400).send({
        error: { code, message: appLaunchInvalidMessage(error) },
      });
    }
  });

  app.get("/api/triggers/runs", async () => ({
    data: triggers.list().recentRuns,
  }));

  app.get("/api/ai-sessions/history", async () => ({
    data: AiSessionHistoryListSchema.parse({ items: aiSessionHistory.list() }),
  }));

  app.get<{ Params: { id: string } }>("/api/ai-sessions/history/:id", async (request, reply) => {
    const detail = aiSessionHistory.detail(request.params.id);
    if (!detail) {
      return reply.code(404).send({ error: AiSessionControlErrorSchema.parse({
        code: "AI_SESSION_HISTORY_NOT_FOUND",
        message: "AI session history entry not found.",
      }) });
    }
    return { data: AiSessionHistoryDetailSchema.parse(detail) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/resume", async (request, reply) => {
    try {
      z.object({}).strict().parse(request.body || {});
      const result = AiSessionResumeResultSchema.parse(await aiSessionResume.resume(request.params.id));
      await refreshAndPublishAiSessions("control-action");
      return { data: result };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/ai-sessions", { bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
    try {
      const body = AiSessionCreateInputSchema.parse(request.body || {});
      const result = AiSessionCreateResultSchema.parse(await aiSessionCreate.create({
        ...body,
        cwd: body.cwd.path,
      }));
      publishAiSessionSnapshot("control-action");
      return { data: result };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/fork", async (request, reply) => {
    try {
      const body = AiSessionForkInputSchema.parse(request.body || {});
      const result = AiSessionForkResultSchema.parse(await aiSessionFork.fork(request.params.id, body));
      publishAiSessionSnapshot("control-action");
      return { data: result };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/open-app", async (request, reply) => {
    try {
      AiSessionOpenAppInputSchema.parse(request.body || {});
      const result = AiSessionOpenAppResultSchema.parse(await aiSessionOpenApp.open(request.params.id));
      await refreshAndPublishAiSessions("control-action");
      return { data: result };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/close", async (request, reply) => {
    try {
      AiSessionCloseInputSchema.parse(request.body || {});
      const result = AiSessionCloseResultSchema.parse(await aiSessionClose.close(request.params.id));
      publishAiSessionSnapshot("control-action");
      return { data: result };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/ai-sessions/:id", async (request, reply) => {
    const session = aiSessions.get(request.params.id);
    return session ? { data: session } : reply.code(404).send({ error: { code: "AI_SESSION_NOT_FOUND", message: "AI session not found." } });
  });

  app.get<{ Params: { id: string } }>("/api/ai-sessions/:id/timeline", async (request, reply) => {
    try {
      return { data: AiSessionTimelineSchema.parse(await aiSessionController.timeline(request.params.id)) };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.get<{ Params: { id: string; turnId: string } }>("/api/ai-sessions/:id/turns/:turnId/timeline", async (request, reply) => {
    try {
      return { data: AiSessionTurnTimelineSchema.parse(await aiSessionController.turnTimeline(request.params.id, request.params.turnId)) };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { afterTurnId?: string; afterRevision?: string } }>("/api/ai-sessions/:id/turns", async (request, reply) => {
    const session = aiSessions.get(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: { code: "AI_SESSION_NOT_FOUND", message: "AI session not found." } });
    }
    const afterTurnId = String(request.query.afterTurnId || "").trim();
    const afterRevision = Number(request.query.afterRevision);
    const turns = session.turns || [];
    const afterIndex = afterTurnId ? turns.findIndex((entry) => entry.id === afterTurnId) : -1;
    const filtered = turns.filter((turn) => {
      if (!afterTurnId) {
        return true;
      }
      if (afterIndex < 0) {
        return true;
      }
      if (turn.id !== afterTurnId) {
        return turns.findIndex((entry) => entry.id === turn.id) > afterIndex;
      }
      return Number.isFinite(afterRevision) ? turn.revision > afterRevision : false;
    });
    const last = filtered.at(-1);
    return {
      data: {
        sessionId: session.id,
        turns: filtered,
        nextCursor: last ? { turnId: last.id, revision: last.revision } : afterTurnId ? { turnId: afterTurnId, revision: Number.isFinite(afterRevision) ? afterRevision : 0 } : undefined,
      },
    };
  });

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>("/api/ai-sessions/:id/transcript", async (request, reply) => {
    const session = aiSessions.get(request.params.id);
    if (!session?.transcriptPath) {
      return reply.code(404).send({ error: { code: "AI_SESSION_TRANSCRIPT_NOT_FOUND", message: "AI session transcript not found." } });
    }
    try {
      return { data: tailTextFile(session.transcriptPath, Number(request.query.tail) || 200) };
    } catch (error) {
      return reply.code(404).send({ error: { code: "AI_SESSION_TRANSCRIPT_NOT_READABLE", message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/messages", { bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
    try {
      const body = AiSessionMessageInputSchema.parse(request.body || {});
      const result = AiSessionActionResultSchema.parse(await aiSessionController.sendMessage(request.params.id, body));
      publishAiSessionSnapshot("control-action");
      return { data: result };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/ai-sessions/:id/mentions", async (request, reply) => {
    const session = aiSessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: { code: "AI_SESSION_NOT_FOUND", message: "AI session not found." } });
    try {
      return { data: await codexAppServer.mentionCatalog(session) };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/mentions/files", async (request, reply) => {
    const session = aiSessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: { code: "AI_SESSION_NOT_FOUND", message: "AI session not found." } });
    try {
      const input = AiSessionMentionFileSearchInputSchema.parse(request.body || {});
      return { data: await codexAppServer.searchMentionFiles(session, input.query) };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/commands", async (request, reply) => {
    const session = aiSessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: { code: "AI_SESSION_NOT_FOUND", message: "AI session not found." } });
    try {
      const input = AiSessionCommandInputSchema.parse(request.body || {});
      const result = AiSessionCommandResultSchema.parse(await codexAppServer.executeCommand(session, input));
      publishAiSessionSnapshot("control-action");
      return { data: result };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/ai-sessions/:id/queue", async (request, reply) => {
    const session = aiSessions.get(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: { code: "AI_SESSION_NOT_FOUND", message: "AI session not found." } });
    }
    return { data: session.queue };
  });

  app.post<{ Params: { id: string; queueId: string } }>("/api/ai-sessions/:id/queue/:queueId/steer", async (request, reply) => {
    try {
      const result = AiSessionActionResultSchema.parse(await aiSessionController.steerQueuedMessage(request.params.id, request.params.queueId));
      publishAiSessionSnapshot("control-action");
      return { data: result };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.post<{ Params: { id: string; queueId: string } }>("/api/ai-sessions/:id/queue/:queueId/retry", async (request, reply) => {
    try {
      const session = aiSessionController.retryQueuedMessage(request.params.id, request.params.queueId);
      publishAiSessionSnapshot("control-action");
      return { data: session };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.delete<{ Params: { id: string; queueId: string } }>("/api/ai-sessions/:id/queue/:queueId", async (request, reply) => {
    try {
      const session = aiSessionController.removeQueuedMessage(request.params.id, request.params.queueId);
      publishAiSessionSnapshot("control-action");
      return { data: session };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.patch<{ Params: { id: string; queueId: string }; Body: unknown }>("/api/ai-sessions/:id/queue/:queueId", async (request, reply) => {
    try {
      const body = AiSessionQueueEditInputSchema.parse(request.body || {});
      const session = aiSessionController.editQueuedMessage(request.params.id, request.params.queueId, body.expectedRevision, body.message);
      publishAiSessionSnapshot("control-action");
      return { data: session };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/queue/reorder", async (request, reply) => {
    try {
      const body = AiSessionQueueReorderInputSchema.parse(request.body || {});
      const session = aiSessionController.reorderQueuedMessages(request.params.id, body.expectedRevision, body.queueIds);
      publishAiSessionSnapshot("control-action");
      return { data: session };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/ai-sessions/:id/interrupt", async (request, reply) => {
    try {
      const result = AiSessionActionResultSchema.parse(await aiSessionController.interrupt(request.params.id));
      publishAiSessionSnapshot("control-action");
      return { data: result };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/ai-sessions/:id/approval", async (request, reply) => {
    try {
      const body = AiSessionApprovalInputSchema.parse(request.body || {});
      const result = AiSessionActionResultSchema.parse(await aiSessionController.resolveApproval(request.params.id, body.decision));
      publishAiSessionSnapshot("control-action");
      return { data: result };
    } catch (error: unknown) {
      return sendAiSessionControlError(reply, error);
    }
  });

  app.get("/api/diagnostics", async () => ({
    data: {
      ...runtimeDiagnostics(storagePaths, noVncRoot),
      sessionStreams: {
        ai: {
          streamId: aiSessionStreamId,
          revision: aiSessionSnapshotRevision,
          retainedEventCount: aiSessionEventHistory.length,
          discoveryUnchanged: streamDiagnostics.aiDiscoveryUnchanged,
          discoveryCorrections: streamDiagnostics.aiDiscoveryCorrections,
          messageDeltaCoalescing: {
            windowMs: aiSessionMessageDeltas.windowMs,
            pendingMessageCount: aiSessionMessageDeltas.pendingCount,
            ...aiSessionMessageDeltas.diagnostics(),
          },
        },
        app: {
          streamId: appSessionStreamId,
          revision: appSessionSnapshotRevision,
          retainedEventCount: appSessionEventHistory.length,
          unchangedRefreshes: streamDiagnostics.appUnchanged,
        },
      },
    },
  }));

  app.get("/api/apps/catalog", async () => ({
    data: appRuntime.catalog(),
  }));

  app.get("/api/apps/management", async () => ({
    data: await appManagement.refreshSnapshot(),
  }));

  const appManagementError = (reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, error: unknown) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: { code: "app_management_input_invalid", message: appLaunchInvalidMessage(error) } });
    }
    if (error instanceof AppManagementRequestError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    }
    return reply.code(500).send({ error: { code: "app_management_failed", message: error instanceof Error ? error.message : String(error) } });
  };

  app.post<{ Params: { appId: string }; Body: unknown }>("/api/apps/:appId/install", async (request, reply) => {
    try {
      const input = AppManagementOperationRequestSchema.parse(request.body || {});
      await appManagement.refreshSnapshot();
      return reply.code(202).send({ data: { job: appManagement.request(request.params.appId, "install", input.requestId) } });
    } catch (error) {
      return appManagementError(reply, error);
    }
  });

  app.post<{ Params: { appId: string }; Body: unknown }>("/api/apps/:appId/uninstall", async (request, reply) => {
    try {
      const input = AppManagementOperationRequestSchema.parse(request.body || {});
      await appManagement.refreshSnapshot();
      return reply.code(202).send({ data: { job: appManagement.request(request.params.appId, "uninstall", input.requestId) } });
    } catch (error) {
      return appManagementError(reply, error);
    }
  });

  app.get<{ Params: { jobId: string } }>("/api/apps/jobs/:jobId", async (request, reply) => {
    try {
      return { data: { job: appManagement.getJob(request.params.jobId) } };
    } catch (error) {
      return appManagementError(reply, error);
    }
  });

  app.put<{ Body: unknown }>("/api/internal/model-environment", nodeAgentApiRoute({
    code: "MANAGED_MODEL_ENVIRONMENT_FORBIDDEN",
    message: "Instance registration token is required.",
  }), async (request) => {
    const next = ManagedModelEnvironmentSchema.parse(request.body || {});
    for (const key of MANAGED_MODEL_ENV_KEYS) delete managedModelEnv[key];
    Object.assign(managedModelEnv, next);
    const codex = applyManagedCodexModelConfig(managedModelEnv);
    const claude = applyManagedClaudeModelConfig(managedModelEnv);
    appRuntime.replaceManagedEnvironment(managedAppEnvironment(managedModelEnv));
    return { data: {
      applied: true,
      codexAuthConfigured: Boolean(next.OPENAI_API_KEY),
      claudeAuthConfigured: Boolean(next.ANTHROPIC_API_KEY),
      configUpdated: codex.applied || claude.applied,
    } };
  });

  app.get("/api/config-sync/presets", async () => ({
    data: configSyncPresets(),
  }));

  app.get("/api/config-sync/programs", async () => ({
    data: configSyncPrograms(),
  }));

  app.get<{ Querystring: unknown }>("/api/config-sync/folders", async (request, reply) => {
    const query = z.object({
      path: z.string().trim().max(1000).optional(),
      depth: z.coerce.number().int().min(0).max(2).default(0),
    }).strict().parse(request.query || {});
    try {
      return { data: listConfigSyncFolders(query.path, query.depth) };
    } catch (error: unknown) {
      const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
      return reply.code(typeof record.statusCode === "number" ? record.statusCode : 500).send({
        error: {
          code: typeof record.code === "string" ? record.code : "CONFIG_SYNC_FOLDER_LIST_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  app.post<{ Body: unknown }>("/api/config-sync", async (request, reply) => {
    try {
      const input = ConfigSyncRequestSchema.parse(request.body || {});
      const result = runConfigSyncBatch(input);
      if (input.direction === "import") {
        if (input.programIds.includes("codex")) applyManagedCodexModelConfig(managedModelEnv);
        if (input.programIds.includes("claude")) applyManagedClaudeModelConfig(managedModelEnv);
      }
      return { data: result };
    } catch (error: unknown) {
      const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
      return reply.code(typeof record.statusCode === "number" ? record.statusCode : 500).send({
        error: {
          code: typeof record.code === "string" ? record.code : "CONFIG_SYNC_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  app.post<{ Params: { direction: "import" | "export"; preset: string } }>("/api/config-sync/:direction/:preset", async (request, reply) => {
    const direction = request.params.direction;
    if (direction !== "import" && direction !== "export") {
      return reply.code(400).send({ error: { code: "CONFIG_SYNC_DIRECTION_INVALID", message: "Config sync direction must be import or export." } });
    }
    try {
      const body = ConfigSyncLegacyRequestSchema.parse(request.body || {});
      const result = runConfigSync(direction, request.params.preset, body.preset);
      if (direction === "import" && request.params.preset === "codex") {
        applyManagedCodexModelConfig(managedModelEnv);
      }
      if (direction === "import" && request.params.preset === "claude") {
        applyManagedClaudeModelConfig(managedModelEnv);
      }
      return { data: result };
    } catch (error: unknown) {
      const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
      return reply.code(typeof record.statusCode === "number" ? record.statusCode : 500).send({
        error: {
          code: typeof record.code === "string" ? record.code : "CONFIG_SYNC_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  app.get("/api/apps/catalog/custom", async (_request, reply) => {
    const custom = appRuntime.customCatalog();
    if (custom.error || !custom.data) {
      return reply.code(400).send({ error: custom.error || { code: "APP_CATALOG_INVALID", message: "Custom app catalog is invalid." } });
    }
    return { data: custom.data };
  });

  app.patch<{ Body: { items?: AppCatalogItem[] } }>("/api/apps/catalog/custom", async (request, reply) => {
    try {
      return { data: appRuntime.saveCustomCatalog(request.body?.items || []) };
    } catch (error: unknown) {
      return reply.code(400).send({ error: { code: "APP_CATALOG_INVALID", message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.get<{ Querystring: { streamId?: string; sinceRevision?: string } }>("/api/apps/sessions", async (request, reply) => {
    if (request.query.sinceRevision !== undefined) {
      const sinceRevision = Number(request.query.sinceRevision);
      if (!Number.isInteger(sinceRevision) || sinceRevision < 0) {
        return reply.code(400).send({ error: { code: "APP_SESSION_DELTA_INVALID", message: "sinceRevision must be a non-negative integer." } });
      }
      if (!request.query.streamId) return reply.code(400).send({ error: { code: "APP_SESSION_DELTA_INVALID", message: "streamId is required with sinceRevision." } });
      return { data: appSessionDeltaSince(request.query.streamId, sinceRevision) };
    }
    return { data: {
      streamId: appSessionStreamId,
      revision: appSessionSnapshotRevision,
      lastEventAt: appSessionEventHistory.at(-1)?.payload.meta.generatedAt || startedAt,
      snapshot: activeAppSessionsSnapshotFromRecords(appRuntime.listSessions() as unknown as Array<Record<string, unknown>>),
    } };
  });

  app.get("/api/apps/sessions/state", async () => ({
    data: {
      streamId: appSessionStreamId,
      revision: appSessionSnapshotRevision,
      lastEventAt: appSessionEventHistory.at(-1)?.payload.meta.generatedAt || startedAt,
      snapshot: activeAppSessionsSnapshotFromRecords(appRuntime.listSessions() as unknown as Array<Record<string, unknown>>),
    },
  }));

  app.post<{ Body: AppLaunchRequestBody }>("/api/apps/sessions", async (request, reply) => {
    try {
      const launch = appLaunchRequest(request.body);
      return { data: appRuntime.start(launch.appId, launch.options) };
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: { code: "APP_LAUNCH_INVALID", message: appLaunchInvalidMessage(error) } });
      }
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "APP_LAUNCH_FAILED";
      return reply.code(code === "APP_NOT_FOUND" ? 404 : 400).send({ error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.get<{ Params: { id: string } }>("/api/apps/sessions/:id", async (request, reply) => {
    const session = appRuntime.getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: { code: "APP_SESSION_NOT_FOUND", message: "App session not found." } });
    }
    return { data: session };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/apps/sessions/:id", async (request, reply) => {
    try {
      const { title } = AppSessionRenameSchema.parse(request.body || {});
      return { data: appRuntime.rename(request.params.id, title) };
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: { code: "APP_SESSION_UPDATE_INVALID", message: appLaunchInvalidMessage(error) } });
      }
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "APP_SESSION_UPDATE_FAILED";
      return reply.code(code === "APP_SESSION_NOT_FOUND" ? 404 : 400).send({ error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.post<{ Params: { id: string } }>("/api/apps/sessions/:id/stop", async (request, reply) => {
    try {
      const closed = await aiSessionClose.closeForAppSession(request.params.id);
      if (closed) {
        publishAiSessionSnapshot("control-action");
      }
      const session = closed
        ? appRuntime.getSession(request.params.id)
        : appRuntime.stop(request.params.id);
      return { data: AppSessionRecordSchema.parse(session) };
    } catch (error: unknown) {
      return reply.code(404).send({ error: { code: "APP_SESSION_NOT_FOUND", message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.post<{ Params: { id: string } }>("/api/apps/sessions/:id/restart", async (request, reply) => {
    try {
      return { data: appRuntime.restart(request.params.id) };
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "APP_RESTART_FAILED";
      return reply.code(code === "APP_SESSION_NOT_FOUND" ? 404 : 400).send({ error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/apps/sessions/:id/display", async (request, reply) => {
    try {
      return { data: appRuntime.resizeDisplay(request.params.id, AppDisplaySchema.parse(request.body || {})) };
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "APP_DISPLAY_RESIZE_FAILED";
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: { code: "APP_DISPLAY_INVALID", message: appLaunchInvalidMessage(error) } });
      }
      return reply.code(code === "APP_DISPLAY_NOT_FOUND" ? 404 : 400).send({ error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/apps/sessions/:id", async (request, reply) => {
    try {
      return { data: await appRuntime.delete(request.params.id) };
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "APP_DELETE_FAILED";
      return reply.code(code === "APP_SESSION_NOT_FOUND" ? 404 : 400).send({ error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { maxBytes?: string } }>("/api/apps/sessions/:id/logs", async (request, reply) => {
    try {
      const requestedMaxBytes = Number(request.query.maxBytes || 64 * 1024);
      const maxBytes = Number.isFinite(requestedMaxBytes) ? Math.min(Math.max(1024, requestedMaxBytes), 512 * 1024) : 64 * 1024;
      return { data: appRuntime.readLogs(request.params.id, maxBytes) };
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "APP_LOGS_FAILED";
      return reply.code(code === "APP_SESSION_NOT_FOUND" ? 404 : 400).send({ error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.get<{ Params: { id: string } }>("/api/apps/sessions/:id/screenshot", async (request, reply) => {
    try {
      const image = appRuntime.screenshot(request.params.id);
      return reply.header("Cache-Control", "no-store").type("image/png").send(image);
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "APP_SCREENSHOT_FAILED";
      const statusCode = code === "APP_SESSION_NOT_FOUND" ? 404 : code === "APP_SCREENSHOT_UNAVAILABLE" ? 409 : 400;
      return reply.code(statusCode).send({ error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.get<{ Params: { id: string } }>("/api/apps/sessions/:id/snapshot", async (request, reply) => {
    try {
      const image = appRuntime.screenshot(request.params.id);
      return reply.header("Cache-Control", "no-store").type("image/png").send(image);
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "APP_SNAPSHOT_FAILED";
      const statusCode = code === "APP_SESSION_NOT_FOUND" ? 404 : code === "APP_SCREENSHOT_UNAVAILABLE" ? 409 : 400;
      return reply.code(statusCode).send({ error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.get<{ Params: { id: string } }>("/api/apps/sessions/:id/automation", async (request, reply) => {
    try {
      return { data: await appRuntime.automationStatus(request.params.id) };
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "APP_AUTOMATION_FAILED";
      const statusCode = code === "APP_SESSION_NOT_FOUND" ? 404 : code === "APP_AUTOMATION_UNAVAILABLE" ? 409 : 400;
      return reply.code(statusCode).send({ error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.get<{ Params: { id: string } }>("/api/apps/sessions/:id/tty", { websocket: true }, (socket, request) => {
    appRuntime.attachTty(request.params.id, socket);
  });

  app.get<{ Params: { id: string } }>("/api/apps/sessions/:id/vnc", { websocket: true }, (socket, request) => {
    const target = appRuntime.vncTarget(request.params.id);
    if (!target) {
      socket.send(JSON.stringify({ error: { code: "VNC_SESSION_NOT_FOUND", message: "VNC session not found." } }));
      socket.close();
      return;
    }
    const upstream = net.connect(target.port, target.host);
    upstream.on("data", (chunk) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(chunk);
      }
    });
    upstream.on("close", () => socket.close());
    upstream.on("error", () => socket.close());
    socket.on("message", (message) => {
      upstream.write(websocketMessageToBuffer(message));
    });
    socket.on("close", () => upstream.destroy());
  });

  const webSocketProxyHandler = (socket: { send: (data: unknown, options?: { binary?: boolean }) => void; close: () => void; on: (event: "message" | "close" | "error", listener: (message?: unknown, isBinary?: boolean) => void) => void; readyState: number; OPEN: number }, request: { params: { id: string }; raw: { url?: string }; headers: http.IncomingHttpHeaders }) => {
    const target = appRuntime.webTarget(request.params.id);
    if (!target) {
      socket.send(JSON.stringify({ error: { code: "WEB_SESSION_NOT_FOUND", message: "Web session not found." } }));
      socket.close();
      return;
    }
    const upstreamOrigin = `http://${target.host}:${target.port}`;
    const extraHeaders = appRuntime.getSession(request.params.id)?.vnc?.backend === "kasmvnc"
      ? {
          authorization: kasmVncAuthorizationHeader(),
          origin: upstreamOrigin,
          "sec-websocket-origin": request.headers.origin || upstreamOrigin,
        }
      : { origin: upstreamOrigin };
    const startedAt = Date.now();
    const upstreamUrl = `ws://${target.host}:${target.port}${proxyPath(request.params.id, request.raw.url)}`;
    const upstreamProtocols = proxyWebSocketProtocols(request.headers) || (appRuntime.getSession(request.params.id)?.vnc?.backend === "kasmvnc" ? ["binary"] : undefined);

    const connect = () => {
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      const upstream = new WebSocketClient(upstreamUrl, upstreamProtocols, {
        headers: proxyWebSocketHeaders(request.headers, target.host, target.port, extraHeaders),
      });
      bridgeWebSockets(socket, upstream, {
        onUpstreamCloseBeforeOpen: () => {
          if (Date.now() - startedAt < WEB_PROXY_STARTUP_RETRY_MS) {
            void sleep(WEB_PROXY_STARTUP_RETRY_INTERVAL_MS).then(connect);
            return true;
          }
          return false;
        },
        onUpstreamErrorBeforeOpen: (error) => isRetryableWebProxyError(error),
      });
    };
    connect();
  };

  const webProxyHandler = async (request: { params: { id: string }; raw: http.IncomingMessage; method: string; headers: http.IncomingHttpHeaders; body?: unknown }, reply: { raw: http.ServerResponse; hijack: () => void; code: (statusCode: number) => { send: (payload: unknown) => unknown } }) => {
    const target = appRuntime.webTarget(request.params.id);
    if (!target) {
      return sendProxyError(reply, "WEB_SESSION_NOT_FOUND", "Web session not found.", 404);
    }
    const isKasmVnc = appRuntime.getSession(request.params.id)?.vnc?.backend === "kasmvnc";
    const extraHeaders = isKasmVnc ? { authorization: kasmVncAuthorizationHeader() } : {};
    reply.hijack();
    const requestBody = normalizeProxyRequestBody(request.body);
    const canRetry = requestBody !== undefined || request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
    const startedAt = Date.now();
    const upstreamBase = `http://${target.host}:${target.port}`;
    const upstreamUrl = new URL(proxyPath(request.params.id, request.raw.url), `${upstreamBase}/`).toString();
    for (;;) {
      try {
        const response = await proxyFetch(upstreamBase, upstreamUrl, proxyRequestInit({
          method: request.method,
          headers: proxyHeaders(request.headers, target.host, target.port, extraHeaders),
          requestBody,
          rawRequest: request.raw,
          streamRawRequest: requestBody === undefined && !canRetry,
        }));
        const headers = fetchHeadersToNode(response.headers);
        if (request.method !== "HEAD" && isKasmVnc && shouldThemeKasmVncResponse(headers)) {
          const themedBody = Buffer.from(themeKasmVncResponseBody(Buffer.from(await response.arrayBuffer()), headers), "utf8");
          const outgoingHeaders = { ...headers, "content-length": String(themedBody.byteLength) };
          delete outgoingHeaders.etag;
          reply.raw.writeHead(response.status || 502, response.statusText, outgoingHeaders);
          reply.raw.end(themedBody);
          break;
        }
        reply.raw.writeHead(response.status || 502, response.statusText, fetchHeadersToOutgoing(response.headers));
        if (!response.body || request.method === "HEAD") {
          reply.raw.end();
          break;
        }
        await pipeline(readableFromWebStream(response.body), reply.raw);
        break;
      } catch (error) {
        if (canRetry && isRetryableWebProxyError(error) && Date.now() - startedAt < WEB_PROXY_STARTUP_RETRY_MS) {
          await sleep(WEB_PROXY_STARTUP_RETRY_INTERVAL_MS);
          continue;
        }
        if (reply.raw.headersSent || reply.raw.destroyed) {
          if (!reply.raw.destroyed) {
            reply.raw.destroy(error instanceof Error ? error : undefined);
          }
          break;
        }
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(502, { "content-type": "application/json" });
        }
        reply.raw.end(JSON.stringify({ error: { code: "WEB_PROXY_FAILED", message: error instanceof Error ? error.message : String(error) } }));
        break;
      }
    }
    return reply;
  };

  app.route<{ Params: { id: string } }>({
    method: "GET",
    url: "/api/apps/sessions/:id/web/*",
    wsHandler: webSocketProxyHandler,
    handler: webProxyHandler,
  });

  for (const method of ["DELETE", "OPTIONS", "PATCH", "POST", "PUT"] as const) {
    app.route<{ Params: { id: string } }>({
      method,
      url: "/api/apps/sessions/:id/web/*",
      bodyLimit: 64 * 1024 * 1024,
      handler: webProxyHandler,
    });
  }

  app.get<{ Params: { id: string }; Querystring: { resize?: string } }>("/api/apps/sessions/:id/novnc/vnc.html", async (request, reply) => {
    const session = appRuntime.getSession(request.params.id);
    if (!session?.vnc) {
      return reply.code(404).send({ error: { code: "VNC_SESSION_NOT_FOUND", message: "VNC session not found." } });
    }
    const resize = request.query.resize === "remote" ? "remote" : "scale";
    const params = new URLSearchParams({
      path: session.vnc.webPath.replace(/^\//, ""),
      autoconnect: "1",
      resize,
    });
    return reply.redirect(`/api/novnc/vnc.html?${params.toString()}`);
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found." } });
    }
    const indexPath = path.join(staticDir, "index.html");
    if (fs.existsSync(indexPath)) {
      return reply.type("text/html").send(fs.readFileSync(indexPath, "utf8"));
    }
    return reply.type("text/plain").send("TaskHandoff Web UI has not been built yet. Run pnpm web:build.");
  });

  return app;
}

export async function runWebServer(options: Partial<RunWebServerOptions> = {}) {
  const host = options.host || process.env.TASK_HANDOFF_WEB_HOST || "127.0.0.1";
  const port = Number(options.port || process.env.TASK_HANDOFF_WEB_PORT || 8080);
  const localLock = process.env.TASK_HANDOFF_CONTROL_MODE === "controlled" && process.env.TASK_HANDOFF_RUNTIME_KIND === "local"
    ? acquireLocalControlledInstanceLock({
        instanceId: process.env.TASK_HANDOFF_INSTANCE_ID || "unknown",
        dataDir: process.env.TASK_HANDOFF_DATA_DIR,
        host,
        port,
      }, process.env.TASK_HANDOFF_LOCAL_CONTROLLED_INSTANCE_LOCK_PATH)
    : undefined;
  try {
    const app = await createWebApp(options);
    if (localLock) app.addHook("onClose", async () => localLock.release());
    installGracefulShutdown(app);
    await app.listen({ host, port });
    return app;
  } catch (error) {
    localLock?.release();
    throw error;
  }
}
