const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../../..");
const mainSource = fs.readFileSync(path.join(root, "apps/desktop-shell/src/main.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "apps/desktop-shell/src/preload.cjs"), "utf8");

test("Electron opens repository workspaces in a restricted same-origin control plane window", () => {
  assert.match(mainSource, /function resolveControlPlaneWindowUrl\(url\)/);
  assert.match(mainSource, /parsedUrl\.origin !== new URL\(base\)\.origin/);
  assert.match(mainSource, /parsedUrl\.pathname !== "\/repository-workspace"/);
  assert.match(mainSource, /function createControlPlaneWindow\(url\)[\s\S]*new BrowserWindow/);
  assert.match(mainSource, /controlPlaneWindows\.add\(controlPlaneWindow\)/);
  assert.match(mainSource, /controlPlaneWindow\.once\("closed", \(\) => controlPlaneWindows\.delete\(controlPlaneWindow\)\)/);
  assert.match(mainSource, /task-handoff:open-control-plane-window/);
  assert.match(preloadSource, /openControlPlaneWindow: \(url\) => ipcRenderer\.invoke\("task-handoff:open-control-plane-window", url\)/);
});
