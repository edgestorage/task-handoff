import type { StoryDecision } from "@task-handoff/protocol/stories";

export type StoryDecisionAnswerInput = { optionId?: string; response?: string };

type Translate = (key: string, values?: Record<string, unknown>) => string;

// 已决策是只读的历史记录：主列表只保留最近 N 条作为上下文，更早的折叠进历史。
export const STORY_DECISION_VISIBLE_DECIDED_LIMIT = 1;

export function splitStoryDecisions(decisions: StoryDecision[]) {
  const visible: StoryDecision[] = [];
  const history: StoryDecision[] = [];
  let decidedSeen = 0;
  for (const decision of decisions) {
    if (decision.status !== "decided") {
      visible.push(decision);
      continue;
    }
    decidedSeen += 1;
    if (decidedSeen <= STORY_DECISION_VISIBLE_DECIDED_LIMIT) visible.push(decision);
    else history.push(decision);
  }
  return { visible, history };
}

export function storyDecisionMeta(decision: StoryDecision, t: Translate) {
  const parts: string[] = [];
  const selected = decision.options.find((option) => option.id === decision.selectedOptionId);
  if (selected) parts.push(t("stories.decisions.selected", { text: selected.label }));
  const response = decision.response?.trim();
  if (response) parts.push(t("stories.decisions.reply", { text: response }));
  if (decision.decidedTurnId) parts.push(t("stories.decisions.decidedTurn"));
  return parts.join(" · ");
}
