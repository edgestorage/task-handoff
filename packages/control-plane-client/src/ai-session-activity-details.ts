import type { AiSessionTimelineActivity } from "@task-handoff/protocol/ai-sessions";

export function aiSessionActivityDetailInput(activity: AiSessionTimelineActivity) {
  if (activity.input) return activity.input;
  const kind = activity.activityKind;
  if (kind === "fileRead" || kind === "fileSearch" || kind === "fileList" || kind === "explore" || kind === "webSearch") {
    return activity.summary || activity.paths?.join("\n");
  }
  return undefined;
}
