import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const styles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/SessionPreview.css", import.meta.url), "utf8");
const preview = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/SessionPreview.vue", import.meta.url), "utf8");

test("mobile session previews omit the bottom instance status bar", () => {
  assert.match(styles, /@media \(max-width: 780px\)\s*\{[\s\S]*?\.session-preview\s*\{[^}]*grid-template-rows: auto minmax\(0, 1fr\);/);
  assert.match(styles, /@media \(max-width: 780px\)\s*\{[\s\S]*?\.session-preview-actions\s*\{\s*display: none;/);
});

test("narrow desktop windows and mobile keep only AI, launch, and session menu controls", () => {
  assert.match(styles, /\.session-ai-home\s*\{[^}]*flex: 0 0 auto;/s);
  assert.match(preview, /const compactSessionToolbar = useMediaQuery\("\(max-width: 600px\)"\);/);
  assert.match(preview, /const sessionSplitAvailable = useMediaQuery\("\(min-width: 601px\)"\);/);
  assert.match(preview, /v-if="tabGroup\.statusTab && !compactSessionToolbar"/);
  assert.match(preview, /v-if="!compactSessionToolbar && previewSessionTabs\(tabGroup\.id, tabGroup\.appTabs\)\.length" class="session-tab-strip-frame"/);
  assert.equal((preview.match(/v-if="compactSessionToolbar \|\| !tabGroup\.statusTab"/g) || []).length, 2);
  assert.match(preview, /<button v-if="sessionSplitAvailable" type="button" class="preview-expand-button"[^>]*closeSessionSplit/);
  assert.match(preview, /watch\(\[sessionSplitAvailable, \(\) => props\.hasSessionSplit\],[\s\S]*if \(!available && split\) emit\("closeSessionSplit"\);/);
  assert.match(preview, /v-if="sessionSplitAvailable && sessionPaneId\(session\) === 'right'"/);
  assert.match(preview, /v-else-if="sessionSplitAvailable" class="instance-action-item"/);
});

test("mobile session tabs require a long press before dragging", () => {
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*?\.session-tab-item\s*\{[^}]*touch-action: pan-x;[^}]*-webkit-touch-callout: none;/);
  assert.match(preview, /const mobileSessionTabDragHoldMs = 420;/);
  assert.match(preview, /<ContextMenuTrigger as-child :disabled="!sessionSplitAvailable && !windowAlwaysOnTopSupported">/);
  assert.match(preview, /!sessionSplitAvailable\.value && event\.pointerType === "touch"/);
  assert.match(preview, /window\.setTimeout\(\(\) => \{[\s\S]*activateSessionTabPointerDrag\(pending\.startX, pending\.startY\);[\s\S]*mobileSessionTabDragHoldMs/);
  assert.match(preview, /if \(!sessionTabPointerDrag\.value && waitsForLongPress\) \{\s*if \(distance > mobileSessionTabDragMoveTolerance\) cleanupSessionTabPointerDrag\(false\);\s*return;/);
  assert.match(preview, /wasDragging && sessionTabDragMoved && draggingSessionTabKey\.value && target/);
  assert.match(preview, /clearSessionTabLongPressTimer\(\);[\s\S]*window\.removeEventListener\("pointermove"/);
});
