import type { StoryDecision } from '@task-handoff/protocol/stories';
import type { Translate } from '../i18n';

export type StoryDecisionAnswerInput = { optionId?: string; response?: string };

/**
 * 兼容 v0.0.33 及更早的受管实例：处于 resuming 的决策必须由调用方显式确认后才能重发。
 */
export function isStoryDecisionResumePending(cause: unknown) {
  return Boolean(cause && typeof cause === 'object' && (cause as { code?: string }).code === 'STORY_DECISION_RESUME_PENDING');
}

/** 决策的权威归属是 sessionId：会话内提示只呈现当前会话自己的待决策。 */
export function pendingStoryDecisionsForSession(decisions: readonly StoryDecision[], sessionId: string) {
  return decisions.filter((decision) => decision.status === 'pending' && decision.sessionId === sessionId);
}

/** 决策只保存 sessionId：实例归属从当前会话快照反查，查不到时按不可用处理。 */
export function storyDecisionInstanceId(
  instances: readonly { instanceId: string; aiSessions: { sessions: readonly { id: string }[] } }[],
  decision: Pick<StoryDecision, 'sessionId'>,
) {
  return instances.find((instance) => instance.aiSessions.sessions.some((session) => session.id === decision.sessionId))?.instanceId;
}

// 已决策是只读的历史记录：主列表只保留最近 N 条作为上下文，更早的折叠进历史。
export const STORY_DECISION_VISIBLE_DECIDED_LIMIT = 1;

export function splitStoryDecisions(decisions: readonly StoryDecision[]) {
  const visible: StoryDecision[] = [];
  const history: StoryDecision[] = [];
  let decidedSeen = 0;
  for (const decision of decisions) {
    if (decision.status !== 'decided') {
      visible.push(decision);
      continue;
    }
    decidedSeen += 1;
    if (decidedSeen <= STORY_DECISION_VISIBLE_DECIDED_LIMIT) visible.push(decision);
    else history.push(decision);
  }
  return { visible, history };
}

/** 只读历史只展示已决策的答案与回复，保留同一份展示口径给 Story 决策区。 */
export function storyDecisionMeta(decision: StoryDecision, t: Translate) {
  const parts: string[] = [];
  const selected = decision.options.find((option) => option.id === decision.selectedOptionId);
  if (selected) parts.push(t('stories.decisionSelected', { text: selected.label }));
  const response = decision.response?.trim();
  if (response) parts.push(t('stories.decisionReply', { text: response }));
  if (decision.status === 'expired' && decision.expiredReason) parts.push(decision.expiredReason.message);
  return parts.join(' · ');
}
