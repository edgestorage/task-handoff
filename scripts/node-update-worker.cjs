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

function updateJob(patch) {
  const current = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeFileAtomic.sync(jobFile, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
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

try {
  updateJob({ status: "updating", startedAt: new Date().toISOString(), error: undefined });
  const prefixResult = spawnSync(npmCommand, ["prefix", "--global"], { encoding: "utf8" });
  if (prefixResult.status !== 0) throw new Error("Could not determine the npm global prefix.");
  const prefix = prefixResult.stdout.trim();
  const taskHandoff = path.join(prefix, "bin", "task-handoff");
  const serverPackage = path.join(prefix, "lib", "node_modules", "@task-handoff", "server", "package.json");
  if (fs.existsSync(taskHandoff) && fs.existsSync(serverPackage)) {
    run(taskHandoff, ["update", "--to", targetVersion]);
  } else {
    run(npmCommand, [
      "install",
      "--global",
      "--prefix",
      prefix,
      `@task-handoff/node-agent@${targetVersion}`,
      `@task-handoff/controlled-instance@${targetVersion}`,
    ]);
    updateJob({ status: "restarting" });
    run("systemctl", ["restart", service]);
  }
  verifyInstalledVersion();
  updateJob({ status: "succeeded", completedAt: new Date().toISOString() });
} catch (error) {
  updateJob({ status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
  console.error(error);
  process.exit(1);
}
