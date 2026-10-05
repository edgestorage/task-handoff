import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const agentView = fs.readFileSync(new URL("../src/apps/control-plane/agent/AgentView.vue", import.meta.url), "utf8");
const resizablePane = fs.readFileSync(new URL("../src/apps/control-plane/shared/useResizablePane.ts", import.meta.url), "utf8");

test("Story uses the same solid workspace background as AI Session", () => {
  assert.match(storyView, /\.story-view \{[^}]*background:var\(--workspace-bg\);/);
});

test("Story list stays readable while nodes answer", () => {
  assert.doesNotMatch(storyView, /story-loading-overlay/);
  assert.match(storyView, /\.story-node-load \{ display:flex;[^}]*color:var\(--text-muted\);[^}]*font-size:12px; \}/);
  assert.match(storyView, /\.story-node-load\[data-state="warning"\] \{ color:var\(--status-warning\); \}/);
});

test("Story detail uses settings-style directories instead of standalone item cards", () => {
  assert.doesNotMatch(storyView, /class="story-overview-summary"/);
  assert.match(storyView, /class="story-directory story-actions-section"/);
  assert.match(storyView, /class="story-directory story-resource-section"/);
  assert.match(storyView, /\.story-directory \{[^}]*border:1px solid var\(--line\);[^}]*border-radius:8px;[^}]*background:var\(--surface-raised\);/);
  assert.match(storyView, /\.story-directory-header \{[^}]*min-height:38px;[^}]*border-bottom:1px solid var\(--line\);/);
  assert.match(storyView, /\.story-resource-item \+ \.story-resource-item \{ border-top:1px solid var\(--line\); \}/);
  assert.match(storyView, /\.story-action-item \+ \.story-action-item \{ border-top:1px solid var\(--line\); \}/);
  assert.doesNotMatch(storyView, /story-overview-grid/);
});

test("archived Stories move their state to the row end and mute the whole tree", () => {
  assert.match(storyView, /'story-tree-archived': Boolean\(story\.archivedAt\)/);
  assert.match(storyView, /<small v-if="story\.archivedAt" class="story-tree-archived-label">\{\{ t\("stories\.archived"\) \}\}<\/small>/);
  assert.match(storyView, /\.story-tree-archived \.story-tree-item,[^}]*color:var\(--story-tree-archived-foreground\);/);
  assert.match(storyView, /\.story-tree-archived-label \{[^}]*border:1px solid color-mix\(in srgb,var\(--line\) 60%,transparent\);[^}]*color:var\(--story-tree-archived-foreground\);/);
});

test("archived Stories do not render the new-session icon", () => {
  assert.match(storyView, /<small v-if="story\.archivedAt" class="story-tree-archived-label">[\s\S]*?<button v-else type="button" class="story-tree-add story-tree-story-add"/);
});

test("Story children keep compact spacing between expanded groups", () => {
  assert.match(storyView, /\.story-tree-children \{[^}]*margin:2px 0 4px 16px;/);
});

test("Story list sidebar animates only its expand and collapse", () => {
  // 拖拽/折叠交互由 Story 与 Agent 共用的 useResizablePane 承载，动画只挂在折叠状态上。
  assert.match(resizablePane, /const animationMs = options\.animationMs \?\? 200;/);
  assert.match(resizablePane, /function playLayoutAnimation\(\)[\s\S]*paneLayoutAnimating\.value = true;[\s\S]*window\.setTimeout\([\s\S]*paneLayoutAnimating\.value = false;/);
  assert.match(resizablePane, /watch\(paneCollapsed, playLayoutAnimation, \{ flush: "sync" \}\)/);
  assert.match(storyView, /useResizablePane\(\{[\s\S]*widthStorageKey: "task-handoff\.control-plane\.stories\.sidebar-width"[\s\S]*collapseStorageKey: "task-handoff\.control-plane\.stories\.sidebar-collapse-mode"/);
  assert.match(agentView, /useResizablePane\(\{[\s\S]*widthStorageKey: "task-handoff\.control-plane\.agents\.sidebar-width"[\s\S]*collapseStorageKey: "task-handoff\.control-plane\.agents\.sidebar-collapse-mode"/);
  assert.match(storyView, /'story-workspace-animating': sidebarLayoutAnimating/);
  assert.match(storyView, /\.story-workspace \{[^}]*transition:none; \}/);
  assert.doesNotMatch(storyView, /\.story-workspace \{[^}]*transition:grid-template-columns/);
  assert.match(storyView, /\.story-workspace-animating \{ transition:grid-template-columns 180ms cubic-bezier\(\.2,0,0,1\); \}/);
});

test("Story detail tabs merge section counts into the sticky header", () => {
  assert.match(storyView, /class="story-detail-header-tabs"/);
  assert.match(storyView, /class="story-detail-tab-count"/);
  assert.match(storyView, /value="automations"><span class="story-detail-tab-count">\{\{ storyAutomationEntries\.length \}\}<\/span>\{\{ t\("stories\.automation\.title"\) \}\}<\/TabsTrigger>/);
});

test("Story detail header keeps content flush under the divider without an extra gap", () => {
  assert.match(storyView, /\.story-detail-head \{[^}]*position:sticky; top:0;/);
  assert.match(storyView, /\.story-detail-head \{[^}]*background:var\(--workspace-bg\);/);
  assert.doesNotMatch(storyView, /\.story-detail-head \{[^}]*padding-bottom:/);
  assert.doesNotMatch(storyView, /\.story-detail-head \{[^}]*backdrop-filter:/);
});

test("Story detail header wraps its tabs on the story pane width instead of the window width", () => {
  assert.match(storyView, /\.story-detail-scroll-inner \{[^}]*container:story-detail \/ inline-size;/);
  assert.match(
    storyView,
    /@container story-detail \(max-width:780px\) \{ \.story-content-header \{ flex-wrap:wrap; padding:0 0 14px; \} \.story-detail-header-tabs \{ order:3; width:100%; margin-left:0; \} \.story-detail-tabs \{ width:100%; \} \.story-detail-tabs :deep\(button\) \{ flex:1; min-width:0; padding:0 5px; \} \}/,
  );
  assert.doesNotMatch(storyView, /@media \(max-width:(?:800|560)px\)[^\n]*\.story-detail(?:-header)?-tabs/);
});

test("Story detail header never pushes its actions out of the pane", () => {
  assert.match(storyView, /\.story-detail-header-tabs \{ flex:0 1 auto; margin-left:auto; min-width:0; \}/);
  assert.match(storyView, /\.story-detail-tabs \{ display:inline-flex; align-items:center; width:fit-content; max-width:100%;/);
  assert.match(storyView, /\.story-detail-tabs :deep\(button\) \{ min-width:0;/);
  assert.match(storyView, /\.story-content-actions \{ display:flex; align-items:center; gap:8px; flex:0 0 auto; \}/);
});

test("Story tabs distinguish selection without the default active shadow", () => {
  assert.match(storyView, /\.story-detail-tabs :deep\(button\) \{[^}]*color:var\(--text-muted\);/);
  assert.match(storyView, /\.story-session-tabs :deep\(button\) \{[^}]*color:var\(--text-muted\);/);
  assert.match(storyView, /button\[data-state="active"\][^}]*background:var\(--surface-active\);[^}]*color:var\(--text-strong\);[^}]*box-shadow:none;/);
  assert.match(storyView, /\.story-detail-tab-count \{[^}]*color:inherit;/);
});

test("Story detail title supports the instance-detail inline rename interaction", () => {
  assert.match(storyView, /class="story-title-name-button"[\s\S]*?@click="beginStoryTitleEdit\(selectedResource\.story, \$event\)"/);
  assert.match(storyView, /class="story-title-name-input"[\s\S]*?@blur="commitStoryTitleEdit"[\s\S]*?@keydown="handleStoryTitleEditKeydown"/);
  assert.match(storyView, /function handleStoryTitleEditKeydown\(event: KeyboardEvent\) \{[\s\S]*?if \(event\.isComposing\) return;[\s\S]*?event\.key === "Enter"[\s\S]*?commitStoryTitleEdit\(\)[\s\S]*?event\.key === "Escape"[\s\S]*?cancelStoryTitleEdit\(\)/);
  assert.doesNotMatch(storyView, /class="story-title-name-input"[^>]*@keydown\.(?:enter|esc)\.prevent/);
  assert.match(storyView, /body: JSON\.stringify\(\{ nodeId: story\.ownerNodeId, input: \{ title \} \}\)/);
  assert.match(storyView, /\.story-title-name-button:hover \.story-title-name-button-label[^}]*background:var\(--surface-hover\);/);
  assert.match(storyView, /\.story-title-name-field \{[^}]*width:max-content;[^}]*max-width:100%;/);
  assert.match(storyView, /\.story-title-name-button,\.story-title-name-input \{[^}]*margin:0;/);
  assert.doesNotMatch(storyView, /\.story-title-name-button,\.story-title-name-input \{[^}]*margin:[^;}]*-6px/);
  assert.match(storyView, /\.story-title-name-button-label \{[^}]*display:block;/);
  assert.match(storyView, /\.story-content-header \.story-content-title \{[^}]*align-items:baseline;/);
  assert.match(storyView, /input\.scrollWidth \+ input\.offsetWidth - input\.clientWidth/);
  assert.match(storyView, /Math\.max\(storyTitleEditWidth\.value, Math\.ceil\(inputContentWidth\)\)/);
});

test("Story detail actions match the tree menu after the standalone edit action", () => {
  assert.match(
    storyView,
    /@select="openCreateAutomation\(\)"[\s\S]*?<DropdownMenuSeparator \/>[\s\S]*?@select="toggleArchive\(selectedResource\.story\)"[\s\S]*?class="story-detail-action-menu-item danger" @select="deleteStory\(selectedResource\.story\)"/,
  );
});

test("Story detail moves its scrollbar outward without shifting the content viewport", () => {
  assert.match(storyView, /\.story-detail-scroll \{[^}]*margin-right:-16px;/);
  assert.match(storyView, /\.story-detail-scroll :deep\(\[data-task-handoff-scroll-viewport\]\) \{ width:calc\(100% - 16px\); \}/);
  assert.match(storyView, /\.story-detail-scroll-inner \{[^}]*padding:0 0 32px;/);
  assert.doesNotMatch(storyView, /\.story-detail-scroll-inner \{[^}]*padding-right:/);
});

test("Story session keeps its scrollbar five pixels from the right edge", () => {
  assert.match(storyView, /\.story-content\.story-session-pane > \.story-session-creator \{ padding:0 5px 0 0; background:transparent; \}/);
});

test("Story session directory uses explicit current and history tabs", () => {
  assert.match(storyView, /<Tabs :model-value="storySessionView"/);
  assert.match(storyView, /<TabsTrigger value="current">/);
  assert.match(storyView, /<TabsTrigger value="history">/);
  assert.match(storyView, /type StorySessionView = "current" \| "history";/);
  assert.doesNotMatch(storyView, /toggleStorySessionHistory/);
});

test("Story documents and both session views paginate independently", () => {
  assert.match(storyView, /const STORY_DETAIL_PAGE_SIZE = 10;/);
  assert.match(storyView, /v-for="document in pagedStoryDocuments"/);
  assert.match(storyView, /v-for="entry in pagedStoryCurrentSessions"/);
  assert.match(storyView, /v-for="entry in pagedStoryHistoryEntries"/);
  assert.match(storyView, /const storyDocumentPage = ref\(1\);/);
  assert.match(storyView, /const storyCurrentSessionPage = ref\(1\);/);
  assert.match(storyView, /const storyHistoryPage = ref\(1\);/);
  assert.match(storyView, /class="story-pagination"/);
});

test("Agent Run member sessions are derived as read-only descendants of the initiating Story session", () => {
  assert.match(storyView, /useAgentRunsQuery\(isFeatureEnabled\("agentRuns"\)\)/);
  assert.match(storyView, /run\.provenance\.initiatingAiSessionId === sessionId/);
  assert.match(storyView, /byParent\.set\(member\.parentMemberId/);
  assert.match(storyView, /class="story-tree-item story-agent-run-member-row"/);
  assert.doesNotMatch(storyView, /story-agent-run-member-row[\s\S]{0,400}@(?:click|keydown)/);
});
