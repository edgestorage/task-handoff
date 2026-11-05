const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("runtime selection uses the repository default and rejects unknown implementations", async () => {
  const { resolveControlledInstanceImplementation, runtimePackages } = await import("../runtime-packages.config.mjs");
  assert.equal(resolveControlledInstanceImplementation({}), runtimePackages["controlled-instance"].implementation);
  for (const implementation of ["node", "rust"]) {
    assert.equal(resolveControlledInstanceImplementation({ TASK_HANDOFF_CONTROLLED_INSTANCE_IMPLEMENTATION: implementation }), implementation);
  }
  assert.throws(() => resolveControlledInstanceImplementation({ TASK_HANDOFF_CONTROLLED_INSTANCE_IMPLEMENTATION: "other" }), /must be rust or node/);
});

test("switching helper implementations removes the previous payload and preserves command arguments", async (t) => {
  const { prepareGitHelper, checkGitHelper } = await import("../scripts/runtime-git-helper.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-selected-helpers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dockerDir = path.join(root, "docker assets");
  const binariesDir = path.join(root, "binaries");
  const nodeHelper = path.join(root, "node.js");
  fs.mkdirSync(binariesDir);
  fs.mkdirSync(dockerDir);
  fs.writeFileSync(nodeHelper, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  fs.copyFileSync(path.join(__dirname, "../docker/js-runtime.sh"), path.join(dockerDir, "js-runtime.sh"));
  fs.chmodSync(path.join(dockerDir, "js-runtime.sh"), 0o755);
  for (const arch of ["x64", "arm64"]) {
    fs.writeFileSync(path.join(binariesDir, `controlled-instance-linux-${arch}`), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  }
  for (const implementation of ["node", "rust", "node"]) {
    prepareGitHelper({ implementation, dockerDir, binariesDir, nodeHelper });
    checkGitHelper(dockerDir, implementation);
    const result = spawnSync(path.join(dockerDir, "git-provisioning-helper"), ["credential", "get", "argument with spaces"], {
      encoding: "utf8",
      env: { ...process.env, TASK_HANDOFF_JS_RUNTIME_BIN: process.execPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, implementation === "node"
      ? JSON.stringify(["credential", "get", "argument with spaces"])
      : "git-provisioning-helper\ncredential\nget\nargument with spaces\n");
  }
  fs.copyFileSync(nodeHelper, path.join(dockerDir, "controlled-instance-linux-x64"));
  assert.throws(() => checkGitHelper(dockerDir, "node"), /unselected runtime payloads/);
});

test("Node helper packaging does not require any Rust binary directory", async (t) => {
  const { prepareGitHelper, checkGitHelper } = await import("../scripts/runtime-git-helper.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-node-only-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeHelper = path.join(root, "helper.js");
  fs.writeFileSync(nodeHelper, "process.exit(0);\n");
  const dockerDir = path.join(root, "docker");
  prepareGitHelper({ implementation: "node", dockerDir, nodeHelper });
  checkGitHelper(dockerDir, "node");
  assert.deepEqual(fs.readdirSync(dockerDir).sort(), ["git-provisioning-helper", "git-provisioning-helper.js"]);
});
