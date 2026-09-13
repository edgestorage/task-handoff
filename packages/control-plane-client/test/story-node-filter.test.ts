import assert from "node:assert/strict";
import test from "node:test";
import {
  allStoryNodes,
  normalizeStoryNodeFilter,
  selectOnlyStoryNode,
  storyNodeIsVisible,
  toggleStoryNode,
} from "../src/story-node-filter.ts";

test("normalizes Story node selections against the authoritative directory order", () => {
  assert.deepEqual(
    normalizeStoryNodeFilter({ kind: "selected", nodeIds: ["node-c", "missing", "node-a", "node-a"] }, ["node-a", "node-b", "node-c"]),
    { kind: "selected", nodeIds: ["node-a", "node-c"] },
  );
  assert.deepEqual(normalizeStoryNodeFilter({ kind: "selected", nodeIds: ["missing"] }, ["node-a"]), allStoryNodes());
  assert.deepEqual(normalizeStoryNodeFilter({ kind: "selected", nodeIds: ["node-a", "node-b"] }, ["node-a", "node-b"]), allStoryNodes());
});

test("toggles a multi-node Story selection without changing visibility semantics", () => {
  const selected = toggleStoryNode(selectOnlyStoryNode("node-a"), "node-c", true, ["node-a", "node-b", "node-c"]);
  assert.deepEqual(selected, { kind: "selected", nodeIds: ["node-a", "node-c"] });
  assert.equal(storyNodeIsVisible(selected, "node-a"), true);
  assert.equal(storyNodeIsVisible(selected, "node-b"), false);
  assert.equal(storyNodeIsVisible(selected, "node-c"), true);
});
