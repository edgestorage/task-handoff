import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");

test("Story uses the same solid workspace background as AI Session", () => {
  assert.match(storyView, /\.story-view \{[^}]*background:var\(--workspace-bg\);/);
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

test("Story detail tabs merge section counts into the sticky header", () => {
  assert.match(storyView, /class="story-detail-header-tabs"/);
  assert.match(storyView, /class="story-detail-tab-count"/);
  assert.match(storyView, /value="automations"><span class="story-detail-tab-count">\{\{ storyAutomationEntries\.length \}\}<\/span>\{\{ t\("stories\.automation\.title"\) \}\}<\/TabsTrigger>/);
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
