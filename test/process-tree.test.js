const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
require("./workspace-require.js").registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
};

const { ManagedProcessTreeRegistry } = require("../packages/core/src/core/process-tree.ts");

function longRunningChild() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
}

test("requestStop resolves only after the tracked process tree exits", async () => {
  const child = longRunningChild();
  assert.ok(child.pid);
  const registry = new ManagedProcessTreeRegistry({ stopTimeoutMs: 5_000, killTimeoutMs: 1_000 });
  registry.track({ pid: child.pid, child, rootExited: false });
  child.once("exit", () => registry.markRootExited(child.pid));

  const stopped = await registry.requestStop(child.pid, "SIGTERM", child);

  assert.equal(stopped, true);
  assert.equal(registry.has(child.pid), false);
  assert.ok(child.exitCode !== null || child.signalCode !== null, "the child must have exited before requestStop resolved");
});

test("requestStop escalates to a forced kill after the stop deadline", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(child.pid);
  const registry = new ManagedProcessTreeRegistry({ stopTimeoutMs: 100, killTimeoutMs: 5_000 });
  registry.track({ pid: child.pid, child, rootExited: false });
  child.once("exit", () => registry.markRootExited(child.pid));

  const stopped = await registry.requestStop(child.pid, "SIGTERM", child);

  assert.equal(stopped, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
