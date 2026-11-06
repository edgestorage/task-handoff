import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS,
  AiSessionToolActivityWindowSchema,
} from "@task-handoff/protocol/ai-sessions";

test("bounded tool activity windows stay strict and activity-only", () => {
  const activity = (index: number) => ({
    id: `command-${index}`,
    turnId: "turn-1",
    type: "activity",
    activityKind: "commandExecution",
    title: "Command",
  });
  const window = {
    sessionId: "session-1",
    turnId: "turn-1",
    revision: "revision-1",
    boundaryItemId: "message-1",
    items: Array.from({ length: AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS }, (_, index) => activity(index)),
    total: 55,
    truncated: true,
    generatedAt: "2026-11-06T00:00:00.000Z",
  };
  assert.equal(AiSessionToolActivityWindowSchema.safeParse(window).success, true);
  assert.equal(AiSessionToolActivityWindowSchema.safeParse({
    ...window,
    items: [...window.items, activity(50)],
  }).success, false);
  assert.equal(AiSessionToolActivityWindowSchema.safeParse({
    ...window,
    items: [{ id: "message-2", turnId: "turn-1", type: "ai-message", text: "Not activity" }],
  }).success, false);
  assert.equal(AiSessionToolActivityWindowSchema.safeParse({ ...window, unexpected: true }).success, false);
});
