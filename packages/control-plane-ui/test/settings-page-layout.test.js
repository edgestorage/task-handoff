import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const settingsPages = [
  ["AppearanceSettingsSection.vue", "basic-settings-page"],
  ["ChatBridgeSettingsSection.vue", "chat-settings-page"],
  ["CloudConnectivitySettingsSection.vue", "cloud-connectivity-page"],
  ["EnvironmentTemplatesSettings.vue", "environment-template-page"],
  ["GitCredentialsSettingsSection.vue", "git-credentials-page"],
  ["ImageSettingsSection.vue", "image-settings-page"],
  ["MobileSessionsSettingsSection.vue", "mobile-sessions-page"],
  ["ModelSettingsSection.vue", "model-settings-page"],
  ["ProjectSettingsSection.vue", "project-settings-page"],
  ["UserAccessSettingsSection.vue", "user-access-settings"],
];

test("settings sections use one full-width content contract without a right-only gutter", () => {
  const layout = read("src/apps/control-plane/settings/SettingsPageLayout.css");
  const modal = read("src/apps/control-plane/settings/SettingsModal.vue");
  const triggerStyles = read("src/apps/control-plane/triggers/ControlPlaneTriggersView.css");

  assert.match(layout, /margin-inline: auto/);
  assert.match(layout, /width: min\(100%, var\(--settings-content-max-width, 1080px\)\)/);
  assert.doesNotMatch(layout, /padding-(?:left|right|inline)|inline-gutter/);
  assert.match(modal, /settings-section-scroll-content settings-content-page/);
  assert.match(modal, /<style src="\.\/SettingsPageLayout\.css"><\/style>/);
  assert.doesNotMatch(triggerStyles, /\.trigger-board\s*\{[^}]*padding/);

  for (const [file, pageClass] of settingsPages) {
    const component = read(`src/apps/control-plane/settings/${file}`);
    assert.match(component, new RegExp(`class="${pageClass} settings-content-page"`));
    assert.doesNotMatch(component, new RegExp(`\\.${pageClass}\\s*\\{[^}]*padding-right`));
  }
});
