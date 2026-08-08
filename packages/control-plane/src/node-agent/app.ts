import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import type { FastifyServerOptions } from "fastify";
import { z } from "zod";
import { processStartIdentity } from "@task-handoff/core/core/process-singleton-lock";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  ControlledInstanceSchema,
  InstanceImageSnapshotSchema,
  InstanceResourceMetricsEventType,
  sanitizeCrossVersionControlledInstanceHeartbeat,
  sanitizeCrossVersionControlledInstanceRegister,
  type BuildInfo,
  type ControlledInstance,
  type InstanceResourceMetrics,
} from "@task-handoff/protocol/control-plane";
import { defaultCommandRunner, LocalDockerExecutor, listLocalDockerImages, type CommandRunner, type ExecutorContext } from "./runtimes/docker.ts";
import { DockerImageService } from "./docker-images.ts";
import { NodeAgentInstanceEventForwarder } from "./events.ts";
import { DockerRuntimeMetricsCollector } from "./runtime-metrics.ts";
import { listFolderTree } from "./folders.ts";
import { nodeAgentStorePaths, type NodeAgentStorePaths } from "./persistence/paths.ts";
import { acquireNodeAgentSingletonLock, defaultNodeAgentSingletonLockPath } from "./process/singleton-lock.ts";
import type { TerminalCommandRunner } from "../shared/process/terminal-command-runner.ts";
import { nodeAgentIpcEndpoint, nodeAgentIpcPath, prepareNodeAgentIpcPath } from "../shared/transport/node-agent-ipc.ts";
import { RuntimeArtifactResolver, type ResolvedRuntimeArtifact } from "./runtime-artifacts.ts";
import { resolvePublishedRuntimeArtifact, type PublishedRuntimeArtifact } from "./runtime-release-source.ts";
import { RuntimeConvergenceCoordinator, reportedVersion } from "./runtime-convergence.ts";
import {
  NodeAgentState,
  runtimeUsesManagedArtifacts,
} from "./state.ts";
import { registerNodeModelRoutes } from "./models/routes.ts";
import { registerRuntimeRoutes } from "./runtimes/routes.ts";
import { registerInstanceManagementRoutes } from "./instances/routes.ts";
import { registerInstanceLifecycleRoutes } from "./instances/lifecycle-routes.ts";
import { InstanceImageProvisioningController } from "./instances/image-provisioning.ts";
import { InstanceOperationGate } from "./instances/instance-operation-gate.ts";
import { EnvironmentTemplateService } from "./environment-templates/service.ts";
import { registerEnvironmentTemplateRoutes } from "./environment-templates/routes.ts";
import {
  createInstanceProxyMetrics,
  registerInstanceProxyRoutes,
} from "./instances/proxy-routes.ts";
import {
  allocateNodeAgentExternalListener,
  NodeAgentExternalListenerManager,
  registerExternalListenerSettingsRoutes,
} from "./external-listener-manager.ts";
import { NodeAgentPairedHmacVerifier } from "./identity/hmac-verifier.ts";
import { NodeAgentIdentityService } from "./identity/service.ts";
import { registerNodeAgentIdentityRoutes } from "./identity/routes.ts";
import { NodeUpdateController, registerNodeUpdateRoutes } from "./node-update-controller.ts";
import { NodeAgentRecoverySupervisor } from "./recovery-supervisor.ts";
import { connectReverseTunnel } from "./reverse-tunnel/client.ts";
import { createReverseTunnelManager } from "./reverse-tunnel/manager.ts";
import {
  DockerRuntimeAdapter,
  RuntimeAdapterRegistry,
  finalComputerPlatform,
  isManagedRuntimeAdapter,
  type ManagedRuntimeAdapter,
} from "./runtimes/adapters.ts";
import {
  LocalhostRuntimeAdapter,
  configuredLocalControlledCommand,
} from "./runtimes/local-adapter.ts";
import {
  bootstrapExternalListener,
  createRuntimeSettingsFile,
} from "./external-listener-settings.ts";
import {
  desiredControlledInstanceVersion,
  runtimeVersionStateForActual,
} from "./runtime-version-state.ts";

export { mergeRuntimeLifecycleResult } from "./instance-lifecycle-state.ts";
export { runtimeVersionStateForActual } from "./runtime-version-state.ts";
export { NodeAgentExternalListenerManager } from "./external-listener-manager.ts";
export { LocalhostRuntimeAdapter } from "./runtimes/local-adapter.ts";
export { resolvedDockerImageUpdatePatch } from "./instances/image-provisioning.ts";
export { connectReverseTunnel, createReverseTunnelManager };

declare module "fastify" {
  interface FastifyInstance {
    nodeAgentState?: NodeAgentState;
    nodeAgentEventForwarder?: NodeAgentInstanceEventForwarder;
    nodeAgentRuntimeMetrics?: DockerRuntimeMetricsCollector;
    nodeAgentReverseTunnels?: ReturnType<typeof createReverseTunnelManager>;
    nodeAgentListenerManager?: NodeAgentExternalListenerManager;
    nodeAgentRestoreManagedInstances?: () => Promise<void>;
    nodeAgentRecoverManagedInstances?: () => Promise<void>;
    nodeAgentStartRecoverySupervisor?: () => void;
  }

  interface FastifyRequest {
    nodeAgentAuthKeyId?: string;
  }
}

const AUTO_IMPORT_AGENT_CONFIG_PRESETS = ["codex", "claude"] as const;
const DEFAULT_AUTO_IMPORT_AGENT_CONFIG_TIMEOUT_MS = 5_000;
function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function buildInfo(component: BuildInfo["component"]): BuildInfo {
  return {
    component,
    packageName: component === "node-agent" ? "@task-handoff/node-agent" : undefined,
    packageVersion: desiredControlledInstanceVersion(),
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    buildId: optionalEnv("TASK_HANDOFF_BUILD_ID"),
    builtAt: optionalEnv("TASK_HANDOFF_BUILT_AT"),
    gitCommit: optionalEnv("TASK_HANDOFF_GIT_COMMIT"),
    imageRef: optionalEnv("TASK_HANDOFF_IMAGE_REF"),
    imageDigest: optionalEnv("TASK_HANDOFF_IMAGE_DIGEST"),
  };
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
  /** Test-only lock-path injection. Production always uses the host-user global lock. */
  localControlledInstanceLockPath?: string;
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
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String),
          code: issue.code,
          message: issue.message,
        })),
      },
    };
  }
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return {
    statusCode: typeof record.statusCode === "number" ? record.statusCode : 500,
    code: typeof record.code === "string" ? record.code : "NODE_AGENT_ERROR",
    message: error instanceof Error ? error.message : String(error),
    ...(record.details && typeof record.details === "object" && !Array.isArray(record.details) ? { details: record.details } : {}),
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
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

function isPairingSelfRevokeRoute(url: string) {
  return url.split("?")[0] === "/api/node-agent/pairing/current";
}

function now() {
  return new Date().toISOString();
}


function envFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function nodeAgentDiagnosticLogsEnabled() {
  return envFlag(process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS);
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
  state.instancePrivateConfigs.materialize(instance.id, instance.registrationToken, state.resolvedAssignedModelEnvironment(instanceId));
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

function appSessionsFromCrossVersionSnapshot(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const data = (payload as Record<string, unknown>).data;
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const snapshot = (data as Record<string, unknown>).snapshot;
  const source = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : data;
  const sessions = (source as Record<string, unknown>).sessions;
  return Array.isArray(sessions) ? sessions : [];
}

export async function requestRuntimeAppSessionDrain(fetchImpl: typeof fetch, instance: ControlledInstance) {
  const instanceBase = nodeLocalInstanceWebBase(instance);
  if (instance.registrationToken) {
    const internalResponse = await fetchWithTimeout(fetchImpl, `${instanceBase}/api/internal/node-agent/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${instance.registrationToken}` },
    }, 10_000);
    if (internalResponse.ok) {
      return { requested: instance.apps.runningCount, failures: [] as Array<{ sessionId: string; error: string }> };
    }
  }
  const listResponse = await fetchWithTimeout(fetchImpl, `${instanceBase}/api/apps/sessions`, {
    method: "GET",
    headers: { "cache-control": "no-cache" },
  }, 5_000);
  if (!listResponse.ok) {
    throw new Error(`Could not list app sessions for runtime drain (HTTP ${listResponse.status}).`);
  }
  const sessions = appSessionsFromCrossVersionSnapshot(await listResponse.json());
  const runningSessionIds = sessions.flatMap((session) => {
    if (!session || typeof session !== "object" || Array.isArray(session)) return [];
    const record = session as Record<string, unknown>;
    return record.status === "running" && typeof record.id === "string" && record.id ? [record.id] : [];
  });
  const results = await Promise.all(runningSessionIds.map(async (sessionId) => {
    try {
      const response = await fetchWithTimeout(fetchImpl, `${instanceBase}/api/apps/sessions/${encodeURIComponent(sessionId)}/stop`, {
        method: "POST",
      }, 5_000);
      return response.ok ? undefined : { sessionId, error: `HTTP ${response.status}` };
    } catch (error) {
      return { sessionId, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return {
    requested: runningSessionIds.length,
    failures: results.filter((result): result is { sessionId: string; error: string } => Boolean(result)),
  };
}

export async function releaseRuntimeAppSessionDrain(fetchImpl: typeof fetch, instance: ControlledInstance) {
  if (!instance.registrationToken) return false;
  const response = await fetchWithTimeout(fetchImpl, `${nodeLocalInstanceWebBase(instance)}/api/internal/node-agent/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${instance.registrationToken}` },
  }, 5_000);
  return response.ok;
}


type NodeAgentDiagnosticLogger = (data: Record<string, unknown>, message: string) => void;
type NodeAgentLifecycleLoggers = {
  diagnostic: NodeAgentDiagnosticLogger;
  warn: NodeAgentDiagnosticLogger;
};


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
  const starting = state.applyInstanceLifecycle(id, { type: "start-requested" });
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
  const stored = state.applyInstanceLifecycle(id, {
    type: "runtime-lifecycle-completed",
    baseline: starting,
    observation: {
      ...result,
      target: result.target ? { ...result.target, status: probedEndpointStatus } : undefined,
      workspace: result.workspace ? { error: undefined, ...result.workspace } : undefined,
      targetStatus: probedEndpointStatus,
      uiAccessStatus: probedEndpointStatus,
    },
  });
  loggers.diagnostic({ instanceId: id, action: "start", reason, status: stored.status, connectionStatus: stored.connectionStatus, targetStatus: stored.targetStatus, targetWeb: stored.target.web, containerName: stored.runtime.containerName }, "node instance start completed");
  return stored;
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
  const nodeAgentProcessIdentity = processStartIdentity(process.pid);
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
  let recoverySupervisor!: NodeAgentRecoverySupervisor;
  const runtimeAdapters = new RuntimeAdapterRegistry(
    new DockerRuntimeAdapter(dockerExecutor, dockerCommandRunner, platform, arch),
    new LocalhostRuntimeAdapter(
      options.dockerCommandRunner || defaultCommandRunner,
      paths,
      () => state.localNodeAgentUrl,
      configuredLocalControlledCommand(),
      options.localControlledInstanceLockPath || process.env.TASK_HANDOFF_LOCAL_CONTROLLED_INSTANCE_LOCK_PATH,
      (event) => recoverySupervisor.handleUnexpectedLocalExit(
        event.instanceId,
        new Error(`Local controlled instance exited unexpectedly (pid=${event.pid ?? "unknown"}, code=${event.code ?? "none"}, signal=${event.signal ?? "none"}).`),
      ),
      (error, event) => app.log.error({ error, instanceId: event.instanceId, pid: event.pid }, "local controlled instance exit recovery failed"),
    ),
  );
  const updateCommandRunner = options.updateCommandRunner || options.dockerCommandRunner || defaultCommandRunner;
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
  const instanceProxyMetrics = createInstanceProxyMetrics();
  app.decorate("nodeAgentState", state);
  await app.register(websocket);
  const eventForwarder = new NodeAgentInstanceEventForwarder(state, token, { logger: app.log, safetyIntervalMs: Number(process.env.TASK_HANDOFF_EVENT_CONNECTION_SAFETY_INTERVAL_MS) || undefined });
  const convergence = new RuntimeConvergenceCoordinator(state.controlledInstances, desiredControlledInstanceVersion, {
    isInstalled: async (instance, desiredVersion) => {
      const artifact = await resolveArtifactForInstance(instance, desiredVersion);
      return requireManagedAdapterForInstance(instance).inspectRuntime(state.context(instance), artifact.identity);
    },
    beginDrain: async (instance) => {
      try {
        const result = await requestRuntimeAppSessionDrain(fetchImpl, instance);
        if (result.failures.length) {
          app.log.warn({ instanceId: instance.id, requested: result.requested, failures: result.failures }, "runtime convergence could not stop every app session");
        } else {
          app.log.info({ instanceId: instance.id, requested: result.requested }, "runtime convergence requested app session drain");
        }
      } catch (error) {
        app.log.warn({ instanceId: instance.id, error: error instanceof Error ? error.message : String(error) }, "runtime convergence could not request app session drain");
      }
    },
    endDrain: async (instance) => {
      try {
        if (await releaseRuntimeAppSessionDrain(fetchImpl, instance)) {
          app.log.info({ instanceId: instance.id }, "runtime convergence released app session drain");
        }
      } catch (error) {
        app.log.warn({ instanceId: instance.id, error: error instanceof Error ? error.message : String(error) }, "runtime convergence could not release app session drain");
      }
    },
    install: async (instance, desiredVersion) => {
      const adapter = requireManagedAdapterForInstance(instance);
      await adapter.installRuntime(state.context(instance), await resolveArtifactForInstance(instance, desiredVersion));
    },
    restart: async (instance) => {
      const adapter = adapterForInstance(instance);
      const restartBoundary = state.applyInstanceLifecycle(instance.id, { type: "convergence-restart-requested" });
      const result = await adapter.restart(state.context(restartBoundary));
      state.applyInstanceLifecycle(instance.id, {
        type: "runtime-lifecycle-completed",
        baseline: restartBoundary,
        observation: result,
      });
    },
    onForcedDrain: (instance) => app.log.warn({ instanceId: instance.id }, "runtime convergence drain deadline reached; restarting instance"),
  }, {
    drainTimeoutMs: Number(process.env.TASK_HANDOFF_RUNTIME_DRAIN_TIMEOUT_MS) || undefined,
    verificationTimeoutMs: Number(process.env.TASK_HANDOFF_RUNTIME_VERIFY_TIMEOUT_MS) || undefined,
    maxAttempts: Number(process.env.TASK_HANDOFF_RUNTIME_MAX_ATTEMPTS) || undefined,
  });
  state.controlledInstances.setOnStored((instance) => {
    eventForwarder.publishInstanceLifecycle(instance);
    state.updateJobs.reconcileRollouts(state.listInstances(), desiredControlledInstanceVersion());
  });
  eventForwarder.start();
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
  const instanceOperations = new InstanceOperationGate();
  const environmentTemplates = new EnvironmentTemplateService(
    state.environmentTemplates,
    state.instancePrivateConfigs,
    dockerExecutor,
    (id) => state.requireInstance(id),
    (id) => state.requireRuntime(id),
    (instanceId, operation) => instanceOperations.run(instanceId, operation),
    (imageId) => state.listInstances().some((instance) => instance.environmentTemplateOrigin?.imageId === imageId),
  );
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

  const startInstanceWithFailureState = async (
    id: string,
    reason: "request" | "image-ready",
    shouldContinue: () => boolean = () => true,
  ) => {
    try {
      if (!shouldContinue()) return state.requireInstance(id);
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
      if (runtime.type === "docker" && started.imageProvisioning && started.imageProvisioning.phase !== "ready") {
        eventForwarder.syncNow();
        return started;
      }
      if (!shouldContinue()) return state.requireInstance(id);
      recoverySupervisor.markRestored(id);
      let instance = state.requireInstance(id);
      if (usesManagedArtifact(instance)) {
        try {
          instance = await convergence.schedule(id, { startRequested: true });
        } catch (error) {
          instance = state.requireInstance(id);
          lifecycleLoggers.warn({
            instanceId: id,
            action: "runtime.converge",
            reason,
            error: error instanceof Error ? error.message : String(error),
          }, "node instance runtime convergence failed after start");
        }
        if (instance.runtimeVersion?.phase === "failed") {
          lifecycleLoggers.warn({
            instanceId: id,
            action: "runtime.converge",
            reason,
            error: instance.runtimeVersion.error,
          }, "node instance started with failed runtime convergence");
        }
      }
      if (!shouldContinue()) return state.requireInstance(id);
      await autoImportAgentConfig(fetchImpl, instance, "start", lifecycleLoggers);
      eventForwarder.syncNow();
      return instance;
    } catch (error) {
      state.applyInstanceLifecycle(id, { type: "start-failed", error });
      eventForwarder.syncNow();
      lifecycleLoggers.warn({ instanceId: id, action: "start", reason, error: error instanceof Error ? error.message : String(error) }, "node instance start failed");
      throw error;
    }
  };

  const imageProvisioning = new InstanceImageProvisioningController(state, dockerImageService, {
    sync: () => eventForwarder.syncNow(),
    diagnostic: lifecycleLoggers.diagnostic,
    warn: lifecycleLoggers.warn,
    publish: (type, payload, instanceId) => eventForwarder.publish(type, payload, { instanceId }),
    runInstanceOperation: (instanceId, operation) => instanceOperations.run(instanceId, operation),
  });

  const provisionInstanceImage = (instance: ControlledInstance) => {
    const intent = instanceOperations.intent(instance.id);
    void imageProvisioning.provision(instance, async () => {
      await startInstanceWithFailureState(
        instance.id,
        "image-ready",
        () => instanceOperations.isIntentCurrent(instance.id, intent),
      ).catch(() => undefined);
    });
  };

  recoverySupervisor = new NodeAgentRecoverySupervisor({
    state,
    runtimeAdapters,
    convergence,
    restoreInstance: (id) => startNodeInstance(state, runtimeAdapters, fetchImpl, id, lifecycleLoggers, "restore"),
    autoImport: (instance) => autoImportAgentConfig(fetchImpl, instance, "start", lifecycleLoggers),
    provisionImage: provisionInstanceImage,
    stopImageProvisioning: () => imageProvisioning.stop(),
    usesManagedArtifact,
    warn: lifecycleLoggers.warn,
    error: (data, message) => app.log.error(data, message),
    runInstanceOperation: (instanceId, operation) => instanceOperations.run(instanceId, operation),
  });

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

  const updateController = new NodeUpdateController({
    nodeId,
    jobs: state.updateJobs,
    runCommand: updateCommandRunner,
    currentRuntimeVersion: desiredControlledInstanceVersion,
    listInstances: () => state.listInstances(),
    resolveRuntimeArtifacts: async (version) => (
      await resolvePreflightRuntimeArtifacts(version)
    ).map((artifact) => artifact.identity),
    moduleDir: import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : __dirname,
  });

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
      if (identity.isRevokedPairing(hmacKeyId) && !isPairingSelfRevokeRoute(request.url)) {
        const error = new Error("The node agent pairing used for this request has been revoked.");
        Object.assign(error, { statusCode: 401, code: "NODE_AGENT_HMAC_KEY_REVOKED" });
        throw error;
      }
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
    await recoverySupervisor.stop();
  });

  app.decorate("nodeAgentRestoreManagedInstances", () => recoverySupervisor.restoreManagedInstances());
  app.decorate("nodeAgentRecoverManagedInstances", () => recoverySupervisor.recoverManagedInstances());
  app.decorate("nodeAgentStartRecoverySupervisor", () => recoverySupervisor.start());

  app.get("/api/node-agent/health", async () => ({
    data: {
      ok: true,
      role: "node-agent",
      process: {
        pid: process.pid,
        ...(nodeAgentProcessIdentity ? { startIdentity: nodeAgentProcessIdentity } : {}),
      },
      listener: {
        host: "127.0.0.1",
        port: state.currentListenerPort,
      },
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

  registerExternalListenerSettingsRoutes(app, requireListenerManager);

  registerNodeUpdateRoutes(app, updateController, state.updateJobs);

  registerNodeAgentIdentityRoutes(app, {
    identity,
    nodeId,
    nodeName: () => state.node.name,
    fetchImpl,
    reverseTunnels: () => app.nodeAgentReverseTunnels,
  });

  registerRuntimeRoutes(app, {
    listRuntimes: () => state.nodeRuntimes.list(),
    createRuntime: (input) => state.createRuntime(input),
    updateRuntime: (id, input) => state.updateRuntime(id, input),
    deleteRuntime: (id) => state.deleteRuntime(id),
    checkRuntime: async (id) => {
      const runtime = state.requireRuntime(id);
      return state.checkRuntime(id, runtimeAdapters.forRuntime(runtime));
    },
    listLocalFolders: () => state.localFolders.list(),
    listFolderTree,
    createLocalFolder: (input) => state.createLocalFolder(input),
    deleteLocalFolder: (id) => state.localFolders.delete(id),
  });

  registerNodeModelRoutes(app, state.modelRegistry, (id) => syncAssignedModelEnvironment(fetchImpl, state, id));

  registerEnvironmentTemplateRoutes(app, environmentTemplates);

  registerInstanceManagementRoutes(app, {
    list: () => state.listInstances(),
    create: (input) => input.environmentSource?.type === "template"
      ? environmentTemplates.runTemplateOperation(input.environmentSource.environmentTemplateId, () => state.createInstance(input))
      : state.createInstance(input),
    retryImageProvisioning: (id) => imageProvisioning.retry(id),
    update: (id, input) => {
      const current = state.requireInstance(id);
      return state.controlledInstances.put(ControlledInstanceSchema.parse({
        ...current,
        ...input,
        ...(input.config ? { config: { ...current.config, ...input.config } } : {}),
        updatedAt: now(),
      }));
    },
    register: (id, input, registrationToken) => state.registerInstance(id, input, registrationToken),
    heartbeat: (id, input, registrationToken) => state.heartbeatInstance(id, input, registrationToken),
    sanitizeReport: sanitizeCrossVersionInstanceReport,
    afterCreate: (instance) => {
      eventForwarder.syncNow();
      if (instance.imageProvisioning) provisionInstanceImage(instance);
    },
    afterImageRetry: (instance) => {
      eventForwarder.syncNow();
      provisionInstanceImage(instance);
    },
    afterUpdate: () => eventForwarder.syncNow(),
    afterReport: (instance, report) => {
      eventForwarder.syncNow();
      if (report === "register") {
        logDiagnostic({ instanceId: instance.id, action: report, protocolVersion: instance.protocolVersion, build: instance.build, targetStatus: instance.targetStatus, targetStrategy: instance.target.strategy }, "node instance registered");
      } else {
        logDiagnostic({ instanceId: instance.id, action: report, status: instance.status, health: instance.health, protocolVersion: instance.protocolVersion, build: instance.build, targetStatus: instance.targetStatus, apps: instance.apps.runningCount }, "node instance heartbeat accepted");
      }
      if (usesManagedArtifact(instance) && (!instance.ready || instance.runtimeVersion?.phase !== "matched")) {
        void convergence.schedule(instance.id).catch((error) => app.log.error({ instanceId: instance.id, error }, `runtime convergence after ${report} failed`));
      }
    },
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

  registerInstanceLifecycleRoutes(app, {
    requireInstance: (id) => state.requireInstance(id),
    requireRuntime: (id) => state.requireRuntime(id),
    putInstance: (instance) => state.controlledInstances.put(instance),
    deleteInstance: (id) => state.controlledInstances.delete(id),
    applyLifecycle: (id, event) => state.applyInstanceLifecycle(id, event),
    context: (instance, modelEnv) => state.context(instance, modelEnv),
  }, runtimeAdapters, convergence, {
    start: (id, shouldContinue) => startInstanceWithFailureState(id, "request", shouldContinue),
    sync: () => eventForwarder.syncNow(),
    isManaged: usesManagedArtifact,
    probe: (instance) => probeInstanceEndpoint(fetchImpl, instance),
    autoImport: (instance) => autoImportAgentConfig(fetchImpl, instance, "restart", lifecycleLoggers),
    markRestarted: (id) => recoverySupervisor.markRestored(id),
    allowRecovery: (id) => recoverySupervisor.allowRecovery(id),
    suppressRecovery: (id) => recoverySupervisor.suppressRecovery(id),
    forgetRecovery: (id) => recoverySupervisor.forgetInstance(id),
    completeSuppressedRecovery: (id) => recoverySupervisor.completeSuppressedOperation(id),
    deleteMetadata: (id) => {
      state.modelRegistry.deleteInstanceMetadata(id);
      state.instancePrivateConfigs.delete(id);
    },
    releaseEnvironmentImage: (imageId) => environmentTemplates.releaseUnusedImage(imageId),
    diagnostic: logDiagnostic,
  }, instanceOperations);

  registerInstanceProxyRoutes(app, {
    fetchImpl,
    metrics: instanceProxyMetrics,
    instanceBase: (id) => nodeLocalInstanceWebBase(state.requireInstance(id)),
    syncModelEnvironment: (id) => syncAssignedModelEnvironment(fetchImpl, state, id),
    diagnostic: logDiagnostic,
  });

  return app;
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
  const lock = acquireNodeAgentSingletonLock(defaultNodeAgentSingletonLockPath(), {
    dataDir: paths.dataDir,
  });
  try {
    const defaults = bootstrapExternalListener(options.host, options.port);
    const hadPersistedSettings = fs.existsSync(paths.settingsPath);
    const settings = createRuntimeSettingsFile(paths, defaults);
    let listenerConfig = settings.get().externalListener;
    if (process.env.TASK_HANDOFF_NODE_AGENT_PORT_CONFLICT === "allocate") {
      const allocated = await allocateNodeAgentExternalListener(listenerConfig);
      if (allocated.port !== listenerConfig.port) {
        settings.put({ version: 1, externalListener: allocated });
        listenerConfig = allocated;
      }
    }
    const publishActiveListener = (listener: ReturnType<NodeAgentExternalListenerManager["current"]>) => {
      if (!lock.updateDetails({
        dataDir: paths.dataDir,
        host: listener.host,
        port: listener.port,
        instanceId: undefined,
      })) {
        throw new Error("Node agent singleton ownership changed while publishing listener state.");
      }
    };
    const effectiveOptions = { ...options, port: listenerConfig.port };
    const app = await createNodeAgentApp(effectiveOptions);
    const nodeAgentState = app.nodeAgentState;
    if (!nodeAgentState) {
      throw new Error("Node agent state was not initialized.");
    }
    const nodeId = new NodeAgentIdentityService(paths).resolveNodeId(options.nodeId || process.env.TASK_HANDOFF_NODE_ID);
    const reverseTunnels = createReverseTunnelManager({
      log: app.log,
      inject: (input) => app.inject(input),
      nodeAgentEventForwarder: app.nodeAgentEventForwarder,
      nodeAgentState,
    }, effectiveOptions, paths, nodeId);
    app.decorate("nodeAgentReverseTunnels", reverseTunnels);
    const listenerManager = new NodeAgentExternalListenerManager({
      app,
      state: nodeAgentState,
      settings,
      config: listenerConfig,
      source: hadPersistedSettings ? "persisted" : "bootstrap",
      onActiveListener: publishActiveListener,
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
      app.nodeAgentStartRecoverySupervisor?.();
    } catch (error) {
      await app.close();
      throw error;
    }
  } catch (error) {
    lock.release();
    throw error;
  }
}
