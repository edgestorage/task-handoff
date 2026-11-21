import type { AiSessionLifecycle, AiSessionPhase, AiSessionTool } from "../../api/types";
import type { Translate } from "../../i18n/status";

export function aiSessionActivityText(
  activity: {
    currentTool?: AiSessionTool;
    phase?: AiSessionPhase;
    status?: AiSessionLifecycle;
    summary?: string;
    toolCallsSinceLastMessage?: number;
  },
  t: Translate,
) {
  const count = Math.max(0, activity.toolCallsSinceLastMessage || 0);
  if (activity.phase === "approval") {
    return activity.summary
      ? `${t("sessions.status.waitingApproval")} · ${activity.summary}`
      : t("sessions.activity.waitingApproval");
  }
  if (activity.currentTool?.name) {
    return activity.currentTool.inputPreview
      ? `${activity.currentTool.name} · ${activity.currentTool.inputPreview}`
      : activity.currentTool.name;
  }
  if (activity.phase === "responding") {
    return count > 0
      ? t("sessions.activity.respondingTools", { count })
      : t("sessions.activity.responding");
  }
  if (activity.phase === "editing") return t("sessions.activity.editing");
  if (activity.status === "waiting") return t("sessions.activity.waiting");
  return count > 0
    ? t("sessions.activity.thinkingTools", { count })
    : t("sessions.activity.thinking");
}
