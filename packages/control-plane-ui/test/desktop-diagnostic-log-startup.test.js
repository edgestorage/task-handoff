import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function source(path) {
  return fs.readFileSync(new URL(`../src/apps/control-plane/${path}`, import.meta.url), "utf8");
}

test("desktop diagnostic logging follows persisted settings before the settings panel opens", () => {
  const workbench = source("ControlPlaneWorkbench.vue");
  const settings = source("settings/SettingsModal.vue");
  assert.match(workbench, /useControlPlaneSettingsQuery\(\)/);
  assert.match(workbench, /controlPlaneSettings\.data\.value\?\.diagnosticLogs[\s\S]*?setDiagnosticLogsEnabled\?\.\(enabled\)[\s\S]*?\{\s*immediate:\s*true\s*\}/);
  assert.doesNotMatch(settings, /setDiagnosticLogsEnabled/);
});
