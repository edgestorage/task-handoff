import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const aiSessionPanel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const aiSessionPanelStyles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const appStyles = fs.readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");

test("Story history opens one conversation in a right-side drawer", () => {
  assert.match(storyView, /<Sheet v-model:open="storyHistoryDetailOpen">/);
  assert.match(storyView, /<SheetContent side="right"[^>]*class="story-history-drawer">/);
  assert.match(storyView, /<AiSessionPanel[\s\S]*?detail-only[\s\S]*?:initial-history-id="storyHistoryDetailEntry\?\.item\.id"/);
  assert.match(storyView, /<SheetTitle class="sr-only">/);
  assert.match(storyView, /class="story-history-drawer-drag-region" aria-hidden="true"/);
  assert.match(storyView, /class="story-history-drawer-close"/);
  assert.doesNotMatch(storyView, /story-history-drawer-header/);
  assert.match(storyView, /:global\(\.story-history-drawer\) \{[^}]*flex-direction:column;[^}]*gap:0 !important;[^}]*overflow:visible;[^}]*padding:0 !important;/);
  assert.match(storyView, /:global\(\.story-history-drawer\) \{ -webkit-app-region:no-drag;/);
  assert.match(storyView, /\.story-history-drawer-drag-region \{ -webkit-app-region:drag; height:var\(--control-plane-titlebar-height\);/);
  assert.match(storyView, /\.story-history-drawer-close \{ -webkit-app-region:no-drag; position:absolute;[^}]*left:-42px;/);
  assert.match(storyView, /@media \(max-width:820px\) \{ \.story-history-drawer-close \{ top:12px; left:max\(10px,calc\(10px \+ var\(--native-titlebar-controls-left-width\)\)\);/);
  assert.match(appStyles, /--control-plane-titlebar-height: 56px;/);
  assert.match(storyView, /\.story-history-panel > \.story-history-ai-session-panel \{ --session-ai-scrollbar-outset:0px; \}/);
  assert.match(aiSessionPanel, /v-else-if="historyDetail"[\s\S]*?<div v-if="!detailOnly" class="session-ai-detail-fixed-actions session-ai-detail-head-actions">/);
  assert.match(aiSessionPanelStyles, /\.session-ai-workspace\.detail-only \.session-ai-history-detail \{\s*--session-ai-detail-left-inset: 0px;\s*\}/);
  assert.doesNotMatch(aiSessionPanelStyles, /\.session-ai-workspace\.detail-only \.session-ai-detail \{/);
  assert.doesNotMatch(storyView, /story-history-dialog/);
});
