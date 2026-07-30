import crypto from "node:crypto";
import type { ImageSelection, InstanceAppInventory } from "@task-handoff/protocol/control-plane";

export type NodeAgentRegistrationConfig = {
  controlMode: "standalone" | "controlled";
  nodeAgentUrl?: string;
  registrationToken?: string;
  instanceId?: string;
  projectId?: string;
  nodeId?: string;
  runtimeId?: string;
  imageSelection?: ImageSelection;
  heartbeatIntervalMs: number;
};

export type ControlledInstanceSnapshot = {
  status: "running" | "unhealthy" | "failed" | "stopped";
  health: "ok" | "degraded" | "failed" | "unknown";
  instanceVersion?: string;
  protocolVersion: string;
  build?: Record<string, unknown>;
  controlMode: "standalone" | "controlled";
  capabilities: Record<string, unknown>;
  appInventory: InstanceAppInventory;
  target: Record<string, unknown>;
  workspace: Record<string, unknown>;
  apps: {
    runningCount: number;
    problemCount?: number;
    updatedAt?: string;
    revision?: number;
  };
  aiSessions?: {
    runningCount: number;
    waitingCount: number;
    staleCount: number;
    sessions: Array<Record<string, unknown>>;
    updatedAt: string;
  };
};

export type SnapshotProvider = () => Promise<ControlledInstanceSnapshot>;

export type NodeAgentRegistrationClientOptions = {
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

export function nodeAgentRegistrationConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NodeAgentRegistrationConfig {
  return {
    controlMode: env.TASK_HANDOFF_CONTROL_MODE === "controlled" ? "controlled" : "standalone",
    nodeAgentUrl: env.TASK_HANDOFF_NODE_AGENT_URL,
    registrationToken: env.TASK_HANDOFF_REGISTRATION_TOKEN,
    instanceId: env.TASK_HANDOFF_INSTANCE_ID,
    projectId: env.TASK_HANDOFF_PROJECT_ID,
    nodeId: env.TASK_HANDOFF_NODE_ID,
    runtimeId: env.TASK_HANDOFF_RUNTIME_ID,
    imageSelection: env.TASK_HANDOFF_IMAGE_ID ? {
      imageId: env.TASK_HANDOFF_IMAGE_ID,
      ...(env.TASK_HANDOFF_IMAGE_TAG ? { tag: env.TASK_HANDOFF_IMAGE_TAG } : {}),
    } : undefined,
    heartbeatIntervalMs: Number(env.TASK_HANDOFF_HEARTBEAT_INTERVAL_MS) || 10_000,
  };
}

export class NodeAgentRegistrationClient {
  private registeredInstanceId = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = true;
  private consecutiveFailures = 0;
  private readonly processIncarnationId = crypto.randomUUID();
  private readonly config: NodeAgentRegistrationConfig;
  private readonly snapshotProvider: SnapshotProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(
    config: NodeAgentRegistrationConfig,
    snapshotProvider: SnapshotProvider,
    fetchImpl: typeof fetch = fetch,
    options: NodeAgentRegistrationClientOptions = {},
  ) {
    this.config = config;
    this.snapshotProvider = snapshotProvider;
    this.fetchImpl = fetchImpl;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 30_000;
  }

  enabled() {
    return Boolean(this.config.controlMode === "controlled" && this.config.nodeAgentUrl && this.config.registrationToken && this.config.instanceId);
  }

  async start() {
    if (!this.enabled() || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async register() {
    return this.runExclusive(() => this.registerOnce());
  }

  async heartbeat() {
    return this.runExclusive(() => this.heartbeatOnce());
  }

  private async registerOnce() {
    const snapshot = await this.snapshotProvider();
    const instanceId = this.requiredInstanceId();
    const response = await this.request(`node-agent/instances/${encodeURIComponent(instanceId)}/register`, {
      instanceId: this.config.instanceId,
      projectId: this.config.projectId,
      nodeId: this.config.nodeId,
      runtimeId: this.config.runtimeId,
      imageSelection: this.config.imageSelection,
      instanceVersion: snapshot.instanceVersion,
      protocolVersion: snapshot.protocolVersion,
      build: snapshot.build,
      controlMode: "controlled",
      capabilities: snapshot.capabilities,
      appInventory: snapshot.appInventory,
      target: snapshot.target,
      workspace: snapshot.workspace,
      processIncarnationId: this.processIncarnationId,
    });
    this.registeredInstanceId = String(response.id || instanceId);
    await this.heartbeatOnce();
  }

  private async heartbeatOnce() {
    const instanceId = this.registeredInstanceId || this.config.instanceId;
    if (!instanceId) {
      return;
    }
    const snapshot = await this.snapshotProvider();
    try {
      await this.request(`node-agent/instances/${encodeURIComponent(instanceId)}/heartbeat`, {
        status: snapshot.status,
        health: snapshot.health,
        protocolVersion: snapshot.protocolVersion,
        build: snapshot.build,
        capabilities: snapshot.capabilities,
        appInventory: snapshot.appInventory,
        apps: snapshot.apps,
        aiSessions: snapshot.aiSessions,
        workspace: snapshot.workspace,
        target: snapshot.target,
        processIncarnationId: this.processIncarnationId,
      });
    } catch (error) {
      if (requestStatus(error) === 404) this.registeredInstanceId = "";
      throw error;
    }
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runCycle();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runCycle() {
    if (this.stopped) return;
    let succeeded = false;
    try {
      await this.runExclusive(() => this.registeredInstanceId ? this.heartbeatOnce() : this.registerOnce());
      this.consecutiveFailures = 0;
      succeeded = true;
    } catch (error) {
      this.consecutiveFailures += 1;
      console.warn(`node agent registration sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!this.stopped) this.schedule(succeeded ? this.config.heartbeatIntervalMs : this.retryDelayMs());
    }
  }

  private retryDelayMs() {
    return Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * (2 ** Math.max(0, this.consecutiveFailures - 1)));
  }

  private runExclusive(operation: () => Promise<void>) {
    if (this.inFlight) return this.inFlight;
    const running = operation().finally(() => {
      if (this.inFlight === running) this.inFlight = undefined;
    });
    this.inFlight = running;
    return running;
  }

  private async request(path: string, body: Record<string, unknown>) {
    const baseUrl = this.config.nodeAgentUrl?.replace(/\/$/, "");
    if (!baseUrl) {
      throw new Error("Node agent URL is required.");
    }
    const response = await this.fetchImpl(`${baseUrl}/api/${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.registrationToken}`,
      },
      body: JSON.stringify(stripUndefined(body)),
    });
    const payload = (await response.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: { message?: string } };
    if (!response.ok) {
      throw Object.assign(
        new Error(payload.error?.message || `Node agent request failed with HTTP ${response.status}`),
        { statusCode: response.status },
      );
    }
    return payload.data || {};
  }

  private requiredInstanceId() {
    if (!this.config.instanceId) {
      throw new Error("Instance id is required for controlled mode registration.");
    }
    return this.config.instanceId;
  }
}

function requestStatus(error: unknown) {
  return error && typeof error === "object" && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : undefined;
}

function stripUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
