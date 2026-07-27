#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Command, InvalidArgumentError } = require("commander");
const semver = require("semver");
const writeFileAtomic = require("write-file-atomic");

function parseExactVersion(value) {
  if (value.trim() !== value || /^[v=]/.test(value) || semver.valid(value) === null) throw new InvalidArgumentError("must be an exact semantic version");
  return value;
}

const options = new Command()
  .name("task-handoff-node-update-worker")
  .description("Apply a detached TaskHandoff node update.")
  .requiredOption("--job-file <path>", "persisted update job file")
  .requiredOption("--target-version <version>", "exact semantic version", parseExactVersion)
  .option("--service <name>", "systemd service to restart", "task-handoff-node-agent.service")
  .option("--npm-command <path>", "npm executable", process.env.TASK_HANDOFF_NPM_COMMAND || "npm")
  .parse(process.argv)
  .opts();

const jobFile = options.jobFile;
const targetVersion = options.targetVersion;
const service = options.service;
const npmCommand = options.npmCommand;
const nodeAgentManifest = path.resolve(__dirname, "..", "package.json");
const terminalStatuses = new Set(["succeeded", "degraded", "failed"]);

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

function verifyInstalledVersion() {
  const installedVersion = JSON.parse(fs.readFileSync(nodeAgentManifest, "utf8")).version;
  if (installedVersion !== targetVersion) {
    throw new Error(`Updated node-agent verification failed: expected ${targetVersion}, found ${installedVersion || "unknown"}.`);
  }
}

function verifyNpmArtifactIntegrity() {
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const prefix = `npm:@task-handoff/node-agent@${targetVersion}#`;
  if (typeof job.artifactRef !== "string" || !job.artifactRef.startsWith(prefix) || job.artifactRef.length === prefix.length) {
    throw new Error(`Update job does not pin npm integrity for @task-handoff/node-agent@${targetVersion}.`);
  }
  const expectedIntegrity = job.artifactRef.slice(prefix.length);
  const result = spawnSync(npmCommand, ["view", `@task-handoff/node-agent@${targetVersion}`, "dist.integrity", "--json"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Could not verify the node-agent npm artifact integrity.");
  let actualIntegrity;
  try {
    actualIntegrity = JSON.parse(result.stdout);
  } catch {
    throw new Error("npm returned invalid node-agent artifact integrity metadata.");
  }
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error(`Node-agent npm artifact integrity mismatch: expected ${expectedIntegrity}, found ${String(actualIntegrity || "unknown")}.`);
  }
}

let restartAttempted = false;

try {
  const claimed = updateJob(["queued"], (current) => ({
    status: "updating-node",
    rollout: { ...current.rollout, phase: "updating-node" },
    startedAt: new Date().toISOString(),
    error: undefined,
  }));
  if (!claimed) process.exit(0);
  verifyNpmArtifactIntegrity();
  const prefixResult = spawnSync(npmCommand, ["prefix", "--global"], { encoding: "utf8" });
  if (prefixResult.status !== 0) throw new Error("Could not determine the npm global prefix.");
  const prefix = prefixResult.stdout.trim();
  run(npmCommand, [
    "install",
    "--global",
    "--prefix",
    prefix,
    `@task-handoff/node-agent@${targetVersion}`,
  ]);
  const handedOff = updateJob(["updating-node"], (current) => ({ status: "restarting-node", rollout: { ...current.rollout, phase: "restarting-node" } }));
  if (!handedOff) process.exit(0);
  // Once restart is attempted, the new node-agent exclusively owns all later
  // rollout transitions. The old worker must never write this job again.
  restartAttempted = true;
  run("systemctl", ["restart", service]);
  verifyInstalledVersion();
} catch (error) {
  if (!restartAttempted) {
    updateJob(["queued", "updating-node"], (current) => ({
      status: "failed",
      rollout: { ...current.rollout, phase: "failed" },
      error: { code: "NODE_UPDATE_FAILED", message: error instanceof Error ? error.message : String(error), retryable: false },
      completedAt: new Date().toISOString(),
    }));
  }
  console.error(error);
  process.exit(1);
}
