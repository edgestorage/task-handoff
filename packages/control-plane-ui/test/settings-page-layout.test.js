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
  assert.match(layout, /\.control-settings-page > \.settings-page-scroll \{[^}]*width: calc\(100% \+ var\(--settings-scrollbar-outset, 16px\)\);[^}]*margin-right: calc\(-1 \* var\(--settings-scrollbar-outset, 16px\)\);/);
  assert.match(layout, /\.settings-page-scroll > \[data-task-handoff-scroll-viewport\] \{[^}]*width: calc\(100% - var\(--settings-scrollbar-outset, 16px\)\);/);
  assert.match(modal, /class="settings-section-scroll settings-page-scroll"/);
  assert.match(modal, /settings-section-scroll-content settings-content-page/);
  assert.match(modal, /<style src="\.\/SettingsPageLayout\.css"><\/style>/);
  assert.doesNotMatch(triggerStyles, /\.trigger-board\s*\{[^}]*padding/);

  for (const [file, pageClass] of settingsPages) {
    const component = read(`src/apps/control-plane/settings/${file}`);
    assert.match(component, /<ScrollArea class="[^"]*settings-page-scroll[^"]*"/);
    assert.match(component, new RegExp(`class="${pageClass} settings-content-page"`));
    assert.doesNotMatch(component, new RegExp(`\\.${pageClass}\\s*\\{[^}]*padding-right`));
  }
});

test("settings content reaches the bottom edge and fades beneath the section tabs", () => {
  const layout = read("src/apps/control-plane/settings/SettingsPageLayout.css");
  const modal = read("src/apps/control-plane/settings/SettingsModal.vue");

  assert.match(modal, /--settings-top-fade-height: 18px/);
  assert.match(modal, /gap: 0/);
  assert.match(modal, /padding: 18px 18px 0/);
  assert.match(modal, /padding: 12px 12px 0/);
  assert.match(layout, /padding-top: var\(--settings-top-fade-height, 18px\)/);
  assert.match(layout, /mask-image: linear-gradient\(\s*to bottom,\s*transparent,\s*#000 var\(--settings-top-fade-height, 18px\)\s*\)/);
});

test("settings navigation replaces overflowing tabs with the current-section menu", () => {
  const modal = read("src/apps/control-plane/settings/SettingsModal.vue");
  const radioItem = read("src/components/ui/dropdown-menu/DropdownMenuRadioItem.vue");

  assert.match(modal, /tabs\.offsetWidth > availableWidth/);
  assert.match(modal, /new ResizeObserver\(syncSettingsNavigationLayout\)/);
  assert.match(modal, /v-show="!compactSettingsNavigation"/);
  assert.match(modal, /<DropdownMenu v-if="compactSettingsNavigation">/);
  assert.match(modal, /\{\{ currentSettingsSectionLabel \}\}/);
  assert.match(modal, /<DropdownMenuRadioItem v-for="item in settingsSections"/);
  assert.match(modal, /class="control-settings-section-menu-scroll"/);
  assert.match(modal, /var\(--reka-dropdown-menu-content-available-height\)/);
  assert.match(radioItem, /<Circle class="h-2 w-2 fill-current" \/>/);
});
