const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { resolveControlPlaneWindowUrl } = require("../src/config.cjs");

const preloadSource = fs.readFileSync(path.join(__dirname, "../src/preload.cjs"), "utf8");

test("repository workspace windows are restricted to the control plane origin and route", () => {
  const baseUrl = "http://127.0.0.1:18081/dashboard";
  assert.equal(
    resolveControlPlaneWindowUrl("/repository-workspace?project=one", { baseUrl }).toString(),
    "http://127.0.0.1:18081/repository-workspace?project=one",
  );
  assert.throws(
    () => resolveControlPlaneWindowUrl("http://example.com/repository-workspace", { baseUrl }),
    /same-origin repository workspace/,
  );
  assert.throws(
    () => resolveControlPlaneWindowUrl("/settings", { baseUrl }),
    /same-origin repository workspace/,
  );
});

test("preload API delegates privileged desktop operations through IPC", async () => {
  const invocations = [];
  const listeners = new Map();
  let exposedApi;
  const ipcRenderer = {
    invoke: async (...args) => {
      invocations.push(args);
      return args;
    },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, value) => {
        assert.equal(name, "taskHandoffDesktop");
        exposedApi = value;
      },
    },
    ipcRenderer,
    webUtils: { getPathForFile: (file) => `/files/${file.name}` },
  };
  vm.runInNewContext(preloadSource, {
    process: { platform: "darwin" },
    require: (specifier) => {
      assert.equal(specifier, "electron", "sandbox preload must only load Electron's supported module");
      return electron;
    },
  });
  const api = exposedApi;

  assert.equal(api.windowChrome.mode, "macos-overlay");
  assert.equal(api.getPathForFile({ name: "project" }), "/files/project");
  await api.openControlPlaneWindow("/repository-workspace");
  await api.setDiagnosticLogsEnabled(true);
  await api.desktopUpdates.check();
  await api.desktopUpdates.install();
  assert.deepEqual(invocations, [
    ["task-handoff:open-control-plane-window", "/repository-workspace"],
    ["task-handoff:set-diagnostic-logs-enabled", true],
    ["task-handoff:desktop-update-check"],
    ["task-handoff:desktop-update-install"],
  ]);

  let state;
  const unsubscribe = api.desktopUpdates.onStateChanged((next) => { state = next; });
  const channel = "task-handoff:desktop-update-state";
  listeners.get(channel)({}, { status: "ready" });
  assert.deepEqual(state, { status: "ready" });
  unsubscribe();
  assert.equal(listeners.has(channel), false);
});
