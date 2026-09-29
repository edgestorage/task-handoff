import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { storySelectionKey } from "../src/apps/control-plane/story/storySelection.ts";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");

function functionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  assert.fail(`unterminated ${signature}`);
}

test("Story resource selections have stable identity keys", () => {
  assert.equal(storySelectionKey({ kind: "story", ownerNodeId: "node-1", storyId: "story-1" }), "story:node-1:story-1");
  assert.equal(storySelectionKey({ kind: "document", ownerNodeId: "node-1", storyId: "story-1", storyPath: "notes/today.md" }), "document:node-1:story-1:notes/today.md");
  assert.equal(storySelectionKey({ kind: "session", ownerNodeId: "node-1", storyId: "story-1", instanceId: "instance-1", sessionId: "session-1" }), "session:node-1:story-1:instance-1:session-1");
  assert.equal(storySelectionKey(undefined), "");
});

test("the workbench owns Story selection across StoryView remounts", () => {
  assert.match(workbench, /const storySelection = ref<StorySelection>\(\);/);
  assert.match(workbench, /<StoryView[\s\S]*?v-model:selection="storySelection"/);
  assert.match(storyView, /selection\?: StorySelection/);
  assert.match(storyView, /"update:selection": \[selection: StorySelection \| undefined\]/);
});

test("StoryView restores stable selections from current authoritative data", () => {
  assert.match(storyView, /function resolveSelection\(selection: StorySelection \| undefined\): Resource \| undefined/);
  assert.match(storyView, /const restored = resolveSelection\(props\.selection\);[\s\S]*if \(restored\) selectedResource\.value = restored;/);
  assert.match(storyView, /watch\(selectedResource, \(resource\) => \{[\s\S]*emit\("update:selection", selection\);/);
  assert.doesNotMatch(storyView, /emit\("update:selection", resource\)/);
});

test("node or instance outages keep the current selection instead of resetting it", () => {
  // 节点/实例离线只影响置灰与交互可用性，解析选择时不再因为它返回空资源。
  const resolve = functionSource(storyView, "function resolveSelection(");
  assert.doesNotMatch(resolve, /storyIsOnline|sessionIsOnline/);
  assert.match(resolve, /const story = filteredStories\.value\.find\(\(candidate\) => candidate\.id === selection\.storyId/);
  assert.match(resolve, /return entry \? \{ kind: "session", story, entry \} : \{ kind: "story", story \};/);
  const refresh = functionSource(storyView, "function refreshResource(");
  assert.doesNotMatch(refresh, /storyIsOnline/);
  assert.match(refresh, /if \(!story\) return undefined;/);
  // 解析不到目标时保留 workbench 里的选择，不回写空值。
  const publishSelection = functionSource(storyView, "watch(selectedResource, (resource) => {");
  assert.match(publishSelection, /if \(!selection\) return;/);
  assert.match(publishSelection, /emit\("update:selection", selection\);/);
  // 离线节点仍然置灰并阻止发起新选择。
  assert.match(storyView, /function selectStory\(story: Story\) \{ if \(storyIsOnline\(story\)\)/);
  assert.match(storyView, /function selectSession\(story: Story, entry: SessionEntry\) \{ if \(!sessionIsOnline\(story, entry\)\) return;/);
});

test("authoritative Story refreshes preserve an open new-session surface", () => {
  assert.match(storyView, /function refreshResource\(resource: Resource\): Resource \| undefined/);
  assert.match(storyView, /if \(resource\.kind === "new-session"\) return \{ kind: "new-session", story \};/);
  assert.match(storyView, /const refreshed = refreshResource\(resource\);/);
});
