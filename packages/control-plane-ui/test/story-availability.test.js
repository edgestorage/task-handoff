import assert from "node:assert/strict";
import test from "node:test";
import { isStoryOnline, isStorySessionOnline } from "../src/apps/control-plane/story/storyAvailability.ts";

const story = { ownerNodeId: "node-1" };
const nodes = (status) => [{ id: "node-1", status }];

test("Story detail is available only while its owner node is online", () => {
  assert.equal(isStoryOnline(story, nodes("online")), true);
  for (const status of ["unknown", "offline", "degraded"]) {
    assert.equal(isStoryOnline(story, nodes(status)), false);
  }
  assert.equal(isStoryOnline(story, []), false);
});

test("Story AI Session detail also requires an online instance connection", () => {
  assert.equal(isStorySessionOnline(story, nodes("online"), { connectionStatus: "online" }), true);
  assert.equal(isStorySessionOnline(story, nodes("online"), { connectionStatus: "offline" }), false);
  assert.equal(isStorySessionOnline(story, nodes("offline"), { connectionStatus: "online" }), false);
});
