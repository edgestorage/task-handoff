import assert from "node:assert/strict";
import test from "node:test";
import { mergeActionInboxItems, visibleActionInboxCount, visibleActionInboxItems } from "../src/apps/control-plane/action-inbox/items.ts";

test("AI session, Story decision and operation approvals share a stable sorted inbox", () => {
  const session = { type: "ai-session-approval", key: "ai:one", session: { updatedAt: "2026-01-01T00:00:00.000Z" } };
  const request = { id: "approval-one", operation: "node.remove", targetId: "node-one", createdAt: "2026-01-02T00:00:00.000Z", expiresAt: "2026-01-02T00:05:00.000Z" };
  const storyDecision = { type: "story-decision", key: "story-decision:node-a:story-1:decision-1", story: { id: "story-1" }, decision: { createdAt: "2026-01-03T00:00:00.000Z" } };
  assert.deepEqual(mergeActionInboxItems([session], [request], [storyDecision]).map((item) => item.key), ["story-decision:node-a:story-1:decision-1", "operation-approval:approval-one", "ai:one"]);
  assert.deepEqual(mergeActionInboxItems([], [], []).map((item) => item.key), []);
});

test("every stacked item remains reachable while at most two cards are complete", () => {
  const items = ["one", "two", "three", "four", "five"];
  const visible = new Set();
  for (let offset = 0; offset < items.length; offset += 2) {
    for (const item of visibleActionInboxItems(items, offset, visibleActionInboxCount(600))) visible.add(item);
  }
  assert.deepEqual([...visible], items);
  assert.equal(visibleActionInboxCount(200), 1);
  assert.equal(visibleActionInboxCount(420), 1);
  assert.equal(visibleActionInboxCount(500), 2);
  assert.deepEqual(visibleActionInboxItems([], 0, 2), []);
});
