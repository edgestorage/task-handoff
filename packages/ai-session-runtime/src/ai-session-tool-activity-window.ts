import { createHash } from "node:crypto";
import {
  AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS,
  type AiSessionTimelineActivity,
  type AiSessionToolActivityWindow,
  type AiSessionTurnTimeline,
} from "@task-handoff/protocol/ai-sessions";

/**
 * Projects the bounded activity tail that the compact tool-activity disclosure
 * needs. This intentionally runs on the adapter boundary so clients never have
 * to fetch a complete Turn Timeline just to render the latest tool run.
 */
export function aiSessionToolActivityWindow(timeline: AiSessionTurnTimeline): AiSessionToolActivityWindow {
  let boundaryIndex = -1;
  for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
    if (timeline.items[index].type === "ai-message") {
      boundaryIndex = index;
      break;
    }
  }
  const boundary = boundaryIndex >= 0 ? timeline.items[boundaryIndex] : undefined;
  const activities = timeline.items
    .slice(boundaryIndex + 1)
    .filter((item): item is AiSessionTimelineActivity => item.type === "activity");
  const items = activities.slice(-AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS);
  const revision = createHash("sha256")
    .update(JSON.stringify({ boundaryItemId: boundary?.id, items }))
    .digest("base64url")
    .slice(0, 22);
  return {
    sessionId: timeline.sessionId,
    turnId: timeline.turnId,
    revision,
    ...(boundary ? { boundaryItemId: boundary.id } : {}),
    items,
    total: activities.length,
    truncated: activities.length > items.length,
    generatedAt: timeline.generatedAt,
  };
}
