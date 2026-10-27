const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

test("test runtime strips inherited live instance state but preserves explicit test controls", () => {
  const setupPath = path.join(__dirname, "setup-isolated-runtime.mjs");
  const result = spawnSync(process.execPath, [
    "--import",
    setupPath,
    "--input-type=module",
    "--eval",
    `process.stdout.write(JSON.stringify({
      instanceId: process.env.TASK_HANDOFF_INSTANCE_ID ?? null,
      gitSocket: process.env.TASK_HANDOFF_GIT_CREDENTIAL_SOCKET ?? null,
      cloudEnvironment: process.env.TASK_HANDOFF_CLOUD_ENV ?? null,
      dataDir: process.env.TASK_HANDOFF_DATA_DIR,
      postgresUrl: process.env.TASK_HANDOFF_TEST_POSTGRES_URL,
      imageProfile: process.env.TASK_HANDOFF_IMAGE_PROFILE
    }))`,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      TASK_HANDOFF_INSTANCE_ID: "inst_live",
      TASK_HANDOFF_GIT_CREDENTIAL_SOCKET: "/private/tmp/live-instance/broker.sock",
      TASK_HANDOFF_CLOUD_ENV: "production",
      TASK_HANDOFF_TEST_POSTGRES_URL: "postgres://test.invalid/task-handoff",
      TASK_HANDOFF_IMAGE_PROFILE: "codex",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const isolated = JSON.parse(result.stdout);
  assert.equal(isolated.instanceId, null);
  assert.equal(isolated.gitSocket, null);
  assert.equal(isolated.cloudEnvironment, null);
  assert.match(isolated.dataDir, /task-handoff-test-runtime-/);
  assert.equal(isolated.postgresUrl, "postgres://test.invalid/task-handoff");
  assert.equal(isolated.imageProfile, "codex");
});
