const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { resolveControlPlaneWindowUrl } = require("../src/config.cjs");

const preloadSource = fs.readFileSync(path.join(__dirname, "../src/preload.cjs"), "utf8");
const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");

test("control plane child windows are restricted to approved same-origin routes", () => {
  const baseUrl = "http://127.0.0.1:18081/dashboard";
  assert.equal(
    resolveControlPlaneWindowUrl("/repository-workspace?project=one", { baseUrl }).toString(),
    "http://127.0.0.1:18081/repository-workspace?project=one",
  );
  assert.equal(
    resolveControlPlaneWindowUrl("/instance-detail/instance%20one", { baseUrl }).toString(),
    "http://127.0.0.1:18081/instance-detail/instance%20one",
  );
  assert.throws(
    () => resolveControlPlaneWindowUrl("http://example.com/repository-workspace", { baseUrl }),
    /same-origin control plane/,
  );
  assert.throws(
    () => resolveControlPlaneWindowUrl("/settings", { baseUrl }),
    /approved control plane child window/,
  );
  assert.throws(() => resolveControlPlaneWindowUrl("/instance-detail/a/b", { baseUrl }), /approved control plane child window/);
  assert.throws(() => resolveControlPlaneWindowUrl("/instance-detail/a?other=b", { baseUrl }), /query parameters/);
  assert.throws(() => resolveControlPlaneWindowUrl("/instance-detail/a#other", { baseUrl }), /fragments/);
});

test("control plane child windows use the compact content-backed titlebar", () => {
  assert.match(mainSource, /function compactTitleBarWindowOptions\(\) \{[\s\S]*?height: 42,[\s\S]*?trafficLightPosition: \{ x: 16, y: 15 \}/);
  const createWindowSource = mainSource.match(/function createControlPlaneWindow\(url\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(createWindowSource, /createDesktopBrowserWindow\(\{[\s\S]*?\.\.\.compactTitleBarWindowOptions\(\)/);
  assert.match(createWindowSource, /\}, 42\)/);
  assert.match(mainSource, /function createDesktopBrowserWindow\([\s\S]*?webPreferences: desktopWindowWebPreferences\(\)[\s\S]*?openExternalWindowsOnly\(window\.webContents\)/);
  assert.match(createWindowSource, /minWidth: instanceId \? 400 : 760/);
  assert.match(createWindowSource, /const initialSize = instanceId[\s\S]*?desktopWindowPreferences\?\.instanceDetailSize\(\)/);
  assert.match(createWindowSource, /controlPlaneWindow\.on\("resize"[\s\S]*?setTimeout\(persistSize, 180\)/);
  assert.match(createWindowSource, /rememberInstanceDetailSize\(controlPlaneWindow\.getBounds\(\)\)/);
});

test("the main window and live theme changes keep the native surface aligned with the renderer", () => {
  const createWindowSource = mainSource.match(/function createWindow\(url\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(createWindowSource, /backgroundColor: desktopWindowBackgroundColor\("dark"\)/);
  assert.doesNotMatch(createWindowSource, /backgroundColor: "#eef3f4"/);
  assert.match(mainSource, /ipcMain\.handle\("task-handoff:set-window-chrome-theme"[\s\S]*?targetWindow\.setBackgroundColor\(desktopWindowBackgroundColor\(theme\)\)/);
});

test("desktop constrains manual titlebar dragging to the sender window", () => {
  assert.match(mainSource, /ipcMain\.on\("task-handoff:window-drag"/);
  assert.match(mainSource, /BrowserWindow\.fromWebContents\(event\.sender\)/);
  assert.match(mainSource, /windowDragStates\.set\(event\.sender/);
  assert.match(mainSource, /targetWindow\.setPosition\(/);
});

test("preload API delegates privileged desktop operations through IPC", async () => {
  const invocations = [];
  const sends = [];
  const listeners = new Map();
  let exposedApi;
  const ipcRenderer = {
    invoke: async (...args) => {
      invocations.push(args);
      return args;
    },
    send: (...args) => sends.push(args),
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
  await api.openLocalPath("/projects/task-handoff");
  await api.openControlPlaneWindow("/repository-workspace");
  await api.openInstanceDetailWindow("instance-a");
  await api.switchInstanceDetailWindow("instance-b");
  await api.getWindowAlwaysOnTop();
  await api.setWindowAlwaysOnTop(true);
  api.windowDrag("start", 120, 80);
  let settingsOpened = 0;
  const stopOpenSettings = api.onOpenSettings(() => { settingsOpened += 1; });
  listeners.get("task-handoff:open-settings")();
  assert.equal(settingsOpened, 1);
  stopOpenSettings();
  assert.equal(listeners.has("task-handoff:open-settings"), false);
  await api.setDiagnosticLogsEnabled(true);
  await api.desktopUpdates.check();
  await api.desktopUpdates.install();
  assert.deepEqual(invocations, [
    ["task-handoff:open-local-path", "/projects/task-handoff"],
    ["task-handoff:open-control-plane-window", "/repository-workspace"],
    ["task-handoff:open-instance-detail-window", "instance-a"],
    ["task-handoff:switch-instance-detail-window", "instance-b"],
    ["task-handoff:get-window-always-on-top"],
    ["task-handoff:set-window-always-on-top", true],
    ["task-handoff:set-diagnostic-logs-enabled", true],
    ["task-handoff:desktop-update-check"],
    ["task-handoff:desktop-update-install"],
  ]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], "task-handoff:window-drag");
  assert.equal(sends[0][1].phase, "start");
  assert.equal(sends[0][1].screenX, 120);
  assert.equal(sends[0][1].screenY, 80);

  let state;
  const unsubscribe = api.desktopUpdates.onStateChanged((next) => { state = next; });
  const channel = "task-handoff:desktop-update-state";
  listeners.get(channel)({}, { status: "ready" });
  assert.deepEqual(state, { status: "ready" });
  unsubscribe();
  assert.equal(listeners.has(channel), false);
});

test("desktop local-path opening is restricted to an existing absolute directory", () => {
  const handler = mainSource.match(/ipcMain\.handle\("task-handoff:open-local-path"[\s\S]*?\n\}\);/)?.[0] || "";
  assert.match(handler, /path\.isAbsolute\(normalized\)/);
  assert.match(handler, /fs\.statSync\(normalized\)\.isDirectory\(\)/);
  assert.match(handler, /shell\.openPath\(normalized\)/);
});

test("only registered instance detail windows can control their own always-on-top state", () => {
  assert.match(mainSource, /function senderInstanceDetailWindow\(event\)[\s\S]*?BrowserWindow\.fromWebContents\(event\.sender\)[\s\S]*?controlPlaneWindows\.metadata\(targetWindow\)\?\.kind === "instance-detail"/);
  assert.match(mainSource, /ipcMain\.handle\("task-handoff:get-window-always-on-top"[\s\S]*?targetWindow\.isAlwaysOnTop\(\)/);
  assert.match(mainSource, /ipcMain\.handle\("task-handoff:set-window-always-on-top"[\s\S]*?typeof enabled !== "boolean"[\s\S]*?targetWindow\.setAlwaysOnTop\(enabled\)[\s\S]*?targetWindow\.isAlwaysOnTop\(\)/);
});
