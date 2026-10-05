import type { StoryDecision } from "@task-handoff/protocol/stories";

/**
 * 决策的权威模型只保存 sessionId：实例归属必须从当前加载的会话快照反查，
 * 查不到时调用方按不可用处理，不猜测、也不物化到决策对象上。
 */
export type StoryDecisionSessionInstance = {
  id: string;
  aiSessions: { sessions: readonly { id: string }[] };
};

export function storyDecisionSessionInstance<T extends StoryDecisionSessionInstance>(
  instances: readonly T[],
  decision: Pick<StoryDecision, "sessionId">,
): T | undefined {
  return instances.find((instance) => instance.aiSessions.sessions.some((session) => session.id === decision.sessionId));
}
