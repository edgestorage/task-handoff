import crypto from "node:crypto";
import { StandardReconnectBackoff } from "@task-handoff/core/core/reconnect";
import type { ImageSelection, InstanceAppInventory } from "@task-handoff/protocol/control-plane";
import {
  GitCredentialHttpsResolveResponseSchema,
  GitCredentialSshAgentResponseSchema,
  GitCredentialSshPrepareResponseSchema,
} from "@task-handoff/protocol/managed-git-credentials";
import {
  sanitizeStoryContentPageResult,
  StoryContentPageResultSchema,
  StoryRevisionSchema,
  type StoryContentPageResult,
} from "@task-handoff/protocol/stories";

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
  private readonly reconnectBackoff = new StandardReconnectBackoff();
  private readonly processIncarnationId = crypto.randomUUID();
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

  async resolveGitHttps(remoteUrl: string) {
    return GitCredentialHttpsResolveResponseSchema.parse(await this.request(
      `node-agent/instances/${encodeURIComponent(this.requiredInstanceId())}/git-credentials/https`,
      { remoteUrl },
    ));
  }

  async prepareGitSsh(remoteUrl: string) {
    return GitCredentialSshPrepareResponseSchema.parse(await this.request(
      `node-agent/instances/${encodeURIComponent(this.requiredInstanceId())}/git-credentials/ssh/prepare`,
      { remoteUrl },
    ));
  }

  async exchangeGitSshAgent(invocationId: string, frame: string) {
    return GitCredentialSshAgentResponseSchema.parse(await this.request(
      `node-agent/instances/${encodeURIComponent(this.requiredInstanceId())}/git-credentials/ssh/agent`,
      { invocationId, frame },
    ));
  }

  async releaseGitSsh(invocationId: string) {
    await this.request(
      `node-agent/instances/${encodeURIComponent(this.requiredInstanceId())}/git-credentials/ssh/${encodeURIComponent(invocationId)}`,
      {},
      "DELETE",
    );
  }

  async listStoryContent(sessionId: string, page: number, pageSize: number): Promise<StoryContentPageResult> {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    const result = await this.request(
      `node-agent/instances/${encodeURIComponent(this.requiredInstanceId())}/ai-sessions/${encodeURIComponent(sessionId)}/story-content?${query}`,
      {},
      "GET",
    );
    return StoryContentPageResultSchema.parse(sanitizeStoryContentPageResult(result));
  }

  async downloadStoryContent(sessionId: string, storyPath: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ storyPath });
    const response = await this.rawRequest(
      `node-agent/instances/${encodeURIComponent(this.requiredInstanceId())}/ai-sessions/${encodeURIComponent(sessionId)}/story-content/file?${query}`,
      { method: "GET", signal },
    );
    const revision = StoryRevisionSchema.parse(response.headers.get("x-story-revision"));
    if (!response.body) throw new Error("Story content response has no body.");
    return { body: response.body, revision };
  }

  async uploadStoryContent(sessionId: string, input: {
    storyPath: string;
    title?: string;
    expectedRevision?: string;
    body: BodyInit;
    size: number;
    signal?: AbortSignal;
  }) {
    const query = new URLSearchParams({ storyPath: input.storyPath });
    if (input.title) query.set("title", input.title);
    if (input.expectedRevision) query.set("expectedRevision", input.expectedRevision);
    const response = await this.rawRequest(
      `node-agent/instances/${encodeURIComponent(this.requiredInstanceId())}/ai-sessions/${encodeURIComponent(sessionId)}/story-content/file?${query}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": String(input.size) },
        body: input.body,
        duplex: "half",
        signal: input.signal,
      } as RequestInit,
    );
    const payload = (await response.json()) as { data?: { storyPath?: unknown; revision?: unknown; size?: unknown } };
    return {
      storyPath: String(payload.data?.storyPath || ""),
      revision: StoryRevisionSchema.parse(payload.data?.revision),
      size: Number(payload.data?.size || 0),
    };
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
      this.reconnectBackoff.reset();
      succeeded = true;
    } catch (error) {
      console.warn(`node agent registration sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!this.stopped) this.schedule(succeeded ? this.config.heartbeatIntervalMs : this.reconnectBackoff.next().delay);
    }
  }

  private runExclusive(operation: () => Promise<void>) {
    if (this.inFlight) return this.inFlight;
    const running = operation().finally(() => {
      if (this.inFlight === running) this.inFlight = undefined;
    });
    this.inFlight = running;
    return running;
  }

  private async request(path: string, body: Record<string, unknown>, method = "POST") {
    const response = await this.rawRequest(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(stripUndefined(body)) }),
    });
    const payload = (await response.json().catch(() => ({}))) as { data?: Record<string, unknown> };
    return payload.data || {};
  }

  private async rawRequest(path: string, init: RequestInit) {
    const baseUrl = this.config.nodeAgentUrl?.replace(/\/$/, "");
    if (!baseUrl) {
      throw new Error("Node agent URL is required.");
    }
    const headerTimeout = new AbortController();
    const timer = setTimeout(() => headerTimeout.abort(Object.assign(new Error("Node agent response header timed out."), {
      code: "NODE_AGENT_RESPONSE_HEADER_TIMEOUT",
    })), 30_000);
    timer.unref?.();
    const signal = init.signal
      ? AbortSignal.any([init.signal, headerTimeout.signal])
      : headerTimeout.signal;
    const response = await this.fetchImpl(`${baseUrl}/api/${path}`, {
      ...init,
      signal,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        authorization: `Bearer ${this.config.registrationToken}`,
      },
    }).finally(() => clearTimeout(timer));
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw Object.assign(
        new Error(payload.error?.message || `Node agent request failed with HTTP ${response.status}`),
        { statusCode: response.status },
      );
    }
    return response;
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
