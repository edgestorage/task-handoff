import assert from "node:assert/strict";
import test from "node:test";
import {
  StoryAgentEntrySetSchema,
  StoryAgentEntrySetUpdateInputSchema,
  sanitizeStoryAgentEntrySet,
} from "../src/story-agent-authorization.ts";

const revision = "a".repeat(64);

test("Story Agent entry writes are strict and expose only stable references", () => {
  assert.throws(() => StoryAgentEntrySetUpdateInputSchema.parse({
    expectedRevision: revision,
    agentIds: ["agent_one"],
    nodeId: "node_one",
  }));
  const parsed = StoryAgentEntrySetSchema.parse({
    storyId: "story_one",
    revision,
    entries: [{ agentId: "agent_one", orchestrationId: "default:agent_one", status: "available" }],
  });
  assert.equal((parsed as Record<string, unknown>).ownerNodeId, undefined);
  assert.deepEqual(parsed.entries, [{ agentId: "agent_one", orchestrationId: "default:agent_one", status: "available" }]);
});

test("Story Agent entry reads ignore additive unknown fields", () => {
  assert.deepEqual(sanitizeStoryAgentEntrySet({
    storyId: "story_one",
    revision,
    entries: [{ agentId: "agent_missing", orchestrationId: "orchestration_custom", status: "missing-reference", future: true }],
    future: true,
  }), {
    storyId: "story_one",
    revision,
    entries: [{ agentId: "agent_missing", orchestrationId: "orchestration_custom", status: "missing-reference" }],
  });
});
