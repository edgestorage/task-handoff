import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { reorderSessionTabKeys } from "../src/apps/control-plane/instance-detail/sessionTabOrder.ts";

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
  assert.match(state, /\.\.\.tabs\.filter\(\(session\) => !order\.includes\(session\.key\)\)/);
  assert.match(state, /rightSelectedSessionKeys\[instance\.id\] = session\.id[\s\S]*selectedSessionKeys\[instance\.id\] = session\.id/);
  assert.match(state, /function closeSessionSplit\(\)[\s\S]*delete rightSelectedSessionKeys\[instanceId\][\s\S]*focusedSessionPanes\[instanceId\] = "left"/);
});

test("session preview splits the original tab row into pane-aligned tab groups", async () => {
  const [preview, pane, styles, terminalPreview] = await Promise.all([
    source("apps/control-plane/instance-detail/SessionPreview.vue"),
    source("apps/control-plane/instance-detail/SessionPaneContent.vue"),
    source("apps/control-plane/instance-detail/SessionPreview.css"),
    source("apps/control-plane/useTerminalPreview.ts"),
  ]);

  assert.match(preview, /:aria-label="hasSessionSplit \? t\('sessions\.tabs\.closeSplit'\) : t\('sessions\.tabs\.split'\)"/);
  assert.match(preview, /v-for="pane in visiblePanes"/);
  assert.match(preview, /v-for="tabGroup in visibleTabGroups"/);
  assert.match(preview, /props\.hasSessionSplit[\s\S]*id: "left"[\s\S]*props\.leftSessionTabs[\s\S]*id: "right"[\s\S]*props\.rightSessionTabs/);
  assert.doesNotMatch(preview, /v-if="!hasSessionSplit" class="session-preview-selector"/);
  assert.doesNotMatch(preview, /class="session-pane-tabs"/);
  assert.doesNotMatch(styles, /\.session-pane-tabs|\.session-pane-tab/);
  assert.match(preview, /t\("sessions\.tabs\.moveLeft"\)/);
  assert.match(preview, /t\("sessions\.tabs\.moveRight"\)/);
  assert.match(preview, /session\.key === props\.leftSessionKey \|\| session\.key === props\.rightSessionKey/);
  assert.match(preview, /:data-pane="hasSessionSplit \? sessionPaneId\(session\) : undefined"/);
  assert.match(preview, /<div v-if="!tabGroup\.statusTab" class="app-launcher" :class="\{ open: appLaunchMenuOpen && appLaunchMenuPane === tabGroup\.id \}"/);
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
  assert.match(preview, /class="session-tab-strip-frame"[\s\S]*v-session-tab-overflow class="session-tab-strip" @scroll="updateSessionTabOverflowFromEvent" @wheel="scrollSessionTabs"/);
  assert.match(preview, /function scrollSessionTabs\(event: WheelEvent\)[\s\S]*tabList\.scrollLeft \+ event\.deltaY/);
  assert.match(preview, /event\.preventDefault\(\);[\s\S]*tabList\.scrollLeft = nextScrollLeft/);
  assert.match(preview, /tabList\.dataset\.overflowStart = String\(tabList\.scrollLeft > 1\)/);
  assert.match(preview, /tabList\.dataset\.overflowEnd = String\(tabList\.scrollLeft < maxScrollLeft - 1\)/);
  assert.match(preview, /querySelector<HTMLElement>\('\[role="tab"\]\[aria-selected="true"\]'\)/);
  assert.match(preview, /tabBounds\.right > viewportBounds\.right[\s\S]*tabList\.scrollLeft = Math\.max\(0, Math\.min\(tabList\.scrollWidth - tabList\.clientWidth, nextScrollLeft\)\)/);
  assert.match(preview, /new ResizeObserver\(\(\) => syncSessionTabViewport\(tabList\)\)/);
  assert.match(preview, /updated\(tabList\) \{[\s\S]*nextTick\(\(\) => syncSessionTabViewport\(tabList\)\)/);
  assert.match(styles, /\.session-tab-strip \{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;[^}]*scrollbar-width:\s*none;/);
  assert.match(styles, /\.session-tab-strip::-webkit-scrollbar\s*\{[\s\S]*display:\s*none;/);
  assert.match(styles, /\.session-tab-strip-frame::before,[\s\S]*\.session-tab-strip-frame::after[\s\S]*transition:\s*opacity 140ms ease/);
  assert.match(styles, /data-overflow-start="true"[\s\S]*data-overflow-end="true"[\s\S]*opacity:\s*1/);
  assert.match(styles, /\.app-launcher\.open \.session-tab-add-button\s*\{[\s\S]*background:\s*color-mix\(in srgb, var\(--surface-raised\) 92%, var\(--white\) 4%\)/);
  assert.match(preview, /hasSessionSplit \? t\('sessions\.tabs\.closeSplit'\) : t\('sessions\.tabs\.split'\)/);
  assert.match(preview, /role="separator"/);
  assert.match(preview, /Math\.round\(sessionSplitRatio \* 100\)/);
  assert.doesNotMatch(pane, /v-for="terminalSession in terminalSessions"/);
  assert.doesNotMatch(pane, /v-show=/);
  assert.match(pane, /v-if="!hasInstanceStatusPage\(instance\) && activeTerminalSocketUrl"/);
  assert.match(pane, /:key="sessionKey"[\s\S]*active[\s\S]*:socket-url="activeTerminalSocketUrl"/);
  assert.match(pane, /\.session-terminal \{ position: relative;/);
  assert.match(terminalPreview, /message\.type === "snapshot"[\s\S]*terminal\.reset\(\)[\s\S]*terminal\.write\(message\.data\)/);
  assert.match(terminalPreview, /message\.pendingEscape[\s\S]*terminal\.write\(message\.pendingEscape\)/);
  assert.match(styles, /grid-template-columns: minmax\(0, var\(--session-left-ratio\)\) 7px/);
  assert.match(styles, /\.session-pane-layout\.split \.session-pane,[\s\S]*\.session-pane-layout\.split \.session-pane-resize-handle\s*\{[\s\S]*grid-row:\s*1/);
  assert.match(styles, /\.session-pane-resize-handle::after\s*\{[\s\S]*width:\s*2px/);
  assert.match(styles, /body\.session-pane-resizing iframe/);
});

test("session tab dragging follows the pointer, reorders live, and accepts pane whitespace", async () => {
  const [preview, state, styles] = await Promise.all([
    source("apps/control-plane/instance-detail/SessionPreview.vue"),
    source("apps/control-plane/instance-detail/useActiveInstanceSessions.ts"),
    source("apps/control-plane/instance-detail/SessionPreview.css"),
  ]);

  assert.match(preview, /@pointerdown="startSessionTabPointer\(\$event, session, tabGroup\.id\)"/);
  assert.match(preview, /window\.addEventListener\("pointermove", moveSessionTabPointer, true\)/);
  assert.match(preview, /const distance = Math\.hypot\(event\.clientX - pending\.startX, event\.clientY - pending\.startY\);/);
  assert.match(preview, /if \(!sessionTabPointerDrag\.value && distance < 5\) return;/);
  assert.match(preview, /<Teleport to="body">[\s\S]*class="session-tab-pointer-overlay"/);
  assert.match(preview, /<TransitionGroup name="session-tab-reorder"[\s\S]*previewSessionTabs\(tabGroup\.id, tabGroup\.appTabs\)/);
  assert.match(preview, /function previewSessionTabs\([\s\S]*nextTabs\.splice\(target\.placement === "after" \? targetIndex \+ 1 : targetIndex, 0, drag\.session\)/);
  assert.match(preview, /document\.elementFromPoint\(clientX, clientY\)/);
  assert.match(preview, /querySelectorAll<HTMLElement>\("\[data-session-tab-key\]"\)/);
  assert.match(preview, /targetKey: "", placement: "after"/);
  assert.doesNotMatch(preview, /draggable="true"|setDragImage|@dragstart/);
  assert.match(state, /isPinnedLeft\(sourceSession\)/);
  assert.match(state, /if \(!targetKey\)[\s\S]*targetPaneKeys[\s\S]*reorderSessionTabKeys\(currentOrder, sourceKey, "", placement, targetPaneKeys\)/);
  assert.match(styles, /\.session-tab-item\.drag-placeholder[\s\S]*border: 1px dashed/);
  assert.match(styles, /\.session-tab-reorder-move[\s\S]*transition: transform 160ms/);
  assert.match(styles, /:global\(\.session-tab-pointer-overlay\)[\s\S]*will-change: transform/);
  assert.match(styles, /body\.session-tab-pointer-dragging iframe[\s\S]*pointer-events: none/);
});

test("session tab ordering uses the same insertion invariant for tabs and pane whitespace", () => {
  const order = ["ai", "left-a", "right-a", "left-b", "right-b"];

  assert.deepEqual(reorderSessionTabKeys(order, "left-b", "left-a", "before"), ["ai", "left-b", "left-a", "right-a", "right-b"]);
  assert.deepEqual(reorderSessionTabKeys(order, "left-a", "left-b", "after"), ["ai", "right-a", "left-b", "left-a", "right-b"]);
  assert.deepEqual(reorderSessionTabKeys(order, "right-a", "", "after", ["left-a", "left-b"]), ["ai", "left-a", "left-b", "right-a", "right-b"]);
  assert.deepEqual(reorderSessionTabKeys(order, "left-a", "", "after", []), ["ai", "right-a", "left-b", "right-b", "left-a"]);
  assert.equal(reorderSessionTabKeys(order, "missing", "left-a", "before"), order);
});
