import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("instance settings is one top-level dialog with three independent entry points", () => {
  const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
  const list = read("src/apps/control-plane/instance-list/InstanceList.vue");
  const detail = read("src/apps/control-plane/instance-detail/InstanceDetail.vue");
  const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
  const nodeDetail = read("src/apps/control-plane/settings/NodeDetailPanel.vue");

  assert.match(workbench, /<InstanceSettingsDialog/);
  assert.match(workbench, /v-model:open="instanceSettingsOpen"/);
  assert.match(workbench, /@open-instance-settings="openInstanceSettings"/);
  assert.match(list, /\$emit\('openSettings', instance\.id\)/);
  assert.match(detail, /\$emit\('openSettings', instance\.id\)/);
  assert.match(settings, /openInstanceSettings: \[instanceId: string\]/);
  assert.match(nodeDetail, /actions\.openInstanceSettings\(instance\.id\)/);
});

test("the instance App menu opens settings directly on app management", () => {
  const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
  const detail = read("src/apps/control-plane/instance-detail/InstanceDetail.vue");
  const preview = read("src/apps/control-plane/instance-detail/SessionPreview.vue");
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");

  assert.match(preview, /Manage apps/);
  assert.match(preview, /\$emit\('openSettings', instance\.id, 'apps'\)/);
  assert.match(detail, /\$emit\('openSettings', instanceId, section\)/);
  assert.match(workbench, /:initial-section="instanceSettingsSection"/);
  assert.match(workbench, /function openInstanceSettings\(instanceId: string, section: "general" \| "models" \| "apps" = "general"\)/);
  assert.match(dialog, /section\.value = props\.initialSection \|\| "general"/);
});

test("instance model controls live only in the settings dialog", () => {
  const detail = read("src/apps/control-plane/instance-detail/InstanceDetail.vue");
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
  assert.doesNotMatch(detail, /Codex model|Claude model|updateInstanceModels|detail-model-selectors/);
  assert.match(dialog, /Global default/);
  assert.match(dialog, /No model/);
  assert.ok(dialog.indexOf(">No model<") < dialog.indexOf(">Global default<"));
  assert.match(dialog, /Unavailable/);
  assert.match(dialog, /next start or restart/);
  assert.doesNotMatch(dialog, /keyPreview|\.key\b|API key/);
});

test("instance settings exposes general, models, apps, and inventory freshness states", () => {
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
  for (const section of ["general", "models", "apps"]) assert.match(dialog, new RegExp(`value=\\"${section}\\"`));
  for (const state of ["current", "stale", "not-reported", "empty", "degraded"]) assert.match(dialog, new RegExp(state));
  assert.match(dialog, /aria-label="Instance settings sections"/);
  assert.match(dialog, /DialogContent/);
  assert.match(dialog, /ScrollArea/);
});

test("instance settings keeps a stable height within the viewport", () => {
  const dialog = read("src/apps/control-plane/instance-settings/InstanceSettingsDialog.vue");
  assert.match(dialog, /height: 680px;/);
  assert.match(dialog, /max-height: calc\(100vh - 36px\);/);
  assert.match(dialog, /\.instance-settings-scroll\s*\{[^}]*height: 100%;/s);
});
