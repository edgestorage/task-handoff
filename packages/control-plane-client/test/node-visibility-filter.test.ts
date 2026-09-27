import assert from "node:assert/strict";
import test from "node:test";
import {
  allNodesVisible,
  nodeIsVisible,
  normalizeNodeVisibilityFilter,
  selectOnlyNode,
  toggleNodeVisibility,
} from "../src/node-visibility-filter.ts";

test("normalizes node selections against the authoritative directory order", () => {
  assert.deepEqual(
    normalizeNodeVisibilityFilter({ kind: "selected", nodeIds: ["node-c", "missing", "node-a", "node-a"] }, ["node-a", "node-b", "node-c"]),
    { kind: "selected", nodeIds: ["node-a", "node-c"] },
  );
  assert.deepEqual(normalizeNodeVisibilityFilter({ kind: "selected", nodeIds: ["missing"] }, ["node-a"]), allNodesVisible());
  assert.deepEqual(normalizeNodeVisibilityFilter({ kind: "selected", nodeIds: ["node-a", "node-b"] }, ["node-a", "node-b"]), allNodesVisible());
});

test("toggles a multi-node selection without changing visibility semantics", () => {
  const selected = toggleNodeVisibility(selectOnlyNode("node-a"), "node-c", true, ["node-a", "node-b", "node-c"]);
  assert.deepEqual(selected, { kind: "selected", nodeIds: ["node-a", "node-c"] });
  assert.equal(nodeIsVisible(selected, "node-a"), true);
  assert.equal(nodeIsVisible(selected, "node-b"), false);
  assert.equal(nodeIsVisible(selected, "node-c"), true);
});
