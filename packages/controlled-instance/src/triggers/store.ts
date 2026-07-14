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

type TriggerStorageWarning = {
  kind: "config" | "deployment" | "runtime" | "recent-run" | "index";
  id: string;
  reason: string;
};

type TriggerCreateInput = {
  name: string;
  description?: string;
  source: TriggerConfig["source"];
  action: TriggerConfig["action"];
  policy?: Partial<TriggerConfig["policy"]>;
  deployment: Partial<Omit<TriggerDeployment, "configHash" | "instanceId" | "createdAt" | "updatedAt" | "target">> & {
    target: TriggerDeployment["target"];
  };
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

function defaultDeployment(configHash: string, input: TriggerCreateInput["deployment"]) {
  const timestamp = now();
  return TriggerDeploymentSchema.parse({
    configHash,
    deploymentId: input.deploymentId,
    instanceId: localInstanceId(),
    origin: input.origin || "controlled-instance",
    enabled: input.enabled ?? true,
    target: input.target,
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
    const warned = new Set<string>();
    this.indexStore = new DomainStore(path.join(paths.triggersDir, "index.json"), {
      schema: TriggerIndexSchema,
      defaultValue: () => ({ schemaVersion: 1, configs: [], deployments: [], runtime: [], recentRuns: [] }),
      sanitize: (value) => sanitizeStoredTriggerIndex(value, (warning) => {
        const key = `${warning.kind}:${warning.id}:${warning.reason}`;
        if (warned.has(key)) return;
        warned.add(key);
        console.warn(JSON.stringify({ message: "historical trigger entry was sanitized", ...warning }));
      }),
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

export function sanitizeStoredTriggerIndex(input: unknown, onWarning?: (warning: TriggerStorageWarning) => void): TriggerIndex {
  const source = objectRecord(input);
  if (!source) {
    onWarning?.({ kind: "index", id: "index", reason: "invalid index replaced with an empty index" });
    return TriggerIndexSchema.parse({});
  }

  const configs = arrayValue(source.configs).flatMap((entry, index) => {
    const raw = objectRecord(entry);
    const id = stringValue(raw?.configHash) || `config[${index}]`;
    if (!raw) {
      onWarning?.({ kind: "config", id, reason: "invalid config removed" });
      return [];
    }
    const candidate = storedTriggerConfig(raw);
    return parsedStoredEntry(TriggerConfigSchema, candidate, raw, "config", id, onWarning);
  });

  const deployments = arrayValue(source.deployments).flatMap((entry, index) => {
    const raw = objectRecord(entry);
    const id = stringValue(raw?.deploymentId) || stringValue(raw?.configHash) || `deployment[${index}]`;
    const target = objectRecord(raw?.target);
    if (target?.type === "conversation") {
      onWarning?.({ kind: "deployment", id, reason: "conversation target removed" });
      return [];
    }
    if (!raw) {
      onWarning?.({ kind: "deployment", id, reason: "invalid deployment removed" });
      return [];
    }
    const candidate = pick(raw, ["configHash", "deploymentId", "instanceId", "origin", "enabled", "localName", "createdAt", "updatedAt"]);
    candidate.target = target ? pick(target, ["type", "aiSessionId"]) : target;
    return parsedStoredEntry(TriggerDeploymentSchema, candidate, raw, "deployment", id, onWarning);
  });

  const deploymentKeys = new Set(deployments.map((entry) => deploymentKey(entry)));
  const runtime = arrayValue(source.runtime).flatMap((entry, index) => {
    const raw = objectRecord(entry);
    const id = stringValue(raw?.deploymentId) || stringValue(raw?.configHash) || `runtime[${index}]`;
    if (!raw || !deploymentKeys.has(id)) {
      onWarning?.({ kind: "runtime", id, reason: "orphaned or conversation runtime removed" });
      return [];
    }
    return parsedStoredEntry(
      TriggerRuntimeStateSchema,
      pick(raw, ["configHash", "deploymentId", "instanceId", "status", "lastTriggeredAt", "lastCompletedAt", "lastSkippedAt", "lastError", "runCount", "skippedCount"]),
      raw,
      "runtime",
      id,
      onWarning,
    );
  });

  const recentRuns = arrayValue(source.recentRuns).flatMap((entry, index) => {
    const raw = objectRecord(entry);
    const id = stringValue(raw?.id) || `recentRun[${index}]`;
    const target = objectRecord(raw?.target);
    if (target?.type === "conversation") {
      onWarning?.({ kind: "recent-run", id, reason: "conversation target run removed" });
      return [];
    }
    if (!raw) {
      onWarning?.({ kind: "recent-run", id, reason: "invalid run removed" });
      return [];
    }
    const candidate = pick(raw, ["id", "configHash", "deploymentId", "instanceId", "eventType", "status", "promptPreview", "eventSummary", "error", "startedAt", "completedAt"]);
    candidate.target = target ? pick(target, ["type", "aiSessionId"]) : target;
    return parsedStoredEntry(TriggerRunSchema, candidate, raw, "recent-run", id, onWarning);
  });

  const knownIndex = pick(source, ["schemaVersion", "configs", "deployments", "runtime", "recentRuns"]);
  if (Object.keys(source).some((key) => !(key in knownIndex))) {
    onWarning?.({ kind: "index", id: "index", reason: "unknown index fields ignored" });
  }
  return TriggerIndexSchema.parse({ schemaVersion: 1, configs, deployments, runtime, recentRuns });
}

function storedTriggerConfig(raw: Record<string, unknown>) {
  const candidate = pick(raw, ["configHash", "name", "description", "createdAt", "updatedAt"]);
  const source = objectRecord(raw.source);
  if (source) {
    if (source.type === "schedule") {
      candidate.source = pick(source, ["type", "scheduleKind", "intervalMs", "timeOfDay", "timezone", "weekdays"]);
    } else if (source.type === "file-change") {
      candidate.source = pick(source, ["type", "roots", "globs", "ignore", "debounceMs"]);
    } else if (source.type === "ai-session") {
      candidate.source = pick(source, ["type", "agent", "statuses", "phases"]);
    } else {
      candidate.source = source;
    }
  }
  const action = objectRecord(raw.action);
  candidate.action = action ? pick(action, ["promptTemplate"]) : action;
  const policy = objectRecord(raw.policy);
  candidate.policy = policy ? pick(policy, ["cooldownMs", "maxConcurrentRuns", "whenBusy"]) : policy;
  return candidate;
}

function parsedStoredEntry<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  candidate: Record<string, unknown>,
  raw: Record<string, unknown>,
  kind: TriggerStorageWarning["kind"],
  id: string,
  onWarning?: (warning: TriggerStorageWarning) => void,
): T[] {
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    onWarning?.({ kind, id, reason: "entry failed current schema and was removed" });
    return [];
  }
  if (JSON.stringify(candidate) !== JSON.stringify(raw)) {
    onWarning?.({ kind, id, reason: "unknown or legacy fields ignored" });
  }
  return [parsed.data];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function pick(source: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, source[key]]));
}
