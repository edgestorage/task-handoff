import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  DETAIL_HEAD_EXPAND_SLACK,
  DETAIL_HEAD_MIN_CONTEXT_WIDTH,
  nextDetailHeadActionsOverflow,
} from "../src/apps/control-plane/instance-detail/sessionDetailHeadActions.ts";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const panelCss = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");

const expanded = { collapsed: false, expandedActionsWidth: 0 };

test("detail head actions collapse into the overflow menu only when the pane cannot fit them", () => {
  const actionsWidth = 284;
  const roomy = nextDetailHeadActionsOverflow(expanded, { availableWidth: actionsWidth + DETAIL_HEAD_MIN_CONTEXT_WIDTH, actionsWidth });
  assert.deepEqual(roomy, { collapsed: false, expandedActionsWidth: actionsWidth });

  const tight = nextDetailHeadActionsOverflow(expanded, { availableWidth: actionsWidth + DETAIL_HEAD_MIN_CONTEXT_WIDTH - 1, actionsWidth });
  assert.deepEqual(tight, { collapsed: true, expandedActionsWidth: actionsWidth });
});

test("detail head actions keep measuring the expanded row while they are collapsed", () => {
  const collapsed = { collapsed: true, expandedActionsWidth: 284 };
  // The collapsed row only renders the "..." trigger, so its width must not reopen the row.
  const narrow = nextDetailHeadActionsOverflow(collapsed, { availableWidth: 320, actionsWidth: 26 });
  assert.equal(narrow, collapsed);

  // Expanding needs the full row plus slack so a dragged pane divider cannot flap the row.
  const borderline = 284 + DETAIL_HEAD_MIN_CONTEXT_WIDTH + DETAIL_HEAD_EXPAND_SLACK - 1;
  assert.equal(nextDetailHeadActionsOverflow(collapsed, { availableWidth: borderline, actionsWidth: 26 }), collapsed);

  const comfortable = 284 + DETAIL_HEAD_MIN_CONTEXT_WIDTH + DETAIL_HEAD_EXPAND_SLACK;
  assert.deepEqual(
    nextDetailHeadActionsOverflow(collapsed, { availableWidth: comfortable, actionsWidth: 26 }),
    { collapsed: false, expandedActionsWidth: 284 },
  );
});

test("detail head actions ignore unmeasurable rows", () => {
  const collapsed = { collapsed: true, expandedActionsWidth: 284 };
  assert.equal(nextDetailHeadActionsOverflow(collapsed, { availableWidth: 0, actionsWidth: 0 }), collapsed);
  assert.equal(nextDetailHeadActionsOverflow(expanded, { availableWidth: 900, actionsWidth: 0 }), expanded);
});

test("session detail measures its own pane instead of the viewport for head action overflow", () => {
  assert.match(panel, /const detailHeadActionsOverflow = ref<DetailHeadActionsOverflow>\(\{ collapsed: false, expandedActionsWidth: 0 \}\)/);
  assert.match(panel, /const detailHeadActionsInMenu = computed\(\(\) => compactAiSessionLayout\.value \|\| detailHeadActionsOverflow\.value\.collapsed\)/);
  assert.match(panel, /function syncDetailHeadActionsOverflow\(\) \{[\s\S]*?if \(compactAiSessionLayout\.value\) return;[\s\S]*?availableWidth: header\.getBoundingClientRect\(\)\.width[\s\S]*?actionsWidth: actions\.getBoundingClientRect\(\)\.width/);
  assert.match(panel, /promptResizeObserver = new ResizeObserver\(\(\) => \{\s*syncDetailHeadActionsOverflow\(\);/);
  assert.match(panel, /detailActionsResizeObserver = new ResizeObserver\(\(\) => \{\s*syncDetailActionsWidth\(\);\s*syncDetailHeadActionsOverflow\(\);\s*\}\);/);
});

test("session detail reserves the head action width so the context truncates instead of overlapping", () => {
  assert.match(panelCss, /\.session-ai-detail-context \{[\s\S]*?padding-right: calc\(var\(--session-ai-fixed-actions-width, 0px\) \+ 8px\);/);
  assert.match(panelCss, /\.session-ai-detail-context > \* \{\s*flex: 0 0 auto;\s*\}/);
  assert.match(panelCss, /\.session-ai-detail-context > \.session-ai-detail-folder,\s*\.session-ai-detail-context > \.session-ai-detail-context-path \{\s*flex: 0 1 auto;\s*\}/);
});
