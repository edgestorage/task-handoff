import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewerSource = readFileSync(new URL("../src/apps/control-plane/instance-detail/InstanceRemoteDesktopViewer.vue", import.meta.url), "utf8");

test("scope popover constrains the teleported frame and its Reka viewport", () => {
  assert.match(
    viewerSource,
    /:deep\(\.remote-desktop-scope-popover\)\s*\{[\s\S]*?max-height:\s*var\(--reka-popover-content-available-height\);[\s\S]*?overflow:\s*hidden;/,
  );
  assert.match(
    viewerSource,
    /\.remote-desktop-scope-scroll\s*:deep\(\[data-task-handoff-scroll-viewport\]\)\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?max-height:\s*calc\(var\(--reka-popover-content-available-height\) - 85px\);/,
  );
});
