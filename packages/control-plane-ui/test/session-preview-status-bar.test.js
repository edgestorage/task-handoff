import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = async (path) => fs.readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("session tab bar menus control persisted workbench visibility preferences", async () => {
  const [workbench, workbenchStyles, sidebar, detail, preview, layoutMenu, english, chinese] = await Promise.all([
    source("apps/control-plane/ControlPlaneWorkbench.vue"),
    source("apps/control-plane/ControlPlaneWorkbench.css"),
    source("apps/control-plane/instance-list/useResizableInstancesSidebar.ts"),
    source("apps/control-plane/instance-detail/InstanceDetail.vue"),
    source("apps/control-plane/instance-detail/SessionPreview.vue"),
    source("apps/control-plane/shared/WorkbenchLayoutContextMenu.vue"),
    source("i18n/locales/en-US/sessions.ts"),
    source("i18n/locales/zh-CN/sessions.ts"),
  ]);

  assert.match(detail, /:standalone="standalone"/);
  assert.match(workbench, /'instances-sidebar-hidden': !instancesSidebarVisible/);
  assert.match(workbench, /v-if="!standaloneMode && instanceViewMode && !settingsMode && instancesSidebarVisible"/);
  assert.match(workbench, /:instance-sidebar-visible="instancesSidebarVisible"/);
  assert.match(workbench, /@update:instance-sidebar-visible="setInstancesSidebarVisible"/);
  assert.match(workbenchStyles, /\.control-plane-workbench\.instances-sidebar-hidden \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(sidebar, /INSTANCE_VISIBLE_STORAGE_KEY = "task-handoff\.control-plane\.instances-visible"/);
  assert.match(sidebar, /storedInstancesVisible\(\)[\s\S]*?getItem\(INSTANCE_VISIBLE_STORAGE_KEY\) !== "false"/);
  assert.match(sidebar, /function setInstancesSidebarVisible\(visible: boolean\)[\s\S]*?setItem\(INSTANCE_VISIBLE_STORAGE_KEY, String\(visible\)\)/);
  assert.match(detail, /:instance-sidebar-visible="instanceSidebarVisible"/);
  assert.match(detail, /@update:instance-sidebar-visible="\$emit\('update:instanceSidebarVisible', \$event\)"/);
  assert.match(preview, /props\.standalone[\s\S]*session-status-bar-visible\.standalone[\s\S]*session-status-bar-visible\.main/);
  assert.match(preview, /useStorage\(sessionStatusBarStorageKey, !props\.standalone\)/);
  assert.doesNotMatch(preview, /useStorage\(sessionStatusBarStorageKey, computed/);
  assert.match(preview, /<ContextMenuTrigger as-child>\s*<div class="session-preview-toolbar"/);
  assert.match(preview, /<ContextMenu v-if="sessionStatusBarVisible">[\s\S]*?<div class="session-preview-actions">/);
  assert.equal((preview.match(/<WorkbenchLayoutContextMenu/g) || []).length, 3);
  assert.equal((preview.match(/show-status-bar/g) || []).length, 3);
  assert.equal((preview.match(/@update:status-bar-visible="sessionStatusBarVisible = \$event"/g) || []).length, 3);
  assert.equal((preview.match(/@update:instance-sidebar-visible="\$emit\('update:instanceSidebarVisible', \$event\)"/g) || []).length, 3);
  assert.match(preview, /sessions\.tabs\.moveRight[\s\S]*?<\/WorkbenchLayoutContextMenu>/);
  assert.match(layoutMenu, /t\("sessions\.tabs\.showStatusBar"\)/);
  assert.match(layoutMenu, /t\("sessions\.tabs\.showInstanceSidebar"\)/);
  assert.match(layoutMenu, /\.instance-action-item\.workbench-layout-menu-check\s*\{[\s\S]*?position: relative;[\s\S]*?padding: 0 8px 0 30px;/);
  assert.match(layoutMenu, /\.instance-action-item\.workbench-layout-menu-check > span:first-child\s*\{[\s\S]*?position: absolute;[\s\S]*?left: 8px;[\s\S]*?min-width: 14px;[\s\S]*?overflow: visible;/);
  assert.match(english, /showStatusBar: "Show bottom status bar"/);
  assert.match(english, /showInstanceSidebar: "Show instance sidebar"/);
  assert.match(chinese, /showStatusBar: "显示底部状态栏"/);
  assert.match(chinese, /showInstanceSidebar: "显示实例侧栏"/);
});

test("standalone session tab menus control the authoritative desktop window always-on-top state", async () => {
  const [preview, layoutMenu, english, chinese] = await Promise.all([
    source("apps/control-plane/instance-detail/SessionPreview.vue"),
    source("apps/control-plane/shared/WorkbenchLayoutContextMenu.vue"),
    source("i18n/locales/en-US/sessions.ts"),
    source("i18n/locales/zh-CN/sessions.ts"),
  ]);

  assert.match(preview, /windowAlwaysOnTopSupported = computed\(\(\) => Boolean\(props\.standalone/);
  assert.match(preview, /getWindowAlwaysOnTop\?\.\(\)[\s\S]*?windowAlwaysOnTop\.value = result\.alwaysOnTop/);
  assert.match(preview, /setWindowAlwaysOnTop\?\.\(enabled\)[\s\S]*?windowAlwaysOnTop\.value = result\.alwaysOnTop/);
  assert.equal((preview.match(/:show-window-always-on-top="windowAlwaysOnTopSupported"/g) || []).length, 2);
  assert.equal((preview.match(/@update:window-always-on-top="setWindowAlwaysOnTop"/g) || []).length, 2);
  assert.match(preview, /:show-header-density="!standalone"/);
  assert.match(layoutMenu, /t\("sessions\.tabs\.alwaysOnTop"\)/);
  assert.match(layoutMenu, /\.instance-action-item\.workbench-layout-menu-check\s*\{[\s\S]*?padding: 0 8px 0 30px;/);
  assert.match(english, /alwaysOnTop: "Keep window on top"/);
  assert.match(chinese, /alwaysOnTop: "窗口置顶"/);
});
