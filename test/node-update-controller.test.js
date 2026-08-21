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
