import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function source(relativePath) {
  return fs.readFileSync(new URL(`../src/apps/control-plane/${relativePath}`, import.meta.url), "utf8");
}

test("the workbench registers desktop browser agent control for every ready instance", () => {
  const workbench = source("ControlPlaneWorkbench.vue");
  const bridge = fs.readFileSync(new URL("../src/lib/desktopBridge.ts", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../../../apps/desktop-shell/src/preload.cjs", import.meta.url), "utf8");

  assert.match(workbench, /ensureBrowserAgentControl\?: \(instanceId: string\)/);
  assert.match(workbench, /const browserAgentControlInstanceIds = computed\(\(\) => \[\.\.\.new Set\(sortedInstances\.value[\s\S]*?isInstanceAppReady\(instance\)[\s\S]*?\.sort\(\)\)/);
  assert.match(workbench, /watch\(browserAgentControlInstanceIds, \(instanceIds\) => \{[\s\S]*?for \(const instanceId of instanceIds\) registerBrowserAgentControl\(instanceId\);[\s\S]*?\{ immediate: true \}/);
  assert.doesNotMatch(workbench, /watch\(activeInstanceId,[\s\S]{0,400}?ensureBrowserAgentControl/);
  assert.match(bridge, /ensureBrowserAgentControl\?: \(instanceId: string\)/);
  assert.match(bridge, /export function ensureDesktopBrowserAgentControl\(instanceId: string\)/);
  assert.match(preload, /ensureBrowserAgentControl: \(instanceId\) => ipcRenderer\.invoke\("task-handoff:browser-agent-control-ensure", instanceId\)/);
});
