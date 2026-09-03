import assert from "node:assert/strict";
import test from "node:test";
import { normalizeManualStoryOrder, reorderStoryKeys, sortStories, storyDropTargetAt, storySortKey } from "../src/apps/control-plane/story/storySort.ts";

const story = (id, title, ownerNodeId = "node-1") => ({ id, title, ownerNodeId, documents: [], actions: [], createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" });
const stories = [story("10", "Story 10"), story("2", "Story 2"), story("empty", "Empty")];

test("Story name sorting is natural and stable", () => {
  const result = sortStories(stories, "name", { locale: "en-US", lastUserMessageTimes: new Map(), manualKeys: [] });
  assert.deepEqual(result.map((item) => item.id), ["empty", "2", "10"]);
});

test("Story activity sorting uses the latest user message and leaves empty Stories last", () => {
  const times = new Map([[storySortKey(stories[0]), 10], [storySortKey(stories[1]), 20]]);
  const result = sortStories(stories, "last-user-message", { locale: "en-US", lastUserMessageTimes: times, manualKeys: [] });
  assert.deepEqual(result.map((item) => item.id), ["2", "10", "empty"]);
});

test("manual Story order retains known keys, appends new Stories, and reorders around a target", () => {
  const initial = normalizeManualStoryOrder(stories, [storySortKey(stories[1]), "missing", storySortKey(stories[1])]);
  assert.deepEqual(initial, [storySortKey(stories[1]), storySortKey(stories[0]), storySortKey(stories[2])]);
  assert.deepEqual(reorderStoryKeys(initial, storySortKey(stories[2]), storySortKey(stories[1]), "after"), [storySortKey(stories[1]), storySortKey(stories[2]), storySortKey(stories[0])]);
});

test("Story drop targets use title-row centers rather than expanded subtree heights", () => {
  const rows = [
    { key: "first", top: 10, height: 40 },
    { key: "expanded", top: 200, height: 40 },
    { key: "last", top: 600, height: 40 },
  ];
  assert.deepEqual(storyDropTargetAt(rows, "first", 210), { targetKey: "expanded", placement: "before" });
  assert.deepEqual(storyDropTargetAt(rows, "first", 250), { targetKey: "last", placement: "before" });
  assert.deepEqual(storyDropTargetAt(rows, "first", 700), { targetKey: "last", placement: "after" });
});
