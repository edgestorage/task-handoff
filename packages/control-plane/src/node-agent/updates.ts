import {
  NodeRolloutSummarySchema,
  NodeUpdateImpactSchema,
  RuntimeArtifactIdentitySchema,
  RuntimeConvergenceErrorSchema,
  UpdateCheckResultSchema,
  UpdateJobSchema,
  type UpdateChannel,
  type UpdateCheckResult,
  type UpdateJob,
} from "@task-handoff/protocol/control-plane";
import semver from "semver";
import fs from "node:fs";
import path from "node:path";
import type { CommandRunner } from "../shared/process/command-runner.ts";
import type { NodeAgentStorePaths } from "./persistence/paths.ts";
import { createId, JsonCollection } from "../shared/persistence/store.ts";

function now() {
  return new Date().toISOString();
}

export function isNewerVersion(current: string | undefined, available: string) {
  if (!current) return true;
  const currentVersion = semver.valid(current);
  const availableVersion = semver.valid(available);
  if (!currentVersion || !availableVersion) return current !== available;
  return semver.gt(availableVersion, currentVersion);
}

async function npmVersion(runCommand: CommandRunner, packageName: string, channel: UpdateChannel) {
  const registryTag = registryTagForChannel(channel);
  const result = await runCommand(npmCommand(), ["view", `${packageName}@${registryTag}`, "version", "--json"]).catch((error: unknown) => {
    if (isNpmNotFoundError(error)) return undefined;
    throw error;
  });
  if (!result) return undefined;
  const parsed = JSON.parse(result.stdout);
  if (typeof parsed !== "string") throw new Error(`npm did not resolve ${packageName}@${registryTag} to one version.`);
  return parsed;
}

async function npmIntegrity(runCommand: CommandRunner, packageName: string, version: string) {
  const result = await runCommand(npmCommand(), ["view", `${packageName}@${version}`, "dist.integrity", "--json"]);
  const parsed = JSON.parse(result.stdout);
  if (typeof parsed !== "string" || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(parsed)) {
    throw Object.assign(new Error(`npm did not return immutable integrity metadata for ${packageName}@${version}.`), {
      statusCode: 502,
      code: "NODE_UPDATE_PREFLIGHT_FAILED",
      retryable: true,
    });
  }
  return parsed;
}

export function npmCommand() {
  return process.env.TASK_HANDOFF_NPM_COMMAND || "npm";
}

export type NodeUpdatePackageName = "@task-handoff/node-agent" | "@task-handoff/server";

function installedPackageManifest(globalRoot: string, packageName: NodeUpdatePackageName) {
  const manifestPath = path.join(globalRoot, ...packageName.split("/"), "package.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
    if (manifest.name !== packageName || typeof manifest.version !== "string" || !manifest.version.trim()) {
      throw new Error(`Installed package manifest is invalid: ${manifestPath}`);
    }
    return { name: packageName, version: manifest.version.trim() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export type NodeUpdatePackageSelection = {
  packageName: NodeUpdatePackageName;
  currentVersion?: string;
  relatedCurrentVersions: string[];
};

export async function resolveNodeUpdatePackage(runCommand: CommandRunner): Promise<NodeUpdatePackageSelection> {
  const result = await runCommand(npmCommand(), ["root", "--global"]);
  const globalRoot = result.stdout.trim();
  if (!globalRoot) throw new Error("npm did not return its global module root.");
  const server = installedPackageManifest(globalRoot, "@task-handoff/server");
  const nodeAgent = installedPackageManifest(globalRoot, "@task-handoff/node-agent");
  if (server) {
    return {
      packageName: "@task-handoff/server",
      currentVersion: server.version,
      relatedCurrentVersions: nodeAgent ? [nodeAgent.version] : [],
    };
  }
  return {
    packageName: "@task-handoff/node-agent",
    currentVersion: nodeAgent?.version,
    relatedCurrentVersions: [],
  };
}

export function resolveNodeAgentUpdateWorker(moduleDir: string, exists: (candidate: string) => boolean = fs.existsSync) {
  const packagedCandidates = [
    // Runtime releases bundle the node agent into <package>/dist/cli.js.
    path.resolve(moduleDir, "..", "bin", "task-handoff-node-update-worker"),
    // A package may expose bin/ while its TypeScript source is loaded directly.
    path.resolve(moduleDir, "..", "..", "bin", "task-handoff-node-update-worker"),
  ];
  const packagedWorker = packagedCandidates.find(exists);
  const sourceWorker = path.resolve(moduleDir, "..", "..", "..", "..", "scripts", "node-update-worker.cjs");
  if (packagedWorker) return { worker: packagedWorker, packaged: true, expectedWorker: packagedCandidates[0] };
  if (exists(sourceWorker)) return { worker: sourceWorker, packaged: false, expectedWorker: packagedCandidates[0] };
  return { worker: undefined, packaged: false, expectedWorker: packagedCandidates[0] };
}

function isNpmNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as { message?: unknown; details?: { stdout?: unknown; stderr?: unknown } };
  const output = [record.message, record.details?.stdout, record.details?.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return /\bE404\b/i.test(output);
}

function unavailableNpmRelease(input: {
  channel: UpdateChannel;
  currentVersion?: string;
  impact?: UpdateCheckResult["impact"];
}) {
  return UpdateCheckResultSchema.parse({
    source: "npm",
    channel: input.channel,
    currentVersion: input.currentVersion,
    availableVersion: input.currentVersion || "unavailable",
    impact: input.impact || emptyUpdateImpact(),
    updateAvailable: false,
    reason: `No ${input.channel} release is currently published.`,
    checkedAt: now(),
  });
}

export function registryTagForChannel(channel: UpdateChannel) {
  return channel === "stable" ? "latest" : channel;
}

export async function checkNodeAgentUpdate(input: {
  channel: UpdateChannel;
  currentVersion?: string;
  runCommand: CommandRunner;
  packageName?: NodeUpdatePackageName;
  relatedCurrentVersions?: string[];
  impact?: UpdateCheckResult["impact"];
  runtimeArtifacts?: UpdateCheckResult["runtimeArtifacts"];
}): Promise<UpdateCheckResult> {
  const packageName = input.packageName || "@task-handoff/node-agent";
  const availableVersion = await npmVersion(input.runCommand, packageName, input.channel);
  if (!availableVersion) {
    return unavailableNpmRelease({
      channel: input.channel,
      currentVersion: input.currentVersion,
      impact: input.impact,
    });
  }
  const updateAvailable = isNewerVersion(input.currentVersion, availableVersion)
    || (input.relatedCurrentVersions || []).some((version) => isNewerVersion(version, availableVersion));
  const integrity = updateAvailable ? await npmIntegrity(input.runCommand, packageName, availableVersion) : undefined;
  return UpdateCheckResultSchema.parse({
    source: "npm",
    channel: input.channel,
    currentVersion: input.currentVersion,
    availableVersion,
    ...(integrity ? { artifactRef: `npm:${packageName}@${availableVersion}#${integrity}` } : {}),
    runtimeArtifacts: input.runtimeArtifacts || [],
    impact: input.impact || emptyUpdateImpact(),
    updateAvailable,
    checkedAt: now(),
  });
}

function emptyUpdateImpact(): UpdateCheckResult["impact"] {
  return {
    runningInstanceCount: 0,
    stoppedInstanceCount: 0,
    activeInstanceCount: 0,
    restartInstanceCount: 0,
    runningInstanceIds: [],
    stoppedInstanceIds: [],
    activeInstanceIds: [],
  };
}

export function sanitizeStoredUpdateJob(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const timestamp = typeof source.updatedAt === "string" ? source.updatedAt : now();
  const target = source.target && typeof source.target === "object" && !Array.isArray(source.target)
    ? source.target as Record<string, unknown>
    : undefined;
  const legacyInstanceJob = target?.component === "controlled-instance";
  const statusMap: Record<string, UpdateJob["status"]> = {
    updating: "updating-node",
    downloading: "updating-node",
    installing: "updating-node",
    restarting: "restarting-node",
    completed: "succeeded",
    success: "succeeded",
    error: "failed",
  };
  const knownStatuses = new Set<UpdateJob["status"]>(["queued", "updating-node", "restarting-node", "converging-instances", "succeeded", "degraded", "failed"]);
  const rawStatus = typeof source.status === "string" ? source.status : "queued";
  const status = legacyInstanceJob
    ? "failed"
    : knownStatuses.has(rawStatus as UpdateJob["status"])
      ? rawStatus as UpdateJob["status"]
      : statusMap[rawStatus] || "failed";
  const desiredVersion = typeof source.toVersion === "string" && source.toVersion ? source.toVersion : "unknown";
  const impact = NodeUpdateImpactSchema.strip().safeParse(source.impact).success
    ? NodeUpdateImpactSchema.strip().parse(source.impact)
    : emptyUpdateImpact();
  const error = legacyInstanceJob
    ? { code: "LEGACY_INSTANCE_UPDATE_RETIRED", message: "Independent controlled-instance update jobs were retired in favor of Node reconciliation.", retryable: false }
    : status === "failed" && !source.error && !knownStatuses.has(rawStatus as UpdateJob["status"]) && !(rawStatus in statusMap)
      ? { code: "NODE_UPDATE_FAILED", message: `Stored update job used an unknown status: ${rawStatus}.`, retryable: false }
    : typeof source.error === "string"
      ? { code: "NODE_UPDATE_FAILED", message: source.error, retryable: false }
    : RuntimeConvergenceErrorSchema.strip().safeParse(source.error).success
      ? RuntimeConvergenceErrorSchema.strip().parse(source.error)
      : source.error && typeof source.error === "object"
        ? { code: "NODE_UPDATE_FAILED", message: typeof (source.error as Record<string, unknown>).message === "string" ? (source.error as Record<string, unknown>).message : "Stored update job contained an unknown error.", retryable: false }
        : undefined;
  const { target: _legacyTarget, error: _storedError, ...rest } = source;
  const fallbackRollout = {
    phase: status === "succeeded" ? "succeeded" : status === "failed" ? "failed" : status || "queued",
    desiredVersion,
    expectedInstanceIds: [],
    expectedInstanceCount: 0,
    matchedInstanceCount: 0,
    pendingInstanceCount: 0,
    failedInstanceCount: legacyInstanceJob || status === "failed" ? 1 : 0,
    deferredInstanceCount: 0,
  };
  const parsedRollout = NodeRolloutSummarySchema.strip().safeParse(source.rollout);
  return {
    ...rest,
    source: "npm",
    status,
    impact,
    runtimeArtifacts: Array.isArray(source.runtimeArtifacts)
      ? source.runtimeArtifacts.flatMap((artifact) => {
          const parsed = RuntimeArtifactIdentitySchema.strip().safeParse(artifact);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
    rollout: parsedRollout.success ? parsedRollout.data : fallbackRollout,
    ...(error ? { error } : {}),
    ...(legacyInstanceJob ? { completedAt: source.completedAt || timestamp } : {}),
  };
}

export class NodeUpdateJobs {
  readonly records: JsonCollection<UpdateJob>;

  constructor(paths: NodeAgentStorePaths) {
    this.records = new JsonCollection(paths.updatesDir, { schema: UpdateJobSchema, sanitize: sanitizeStoredUpdateJob });
  }

  init() {
    this.records.init();
  }

  list() {
    return this.records.list().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  create(nodeId: string, check: UpdateCheckResult) {
    const timestamp = now();
    return this.records.put(UpdateJobSchema.parse({
      id: createId("update"),
      nodeId,
      source: check.source,
      channel: check.channel,
      fromVersion: check.currentVersion,
      toVersion: check.availableVersion,
      artifactRef: check.artifactRef,
      runtimeArtifacts: check.runtimeArtifacts,
      impact: check.impact,
      status: "queued",
      rollout: {
        phase: "queued",
        desiredVersion: check.availableVersion,
        expectedInstanceIds: check.impact.runningInstanceIds,
        expectedInstanceCount: check.impact.runningInstanceCount,
        matchedInstanceCount: 0,
        pendingInstanceCount: check.impact.runningInstanceCount,
        failedInstanceCount: 0,
        deferredInstanceCount: check.impact.stoppedInstanceCount,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }

  patch(id: string, patch: Partial<UpdateJob>) {
    const current = this.records.get(id);
    if (!current) throw Object.assign(new Error(`Update job ${id} was not found.`), { statusCode: 404, code: "UPDATE_JOB_NOT_FOUND" });
    return this.records.put(UpdateJobSchema.parse({ ...current, ...patch, id, createdAt: current.createdAt, updatedAt: now() }));
  }

  reconcileRollouts(
    instances: Array<{ id: string; status?: string; ready: boolean; runtimeVersion?: { actualVersion?: string; desiredVersion: string; phase: string } }>,
    nodeVersion: string,
    options: { processStarted?: boolean } = {},
  ) {
    const byId = new Map(instances.map((instance) => [instance.id, instance]));
    for (const persisted of this.list().filter((candidate) => ["updating-node", "restarting-node", "converging-instances"].includes(candidate.status))) {
      if (options.processStarted && persisted.status === "restarting-node" && nodeVersion !== persisted.toVersion) {
        this.patch(persisted.id, {
          status: "failed",
          rollout: { ...persisted.rollout, phase: "failed", nodeVersion },
          error: {
            code: "NODE_UPDATE_FAILED",
            message: `Node agent restarted with version ${nodeVersion}, expected ${persisted.toVersion}.`,
            retryable: false,
          },
          completedAt: now(),
        });
        continue;
      }
      const job = persisted.status !== "converging-instances" && nodeVersion === persisted.toVersion
        ? this.patch(persisted.id, {
            status: "converging-instances",
            rollout: { ...persisted.rollout, phase: "converging-instances", nodeVersion },
          })
        : persisted;
      if (job.status !== "converging-instances") continue;
      const expectedIds = job.rollout.expectedInstanceIds;
      const expected = expectedIds.map((id) => byId.get(id));
      const matched = expected.filter((instance) => instance?.ready && instance.runtimeVersion?.phase === "matched" && instance.runtimeVersion.actualVersion === job.toVersion).length;
      const deferred = expected.filter((instance) => instance && ["created", "stopped", "failed"].includes(instance.status || "") && instance.runtimeVersion?.phase !== "failed").length;
      const failed = expected.filter((instance) => !instance || instance.runtimeVersion?.phase === "failed").length;
      const pending = Math.max(0, expectedIds.length - matched - failed - deferred);
      const phase = failed > 0 ? "degraded" : pending === 0 ? "succeeded" : "converging-instances";
      this.patch(job.id, {
        status: phase,
        rollout: {
          ...job.rollout,
          phase,
          nodeVersion,
          expectedInstanceCount: expectedIds.length,
          matchedInstanceCount: matched,
          pendingInstanceCount: pending,
          failedInstanceCount: failed,
          deferredInstanceCount: job.impact.stoppedInstanceCount + deferred,
        },
        ...(phase === "succeeded" || phase === "degraded" ? { completedAt: now() } : {}),
      });
    }
  }

  run(job: UpdateJob, execute: (job: UpdateJob) => Promise<void>) {
    void (async () => {
      this.patch(job.id, { status: "updating-node", rollout: { ...job.rollout, phase: "updating-node" }, startedAt: now(), error: undefined });
      try {
        await execute(job);
        this.patch(job.id, { status: "succeeded", completedAt: now() });
      } catch (error) {
        this.patch(job.id, {
          status: "failed",
          rollout: { ...job.rollout, phase: "failed" },
          error: { code: "NODE_UPDATE_FAILED", message: error instanceof Error ? error.message : String(error), retryable: false },
          completedAt: now(),
        });
      }
    })();
  }
}
