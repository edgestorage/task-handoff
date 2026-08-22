const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { NodeUpdateController } = require("../packages/control-plane/src/node-agent/node-update-controller.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { NodeUpdateJobs } = require("../packages/control-plane/src/node-agent/updates.ts");

test("node update launch failure persists a terminal failed job", async () => {
  const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "node-update-launch-failure-"));
  const integrity = `sha512-${Buffer.from("node-update-launch-failure").toString("base64")}`;
  const paths = nodeAgentStorePaths(path.join(globalRoot, "node-agent"));
  const jobs = new NodeUpdateJobs(paths);
  jobs.init();
  const controller = new NodeUpdateController({
    nodeId: "node_update_failure",
    jobs,
    moduleDir: path.join(__dirname, "../packages/control-plane/src/node-agent"),
    currentRuntimeVersion: () => "1.0.0",
    listInstances: () => [],
    resolveRuntimeArtifacts: async () => [],
    managedUpdateSupport: () => ({ supported: true }),
    runCommand: async (command, args) => {
      if (command === "systemd-run") throw new Error("systemd is unavailable");
      assert.equal(command, "npm");
      if (args[0] === "root") return { stdout: globalRoot, stderr: "" };
      if (args[0] === "prefix") return { stdout: globalRoot, stderr: "" };
      if (args.includes("dist.integrity")) return { stdout: JSON.stringify(integrity), stderr: "" };
      return { stdout: JSON.stringify("9.8.7"), stderr: "" };
    },
  });

  const check = await controller.check({ channel: "stable" });
  await assert.rejects(
    controller.apply({
      channel: "stable",
      targetVersion: check.availableVersion,
      preflightToken: check.preflightToken,
    }),
    (error) => error.code === "NODE_UPDATE_WORKER_LAUNCH_FAILED",
  );

  const reloadedJobs = new NodeUpdateJobs(paths);
  reloadedJobs.init();
  const [stored] = reloadedJobs.list();
  assert.equal(stored.status, "failed");
  assert.equal(stored.rollout.phase, "failed");
  assert.equal(stored.error.code, "NODE_UPDATE_FAILED");
  assert.equal(stored.error.retryable, true);
  assert.ok(stored.completedAt);
});

test("node update systemd handoff fails when the worker never claims the queued job", async () => {
  const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "node-update-unclaimed-"));
  const integrity = `sha512-${Buffer.from("node-update-unclaimed").toString("base64")}`;
  const paths = nodeAgentStorePaths(path.join(globalRoot, "node-agent"));
  const jobs = new NodeUpdateJobs(paths);
  jobs.init();
  const controller = new NodeUpdateController({
    nodeId: "node_update_unclaimed",
    jobs,
    moduleDir: path.join(__dirname, "../packages/control-plane/src/node-agent"),
    currentRuntimeVersion: () => "1.0.0",
    listInstances: () => [],
    resolveRuntimeArtifacts: async () => [],
    managedUpdateSupport: () => ({ supported: true }),
    workerClaimTimeoutMs: 10,
    workerClaimPollMs: 1,
    runCommand: async (command, args) => {
      if (command === "systemd-run") return { stdout: "", stderr: "" };
      assert.equal(command, "npm");
      if (args[0] === "root") return { stdout: globalRoot, stderr: "" };
      if (args[0] === "prefix") return { stdout: globalRoot, stderr: "" };
      if (args.includes("dist.integrity")) return { stdout: JSON.stringify(integrity), stderr: "" };
      return { stdout: JSON.stringify("9.8.7"), stderr: "" };
    },
  });

  const check = await controller.check({ channel: "stable" });
  await assert.rejects(
    controller.apply({
      channel: "stable",
      targetVersion: check.availableVersion,
      preflightToken: check.preflightToken,
    }),
    (error) => error.code === "NODE_UPDATE_WORKER_START_TIMEOUT",
  );

  const [stored] = jobs.list();
  assert.equal(stored.status, "failed");
  assert.equal(stored.rollout.phase, "failed");
  assert.equal(stored.error.code, "NODE_UPDATE_FAILED");
  assert.match(stored.error.message, /did not claim/);
  assert.equal(stored.error.retryable, true);
  assert.ok(stored.completedAt);
});

test("node agent startup fails an update job left queued by an unclaimed worker", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-update-recover-queued-"));
  const jobs = new NodeUpdateJobs(nodeAgentStorePaths(dataDir));
  jobs.init();
  const timestamp = new Date().toISOString();
  jobs.records.put({
    id: "update_unclaimed_restart",
    nodeId: "node_update_restart",
    source: "npm",
    channel: "stable",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    artifactRef: `npm:@task-handoff/server@1.1.0#sha512-${Buffer.from("restart").toString("base64")}`,
    runtimeArtifacts: [],
    impact: {
      runningInstanceCount: 0,
      stoppedInstanceCount: 0,
      activeInstanceCount: 0,
      restartInstanceCount: 0,
      runningInstanceIds: [],
      stoppedInstanceIds: [],
      activeInstanceIds: [],
    },
    status: "queued",
    rollout: {
      phase: "queued",
      desiredVersion: "1.1.0",
      expectedInstanceIds: [],
      expectedInstanceCount: 0,
      matchedInstanceCount: 0,
      pendingInstanceCount: 0,
      failedInstanceCount: 0,
      deferredInstanceCount: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  jobs.reconcileRollouts([], "1.0.0", { processStarted: true });

  const stored = jobs.records.get("update_unclaimed_restart");
  assert.equal(stored.status, "failed");
  assert.equal(stored.rollout.phase, "failed");
  assert.equal(stored.error.code, "NODE_UPDATE_FAILED");
  assert.match(stored.error.message, /restarted before the update worker claimed/);
  assert.equal(stored.error.retryable, true);
});
