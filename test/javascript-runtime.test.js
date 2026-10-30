const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const script = path.resolve(__dirname, "../docker/js-runtime.sh");
const runtimeModule = path.resolve(__dirname, "../packages/core/src/core/javascript-runtime.ts");
const {
  configuredJavaScriptRuntime,
  currentJavaScriptRuntime,
  javascriptRuntimeEnvironment,
  selectedJavaScriptRuntime,
} = require(runtimeModule);

function fakeRuntime(binDir, name) {
  fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\nprintf '%s\\n' "${name}:$*"\n`, { mode: 0o755 });
}

function run(env = {}, args = ["--version"]) {
  const childEnv = { ...process.env };
  delete childEnv.TASK_HANDOFF_JS_RUNTIME;
  delete childEnv.TASK_HANDOFF_JS_RUNTIME_BIN;
  return execFileSync(script, args, { encoding: "utf8", env: { ...childEnv, ...env } }).trim();
}

function sanitizedEnv() {
  const env = { ...process.env };
  delete env.TASK_HANDOFF_JS_RUNTIME;
  delete env.TASK_HANDOFF_JS_RUNTIME_BIN;
  return env;
}

function detectInRuntime(runtime, directory) {
  const probe = path.join(directory, `runtime-${path.basename(runtime)}.mjs`);
  fs.writeFileSync(probe, `
    import { selectedJavaScriptRuntime } from ${JSON.stringify(pathToFileURL(runtimeModule).href)};
    process.stdout.write(selectedJavaScriptRuntime());
  `);
  const result = spawnSync(runtime, [probe], { encoding: "utf8", env: sanitizedEnv() });
  assert.equal(result.status, 0, `${runtime}: ${result.stderr}`);
  return result.stdout.trim();
}

test("JavaScript runtime selection self-detects Node and Bun processes", () => {
  assert.equal(currentJavaScriptRuntime({}), "node");
  assert.equal(currentJavaScriptRuntime({ bun: "1.4.4" }), "bun");
  assert.equal(selectedJavaScriptRuntime({ env: {}, versions: {} }), "node");
  assert.equal(selectedJavaScriptRuntime({ env: {}, versions: { bun: "1.4.4" } }), "bun");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-runtime-probe-"));
  try {
    assert.equal(detectInRuntime(process.execPath, directory), "node");
    if (process.env.TASK_HANDOFF_TEST_BUN_BIN) {
      assert.equal(detectInRuntime(process.env.TASK_HANDOFF_TEST_BUN_BIN, directory), "bun");
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("JavaScript runtime environment is only an explicit override", () => {
  assert.equal(configuredJavaScriptRuntime({}), undefined);
  assert.equal(configuredJavaScriptRuntime({ TASK_HANDOFF_JS_RUNTIME: "auto" }), undefined);
  assert.equal(configuredJavaScriptRuntime({ TASK_HANDOFF_JS_RUNTIME: "bun" }), "bun");
  assert.deepEqual(javascriptRuntimeEnvironment({}), {});
  assert.deepEqual(javascriptRuntimeEnvironment({ TASK_HANDOFF_JS_RUNTIME: "auto" }), {});
  assert.deepEqual(javascriptRuntimeEnvironment({ TASK_HANDOFF_JS_RUNTIME: "bun" }), {
    TASK_HANDOFF_JS_RUNTIME: "bun",
  });
  assert.throws(
    () => configuredJavaScriptRuntime({ TASK_HANDOFF_JS_RUNTIME: "deno" }),
    /must be auto, node, or bun/,
  );
});

test("JavaScript runtime helper self-detects when no override is configured", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-js-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const both = path.join(root, "both");
  const bunOnly = path.join(root, "bun-only");
  fs.mkdirSync(both);
  fs.mkdirSync(bunOnly);
  fakeRuntime(both, "node");
  fakeRuntime(both, "bun");
  fakeRuntime(bunOnly, "bun");

  assert.equal(run({ PATH: both }), "node:--version");
  assert.equal(run({ PATH: bunOnly }), "bun:--version");
  assert.equal(run({ PATH: both, TASK_HANDOFF_JS_RUNTIME: "auto" }), "node:--version");
  assert.equal(run({ PATH: bunOnly, TASK_HANDOFF_JS_RUNTIME: "auto" }), "bun:--version");
});

test("JavaScript runtime selection supports explicit Bun and executable override", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-js-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fakeRuntime(root, "node");
  fakeRuntime(root, "bun");
  fakeRuntime(root, "custom-runtime");

  assert.equal(run({ PATH: root, TASK_HANDOFF_JS_RUNTIME: "bun" }, ["one", "two"]), "bun:one two");
  assert.equal(run({ PATH: root, TASK_HANDOFF_JS_RUNTIME: "node", TASK_HANDOFF_JS_RUNTIME_BIN: path.join(root, "custom-runtime") }), "custom-runtime:--version");
});

test("JavaScript runtime selection rejects unsupported or unavailable runtimes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-js-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => run({ PATH: root, TASK_HANDOFF_JS_RUNTIME: "deno" }), /must be auto, node, or bun/);
  assert.throws(() => run({ PATH: root, TASK_HANDOFF_JS_RUNTIME: "bun" }), /not available/);
});
