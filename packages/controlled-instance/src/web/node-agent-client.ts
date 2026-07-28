import type { ImageSelection, InstanceAppInventory } from "@task-handoff/protocol/control-plane";

export type NodeAgentRegistrationConfig = {
  controlMode: "standalone" | "controlled";
  nodeAgentUrl?: string;
  registrationToken?: string;
  instanceId?: string;
  instanceName: string;
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

export function nodeAgentRegistrationConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NodeAgentRegistrationConfig {
  return {
    controlMode: env.TASK_HANDOFF_CONTROL_MODE === "controlled" ? "controlled" : "standalone",
    nodeAgentUrl: env.TASK_HANDOFF_NODE_AGENT_URL,
    registrationToken: env.TASK_HANDOFF_REGISTRATION_TOKEN,
    instanceId: env.TASK_HANDOFF_INSTANCE_ID,
    instanceName: env.TASK_HANDOFF_INSTANCE_NAME || env.HOSTNAME || "controlled-instance",
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
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly config: NodeAgentRegistrationConfig;
  private readonly snapshotProvider: SnapshotProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: NodeAgentRegistrationConfig,
    snapshotProvider: SnapshotProvider,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.config = config;
    this.snapshotProvider = snapshotProvider;
    this.fetchImpl = fetchImpl;
  }

  enabled() {
    return Boolean(this.config.controlMode === "controlled" && this.config.nodeAgentUrl && this.config.registrationToken && this.config.instanceId);
  }

  async start() {
    if (!this.enabled()) {
      return;
    }
    await this.register();
    this.timer = setInterval(() => {
      void this.heartbeat().catch((error) => {
        console.warn(`node agent heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.config.heartbeatIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async register() {
    const snapshot = await this.snapshotProvider();
    const instanceId = this.requiredInstanceId();
    const response = await this.request(`node-agent/instances/${encodeURIComponent(instanceId)}/register`, {
      instanceId: this.config.instanceId,
      name: this.config.instanceName,
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
    });
    this.registeredInstanceId = String(response.id || instanceId);
    await this.heartbeat();
  }

  async heartbeat() {
    const instanceId = this.registeredInstanceId || this.config.instanceId;
    if (!instanceId) {
      return;
    }
    const snapshot = await this.snapshotProvider();
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
    });
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
      throw new Error(payload.error?.message || `Node agent request failed with HTTP ${response.status}`);
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

function stripUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
