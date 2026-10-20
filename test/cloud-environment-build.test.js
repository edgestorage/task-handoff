const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const cloudEnvironmentModule = path.join(root, "shared", "cloud-environments.cjs");
const cloudEnvironmentBuildModule = path.join(root, "shared", "cloud-environment-build.cjs");
const bundledEnvironment = Object.freeze({
  TASK_HANDOFF_CLOUD_ENV: "production",
  TASK_HANDOFF_CLOUD_SERVICE_ORIGIN: "https://cloud.bundled.test",
  TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES: "bundled.test",
  TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES: "bundled.test",
  TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY: "0",
});

test("Rollup cloud builds inline the validated build environment", async () => {
  const { cloudEnvironmentBuildPlugin } = await import("../scripts/rollup-cloud-environment.mjs");
  const plugin = cloudEnvironmentBuildPlugin(bundledEnvironment);
  const transformed = plugin.transform("module.exports = Object.freeze({});", cloudEnvironmentBuildModule);
  assert.ok(transformed);
  const loaded = { exports: {} };
  Function("module", "exports", transformed.code)(loaded, loaded.exports);
  assert.deepEqual(loaded.exports, bundledEnvironment);
});

test("desktop builds materialize the cloud environment as a CJS constant", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-desktop-cloud-build-"));
  const output = path.join(directory, "desktop-cloud-environment.cjs");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TASK_HANDOFF_CLOUD_")));
  const result = spawnSync(process.execPath, ["scripts/prepare-cloud-environment.mjs", "--out", output], {
    cwd: root,
    encoding: "utf8",
    env: { ...environment, ...bundledEnvironment },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(require(output), bundledEnvironment);
    assert.match(fs.readFileSync(output, "utf8"), /^"use strict";\nmodule\.exports = Object\.freeze\(/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bundled cloud environments cannot be overridden by process settings", () => {
  const script = `
    const buildPath = ${JSON.stringify(cloudEnvironmentBuildModule)};
    require.cache[buildPath] = { id: buildPath, filename: buildPath, loaded: true, exports: ${JSON.stringify(bundledEnvironment)} };
    const { resolveCloudEnvironment } = require(${JSON.stringify(cloudEnvironmentModule)});
    const environment = resolveCloudEnvironment(undefined, undefined, {
      TASK_HANDOFF_CLOUD_ENV: "staging",
      TASK_HANDOFF_CLOUD_SERVICE_ORIGIN: "https://cloud.runtime.test",
      TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES: "runtime.test",
      TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES: "runtime.test"
    });
    process.stdout.write(JSON.stringify(environment));
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: "production",
    serviceOrigin: "https://cloud.bundled.test",
    coordinatorHostSuffixes: ["bundled.test"],
    relayHostSuffixes: ["bundled.test"],
    allowInsecureRelay: false,
  });
});
