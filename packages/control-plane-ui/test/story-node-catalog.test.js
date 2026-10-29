import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { storyNodeLoadState } from "../src/apps/control-plane/story/storyNodeLoad.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const catalog = read("src/apps/control-plane/story/useStoryCatalog.ts");
const queries = read("src/api/queries.ts");
const storyView = read("src/apps/control-plane/story/StoryView.vue");
const workbench = read("src/apps/control-plane/ControlPlaneWorkbench.vue");
const workbenchStyles = read("src/apps/control-plane/ControlPlaneWorkbench.css");

test("Story node load state follows the node agent answer", () => {
  assert.equal(storyNodeLoadState("node-a", undefined), "loading");
  assert.equal(storyNodeLoadState("node-a", { isError: false }), "loading");
  assert.equal(storyNodeLoadState("node-a", { data: { unavailableNodeIds: [] }, isError: false }), "ready");
  assert.equal(storyNodeLoadState("node-a", { data: { unavailableNodeIds: ["node-b"] }, isError: false }), "ready");
  assert.equal(storyNodeLoadState("node-a", { data: { unavailableNodeIds: ["node-a"] }, isError: false }), "unavailable");
  assert.equal(storyNodeLoadState("node-a", { data: { unavailableNodeIds: [] }, isError: true }), "unavailable");
});

test("Story catalog reads one query per node instead of one aggregate request", () => {
  assert.match(queries, /export function storyNodeQueryOptions\(nodeId: string, enabled: MaybeRefOrGetter<boolean> = true\) \{[\s\S]*queryKey: controlPlaneQueryKeys\.stories\(nodeId\)[\s\S]*enabled: Boolean\(nodeId\) && toValue\(enabled\)/);
  assert.match(catalog, /const nodeQueries = useQueries\(\{\n    queries: \(\) => nodeIds\.value\.map\(\(nodeId\) => storyNodeQueryOptions\(nodeId, toValue\(enabled\) && connectionEnabled\(nodeId\)\)\),\n  \}\);/);
  assert.doesNotMatch(catalog, /useStoriesQuery/);
  assert.match(catalog, /const stories = computed<Story\[\]>\(\(\) => nodeIds\.value\.flatMap\(\(_, index\) => nodeQueries\.value\[index\]\?\.data\?\.stories \|\| \[\]\)\);/);
  assert.match(catalog, /const loadingNodeIds = computed\(\(\) => nodeIds\.value\.filter\(\(nodeId\) => nodeLoadState\(nodeId\) === "loading"\)\);/);
  assert.match(catalog, /const unavailableNodeIds = computed\(\(\) => nodeIds\.value\.filter\(\(nodeId\) => nodeLoadState\(nodeId\) === "unavailable"\)\);/);
});

test("Story mutations refetch only the node that owns the Story", async () => {
  assert.match(catalog, /async function refetch\(nodeId\?: string\) \{[\s\S]*\.filter\(\(id\) => !nodeId \|\| id === nodeId\)/);
  assert.match(storyView, /async function load\(nodeId\?: string\) \{[\s\S]*const results = await storyCatalog\.refetch\(nodeId\);[\s\S]*const failure = results\.find\(\(result\) => result\?\.error\)\?\.error;/);
  assert.match(storyView, /async function saveStory\(\) \{[\s\S]*?await load\(story\.ownerNodeId\);/);
  assert.match(storyView, /async function adoptCreatedStory\(story: Story\) \{[\s\S]*?await load\(story\.ownerNodeId\);/);
  assert.doesNotMatch(storyView, /await load\(\);/);
});

test("Story node menu surfaces per-node loading and unavailability", () => {
  assert.match(workbench, /import \{ useStoryCatalog \} from "\.\/story\/useStoryCatalog";/);
  assert.match(workbench, /const storyCatalog = useStoryCatalog\(storyMode\);/);
  assert.match(workbench, /function visibleNodeLoadState\(nodeId: string\): NodeLoadState \{[\s\S]*?agentCatalog\.nodeLoadState\(nodeId\);[\s\S]*?storyCatalog\.nodeLoadState\(nodeId\);/);
  assert.match(workbench, /v-else-if="visibleNodeLoadState\(node\.id\) === 'loading'" class="control-plane-node-filter-menu-load"[\s\S]*nodeLoadLabel\.loading/);
  assert.match(workbench, /v-else-if="visibleNodeLoadState\(node\.id\) === 'unavailable'" class="control-plane-node-filter-menu-load" data-state="warning"[\s\S]*nodeLoadLabel\.unavailable/);
  assert.match(workbench, /t\("stories\.nodeLoad\.loading"\), unavailable: t\("stories\.nodeLoad\.unavailable"\)/);
  assert.match(workbench, /t\("agents\.list\.loadingNode"\), unavailable: t\("agents\.list\.unavailableNode"\)/);
  assert.match(workbenchStyles, /:global\(\.control-plane-node-filter-menu-main\) \{\n  display: grid;\n  grid-template-columns: 8px minmax\(0, 1fr\) auto;/);
  assert.match(workbenchStyles, /:global\(\.control-plane-node-filter-menu-load\) \{[\s\S]*font-size: 12px;/);
  assert.match(workbenchStyles, /:global\(\.control-plane-node-filter-menu-load\[data-state="warning"\]\) \{\n  color: var\(--status-warning\);/);
});

test("Story list footer hints at nodes that are still loading or unavailable", () => {
  assert.match(storyView, /\.story-node-load \{ display:flex; align-items:center; justify-content:center; gap:7px; padding:12px 10px 2px; color:var\(--text-muted\); font-size:12px; \}/);
  assert.match(storyView, /\.story-node-load\[data-state="warning"\] \{ color:var\(--status-warning\); \}/);
  assert.match(storyView, /const storyLoadingNodeIds = computed\(\(\) => storyCatalog\.loadingNodeIds\.value\);/);
  assert.match(storyView, /const storyUnavailableNodeIds = computed\(\(\) => storyCatalog\.unavailableNodeIds\.value\);/);
});


test("pausing a node overrides all cached directory states and excludes it from failure counts", () => {
  for (const query of [undefined, { isError: false }, { isError: true }, { isError: false, data: { unavailableNodeIds: [] } }, { isError: false, data: { unavailableNodeIds: ["paused"] } }]) {
    assert.equal(storyNodeLoadState("paused", query, false), "paused");
  }
  const snapshot = { isError: false, data: { unavailableNodeIds: ["offline", "paused"] } };
  const states = [storyNodeLoadState("paused", snapshot, false), storyNodeLoadState("offline", snapshot, true), storyNodeLoadState("online", snapshot)];
  assert.deepEqual(states, ["paused", "unavailable", "ready"]);
  assert.equal(states.filter((state) => state === "unavailable").length, 1);
  assert.equal(storyNodeLoadState("paused", undefined, true), "loading", "reconnecting resumes loading until an answer arrives");
  assert.equal(storyNodeLoadState("paused", { isError: false, data: { unavailableNodeIds: [] } }, true), "ready");
});

test("paused catalogs stop automatic and explicit requests and use neutral menu/footer status", () => {
  assert.match(catalog, /storyNodeLoadState\(nodeId, nodeQuery\(nodeId\), connectionEnabled\(nodeId\)\)/);
  assert.match(catalog, /const targets = nodeIds\.value[\s\S]*?\.filter\(connectionEnabled\)/);
  assert.match(workbench, /v-if="visibleNodeLoadState\(node\.id\) === 'paused'" class="control-plane-node-filter-menu-load" data-state="paused"/);
  assert.match(storyView, /v-if="storyPausedNodeIds\.length" class="story-node-load" data-state="paused"[\s\S]*?stories\.nodeLoad\.pausedNodes/);
});
