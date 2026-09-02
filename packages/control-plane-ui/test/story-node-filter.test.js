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
  assert.match(storyView, /return nodeId \? allStories\.filter\(\(story\) => story\.ownerNodeId === nodeId\) : allStories;/);
});

test("story selection follows the node-filtered list", () => {
  assert.match(storyView, /watch\(stories, \(value\) => \{[\s\S]*const present = value\.some\(\(story\) => story\.id === resource\.story\.id && story\.ownerNodeId === resource\.story\.ownerNodeId\);[\s\S]*if \(!present\) selectedResource\.value = value\[0\] \? \{ kind: "story", story: value\[0\] \} : undefined;/);
  assert.match(storyView, /const filterNodeId = props\.filterNodeId\?\.trim\(\);/);
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

test("Story tree rows share distinct light-theme hover and selected states", () => {
  assert.match(storyView, /\.story-tree-item:hover \{ background:var\(--sidebar-row-hover-bg,var\(--surface-active\)\); \}/);
  assert.match(storyView, /\.story-tree-item\.active,\.story-tree-item\.active:hover \{ background:var\(--sidebar-row-selected-bg,var\(--surface-active\)\); \}/);
  assert.match(appStyles, /--sidebar-row-hover-bg: #eeeef2;[\s\S]*--sidebar-row-selected-bg: #e6e6ec;[\s\S]*--ai-session-row-hover-bg: var\(--sidebar-row-hover-bg\);[\s\S]*--ai-session-row-selected-bg: var\(--sidebar-row-selected-bg\);/);
});
