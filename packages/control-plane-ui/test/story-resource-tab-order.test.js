import assert from "node:assert/strict";
import test from "node:test";
import { reorderStoryResourceKeys, storyResourceDropTargetAt } from "../src/apps/control-plane/story/storyResourceOrder.ts";

test("Story resource tab ordering can advance and return across the same target", () => {
  const order = ["first", "second", "third"];

  assert.deepEqual(reorderStoryResourceKeys(order, "second", "third", "after"), ["first", "third", "second"]);
  assert.equal(reorderStoryResourceKeys(order, "second", "third", "before"), order);
  assert.deepEqual(reorderStoryResourceKeys(order, "third", "second", "before"), ["first", "third", "second"]);
  assert.equal(reorderStoryResourceKeys(order, "third", "second", "after"), order);
  assert.equal(reorderStoryResourceKeys(order, "missing", "third", "after"), order);
  assert.equal(reorderStoryResourceKeys(order, "second", "second", "after"), order);
});

test("Story resource drop target changes side when the pointer returns across a tab midpoint", () => {
  const targets = [{ key: "first", midpoint: 50 }, { key: "third", midpoint: 150 }];

  assert.deepEqual(storyResourceDropTargetAt(targets, 160), { key: "third", placement: "after" });
  assert.deepEqual(storyResourceDropTargetAt(targets, 140), { key: "third", placement: "before" });
  assert.deepEqual(storyResourceDropTargetAt(targets, 40), { key: "first", placement: "before" });
  assert.equal(storyResourceDropTargetAt([], 100), undefined);
});
