import {
  UpdateCheckResultSchema,
  UpdateJobSchema,
  type ControlledInstance,
  type NodeRuntime,
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

export function npmCommand() {
  return process.env.TASK_HANDOFF_NPM_COMMAND || "npm";
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

function packageRootFromExecutable(executable: string, packageName: string) {
  if (!path.isAbsolute(executable) || !fs.existsSync(executable)) return undefined;
  const resolved = fs.realpathSync(executable);
  let current = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  while (current !== path.dirname(current)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
      if (manifest.name === packageName) return current;
    } catch {}
    current = path.dirname(current);
  }
  return undefined;
}

function ancestorPackageRoot(start: string, packageName: string) {
  let current = path.dirname(start);
  while (current !== path.dirname(current)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
      if (manifest.name === packageName) return current;
    } catch {}
    current = path.dirname(current);
  }
  return undefined;
}

export function managedNpmPackageInstall(input: {
  executable: string;
  globalPrefix: string;
  packageName: string;
  targetVersion: string;
}) {
  const currentPackageRoot = packageRootFromExecutable(input.executable, input.packageName);
  const aggregateRoot = currentPackageRoot && ancestorPackageRoot(currentPackageRoot, "@task-handoff/server");
  if (aggregateRoot) {
    return {
      args: ["install", "--prefix", aggregateRoot, "--no-save", `${input.packageName}@${input.targetVersion}`],
      manifestPath: path.join(currentPackageRoot, "package.json"),
    };
  }
  return {
    args: ["install", "--global", "--prefix", input.globalPrefix, `${input.packageName}@${input.targetVersion}`],
    manifestPath: currentPackageRoot
      ? path.join(currentPackageRoot, "package.json")
      : path.join(input.globalPrefix, "lib", "node_modules", ...input.packageName.split("/"), "package.json"),
  };
}

export function assertInstalledPackageVersion(manifestPath: string, expectedVersion: string) {
  let installedVersion: unknown;
  try {
    installedVersion = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
  } catch (error) {
    throw new Error(`Could not verify the updated package at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (installedVersion !== expectedVersion) {
    throw new Error(`Updated package verification failed: expected ${expectedVersion}, found ${String(installedVersion || "unknown")}.`);
  }
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
  target: UpdateCheckResult["target"];
  channel: UpdateChannel;
  currentVersion?: string;
}) {
  return UpdateCheckResultSchema.parse({
    target: input.target,
    source: "npm",
    channel: input.channel,
    currentVersion: input.currentVersion,
    availableVersion: input.currentVersion || "unavailable",
    updateAvailable: false,
    reason: `No ${input.channel} release is currently published.`,
    checkedAt: now(),
  });
}

export function registryTagForChannel(channel: UpdateChannel) {
  return channel === "stable" ? "latest" : channel;
}

function findDigest(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.map(findDigest).find(Boolean);
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.digest === "string" && record.digest.startsWith("sha256:")) return record.digest;
  if (typeof record.Digest === "string" && record.Digest.startsWith("sha256:")) return record.Digest;
  return Object.values(record).map(findDigest).find(Boolean);
}

function dockerArchitecture(arch: NodeJS.Architecture) {
  const architectures: Partial<Record<NodeJS.Architecture, string>> = {
    x64: "amd64",
    ia32: "386",
    arm: "arm",
    arm64: "arm64",
    ppc64: "ppc64le",
    s390x: "s390x",
    riscv64: "riscv64",
  };
  return architectures[arch] || arch;
}

function manifestPlatformArchitecture(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const descriptor = (record.Descriptor || record.descriptor || record) as Record<string, unknown>;
  const platform = (descriptor.platform || descriptor.Platform) as Record<string, unknown> | undefined;
  return typeof platform?.architecture === "string"
    ? platform.architecture
    : typeof platform?.Architecture === "string"
      ? platform.Architecture
      : undefined;
}

export function dockerManifestDigestForArchitecture(value: unknown, arch: NodeJS.Architecture = process.arch) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const entries = Array.isArray(value) ? value : Array.isArray(record?.manifests) ? record.manifests : undefined;
  if (!entries) return findDigest(value);
  const platformEntries = entries.filter((entry) => manifestPlatformArchitecture(entry));
  if (!platformEntries.length) return findDigest(value);
  const selected = platformEntries.find((entry) => manifestPlatformArchitecture(entry) === dockerArchitecture(arch));
  return selected ? findDigest(selected) : undefined;
}

export function dockerImageRefForChannel(imageRef: string, channel: UpdateChannel) {
  const withoutDigest = imageRef.split("@", 1)[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const repository = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  return `${repository}:${registryTagForChannel(channel)}`;
}

export async function checkNodeAgentUpdate(input: {
  channel: UpdateChannel;
  currentVersion?: string;
  runCommand: CommandRunner;
}): Promise<UpdateCheckResult> {
  const availableVersion = await npmVersion(input.runCommand, "@task-handoff/node-agent", input.channel);
  if (!availableVersion) {
    return unavailableNpmRelease({
      target: { component: "node-agent" },
      channel: input.channel,
      currentVersion: input.currentVersion,
    });
  }
  return UpdateCheckResultSchema.parse({
    target: { component: "node-agent" },
    source: "npm",
    channel: input.channel,
    currentVersion: input.currentVersion,
    availableVersion,
    updateAvailable: isNewerVersion(input.currentVersion, availableVersion),
    checkedAt: now(),
  });
}

export async function checkControlledInstanceUpdate(input: {
  channel: UpdateChannel;
  instance: ControlledInstance;
  runtime: NodeRuntime;
  runCommand: CommandRunner;
  arch?: NodeJS.Architecture;
}): Promise<UpdateCheckResult> {
  const target = { component: "controlled-instance" as const, instanceId: input.instance.id };
  if (input.runtime.type === "local") {
    const availableVersion = await npmVersion(input.runCommand, "@task-handoff/controlled-instance", input.channel);
    const currentVersion = input.instance.build?.packageVersion || input.instance.instanceVersion;
    if (!availableVersion) return unavailableNpmRelease({ target, channel: input.channel, currentVersion });
    return UpdateCheckResultSchema.parse({
      target,
      source: "npm",
      channel: input.channel,
      currentVersion,
      availableVersion,
      updateAvailable: isNewerVersion(currentVersion, availableVersion),
      checkedAt: now(),
    });
  }
  if (input.runtime.type === "docker") {
    const imageRef = input.instance.imageSnapshot?.requestedReference;
    if (!imageRef) {
      return UpdateCheckResultSchema.parse({
        target,
        source: "docker-registry",
        channel: input.channel,
        currentVersion: input.instance.build?.imageDigest,
        availableVersion: input.instance.build?.imageDigest || "unavailable",
        updateAvailable: false,
        supported: false,
        reason: "The instance does not use a remote Docker image.",
        checkedAt: now(),
      });
    }
    const artifactRef = dockerImageRefForChannel(imageRef, input.channel);
    const result = await input.runCommand("docker", ["manifest", "inspect", "--verbose", artifactRef]);
    const availableVersion = dockerManifestDigestForArchitecture(JSON.parse(result.stdout), input.arch);
    if (!availableVersion) throw new Error(`Docker registry did not return a digest for ${artifactRef} matching ${dockerArchitecture(input.arch || process.arch)}.`);
    const currentVersion = input.instance.build?.imageDigest;
    return UpdateCheckResultSchema.parse({
      target,
      source: "docker-registry",
      channel: input.channel,
      currentVersion,
      availableVersion,
      artifactRef,
      updateAvailable: currentVersion !== availableVersion,
      checkedAt: now(),
    });
  }
  return UpdateCheckResultSchema.parse({
    target,
    source: "npm",
    channel: input.channel,
    availableVersion: "unsupported",
    updateAvailable: false,
    supported: false,
    reason: `Runtime type ${input.runtime.type} does not support managed updates.`,
    checkedAt: now(),
  });
}

export class NodeUpdateJobs {
  readonly records: JsonCollection<UpdateJob>;

  constructor(paths: NodeAgentStorePaths) {
    this.records = new JsonCollection(paths.updatesDir, { schema: UpdateJobSchema });
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
      target: check.target,
      source: check.source,
      channel: check.channel,
      fromVersion: check.currentVersion,
      toVersion: check.availableVersion,
      artifactRef: check.artifactRef,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }

  patch(id: string, patch: Partial<UpdateJob>) {
    const current = this.records.get(id);
    if (!current) throw Object.assign(new Error(`Update job ${id} was not found.`), { statusCode: 404, code: "UPDATE_JOB_NOT_FOUND" });
    return this.records.put(UpdateJobSchema.parse({ ...current, ...patch, id, createdAt: current.createdAt, updatedAt: now() }));
  }

  run(job: UpdateJob, execute: (job: UpdateJob) => Promise<void>) {
    void (async () => {
      this.patch(job.id, { status: "updating", startedAt: now(), error: undefined });
      try {
        await execute(job);
        this.patch(job.id, { status: "succeeded", completedAt: now() });
      } catch (error) {
        this.patch(job.id, { status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: now() });
      }
    })();
  }
}
