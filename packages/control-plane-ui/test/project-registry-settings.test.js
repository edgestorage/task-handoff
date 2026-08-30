import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const section = read("src/apps/control-plane/settings/ProjectSettingsSection.vue");
const settings = read("src/apps/control-plane/settings/SettingsModal.vue");
const projectSettings = read("src/apps/control-plane/settings/useProjectSettings.ts");

test("project settings reuse the compact directory and portal overlay patterns", () => {
  assert.match(settings, /<ProjectSettingsSection[^>]*:can-manage-secrets="canManageSecrets"/);
  assert.match(section, /class="project-toolbar"/);
  assert.match(section, /<PopoverContent[^>]*--reka-popover-content-available-width/);
  assert.match(section, /<ScrollArea v-if="projectReferences/);
  assert.match(section, /:collision-padding="10"/);
  assert.match(section, /<DialogContent class="project-editor-dialog/);
  assert.match(section, /<AlertDialog :open="Boolean\(deleteTarget\)"/);
  assert.doesNotMatch(settings, /class="project-management-grid"/);
  assert.doesNotMatch(projectSettings, /window\.confirm/);
});

test("project mutations use the global toast and preserve authoritative project refresh", () => {
  assert.match(projectSettings, /showControlPlaneToast\(t\("settings\.projectRegistry\.created"[^;]*"success"\)/s);
  assert.match(projectSettings, /showControlPlaneToast\(t\("settings\.projectRegistry\.deleted"[^;]*"success"\)/s);
  assert.match(projectSettings, /showControlPlaneToast\(t\("settings\.projectRegistry\.credentialUpdated"\), "success"\)/);
  assert.match(projectSettings, /await refreshProjects\(\)/);
  assert.doesNotMatch(projectSettings, /settingsProjectSuccess/);
});

test("project directory typography follows shared menu density", () => {
  assert.match(section, /\.project-directory-head strong[^}]*font-size: 13px[^}]*font-weight: 500/s);
  assert.match(section, /\.project-summary-popover-row strong[^}]*font-size: 12px[^}]*font-weight: 500/s);
  assert.doesNotMatch(section, /font-size:\s*(?:10|11)px/);
});
