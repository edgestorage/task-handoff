#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Command, InvalidArgumentError } = require("commander");
const semver = require("semver");
const writeFileAtomic = require("write-file-atomic");
const { ControlPlaneHealthResponseSchema } = require("../packages/protocol/src/control-plane.ts") as typeof import("../packages/protocol/src/control-plane.ts");
const {
  acquireServerUpdateLock,
  cleanUpServerUpdateLockOnSignals,
  globalPrefixFromModulePath,
} = require("../packages/core/src/core/server-update-installation.ts") as typeof import("../packages/core/src/core/server-update-installation.ts");

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

function parseAbsolutePath(value) {
  if (!path.isAbsolute(value)) throw new InvalidArgumentError("must be an absolute path");
  return path.resolve(value);
}

const options = new Command()
  .name("task-handoff-node-update-worker")
  .description("Apply a detached TaskHandoff node update.")
  .requiredOption("--job-file <path>", "persisted update job file")
  .requiredOption("--target-version <version>", "exact semantic version", parseExactVersion)
  .option("--service <name>", "systemd service to restart", "task-handoff-node-agent.service")
  .option("--npm-command <path>", "npm executable", process.env.TASK_HANDOFF_NPM_COMMAND || "npm")
  .option("--control-plane-health-url <url>", "local control-plane health endpoint", parseControlPlaneHealthUrl)
  .option("--install-prefix <path>", "authoritative npm global prefix", parseAbsolutePath)
  .option("--node-agent-ipc-path <path>", "node-agent readiness socket", parseAbsolutePath)
  .option("--registry <url>", "npm registry URL")
  .option("--standalone", "complete the temporary job after service verification")
  .parse(process.argv)
  .opts();

const jobFile = options.jobFile;
const targetVersion = options.targetVersion;
const service = options.service;
const npmCommand = options.npmCommand;
const controlPlaneHealthUrl = options.controlPlaneHealthUrl;
const requestedInstallPrefix = options.installPrefix;
const nodeAgentIpcPath = options.nodeAgentIpcPath;
const registry = options.registry;
const terminalStatuses = new Set(["succeeded", "degraded", "failed"]);
const supportedPackages = new Set(["@task-handoff/node-agent", "@task-handoff/server"]);
const systemServerConfigurationFiles = [
  "/etc/task-handoff/control-plane.env",
  "/etc/task-handoff/node-agent.env",
  "/etc/systemd/system/task-handoff-control-plane.service",
  "/etc/systemd/system/task-handoff-node-agent.service",
];

function serverConfigurationFiles() {
  const testRoot = process.env.TASK_HANDOFF_UPDATE_WORKER_TEST_CONFIGURATION_ROOT;
  return testRoot
    ? systemServerConfigurationFiles.map((file) => path.join(testRoot, file.slice(1)))
    : systemServerConfigurationFiles;
}

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
  const args = ["view", `${packageName}@${targetVersion}`, "dist.integrity", "--json"];
  if (registry) args.push("--registry", registry);
  const result = spawnSync(npmCommand, args, { encoding: "utf8" });
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

async function waitForControlPlaneHealth(healthUrl, expectedVersion = targetVersion, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "not reachable";
  while (Date.now() < deadline) {
    try {
      if (process.env.TASK_HANDOFF_UPDATE_WORKER_TEST_HEALTH_FILE) {
        const payload = JSON.parse(fs.readFileSync(process.env.TASK_HANDOFF_UPDATE_WORKER_TEST_HEALTH_FILE, "utf8"));
        const version = controlPlanePackageVersion(payload);
        if (version === expectedVersion) return;
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
      if (response.ok && version === expectedVersion) return;
      lastFailure = response.ok ? `reported version ${String(version || "unknown")}` : `returned HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Control plane did not become healthy at ${healthUrl} with version ${expectedVersion}: ${lastFailure}.`);
}

function waitForSocket(socketPath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(socketPath).isSocket()) return;
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`Node agent socket was not ready after ${timeoutMs}ms: ${socketPath}`);
}

function installPackage(prefix, packageName, version) {
  const args = ["install", "--global", "--prefix", prefix, `${packageName}@${version}`];
  if (registry) args.push("--registry", registry);
  run(npmCommand, args);
}

function materializeServerServices(prefix) {
  run(path.join(prefix, "bin", "task-handoff"), ["install", "--preserve-current", "--materialize-only"]);
}

function snapshotFiles(files) {
  return files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return { file, contents: fs.readFileSync(file), mode: stat.mode };
    } catch (error) {
      if (error?.code === "ENOENT") return { file };
      throw error;
    }
  });
}

function restoreFiles(snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot.contents) {
      fs.mkdirSync(path.dirname(snapshot.file), { recursive: true });
      writeFileAtomic.sync(snapshot.file, snapshot.contents, { mode: snapshot.mode });
    } else {
      fs.rmSync(snapshot.file, { force: true });
    }
  }
}

async function main() {
  let releaseUpdateLock;
  let removeSignalCleanup;
  let rollback;
  try {
    const claimed = updateJob(["queued"], (current) => ({
      status: "updating-node",
      rollout: { ...current.rollout, phase: "updating-node" },
      startedAt: new Date().toISOString(),
      error: undefined,
    }));
    if (!claimed) return;
    releaseUpdateLock = acquireServerUpdateLock(process.env.TASK_HANDOFF_SERVER_UPDATE_LOCK_PATH || undefined);
    removeSignalCleanup = cleanUpServerUpdateLockOnSignals(releaseUpdateLock);
    const verifiedArtifact = verifyNpmArtifactIntegrity();
    const packageName = verifiedArtifact.packageName;
    // Compatibility for v0.0.18: install beside the worker that the service is
    // actually running, even when npm's ambient global prefix has changed.
    const ownedPrefix = globalPrefixFromModulePath(process.argv[1]);
    if (requestedInstallPrefix && ownedPrefix && requestedInstallPrefix !== ownedPrefix) {
      throw Object.assign(new Error(`Update prefix ${requestedInstallPrefix} does not match the running package prefix ${ownedPrefix}.`), {
        code: "UPDATE_INSTALL_PREFIX_MISMATCH",
      });
    }
    const prefixResult = ownedPrefix ? undefined : spawnSync(npmCommand, ["prefix", "--global"], { encoding: "utf8" });
    if (prefixResult && prefixResult.status !== 0) throw new Error("Could not determine the npm global prefix.");
    const prefix = requestedInstallPrefix || ownedPrefix || prefixResult?.stdout.trim();
    if (!prefix) throw new Error("Could not determine the npm global prefix.");
    const rootResult = spawnSync(npmCommand, ["root", "--global", "--prefix", prefix], { encoding: "utf8" });
    if (rootResult.status !== 0) throw new Error("Could not determine the npm global module root.");
    const globalRoot = rootResult.stdout.trim();
    const packageNames = [packageName];
    if (packageName === "@task-handoff/server" && installedVersion("@task-handoff/node-agent", globalRoot) !== undefined) {
      packageNames.push("@task-handoff/node-agent");
    }
    const previousVersions = new Map(packageNames.map((installedPackage) => [installedPackage, installedVersion(installedPackage, globalRoot)]));
    const serverConfiguration = packageName === "@task-handoff/server" ? snapshotFiles(serverConfigurationFiles()) : [];
    let serverConfigurationChanged = false;
    rollback = async () => {
      for (const installedPackage of [...packageNames].reverse()) {
        const previousVersion = previousVersions.get(installedPackage);
        if (previousVersion) installPackage(prefix, installedPackage, previousVersion);
      }
      if (packageName === "@task-handoff/server") {
        // Compatibility for v0.0.21: restore the captured service configuration
        // instead of invoking a rolled-back CLI that lacks --materialize-only.
        if (serverConfigurationChanged) {
          restoreFiles(serverConfiguration);
          run("systemctl", ["daemon-reload"]);
        }
        run("systemctl", ["restart", "task-handoff-control-plane.service"]);
        const previousServerVersion = previousVersions.get("@task-handoff/server");
        if (controlPlaneHealthUrl && previousServerVersion) await waitForControlPlaneHealth(controlPlaneHealthUrl, previousServerVersion);
      }
      run("systemctl", ["restart", service]);
      if (nodeAgentIpcPath) waitForSocket(nodeAgentIpcPath);
    };
    const expectedIntegrities = new Map([[packageName, verifiedArtifact.integrity]]);
    for (const companionPackage of packageNames.slice(1)) {
      expectedIntegrities.set(companionPackage, npmArtifactIntegrity(companionPackage));
    }
    for (const installedPackage of packageNames) {
      installPackage(prefix, installedPackage, targetVersion);
      if (npmArtifactIntegrity(installedPackage) !== expectedIntegrities.get(installedPackage)) {
        throw new Error(`${installedPackage} npm artifact integrity changed during installation.`);
      }
      verifyInstalledVersion(installedPackage, globalRoot);
    }
    if (packageName === "@task-handoff/server") {
      verifyServerDistributionVersions(globalRoot);
      if (!controlPlaneHealthUrl) throw new Error("A control-plane health URL is required for a complete server update.");
      serverConfigurationChanged = true;
      materializeServerServices(prefix);
      run("systemctl", ["restart", "task-handoff-control-plane.service"]);
      await waitForControlPlaneHealth(controlPlaneHealthUrl);
    }
    const handedOff = updateJob(["updating-node"], (current) => ({ status: "restarting-node", rollout: { ...current.rollout, phase: "restarting-node" } }));
    if (!handedOff) return;
    run("systemctl", ["restart", service]);
    if (nodeAgentIpcPath) waitForSocket(nodeAgentIpcPath);
    if (options.standalone) {
      updateJob(["restarting-node"], (current) => ({
        status: "succeeded",
        rollout: { ...current.rollout, phase: "succeeded", nodeVersion: targetVersion },
        completedAt: new Date().toISOString(),
      }));
    }
  } catch (error) {
    let rollbackError;
    if (rollback) {
      try {
        await rollback();
      } catch (caught) {
        rollbackError = caught;
      }
    }
    const message = [
      error instanceof Error ? error.message : String(error),
      rollbackError ? `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}` : undefined,
    ].filter(Boolean).join(" ");
    updateJob(["queued", "updating-node", "restarting-node"], (current) => ({
      status: "failed",
      rollout: { ...current.rollout, phase: "failed" },
      error: {
        code: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "NODE_UPDATE_FAILED",
        message,
        retryable: error && typeof error === "object" && "code" in error && error.code === "SERVER_UPDATE_ALREADY_RUNNING",
      },
      completedAt: new Date().toISOString(),
    }));
    console.error(error);
    process.exitCode = 1;
  } finally {
    removeSignalCleanup?.();
    releaseUpdateLock?.();
  }
}

void main();
