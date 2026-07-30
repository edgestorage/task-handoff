import {
  InstanceResourceMetricsSchema,
  type ControlledInstance,
  type InstanceResourceMetrics,
} from "@task-handoff/protocol/control-plane";
import type { CommandRunner } from "../shared/process/command-runner.ts";

const ACTIVE_INSTANCE_STATUSES = new Set<ControlledInstance["status"]>(["provisioning", "starting", "registering", "registered", "running", "unhealthy"]);
const DOCKER_STATS_FORMAT = JSON.stringify({
  id: "{{.ID}}",
  name: "{{.Name}}",
  cpu: "{{.CPUPerc}}",
  memory: "{{.MemUsage}}",
  memoryPercent: "{{.MemPerc}}",
  network: "{{.NetIO}}",
  blockIo: "{{.BlockIO}}",
  pids: "{{.PIDs}}",
});
const DOCKER_STATS_TIMEOUT_MS = 5_000;

type DockerMetricsTarget = Pick<ControlledInstance, "id" | "status" | "runtime">;

export class DockerRuntimeMetricsCollector {
  private readonly snapshots = new Map<string, InstanceResourceMetrics>();
  private readonly runCommand: CommandRunner;
  private readonly targets: () => DockerMetricsTarget[];
  private readonly publish?: (metrics: InstanceResourceMetrics) => void;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight?: Promise<void>;
  private readonly pendingTargets = new Map<string, DockerMetricsTarget>();
  private readonly collectingTargets = new Map<string, string>();

  constructor(
    runCommand: CommandRunner,
    targets: () => DockerMetricsTarget[],
    publish?: (metrics: InstanceResourceMetrics) => void,
    intervalMs = 3_000,
  ) {
    this.runCommand = runCommand;
    this.targets = targets;
    this.publish = publish;
    this.intervalMs = intervalMs;
  }

  start() {
    void this.collect().catch(() => undefined);
    this.timer = setInterval(() => void this.collect().catch(() => undefined), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async snapshot(instanceId: string) {
    const target = this.targets().find((item) => item.id === instanceId);
    if (!target) return undefined;
    if (!ACTIVE_INSTANCE_STATUSES.has(target.status)) return stoppedMetrics(target.id);
    const cached = this.snapshots.get(instanceId);
    if (cached && Date.now() - Date.parse(cached.sampledAt) <= this.intervalMs) return cached;
    await this.collect([target]);
    return this.snapshots.get(instanceId);
  }

  async collect(selectedTargets?: DockerMetricsTarget[]) {
    const targets = selectedTargets || this.targets();
    if (!selectedTargets) {
      const currentIds = new Set(targets.map((target) => target.id));
      for (const instanceId of this.snapshots.keys()) if (!currentIds.has(instanceId)) this.snapshots.delete(instanceId);
    }
    for (const target of targets) {
      const fingerprint = metricsTargetFingerprint(target);
      if (this.collectingTargets.get(target.id) !== fingerprint) this.pendingTargets.set(target.id, target);
    }
    if (!this.inFlight) {
      this.inFlight = this.drain().finally(() => {
        this.inFlight = undefined;
      });
    }
    await this.inFlight;
  }

  private async drain() {
    while (this.pendingTargets.size) {
      const targets = [...this.pendingTargets.values()];
      this.pendingTargets.clear();
      for (const target of targets) this.collectingTargets.set(target.id, metricsTargetFingerprint(target));
      try {
        await this.collectOnce(targets);
      } finally {
        for (const target of targets) this.collectingTargets.delete(target.id);
      }
    }
  }

  private async collectOnce(selectedTargets: DockerMetricsTarget[]) {
    const active = selectedTargets.filter((item) => ACTIVE_INSTANCE_STATUSES.has(item.status) && (item.runtime.containerId || item.runtime.containerName));
    for (const target of selectedTargets.filter((item) => ACTIVE_INSTANCE_STATUSES.has(item.status) && !item.runtime.containerId && !item.runtime.containerName)) {
      this.update(pendingMetrics(target.id));
    }
    for (const target of selectedTargets.filter((item) => !ACTIVE_INSTANCE_STATUSES.has(item.status))) {
      this.update(stoppedMetrics(target.id));
    }
    if (!active.length) return;

    const identifiers = active.map((item) => item.runtime.containerId || item.runtime.containerName!);
    const sampledAt = new Date().toISOString();
    try {
      const result = await this.runCommand("docker", ["stats", "--no-stream", "--format", DOCKER_STATS_FORMAT, ...identifiers], { timeoutMs: DOCKER_STATS_TIMEOUT_MS });
      this.applyDockerOutput(active, result.stdout, sampledAt);
    } catch (error) {
      if (active.length === 1) {
        this.update(unavailableMetrics(active[0].id, sampledAt, error instanceof Error ? error.message : String(error)));
        return;
      }
      await Promise.all(active.map(async (target) => {
        const identifier = target.runtime.containerId || target.runtime.containerName!;
        try {
          const result = await this.runCommand("docker", ["stats", "--no-stream", "--format", DOCKER_STATS_FORMAT, identifier], { timeoutMs: DOCKER_STATS_TIMEOUT_MS });
          this.applyDockerOutput([target], result.stdout, sampledAt);
        } catch (targetError) {
          this.update(unavailableMetrics(target.id, sampledAt, targetError instanceof Error ? targetError.message : String(targetError)));
        }
      }));
    }
  }

  private applyDockerOutput(targets: DockerMetricsTarget[], output: string, sampledAt: string) {
    const byContainer = parseDockerStatsOutput(output, sampledAt);
    for (const target of targets) {
      const identifiers = [target.runtime.containerId, target.runtime.containerName].filter(Boolean) as string[];
      const metrics = [...byContainer.entries()].find(([key]) => identifiers.some((identifier) => identifier === key || identifier.startsWith(key) || key.startsWith(identifier)))?.[1];
      this.update(metrics ? { ...metrics, instanceId: target.id } : unavailableMetrics(target.id, sampledAt, "Container metrics were not returned by Docker."));
    }
  }

  private update(metrics: InstanceResourceMetrics) {
    const parsed = InstanceResourceMetricsSchema.parse(metrics);
    this.snapshots.set(parsed.instanceId, parsed);
    this.publish?.(parsed);
  }
}

function metricsTargetFingerprint(target: DockerMetricsTarget) {
  return [target.status, target.runtime.containerId || "", target.runtime.containerName || ""].join("\0");
}

export function parseDockerStatsOutput(output: string, sampledAt = new Date().toISOString()) {
  const metrics = new Map<string, InstanceResourceMetrics>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = stringValue(row.id);
    const name = stringValue(row.name);
    const container = id || name;
    if (!container) continue;
    const memory = parsePair(stringValue(row.memory));
    const network = parsePair(stringValue(row.network));
    const blockIo = parsePair(stringValue(row.blockIo));
    const parsed = InstanceResourceMetricsSchema.parse({
      instanceId: container,
      runtimeKind: "docker",
      state: "available",
      sampledAt,
      cpu: optionalPercent(row.cpu, "usagePercent"),
      memory: memory ? {
        usageBytes: memory[0],
        ...(memory[1] !== undefined ? { limitBytes: memory[1] } : {}),
        ...optionalPercent(row.memoryPercent, "usagePercent"),
      } : undefined,
      network: network ? { rxBytes: network[0], txBytes: network[1] || 0 } : undefined,
      blockIo: blockIo ? { readBytes: blockIo[0], writeBytes: blockIo[1] || 0 } : undefined,
      pids: optionalNonnegativeNumber(row.pids),
    });
    if (id) metrics.set(id, parsed);
    if (name) metrics.set(name, parsed);
  }
  return metrics;
}

export function parseDockerByteSize(value: string) {
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const binary = unit.includes("i");
  const prefix = unit[0] === "b" ? "" : unit[0];
  const exponent = prefix ? "kmgtpe".indexOf(prefix) + 1 : 0;
  return Math.round(amount * ((binary ? 1024 : 1000) ** exponent));
}

function parsePair(value: string) {
  if (!value) return undefined;
  const [first, second] = value.split("/").map((item) => parseDockerByteSize(item || ""));
  return first === undefined ? undefined : [first, second] as const;
}

function optionalPercent(value: unknown, key: string) {
  const parsed = Number(stringValue(value).replace(/%$/, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? { [key]: parsed } : undefined;
}

function optionalNonnegativeNumber(value: unknown) {
  const parsed = Number(stringValue(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function stoppedMetrics(instanceId: string): InstanceResourceMetrics {
  return { instanceId, runtimeKind: "docker", state: "stopped", sampledAt: new Date().toISOString() };
}

function pendingMetrics(instanceId: string): InstanceResourceMetrics {
  return { instanceId, runtimeKind: "docker", state: "pending", sampledAt: new Date().toISOString() };
}

function unavailableMetrics(instanceId: string, sampledAt: string, error: string): InstanceResourceMetrics {
  return { instanceId, runtimeKind: "docker", state: "unavailable", sampledAt, error: error.slice(0, 2048) };
}
