import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = async (path) => fs.readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("instance session split assigns every session to exactly one pane and pins AI and Status left", async () => {
  const state = await source("apps/control-plane/instance-detail/useActiveInstanceSessions.ts");

  assert.match(state, /return session\.kind === "ai" \|\| session\.kind === "status"/);
  assert.match(state, /rightPaneSessionKeys\[instanceId\]\?\.\[session\.key\] \? "right" : "left"/);
  assert.match(state, /leftOrderedSessionTabs = computed\(\(\) => orderedSessionTabs\.value\.filter/);
  assert.match(state, /rightOrderedSessionTabs = computed\(\(\) => orderedSessionTabs\.value\.filter/);
  assert.match(state, /if \(!instanceId \|\| !session \|\| isPinnedLeft\(session\)\) return/);
  assert.match(state, /for \(const key of Object\.keys\(assignments\)\)[\s\S]*isPinnedLeft\(session\)\) delete assignments\[key\]/);
});

test("session split follows the focused pane for selection and new app sessions", async () => {
  const state = await source("apps/control-plane/instance-detail/useActiveInstanceSessions.ts");

  assert.match(state, /focusedSessionPanes\[instanceId\] = pane/);
  assert.match(state, /focusedSessionPanes\[instance\.id\] === "right" && rightSelectedSessionKeys\[instance\.id\]/);
  assert.match(state, /ensurePaneAssignments\(instance\.id\)\[session\.id\] = true/);
  assert.match(state, /function closeSessionSplit\(\)[\s\S]*delete rightSelectedSessionKeys\[instanceId\][\s\S]*focusedSessionPanes\[instanceId\] = "left"/);
});

test("session preview splits the original tab row into pane-aligned tab groups", async () => {
  const [preview, pane, styles] = await Promise.all([
    source("apps/control-plane/instance-detail/SessionPreview.vue"),
    source("apps/control-plane/instance-detail/SessionPaneContent.vue"),
    source("apps/control-plane/instance-detail/SessionPreview.css"),
  ]);

  assert.match(preview, /:aria-label="hasSessionSplit \? 'Close split view' : 'Split session view'"/);
  assert.match(preview, /v-for="pane in visiblePanes"/);
  assert.match(preview, /v-for="tabGroup in visibleTabGroups"/);
  assert.match(preview, /props\.hasSessionSplit[\s\S]*id: "left"[\s\S]*props\.leftSessionTabs[\s\S]*id: "right"[\s\S]*props\.rightSessionTabs/);
  assert.doesNotMatch(preview, /v-if="!hasSessionSplit" class="session-preview-selector"/);
  assert.doesNotMatch(preview, /class="session-pane-tabs"/);
  assert.doesNotMatch(styles, /\.session-pane-tabs|\.session-pane-tab/);
  assert.match(preview, /Move to left/);
  assert.match(preview, /Move to right/);
  assert.match(preview, /session\.key === props\.leftSessionKey \|\| session\.key === props\.rightSessionKey/);
  assert.match(preview, /:data-pane="hasSessionSplit \? sessionPaneId\(session\) : undefined"/);
  assert.match(preview, /<div class="app-launcher" :class="\{ open: appLaunchMenuOpen && appLaunchMenuPane === tabGroup\.id \}"/);
  assert.match(preview, /class="session-tab-add-button"[\s\S]*<Plus :size="16"/);
  assert.doesNotMatch(preview, /\{\{ appLaunchButtonLabel \}\}/);
  assert.match(preview, /:open="sessionMenuOpen && sessionMenuPane === tabGroup\.id"/);
  assert.match(preview, /v-for="session in tabGroup\.tabs"/);
  assert.match(preview, /v-for="group in tabGroup\.groupedAppSessions"/);
  assert.match(preview, /function updateAppLaunchMenuOpen\(pane: SessionPaneId, open: boolean\)[\s\S]*emit\("focusSessionPane", pane\)/);
  assert.match(preview, /function updateSessionMenuOpen\(pane: SessionPaneId, open: boolean\)[\s\S]*emit\("focusSessionPane", pane\)/);
  assert.doesNotMatch(styles, /session-tab-item\.active\.focused/);
  assert.match(styles, /\.session-preview-primary-tools\.split \{[\s\S]*grid-template-columns: minmax\(0, var\(--session-left-ratio\)\) 7px/);
  assert.match(styles, /\.session-preview-primary-tools\.split \.session-preview-selector\[data-pane="left"\]/);
  assert.match(styles, /\.session-preview-primary-tools\.split \.session-preview-selector\[data-pane="right"\]/);
  assert.match(styles, /\.session-preview-primary-tools\.split \.session-preview-selector \.app-launcher,[\s\S]*opacity:\s*0[\s\S]*pointer-events:\s*none/);
  assert.match(styles, /transition:\s*opacity 180ms ease-in-out/);
  assert.match(styles, /\.session-preview-primary-tools\.split \.session-preview-selector:hover \.app-launcher,[\s\S]*:focus-within \.session-tab-menu-trigger[\s\S]*opacity:\s*1[\s\S]*pointer-events:\s*auto/);
  assert.match(styles, /\.session-preview:has\(\.session-pane\[data-pane="left"\]:hover\) \.session-preview-selector\[data-pane="left"\] \.app-launcher/);
  assert.match(styles, /\.session-preview:has\(\.session-pane\[data-pane="right"\]:hover\) \.session-preview-selector\[data-pane="right"\] \.session-tab-menu-trigger/);
  assert.match(styles, /\.session-toolbar-split-divider::after\s*\{[\s\S]*width:\s*2px/);
  assert.match(styles, /\.session-tab-strip :deep\(\[data-reka-scroll-area-viewport\] > div\)\s*\{[\s\S]*align-items:\s*center/);
  assert.match(styles, /\.app-launcher\.open \.session-tab-add-button\s*\{[\s\S]*background:\s*color-mix\(in srgb, var\(--surface-raised\) 92%, var\(--white\) 4%\)/);
  assert.match(preview, /hasSessionSplit \? 'Close split view' : 'Split session view'/);
  assert.match(preview, /role="separator"/);
  assert.match(preview, /Math\.round\(sessionSplitRatio \* 100\)/);
  assert.match(pane, /v-for="terminalSession in terminalSessions"/);
  assert.match(pane, /props\.tabs[\s\S]*filter\(\(session\) => session\.kind === "terminal"\)/);
  assert.match(styles, /grid-template-columns: minmax\(0, var\(--session-left-ratio\)\) 7px/);
  assert.match(styles, /\.session-pane-layout\.split \.session-pane,[\s\S]*\.session-pane-layout\.split \.session-pane-resize-handle\s*\{[\s\S]*grid-row:\s*1/);
  assert.match(styles, /\.session-pane-resize-handle::after\s*\{[\s\S]*width:\s*2px/);
  assert.match(styles, /body\.session-pane-resizing iframe/);
});
