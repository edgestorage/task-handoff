import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
const workbenchStyles = read("src/apps/control-plane/ControlPlaneWorkbench.css");
const storyView = read("src/apps/control-plane/story/StoryView.vue");
const appStyles = read("src/styles/app.css");

test("workbench navigation orders Story before Board and AI", () => {
  assert.match(workbench, /const workbenchViewOptions[^]*?value: "instance"[^]*?value: "story"[^]*?value: "board"[^]*?value: "ai"[^]*?\]\);/);
  assert.match(workbenchStyles, /\[data-active-view="story"\]::before \{\s*left: calc\(2px \+ \(100% - 4px\) \/ 4\);/);
  assert.match(workbenchStyles, /\[data-active-view="board"\]::before \{\s*left: calc\(2px \+ \(100% - 4px\) \/ 2\);/);
  assert.match(workbenchStyles, /\[data-active-view="ai"\]::before \{\s*left: calc\(2px \+ \(100% - 4px\) \/ 4 \+ \(100% - 4px\) \/ 2\);/);
});

test("story mode replaces the instance switcher with a node filter", () => {
  assert.match(workbench, /const storyNodeFilter = ref\(""\);/);
  assert.match(workbench, /const storyNodeFilterOpen = ref\(false\);/);
  assert.match(workbench, /const storyNodeFilterOptions = computed\(\(\) => nodes\.data\.value \|\| \[\]\);/);
  assert.match(workbench, /function selectStoryNodeFilter\(nodeId: string\) \{[\s\S]*storyNodeFilter\.value = nodeId;/);
  assert.match(workbench, /<div v-else-if="storyMode && !standaloneMode" class="control-plane-title control-plane-instance-switcher-shell">/);
  assert.match(workbench, /t\("instances\.board\.allNodes"\)/);
  assert.match(workbench, /:filter-node-id="storyNodeFilter"/);
  assert.match(workbench, /@select="selectStoryNodeFilter\(''\)"/);
  assert.match(workbench, /@select="selectStoryNodeFilter\(node\.id\)"/);
  assert.match(workbench, /class="control-plane-story-node-menu"/);
  assert.match(workbench, /'--story-node-menu-height': `\$\{Math\.max\(storyNodeFilterOptions\.length \+ 1, 1\) \* 33 \+ 2\}px`/);
  assert.match(workbenchStyles, /control-plane-story-node-menu-item[\s\S]*min-height: 32px/);
});

test("story list filters by the selected owner node", () => {
  assert.match(storyView, /filterNodeId\?: string/);
  assert.match(storyView, /const nodeId = props\.filterNodeId\?\.trim\(\);/);
  assert.match(storyView, /return nodeId \? allStories\.value\.filter\(\(story\) => story\.ownerNodeId === nodeId\) : allStories\.value;/);
  assert.match(storyView, /const stories = computed\(\(\) => sortStories\(filteredStories\.value, storySortMode\.value, storySortOptions\.value\)\);/);
});

test("Story list options combine view and sort controls while manual mode drags the complete Story", () => {
  assert.match(storyView, /<MoreHorizontal :size="16" \/>/);
  assert.match(storyView, /<DropdownMenuRadioGroup :model-value="treeViewMode"[^]*?<DropdownMenuSeparator[^]*?<DropdownMenuRadioGroup :model-value="storySortMode"/);
  assert.match(storyView, /class="story-list-options-menu"/);
  assert.match(storyView, /class="story-list-options-item option-item"/);
  assert.match(storyView, /:global\(\.story-list-options-item \.absolute svg\) \{ width:9px; height:9px; \}/);
  assert.match(storyView, /class="story-tree"[^]*?@pointerdown="startStoryPointer\(\$event, story\)"/);
  assert.doesNotMatch(storyView, /GripVertical/);
  assert.doesNotMatch(storyView, /:draggable=|@dragstart=/);
  assert.match(storyView, /const STORY_TOUCH_DRAG_HOLD_MS = 420;/);
  assert.match(storyView, /distance < STORY_POINTER_DRAG_THRESHOLD/);
  assert.match(storyView, /storyDropTargetAt\(rows, draggingStoryKey\.value, clientY\)/);
  assert.match(storyView, /requestAnimationFrame\(scrollStoryDragFrame\)/);
  assert.match(storyView, /<Teleport to="body">[^]*?class="story-pointer-overlay"/);
  assert.match(storyView, /@keydown="handleStorySortKeydown\(\$event, story\)"/);
});

test("story selection follows the node-filtered list", () => {
  assert.match(storyView, /watch\(stories, \(value\) => \{[\s\S]*const present = value\.some\(\(story\) => story\.id === resource\.story\.id && story\.ownerNodeId === resource\.story\.ownerNodeId\);[\s\S]*if \(!present\) selectedResource\.value = value\[0\] \? \{ kind: "story", story: value\[0\] \} : undefined;/);
  assert.match(storyView, /const filterNodeId = props\.filterNodeId\?\.trim\(\);/);
});

test("selecting a Story detail does not expand its tree", () => {
  assert.match(storyView, /function selectStory\(story: Story\) \{ selectedResource\.value = \{ kind: "story", story \}; \}/);
  assert.doesNotMatch(storyView, /function selectStory\(story: Story\) \{ setStoryExpanded/);
  assert.match(storyView, /function toggleStoryExpanded\(story: Story\) \{ setStoryExpanded\(story, !isStoryOpen\(story\)\); \}/);
});

test("Story action folders resolve through the target instance node", () => {
  assert.match(storyView, /const nodeId = targetInstance\(instanceId\)\?\.nodeId;/);
  assert.match(storyView, /props\.nodeLocalFoldersByNodeId\[nodeId\]/);
  assert.doesNotMatch(storyView, /nodeLocalFoldersByNodeId\?\.\[actionDraftTargetInstanceId\.value\]/);
});

test("Story AI sessions expose status and unread indicators", () => {
  assert.match(storyView, /v-if="entry\.session\.status === 'running'" class="story-session-status"><AiSessionStatusIndicator :status="entry\.session\.status" \/>/);
  assert.match(storyView, /v-else class="story-session-icon"><MessageSquare :size="14" \/><AiSessionStatusIndicator class="story-session-icon-status" :status="entry\.session\.status" size="compact" \/>/);
  assert.match(storyView, /v-if="entry\.session\.unread" class="story-session-unread"/);
  assert.match(storyView, /\.story-session-icon-status\s*\{[^}]*position:absolute;[^}]*top:-2px;[^}]*right:-5px;/s);
  assert.match(storyView, /\.story-session-unread\s*\{[^}]*background:var\(--status-info\);/s);
  assert.match(storyView, /type SessionEntry = \{ instance: InstanceWithAiSessions; session: AiSessionSummary \};/);
});

test("Story AI sessions sort by the last user message across instances", () => {
  assert.match(storyView, /sortedAiSessionInboxEntries\(entries\)\.map/);
  assert.match(storyView, /\.filter\(\(session\) => session\.storyId === story\.id && instance\.node\?\.id === story\.ownerNodeId\)/);
  assert.doesNotMatch(storyView, /const sessionsFor = .*updatedAt/);
});

test("Story tree rows share distinct light-theme hover and selected states", () => {
  assert.match(storyView, /\.story-tree-item:hover \{ background:var\(--sidebar-row-hover-bg,var\(--surface-active\)\); \}/);
  assert.match(storyView, /\.story-tree-item\.active,\.story-tree-item\.active:hover \{ background:var\(--sidebar-row-selected-bg,var\(--surface-active\)\); \}/);
  assert.match(appStyles, /--sidebar-row-hover-bg: #eeeef2;[\s\S]*--sidebar-row-selected-bg: #e6e6ec;[\s\S]*--ai-session-row-hover-bg: var\(--sidebar-row-hover-bg\);[\s\S]*--ai-session-row-selected-bg: var\(--sidebar-row-selected-bg\);/);
});

test("Story children animate when their tree is expanded or collapsed", () => {
  assert.match(storyView, /<Transition name="story-tree-collapse">[\s\S]*v-if="isStoryOpen\(story\)" class="story-tree-collapse"[\s\S]*class="story-tree-collapse-inner"/);
  assert.match(storyView, /\.story-tree-collapse \{[^}]*grid-template-rows:1fr;[^}]*transition:grid-template-rows 180ms ease,opacity 140ms ease;/);
  assert.match(storyView, /\.story-tree-collapse-enter-from,\.story-tree-collapse-leave-to \{ grid-template-rows:0fr; opacity:0; \}/);
  assert.match(storyView, /@media \(prefers-reduced-motion: reduce\) \{ \.story-tree-collapse,\.story-tree-disclosure \{ transition:none; \} \}/);
});

test("Story list blocks only for its initial snapshot", () => {
  assert.match(storyView, /v-if="storiesPending" class="story-loading-overlay"/);
  assert.doesNotMatch(storyView, /v-if="storiesFetching" class="story-loading-overlay"/);
  assert.match(storyView, /:aria-busy="storiesFetching \? 'true' : undefined"/);
});

test("a newly created Story AI Session is selected from the authoritative session snapshot", () => {
  assert.match(storyView, /const pendingCreatedStorySession = ref<\{ story: Story; instanceId: string; sessionId: string; sourceResourceKey: string \}>\(\);/);
  assert.match(storyView, /function queueCreatedStorySession\(story: Story, instanceId: string, sessionId: string, sourceResourceKey: string\)[\s\S]*pendingCreatedStorySession\.value = \{ story, instanceId, sessionId, sourceResourceKey \};[\s\S]*selectPendingCreatedStorySession\(\);/);
  assert.match(storyView, /function finishStorySessionCreation\(instanceId: string, sessionId: string\)[\s\S]*queueCreatedStorySession\(story, instanceId, sessionId, resourceKey\(selectedResource\.value\)\)/);
  assert.match(storyView, /candidate\.id === pending\.sessionId && candidate\.storyId === pending\.story\.id/);
  assert.match(storyView, /watch\(\(\) => props\.instances, selectPendingCreatedStorySession\);/);
  assert.match(storyView, /selectSession\(pending\.story, \{ instance, session \}\);/);
  assert.doesNotMatch(storyView, /async function finishStorySessionCreation[\s\S]*?selectStory\(refreshed\)/);
});
