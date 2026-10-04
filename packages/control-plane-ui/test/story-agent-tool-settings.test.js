import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");

test("Story editor exposes only the product-level Agent tool categories", () => {
  for (const category of ["content", "actions", "automations", "aiSessions", "decisions"]) {
    assert.match(storyView, new RegExp(`draftAgentToolPolicy\\.${category}`));
  }
  const policyOptionCount = (storyView.match(/class="story-agent-tool-option"><Checkbox :model-value="draftAgentToolPolicy\./g) || []).length;
  assert.equal(policyOptionCount, 5);
  assert.doesNotMatch(storyView, /story_delete_automation/);
  assert.doesNotMatch(storyView, /story_run_action/);
});

test("Story editor gates policy reads on the normalized node capability", () => {
  assert.match(storyView, /nodeStoryAgentToolCapabilities\(nodeAgentCapabilitiesFromPublicNode\(ownerNode\.capabilities\)\)\.policy/);
  assert.match(storyView, /agentToolSettingsState\.value = ownerNode\?\.status === "online"/);
  assert.match(storyView, /agentToolSettingsState === 'unsupported'/);
  assert.match(storyView, /agentToolSettingsState === 'unavailable'/);
});

test("Story editor saves policy through the shared client and consumes its authoritative response", () => {
  assert.match(storyView, /sharedControlPlaneClient\.stories\.agentToolSettings\(story\.id, story\.ownerNodeId\)/);
  assert.match(storyView, /sharedControlPlaneClient\.stories\.updateAgentToolSettings\(story\.id, story\.ownerNodeId, draftAgentToolPolicy\.value\)/);
  assert.match(storyView, /draftAgentToolPolicy\.value = \{ \.\.\.settings\.policy \}/);
  assert.match(storyView, /savedAgentToolPolicy\.value = \{ \.\.\.settings\.policy \}/);
});
