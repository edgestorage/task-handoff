import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");
const workbenchStyles = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.css", import.meta.url), "utf8");
const detailStyles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/InstanceDetail.css", import.meta.url), "utf8");
const previewStyles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/SessionPreview.css", import.meta.url), "utf8");
const themeStyles = fs.readFileSync(new URL("../../web-theme/theme.css", import.meta.url), "utf8");

test("expanded instance preview removes only the detail gutter", () => {
  assert.match(workbench, /<header class="control-plane-topbar"/);
  assert.match(workbench, /<InstanceList\s+[\s\S]*?v-if="!standaloneMode && instanceViewMode && !settingsMode && instancesSidebarVisible"/);
  assert.match(workbench, /<InstanceDetail\s+[\s\S]*?:class="\{ 'preview-expanded': sessionPreviewExpanded \}"/);
  assert.doesNotMatch(workbench, /detailFullscreen|detail-fullscreen/);
  assert.doesNotMatch(workbenchStyles, /detail-fullscreen/);
  assert.match(detailStyles, /\.instance-detail\.preview-expanded\s*{[\s\S]*?padding: 0;/);
  assert.match(previewStyles, /\.session-preview\.expanded\s*{[\s\S]*?border: 0;[\s\S]*?border-radius: 0;[\s\S]*?box-shadow: none;/);
  assert.match(workbench, /:session-toolbar-target="standaloneMode && sessionPreviewExpanded && !hasSessionSplit \? '#instance-detail-titlebar-tabs' : undefined"/);
  assert.match(fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/SessionPreview.vue", import.meta.url), "utf8"), /'toolbar-in-titlebar': Boolean\(toolbarTarget\)/);
  assert.match(previewStyles, /\.session-preview\.toolbar-in-titlebar\s*{\s*grid-template-rows: minmax\(0, 1fr\) auto;/);
  assert.match(workbenchStyles, /\.instance-detail-titlebar-tabs\s*{[\s\S]*?-webkit-app-region: drag;/);
  assert.match(previewStyles, /\.session-preview-toolbar\.in-titlebar\s*{[\s\S]*?-webkit-app-region: drag;/);
  assert.match(previewStyles, /\.session-preview-toolbar\.in-titlebar :is\(button, input, \[role="tab"\], \[role="button"\]\),[\s\S]*?\.session-preview-toolbar\.in-titlebar \.session-tab-sortable-shell,[\s\S]*?-webkit-app-region: no-drag;/);
  assert.doesNotMatch(previewStyles, /session-tab-overflow-mask-bg/);
  assert.match(previewStyles, /\.session-tab-strip\[data-overflow-start="true"\]\[data-overflow-end="false"\] \{[\s\S]*?mask-image: linear-gradient\(90deg, transparent, #000 28px\);/);
  assert.match(previewStyles, /\.session-tab-strip\[data-overflow-start="false"\]\[data-overflow-end="true"\] \{[\s\S]*?mask-image: linear-gradient\(270deg, transparent, #000 28px\);/);
  assert.match(previewStyles, /\.session-tab-strip\[data-overflow-start="true"\]\[data-overflow-end="true"\] \{[\s\S]*?transparent 0,[\s\S]*?transparent 100%/);
  assert.match(previewStyles, /\.session-preview-toolbar\.in-titlebar \.session-tab-strip \{[\s\S]*?mask-image: none;/);
  assert.match(previewStyles, /\.session-preview-toolbar\.in-titlebar \.session-tab-strip-frame::before \{[\s\S]*?linear-gradient\(90deg, var\(--titlebar-overflow-fade\), transparent\)/);
  assert.match(previewStyles, /\.session-preview-toolbar\.in-titlebar \.session-tab-strip-frame::after \{[\s\S]*?linear-gradient\(270deg, var\(--titlebar-overflow-fade\), transparent\)/);
  assert.match(themeStyles, /:root,\s*\[data-theme="light"\] \{[\s\S]*?--titlebar-overflow-fade: #ffffff;/);
  assert.match(themeStyles, /\.dark,\s*\[data-theme="dark"\] \{[\s\S]*?--titlebar-overflow-fade: #0b1519;/);
});

test("main and standalone windows persist expanded preview independently", () => {
  assert.match(workbench, /const MAIN_SESSION_PREVIEW_EXPANDED_STORAGE_KEY = "task-handoff\.control-plane\.session-preview-expanded";/);
  assert.match(workbench, /const STANDALONE_SESSION_PREVIEW_EXPANDED_STORAGE_KEY = "task-handoff\.control-plane\.instance-window\.session-preview-expanded";/);
  assert.match(workbench, /const stored = window\.localStorage\?\.getItem\(standaloneMode\.value\s*\? STANDALONE_SESSION_PREVIEW_EXPANDED_STORAGE_KEY\s*: MAIN_SESSION_PREVIEW_EXPANDED_STORAGE_KEY\);/);
  assert.match(workbench, /return stored === null \|\| stored === undefined \? standaloneMode\.value : stored === "true";/);
  assert.match(workbench, /watch\(sessionPreviewExpanded, \(expanded\) => \{\s*window\.localStorage\?\.setItem\(standaloneMode\.value\s*\? STANDALONE_SESSION_PREVIEW_EXPANDED_STORAGE_KEY\s*: MAIN_SESSION_PREVIEW_EXPANDED_STORAGE_KEY, String\(expanded\)\);/);
});
