import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Transform } from "node:stream";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import type { FastifyServerOptions } from "fastify";
import { z } from "zod";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  ApplyUpdateRequestSchema,
  ControlledInstanceSchema,
  ControlledInstanceHeartbeatSchema,
  ControlledInstanceRegisterSchema,
  InstanceImageSnapshotSchema,
  InstanceResourceMetricsEventType,
  ImagePullTerminalEventType,
  CreateNodeModelSchema,
  DeployNodeModelSchema,
  modelConfigHash,
  NodeModelAssignmentSchema,
  NodeModelConfigSchema,
  NodeModelPublicRecordSchema,
  NodeAgentExternalListenerConfigSchema,
  NodeAgentExternalListenerSchema,
  NodeLocalFolderSchema,
  sanitizeStoredNodeLocalFolder,
  NodeRuntimeSchema,
  NodeSchema,
  ProjectSchema,
  ProjectSourceSchema,
  RuntimeVersionStateSchema,
  sanitizeCrossVersionControlledInstanceHeartbeat,
  sanitizeCrossVersionControlledInstanceRegister,
  WorkspacePolicySchema,
  UpdateCheckRequestSchema,
  UpdateNodeModelAssignmentSchema,
  UpdateNodeModelSchema,
  UpdateNodeAgentExternalListenerSchema,
  safeParseStoredControlledInstance,
  sanitizeStoredControlledInstance,
  type BuildInfo,
  type ControlledInstance,
  type ControlledInstanceHeartbeat,
  type ControlledInstanceRegister,
  type InstanceResourceMetrics,
  type Node,
  type NodeModelAssignment,
  type NodeModelConfig,
  type NodeModelPublicRecord,
  type NodeAgentExternalListener,
  type NodeAgentExternalListenerConfig,
  type NodeLocalFolder,
  type NodeRuntime,
  type Project,
  type RuntimeArtifactIdentity,
  type UpdateCheckResult,
} from "@task-handoff/protocol/control-plane";
import { bridgeWebSockets } from "@task-handoff/protocol/websocket-bridge";
import { defaultCommandRunner, LocalDockerExecutor, listLocalDockerImages, type CommandRunner, type ExecutorContext, type ExecutorStartResult } from "./runtimes/docker.ts";
import { DockerImageService, type DockerImagePhase, type DockerImageTerminalOutput, type ResolvedDockerImage } from "./docker-images.ts";
import { NodeAgentInstanceEventForwarder } from "./events.ts";
import { DockerRuntimeMetricsCollector } from "./runtime-metrics.ts";
import { listFolderTree } from "./folders.ts";
import {
  CreateLocalFolderSchema,
  CreateNodeInstanceSchema,
  CreateNodeRuntimeSchema,
  FolderTreeQuerySchema,
  ProxyRequestSchema,
  UpdateNodeInstanceSchema,
  UpdateNodeRuntimeSchema,
} from "./schemas.ts";
import { nodeAgentStorePaths, type NodeAgentStorePaths } from "./persistence/paths.ts";
import { createId, createSecret, JsonCollection, JsonFile } from "../shared/persistence/store.ts";
import { acquireNodeAgentSingletonLock, defaultNodeAgentSingletonLockPath } from "./process/singleton-lock.ts";
import type { TerminalCommandRunner } from "../shared/process/terminal-command-runner.ts";
import { nodeAgentIpcEndpoint, nodeAgentIpcPath, prepareNodeAgentIpcPath } from "../shared/transport/node-agent-ipc.ts";
import { createNodeAgentHmacHeaders } from "../shared/security/node-agent-auth.ts";
import { nodeAgentProxyMethod, type NodeAgentInjectResponse, websocketPayload } from "./transport/proxy-utils.ts";
import { checkNodeAgentUpdate, npmCommand, NodeUpdateJobs, resolveNodeAgentUpdateWorker } from "./updates.ts";
import { RuntimeArtifactResolver, type ResolvedRuntimeArtifact } from "./runtime-artifacts.ts";
import { resolvePublishedRuntimeArtifact, type PublishedRuntimeArtifact } from "./runtime-release-source.ts";
import { RuntimeConvergenceCoordinator, reportedVersion } from "./runtime-convergence.ts";
import {
  InstanceModelAssignmentStore,
  InstanceModelEnvironmentStore,
  LEGACY_MODEL_ENV_KEYS,
  NodeModelStore,
} from "./models/stores.ts";
import { NodeAgentPairedHmacVerifier } from "./identity/hmac-verifier.ts";
import { NodeAgentPairingCompleteSchema, NodeAgentPairingInviteSchema, NodeAgentRemoteConnectSchema } from "./identity/schemas.ts";
import { assertHttpControlPlaneUrl, completeControlPlaneJoin, NodeAgentIdentityService } from "./identity/service.ts";

declare module "fastify" {
  interface FastifyInstance {
    nodeAgentState?: NodeAgentState;
    nodeAgentEventForwarder?: NodeAgentInstanceEventForwarder;
    nodeAgentRuntimeMetrics?: DockerRuntimeMetricsCollector;
    nodeAgentReverseTunnels?: ReturnType<typeof createReverseTunnelManager>;
    nodeAgentListenerManager?: NodeAgentExternalListenerManager;
    nodeAgentRestoreLocalInstances?: () => Promise<void>;
  }

  interface FastifyRequest {
    nodeAgentAuthKeyId?: string;
  }
}

const DECODED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"]);
const AUTO_IMPORT_AGENT_CONFIG_PRESETS = ["codex", "claude"] as const;
const DEFAULT_AUTO_IMPORT_AGENT_CONFIG_TIMEOUT_MS = 5_000;
const UPDATE_PREFLIGHT_TTL_MS = 10 * 60 * 1_000;
const BUILTIN_LOCAL_RUNTIME_ID = "runtime_local_host";
const BUILTIN_RUNTIME_LABEL = "task-handoff.node-agent.builtin";
const FINAL_COMPUTER_PLATFORMS = new Set(["linux", "darwin", "win32", "freebsd", "openbsd", "aix", "sunos"]);
function finalComputerPlatform(platform: string) {
  return FINAL_COMPUTER_PLATFORMS.has(platform) ? platform : "unknown";
}
function userRuntimeLabels(labels: Record<string, string> | undefined) {
  const sanitized = { ...labels };
  delete sanitized[BUILTIN_RUNTIME_LABEL];
  return sanitized;
}
const NodeAgentRuntimeSettingsSchema = z.object({
  version: z.literal(1),
  externalListener: NodeAgentExternalListenerConfigSchema,
}).strict();

type NodeAgentRuntimeSettings = z.infer<typeof NodeAgentRuntimeSettingsSchema>;

const NodeInstanceLifecycleRequestSchema = z.object({}).strict().default({});

const NodeAgentApplyUpdateRequestSchema = ApplyUpdateRequestSchema.strict();

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
      path.resolve(moduleDir, "..", "..", "package.json"),
    ].find((candidate) => fs.existsSync(candidate));
    if (!packagePath) return "unknown";
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

function buildInfo(component: BuildInfo["component"]): BuildInfo {
  return {
    component,
    packageName: component === "node-agent" ? "@task-handoff/node-agent" : undefined,
    packageVersion: packageVersion(),
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    buildId: optionalEnv("TASK_HANDOFF_BUILD_ID"),
    builtAt: optionalEnv("TASK_HANDOFF_BUILT_AT"),
    gitCommit: optionalEnv("TASK_HANDOFF_GIT_COMMIT"),
    imageRef: optionalEnv("TASK_HANDOFF_IMAGE_REF"),
    imageDigest: optionalEnv("TASK_HANDOFF_IMAGE_DIGEST"),
  };
}

export function runtimeVersionStateForActual(actualVersion?: string) {
  const desiredVersion = packageVersion();
  if (actualVersion === desiredVersion) {
    return {
      desiredVersion,
      actualVersion,
      phase: "matched" as const,
      attempt: 0,
      matchedAt: now(),
    };
  }
  return {
    desiredVersion,
    ...(actualVersion ? { actualVersion } : {}),
    phase: "pending" as const,
    attempt: 0,
    error: {
      code: "INSTANCE_RUNTIME_VERSION_MISMATCH" as const,
      message: `Expected controlled-instance ${desiredVersion}, received ${actualVersion || "an unknown version"}.`,
      expectedVersion: desiredVersion,
      ...(actualVersion ? { actualVersion } : {}),
      retryable: true,
    },
  };
}

function runtimeVersionStateForReport(instance: ControlledInstance, actualVersion?: string, managedArtifacts = true) {
  if (!managedArtifacts) return runtimeVersionStateForActual(actualVersion);
  const desiredVersion = packageVersion();
  const current = instance.runtimeVersion;
  if (!current || current.desiredVersion !== desiredVersion) return runtimeVersionStateForActual(actualVersion);
  return RuntimeVersionStateSchema.parse({
    ...current,
    desiredVersion,
    ...(actualVersion ? { actualVersion } : { actualVersion: undefined }),
    ...(current.phase === "pending" && actualVersion !== desiredVersion
      ? { error: {
          code: "INSTANCE_RUNTIME_VERSION_MISMATCH",
          message: `Expected controlled-instance ${desiredVersion}, received ${actualVersion || "an unknown version"}.`,
          expectedVersion: desiredVersion,
          ...(actualVersion ? { actualVersion } : {}),
          retryable: true,
        } }
      : current.phase === "pending"
        ? { error: undefined }
        : {}),
  });
}

function proxyResponseHeaders(headers: Headers) {
  return Object.fromEntries([...headers.entries()].filter(([key]) => !DECODED_RESPONSE_HEADERS.has(key.toLowerCase())));
}

function proxyRequestBody(parsed: { body?: string; bodyBase64?: string }) {
  return parsed.bodyBase64 ? Buffer.from(parsed.bodyBase64, "base64") : parsed.body;
}

const INSTANCE_PROXY_REQUEST_BODY_LIMIT = 64 * 1024 * 1024;
const DEFAULT_INSTANCE_PROXY_RESPONSE_LIMIT = 64 * 1024 * 1024;

function instanceProxyResponseLimit() {
  const configured = Number(process.env.TASK_HANDOFF_INSTANCE_PROXY_MAX_RESPONSE_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_INSTANCE_PROXY_RESPONSE_LIMIT;
}

async function readResponseBodyWithLimit(response: Response, maxBytes: number) {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let length = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel("Instance proxy response limit exceeded.").catch(() => undefined);
      throw Object.assign(new Error("Instance proxy response limit exceeded."), { code: "INSTANCE_PROXY_RESPONSE_TOO_LARGE" });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

export type CreateNodeAgentAppOptions = {
  token?: string;
  remoteSecret?: string;
  remoteKeyId?: string;
  connectionMode?: "local-ipc" | "local-loopback";
  ipcPath?: string;
  port?: number | string;
  containerUrl?: string;
  nodeId?: string;
  dataDir?: string;
  logger?: FastifyServerOptions["logger"];
  dockerCommandRunner?: CommandRunner;
  dockerTerminalCommandRunner?: TerminalCommandRunner;
  updateCommandRunner?: CommandRunner;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  resolveRuntimeArtifactRelease?: (version: string, platform: string, arch: string) => Promise<PublishedRuntimeArtifact>;
  resolveRuntimeArtifact?: (version: string, platform: string, arch: string) => Promise<ResolvedRuntimeArtifact>;
};

export type RunNodeAgentServerOptions = CreateNodeAgentAppOptions & {
  host: string;
  port: number;
  controlPlaneTunnelUrl?: string;
};

function installGracefulShutdown(app: Awaited<ReturnType<typeof createNodeAgentApp>>, cleanup?: () => void) {
  let closing = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) {
      return;
    }
    closing = true;
    cleanup?.();
    try {
      await app.close();
    } finally {
      process.exitCode = signal ? 0 : process.exitCode;
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
    code: typeof record.code === "string" ? record.code : "NODE_AGENT_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

function bearerToken(headers: Record<string, unknown>) {
  const authorization = headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
}

function isLoopbackAddress(value: unknown) {
  if (typeof value !== "string") {
    return false;
  }
  const address = value.trim().toLowerCase();
  return address === "localhost" || address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isLocalStaticKeyConnection(request: { ip?: string; socket: { remoteAddress?: string; remoteFamily?: string } }) {
  return isLoopbackAddress(request.ip)
    || isLoopbackAddress(request.socket.remoteAddress)
    || (!request.ip && !request.socket.remoteAddress && !request.socket.remoteFamily);
}

function isUnixSocketRequest(request: { ip?: string; socket: { remoteAddress?: string; remoteFamily?: string } }) {
  return !request.ip
    && !request.socket.remoteAddress
    && !request.socket.remoteFamily;
}

function isInstanceReportRoute(url: string) {
  const path = url.split("?")[0];
  return /^\/api\/node-agent\/instances\/[^/]+\/(register|heartbeat)$/.test(path);
}

function isPairingCompleteRoute(url: string) {
  return url.split("?")[0] === "/api/node-agent/pairing/complete";
}

function now() {
  return new Date().toISOString();
}

function splitTerminalOutput(data: string, maxLength = 60_000) {
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length; offset += maxLength) chunks.push(data.slice(offset, offset + maxLength));
  return chunks;
}

function listenerHost(bindScope: NodeAgentExternalListenerConfig["bindScope"]) {
  return bindScope === "all-ipv4" ? "0.0.0.0" as const : "127.0.0.1" as const;
}

function bootstrapListener(host: string, port: number): NodeAgentExternalListenerConfig {
  return NodeAgentExternalListenerConfigSchema.parse({
    bindScope: host.trim() === "0.0.0.0" ? "all-ipv4" : "loopback",
    port,
  });
}

function sanitizeNodeAgentRuntimeSettings(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const listener = source.externalListener && typeof source.externalListener === "object" && !Array.isArray(source.externalListener)
    ? source.externalListener as Record<string, unknown>
    : {};
  const unknownTopLevel = Object.keys(source).filter((key) => key !== "version" && key !== "externalListener");
  const unknownListener = Object.keys(listener).filter((key) => key !== "bindScope" && key !== "port");
  if (unknownTopLevel.length || unknownListener.length) {
    console.warn(JSON.stringify({
      message: "unknown stored node agent runtime setting fields were ignored",
      filePath: "runtime-settings.json",
      fields: [...unknownTopLevel, ...unknownListener.map((key) => `externalListener.${key}`)],
    }));
  }
  return {
    version: source.version,
    externalListener: {
      bindScope: listener.bindScope,
      port: listener.port,
    },
  };
}

function runtimeSettingsFile(paths: NodeAgentStorePaths, defaults: NodeAgentExternalListenerConfig) {
  return new JsonFile<NodeAgentRuntimeSettings>(paths.settingsPath, () => ({ version: 1, externalListener: defaults }), {
    schema: NodeAgentRuntimeSettingsSchema,
    sanitize: sanitizeNodeAgentRuntimeSettings,
  });
}

function envFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function nodeAgentDiagnosticLogsEnabled() {
  return envFlag(process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS);
}

function workspacePolicyForSource(source: Project["source"]) {
  if (source.type === "local-folder") {
    return WorkspacePolicySchema.parse({ mode: "local-bind", path: "/workspace", readOnly: false });
  }
  return WorkspacePolicySchema.parse({ mode: "git-clone", path: "/workspace", readOnly: false });
}

function projectForInstance(instance: ControlledInstance): Project {
  const source = ProjectSourceSchema.parse(instance.source);
  const projectId =
    instance.projectId ||
    (source.type === "local-folder" ? source.localFolderId : undefined) ||
    (source.type === "git-repository" ? source.repositoryId : undefined) ||
    (source.type === "git-template" ? source.templateId : undefined) ||
    `project_${instance.id}`;
  return ProjectSchema.parse({
    id: projectId,
    name: typeof instance.sourceSnapshot.name === "string" ? instance.sourceSnapshot.name : instance.name,
    source,
    defaultImageSelection: instance.imageSelection,
    defaultNodeId: instance.nodeId,
    defaultRuntimeId: instance.runtimeId,
    workspacePolicy: workspacePolicyForSource(source),
    labels: {},
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  });
}

async function probeInstanceEndpoint(fetchImpl: typeof fetch, instance: ControlledInstance) {
  if (!instance.target.web) {
    return "unknown" as const;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetchImpl(`${nodeLocalInstanceWebBase(instance)}/api/health`, { signal: controller.signal });
    return response.ok ? "reachable" as const : "endpoint-unreachable" as const;
  } catch {
    return "endpoint-unreachable" as const;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function autoImportAgentConfig(fetchImpl: typeof fetch, instance: ControlledInstance, action: "start" | "restart", loggers: NodeAgentLifecycleLoggers) {
  if (!instance.config.autoImportAgentConfigs) {
    loggers.diagnostic({ instanceId: instance.id, action }, "node instance config auto-import skipped");
    return;
  }
  if (instance.targetStatus !== "reachable") {
    return;
  }
  const instanceBase = nodeLocalInstanceWebBase(instance);
  const timeoutMs = Number(process.env.TASK_HANDOFF_CONFIG_AUTO_IMPORT_TIMEOUT_MS || DEFAULT_AUTO_IMPORT_AGENT_CONFIG_TIMEOUT_MS);
  for (const preset of AUTO_IMPORT_AGENT_CONFIG_PRESETS) {
    try {
      const response = await fetchWithTimeout(fetchImpl, `${instanceBase}/api/config-sync/import/${encodeURIComponent(preset)}`, { method: "POST" }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_AUTO_IMPORT_AGENT_CONFIG_TIMEOUT_MS);
      if (!response.ok) {
        loggers.warn({ instanceId: instance.id, action, preset, statusCode: response.status }, "node instance config auto-import failed");
        continue;
      }
      loggers.diagnostic({ instanceId: instance.id, action, preset }, "node instance config auto-import completed");
    } catch (error) {
      loggers.warn({ instanceId: instance.id, action, preset, error: error instanceof Error ? error.message : String(error) }, "node instance config auto-import failed");
    }
  }
}

async function syncAssignedModelEnvironment(fetchImpl: typeof fetch, state: NodeAgentState, instanceId: string) {
  const instance = state.requireInstance(instanceId);
  if (instance.targetStatus !== "reachable" || !instance.target.web) return false;
  const response = await fetchWithTimeout(fetchImpl, `${nodeLocalInstanceWebBase(instance)}/api/internal/model-environment`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${instance.registrationToken}`,
    },
    body: JSON.stringify(state.resolvedAssignedModelEnvironment(instanceId)),
  }, DEFAULT_AUTO_IMPORT_AGENT_CONFIG_TIMEOUT_MS);
  if (!response.ok) {
    throw Object.assign(new Error(`Instance ${instanceId} rejected its managed model environment with HTTP ${response.status}.`), {
      statusCode: 502,
      code: "INSTANCE_MODEL_ENVIRONMENT_APPLY_FAILED",
    });
  }
  return true;
}

function nodeLocalInstanceWebBase(instance: ControlledInstance) {
  const webBase = instance.target.web;
  if (!webBase) {
    const error = new Error(`Instance ${instance.id} does not have a web endpoint.`);
    Object.assign(error, { statusCode: 409, code: "NODE_INSTANCE_WEB_ENDPOINT_MISSING" });
    throw error;
  }
  if (instance.target.strategy !== "direct-port") {
    return webBase.replace(/\/$/, "");
  }
  try {
    const url = new URL(webBase);
    if (!url.port) {
      return webBase.replace(/\/$/, "");
    }
    url.hostname = process.env.TASK_HANDOFF_NODE_AGENT_PROXY_HOST || "127.0.0.1";
    return url.toString().replace(/\/$/, "");
  } catch {
    return webBase.replace(/\/$/, "");
  }
}

function proxyWebSocketProtocols(headers: Record<string, unknown>) {
  const value = headers["sec-websocket-protocol"];
  const text = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
  const protocols = text
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  return protocols.length ? protocols : undefined;
}

function throwForbidden(code: string, message: string): never {
  const error = new Error(message);
  Object.assign(error, { statusCode: 403, code });
  throw error;
}

function warnProtocolVersion(protocolVersion: string, peer: string) {
  if (protocolVersion === CONTROL_PLANE_PROTOCOL_VERSION) return;
  console.warn(JSON.stringify({
    message: "protocol version mismatch",
    peer,
    expectedProtocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    actualProtocolVersion: protocolVersion || "missing",
    errorCode: "PROTOCOL_VERSION_MISMATCH",
  }));
}

function storedInstancePayloadError(id: string, issues: Array<{ path: PropertyKey[]; message: string }>) {
  const detail = issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
  const error = new Error(`Stored instance ${id} is not compatible with protocol ${CONTROL_PLANE_PROTOCOL_VERSION}: ${detail}`);
  Object.assign(error, { statusCode: 409, code: "NODE_INSTANCE_PAYLOAD_INVALID" });
  return error;
}

function runtimeRequiresImage(runtime: NodeRuntime) {
  if (typeof runtime.capabilities.requiresImage === "boolean") {
    return runtime.capabilities.requiresImage;
  }
  return runtime.type !== "local";
}

function runtimeUsesManagedArtifacts(runtime: NodeRuntime) {
  return runtime.capabilities.artifactKind !== "none";
}

function localRuntimeCapabilities(capabilities: Record<string, unknown> = {}) {
  return {
    ...capabilities,
    requiresImage: false,
    supportsControlledInstanceApi: true,
    supportsContainerLifecycle: false,
    supportsAppSessions: true,
    supportsHostSessions: true,
    artifactKind: "none",
    isolation: "none",
  };
}

function defaultAccessStrategyForRuntime(type: NodeRuntime["type"]) {
  if (type === "docker") {
    return "direct-port" as const;
  }
  return "node-proxy" as const;
}

function localWorkspacePath(instance: ControlledInstance) {
  if (instance.source.type !== "local-folder") {
    const error = new Error("Localhost runtime currently supports local folder sources only.");
    Object.assign(error, { statusCode: 400, code: "LOCAL_RUNTIME_REQUIRES_LOCAL_FOLDER" });
    throw error;
  }
  return path.resolve(instance.source.path);
}

function configuredLocalControlledCommand() {
  const value = process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV?.trim();
  if (!value) {
    const command = process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND?.trim();
    return command ? command.split(/\s+/) : undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw Object.assign(new Error("TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV must be valid JSON."), { code: "LOCAL_CONTROLLED_COMMAND_INVALID" });
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => typeof item !== "string" || !item)) {
    throw Object.assign(new Error("TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV must be a non-empty string array."), { code: "LOCAL_CONTROLLED_COMMAND_INVALID" });
  }
  return parsed as string[];
}

function localControlledInstanceCommand(configured?: string[]) {
  if (configured) return configured;
  const repositoryCli = path.resolve(process.cwd(), "bin", "task-handoff.js");
  if (fs.existsSync(repositoryCli)) return [process.execPath, repositoryCli, "web"];
  throw Object.assign(
    new Error("The bundled controlled-instance command is unavailable."),
    { statusCode: 500, code: "LOCAL_CONTROLLED_COMMAND_MISSING" },
  );
}

async function allocateLocalPort() {
  const configured = Number(process.env.TASK_HANDOFF_LOCAL_INSTANCE_PORT_START || 19000);
  const start = Number.isInteger(configured) && configured > 0 ? configured : 19000;
  for (let port = start; port < start + 1000 && port <= 65535; port += 1) {
    if (await canListen(port)) {
      return port;
    }
  }
  const error = new Error(`No free localhost port found in range ${start}-${Math.min(start + 999, 65535)}.`);
  Object.assign(error, { statusCode: 503, code: "LOCAL_INSTANCE_PORT_UNAVAILABLE" });
  throw error;
}

function canListen(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs = 3_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, timeoutMs);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForChildSpawn(child: ChildProcessWithoutNullStreams) {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function stopLocalProcess(instance: ControlledInstance, processByInstanceId: Map<string, ChildProcessWithoutNullStreams>) {
  const child = processByInstanceId.get(instance.id);
  if (child && !child.killed) {
    child.kill("SIGTERM");
    processByInstanceId.delete(instance.id);
    await waitForChildExit(child);
    return;
  }
  if (instance.runtime.pid) {
    try {
      process.kill(instance.runtime.pid, "SIGTERM");
    } catch {
      // Process already exited.
      return;
    }
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      try {
        process.kill(instance.runtime.pid, 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      process.kill(instance.runtime.pid, "SIGKILL");
    } catch {
      // Process exited after the final liveness check.
    }
  }
}

const RESTORABLE_LOCAL_INSTANCE_STATUSES = new Set<ControlledInstance["status"]>(["provisioning", "starting", "registering", "registered", "running"]);

async function waitForLocalInstanceHealth(web: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${web}/api/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Keep waiting until the controlled-instance process has bound its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function commandVersion(runCommand: CommandRunner, command: string) {
  try {
    const result = await runCommand(command, ["--version"]);
    return {
      available: true,
      command,
      version: (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() || undefined,
    };
  } catch {
    return { available: false };
  }
}

function runtimeArtifactIdentityMatches(actual: Partial<RuntimeArtifactIdentity>, expected: RuntimeArtifactIdentity) {
  return actual.packageName === expected.packageName
    && actual.version === expected.version
    && actual.platform === expected.platform
    && actual.arch === expected.arch
    && actual.formatVersion === expected.formatVersion
    && actual.launcherAbi === expected.launcherAbi
    && actual.entrypoint === expected.entrypoint
    && actual.sha256 === expected.sha256;
}

type RuntimeAdapter = {
  start(context: ExecutorContext): Promise<ExecutorStartResult>;
  stop(context: ExecutorContext): Promise<ExecutorStartResult>;
  restart(context: ExecutorContext): Promise<ExecutorStartResult>;
  delete(context: ExecutorContext): Promise<ExecutorStartResult>;
  managedArtifacts?: boolean;
  check?(runtime: NodeRuntime): Promise<Partial<NodeRuntime>>;
};

type ManagedRuntimeAdapter = RuntimeAdapter & {
  managedArtifacts: true;
  artifactTarget(context?: ExecutorContext): Promise<{ platform: string; arch: string; launcherAbi: number }>;
  installRuntime(context: ExecutorContext, artifact: ResolvedRuntimeArtifact): Promise<void>;
  inspectRuntime(context: ExecutorContext, expected: RuntimeArtifactIdentity): Promise<boolean>;
  rollbackRuntime(context: ExecutorContext, previousVersion?: string): Promise<void>;
};

function isManagedRuntimeAdapter(adapter: RuntimeAdapter): adapter is ManagedRuntimeAdapter {
  return adapter.managedArtifacts === true;
}

class DockerRuntimeAdapter implements RuntimeAdapter {
  readonly managedArtifacts = true as const;
  private readonly executor: LocalDockerExecutor;
  private readonly platform: string;
  private readonly arch: string;
  private readonly runCommand: CommandRunner;

  constructor(executor: LocalDockerExecutor, runCommand: CommandRunner, platform: string, arch: string) {
    this.executor = executor;
    this.runCommand = runCommand;
    this.platform = platform;
    this.arch = arch;
  }

  artifactTarget(context?: ExecutorContext) {
    return this.executor.inspectRuntimeTarget(context?.instance.runtime.containerName);
  }

  async installRuntime(context: ExecutorContext, artifact: ResolvedRuntimeArtifact) {
    const containerName = context.instance.runtime.containerName;
    if (!containerName) throw Object.assign(new Error(`Instance ${context.instance.id} does not have a Docker container.`), { code: "INSTANCE_RUNTIME_INSTALL_FAILED" });
    await this.executor.installRuntimeLauncher(containerName);
    await this.executor.installRuntimeRelease({
      containerName,
      expectedContainerId: context.instance.runtime.containerId,
      artifactPath: artifact.archivePath,
      identity: artifact.identity,
    });
  }

  async inspectRuntime(context: ExecutorContext, expected: RuntimeArtifactIdentity) {
    const containerName = context.instance.runtime.containerName;
    if (!containerName) return false;
    return runtimeArtifactIdentityMatches(await this.executor.inspectRuntimeVersion(containerName), expected);
  }

  async rollbackRuntime(context: ExecutorContext, _previousVersion?: string) {
    const containerName = context.instance.runtime.containerName;
    if (!containerName) return;
    await this.executor.rollbackRuntime(containerName);
  }

  start(context: ExecutorContext) {
    return this.executor.start(context);
  }

  stop(context: ExecutorContext) {
    return this.executor.stop(context);
  }

  restart(context: ExecutorContext) {
    return this.executor.restart(context, context.instance.runtime.containerId);
  }

  delete(context: ExecutorContext) {
    return this.executor.delete(context);
  }

  async check(runtime: NodeRuntime): Promise<Partial<NodeRuntime>> {
    try {
      const result = await this.runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 5_000 });
      const serverVersion = result.stdout.trim();
      return {
        status: "online",
        capabilities: {
          ...runtime.capabilities,
          daemon: {
            status: "online",
            hostPlatform: finalComputerPlatform(this.platform),
            ...(serverVersion ? { serverVersion } : {}),
          },
        },
      };
    } catch (error) {
      return {
        status: "offline",
        capabilities: {
          ...runtime.capabilities,
          daemon: {
            status: "offline",
            hostPlatform: finalComputerPlatform(this.platform),
            error: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }
}

export class LocalhostRuntimeAdapter implements RuntimeAdapter {
  private readonly runCommand: CommandRunner;
  private readonly paths: NodeAgentStorePaths;
  private readonly nodeAgentUrl: () => string;
  private readonly processByInstanceId = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly commandOverride?: string[];

  constructor(runCommand: CommandRunner, paths: NodeAgentStorePaths, nodeAgentUrl: () => string, commandOverride?: string[]) {
    this.runCommand = runCommand;
    this.paths = paths;
    this.nodeAgentUrl = nodeAgentUrl;
    this.commandOverride = commandOverride;
  }

  async start(context: ExecutorContext): Promise<ExecutorStartResult> {
    const workspacePath = localWorkspacePath(context.instance);
    const port = context.instance.runtime.port || await allocateLocalPort();
    const dataDir = path.join(this.paths.dataDir, "local-instances", context.instance.id);
    const logDir = path.join(dataDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const [command, ...baseArgs] = localControlledInstanceCommand(this.commandOverride);
    const args = [...baseArgs, "--host", "127.0.0.1", "--port", String(port)];
    const out = fs.openSync(path.join(logDir, "controlled-instance.out.log"), "a");
    const err = fs.openSync(path.join(logDir, "controlled-instance.err.log"), "a");
    const child = spawn(command, args, {
      cwd: workspacePath,
      detached: false,
      stdio: ["ignore", out, err],
      env: {
        ...process.env,
        TASK_HANDOFF_CONTROL_MODE: "controlled",
        TASK_HANDOFF_NODE_AGENT_URL: this.nodeAgentUrl(),
        TASK_HANDOFF_INSTANCE_ID: context.instance.id,
        TASK_HANDOFF_INSTANCE_NAME: context.instance.name,
        TASK_HANDOFF_REGISTRATION_TOKEN: context.instance.registrationToken || "",
        TASK_HANDOFF_PROJECT_ID: context.project.id,
        TASK_HANDOFF_NODE_ID: context.node.id,
        TASK_HANDOFF_RUNTIME_ID: context.runtime.id,
        TASK_HANDOFF_WORKSPACE: workspacePath,
        TASK_HANDOFF_WORKSPACE_MODE: "local-bind",
        TASK_HANDOFF_DATA_DIR: dataDir,
        TASK_HANDOFF_LOG_DIR: logDir,
        TASK_HANDOFF_APP_SESSION_PERSIST: "1",
        TASK_HANDOFF_CODEX_APP_SERVER: process.env.TASK_HANDOFF_CODEX_APP_SERVER || "1",
        TASK_HANDOFF_WEB_PORT: String(port),
        TASK_HANDOFF_WEB_HOST: "127.0.0.1",
        ...(context.modelEnv || {}),
      },
    });
    fs.closeSync(out);
    fs.closeSync(err);
    try {
      await waitForChildSpawn(child);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        fs.appendFileSync(
          path.join(logDir, "controlled-instance.lifecycle.log"),
          `[${new Date().toISOString()}] spawn failed command=${command} cwd=${workspacePath} error=${message}\n`,
        );
      } catch {
        // Best-effort lifecycle logging.
      }
      throw Object.assign(
        new Error(`Controlled instance process could not start with command ${command} in ${workspacePath}: ${message}`),
        { statusCode: 500, code: "LOCAL_INSTANCE_PROCESS_SPAWN_FAILED" },
      );
    }
    this.processByInstanceId.set(context.instance.id, child);
    child.on("error", (error) => {
      try {
        fs.appendFileSync(
          path.join(logDir, "controlled-instance.lifecycle.log"),
          `[${new Date().toISOString()}] process error pid=${child.pid ?? ""} error=${error.message}\n`,
        );
      } catch {
        // Best-effort lifecycle logging.
      }
    });
    child.once("exit", (code, signal) => {
      this.processByInstanceId.delete(context.instance.id);
      try {
        fs.appendFileSync(
          path.join(logDir, "controlled-instance.lifecycle.log"),
          `[${new Date().toISOString()}] exited pid=${child.pid ?? ""} code=${code ?? ""} signal=${signal ?? ""}\n`,
        );
      } catch {
        // Best-effort lifecycle logging.
      }
    });
    const web = `http://127.0.0.1:${port}`;
    await waitForLocalInstanceHealth(web);
    return {
      status: "registering",
      health: "unknown",
      connectionStatus: "online",
      agentStatus: "unknown",
      targetStatus: "unknown",
      uiAccessStatus: "unknown",
      target: {
        strategy: "direct-port",
        status: "unknown",
        web,
        api: `${web}/api`,
      },
      workspace: {
        mode: "local-bind",
        status: "pending",
        path: workspacePath,
      },
      runtime: {
        kind: "local",
        workspacePath,
        pid: child.pid,
        port,
        labels: {
          ...context.instance.runtime.labels,
          "task-handoff.runtime-kind": "local",
        },
      },
    };
  }

  async stop(context: ExecutorContext): Promise<ExecutorStartResult> {
    await stopLocalProcess(context.instance, this.processByInstanceId);
    return {
      status: "stopped",
      health: "unknown",
      connectionStatus: "offline",
      agentStatus: "offline",
      targetStatus: "unknown",
      uiAccessStatus: "unknown",
      target: {
        ...context.instance.target,
        status: "unknown",
      },
      runtime: context.instance.runtime,
    };
  }

  async restart(context: ExecutorContext): Promise<ExecutorStartResult> {
    await stopLocalProcess(context.instance, this.processByInstanceId);
    return this.start(context);
  }

  async delete(context: ExecutorContext): Promise<ExecutorStartResult> {
    return this.stop(context);
  }

  async check(runtime: NodeRuntime): Promise<Partial<NodeRuntime>> {
    const [codex, claude] = await Promise.all([
      commandVersion(this.runCommand, "codex"),
      commandVersion(this.runCommand, "claude"),
    ]);
    return {
      status: "online",
      capabilities: localRuntimeCapabilities({
        ...runtime.capabilities,
        apps: {
          terminal: true,
          codex,
          claude,
        },
      }),
    };
  }

  async stopAll() {
    const children = Array.from(this.processByInstanceId.values());
    for (const child of this.processByInstanceId.values()) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }
    this.processByInstanceId.clear();
    await Promise.all(children.map((child) => waitForChildExit(child)));
  }
}

class RuntimeAdapterRegistry {
  private readonly docker: RuntimeAdapter;
  private readonly local: RuntimeAdapter;

  constructor(docker: RuntimeAdapter, local: RuntimeAdapter) {
    this.docker = docker;
    this.local = local;
  }

  forRuntime(runtime: NodeRuntime) {
    if (runtime.type === "docker") {
      return this.docker;
    }
    if (runtime.type === "local") {
      return this.local;
    }
    const error = new Error(`Runtime type ${runtime.type} is not supported by this node agent.`);
    Object.assign(error, { statusCode: 400, code: "NODE_RUNTIME_TYPE_UNSUPPORTED" });
    throw error;
  }

  managedAdapters() {
    return [this.docker, this.local].filter(isManagedRuntimeAdapter);
  }

  async stopAll() {
    if (this.local instanceof LocalhostRuntimeAdapter) {
      await this.local.stopAll();
    }
  }
}

class ControlledInstanceCollection extends JsonCollection<ControlledInstance> {
  private onStored?: (instance: ControlledInstance) => void;

  setOnStored(listener: (instance: ControlledInstance) => void) {
    this.onStored = listener;
  }

  override put(record: ControlledInstance) {
    const persistedRevision = super.get(record.id)?.stateRevision || 0;
    const stored = super.put(ControlledInstanceSchema.parse({
      ...record,
      stateRevision: Math.max(record.stateRevision || 0, persistedRevision) + 1,
    }));
    this.onStored?.(stored);
    return stored;
  }
}

class NodeAgentState {
  readonly nodeId: string;
  readonly paths: NodeAgentStorePaths;
  readonly localFolders: JsonCollection<NodeLocalFolder>;
  readonly nodeRuntimes: JsonCollection<NodeRuntime>;
  readonly controlledInstances: ControlledInstanceCollection;
  readonly models: NodeModelStore;
  readonly modelAssignments: InstanceModelAssignmentStore;
  readonly modelEnvironments: InstanceModelEnvironmentStore;
  readonly updateJobs: NodeUpdateJobs;
  readonly node: Node;
  private listenerPort: number;
  private readonly containerUrlOverride?: string;
  private readonly platform: NodeJS.Platform;

  constructor(paths: NodeAgentStorePaths, nodeId: string, endpoint: string | undefined, containerUrl: string | undefined, listenerPort: number, platform: NodeJS.Platform) {
    this.paths = paths;
    this.nodeId = nodeId;
    this.localFolders = new JsonCollection(paths.localFoldersDir, { schema: NodeLocalFolderSchema, sanitize: sanitizeStoredNodeLocalFolder });
    this.nodeRuntimes = new JsonCollection(paths.nodeRuntimesDir, { schema: NodeRuntimeSchema });
    this.controlledInstances = new ControlledInstanceCollection(paths.controlledInstancesDir, {
      schema: ControlledInstanceSchema,
      sanitize: (value) => sanitizeStoredControlledInstance(value, (warning) => {
        console.warn(JSON.stringify({
          message: "legacy controlled instance field was ignored",
          ...warning,
        }));
      }),
    });
    this.models = new NodeModelStore(paths.nodeModelsDir, nodeId);
    this.modelAssignments = new InstanceModelAssignmentStore(paths.modelAssignmentsDir);
    this.modelEnvironments = new InstanceModelEnvironmentStore(paths.modelEnvironmentsDir);
    this.updateJobs = new NodeUpdateJobs(paths);
    this.listenerPort = listenerPort;
    this.platform = platform;
    this.containerUrlOverride = containerUrl;
    const timestamp = now();
    this.node = NodeSchema.parse({
      id: nodeId,
      name: nodeId,
      connectionMode: "direct-http",
      endpoint,
      controlEndpoint: endpoint,
      containerEndpoint: this.containerUrl,
      publicWebBase: endpoint ? endpoint.replace(/:\d+$/, "") : undefined,
      status: "online",
      health: "ok",
      capabilities: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  init() {
    this.localFolders.init();
    for (const folder of this.localFolders.list()) this.localFolders.put(folder);
    this.nodeRuntimes.init();
    this.controlledInstances.init();
    this.models.init();
    this.modelAssignments.init();
    this.migrateLegacyModelEnvironments();
    this.updateJobs.init();
    this.updateJobs.reconcileRollouts(this.controlledInstances.list(), packageVersion());
    if (!this.nodeRuntimes.get("runtime_local_docker")) {
      const timestamp = now();
      this.nodeRuntimes.put(
        NodeRuntimeSchema.parse({
          id: "runtime_local_docker",
          nodeId: this.nodeId,
          name: "Local Docker",
          type: "docker",
          status: "unknown",
          accessStrategy: "direct-port",
          capabilities: {},
          labels: {},
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
    if (this.platform !== "win32") {
      const current = this.nodeRuntimes.get(BUILTIN_LOCAL_RUNTIME_ID);
      const timestamp = now();
      this.nodeRuntimes.put(NodeRuntimeSchema.parse({
        id: BUILTIN_LOCAL_RUNTIME_ID,
        nodeId: this.nodeId,
        name: "Local Runtime",
        type: "local",
        status: current?.status || "unknown",
        accessStrategy: "node-proxy",
        capabilities: localRuntimeCapabilities(current?.capabilities),
        labels: { ...current?.labels, [BUILTIN_RUNTIME_LABEL]: "true" },
        createdAt: current?.createdAt || timestamp,
        updatedAt: current?.updatedAt || timestamp,
      }));
    }
    for (const runtime of this.nodeRuntimes.list()) {
      if (runtime.nodeId !== this.nodeId) {
        this.nodeRuntimes.put(NodeRuntimeSchema.parse({ ...runtime, nodeId: this.nodeId, updatedAt: now() }));
      }
    }
    for (const folder of this.localFolders.list()) {
      if (folder.nodeId !== this.nodeId) {
        this.localFolders.put(NodeLocalFolderSchema.parse({ ...folder, nodeId: this.nodeId, updatedAt: now() }));
      }
    }
    this.normalizeInstanceRuntimeVersions();
  }

  private normalizeInstanceRuntimeVersions() {
    for (const instance of this.controlledInstances.list()) {
      const actualVersion = instance.build?.packageVersion || instance.instanceVersion;
      const derived = runtimeVersionStateForActual(actualVersion);
      const managedArtifacts = runtimeUsesManagedArtifacts(this.requireRuntime(instance.runtimeId));
      const stopped = ["created", "stopped", "failed"].includes(instance.status);
      const previous = managedArtifacts && instance.runtimeVersion?.desiredVersion === derived.desiredVersion ? instance.runtimeVersion : undefined;
      const runtimeVersion = !managedArtifacts
        ? derived
        : derived.phase === "matched"
        ? (stopped ? derived : { ...derived, phase: "verifying" as const, matchedAt: undefined })
        : previous?.phase === "failed" && previous.error?.retryable === false
          ? { ...derived, phase: "failed" as const, attempt: previous.attempt, lastAttemptAt: previous.lastAttemptAt, error: previous.error }
          : { ...derived, attempt: previous?.attempt || 0, lastAttemptAt: previous?.lastAttemptAt };
      this.controlledInstances.put(ControlledInstanceSchema.parse({
        ...instance,
        ready: false,
        runtimeVersion,
        updatedAt: now(),
      }));
    }
  }

  get localNodeAgentUrl() {
    return `http://127.0.0.1:${this.listenerPort}`;
  }

  get currentListenerPort() {
    return this.listenerPort;
  }

  get containerUrl() {
    return this.containerUrlOverride || `http://host.docker.internal:${this.listenerPort}`;
  }

  setListenerPort(port: number) {
    this.listenerPort = port;
    this.node.containerEndpoint = this.containerUrl;
    this.node.updatedAt = now();
  }

  runningInstanceCount() {
    const inactive = new Set<ControlledInstance["status"]>(["created", "stopped", "failed"]);
    return this.listInstances().filter((instance) => !inactive.has(instance.status)).length;
  }

  createLocalFolder(input: z.infer<typeof CreateLocalFolderSchema>) {
    const timestamp = now();
    const folder = NodeLocalFolderSchema.parse({
      ...input,
      id: input.id || createId("folder"),
      nodeId: this.nodeId,
      labels: input.labels || {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.localFolders.put(folder);
  }

  createRuntime(input: z.infer<typeof CreateNodeRuntimeSchema>) {
    if (input.type === "local") {
      const unsupported = this.platform === "win32";
      const error = new Error(unsupported
        ? "Local Runtime is not supported on Windows."
        : "Local Runtime is built in and cannot be added manually.");
      Object.assign(error, { statusCode: unsupported ? 400 : 409, code: unsupported ? "LOCAL_RUNTIME_UNSUPPORTED" : "LOCAL_RUNTIME_BUILTIN" });
      throw error;
    }
    const timestamp = now();
    const runtime = NodeRuntimeSchema.parse({
      ...input,
      id: input.id || createId("runtime"),
      nodeId: this.nodeId,
      accessStrategy: input.accessStrategy || defaultAccessStrategyForRuntime(input.type),
      capabilities: input.capabilities || {},
      labels: userRuntimeLabels(input.labels),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.nodeRuntimes.put(runtime);
  }

  updateRuntime(id: string, input: z.infer<typeof UpdateNodeRuntimeSchema>) {
    const current = this.requireRuntime(id);
    if (current.labels[BUILTIN_RUNTIME_LABEL] === "true") {
      const error = new Error(`Built-in runtime ${id} cannot be modified.`);
      Object.assign(error, { statusCode: 400, code: "NODE_RUNTIME_BUILTIN" });
      throw error;
    }
    if (current.type === "local" || input.type === "local") {
      const unsupported = this.platform === "win32";
      const error = new Error(unsupported
        ? "Local Runtime is not supported on Windows."
        : "Local Runtime is built in and cannot be configured manually.");
      Object.assign(error, { statusCode: unsupported ? 400 : 409, code: unsupported ? "LOCAL_RUNTIME_UNSUPPORTED" : "LOCAL_RUNTIME_BUILTIN" });
      throw error;
    }
    const updated = NodeRuntimeSchema.parse({
      ...current,
      ...input,
      id: current.id,
      nodeId: this.nodeId,
      accessStrategy: input.accessStrategy || current.accessStrategy,
      capabilities: input.capabilities || current.capabilities,
      labels: input.labels ? userRuntimeLabels(input.labels) : current.labels,
      createdAt: current.createdAt,
      updatedAt: now(),
    });
    return this.nodeRuntimes.put(updated);
  }

  deleteRuntime(id: string) {
    const runtime = this.requireRuntime(id);
    if (runtime.labels[BUILTIN_RUNTIME_LABEL] === "true") {
      const error = new Error(`Built-in runtime ${id} cannot be deleted.`);
      Object.assign(error, { statusCode: 400, code: "NODE_RUNTIME_BUILTIN" });
      throw error;
    }
    const references = this.listInstances().filter((instance) => instance.runtimeId === id);
    if (references.length) {
      const error = new Error(`Runtime ${id} is used by ${references.length} instance${references.length === 1 ? "" : "s"}.`);
      Object.assign(error, { statusCode: 409, code: "NODE_RUNTIME_IN_USE" });
      throw error;
    }
    return this.nodeRuntimes.delete(id);
  }

  checkRuntime(id: string, adapter: RuntimeAdapter) {
    const runtime = this.requireRuntime(id);
    if (!adapter.check) {
      return this.nodeRuntimes.put(NodeRuntimeSchema.parse({ ...runtime, status: "unknown", updatedAt: now() }));
    }
    return adapter.check(runtime).then((patch) => {
      const updated = NodeRuntimeSchema.parse({
        ...runtime,
        ...patch,
        id: runtime.id,
        nodeId: this.nodeId,
        createdAt: runtime.createdAt,
        updatedAt: now(),
      });
      return this.nodeRuntimes.put(updated);
    });
  }

  requireRuntime(id: string) {
    const runtime = this.nodeRuntimes.get(id);
    if (!runtime) {
      const error = new Error(`Node runtime ${id} was not found.`);
      Object.assign(error, { statusCode: 404, code: "NODE_RUNTIME_NOT_FOUND" });
      throw error;
    }
    return runtime;
  }

  requireInstance(id: string) {
    const instance = this.controlledInstances.get(id);
    if (!instance) {
      const error = new Error(`Instance ${id} was not found on node ${this.nodeId}.`);
      Object.assign(error, { statusCode: 404, code: "NODE_INSTANCE_NOT_FOUND" });
      throw error;
    }
    const parsed = safeParseStoredControlledInstance(instance);
    if (!parsed.success) {
      throw storedInstancePayloadError(id, parsed.error.issues);
    }
    return parsed.data;
  }

  listInstances() {
    return this.controlledInstances.list().flatMap((instance) => {
      const parsed = safeParseStoredControlledInstance(instance);
      return parsed.success ? [parsed.data] : [];
    });
  }

  listModels(): NodeModelPublicRecord[] {
    const referenceCounts = new Map<string, number>();
    for (const instance of this.listInstances()) {
      const assignment = this.modelAssignments.get(instance.id);
      for (const modelHash of [assignment?.codexModelHash, assignment?.claudeModelHash]) {
        if (modelHash) referenceCounts.set(modelHash, (referenceCounts.get(modelHash) || 0) + 1);
      }
    }
    return this.models.list().map((model) => this.publicModel(model, referenceCounts.get(model.id) || 0));
  }

  createModel(input: z.infer<typeof CreateNodeModelSchema>) {
    const timestamp = now();
    const id = modelConfigHash(input);
    const current = this.models.get(id);
    const model = NodeModelConfigSchema.parse({
      ...input,
      id,
      enabled: input.enabled ?? true,
      order: input.order ?? this.nextModelOrder(),
      labels: input.labels || {},
      createdAt: current?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    return this.publicModel(this.models.put(model), this.modelReferenceIds(id).length);
  }

  deployModel(input: z.infer<typeof DeployNodeModelSchema>) {
    const expectedHash = modelConfigHash(input);
    if (input.id !== expectedHash) throw Object.assign(new Error(`Model content hash ${expectedHash} does not match ${input.id}.`), { statusCode: 400, code: "NODE_MODEL_HASH_MISMATCH" });
    const current = this.models.get(input.id);
    const stored = current || this.models.put(NodeModelConfigSchema.parse(input));
    return this.publicModel(stored, this.modelReferenceIds(stored.id).length);
  }

  updateModel(id: string, input: z.infer<typeof UpdateNodeModelSchema>) {
    const current = this.requireModel(id);
    const candidate = NodeModelConfigSchema.parse({
      ...current,
      ...input,
      key: input.key?.trim() ? input.key : current.key,
      createdAt: current.createdAt,
      updatedAt: now(),
    });
    const nextId = modelConfigHash(candidate);
    const stored = this.models.put(NodeModelConfigSchema.parse({ ...candidate, id: nextId }));
    return this.publicModel(stored, this.modelReferenceIds(nextId).length);
  }

  deleteModel(id: string) {
    this.requireModel(id);
    const instanceIds = this.modelReferenceIds(id);
    if (instanceIds.length) {
      throw Object.assign(new Error(`Model ${id} is assigned to ${instanceIds.length} instance${instanceIds.length === 1 ? "" : "s"}.`), {
        statusCode: 409,
        code: "NODE_MODEL_IN_USE",
        instanceIds,
      });
    }
    return this.models.delete(id);
  }

  assignModels(instanceId: string, input: z.infer<typeof UpdateNodeModelAssignmentSchema>) {
    const current = this.requireInstance(instanceId);
    this.validateAssignmentRef("codex", input.codexModelHash);
    this.validateAssignmentRef("claude", input.claudeModelHash);
    if (input.modelSelection.codexModelHash !== undefined && (input.modelSelection.codexModelHash ?? undefined) !== input.codexModelHash) {
      throw Object.assign(new Error("Codex model selection does not match its node assignment."), { statusCode: 400, code: "NODE_MODEL_SELECTION_MISMATCH" });
    }
    if (input.modelSelection.claudeModelHash !== undefined && (input.modelSelection.claudeModelHash ?? undefined) !== input.claudeModelHash) {
      throw Object.assign(new Error("Claude model selection does not match its node assignment."), { statusCode: 400, code: "NODE_MODEL_SELECTION_MISMATCH" });
    }
    const previous = this.modelAssignments.get(instanceId);
    const assignment = NodeModelAssignmentSchema.parse({ instanceId, codexModelHash: input.codexModelHash, claudeModelHash: input.claudeModelHash, updatedAt: now() });
    this.modelAssignments.put(assignment);
    try {
      const instance = this.controlledInstances.put(ControlledInstanceSchema.parse({ ...current, modelSelection: input.modelSelection, updatedAt: now() }));
      return { assignment, instance };
    } catch (error) {
      if (previous) this.modelAssignments.put(previous);
      else this.modelAssignments.delete(instanceId);
      throw error;
    }
  }

  resolvedAssignedModelEnvironment(instanceId: string) {
    const assignment = this.modelAssignments.get(instanceId);
    if (!assignment) {
      if (this.modelEnvironments.has(instanceId)) {
        throw Object.assign(new Error(`Legacy model environment for instance ${instanceId} requires manual migration.`), {
          statusCode: 409,
          code: "NODE_MODEL_MIGRATION_REQUIRED",
        });
      }
      return {};
    }
    return {
      ...this.modelEnvironmentForRef("codex", assignment.codexModelHash),
      ...this.modelEnvironmentForRef("claude", assignment.claudeModelHash),
    };
  }

  private validateAssignmentRef(app: "codex" | "claude", modelHash?: string) {
    if (!modelHash) return;
    const model = this.requireModel(modelHash);
    if (model.app !== app) {
      throw Object.assign(new Error(`Model ${model.id} belongs to ${model.app}, not ${app}.`), { statusCode: 400, code: "NODE_MODEL_APP_MISMATCH" });
    }
    if (!model.enabled) {
      throw Object.assign(new Error(`Model ${model.id} is disabled.`), { statusCode: 409, code: "NODE_MODEL_DISABLED" });
    }
  }

  private modelEnvironmentForRef(app: "codex" | "claude", modelHash?: string) {
    if (!modelHash) return {};
    this.validateAssignmentRef(app, modelHash);
    const model = this.requireModel(modelHash);
    return app === "codex" ? {
      OPENAI_API_KEY: model.key,
      OPENAI_BASE_URL: model.endpoint,
      TASK_HANDOFF_CODEX_BASE_URL: model.endpoint,
      TASK_HANDOFF_CODEX_MODEL: model.model,
    } : {
      ANTHROPIC_API_KEY: model.key,
      ANTHROPIC_BASE_URL: model.endpoint,
      TASK_HANDOFF_CLAUDE_MODEL: model.model,
    };
  }

  private requireModel(id: string) {
    const model = this.models.get(id);
    if (!model) throw Object.assign(new Error(`Model ${id} was not found on node ${this.nodeId}.`), { statusCode: 404, code: "NODE_MODEL_NOT_FOUND" });
    if (modelConfigHash(model) !== model.id) throw Object.assign(new Error(`Stored model ${id} does not match its content hash.`), { statusCode: 409, code: "NODE_MODEL_HASH_INVALID" });
    return model;
  }

  private modelReferenceIds(modelId: string) {
    return this.listInstances().filter((instance) => {
      const assignment = this.modelAssignments.get(instance.id);
      return assignment?.codexModelHash === modelId || assignment?.claudeModelHash === modelId;
    }).map((instance) => instance.id);
  }

  private publicModel(model: NodeModelConfig, referenceCount: number): NodeModelPublicRecord {
    const { key, ...safe } = model;
    return NodeModelPublicRecordSchema.parse({ ...safe, keyPreview: key.length <= 8 ? "set" : `${key.slice(0, 4)}...${key.slice(-4)}`, keySet: true, referenceCount });
  }

  private nextModelOrder() {
    return this.models.list().reduce((max, model) => Math.max(max, model.order), 0) + 100;
  }

  private migrateLegacyModelEnvironments() {
    for (const instanceId of this.modelEnvironments.listInstanceIds()) {
      const instance = this.controlledInstances.get(instanceId);
      if (!instance) {
        this.warnLegacyModelMigration(instanceId, "instance-not-found");
        continue;
      }
      const existingAssignment = this.modelAssignments.get(instanceId);
      if (existingAssignment) {
        try {
          this.resolvedAssignedModelEnvironment(instanceId);
          this.modelEnvironments.delete(instanceId);
        } catch {
          this.warnLegacyModelMigration(instanceId, "existing-assignment-invalid");
        }
        continue;
      }

      let environment: Record<string, string>;
      try {
        environment = this.modelEnvironments.get(instanceId);
      } catch {
        this.warnLegacyModelMigration(instanceId, "sidecar-invalid");
        continue;
      }
      if (!Object.keys(environment).length) {
        this.modelEnvironments.delete(instanceId);
        continue;
      }
      if (Object.keys(environment).some((key) => !LEGACY_MODEL_ENV_KEYS.has(key))) {
        this.warnLegacyModelMigration(instanceId, "unknown-fields");
        continue;
      }

      const createdModelIds: string[] = [];
      try {
        const codex = this.migrateLegacyModelForApp(environment, "codex", createdModelIds);
        const claude = this.migrateLegacyModelForApp(environment, "claude", createdModelIds);
        if (!codex && !claude) throw new Error("no complete model configuration");
        const modelSelection = {
          ...(codex ? { codexModelHash: codex } : {}),
          ...(claude ? { claudeModelHash: claude } : {}),
        };
        this.assignModels(instanceId, { modelSelection, codexModelHash: codex, claudeModelHash: claude });
        this.resolvedAssignedModelEnvironment(instanceId);
        this.modelEnvironments.delete(instanceId);
      } catch {
        this.modelAssignments.delete(instanceId);
        for (const modelId of createdModelIds) this.models.delete(modelId);
        this.warnLegacyModelMigration(instanceId, "mapping-failed");
      }
    }
  }

  private migrateLegacyModelForApp(
    environment: Record<string, string>,
    app: "codex" | "claude",
    createdModelIds: string[],
  ) {
    const key = environment[app === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"];
    const endpoint = app === "codex"
      ? environment.TASK_HANDOFF_CODEX_BASE_URL || environment.OPENAI_BASE_URL
      : environment.ANTHROPIC_BASE_URL;
    const modelName = app === "codex"
      ? environment.TASK_HANDOFF_CODEX_MODEL || environment.CODEX_MODEL
      : environment.TASK_HANDOFF_CLAUDE_MODEL || environment.CLAUDE_MODEL;
    const related = Boolean(key || endpoint || modelName);
    if (!related) return undefined;
    if (!key || !endpoint || !modelName) throw new Error("model configuration incomplete");

    const modelId = modelConfigHash({ app, endpoint, key, model: modelName });
    const existing = this.models.get(modelId);
    if (existing) {
      if (existing.app !== app || existing.key !== key || existing.endpoint !== endpoint || existing.model !== modelName || !existing.enabled) {
        throw new Error("existing model conflicts with legacy environment");
      }
      return modelId;
    }

    const timestamp = now();
    this.models.put(NodeModelConfigSchema.parse({
      id: modelId,
      name: `Migrated ${app === "codex" ? "Codex" : "Claude"} model`,
      endpoint,
      key,
      model: modelName,
      app,
      enabled: true,
      order: this.nextModelOrder(),
      labels: { migratedFrom: "instance-model-environment" },
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    createdModelIds.push(modelId);
    return modelId;
  }

  private warnLegacyModelMigration(instanceId: string, reason: string) {
    console.warn(JSON.stringify({
      message: "legacy model environment was preserved because it could not be migrated",
      nodeId: this.nodeId,
      instanceId,
      reason,
    }));
  }

  createInstance(input: z.infer<typeof CreateNodeInstanceSchema>) {
    const runtime = this.requireRuntime(input.runtimeId);
    const timestamp = now();
    const id = input.id || createId("inst");
    const source = ProjectSourceSchema.parse(input.source);
    if (runtimeRequiresImage(runtime) && (!input.imageSelection || !input.image)) {
      const error = new Error(`Runtime ${runtime.name} requires an image.`);
      Object.assign(error, { statusCode: 400, code: "NODE_RUNTIME_IMAGE_REQUIRED" });
      throw error;
    }
    if (runtime.type === "local" && source.type !== "local-folder") {
      const error = new Error("Localhost runtime currently supports local folder sources only.");
      Object.assign(error, { statusCode: 400, code: "LOCAL_RUNTIME_REQUIRES_LOCAL_FOLDER" });
      throw error;
    }
    if (runtime.type === "local" && this.listInstances().some((instance) => this.requireRuntime(instance.runtimeId).type === "local")) {
      const error = new Error("A localhost instance already exists on this node.");
      Object.assign(error, { statusCode: 409, code: "LOCAL_RUNTIME_INSTANCE_EXISTS" });
      throw error;
    }
    const imageSnapshot = input.image ? InstanceImageSnapshotSchema.parse(input.image) : undefined;
    const workspacePath = runtime.type === "local" && source.type === "local-folder" ? path.resolve(source.path) : undefined;
    const instance = ControlledInstanceSchema.parse({
      id,
      name: input.name || `instance-${id.replace(/^inst_?/, "").slice(0, 6)}`,
      source,
      sourceSnapshot: input.sourceSnapshot || {},
      modelSelection: input.modelSelection,
      projectId: input.projectId,
      nodeId: this.nodeId,
      runtimeId: runtime.id,
      imageSelection: input.imageSelection,
      imageSnapshot,
      imageProvisioning: imageSnapshot && runtime.type === "docker" ? {
        phase: "checking-image",
        requestedReference: imageSnapshot.requestedReference,
        generation: 0,
        startedAt: timestamp,
        updatedAt: timestamp,
      } : undefined,
      status: imageSnapshot && runtime.type === "docker" ? "provisioning" : "created",
      health: "unknown",
      connectionStatus: "unknown",
      agentStatus: "unknown",
      targetStatus: "unknown",
      uiAccessStatus: "unknown",
      controlMode: "controlled",
      ready: false,
      runtimeVersion: runtimeVersionStateForActual(),
      capabilities: {},
      config: {
        autoImportAgentConfigs: input.config?.autoImportAgentConfigs ?? true,
        defaultCodexPermissionMode: input.config?.defaultCodexPermissionMode ?? (runtime.type === "docker" ? "full-access" : "ask"),
      },
      workspace: runtime.type === "local" ? { mode: "local-bind", status: "unknown", path: workspacePath } : { status: "unknown" },
      target: { strategy: "node-proxy", status: "unknown" },
      runtime: runtime.type === "local" ? { kind: "local", workspacePath, labels: { "task-handoff.runtime-kind": "local" } } : { labels: {} },
      registrationToken: createSecret(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.controlledInstances.put(instance);
  }

  registerInstance(id: string, input: ControlledInstanceRegister, token?: string) {
    const parsed = ControlledInstanceRegisterSchema.parse(input);
    const timestamp = now();
    const existing = this.controlledInstances.get(id);
    if (!existing) {
      const error = new Error(`Instance ${id} was not found on node ${this.nodeId}.`);
      Object.assign(error, { statusCode: 404, code: "NODE_INSTANCE_NOT_FOUND" });
      throw error;
    }
    this.validateInstanceReport(existing, parsed, token);
    warnProtocolVersion(parsed.protocolVersion, `Instance ${id}`);
    const actualVersion = parsed.build?.packageVersion || parsed.instanceVersion;
    const managedArtifacts = runtimeUsesManagedArtifacts(this.requireRuntime(existing.runtimeId));
    const runtimeVersion = runtimeVersionStateForReport(existing, actualVersion, managedArtifacts);
    const updated = ControlledInstanceSchema.parse({
      ...existing,
      name: parsed.name,
      status: "registered",
      health: actualVersion === packageVersion() ? "ok" : "degraded",
      // Managed releases require inspection before they are ready. A Local
      // Runtime process is the controlled instance bundled with this program.
      ready: !managedArtifacts && actualVersion === packageVersion(),
      connectionStatus: "online",
      agentStatus: "online",
      targetStatus: parsed.target.status === "endpoint-unreachable" ? "endpoint-unreachable" : parsed.target.status === "reachable" ? "reachable" : existing.targetStatus,
      uiAccessStatus: parsed.target.status === "endpoint-unreachable" ? "endpoint-unreachable" : existing.uiAccessStatus,
      controlMode: parsed.controlMode,
      protocolVersion: parsed.protocolVersion,
      instanceVersion: parsed.instanceVersion,
      build: parsed.build,
      runtimeVersion,
      capabilities: parsed.capabilities,
      appInventory: parsed.appInventory,
      workspace: parsed.workspace,
      target: { ...existing.target, ...parsed.target },
      registrationToken: existing.registrationToken || parsed.registrationToken,
      lastHeartbeatAt: timestamp,
      updatedAt: timestamp,
    });
    return this.controlledInstances.put(updated);
  }

  heartbeatInstance(id: string, input: ControlledInstanceHeartbeat, token?: string) {
    const current = this.requireInstance(id);
    this.validateInstanceToken(current, token);
    const parsed = ControlledInstanceHeartbeatSchema.parse(input);
    warnProtocolVersion(parsed.protocolVersion, `Instance ${id}`);
    const timestamp = now();
    const mergedTarget = parsed.target ? { ...current.target, ...parsed.target } : current.target;
    const target = {
      ...mergedTarget,
      status: mergedTarget.status === "unknown" && (mergedTarget.web || mergedTarget.api) ? "reachable" as const : mergedTarget.status,
    };
    const targetStatus = target.status === "endpoint-unreachable" ? "endpoint-unreachable" : target.status === "reachable" ? "reachable" : current.targetStatus;
    const actualVersion = parsed.build?.packageVersion || current.build?.packageVersion || current.instanceVersion;
    const managedArtifacts = runtimeUsesManagedArtifacts(this.requireRuntime(current.runtimeId));
    const runtimeVersion = runtimeVersionStateForReport(current, actualVersion, managedArtifacts);
    const authoritativeReady = actualVersion === packageVersion()
      && (!managedArtifacts || (current.ready && current.runtimeVersion?.phase === "matched"));
    const updated = ControlledInstanceSchema.parse({
      ...current,
      ...parsed,
      target,
      ready: authoritativeReady && parsed.health !== "failed",
      health: actualVersion === packageVersion() ? parsed.health || current.health : "degraded",
      runtimeVersion,
      agentStatus: "online",
      targetStatus,
      uiAccessStatus: targetStatus,
      connectionStatus: "online",
      build: parsed.build || current.build,
      lastHeartbeatAt: timestamp,
      updatedAt: timestamp,
    });
    return this.controlledInstances.put(updated);
  }

  private validateInstanceReport(existing: ControlledInstance, input: ControlledInstanceRegister, token?: string) {
    this.validateInstanceToken(existing, token || input.registrationToken);
    if (input.instanceId && input.instanceId !== existing.id) {
      throwForbidden("INSTANCE_ID_MISMATCH", `Instance ${input.instanceId} cannot register as ${existing.id}.`);
    }
    if (input.nodeId && input.nodeId !== this.nodeId) {
      throwForbidden("INSTANCE_NODE_MISMATCH", `Instance ${existing.id} belongs to node ${this.nodeId}.`);
    }
    if (input.runtimeId && input.runtimeId !== existing.runtimeId) {
      throwForbidden("INSTANCE_RUNTIME_MISMATCH", `Instance ${existing.id} belongs to runtime ${existing.runtimeId}.`);
    }
    if (input.imageSelection && input.imageSelection.imageId !== existing.imageSelection?.imageId) {
      throwForbidden("INSTANCE_IMAGE_MISMATCH", `Instance ${existing.id} belongs to image ${existing.imageSelection?.imageId}.`);
    }
  }

  private validateInstanceToken(instance: ControlledInstance, token?: string) {
    if (!instance.registrationToken || token !== instance.registrationToken) {
      throwForbidden("INSTANCE_REGISTRATION_TOKEN_INVALID", `Invalid registration token for instance ${instance.id}.`);
    }
  }

  context(instance: ControlledInstance, modelEnv: Record<string, string> = this.resolvedAssignedModelEnvironment(instance.id)): ExecutorContext {
    const image = instance.imageSnapshot || InstanceImageSnapshotSchema.parse({ id: "img_localhost", origin: "custom", name: "Localhost", repository: "localhost", tag: "local", requestedReference: "localhost:local", pullPolicy: "if-not-present", capabilities: [], optionalApps: [], defaultEnv: {}, labels: {}, createdAt: instance.createdAt, updatedAt: instance.updatedAt });
    return {
      project: projectForInstance(instance),
      image,
      node: this.node,
      runtime: this.requireRuntime(instance.runtimeId),
      instance,
      nodeAgentUrl: this.containerUrl,
      modelEnv,
    };
  }
}

export class NodeAgentExternalListenerManager {
  private readonly app: Awaited<ReturnType<typeof createNodeAgentApp>>;
  private readonly state: NodeAgentState;
  private readonly settings: JsonFile<NodeAgentRuntimeSettings>;
  private readonly sockets = new Set<net.Socket>();
  private config: NodeAgentExternalListenerConfig;
  private source: NodeAgentExternalListener["source"];
  private status: NodeAgentExternalListener["status"] = "error";
  private error?: string;

  constructor(input: {
    app: Awaited<ReturnType<typeof createNodeAgentApp>>;
    state: NodeAgentState;
    settings: JsonFile<NodeAgentRuntimeSettings>;
    config: NodeAgentExternalListenerConfig;
    source: NodeAgentExternalListener["source"];
  }) {
    this.app = input.app;
    this.state = input.state;
    this.settings = input.settings;
    this.config = input.config;
    this.source = input.source;
    this.app.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  current() {
    return NodeAgentExternalListenerSchema.parse({
      ...this.config,
      host: listenerHost(this.config.bindScope),
      status: this.status,
      source: this.source,
      ...(this.error ? { error: this.error } : {}),
    });
  }

  async start() {
    try {
      await this.listen(this.config);
      this.status = "listening";
      this.error = undefined;
      this.state.setListenerPort(this.config.port);
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.app.log.error({ host: listenerHost(this.config.bindScope), port: this.config.port, error: this.error }, "node agent TCP listener failed to start; Unix IPC remains available");
    }
    return this.current();
  }

  async update(input: unknown) {
    const candidate = UpdateNodeAgentExternalListenerSchema.parse(input);
    if (candidate.bindScope === this.config.bindScope && candidate.port === this.config.port) {
      return this.current();
    }
    if (candidate.port !== this.config.port) {
      const blockingInstanceCount = this.state.runningInstanceCount();
      if (blockingInstanceCount > 0) {
        const error = new Error(`Cannot change the node agent port while ${blockingInstanceCount} controlled instance(s) are running.`);
        Object.assign(error, { statusCode: 409, code: "NODE_AGENT_LISTENER_PORT_IN_USE_BY_INSTANCES", blockingInstanceCount });
        throw error;
      }
    }

    const previous = { config: this.config, source: this.source, status: this.status, error: this.error };
    await this.stop();
    try {
      await this.listen(candidate);
    } catch (error) {
      await this.restore(previous);
      const wrapped = new Error(`Failed to bind node agent TCP listener at ${listenerHost(candidate.bindScope)}:${candidate.port}: ${error instanceof Error ? error.message : String(error)}`);
      Object.assign(wrapped, { statusCode: 409, code: "NODE_AGENT_LISTENER_BIND_FAILED" });
      throw wrapped;
    }

    try {
      this.settings.put({ version: 1, externalListener: candidate });
    } catch (error) {
      await this.stop();
      await this.restore(previous);
      const wrapped = new Error(`Failed to persist node agent TCP listener: ${error instanceof Error ? error.message : String(error)}`);
      Object.assign(wrapped, { statusCode: 500, code: "NODE_AGENT_LISTENER_PERSIST_FAILED" });
      throw wrapped;
    }

    this.config = candidate;
    this.source = "persisted";
    this.status = "listening";
    this.error = undefined;
    this.state.setListenerPort(candidate.port);
    return this.current();
  }

  async shutdown() {
    await this.stop();
  }

  private async restore(previous: { config: NodeAgentExternalListenerConfig; source: NodeAgentExternalListener["source"]; status: NodeAgentExternalListener["status"]; error?: string }) {
    this.config = previous.config;
    this.source = previous.source;
    this.status = previous.status;
    this.error = previous.error;
    if (previous.status === "listening") {
      try {
        await this.listen(previous.config);
      } catch (error) {
        this.status = "error";
        this.error = `Failed to restore previous listener: ${error instanceof Error ? error.message : String(error)}`;
        this.app.log.error({ error: this.error }, "node agent TCP listener rollback failed");
      }
    }
    this.state.setListenerPort(previous.config.port);
  }

  private async listen(config: NodeAgentExternalListenerConfig) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.app.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.app.server.off("error", onError);
        resolve();
      };
      this.app.server.once("error", onError);
      this.app.server.once("listening", onListening);
      this.app.server.listen({ host: listenerHost(config.bindScope), port: config.port });
    });
  }

  private async stop() {
    if (!this.app.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.app.server.close((error) => error ? reject(error) : resolve());
      for (const socket of this.sockets) socket.destroy();
    });
  }
}

type NodeAgentDiagnosticLogger = (data: Record<string, unknown>, message: string) => void;
type NodeAgentLifecycleLoggers = {
  diagnostic: NodeAgentDiagnosticLogger;
  warn: NodeAgentDiagnosticLogger;
};

async function provisionNodeInstanceImage(
  state: NodeAgentState,
  images: DockerImageService,
  id: string,
  generation: number,
  sync: () => void,
  loggers: NodeAgentLifecycleLoggers,
  publishTerminal?: (event: DockerImageTerminalOutput | { sequence: number; outcome: "succeeded" | "failed" }) => void,
  onReadyToStart?: () => Promise<void>,
) {
  const updatePhase = (phase: DockerImagePhase) => {
    const current = state.controlledInstances.get(id);
    if (!current || current.imageProvisioning?.generation !== generation || !current.imageSnapshot) return;
    state.controlledInstances.put(ControlledInstanceSchema.parse({
      ...current,
      status: current.status === "starting" ? "starting" : "provisioning",
      imageProvisioning: { ...current.imageProvisioning, phase, error: undefined, updatedAt: now() },
      updatedAt: now(),
    }));
    sync();
  };
  const initial = state.controlledInstances.get(id);
  if (!initial?.imageSnapshot || initial.imageProvisioning?.generation !== generation) return;
  let terminalSequence = 0;
  let terminalStarted = false;
  try {
    const resolved = await images.ensure(initial.imageSnapshot.requestedReference!, updatePhase, (output) => {
      terminalStarted = true;
      terminalSequence = output.sequence;
      publishTerminal?.(output);
    });
    if (terminalStarted) publishTerminal?.({ sequence: terminalSequence + 1, outcome: "succeeded" });
    const current = state.controlledInstances.get(id);
    if (!current?.imageSnapshot || current.imageProvisioning?.generation !== generation) return;
    state.controlledInstances.put(ControlledInstanceSchema.parse({
      ...current,
      status: current.status === "starting" ? "starting" : "created",
      health: "unknown",
      imageSnapshot: {
        ...current.imageSnapshot,
        requestedReference: resolved.requestedReference,
        resolvedDigest: resolved.resolvedDigest,
        resolvedReference: resolved.resolvedReference,
      },
      imageProvisioning: { ...current.imageProvisioning, phase: "ready", error: undefined, updatedAt: now() },
      updatedAt: now(),
    }));
    sync();
    loggers.diagnostic({ instanceId: id, action: "image.provision", reference: resolved.requestedReference, digest: resolved.resolvedDigest, pulled: resolved.pulled }, "node instance image provisioning completed");
    if (current.status === "starting") {
      await onReadyToStart?.();
    }
  } catch (error) {
    if (terminalStarted) publishTerminal?.({ sequence: terminalSequence + 1, outcome: "failed" });
    const current = state.controlledInstances.get(id);
    if (!current?.imageProvisioning || current.imageProvisioning.generation !== generation) return;
    const message = error instanceof Error ? error.message : String(error);
    state.controlledInstances.put(ControlledInstanceSchema.parse({
      ...current,
      status: "failed",
      health: "failed",
      imageProvisioning: { ...current.imageProvisioning, phase: "failed", error: message, updatedAt: now() },
      updatedAt: now(),
    }));
    sync();
    loggers.warn({ instanceId: id, action: "image.provision", reference: current.imageProvisioning.requestedReference, error: message }, "node instance image provisioning failed");
  }
}

function retryNodeInstanceImageProvisioning(state: NodeAgentState, id: string) {
  const current = state.requireInstance(id);
  const runtime = state.requireRuntime(current.runtimeId);
  if (runtime.type !== "docker" || !current.imageSnapshot) {
    const error = new Error(`Instance ${id} does not use a Docker image.`);
    Object.assign(error, { statusCode: 400, code: "INSTANCE_IMAGE_PROVISIONING_UNSUPPORTED" });
    throw error;
  }
  if (current.status !== "failed" || current.imageProvisioning?.phase !== "failed") {
    const error = new Error(`Instance ${id} does not have failed image provisioning to retry.`);
    Object.assign(error, { statusCode: 409, code: "INSTANCE_IMAGE_PROVISIONING_NOT_FAILED" });
    throw error;
  }
  const timestamp = now();
  return state.controlledInstances.put(ControlledInstanceSchema.parse({
    ...current,
    status: "provisioning",
    health: "unknown",
    imageProvisioning: {
      phase: "checking-image",
      requestedReference: current.imageSnapshot.requestedReference,
      generation: (current.imageProvisioning?.generation || 0) + 1,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  }));
}

async function startNodeInstance(
  state: NodeAgentState,
  runtimeAdapters: RuntimeAdapterRegistry,
  fetchImpl: typeof fetch,
  id: string,
  loggers: NodeAgentLifecycleLoggers,
  reason: "request" | "restore" | "update" = "request",
) {
  const current = state.requireInstance(id);
  if (current.imageProvisioning && current.imageProvisioning.phase !== "ready" && state.requireRuntime(current.runtimeId).type === "docker") {
    loggers.diagnostic({ instanceId: id, action: "start", reason, runtimeId: current.runtimeId, imageId: current.imageSelection?.imageId, imagePhase: current.imageProvisioning.phase }, "node instance start queued until image provisioning completes");
    return state.controlledInstances.put(ControlledInstanceSchema.parse({
      ...current,
      status: "starting",
      updatedAt: now(),
    }));
  }
  loggers.diagnostic({ instanceId: id, action: "start", reason, runtimeId: current.runtimeId, imageId: current.imageSelection?.imageId }, "node instance start requested");
  const starting = state.controlledInstances.put(ControlledInstanceSchema.parse({ ...current, status: "starting", ready: false, updatedAt: now() }));
  const adapter = runtimeAdapters.forRuntime(state.requireRuntime(starting.runtimeId));
  const result = await adapter.start(state.context(starting));
  const probedEndpointStatus = await probeInstanceEndpoint(fetchImpl, ControlledInstanceSchema.parse({
    ...starting,
    ...result,
    target: result.target ? { ...starting.target, ...result.target } : starting.target,
    workspace: result.workspace ? { ...starting.workspace, error: undefined, ...result.workspace } : starting.workspace,
    runtime: result.runtime ? { ...starting.runtime, ...result.runtime } : starting.runtime,
    updatedAt: now(),
  }));
  const latest = state.requireInstance(id);
  const updated = mergeRuntimeLifecycleResult(starting, latest, {
    ...result,
    target: result.target ? { ...result.target, status: probedEndpointStatus } : undefined,
    workspace: result.workspace ? { error: undefined, ...result.workspace } : undefined,
    targetStatus: probedEndpointStatus,
    uiAccessStatus: probedEndpointStatus,
  });
  const stored = state.controlledInstances.put(updated);
  loggers.diagnostic({ instanceId: id, action: "start", reason, status: stored.status, connectionStatus: stored.connectionStatus, targetStatus: stored.targetStatus, targetWeb: stored.target.web, containerName: stored.runtime.containerName }, "node instance start completed");
  return stored;
}

export function mergeRuntimeLifecycleResult(
  baseline: ControlledInstance,
  latest: ControlledInstance,
  result: ExecutorStartResult,
) {
  const hasFreshProcessReport = latest.stateRevision > baseline.stateRevision
    && latest.lastHeartbeatAt !== baseline.lastHeartbeatAt
    && latest.agentStatus === "online";
  return ControlledInstanceSchema.parse({
    ...latest,
    ...result,
    ...(hasFreshProcessReport ? {
      status: latest.status,
      health: latest.health,
      connectionStatus: latest.connectionStatus,
      agentStatus: latest.agentStatus,
      targetStatus: latest.targetStatus,
      uiAccessStatus: latest.uiAccessStatus,
    } : {}),
    ready: hasFreshProcessReport ? latest.ready : false,
    target: result.target
      ? hasFreshProcessReport ? { ...result.target, ...latest.target } : { ...latest.target, ...result.target }
      : latest.target,
    workspace: result.workspace
      ? hasFreshProcessReport ? { ...result.workspace, ...latest.workspace } : { ...latest.workspace, ...result.workspace }
      : latest.workspace,
    runtime: result.runtime ? { ...latest.runtime, ...result.runtime } : latest.runtime,
    updatedAt: now(),
  });
}

function restoreFailurePatch(instance: ControlledInstance, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return ControlledInstanceSchema.parse({
    ...instance,
    status: "failed",
    ready: false,
    health: "failed",
    connectionStatus: "offline",
    agentStatus: "offline",
    targetStatus: "unknown",
    uiAccessStatus: "unknown",
    workspace: {
      ...instance.workspace,
      error: message,
    },
    updatedAt: now(),
  });
}

function stoppedLocalShutdownPatch(instance: ControlledInstance) {
  return ControlledInstanceSchema.parse({
    ...instance,
    status: "stopped",
    ready: false,
    health: "unknown",
    connectionStatus: "offline",
    agentStatus: "offline",
    targetStatus: "unknown",
    uiAccessStatus: "unknown",
    target: {
      ...instance.target,
      status: "unknown",
    },
    updatedAt: now(),
  });
}

export function resolvedDockerImageUpdatePatch(instance: ControlledInstance, resolvedImage: ResolvedDockerImage, timestamp = now()) {
  if (!instance.imageSnapshot) {
    throw new Error(`Instance ${instance.id} does not have an image snapshot.`);
  }
  return {
    imageSnapshot: {
      ...instance.imageSnapshot,
      requestedReference: resolvedImage.requestedReference,
      resolvedDigest: resolvedImage.resolvedDigest,
      resolvedReference: resolvedImage.resolvedReference,
      updatedAt: timestamp,
    },
    imageProvisioning: {
      phase: "ready" as const,
      requestedReference: resolvedImage.requestedReference,
      generation: (instance.imageProvisioning?.generation || 0) + 1,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function resumableLocalShutdownPatch(instance: ControlledInstance) {
  return ControlledInstanceSchema.parse({
    ...instance,
    health: "unknown",
    connectionStatus: "offline",
    agentStatus: "offline",
    targetStatus: "unknown",
    uiAccessStatus: "unknown",
    target: {
      ...instance.target,
      status: "unknown",
    },
    updatedAt: now(),
  });
}

async function stopLocalInstancesForNodeAgentShutdown(state: NodeAgentState, runtimeAdapters: RuntimeAdapterRegistry) {
  await runtimeAdapters.stopAll();
  for (const instance of state.listInstances()) {
    const runtime = state.requireRuntime(instance.runtimeId);
    if (runtime.type !== "local") {
      continue;
    }
    state.controlledInstances.put(resumableLocalShutdownPatch(instance));
  }
}

export async function createNodeAgentApp(options: CreateNodeAgentAppOptions = {}) {
  const token = options.token || process.env.TASK_HANDOFF_NODE_AGENT_TOKEN;
  const port = Number(options.port || process.env.TASK_HANDOFF_NODE_AGENT_PORT || "8091");
  const endpoint = `http://127.0.0.1:${port}`;
  const containerUrl = options.containerUrl || process.env.TASK_HANDOFF_NODE_AGENT_CONTAINER_URL;
  const paths = nodeAgentStorePaths(options.dataDir);
  const remoteSecretOverride = options.remoteSecret || process.env.TASK_HANDOFF_NODE_AGENT_REMOTE_SECRET;
  const remoteKeyIdOverride = options.remoteKeyId || process.env.TASK_HANDOFF_NODE_AGENT_REMOTE_KEY_ID;
  const identity = new NodeAgentIdentityService(paths);
  const nodeId = identity.resolveNodeId(options.nodeId || process.env.TASK_HANDOFF_NODE_ID);
  const connectionMode = options.connectionMode || (process.env.TASK_HANDOFF_NODE_AGENT_CONNECTION_MODE === "local-ipc" ? "local-ipc" : "local-loopback");
  const ipcPath = options.ipcPath || process.env.TASK_HANDOFF_NODE_AGENT_IPC_PATH || nodeAgentIpcPath(paths.dataDir);
  const controlEndpoint = connectionMode === "local-ipc" ? nodeAgentIpcEndpoint(ipcPath) : endpoint;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const state = new NodeAgentState(paths, nodeId, endpoint, containerUrl, port, platform);
  state.node.connectionMode = connectionMode;
  state.node.controlEndpoint = controlEndpoint;
  state.node.endpoint = controlEndpoint;
  state.init();
  const dockerCommandRunner = options.dockerCommandRunner || defaultCommandRunner;
  const dockerImageService = new DockerImageService(dockerCommandRunner, options.dockerTerminalCommandRunner);
  const dockerExecutor = new LocalDockerExecutor(dockerCommandRunner, {
    publishHost: "127.0.0.1",
    imageService: dockerImageService,
  });
  const runtimeAdapters = new RuntimeAdapterRegistry(
    new DockerRuntimeAdapter(dockerExecutor, dockerCommandRunner, platform, arch),
    new LocalhostRuntimeAdapter(
      options.dockerCommandRunner || defaultCommandRunner,
      paths,
      () => state.localNodeAgentUrl,
      configuredLocalControlledCommand(),
    ),
  );
  const updateCommandRunner = options.updateCommandRunner || options.dockerCommandRunner || defaultCommandRunner;
  const updateDockerImageService = new DockerImageService(updateCommandRunner);
  const fetchImpl = options.fetchImpl || fetch;
  const artifactResolver = new RuntimeArtifactResolver({ cacheDir: path.join(paths.dataDir, "runtime-artifacts"), fetchImpl });
  const releaseResolver = options.resolveRuntimeArtifactRelease
    || ((version: string, targetPlatform: string, targetArch: string) => resolvePublishedRuntimeArtifact(version, targetPlatform, targetArch, fetchImpl));
  const resolveArtifactForAdapter = async (version: string, adapter: ManagedRuntimeAdapter, context?: ExecutorContext) => {
    const target = await adapter.artifactTarget(context);
    if (options.resolveRuntimeArtifact) return options.resolveRuntimeArtifact(version, target.platform, target.arch);
    const published = await releaseResolver(version, target.platform, target.arch);
    if (published.identity.launcherAbi > target.launcherAbi) {
      throw Object.assign(
        new Error(`Runtime requires launcher ABI ${published.identity.launcherAbi}, but ${target.platform}-${target.arch} provides ABI ${target.launcherAbi}.`),
        { code: "INSTANCE_BASE_RUNTIME_INCOMPATIBLE", retryable: false },
      );
    }
    return artifactResolver.resolve(published.identity, published.source);
  };
  const adapterForInstance = (instance: ControlledInstance) => runtimeAdapters.forRuntime(state.requireRuntime(instance.runtimeId));
  const managedAdapterForInstance = (instance: ControlledInstance) => {
    const adapter = adapterForInstance(instance);
    return isManagedRuntimeAdapter(adapter) ? adapter : undefined;
  };
  const requireManagedAdapterForInstance = (instance: ControlledInstance) => {
    const adapter = managedAdapterForInstance(instance);
    if (adapter) return adapter;
    throw Object.assign(new Error(`Runtime for instance ${instance.id} does not use managed artifacts.`), {
      code: "INSTANCE_RUNTIME_ARTIFACT_UNMANAGED",
      retryable: false,
    });
  };
  const usesManagedArtifact = (instance: ControlledInstance) => Boolean(managedAdapterForInstance(instance));
  const resolveArtifactForInstance = (instance: ControlledInstance, version: string) => {
    const context = state.context(instance);
    return resolveArtifactForAdapter(version, requireManagedAdapterForInstance(instance), context);
  };
  const app = Fastify({ logger: options.logger ?? true });
  const instanceProxyMetrics = {
    requests: 0,
    active: 0,
    completed: 0,
    aborted: 0,
    limitRejected: 0,
    responseBytes: 0,
    totalDurationMs: 0,
    maxResponseBytes: instanceProxyResponseLimit(),
  };
  app.decorate("nodeAgentState", state);
  await app.register(websocket);
  const eventForwarder = new NodeAgentInstanceEventForwarder(state, token, { logger: app.log, safetyIntervalMs: Number(process.env.TASK_HANDOFF_EVENT_CONNECTION_SAFETY_INTERVAL_MS) || undefined });
  const convergence = new RuntimeConvergenceCoordinator(state.controlledInstances, packageVersion, {
    isInstalled: async (instance, desiredVersion) => {
      const artifact = await resolveArtifactForInstance(instance, desiredVersion);
      return requireManagedAdapterForInstance(instance).inspectRuntime(state.context(instance), artifact.identity);
    },
    install: async (instance, desiredVersion) => {
      const adapter = requireManagedAdapterForInstance(instance);
      await adapter.installRuntime(state.context(instance), await resolveArtifactForInstance(instance, desiredVersion));
    },
    restart: async (instance) => {
      const adapter = adapterForInstance(instance);
      const beforeRestart = state.requireInstance(instance.id);
      const restartBoundary = state.controlledInstances.put(ControlledInstanceSchema.parse({
        ...beforeRestart,
        build: undefined,
        instanceVersion: undefined,
        ready: false,
        updatedAt: now(),
      }));
      const result = await adapter.restart(state.context(restartBoundary));
      const current = state.requireInstance(instance.id);
      state.controlledInstances.put(mergeRuntimeLifecycleResult(restartBoundary, current, result));
    },
    rollback: async (instance) => requireManagedAdapterForInstance(instance).rollbackRuntime(state.context(instance)),
    onForcedDrain: (instance) => app.log.warn({ instanceId: instance.id }, "runtime convergence drain deadline reached; restarting instance"),
  }, {
    drainTimeoutMs: Number(process.env.TASK_HANDOFF_RUNTIME_DRAIN_TIMEOUT_MS) || undefined,
    verificationTimeoutMs: Number(process.env.TASK_HANDOFF_RUNTIME_VERIFY_TIMEOUT_MS) || undefined,
    maxAttempts: Number(process.env.TASK_HANDOFF_RUNTIME_MAX_ATTEMPTS) || undefined,
  });
  state.controlledInstances.setOnStored((instance) => {
    eventForwarder.publishInstanceLifecycle(instance);
    state.updateJobs.reconcileRollouts(state.listInstances(), packageVersion());
  });
  eventForwarder.start();
  for (const instance of state.listInstances()) {
    if (usesManagedArtifact(instance) && !["created", "stopped", "failed", "provisioning"].includes(instance.status)) {
      void convergence.schedule(instance.id).catch((error) => app.log.error({ instanceId: instance.id, error }, "runtime convergence recovery failed"));
    }
  }
  app.decorate("nodeAgentEventForwarder", eventForwarder);
  const runtimeMetrics = new DockerRuntimeMetricsCollector(
    dockerCommandRunner,
    () => state.listInstances().filter((instance) => state.requireRuntime(instance.runtimeId).type === "docker"),
    (metrics: InstanceResourceMetrics) => eventForwarder.publish(InstanceResourceMetricsEventType.Snapshot, metrics, { instanceId: metrics.instanceId }),
  );
  runtimeMetrics.start();
  app.decorate("nodeAgentRuntimeMetrics", runtimeMetrics);
  const diagnosticLogsEnabled = nodeAgentDiagnosticLogsEnabled();
  const pairedHmac = new NodeAgentPairedHmacVerifier(identity, nodeId, remoteSecretOverride, remoteKeyIdOverride);
  const logDiagnostic = (data: Record<string, unknown>, message: string) => {
    if (diagnosticLogsEnabled) {
      app.log.info(data, message);
    }
  };
  const lifecycleLoggers: NodeAgentLifecycleLoggers = {
    diagnostic: logDiagnostic,
    warn: (data, message) => app.log.warn(data, message),
  };
  const sanitizeCrossVersionInstanceReport = (instanceId: string, report: "register" | "heartbeat", input: unknown) => {
    const protocolVersion = input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).protocolVersion
      : undefined;
    if (typeof protocolVersion !== "string" || protocolVersion === CONTROL_PLANE_PROTOCOL_VERSION) {
      return input;
    }
    const onWarning = ({ field, action }: { field: string; action: "ignored" | "migrated" }) => app.log.warn({
      instanceId,
      report,
      protocolVersion,
      expectedProtocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      field,
      action,
    }, "cross-version controlled instance report sanitized");
    return report === "register"
      ? sanitizeCrossVersionControlledInstanceRegister(input, onWarning)
      : sanitizeCrossVersionControlledInstanceHeartbeat(input, onWarning);
  };

  const startInstanceWithFailureState = async (id: string, reason: "request" | "image-ready") => {
    try {
      let current = state.requireInstance(id);
      if (current.runtimeVersion?.phase === "failed" && usesManagedArtifact(current)) {
        current = state.controlledInstances.put(ControlledInstanceSchema.parse({
          ...current,
          ready: false,
          runtimeVersion: runtimeVersionStateForActual(reportedVersion(current)),
          updatedAt: now(),
        }));
      }
      const runtime = state.requireRuntime(current.runtimeId);
      await startNodeInstance(state, runtimeAdapters, fetchImpl, id, lifecycleLoggers);
      const started = state.requireInstance(id);
      if (runtime.type === "docker" && started.imageProvisioning?.phase !== "ready") {
        eventForwarder.syncNow();
        return started;
      }
      const instance = usesManagedArtifact(state.requireInstance(id))
        ? await convergence.schedule(id, { startRequested: true })
        : state.requireInstance(id);
      if (usesManagedArtifact(instance) && instance.runtimeVersion?.phase === "failed") {
        throw Object.assign(new Error(instance.runtimeVersion.error?.message || `Instance ${id} runtime convergence failed.`), {
          statusCode: 503,
          ...(instance.runtimeVersion.error || { code: "INSTANCE_RUNTIME_INSTALL_FAILED", retryable: true }),
        });
      }
      await autoImportAgentConfig(fetchImpl, instance, "start", lifecycleLoggers);
      eventForwarder.syncNow();
      return instance;
    } catch (error) {
      const failed = restoreFailurePatch(state.requireInstance(id), error);
      state.controlledInstances.put(failed);
      eventForwarder.syncNow();
      lifecycleLoggers.warn({ instanceId: id, action: "start", reason, error: error instanceof Error ? error.message : String(error) }, "node instance start failed");
      throw error;
    }
  };

  const startProvisionedInstance = async (id: string) => {
    await startInstanceWithFailureState(id, "image-ready").catch(() => undefined);
  };

  const provisionInstanceImage = (instance: ControlledInstance) => {
    if (!instance.imageProvisioning) return;
    void provisionNodeInstanceImage(
      state,
      dockerImageService,
      instance.id,
      instance.imageProvisioning.generation,
      () => eventForwarder.syncNow(),
      lifecycleLoggers,
      (terminalEvent) => {
        const base = {
          instanceId: instance.id,
          generation: instance.imageProvisioning!.generation,
          requestedReference: instance.imageProvisioning!.requestedReference,
          observedAt: now(),
        };
        if ("outcome" in terminalEvent) {
          eventForwarder.publish(ImagePullTerminalEventType.Finished, { ...base, sequence: terminalEvent.sequence * 1000, outcome: terminalEvent.outcome }, { instanceId: instance.id });
          return;
        }
        for (const [index, data] of splitTerminalOutput(terminalEvent.data).entries()) {
          eventForwarder.publish(ImagePullTerminalEventType.Output, { ...base, sequence: terminalEvent.sequence * 1000 + index, data, ...(terminalEvent.replay ? { replay: true } : {}) }, { instanceId: instance.id });
        }
      },
      () => startProvisionedInstance(instance.id),
    );
  };

  const resolvePreflightRuntimeArtifacts = async (version: string) => {
    const adapters = new Map<string, { adapter: ManagedRuntimeAdapter; context?: ExecutorContext }>();
    for (const adapter of runtimeAdapters.managedAdapters()) {
      const target = await adapter.artifactTarget();
      adapters.set(`${target.platform}-${target.arch}`, { adapter });
    }
    for (const instance of state.listInstances()) {
      const adapter = managedAdapterForInstance(instance);
      if (!adapter) continue;
      const context = state.context(instance);
      const target = await adapter.artifactTarget(context);
      adapters.set(`${target.platform}-${target.arch}`, { adapter, context });
    }
    const artifacts = await Promise.all([...adapters.values()].map(({ adapter, context }) => resolveArtifactForAdapter(version, adapter, context)));
    return artifacts.sort((left, right) => `${left.identity.platform}/${left.identity.arch}`.localeCompare(`${right.identity.platform}/${right.identity.arch}`));
  };

  const checkUpdate = async (input: z.infer<typeof UpdateCheckRequestSchema>) => {
    const impact = currentUpdateImpact();
    const check = await checkNodeAgentUpdate({
      channel: input.channel,
      currentVersion: packageVersion(),
      runCommand: updateCommandRunner,
      impact,
    });
    if (!check.updateAvailable) return check;
    const artifacts = await resolvePreflightRuntimeArtifacts(check.availableVersion);
    const result: UpdateCheckResult = {
      ...check,
      runtimeArtifacts: artifacts.map((artifact) => artifact.identity),
      preflightToken: createSecret(),
    };
    updatePreflights.set(result.preflightToken!, { result, expiresAt: Date.now() + UPDATE_PREFLIGHT_TTL_MS });
    return result;
  };

  const currentUpdateImpact = (): UpdateCheckResult["impact"] => {
    const instances = state.listInstances();
    const running = instances.filter((instance) => !["created", "stopped", "failed"].includes(instance.status));
    const active = running.filter((instance) => instance.apps.runningCount > 0 || instance.aiSessions.runningCount > 0);
    return {
      runningInstanceCount: running.length,
      stoppedInstanceCount: instances.length - running.length,
      activeInstanceCount: active.length,
      restartInstanceCount: running.length,
      runningInstanceIds: running.map((instance) => instance.id).sort(),
      stoppedInstanceIds: instances.filter((instance) => !running.includes(instance)).map((instance) => instance.id).sort(),
      activeInstanceIds: active.map((instance) => instance.id).sort(),
    };
  };

  const updatePreflights = new Map<string, { result: UpdateCheckResult; expiresAt: number }>();

  const consumeUpdatePreflight = async (input: z.infer<typeof NodeAgentApplyUpdateRequestSchema>) => {
    const preflight = updatePreflights.get(input.preflightToken);
    updatePreflights.delete(input.preflightToken);
    if (!preflight || preflight.expiresAt <= Date.now()) {
      const error = new Error("The update preflight is missing or expired. Check for updates again.");
      Object.assign(error, { statusCode: 409, code: "UPDATE_PREFLIGHT_EXPIRED" });
      throw error;
    }
    const check = preflight.result;
    const unchanged = check.channel === input.channel
      && check.availableVersion === input.targetVersion
      && check.currentVersion === packageVersion()
      && JSON.stringify(check.impact) === JSON.stringify(currentUpdateImpact());
    if (!unchanged) {
      const error = new Error("The update target or affected instances changed after preflight. Check for updates again.");
      Object.assign(error, { statusCode: 409, code: "UPDATE_PREFLIGHT_STALE" });
      throw error;
    }
    const currentArtifacts = await resolvePreflightRuntimeArtifacts(check.availableVersion);
    if (JSON.stringify(check.runtimeArtifacts) !== JSON.stringify(currentArtifacts.map((artifact) => artifact.identity))) {
      const error = new Error("The runtime artifacts changed after preflight. Check for updates again.");
      Object.assign(error, { statusCode: 409, code: "UPDATE_PREFLIGHT_STALE" });
      throw error;
    }
    return check;
  };

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
        "node agent request failed",
      );
    }
    reply.code(payload.statusCode).send({
      error: {
        code: payload.code,
        message: payload.message,
        ...(error && typeof error === "object" && typeof (error as { expectedVersion?: unknown }).expectedVersion === "string"
          ? { expectedVersion: (error as { expectedVersion: string }).expectedVersion }
          : {}),
        ...(error && typeof error === "object" && typeof (error as { actualVersion?: unknown }).actualVersion === "string"
          ? { actualVersion: (error as { actualVersion: string }).actualVersion }
          : {}),
        ...(error && typeof error === "object" && typeof (error as { phase?: unknown }).phase === "string"
          ? { phase: (error as { phase: string }).phase }
          : {}),
        ...(error && typeof error === "object" && typeof (error as { retryable?: unknown }).retryable === "boolean"
          ? { retryable: (error as { retryable: boolean }).retryable }
          : {}),
        ...(error && typeof error === "object" && typeof (error as { blockingInstanceCount?: unknown }).blockingInstanceCount === "number"
          ? { blockingInstanceCount: (error as { blockingInstanceCount: number }).blockingInstanceCount }
          : {}),
      },
    });
  });

  app.addHook("preHandler", async (request) => {
    const hmacKeyId = pairedHmac.verify(request);
    if (hmacKeyId) {
      request.nodeAgentAuthKeyId = hmacKeyId;
      return;
    }
    if (isUnixSocketRequest(request)) {
      if (token && bearerToken(request.headers) !== token) {
        const error = new Error("Invalid node agent token.");
        Object.assign(error, { statusCode: 401, code: "NODE_AGENT_UNAUTHORIZED" });
        throw error;
      }
      return;
    }
    if (isPairingCompleteRoute(request.url)) {
      return;
    }
    if (isInstanceReportRoute(request.url)) {
      return;
    }
    if (pairedHmac.hasRemoteSecrets()) {
      const error = new Error("Node agent HMAC signature is required.");
      Object.assign(error, { statusCode: 401, code: "NODE_AGENT_HMAC_SIGNATURE_REQUIRED" });
      throw error;
    }
    if (!isLocalStaticKeyConnection(request)) {
      const error = new Error("Local node agent access is only accepted from loopback or local IPC connections.");
      Object.assign(error, { statusCode: 401, code: "NODE_AGENT_LOCAL_TOKEN_REQUIRES_LOOPBACK" });
      throw error;
    }
    if (token && bearerToken(request.headers) !== token) {
      const error = new Error("Invalid node agent token.");
      Object.assign(error, { statusCode: 401, code: "NODE_AGENT_UNAUTHORIZED" });
      throw error;
    }
  });

  app.addHook("onClose", async () => {
    runtimeMetrics.stop();
    eventForwarder.stop();
    for (const instance of state.listInstances()) convergence.cancel(instance.id);
    await stopLocalInstancesForNodeAgentShutdown(state, runtimeAdapters);
  });

  const restoreLocalInstances = async () => {
    for (const instance of state.listInstances().filter((item) => ["provisioning", "starting"].includes(item.status) && item.imageProvisioning?.phase !== "ready" && state.requireRuntime(item.runtimeId).type === "docker")) {
      provisionInstanceImage(instance);
    }
    const instances = state.listInstances().filter((instance) => {
      const runtime = state.requireRuntime(instance.runtimeId);
      return runtime.type === "local" && RESTORABLE_LOCAL_INSTANCE_STATUSES.has(instance.status);
    });
    for (const instance of instances) {
      try {
        await startNodeInstance(state, runtimeAdapters, fetchImpl, instance.id, lifecycleLoggers, "restore");
        await autoImportAgentConfig(fetchImpl, state.requireInstance(instance.id), "start", lifecycleLoggers);
      } catch (error) {
        state.controlledInstances.put(restoreFailurePatch(state.requireInstance(instance.id), error));
        logDiagnostic({ instanceId: instance.id, action: "restore", error: error instanceof Error ? error.message : String(error) }, "node local instance restore failed");
      }
    }
  };

  app.decorate("nodeAgentRestoreLocalInstances", restoreLocalInstances);

  app.get("/api/node-agent/health", async () => ({
    data: {
      ok: true,
      role: "node-agent",
      nodeId,
      platform: finalComputerPlatform(platform),
      arch: process.arch,
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      build: buildInfo("node-agent"),
      instanceProxy: { ...instanceProxyMetrics },
      serverTime: new Date().toISOString(),
    },
  }));

  const requireListenerManager = (request: { ip?: string; socket: { remoteAddress?: string; remoteFamily?: string } }) => {
    if (!isUnixSocketRequest(request)) {
      const error = new Error("Node agent TCP listener settings are available only over local Unix IPC.");
      Object.assign(error, { statusCode: 403, code: "NODE_AGENT_LISTENER_LOCAL_IPC_ONLY" });
      throw error;
    }
    if (!app.nodeAgentListenerManager) {
      const error = new Error("Node agent TCP listener manager is not initialized.");
      Object.assign(error, { statusCode: 503, code: "NODE_AGENT_LISTENER_UNAVAILABLE" });
      throw error;
    }
    return app.nodeAgentListenerManager;
  };

  app.get("/api/node-agent/settings/external-listener", async (request) => ({
    data: requireListenerManager(request).current(),
  }));

  app.patch("/api/node-agent/settings/external-listener", async (request) => ({
    data: await requireListenerManager(request).update(request.body),
  }));

  app.get("/api/node-agent/updates/jobs", async () => ({ data: state.updateJobs.list() }));

  app.post("/api/node-agent/updates/check", async (request) => ({
    data: await checkUpdate(UpdateCheckRequestSchema.parse(request.body)),
  }));

  app.post("/api/node-agent/updates/apply", async (request, reply) => {
    const input = NodeAgentApplyUpdateRequestSchema.parse(request.body);
    const check = await consumeUpdatePreflight(input);
    if (!check.supported) {
      const error = new Error(check.reason || "The requested update is not supported.");
      Object.assign(error, { statusCode: 400, code: "UPDATE_UNSUPPORTED" });
      throw error;
    }
    if (!check.updateAvailable) {
      const error = new Error(check.reason || "No update is available for the selected channel.");
      Object.assign(error, { statusCode: 409, code: "UPDATE_NOT_AVAILABLE" });
      throw error;
    }
    const job = state.updateJobs.create(nodeId, check);
    const moduleDir = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : __dirname;
    const { worker, packaged, expectedWorker } = resolveNodeAgentUpdateWorker(moduleDir);
    if (!worker) {
      state.updateJobs.patch(job.id, {
        status: "failed",
        rollout: { ...job.rollout, phase: "failed" },
        error: { code: "NODE_UPDATE_FAILED", message: `Update worker was not found: ${expectedWorker}`, retryable: false },
        completedAt: now(),
      });
      const error = new Error(`Node agent update worker was not found: ${expectedWorker}`);
      Object.assign(error, { statusCode: 500, code: "UPDATE_WORKER_NOT_FOUND" });
      throw error;
    }
    await updateCommandRunner("systemd-run", [
      "--unit", `task-handoff-update-${job.id}`,
      "--collect",
      "--property=Type=exec",
      ...(packaged ? [worker] : [process.execPath, worker]),
      "--job-file", state.updateJobs.records.filePath(job.id),
      "--target-version", job.toVersion,
      "--npm-command", npmCommand(),
    ]);
    return reply.code(202).send({ data: job });
  });

  app.post("/api/node-agent/pairing/invites", async (request, reply) => {
    const invite = identity.createPairingInvite(NodeAgentPairingInviteSchema.parse(request.body || {}));
    return reply.code(201).send({
      data: {
        nodeId,
        joinToken: invite.token,
        expiresAt: invite.expiresAt,
      },
    });
  });

  app.post("/api/node-agent/pairing/complete", async (request, reply) => {
    const remote = identity.completePairingInvite(NodeAgentPairingCompleteSchema.parse(request.body));
    return reply.code(201).send({
      data: {
        nodeId,
        keyId: remote.keyId,
        secret: remote.secret,
        pairedAt: remote.pairedAt,
      },
    });
  });

  app.get("/api/node-agent/remotes", async (request) => ({
    data: identity.listRemoteControlPlanes(request.nodeAgentAuthKeyId),
  }));

  app.delete("/api/node-agent/remotes/:keyId", async (request) => {
    const keyId = z.string().trim().min(1).max(160).parse((request.params as { keyId: string }).keyId);
    return {
      data: {
        deleted: identity.deleteRemoteControlPlane(keyId, request.nodeAgentAuthKeyId),
      },
    };
  });

  app.post("/api/node-agent/remotes/connect", async (request, reply) => {
    const input = NodeAgentRemoteConnectSchema.parse(request.body);
    const controlPlaneUrl = assertHttpControlPlaneUrl(input.controlPlaneUrl);
    const remote = identity.createRemoteControlPlane({
      url: controlPlaneUrl,
      ...(input.controlPlaneName ? { name: input.controlPlaneName } : {}),
      active: input.activate !== false,
    });
    const joined = await completeControlPlaneJoin(fetchImpl, controlPlaneUrl, {
      joinToken: input.joinToken,
      nodeId,
      nodeName: state.node.name,
      keyId: remote.keyId,
      secret: remote.secret,
      pairedAt: remote.pairedAt,
    });
    const stored = identity.upsertRemoteControlPlane({
      ...remote,
      ...(typeof joined.name === "string" && joined.name ? { name: input.controlPlaneName || joined.name } : {}),
    });
    let tunnelStatus: "disabled" | "saved" | "connecting" | "failed" = stored.active !== false ? "saved" : "disabled";
    let tunnelError: string | undefined;
    if (stored.active !== false) {
      if (app.nodeAgentReverseTunnels) {
        try {
          app.nodeAgentReverseTunnels.connect({ url: controlPlaneUrl, keyId: stored.keyId, secret: stored.secret });
          tunnelStatus = "connecting";
        } catch (error) {
          tunnelStatus = "failed";
          tunnelError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    return reply.code(201).send({
      data: {
        remote: {
          id: stored.id,
          url: stored.url,
          keyId: stored.keyId,
          pairedAt: stored.pairedAt,
          active: stored.active !== false,
        },
        tunnel: {
          status: tunnelStatus,
          ...(tunnelError ? { error: tunnelError } : {}),
        },
      },
    });
  });

  app.get("/api/node-agent/runtimes", async () => ({
    data: state.nodeRuntimes.list(),
  }));

  app.post("/api/node-agent/runtimes", async (request, reply) => reply.code(201).send({ data: state.createRuntime(CreateNodeRuntimeSchema.parse(request.body)) }));

  app.patch("/api/node-agent/runtimes/:id", async (request) => ({
    data: state.updateRuntime((request.params as { id: string }).id, UpdateNodeRuntimeSchema.parse(request.body)),
  }));

  app.delete("/api/node-agent/runtimes/:id", async (request) => ({
    data: {
      deleted: state.deleteRuntime((request.params as { id: string }).id),
    },
  }));

  app.post("/api/node-agent/runtimes/:id/check", async (request) => {
    const runtime = state.requireRuntime((request.params as { id: string }).id);
    return { data: await state.checkRuntime(runtime.id, runtimeAdapters.forRuntime(runtime)) };
  });

  app.get("/api/node-agent/local-folders", async () => ({
    data: state.localFolders.list(),
  }));

  app.get("/api/node-agent/folders/tree", async (request) => ({
    data: listFolderTree(FolderTreeQuerySchema.parse(request.query)),
  }));

  app.post("/api/node-agent/local-folders", async (request, reply) => reply.code(201).send({ data: state.createLocalFolder(CreateLocalFolderSchema.parse(request.body)) }));

  app.delete("/api/node-agent/local-folders/:id", async (request) => ({
    data: {
      deleted: state.localFolders.delete((request.params as { id: string }).id),
    },
  }));

  app.get("/api/node-agent/models", async () => ({
    data: state.listModels(),
  }));

  app.post("/api/node-agent/models", async (request, reply) => reply.code(201).send({
    data: state.createModel(CreateNodeModelSchema.parse(request.body)),
  }));

  app.put("/api/node-agent/models/:id/deploy", async (request) => {
    const id = (request.params as { id: string }).id;
    const input = DeployNodeModelSchema.parse(request.body);
    if (input.id !== id) {
      throw Object.assign(new Error(`Model payload id ${input.id} does not match route id ${id}.`), { statusCode: 400, code: "NODE_MODEL_ID_MISMATCH" });
    }
    return { data: state.deployModel(input) };
  });

  app.patch("/api/node-agent/models/:id", async (request) => ({
    data: state.updateModel((request.params as { id: string }).id, UpdateNodeModelSchema.parse(request.body)),
  }));

  app.delete("/api/node-agent/models/:id", async (request) => ({
    data: { deleted: state.deleteModel((request.params as { id: string }).id) },
  }));

  app.get("/api/node-agent/instances", async () => ({
    data: state.listInstances(),
  }));

  app.post("/api/node-agent/instances", async (request, reply) => {
    const instance = state.createInstance(CreateNodeInstanceSchema.parse(request.body));
    eventForwarder.syncNow();
    if (instance.imageProvisioning) {
      provisionInstanceImage(instance);
    }
    return reply.code(201).send({ data: instance });
  });

  app.post("/api/node-agent/instances/:id/image-provisioning/retry", async (request) => {
    const instance = retryNodeInstanceImageProvisioning(state, (request.params as { id: string }).id);
    eventForwarder.syncNow();
    provisionInstanceImage(instance);
    return { data: instance };
  });

  app.patch("/api/node-agent/instances/:id", async (request) => {
    const id = (request.params as { id: string }).id;
    const current = state.requireInstance(id);
    const parsed = UpdateNodeInstanceSchema.parse(request.body);
    const updated = ControlledInstanceSchema.parse({
      ...current,
      ...parsed,
      ...(parsed.config ? { config: { ...current.config, ...parsed.config } } : {}),
      updatedAt: now(),
    });
    const stored = state.controlledInstances.put(updated);
    eventForwarder.syncNow();
    return { data: stored };
  });

  app.put("/api/node-agent/instances/:id/model-assignment", async (request) => {
    const id = (request.params as { id: string }).id;
    const result = state.assignModels(id, UpdateNodeModelAssignmentSchema.parse(request.body));
    await syncAssignedModelEnvironment(fetchImpl, state, id);
    return { data: result };
  });

  app.post("/api/node-agent/instances/:id/register", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const payload = sanitizeCrossVersionInstanceReport(id, "register", request.body);
    const registered = state.registerInstance(id, ControlledInstanceRegisterSchema.parse(payload), bearerToken(request.headers));
    eventForwarder.syncNow();
    logDiagnostic({ instanceId: id, action: "register", protocolVersion: registered.protocolVersion, build: registered.build, targetStatus: registered.targetStatus, targetStrategy: registered.target.strategy }, "node instance registered");
    if (usesManagedArtifact(registered) && (!registered.ready || registered.runtimeVersion?.phase !== "matched")) {
      void convergence.schedule(id).catch((error) => app.log.error({ instanceId: id, error }, "runtime convergence after registration failed"));
    }
    return reply.code(201).send({ data: registered });
  });

  app.post("/api/node-agent/instances/:id/heartbeat", async (request) => {
    const id = (request.params as { id: string }).id;
    const payload = sanitizeCrossVersionInstanceReport(id, "heartbeat", request.body);
    const updated = state.heartbeatInstance(id, ControlledInstanceHeartbeatSchema.parse(payload), bearerToken(request.headers));
    eventForwarder.syncNow();
    logDiagnostic({ instanceId: id, action: "heartbeat", status: updated.status, health: updated.health, protocolVersion: updated.protocolVersion, build: updated.build, targetStatus: updated.targetStatus, apps: updated.apps.runningCount }, "node instance heartbeat accepted");
    if (usesManagedArtifact(updated) && (!updated.ready || updated.runtimeVersion?.phase !== "matched")) {
      void convergence.schedule(id).catch((error) => app.log.error({ instanceId: id, error }, "runtime convergence after heartbeat failed"));
    }
    return { data: updated };
  });

  app.get("/api/node-agent/events", { websocket: true }, (socket) => {
    const ws = socket as WebSocket;
    ws.send(JSON.stringify({ type: "node-agent.events.connected", nodeId, serverTime: new Date().toISOString() }));
    const dispose = eventForwarder.addOutput(ws);
    ws.on("close", dispose);
    ws.on("error", dispose);
  });

  app.get("/api/node-agent/docker/images", async () => ({
    data: await listLocalDockerImages(options.dockerCommandRunner),
  }));

  app.get("/api/node-agent/instances/:id/metrics", async (request) => {
    const id = (request.params as { id: string }).id;
    const instance = state.requireInstance(id);
    if (state.requireRuntime(instance.runtimeId).type !== "docker") {
      const error = new Error(`Runtime type ${state.requireRuntime(instance.runtimeId).type} does not provide resource metrics.`);
      Object.assign(error, { statusCode: 409, code: "INSTANCE_METRICS_UNSUPPORTED" });
      throw error;
    }
    return { data: await runtimeMetrics.snapshot(id) };
  });

  app.post("/api/node-agent/instances/:id/start", async (request) => {
    const id = (request.params as { id: string }).id;
    NodeInstanceLifecycleRequestSchema.parse(request.body);
    const instance = await startInstanceWithFailureState(id, "request");
    return { data: instance };
  });

  app.post("/api/node-agent/instances/:id/runtime/reconcile", async (request) => {
    const id = (request.params as { id: string }).id;
    NodeInstanceLifecycleRequestSchema.parse(request.body);
    const current = state.requireInstance(id);
    state.controlledInstances.put(ControlledInstanceSchema.parse({
      ...current,
      ready: false,
      runtimeVersion: runtimeVersionStateForActual(reportedVersion(current)),
      updatedAt: now(),
    }));
    const instance = await convergence.schedule(id, {
      startRequested: !["created", "stopped"].includes(current.status),
      resumeCancelled: true,
    });
    eventForwarder.syncNow();
    return { data: instance };
  });

  app.post("/api/node-agent/instances/:id/stop", async (request) => {
    const id = (request.params as { id: string }).id;
    await convergence.cancel(id);
    const current = state.requireInstance(id);
    logDiagnostic({ instanceId: current.id, action: "stop", runtimeId: current.runtimeId, containerName: current.runtime.containerName }, "node instance stop requested");
    const adapter = runtimeAdapters.forRuntime(state.requireRuntime(current.runtimeId));
    const result = await adapter.stop(state.context(current));
    const updated = ControlledInstanceSchema.parse({
      ...current,
      ...result,
      ready: false,
      agentStatus: "offline",
      targetStatus: "unknown",
      uiAccessStatus: "unknown",
      updatedAt: now(),
    });
    const stored = state.controlledInstances.put(updated);
    eventForwarder.syncNow();
    logDiagnostic({ instanceId: current.id, action: "stop", status: stored.status, connectionStatus: stored.connectionStatus, containerName: stored.runtime.containerName }, "node instance stop completed");
    return { data: stored };
  });

  app.post("/api/node-agent/instances/:id/restart", async (request) => {
    const id = (request.params as { id: string }).id;
    const current = state.requireInstance(id);
    NodeInstanceLifecycleRequestSchema.parse(request.body);
    if (usesManagedArtifact(current) && (!current.ready || current.runtimeVersion?.phase !== "matched")) {
      const instance = await convergence.schedule(id, { startRequested: true });
      eventForwarder.syncNow();
      return { data: instance };
    }
    logDiagnostic({ instanceId: id, action: "restart", runtimeId: current.runtimeId, imageId: current.imageSelection?.imageId, containerName: current.runtime.containerName }, "node instance restart requested");
    const adapter = runtimeAdapters.forRuntime(state.requireRuntime(current.runtimeId));
    const result = await adapter.restart(state.context(current));
    const probeTarget = ControlledInstanceSchema.parse({ ...current, ...result, target: result.target ? { ...current.target, ...result.target } : current.target, updatedAt: now() });
    const probedEndpointStatus = await probeInstanceEndpoint(fetchImpl, probeTarget);
    const latest = state.requireInstance(id);
    const updated = mergeRuntimeLifecycleResult(current, latest, {
      ...result,
      target: result.target ? { ...result.target, status: probedEndpointStatus } : undefined,
      targetStatus: probedEndpointStatus,
      uiAccessStatus: probedEndpointStatus,
    });
    const stored = state.controlledInstances.put(updated);
    await autoImportAgentConfig(fetchImpl, stored, "restart", lifecycleLoggers);
    eventForwarder.syncNow();
    logDiagnostic({ instanceId: id, action: "restart", status: stored.status, connectionStatus: stored.connectionStatus, targetStatus: stored.targetStatus, targetWeb: stored.target.web, containerName: stored.runtime.containerName }, "node instance restart completed");
    return { data: stored };
  });

  app.post("/api/node-agent/instances/:id/delete", async (request) => {
    const id = (request.params as { id: string }).id;
    const current = state.requireInstance(id);
    await convergence.cancel(id);
    logDiagnostic({ instanceId: id, action: "delete", runtimeId: current.runtimeId, containerName: current.runtime.containerName }, "node instance delete requested");
    const adapter = runtimeAdapters.forRuntime(state.requireRuntime(current.runtimeId));
    await adapter.delete(state.context(current, {}));
    logDiagnostic({ instanceId: id, action: "delete" }, "node instance delete completed");
    const deleted = state.controlledInstances.delete(id);
    state.modelAssignments.delete(id);
    state.modelEnvironments.delete(id);
    eventForwarder.syncNow();
    return { data: { deleted } };
  });

  app.post("/api/node-agent/instances/:id/proxy", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = ProxyRequestSchema.parse(request.body);
    const instance = state.requireInstance(id);
    const instanceBase = nodeLocalInstanceWebBase(instance);
    const proxyPath = parsed.path.startsWith("/") ? parsed.path : `/${parsed.path}`;
    if (parsed.method === "POST" && proxyPath === "/api/apps/sessions") {
      await syncAssignedModelEnvironment(fetchImpl, state, id);
    }
    logDiagnostic({ instanceId: id, action: "proxy", method: parsed.method, path: proxyPath, instanceBase }, "node instance proxy requested");
    const response = await fetchImpl(`${instanceBase}${proxyPath}`, {
      method: parsed.method,
      headers: {
        ...parsed.headers,
      },
      body: proxyRequestBody(parsed),
    });
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const text = await response.text();
    logDiagnostic({ instanceId: id, action: "proxy", method: parsed.method, path: proxyPath, statusCode: response.status, contentType }, "node instance proxy completed");
    reply.code(response.status).type(contentType).send(text);
  });

  app.post("/api/node-agent/instances/:id/proxy/stream", { bodyLimit: INSTANCE_PROXY_REQUEST_BODY_LIMIT }, async (request, reply) => {
    const startedAt = Date.now();
    instanceProxyMetrics.requests += 1;
    instanceProxyMetrics.active += 1;
    const controller = new AbortController();
    let responseBytes = 0;
    let streaming = false;
    let finalized = false;
    const finalize = (outcome: "completed" | "aborted") => {
      if (finalized) return;
      finalized = true;
      instanceProxyMetrics.active -= 1;
      instanceProxyMetrics.totalDurationMs += Date.now() - startedAt;
      instanceProxyMetrics.responseBytes += responseBytes;
      instanceProxyMetrics[outcome] += 1;
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
      const instance = state.requireInstance(id);
      const instanceBase = nodeLocalInstanceWebBase(instance);
      const proxyPath = parsed.path.startsWith("/") ? parsed.path : `/${parsed.path}`;
      logDiagnostic({ instanceId: id, action: "proxy.stream", method: parsed.method, path: proxyPath, instanceBase }, "node instance streaming proxy requested");
      const response = await fetchImpl(`${instanceBase}${proxyPath}`, {
        method: parsed.method,
        headers: { ...parsed.headers },
        body: proxyRequestBody(parsed),
        signal: controller.signal,
      });
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > instanceProxyMetrics.maxResponseBytes) {
        instanceProxyMetrics.limitRejected += 1;
        controller.abort();
        return reply.code(502).send({ error: { code: "INSTANCE_PROXY_RESPONSE_TOO_LARGE", message: `Instance response exceeds ${instanceProxyMetrics.maxResponseBytes} bytes.` } });
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
          if (responseBytes > instanceProxyMetrics.maxResponseBytes) {
            instanceProxyMetrics.limitRejected += 1;
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
    const instanceBase = nodeLocalInstanceWebBase(state.requireInstance(id));
    const proxyPath = parsed.path.startsWith("/") ? parsed.path : `/${parsed.path}`;
    logDiagnostic({ instanceId: id, action: "proxy.raw", method: parsed.method, path: proxyPath, instanceBase }, "node instance raw proxy requested");
    const response = await fetchImpl(`${instanceBase}${proxyPath}`, {
      method: parsed.method,
      headers: {
        ...parsed.headers,
      },
      body: proxyRequestBody(parsed),
    });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > instanceProxyMetrics.maxResponseBytes) {
      instanceProxyMetrics.limitRejected += 1;
      return reply.code(502).send({ error: { code: "INSTANCE_PROXY_RESPONSE_TOO_LARGE", message: `Instance response exceeds ${instanceProxyMetrics.maxResponseBytes} bytes.` } });
    }
    let bytes: Buffer;
    try {
      bytes = await readResponseBodyWithLimit(response, instanceProxyMetrics.maxResponseBytes);
    } catch (error) {
      if (!(error instanceof Error) || (error as Error & { code?: string }).code !== "INSTANCE_PROXY_RESPONSE_TOO_LARGE") throw error;
      instanceProxyMetrics.limitRejected += 1;
      return reply.code(502).send({ error: { code: "INSTANCE_PROXY_RESPONSE_TOO_LARGE", message: `Instance response exceeds ${instanceProxyMetrics.maxResponseBytes} bytes.` } });
    }
    logDiagnostic({ instanceId: id, action: "proxy.raw", method: parsed.method, path: proxyPath, statusCode: response.status, byteLength: bytes.length }, "node instance raw proxy completed");
    return {
      data: {
        status: response.status,
        headers: proxyResponseHeaders(response.headers),
        bodyBase64: bytes.toString("base64"),
      },
    };
  });

  app.get("/api/node-agent/instances/:id/proxy/ws/*", { websocket: true }, (socket, request) => {
    const id = (request.params as { id: string; "*": string }).id;
    const suffix = (request.params as { id: string; "*": string })["*"] || "";
    const queryIndex = request.url.indexOf("?");
    const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
    let upstream: WebSocket | undefined;
    try {
      const instanceBase = nodeLocalInstanceWebBase(state.requireInstance(id));
      const upstreamUrl = new URL(`/${suffix}${query}`, `${instanceBase}/`);
      upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
      const protocols = proxyWebSocketProtocols(request.headers);
      logDiagnostic({ instanceId: id, action: "proxy.ws", path: `/${suffix}${query}`, upstreamUrl: upstreamUrl.toString(), protocols: protocols || [] }, "node instance websocket proxy opening");
      upstream = protocols ? new WebSocket(upstreamUrl, protocols) : new WebSocket(upstreamUrl);
      upstream.on("open", () => {
        logDiagnostic({ instanceId: id, action: "proxy.ws", path: `/${suffix}${query}` }, "node instance websocket proxy opened");
        socket.on("message", (data, isBinary) => upstream?.readyState === WebSocket.OPEN && upstream.send(websocketPayload(data, isBinary)));
        socket.on("close", () => upstream?.close());
        socket.on("error", () => upstream?.close());
      });
      upstream.on("message", (data, isBinary) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(isBinary ? data : data.toString());
        }
      });
      upstream.on("close", () => {
        logDiagnostic({ instanceId: id, action: "proxy.ws", path: `/${suffix}${query}` }, "node instance websocket proxy closed");
        socket.close();
      });
      upstream.on("error", (error) => {
        logDiagnostic({ instanceId: id, action: "proxy.ws", path: `/${suffix}${query}`, error: error instanceof Error ? error.message : String(error) }, "node instance websocket proxy failed");
        socket.close(1011, "Instance websocket proxy failed.");
      });
    } catch (error) {
      logDiagnostic({ instanceId: id, action: "proxy.ws", path: `/${suffix}${query}`, error: error instanceof Error ? error.message : String(error) }, "node instance websocket endpoint unavailable");
      upstream?.close();
      socket.close(1011, "Instance websocket endpoint is not reachable.");
    }
  });

  return app;
}

function controlPlaneTunnelUrl(options: RunNodeAgentServerOptions) {
  const explicit = options.controlPlaneTunnelUrl || process.env.TASK_HANDOFF_CONTROL_PLANE_TUNNEL_URL;
  if (explicit) {
    return explicit;
  }
  const base = process.env.TASK_HANDOFF_CONTROL_PLANE_URL;
  if (!base) {
    return undefined;
  }
  const url = new URL("/api/node-agent/tunnel", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function controlPlaneTunnelUrlForBase(controlPlaneUrl: string) {
  const url = new URL("/api/node-agent/tunnel", controlPlaneUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function connectReverseTunnel(app: Awaited<ReturnType<typeof createNodeAgentApp>>, input: {
  tunnelUrl: string;
  nodeId: string;
  port: number | string | (() => number | string);
  token?: string;
  keyId?: string;
  secret?: string;
}) {
  const url = new URL(input.tunnelUrl);
  url.searchParams.set("nodeId", input.nodeId);
  const tunnelHeaders = input.secret
    ? createNodeAgentHmacHeaders({
        nodeId: input.nodeId,
        keyId: input.keyId,
        secret: input.secret,
        method: "GET",
        pathWithQuery: `${url.pathname}${url.search}`,
      })
    : {};
  const socket = new WebSocket(url, { headers: tunnelHeaders });
  const streams = new Map<string, { upstream?: WebSocket; tunnel?: WebSocket; close: (code?: number, reason?: string) => void }>();
  const httpStreams = new Map<string, { tunnel: WebSocket; controller: AbortController }>();
  let disposeEventForwarderOutput: (() => void) | undefined;
  const localNodeAgentWsUrl = (route: string) => {
    const path = route.startsWith("/") ? route : `/${route}`;
    const port = typeof input.port === "function" ? input.port() : input.port;
    const localUrl = new URL(`/api/node-agent${path}`, `http://127.0.0.1:${port}`);
    localUrl.protocol = "ws:";
    return localUrl;
  };
  const localNodeAgentHttpUrl = (route: string) => {
    const path = route.startsWith("/") ? route : `/${route}`;
    const port = typeof input.port === "function" ? input.port() : input.port;
    return new URL(`/api/node-agent${path}`, `http://127.0.0.1:${port}`);
  };
  const controlPlaneStreamUrl = (streamId: string) => {
    const streamUrl = new URL(url);
    streamUrl.pathname = `${streamUrl.pathname.replace(/\/$/, "")}/streams/${encodeURIComponent(streamId)}`;
    return streamUrl;
  };
  const controlPlaneHttpStreamUrl = (streamId: string) => {
    const streamUrl = new URL(url);
    streamUrl.pathname = `${streamUrl.pathname.replace(/\/$/, "")}/http-streams/${encodeURIComponent(streamId)}`;
    return streamUrl;
  };
  const controlPlaneStreamHeaders = (streamUrl: URL) => input.secret
    ? createNodeAgentHmacHeaders({
        nodeId: input.nodeId,
        keyId: input.keyId,
        secret: input.secret,
        method: "GET",
        pathWithQuery: `${streamUrl.pathname}${streamUrl.search}`,
      })
    : {};
  const closeStream = (streamId: string, code = 1000, reason = "") => {
    const stream = streams.get(streamId);
    streams.delete(streamId);
    stream?.upstream?.close(code, reason);
    stream?.tunnel?.close(code, reason);
  };
  const sendHttpFrame = (tunnel: WebSocket, data: string | Buffer, binary = false) => new Promise<void>((resolve, reject) => {
    tunnel.send(data, { binary }, (error) => error ? reject(error) : resolve());
  });
  socket.on("open", () => {
    socket.send(JSON.stringify({ type: "node-agent.identify", nodeId: input.nodeId, serverTime: new Date().toISOString() }));
    disposeEventForwarderOutput = app.nodeAgentEventForwarder?.addOutput(socket);
  });
  socket.on("close", () => {
    for (const streamId of streams.keys()) {
      closeStream(streamId, 1001, "Reverse tunnel disconnected.");
    }
    for (const [streamId, stream] of httpStreams) {
      httpStreams.delete(streamId);
      stream.controller.abort();
      stream.tunnel.close(1001, "Reverse tunnel disconnected.");
    }
    disposeEventForwarderOutput?.();
    disposeEventForwarderOutput = undefined;
  });
  socket.on("message", async (raw) => {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      socket.send(JSON.stringify({ type: "node-agent.error", code: "INVALID_JSON" }));
      return;
    }
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    if (record.type === "control-plane.http.open") {
      const streamId = typeof record.streamId === "string" ? record.streamId : "";
      const route = typeof record.route === "string" && record.route.startsWith("/") ? record.route : "/health";
      const init = record.init && typeof record.init === "object" ? record.init as Record<string, unknown> : {};
      const requestHeaders = init.headers && typeof init.headers === "object" ? init.headers as Record<string, string> : {};
      const controller = new AbortController();
      const streamUrl = controlPlaneHttpStreamUrl(streamId);
      const tunnel = new WebSocket(streamUrl, { headers: controlPlaneStreamHeaders(streamUrl) });
      httpStreams.set(streamId, { tunnel, controller });
      tunnel.on("open", async () => {
        try {
          const response = await fetch(localNodeAgentHttpUrl(route), {
            method: nodeAgentProxyMethod(init.method),
            headers: { ...requestHeaders, ...(input.token ? { authorization: `Bearer ${input.token}` } : {}) },
            body: typeof init.body === "string" ? init.body : undefined,
            signal: controller.signal,
          });
          await sendHttpFrame(tunnel, JSON.stringify({ type: "node-agent.http.head", streamId, status: response.status, headers: Object.fromEntries(response.headers.entries()) }));
          if (response.body) {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await sendHttpFrame(tunnel, Buffer.from(value), true);
            }
          }
          await sendHttpFrame(tunnel, JSON.stringify({ type: "node-agent.http.end", streamId }));
          tunnel.close(1000, "HTTP stream completed.");
        } catch (error) {
          if (tunnel.readyState === WebSocket.OPEN) {
            await sendHttpFrame(tunnel, JSON.stringify({ type: "node-agent.http.error", streamId, message: error instanceof Error ? error.message : String(error) })).catch(() => undefined);
            tunnel.close(1011, "HTTP stream failed.");
          }
        } finally {
          httpStreams.delete(streamId);
        }
      });
      tunnel.on("close", () => {
        controller.abort();
        httpStreams.delete(streamId);
      });
      tunnel.on("error", () => controller.abort());
      return;
    }
    if (record.type === "control-plane.websocket.open") {
      const streamId = typeof record.streamId === "string" ? record.streamId : "";
      const route = typeof record.route === "string" ? record.route : "";
      const protocols = Array.isArray(record.protocols) ? record.protocols.filter((item): item is string => typeof item === "string") : undefined;
      try {
        const headers = input.token ? { authorization: `Bearer ${input.token}` } : undefined;
        const upstream = protocols?.length ? new WebSocket(localNodeAgentWsUrl(route), protocols, { headers }) : new WebSocket(localNodeAgentWsUrl(route), { headers });
        const streamUrl = controlPlaneStreamUrl(streamId);
        const tunnel = new WebSocket(streamUrl, { headers: controlPlaneStreamHeaders(streamUrl) });
        streams.set(streamId, {
          upstream,
          tunnel,
          close: (code = 1000, reason = "") => {
            upstream.close(code, reason);
            tunnel.close(code, reason);
          },
        });
        upstream.on("open", () => {
          socket.send(JSON.stringify({ type: "node-agent.websocket.open", streamId, protocol: upstream.protocol }));
        });
        bridgeWebSockets(tunnel, upstream, {
          pendingFrameLimit: 256,
          upstreamOpenTimeoutMs: 10_000,
          onClientClose: () => {
            streams.delete(streamId);
          },
          onClientError: (error) => {
            streams.delete(streamId);
            socket.send(JSON.stringify({
              type: "node-agent.websocket.error",
              streamId,
              message: error instanceof Error ? error.message : String(error),
            }));
          },
          onUpstreamClose: (code, reason) => {
            streams.delete(streamId);
            socket.send(JSON.stringify({
              type: "node-agent.websocket.close",
              streamId,
              code: typeof code === "number" ? code : 1000,
              reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || ""),
            }));
          },
          onUpstreamError: (error) => {
            streams.delete(streamId);
            socket.send(JSON.stringify({
              type: "node-agent.websocket.error",
              streamId,
              message: error instanceof Error ? error.message : String(error),
            }));
          },
        });
      } catch (error) {
        socket.send(JSON.stringify({
          type: "node-agent.websocket.error",
          streamId,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      return;
    }
    if (record.type === "control-plane.websocket.close") {
      const streamId = typeof record.streamId === "string" ? record.streamId : "";
      closeStream(streamId, typeof record.code === "number" ? record.code : 1000, typeof record.reason === "string" ? record.reason : "");
      return;
    }
    if (record.type === "control-plane.request") {
      const requestId = typeof record.requestId === "string" ? record.requestId : "";
      const init = record.init && typeof record.init === "object" ? record.init as Record<string, unknown> : {};
      const route = typeof record.route === "string" && record.route.startsWith("/") ? record.route : "/health";
      const headers = init.headers && typeof init.headers === "object" ? init.headers as Record<string, string> : {};
      try {
        const response: NodeAgentInjectResponse = await app.inject({
          method: nodeAgentProxyMethod(init.method),
          url: `/api/node-agent${route}`,
          headers: {
            ...headers,
            ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
          },
          payload: typeof init.body === "string" ? init.body : undefined,
        });
        socket.send(
          JSON.stringify({
            type: "node-agent.response",
            requestId,
            status: response.statusCode,
            headers: response.headers,
            body: response.body,
          }),
        );
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "node-agent.response",
            requestId,
            status: 502,
            error: {
              code: "NODE_AGENT_REVERSE_INJECT_FAILED",
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      }
    }
  });
  return socket;
}

function createReverseTunnelManager(app: Awaited<ReturnType<typeof createNodeAgentApp>>, options: RunNodeAgentServerOptions, paths: NodeAgentStorePaths, nodeId: string) {
  const token = options.token || process.env.TASK_HANDOFF_NODE_AGENT_TOKEN;
  const identity = new NodeAgentIdentityService(paths);
  const sockets = new Map<string, WebSocket>();
  const connect = (remote: { url: string; keyId?: string; secret?: string }) => {
    const key = remote.url.replace(/\/$/, "");
    sockets.get(key)?.close(1000, "Reverse tunnel reconnecting.");
    const socket = connectReverseTunnel(app, {
      tunnelUrl: controlPlaneTunnelUrlForBase(remote.url),
      nodeId,
      port: () => app.nodeAgentState!.currentListenerPort,
      token,
      keyId: remote.keyId,
      secret: remote.secret,
    });
    sockets.set(key, socket);
    socket.on("close", () => {
      if (sockets.get(key) === socket) {
        sockets.delete(key);
      }
    });
    return socket;
  };
  const connectConfigured = () => {
    const explicitTunnelUrl = controlPlaneTunnelUrl(options);
    if (explicitTunnelUrl) {
      const tunnelSecret = identity.reverseTunnelSecret(
        process.env.TASK_HANDOFF_CONTROL_PLANE_URL,
        options.remoteSecret || process.env.TASK_HANDOFF_NODE_AGENT_REMOTE_SECRET,
        options.remoteKeyId || process.env.TASK_HANDOFF_NODE_AGENT_REMOTE_KEY_ID,
      );
      const key = (process.env.TASK_HANDOFF_CONTROL_PLANE_URL || explicitTunnelUrl).replace(/\/$/, "");
      sockets.get(key)?.close(1000, "Reverse tunnel reconnecting.");
      const socket = connectReverseTunnel(app, {
        tunnelUrl: explicitTunnelUrl,
        nodeId,
        port: () => app.nodeAgentState!.currentListenerPort,
        token,
        keyId: tunnelSecret?.keyId,
        secret: tunnelSecret?.secret,
      });
      sockets.set(key, socket);
    }
    for (const remote of identity.configuredRemoteControlPlanes()) {
      if (remote.url && remote.active !== false) {
        connect({ url: remote.url, keyId: remote.keyId, secret: remote.secret });
      }
    }
  };
  const closeAll = () => {
    for (const socket of sockets.values()) {
      socket.close(1001, "Node agent shutting down.");
    }
    sockets.clear();
  };
  return { connect, connectConfigured, closeAll };
}

export async function listenNodeAgentIpcServer(app: Awaited<ReturnType<typeof createNodeAgentApp>>, ipcPath: string) {
  prepareNodeAgentIpcPath(ipcPath);
  const ipcServer = http.createServer((request, response) => {
    app.server.emit("request", request, response);
  });
  ipcServer.on("upgrade", (request, socket, head) => {
    app.server.emit("upgrade", request, socket, head);
  });
  await new Promise<void>((resolve, reject) => {
    ipcServer.once("error", reject);
    ipcServer.listen(ipcPath, () => {
      ipcServer.off("error", reject);
      resolve();
    });
  });
  return ipcServer;
}

export async function runNodeAgentServer(options: RunNodeAgentServerOptions) {
  const paths = nodeAgentStorePaths(options.dataDir);
  const defaults = bootstrapListener(options.host, options.port);
  const hadPersistedSettings = fs.existsSync(paths.settingsPath);
  const settings = runtimeSettingsFile(paths, defaults);
  const listenerConfig = settings.get().externalListener;
  const lock = acquireNodeAgentSingletonLock(defaultNodeAgentSingletonLockPath(), {
    dataDir: paths.dataDir,
    host: listenerHost(listenerConfig.bindScope),
    port: listenerConfig.port,
  });
  try {
    const effectiveOptions = { ...options, port: listenerConfig.port };
    const app = await createNodeAgentApp(effectiveOptions);
    const nodeId = new NodeAgentIdentityService(paths).resolveNodeId(options.nodeId || process.env.TASK_HANDOFF_NODE_ID);
    const reverseTunnels = createReverseTunnelManager(app, effectiveOptions, paths, nodeId);
    app.decorate("nodeAgentReverseTunnels", reverseTunnels);
    const listenerManager = new NodeAgentExternalListenerManager({
      app,
      state: app.nodeAgentState!,
      settings,
      config: listenerConfig,
      source: hadPersistedSettings ? "persisted" : "bootstrap",
    });
    app.decorate("nodeAgentListenerManager", listenerManager);
    let ipcServer: http.Server | undefined;
    installGracefulShutdown(app, () => {
      reverseTunnels.closeAll();
      ipcServer?.close();
    });
    app.addHook("onClose", async () => {
      ipcServer?.close();
      lock.release();
    });
    try {
      await app.ready();
      const ipcPath = options.ipcPath || process.env.TASK_HANDOFF_NODE_AGENT_IPC_PATH || nodeAgentIpcPath(paths.dataDir);
      ipcServer = await listenNodeAgentIpcServer(app, ipcPath);
      await listenerManager.start();
      reverseTunnels.connectConfigured();
      await app.nodeAgentRestoreLocalInstances?.();
    } catch (error) {
      await app.close();
      throw error;
    }
  } catch (error) {
    lock.release();
    throw error;
  }
}
