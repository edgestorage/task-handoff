import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { storySelectionKey } from "../src/apps/control-plane/story/storySelection.ts";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");

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

test("StoryView does not restore or retain unavailable detail selections", () => {
  assert.match(storyView, /if \(!story \|\| !storyIsOnline\(story\)\) return undefined;/);
  assert.match(storyView, /entry && sessionIsOnline\(story, entry\) \? \{ kind: "session", story, entry \} : \{ kind: "story", story \}/);
  assert.match(storyView, /watch\(\[filteredStories, \(\) => props\.nodes, \(\) => props\.instances\]/);
  assert.match(storyView, /const firstOnlineStory = stories\.value\.find\(storyIsOnline\);/);
});

test("authoritative Story refreshes preserve an open new-session surface", () => {
  assert.match(storyView, /function refreshResource\(resource: Resource\): Resource \| undefined/);
  assert.match(storyView, /if \(resource\.kind === "new-session"\) return \{ kind: "new-session", story \};/);
  assert.match(storyView, /const refreshed = refreshResource\(resource\);/);
});
