import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadNodeVisibilityFilter, persistNodeVisibilityFilter } from "../src/apps/control-plane/shared/nodeVisibilityPreference.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
const workbenchStyles = read("src/apps/control-plane/ControlPlaneWorkbench.css");
const storyView = read("src/apps/control-plane/story/StoryView.vue");
const agentView = read("src/apps/control-plane/agent/AgentView.vue");
const appStyles = read("src/styles/app.css");

test("workbench navigation orders Story before Board and AI", () => {
  assert.match(workbench, /const workbenchViewOptions[^]*?value: "instance"[^]*?value: "story"[^]*?value: "board"[^]*?value: "ai"[^]*?\]\);/);
  assert.match(workbenchStyles, /\[data-active-view="story"\]::before \{\s*left: calc\(2px \+ \(100% - 4px\) \/ 4\);/);
  assert.match(workbenchStyles, /\[data-active-view="board"\]::before \{\s*left: calc\(2px \+ \(100% - 4px\) \/ 2\);/);
  assert.match(workbenchStyles, /\[data-active-view="ai"\]::before \{\s*left: calc\(2px \+ \(100% - 4px\) \/ 4 \+ \(100% - 4px\) \/ 2\);/);
});

test("Story and Agent views share the top-bar node filter", () => {
  assert.match(workbench, /const nodeFilter = ref<NodeVisibilityFilter>\(loadNodeVisibilityFilter\(\)\);/);
  assert.match(workbench, /watch\(nodeFilter, \(filter\) => persistNodeVisibilityFilter\(filter\)\);/);
  assert.match(workbench, /const nodeFilterOpen = ref\(false\);/);
  assert.match(workbench, /function selectNodeFilter\(nodeId: string, event: MouseEvent\) \{[\s\S]*nodeFilter\.value = selectOnlyNode\(nodeId\);/);
  assert.match(workbench, /function toggleNodeFilter\(nodeId: string, checked: boolean\)/);
  assert.match(workbench, /<div v-else-if="\(storyMode \|\| agentMode\) && !standaloneMode" class="control-plane-title control-plane-instance-switcher-shell">/);
  assert.match(workbench, /const nodeFilterOptions = computed<\{ id: string; name: string; status\?: string \}\[\]>\(\(\) => \{[\s\S]*?agentCatalog\.catalog\.value\.nodes\.map\(\(node\) => \(\{ id: node\.id, name: node\.label \}\)\);/);
  assert.match(workbench, /t\("instances\.board\.allNodes"\)/);
  assert.match(workbench, /:node-filter="nodeFilter"/);
  assert.match(workbench, /@select="selectAllNodes"/);
  assert.match(workbench, /@click="selectNodeFilter\(node\.id, \$event\)"/);
  assert.match(workbench, /@update:model-value="toggleNodeFilter\(node\.id, \$event === true\)"/);
  assert.match(workbench, /class="control-plane-node-filter-menu"/);
  assert.match(workbench, /'--node-filter-menu-items': String\(nodeFilterOptions\.length \+ 1\)/);
  assert.match(workbenchStyles, /control-plane-node-filter-menu-scroll\) \{\s*height: min\(\s*calc\(var\(--node-filter-menu-items, 1\) \* var\(--node-filter-menu-row-height\) \+ \(var\(--node-filter-menu-items, 1\) - 1\) \* var\(--node-filter-menu-row-gap\)\)/);
  assert.match(workbenchStyles, /control-plane-node-filter-menu \.control-plane-node-filter-menu-item\) \{[\s\S]*min-height: var\(--node-filter-menu-row-height\)/);
  assert.match(workbench, /<AgentView v-if="!standaloneMode && agentMode && !settingsMode" :node-filter="nodeFilter" \/>/);
});

test("Agent view keeps its list and graph on the same visible node set", () => {
  assert.match(agentView, /nodeFilter\?: NodeVisibilityFilter/);
  assert.match(agentView, /const visibleAgents = computed\(\(\) => catalog\.value\.agents\.filter\(\(agent\) => nodeIsVisible\(props\.nodeFilter, agent\.nodeId\)\)\);/);
  assert.match(agentView, /:agents="visibleAgents"/);
  assert.match(agentView, /return visibleAgents\.value\.filter/);
  assert.match(agentView, /const groupedAgents = computed\(\(\) => agentCatalogGroups\(\{ \.\.\.catalog\.value, agents: filteredAgents\.value \}\)\);/);
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test("node visibility preference survives a reload per browser", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadNodeVisibilityFilter(storage), { kind: "all" });

  persistNodeVisibilityFilter({ kind: "selected", nodeIds: ["node-b"] }, storage);
  assert.deepEqual(loadNodeVisibilityFilter(memoryStorage(Object.fromEntries(storage.values))), { kind: "selected", nodeIds: ["node-b"] });

  persistNodeVisibilityFilter({ kind: "all" }, storage);
  assert.deepEqual(loadNodeVisibilityFilter(storage), { kind: "all" });
});

test("node visibility preference sanitizes malformed stored state", () => {
  const key = "task-handoff.control-plane.node-visibility";

  for (const value of ["{", "[]", "\"selected\"", "null", JSON.stringify({ kind: "unknown" }), JSON.stringify({ kind: "selected" }), JSON.stringify({ kind: "selected", nodeIds: [] }), JSON.stringify({ kind: "selected", nodeIds: ["  ", 7] })]) {
    assert.deepEqual(loadNodeVisibilityFilter(memoryStorage({ [key]: value })), { kind: "all" }, value);
  }

  assert.deepEqual(
    loadNodeVisibilityFilter(memoryStorage({ [key]: JSON.stringify({ kind: "selected", nodeIds: [" node-a ", "node-a", "node-b"], futureField: true }) })),
    { kind: "selected", nodeIds: ["node-a", "node-b"] },
  );
});

test("node visibility preference reads the Story-only key once for existing browsers", () => {
  const legacyKey = "task-handoff.control-plane.story-node-filter";
  assert.deepEqual(
    loadNodeVisibilityFilter(memoryStorage({ [legacyKey]: JSON.stringify({ kind: "selected", nodeIds: ["node-b"] }) })),
    { kind: "selected", nodeIds: ["node-b"] },
  );
  assert.deepEqual(
    loadNodeVisibilityFilter(memoryStorage({
      "task-handoff.control-plane.node-visibility": JSON.stringify({ kind: "all" }),
      [legacyKey]: JSON.stringify({ kind: "selected", nodeIds: ["node-b"] }),
    })),
    { kind: "all" },
  );
});

test("story list filters by the selected owner node", () => {
  assert.match(storyView, /nodeFilter\?: NodeVisibilityFilter/);
  assert.match(storyView, /allStories\.value\.filter\(\(story\) => nodeIsVisible\(props\.nodeFilter, story\.ownerNodeId\)\)/);
  assert.match(storyView, /const stories = computed\(\(\) => \{[\s\S]*return sortStories\(filteredStories\.value, mode, storySortOptions\(mode\)\);/);
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
  assert.match(storyView, /const story = filteredStories\.value\.find\(\(candidate\) => candidate\.id === selection\.storyId && candidate\.ownerNodeId === selection\.ownerNodeId\);/);
  assert.match(storyView, /watch\(\[filteredStories, \(\) => props\.nodes, \(\) => props\.instances\], \(\) => \{/);
  assert.doesNotMatch(storyView, /watch\(stories, \(value\) => \{/);
  assert.match(storyView, /const refreshed = refreshResource\(resource\);[\s\S]*const firstOnlineStory = stories\.value\.find\(storyIsOnline\);[\s\S]*selectedResource\.value = refreshed \|\| \(firstOnlineStory \? \{ kind: "story", story: firstOnlineStory \} : undefined\);/);
  assert.match(storyView, /const filteredOnlineNode = props\.nodes\.find/);
});

test("Story sorting subscribes only to the state used by its active mode", () => {
  assert.match(storyView, /lastUserMessageTimes: mode === "last-user-message" \? storyLastUserMessageTimes\.value : emptyStoryActivityTimes/);
  assert.match(storyView, /manualKeys: mode === "manual" \? manualStoryKeys\.value : emptyManualStoryKeys/);
  assert.match(storyView, /reuseEqualStoryActivityTimes\(previous, times\)/);
});

test("selecting a Story detail does not expand its tree", () => {
  assert.match(storyView, /function selectStory\(story: Story\) \{ if \(storyIsOnline\(story\)\) selectedResource\.value = \{ kind: "story", story \}; \}/);
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
  assert.match(storyView, /type SessionEntry = \{ instance: InstanceWithAiSessions; session: AiSessionSummary; depth\?: number; hasChildren\?: boolean \};/);
});

test("Story AI sessions open a supported terminal in the session working directory", () => {
  assert.match(storyView, /:can-open-terminal="Boolean\(storyTerminalAppId\(entry\.instance\)\)"/);
  assert.match(storyView, /:is-opening-terminal="launchingApp"/);
  assert.match(storyView, /@open-terminal="openStorySessionTerminal\(entry\)"/);
  assert.match(storyView, /function storyTerminalAppId\(instance: InstanceWithAiSessions\)[\s\S]*terminalAppIdForLaunchableApps\(launchableAppsForInstance\(instance, t\)\)/);
  assert.match(storyView, /function openStorySessionTerminal\(entry: SessionEntry\)[\s\S]*!entry\.session\.cwd[\s\S]*emit\("launch-app", entry\.instance, appId, undefined, \{ cwd: entry\.session\.cwd \}\)/);
  assert.match(workbench, /<StoryView[\s\S]*:launching-app="launchingApp"[\s\S]*@launch-app="launchSelectedApp"/);
});

test("Story AI sessions derive cross-instance trees and sort by each root's own user message", () => {
  assert.match(storyView, /deriveAiSessionForest\(storySessionRecords\.value, \{ orderBy: "last-user-message" \}\)/);
  assert.match(storyView, /root\.session\.storyId === story\.id && instance\?\.node\?\.id === story\.ownerNodeId/);
  assert.match(storyView, /flattenAiSessionForest\(\{[\s\S]*roots,[\s\S]*expandedSessionIds: expandedStorySessionIds\.value/);
  assert.match(storyView, /Date\.parse\(root\.session\.lastUserMessageAt/);
  assert.match(storyView, /const sessionCount = \(story: Story\) => storySessionRootsFor\(story\)\.length;/);
  assert.match(storyView, /sessionEntriesForRoots\(pageItems\(storyCurrentSessionRoots\.value, storyCurrentSessionPage\.value\)\)/);
  assert.match(storyView, /const expandedStorySessionIds = ref\(new Set<string>\(\)\);/);
  assert.match(storyView, /isStorySessionExpanded\(entry\.session\.id\)/);
  assert.match(storyView, /@click\.stop="toggleStorySessionExpanded\(entry\.session\.id\)"/);
  assert.match(storyView, /\.story-session-leading \{ position:relative; display:grid; width:14px; height:14px; flex:0 0 14px;/);
  assert.match(storyView, /\.story-session-semantic,\.story-session-disclosure \{ position:absolute; top:50%; left:50%; transform:translate\(-50%,-50%\);/);
  assert.equal((storyView.match(/class="story-session-chevron"/g) || []).length, 2);
  assert.match(storyView, /\.story-session-chevron\.expanded \{ transform:rotate\(90deg\); \}/);
  assert.equal((storyView.match(/<TransitionGroup name="story-session-tree"/g) || []).length, 1);
  assert.match(storyView, /<div class="story-session-resource-list">[\s\S]*v-for="entry in pagedStoryCurrentSessions"/);
  assert.match(storyView, /\.story-session-tree-enter-from,\.story-session-tree-leave-to \{ max-height:0; padding-block:0; opacity:0; transform:translateY\(-4px\); \}/);
  assert.match(storyView, /\.story-session-disclosure:focus-visible \{[^}]*opacity:1;/s);
  assert.match(storyView, /@media \(hover:none\)[\s\S]*\.story-session-disclosure \{ opacity:1; \}/);
});

test("Story tree rows share distinct light-theme hover and selected states", () => {
  assert.match(storyView, /\.story-tree-item:hover \{ background:var\(--sidebar-row-hover-bg,var\(--surface-active\)\); \}/);
  assert.match(storyView, /\.story-tree-item\.active,\.story-tree-item\.active:hover \{ background:var\(--sidebar-row-selected-bg,var\(--surface-active\)\); \}/);
  assert.match(appStyles, /--sidebar-row-hover-bg: #eeeef2;[\s\S]*--sidebar-row-selected-bg: #e6e6ec;[\s\S]*--ai-session-row-hover-bg: var\(--sidebar-row-hover-bg\);[\s\S]*--ai-session-row-selected-bg: var\(--sidebar-row-selected-bg\);/);
});

test("Instance list rows reuse the story hover and selected states", () => {
  const instanceList = read("src/apps/control-plane/instance-list/InstanceList.vue");
  assert.match(instanceList, /\.instance-row:hover,\s*\.instance-row:focus-within \{\s*background: var\(--sidebar-row-hover-bg, var\(--surface-active\)\);\s*outline: none;\s*\}/);
  assert.match(instanceList, /\.instance-row\.active,\s*\.instance-row\.active:hover,\s*\.instance-row\.active:focus-within \{\s*background: var\(--sidebar-row-selected-bg, var\(--surface-active\)\);\s*\}/);
  assert.match(instanceList, /\.instance-row \{[^}]*border: 0;[^}]*border-radius: 6px;[^}]*background: transparent;/s);
  assert.doesNotMatch(instanceList, /instance-list-row-(?:bg|border|hover-bg)/);
});

test("Story children animate when their tree is expanded or collapsed", () => {
  assert.match(storyView, /<Transition name="story-tree-collapse">[\s\S]*v-if="isStoryOpen\(story\)" class="story-tree-collapse"[\s\S]*class="story-tree-collapse-inner"/);
  assert.match(storyView, /\.story-tree-collapse \{[^}]*grid-template-rows:1fr;[^}]*transition:grid-template-rows 180ms ease,opacity 140ms ease;/);
  assert.match(storyView, /\.story-tree-collapse-enter-from,\.story-tree-collapse-leave-to \{ grid-template-rows:0fr; opacity:0; \}/);
  assert.match(storyView, /@media \(prefers-reduced-motion: reduce\) \{ \.story-tree-collapse,\.story-tree-disclosure \{ transition:none; \} \}/);
});

test("Story list renders nodes as they answer and hints at the remaining nodes", () => {
  assert.match(storyView, /const storyCatalog = useStoryCatalog\(\);/);
  assert.match(storyView, /const allStories = computed\(\(\) => storyCatalog\.stories\.value\);/);
  assert.doesNotMatch(storyView, /useStoriesQuery/);
  assert.doesNotMatch(storyView, /story-loading-overlay/);
  assert.match(storyView, /<div v-if="storyLoadingNodeIds\.length" class="story-node-load" role="status" aria-live="polite">[\s\S]*stories\.nodeLoad\.loadingNodes/);
  assert.match(storyView, /<div v-if="storyUnavailableNodeIds\.length" class="story-node-load" data-state="warning">[\s\S]*stories\.nodeLoad\.unavailableNodes/);
  assert.match(storyView, /v-if="!stories\.length && !storiesPending" class="story-empty"/);
  assert.match(storyView, /async function load\(nodeId\?: string\) \{[\s\S]*storyCatalog\.refetch\(nodeId\)/);
  assert.match(storyView, /await load\(story\.ownerNodeId\);/);
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
