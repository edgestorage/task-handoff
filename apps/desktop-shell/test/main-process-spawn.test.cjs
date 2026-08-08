const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { superviseDesktopChild } = require("../src/child-process.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("desktop passes its authoritative package version to both server child processes", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
  assert.equal((main.match(/buildDesktopChildProcessEnv\(process\.env,/g) || []).length, 2);
  assert.equal((main.match(/version: app\.getVersion\(\),/g) || []).length, 2);
});

test("desktop allocates ports for all local services and enables Local Runtime reallocation", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
  assert.match(main, /findAvailablePort\(controlPlaneHost, resolveControlPlanePort\(\), 20, "control-plane"\)/);
  assert.match(main, /TASK_HANDOFF_LOCAL_INSTANCE_PORT_CONFLICT: "allocate"/);
  assert.match(main, /TASK_HANDOFF_NODE_AGENT_PORT_CONFLICT: "allocate"/);
  assert.match(main, /nodeAgentHealth\?\.listener\?\.port/);
  assert.match(main, /startControlPlane\(\{ host: controlPlaneHost, port: controlPlanePort,/);
});

test("desktop owns a single Electron process and focuses it on repeated launches", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\("second-instance"/);
  assert.match(main, /mainWindow\.focus\(\)/);
});

test("desktop child supervision reports output, spawn failures, and exits", () => {
  const child = fakeChild();
  const info = [];
  const errors = [];
  const spawnErrors = [];
  const exits = [];
  assert.equal(superviseDesktopChild(child, {
    label: "node-agent",
    command: "/app/TaskHandoff",
    cwd: "/tmp/task-handoff",
    logInfo: (message) => info.push(message),
    logError: (message) => errors.push(message),
    onError: (error) => spawnErrors.push(error),
    onExit: (code, signal) => exits.push([code, signal]),
  }), child);

  child.stdout.emit("data", Buffer.from("ready\n"));
  child.stderr.emit("data", Buffer.from("warning\n"));
  const failure = new Error("ENOENT");
  child.emit("error", failure);
  child.emit("exit", 1, null);

  assert.deepEqual(info, ["[node-agent] ready"]);
  assert.deepEqual(spawnErrors, [failure]);
  assert.deepEqual(exits, [[1, null]]);
  assert.deepEqual(errors, [
    "[node-agent] warning",
    "[node-agent] failed to spawn command=/app/TaskHandoff cwd=/tmp/task-handoff: ENOENT",
    "[node-agent] exited code=1 signal=",
  ]);
});
