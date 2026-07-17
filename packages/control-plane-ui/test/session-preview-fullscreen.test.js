import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");
const workbenchStyles = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.css", import.meta.url), "utf8");
const detailStyles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/InstanceDetail.css", import.meta.url), "utf8");
const previewStyles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/SessionPreview.css", import.meta.url), "utf8");

test("expanded instance preview removes only the detail gutter", () => {
  assert.match(workbench, /<header class="control-plane-topbar"/);
  assert.match(workbench, /<InstanceList\s+[\s\S]*?v-if="instanceViewMode && !settingsMode"/);
  assert.match(workbench, /<InstanceDetail\s+[\s\S]*?:class="\{ 'preview-expanded': sessionPreviewExpanded \}"/);
  assert.doesNotMatch(workbench, /detailFullscreen|detail-fullscreen/);
  assert.doesNotMatch(workbenchStyles, /detail-fullscreen/);
  assert.match(detailStyles, /\.instance-detail\.preview-expanded\s*{[\s\S]*?padding: 0;/);
  assert.match(previewStyles, /\.session-preview\.expanded\s*{[\s\S]*?border: 0;[\s\S]*?border-radius: 0;[\s\S]*?box-shadow: none;/);
});
