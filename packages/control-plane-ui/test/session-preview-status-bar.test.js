import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = async (path) => fs.readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("session tab bar and bottom status bar share one persisted visibility action", async () => {
  const [detail, preview, styles, english, chinese] = await Promise.all([
    source("apps/control-plane/instance-detail/InstanceDetail.vue"),
    source("apps/control-plane/instance-detail/SessionPreview.vue"),
    source("apps/control-plane/instance-detail/SessionPreview.css"),
    source("i18n/locales/en-US/sessions.ts"),
    source("i18n/locales/zh-CN/sessions.ts"),
  ]);

  assert.match(detail, /:standalone="standalone"/);
  assert.match(preview, /props\.standalone[\s\S]*session-status-bar-visible\.standalone[\s\S]*session-status-bar-visible\.main/);
  assert.match(preview, /useStorage\(sessionStatusBarStorageKey, computed\(\(\) => !props\.standalone\)\)/);
  assert.match(preview, /<ContextMenuTrigger as-child>\s*<div class="session-preview-toolbar"/);
  assert.match(preview, /<ContextMenu v-if="sessionStatusBarVisible">[\s\S]*?<div class="session-preview-actions">/);
  assert.equal((preview.match(/t\("sessions\.tabs\.showStatusBar"\)/g) || []).length, 3);
  assert.equal((preview.match(/<ContextMenuCheckboxItem v-model="sessionStatusBarVisible" class="instance-action-item session-status-bar-menu-item"/g) || []).length, 3);
  assert.match(preview, /sessions\.tabs\.moveRight[\s\S]*?<ContextMenuSeparator \/>[\s\S]*?sessions\.tabs\.showStatusBar/);
  assert.match(styles, /\.session-status-bar-menu-item\s*\{[^}]*position: relative;[^}]*padding-left: 30px;/s);
  assert.match(styles, /\.session-status-bar-menu-item > span:first-child\s*\{[^}]*position: absolute;[^}]*left: 8px;[^}]*overflow: visible;/s);
  assert.doesNotMatch(styles, /\.session-preview-toolbar\.in-titlebar \.session-preview-primary-tools/);
  assert.match(english, /showStatusBar: "Show bottom status bar"/);
  assert.match(chinese, /showStatusBar: "显示底部状态栏"/);
});
