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

test("Story detail tabs merge section counts into the sticky header", () => {
  assert.match(storyView, /class="story-detail-header-tabs"/);
  assert.match(storyView, /class="story-detail-tab-count"/);
  assert.match(storyView, /value="automations"><span class="story-detail-tab-count">\{\{ storyAutomationEntries\.length \}\}<\/span>\{\{ t\("stories\.automation\.title"\) \}\}<\/TabsTrigger>/);
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
