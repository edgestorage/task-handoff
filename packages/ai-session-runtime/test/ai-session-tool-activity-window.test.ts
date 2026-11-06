import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS,
  type AiSessionTimelineActivity,
  type AiSessionTimelineItem,
  type AiSessionTurnTimeline,
} from "@task-handoff/protocol/ai-sessions";
import { aiSessionToolActivityWindow } from "../src/ai-session-tool-activity-window.ts";

function activity(id: string): AiSessionTimelineActivity {
  return {
    id,
    turnId: "turn-1",
    type: "activity",
    activityKind: "commandExecution",
    title: "Command",
    status: "completed",
  };
}

function message(id: string): AiSessionTimelineItem {
  return { id, turnId: "turn-1", type: "ai-message", text: "Done" };
}

function timeline(items: AiSessionTimelineItem[]): AiSessionTurnTimeline {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    items,
    generatedAt: "2026-11-06T00:00:00.000Z",
  };
}

test("tool activity window only includes activities after the latest AI message", () => {
  const window = aiSessionToolActivityWindow(timeline([
    activity("before"),
    message("message-1"),
    activity("first-tail"),
    message("message-2"),
    activity("tail-1"),
    activity("tail-2"),
  ]));
  assert.equal(window.boundaryItemId, "message-2");
  assert.deepEqual(window.items.map((item) => item.id), ["tail-1", "tail-2"]);
  assert.equal(window.total, 2);
  assert.equal(window.truncated, false);
  assert.equal(window.revision, aiSessionToolActivityWindow(timeline([
    activity("before"),
    message("message-1"),
    activity("first-tail"),
    message("message-2"),
    activity("tail-1"),
    activity("tail-2"),
  ])).revision);
});

test("tool activity window keeps the latest 50 activities and reports the complete total", () => {
  const window = aiSessionToolActivityWindow(timeline([
    message("message-1"),
    ...Array.from({ length: 55 }, (_, index) => activity(`tail-${index}`)),
  ]));
  assert.equal(window.items.length, AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS);
  assert.equal(window.items[0].id, "tail-5");
  assert.equal(window.total, 55);
  assert.equal(window.truncated, true);
});
