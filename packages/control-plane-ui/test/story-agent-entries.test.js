import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");

test("Story settings gate entry Agents through the canonical capability query", () => {
  assert.match(storyView, /!isFeatureEnabled\("agentRuns"\)/);
  assert.match(storyView, /editing && storyAgentEntriesState !== 'hidden'/);
  assert.match(storyView, /controlPlaneAgentCapabilities\(ownerNode\.capabilities\)\.storyEntryAuthorization/);
  assert.match(storyView, /sharedControlPlaneClient\.agents\.storyEntries\(story\.id, story\.ownerNodeId\)/);
  assert.match(storyView, /sharedControlPlaneClient\.agents\.list\(story\.ownerNodeId\)/);
});

test("Story entry Agent saves replace the authoritative set with revision control", () => {
  assert.match(storyView, /updateStoryEntries\(story\.id, story\.ownerNodeId, \{/);
  assert.match(storyView, /expectedRevision: storyAgentEntryRevision\.value/);
  assert.match(storyView, /agentIds: draftStoryAgentIds\.value/);
  assert.match(storyView, /storyAgentEntryRevision\.value = entrySet\.revision/);
  assert.match(storyView, /queryClient\.setQueryData\(controlPlaneQueryKeys\.storyAgentEntries\(story\.ownerNodeId, story\.id\), entrySet\)/);
});

test("missing Story entry references remain visible and removable", () => {
  assert.match(storyView, /entry\.status === "missing-reference"/);
  assert.match(storyView, /missingStoryAgentIds\.value/);
  assert.match(storyView, /toggleStoryAgentEntry\(agent\.id, \$event === true\)/);
  assert.match(storyView, /stories\.editor\.entryAgentMissing/);
});

test("Story settings explain that the allowlist only controls entry Agents", () => {
  assert.match(storyView, /stories\.editor\.entryAgentsScope/);
});
