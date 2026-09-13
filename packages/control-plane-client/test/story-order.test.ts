import assert from "node:assert/strict";
import test from "node:test";
import type { Story } from "@task-handoff/protocol/stories";
import { normalizeManualStoryOrder, reorderStoryKeys } from "../src/story-order.ts";

const story = (id: string, ownerNodeId: string): Story => ({
  id,
  ownerNodeId,
  title: id,
  actions: [],
  documents: [],
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
});

test("normalizes manual Story order across nodes without losing new Stories", () => {
  const stories = [story("a", "node-a"), story("b", "node-b"), story("c", "node-a")];
  assert.deepEqual(normalizeManualStoryOrder(stories, ["node-b:b", "missing", "node-b:b"]), ["node-b:b", "node-a:a", "node-a:c"]);
});

test("moves a Story relative to another while preserving the complete order", () => {
  assert.deepEqual(
    reorderStoryKeys(["node-a:a", "node-b:b", "node-a:c"], "node-a:a", "node-a:c", "after"),
    ["node-b:b", "node-a:c", "node-a:a"],
  );
});
