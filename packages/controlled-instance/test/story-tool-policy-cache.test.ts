import assert from "node:assert/strict";
import test from "node:test";
import { StoryToolPolicyCache } from "../src/web/story-tool-policy-cache.ts";

const firstRevision = "a".repeat(64);
const secondRevision = "b".repeat(64);

test("Story tool policy cache is runtime-only and revision-aware", () => {
  const cache = new StoryToolPolicyCache();
  cache.remember({
    storyId: "story_one",
    policy: { content: true, actions: false, automations: false, aiSessions: false },
    revision: firstRevision,
    enabledTools: ["story_list_content", "story_get_content", "story_set_content"],
  });

  assert.equal(cache.invalidate({ storyId: "story_one", revision: firstRevision }), false);
  assert.equal(cache.get("story_one")?.revision, firstRevision);
  assert.equal(cache.invalidate({ storyId: "story_one", revision: secondRevision }), true);
  assert.equal(cache.get("story_one"), undefined);
});
