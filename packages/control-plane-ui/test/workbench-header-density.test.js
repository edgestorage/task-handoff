import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = async (path) => fs.readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("the shared workbench layout menu controls the persisted header density", async () => {
  const [workbench, styles, menu, preferences, english, chinese] = await Promise.all([
    source("apps/control-plane/ControlPlaneWorkbench.vue"),
    source("apps/control-plane/ControlPlaneWorkbench.css"),
    source("apps/control-plane/shared/WorkbenchLayoutContextMenu.vue"),
    source("apps/control-plane/useWorkbenchLayoutPreferences.ts"),
    source("i18n/locales/en-US/sessions.ts"),
    source("i18n/locales/zh-CN/sessions.ts"),
  ]);

  assert.match(workbench, /:data-header-density="effectiveHeaderDensity"/);
  assert.match(workbench, /<StoryView[\s\S]*?:header-density="effectiveHeaderDensity"/);
  assert.match(workbench, /:show-header-density="headerDensitySupported"/);
  assert.match(workbench, /windowChrome\?: \{ mode: "custom" \| "macos-overlay" \| "windows-overlay"; supportsDensity\?: boolean \}/);
  assert.match(workbench, /const effectiveHeaderDensity = computed\(\(\) => headerDensitySupported \? headerDensity\.value : "normal"\)/);
  assert.match(workbench, /watch\(effectiveHeaderDensity,[\s\S]*?setWindowChromeDensity\?\.\(density\)[\s\S]*?immediate: true/);
  assert.doesNotMatch(workbench, /control-plane-brand-logo/);
  assert.doesNotMatch(styles, /control-plane-brand-logo|task-handoff-logo/);
  assert.match(workbench, /<ContextMenuTrigger as-child :disabled="standaloneMode">[\s\S]*?<header[\s\S]*?class="control-plane-topbar"/);
  assert.match(workbench, /<WorkbenchLayoutContextMenu[\s\S]*?:show-instance-sidebar="instanceViewMode && !settingsMode"/);
  assert.match(menu, /<ContextMenuRadioGroup v-if="showHeaderDensity" :model-value="headerDensity"/);
  assert.match(menu, /value="compact"/);
  assert.match(menu, /value="normal"/);
  assert.match(menu, /\.instance-action-menu\.workbench-layout-context-menu \.instance-action-item\.workbench-layout-menu-choice[\s\S]*?padding: 0 8px 0 30px;/);
  assert.match(menu, /\.workbench-layout-menu-choice > span:first-child svg\s*\{\s*width: 8px;\s*height: 8px;/);
  assert.match(preferences, /HEADER_DENSITY_STORAGE_KEY = "task-handoff\.control-plane\.header-density"/);
  assert.match(preferences, /shallowRef<HeaderDensity>\("compact"\)/);
  assert.match(preferences, /localStorage\?\.setItem\(HEADER_DENSITY_STORAGE_KEY, value\)/);
  assert.match(styles, /--control-plane-titlebar-height: 44px;/);
  assert.match(styles, /\.control-plane-instance-switcher\s*\{[\s\S]*?height: 27px;/);
  assert.match(styles, /\.control-plane-shell\[data-header-density="normal"\]\s*\{\s*--control-plane-titlebar-height: 56px;/);
  assert.match(styles, /\.control-plane-shell\.standalone-instance-detail\s*\{\s*--control-plane-titlebar-height: 42px;/);
  assert.match(styles, /\[data-header-density="compact"\] \.control-plane-title\s*\{\s*display: flex;\s*align-items: center;\s*overflow: hidden;/);
  assert.match(styles, /\[data-header-density="compact"\] \.control-plane-kicker\s*\{[\s\S]*?font-size: 13px;[\s\S]*?font-weight: 700;/);
  assert.match(styles, /\[data-header-density="compact"\] \.control-plane-kicker::after\s*\{[\s\S]*?width: 1px;[\s\S]*?height: 12px;/);
  assert.match(styles, /\[data-header-density="compact"\] \.control-plane-instance-switcher-title > strong\s*\{\s*flex: 0 1 auto;/);
  assert.doesNotMatch(styles, /\[data-header-density="compact"\] \.control-plane-instance-switcher\s*\{[^}]*padding-block:/);
  assert.match(styles, /@media \(max-width: 520px\) \{[\s\S]*?\[data-header-density="compact"\] \.control-plane-kicker\s*\{\s*display: none;/);
  assert.match(english, /headerDensity: "Header height", headerCompact: "Compact", headerNormal: "Normal"/);
  assert.match(chinese, /headerDensity: "头部高度", headerCompact: "紧凑", headerNormal: "正常"/);
});
