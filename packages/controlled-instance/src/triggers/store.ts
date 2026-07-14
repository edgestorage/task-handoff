import path from "node:path";
import {
  TriggerConfigSchema,
  TriggerDeploymentSchema,
  TriggerIndexSchema,
  TriggerRuntimeStateSchema,
  TriggerRunSchema,
  triggerConfigHash,
  type TriggerConfig,
  type TriggerDeployment,
  type TriggerIndex,
  type TriggerRun,
} from "@task-handoff/protocol/triggers";
import { DomainStore } from "@task-handoff/core/storage/domain-store";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";

const MAX_RECENT_RUNS = 100;
const DEFAULT_TRIGGER_CONVERSATION_ID = 1;

type TriggerCreateInput = {
  name: string;
  description?: string;
  source: TriggerConfig["source"];
  action: TriggerConfig["action"];
  policy?: Partial<TriggerConfig["policy"]>;
  deployment?: Partial<Omit<TriggerDeployment, "configHash" | "instanceId" | "createdAt" | "updatedAt">>;
};

function now() {
  return new Date().toISOString();
}

function localInstanceId() {
  return process.env.TASK_HANDOFF_INSTANCE_ID || "local";
}

function deploymentKey(deployment: Pick<TriggerDeployment, "configHash" | "deploymentId">) {
  return deployment.deploymentId || deployment.configHash;
}

function defaultDeployment(configHash: string, input: TriggerCreateInput["deployment"] = {}) {
  const timestamp = now();
  return TriggerDeploymentSchema.parse({
    configHash,
    deploymentId: input.deploymentId,
    instanceId: localInstanceId(),
    origin: input.origin || "controlled-instance",
    enabled: input.enabled ?? true,
    target: input.target || { type: "conversation", conversationId: DEFAULT_TRIGGER_CONVERSATION_ID },
    localName: input.localName,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function runtimeFor(deployment: TriggerDeployment) {
  return TriggerRuntimeStateSchema.parse({
    configHash: deployment.configHash,
    deploymentId: deployment.deploymentId,
    instanceId: deployment.instanceId,
    status: deployment.enabled ? "idle" : "disabled",
    runCount: 0,
    skippedCount: 0,
  });
}

function promptPreview(value: string) {
  return value.trim().slice(0, 500);
}

export class TriggerStore {
  private readonly indexStore: DomainStore<TriggerIndex>;

  constructor(paths: TaskHandoffStoragePaths) {
    this.indexStore = new DomainStore(path.join(paths.triggersDir, "index.json"), {
      schema: TriggerIndexSchema,
      defaultValue: () => ({ schemaVersion: 1, configs: [], deployments: [], runtime: [], recentRuns: [] }),
    });
  }

  indexPath() {
    return this.indexStore.path();
  }

  list() {
    return this.indexStore.load();
  }

  get(configHash: string) {
    const index = this.list();
    const config = index.configs.find((entry) => entry.configHash === configHash);
    const deployments = index.deployments.filter((entry) => entry.configHash === configHash);
    if (!config) {
      return undefined;
    }
    return {
      config,
      deployments,
      runtime: index.runtime.filter((entry) => entry.configHash === configHash),
      recentRuns: index.recentRuns.filter((entry) => entry.configHash === configHash),
    };
  }

  create(input: TriggerCreateInput) {
    const timestamp = now();
    const policy = {
      maxConcurrentRuns: input.policy?.maxConcurrentRuns ?? 1,
      whenBusy: input.policy?.whenBusy ?? "skip",
      cooldownMs: input.policy?.cooldownMs,
    } as TriggerConfig["policy"];
    const configHash = triggerConfigHash({ source: input.source, action: input.action, policy });
    const config = TriggerConfigSchema.parse({
      configHash,
      name: input.name,
      description: input.description,
      source: input.source,
      action: input.action,
      policy,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const deployment = defaultDeployment(configHash, input.deployment);
    const index = this.list();
    const configs = index.configs.some((entry) => entry.configHash === configHash)
      ? index.configs
      : [...index.configs, config];
    const key = deploymentKey(deployment);
    const deployments = [
      ...index.deployments.filter((entry) => deploymentKey(entry) !== key),
      deployment,
    ];
    const runtime = [
      ...index.runtime.filter((entry) => deploymentKey(entry) !== key),
      runtimeFor(deployment),
    ];
    this.save({ ...index, configs, deployments, runtime });
    return { config, deployment, runtime: runtimeFor(deployment) };
  }

  patch(configHash: string, patch: Record<string, unknown>) {
    const index = this.list();
    const existing = index.configs.find((entry) => entry.configHash === configHash);
    if (!existing) {
      return undefined;
    }
    const updated = TriggerConfigSchema.parse({
      ...existing,
      name: patch.name ?? existing.name,
      description: patch.description === null ? undefined : patch.description ?? existing.description,
      updatedAt: now(),
    });
    this.save({
      ...index,
      configs: index.configs.map((entry) => entry.configHash === configHash ? updated : entry),
    });
    return updated;
  }

  setEnabled(configHash: string, enabled: boolean) {
    const index = this.list();
    const timestamp = now();
    let changed = false;
    const deployments = index.deployments.map((entry) => {
      if (entry.configHash !== configHash) {
        return entry;
      }
      changed = true;
      return TriggerDeploymentSchema.parse({ ...entry, enabled, updatedAt: timestamp });
    });
    if (!changed) {
      return undefined;
    }
    const runtime = index.runtime.map((entry) => entry.configHash === configHash
      ? TriggerRuntimeStateSchema.parse({ ...entry, status: enabled ? "idle" : "disabled" })
      : entry);
    this.save({ ...index, deployments, runtime });
    return this.get(configHash);
  }

  delete(configHash: string) {
    const index = this.list();
    const found = index.configs.some((entry) => entry.configHash === configHash);
    if (!found) {
      return false;
    }
    this.save({
      ...index,
      configs: index.configs.filter((entry) => entry.configHash !== configHash),
      deployments: index.deployments.filter((entry) => entry.configHash !== configHash),
      runtime: index.runtime.filter((entry) => entry.configHash !== configHash),
      recentRuns: index.recentRuns.filter((entry) => entry.configHash !== configHash),
    });
    return true;
  }

  deleteDeployment(configHash: string, deploymentId: string) {
    const index = this.list();
    const found = index.deployments.some((entry) => entry.configHash === configHash && deploymentKey(entry) === deploymentId);
    if (!found) {
      return false;
    }
    const deployments = index.deployments.filter((entry) => !(entry.configHash === configHash && deploymentKey(entry) === deploymentId));
    const hasRemainingDeployments = deployments.some((entry) => entry.configHash === configHash);
    this.save({
      ...index,
      configs: hasRemainingDeployments ? index.configs : index.configs.filter((entry) => entry.configHash !== configHash),
      deployments,
      runtime: index.runtime.filter((entry) => !(entry.configHash === configHash && deploymentKey(entry) === deploymentId)),
    });
    return true;
  }

  pruneMissingAiSessionDeployments(activeSessionIds: Set<string>) {
    const index = this.list();
    const stale = index.deployments.filter((entry) => entry.target.type === "ai-session" && !activeSessionIds.has(entry.target.aiSessionId));
    if (!stale.length) {
      return [];
    }
    const staleKeys = new Set(stale.map((entry) => deploymentKey(entry)));
    const deployments = index.deployments.filter((entry) => !staleKeys.has(deploymentKey(entry)));
    const configHashesWithDeployments = new Set(deployments.map((entry) => entry.configHash));
    this.save({
      ...index,
      configs: index.configs.filter((entry) => configHashesWithDeployments.has(entry.configHash)),
      deployments,
      runtime: index.runtime.filter((entry) => !staleKeys.has(deploymentKey(entry))),
    });
    return stale;
  }

  startRun(config: TriggerConfig, deployment: TriggerDeployment, eventType: TriggerRun["eventType"], eventSummary?: string) {
    const startedAt = now();
    const run = TriggerRunSchema.parse({
      id: `run_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
      configHash: config.configHash,
      deploymentId: deployment.deploymentId,
      instanceId: deployment.instanceId,
      eventType,
      status: "started",
      target: deployment.target,
      promptPreview: promptPreview(config.action.promptTemplate),
      eventSummary,
      startedAt,
    });
    const index = this.list();
    const runtime = this.upsertRuntime(index, deployment, {
      status: "running",
      lastTriggeredAt: startedAt,
    });
    this.save({
      ...index,
      runtime,
      recentRuns: [run, ...index.recentRuns].slice(0, MAX_RECENT_RUNS),
    });
    return run;
  }

  completeRun(run: TriggerRun, error?: unknown) {
    const completedAt = now();
    const failed = Boolean(error);
    const index = this.list();
    const recentRuns = index.recentRuns.map((entry) => entry.id === run.id
      ? TriggerRunSchema.parse({
          ...entry,
          status: failed ? "failed" : "completed",
          error: error instanceof Error ? error.message : error ? String(error) : undefined,
          completedAt,
        })
      : entry);
    const deployment = index.deployments.find((entry) => entry.configHash === run.configHash && deploymentKey(entry) === (run.deploymentId || run.configHash));
    const runtime = deployment
      ? this.upsertRuntime(index, deployment, {
          status: failed ? "error" : deployment.enabled ? "idle" : "disabled",
          lastCompletedAt: completedAt,
          lastError: failed ? (error instanceof Error ? error.message : String(error)) : undefined,
          runCount: (index.runtime.find((entry) => entry.configHash === run.configHash && deploymentKey(entry) === deploymentKey(deployment))?.runCount || 0) + 1,
        })
      : index.runtime;
    this.save({ ...index, runtime, recentRuns });
    return recentRuns.find((entry) => entry.id === run.id);
  }

  skipRun(config: TriggerConfig, deployment: TriggerDeployment, eventType: TriggerRun["eventType"], eventSummary?: string) {
    const skippedAt = now();
    const run = TriggerRunSchema.parse({
      id: `run_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
      configHash: config.configHash,
      deploymentId: deployment.deploymentId,
      instanceId: deployment.instanceId,
      eventType,
      status: "skipped",
      target: deployment.target,
      promptPreview: promptPreview(config.action.promptTemplate),
      eventSummary,
      startedAt: skippedAt,
      completedAt: skippedAt,
    });
    const index = this.list();
    const runtime = this.upsertRuntime(index, deployment, {
      status: deployment.enabled ? "idle" : "disabled",
      lastSkippedAt: skippedAt,
      skippedCount: (index.runtime.find((entry) => deploymentKey(entry) === deploymentKey(deployment))?.skippedCount || 0) + 1,
    });
    this.save({
      ...index,
      runtime,
      recentRuns: [run, ...index.recentRuns].slice(0, MAX_RECENT_RUNS),
    });
    return run;
  }

  primaryDeployment(configHash: string) {
    return this.list().deployments.find((entry) => entry.configHash === configHash);
  }

  private upsertRuntime(index: TriggerIndex, deployment: TriggerDeployment, patch: Record<string, unknown>) {
    const key = deploymentKey(deployment);
    const current = index.runtime.find((entry) => deploymentKey(entry) === key) || runtimeFor(deployment);
    const updated = TriggerRuntimeStateSchema.parse({ ...current, ...patch });
    return [
      ...index.runtime.filter((entry) => deploymentKey(entry) !== key),
      updated,
    ];
  }

  private save(index: TriggerIndex) {
    this.indexStore.save(TriggerIndexSchema.parse(index));
  }
}

export type { TriggerCreateInput };
