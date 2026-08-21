const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { stopSupervisedDesktopChild, superviseDesktopChild } = require("../src/child-process.cjs");

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
  assert.match(main, /app\.on\("second-instance"[\s\S]*desktopWindows\.open\(\)/);
});

test("desktop closes windows into tray-backed service mode", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
  assert.match(main, /createDesktopTray\(/);
  assert.match(main, /onActivateExisting: activateExistingDesktopWindows/);
  assert.match(main, /function activateExistingDesktopWindows\(\)[\s\S]*onEmpty: \(\) => desktopWindows\.open\(\)/);
  assert.match(main, /app\.on\("activate", \(\) => \{\s*activateExistingDesktopWindows\(\);/);
  assert.doesNotMatch(main, /app\.on\("activate", \(\) => \{\s*desktopWindows\.open\(\);/);
  assert.match(main, /onSettings: openDesktopSettings/);
  assert.match(main, /function openDesktopSettings\(\)[\s\S]*desktopWindows\.open\(\)[\s\S]*task-handoff:open-settings/);
  assert.match(main, /loadInstances: \(\) => loadDesktopInstanceDirectory\(/);
  assert.match(main, /function openDesktopInstance\(instanceId, source\)[\s\S]*createControlPlaneWindow\(`\/instance-detail\/\$\{encodeURIComponent\(instanceId\)\}`\)/);
  assert.match(main, /createDesktopDockMenu\([\s\S]*onOpen: \(\) => desktopWindows\.open\(\)[\s\S]*onOpenInstance: \(instanceId\) => openDesktopInstance\(instanceId, "dock menu"\)/);
  assert.match(main, /createDesktopTray\([\s\S]*onOpenInstance: \(instanceId\) => openDesktopInstance\(instanceId, "tray"\)/);
  assert.match(main, /onInstanceDirectoryChange: \(snapshot\) => desktopDockMenu\?\.update\(snapshot\)/);
  assert.match(main, /desktopWindows\?\.background\(\)/);
  assert.match(main, /Closing UI windows enters background service mode/);
  assert.doesNotMatch(main, /app\.on\("window-all-closed"[\s\S]{0,160}app\.quit\(\)/);
  assert.match(main, /desktopWindows\.open\(\)/);
  assert.match(main, /desktopServiceSupervisor\.markRunning\(url\)/);
});

test("desktop supervises its detached node-agent and awaits service shutdown", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
  assert.match(main, /detached: true/);
  assert.match(main, /bootNodeAgent\?\.unref\?\.\(\)/);
  assert.match(main, /app\.on\("before-quit", \(event\) =>/);
  assert.match(main, /event\.preventDefault\(\)/);
  assert.match(main, /desktopQuitCoordinator\.request\("quit"\)/);
  assert.match(main, /onStopping: \(\) => \{[\s\S]*?controlPlaneWindows\.closeAll\(\)/);
  assert.match(main, /install: prepareDesktopUpdateInstall/);
  assert.match(main, /async function stopNodeAgent\(\)[\s\S]*stopExistingDesktopNodeAgent/);
});

test("desktop rolls back failed children without coupling a healthy node-agent to Control Plane", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
  assert.match(main, /desktop services failed to start[\s\S]*desktopServiceLifecycle\.stop\("boot-failure", \{ nodeAgentReady \}\)/);
  assert.match(main, /if \(nodeAgentReady\)[\s\S]*bootNodeAgent\?\.unref\?\.\(\)/);
  assert.match(main, /inspectExistingDesktopControlPlane\(\)[\s\S]*ensureDesktopNodeAgent/);
});

test("desktop readiness uses health for availability and the singleton lease for ownership", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
  assert.match(main, /health\?\.role === "control-plane"/);
  assert.match(main, /health\?\.build\?\.component === "control-plane"/);
  assert.match(main, /inspectStartedDesktopControlPlane\(\{/);
  assert.doesNotMatch(main, /payload\?\.data\?\.dataDir/);
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

test("desktop child supervision supports detached children with file-backed stdio", () => {
  const child = new EventEmitter();
  child.stdout = null;
  child.stderr = null;
  assert.equal(superviseDesktopChild(child, {
    label: "node-agent",
    command: "/app/TaskHandoff",
    cwd: "/tmp/task-handoff",
    logInfo: () => undefined,
    logError: () => undefined,
  }), child);
});

test("desktop child termination confirms exit after force", async () => {
  const child = fakeChild();
  child.pid = 1234;
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") setImmediate(() => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    });
  };
  await stopSupervisedDesktopChild(child, { gracefulTimeoutMs: 0, forceTimeoutMs: 100 });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
