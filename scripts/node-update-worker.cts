#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Command, InvalidArgumentError } = require("commander");
const semver = require("semver");
const writeFileAtomic = require("write-file-atomic");
const { ControlPlaneHealthResponseSchema } = require("../packages/protocol/src/control-plane.ts") as typeof import("../packages/protocol/src/control-plane.ts");

function controlPlanePackageVersion(payload: unknown) {
  const parsed = ControlPlaneHealthResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.data.build.packageVersion : undefined;
}

function parseExactVersion(value) {
  if (value.trim() !== value || /^[v=]/.test(value) || semver.valid(value) === null) throw new InvalidArgumentError("must be an exact semantic version");
  return value;
}

function parseControlPlaneHealthUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidArgumentError("must be a valid loopback HTTP URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new InvalidArgumentError("must be a valid loopback HTTP URL");
  }
  return parsed.toString();
}

const options = new Command()
  .name("task-handoff-node-update-worker")
  .description("Apply a detached TaskHandoff node update.")
  .requiredOption("--job-file <path>", "persisted update job file")
  .requiredOption("--target-version <version>", "exact semantic version", parseExactVersion)
  .option("--service <name>", "systemd service to restart", "task-handoff-node-agent.service")
  .option("--npm-command <path>", "npm executable", process.env.TASK_HANDOFF_NPM_COMMAND || "npm")
  .option("--control-plane-health-url <url>", "local control-plane health endpoint", parseControlPlaneHealthUrl)
  .parse(process.argv)
  .opts();

const jobFile = options.jobFile;
const targetVersion = options.targetVersion;
const service = options.service;
const npmCommand = options.npmCommand;
const controlPlaneHealthUrl = options.controlPlaneHealthUrl;
const terminalStatuses = new Set(["succeeded", "degraded", "failed"]);
const supportedPackages = new Set(["@task-handoff/node-agent", "@task-handoff/server"]);

function updateJob(expectedStatuses, createPatch) {
  const observed = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  // Test-only synchronization point used to prove that the value is checked
  // again after another process changes it between observation and commit.
  if (process.env.TASK_HANDOFF_UPDATE_WORKER_TEST_CAS_HOOK) {
    require(path.resolve(process.env.TASK_HANDOFF_UPDATE_WORKER_TEST_CAS_HOOK))({ jobFile, observed });
  }

  const lockPath = `${jobFile}.worker-lock`;
  fs.mkdirSync(lockPath);
  try {
    const current = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    if (terminalStatuses.has(current.status) || !expectedStatuses.includes(current.status)) {
      return false;
    }
    const patch = typeof createPatch === "function" ? createPatch(current) : createPatch;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    writeFileAtomic.sync(jobFile, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
    return true;
  } finally {
    fs.rmdirSync(lockPath);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}

function installedVersion(packageName: string, globalRoot: string, nestedUnder?: string) {
  const manifest = nestedUnder
    ? path.join(globalRoot, ...nestedUnder.split("/"), "node_modules", ...packageName.split("/"), "package.json")
    : path.join(globalRoot, ...packageName.split("/"), "package.json");
  try {
    return JSON.parse(fs.readFileSync(manifest, "utf8")).version;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function verifyInstalledVersion(packageName, globalRoot) {
  const actualVersion = installedVersion(packageName, globalRoot);
  if (actualVersion !== targetVersion) {
    throw new Error(`Updated ${packageName} verification failed: expected ${targetVersion}, found ${actualVersion || "unknown"}.`);
  }
}

function verifyServerDistributionVersions(globalRoot) {
  for (const packageName of ["@task-handoff/control-plane", "@task-handoff/node-agent", "@task-handoff/controlled-instance"]) {
    const actualVersion = installedVersion(packageName, globalRoot, "@task-handoff/server")
      || installedVersion(packageName, globalRoot);
    if (actualVersion !== targetVersion) {
      throw new Error(`Updated @task-handoff/server does not provide ${packageName} ${targetVersion}; found ${actualVersion || "unknown"}.`);
    }
  }
}

function npmArtifactIntegrity(packageName) {
  const result = spawnSync(npmCommand, ["view", `${packageName}@${targetVersion}`, "dist.integrity", "--json"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not verify the ${packageName} npm artifact integrity.`);
  let integrity;
  try {
    integrity = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm returned invalid ${packageName} artifact integrity metadata.`);
  }
  if (typeof integrity !== "string" || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity)) {
    throw new Error(`npm returned invalid ${packageName} artifact integrity metadata.`);
  }
  return integrity;
}

function verifyNpmArtifactIntegrity() {
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const suffix = `@${targetVersion}#`;
  if (typeof job.artifactRef !== "string" || !job.artifactRef.startsWith("npm:") || !job.artifactRef.includes(suffix)) {
    throw new Error(`Update job does not pin npm integrity for version ${targetVersion}.`);
  }
  const separator = job.artifactRef.indexOf(suffix);
  const packageName = job.artifactRef.slice("npm:".length, separator);
  const expectedIntegrity = job.artifactRef.slice(separator + suffix.length);
  if (!supportedPackages.has(packageName) || !expectedIntegrity) {
    throw new Error(`Update job does not identify a supported immutable npm artifact.`);
  }
  const actualIntegrity = npmArtifactIntegrity(packageName);
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error(`${packageName} npm artifact integrity mismatch: expected ${expectedIntegrity}, found ${String(actualIntegrity || "unknown")}.`);
  }
  return { packageName, integrity: actualIntegrity };
}

function activePackagePrefix(scriptPath: string) {
  let current = path.resolve(scriptPath);
  while (current !== path.dirname(current)) {
    if (path.basename(current) === "node_modules" && path.basename(path.dirname(current)) === "lib") {
      return path.dirname(path.dirname(current));
    }
    current = path.dirname(current);
  }
  return undefined;
}

async function waitForControlPlaneHealth(healthUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "not reachable";
  while (Date.now() < deadline) {
    try {
      if (process.env.TASK_HANDOFF_UPDATE_WORKER_TEST_HEALTH_FILE) {
        const payload = JSON.parse(fs.readFileSync(process.env.TASK_HANDOFF_UPDATE_WORKER_TEST_HEALTH_FILE, "utf8"));
        const version = controlPlanePackageVersion(payload);
        if (version === targetVersion) return;
        lastFailure = `reported version ${String(version || "unknown")}`;
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      const response = await fetch(healthUrl, {
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(2_000),
      });
      const payload = await response.json().catch(() => ({}));
      const version = controlPlanePackageVersion(payload);
      if (response.ok && version === targetVersion) return;
      lastFailure = response.ok ? `reported version ${String(version || "unknown")}` : `returned HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Control plane did not become healthy at ${healthUrl} with version ${targetVersion}: ${lastFailure}.`);
}

async function main() {
try {
  const claimed = updateJob(["queued"], (current) => ({
    status: "updating-node",
    rollout: { ...current.rollout, phase: "updating-node" },
    startedAt: new Date().toISOString(),
    error: undefined,
  }));
  if (!claimed) process.exit(0);
  const verifiedArtifact = verifyNpmArtifactIntegrity();
  const packageName = verifiedArtifact.packageName;
  // Compatibility for v0.0.18: install beside the worker that the service is
  // actually running, even when npm's ambient global prefix has changed.
  const ownedPrefix = activePackagePrefix(process.argv[1]);
  const prefixResult = ownedPrefix ? undefined : spawnSync(npmCommand, ["prefix", "--global"], { encoding: "utf8" });
  if (prefixResult && prefixResult.status !== 0) throw new Error("Could not determine the npm global prefix.");
  const prefix = ownedPrefix || prefixResult?.stdout.trim();
  if (!prefix) throw new Error("Could not determine the npm global prefix.");
  const rootResult = spawnSync(npmCommand, ["root", "--global", "--prefix", prefix], { encoding: "utf8" });
  if (rootResult.status !== 0) throw new Error("Could not determine the npm global module root.");
  const globalRoot = rootResult.stdout.trim();
  const packageNames = [packageName];
  if (packageName === "@task-handoff/server" && installedVersion("@task-handoff/node-agent", globalRoot) !== undefined) {
    packageNames.push("@task-handoff/node-agent");
  }
  const expectedIntegrities = new Map([[packageName, verifiedArtifact.integrity]]);
  for (const companionPackage of packageNames.slice(1)) {
    expectedIntegrities.set(companionPackage, npmArtifactIntegrity(companionPackage));
  }
  for (const installedPackage of packageNames) {
    run(npmCommand, [
      "install",
      "--global",
      "--prefix",
      prefix,
      `${installedPackage}@${targetVersion}`,
    ]);
    if (npmArtifactIntegrity(installedPackage) !== expectedIntegrities.get(installedPackage)) {
      throw new Error(`${installedPackage} npm artifact integrity changed during installation.`);
    }
    verifyInstalledVersion(installedPackage, globalRoot);
  }
  if (packageName === "@task-handoff/server") {
    verifyServerDistributionVersions(globalRoot);
  }
  if (packageName === "@task-handoff/server") {
    if (!controlPlaneHealthUrl) throw new Error("A control-plane health URL is required for a complete server update.");
    run("systemctl", ["restart", "task-handoff-control-plane.service"]);
    await waitForControlPlaneHealth(controlPlaneHealthUrl);
  }
  const handedOff = updateJob(["updating-node"], (current) => ({ status: "restarting-node", rollout: { ...current.rollout, phase: "restarting-node" } }));
  if (!handedOff) process.exit(0);
  run("systemctl", ["restart", service]);
} catch (error) {
  updateJob(["queued", "updating-node", "restarting-node"], (current) => ({
    status: "failed",
    rollout: { ...current.rollout, phase: "failed" },
    error: { code: "NODE_UPDATE_FAILED", message: error instanceof Error ? error.message : String(error), retryable: false },
    completedAt: new Date().toISOString(),
  }));
  console.error(error);
  process.exit(1);
}
}

void main();
