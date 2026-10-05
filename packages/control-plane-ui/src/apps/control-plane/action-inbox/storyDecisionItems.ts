import { nodeAgentCapabilitiesFromPublicNode, nodeStoryAgentToolCapabilities } from "@task-handoff/protocol/node-agent-capabilities";
import type { Story, StoryDecision } from "@task-handoff/protocol/stories";

export type StoryDecisionEntry = { story: Story; decisions: readonly StoryDecision[] };

/** 只有声明 decisions 能力的节点会产生 Story 决策；能力缺失即该节点不参与入箱。 */
export function storyDecisionNodes<T extends { id: string; capabilities: unknown }>(nodes: readonly T[]): T[] {
  return nodes.filter((node) => nodeStoryAgentToolCapabilities(nodeAgentCapabilitiesFromPublicNode(node.capabilities)).decisions);
}

export type StoryDecisionInboxItem = {
  type: "story-decision";
  key: string;
  story: Story;
  decision: StoryDecision;
};

export type StoryDecisionList = { decisions: StoryDecision[] };

/** 审批中心只收纳仍可回答的决策：已决策、已取消、已失效和已归档 Story 都不入箱。 */
export function storyDecisionInboxItems(entries: readonly StoryDecisionEntry[]): StoryDecisionInboxItem[] {
  return entries.flatMap(({ story, decisions }) => story.archivedAt ? [] : decisions
    .filter((decision) => decision.status === "pending")
    .map((decision) => ({
      type: "story-decision" as const,
      key: `story-decision:${story.ownerNodeId}:${story.id}:${decision.id}`,
      story,
      decision,
    })))
    .sort((left, right) => right.decision.createdAt.localeCompare(left.decision.createdAt) || left.key.localeCompare(right.key));
}

/** 兼容 v0.0.33 及更早的受管实例：处于 resuming 的决策必须由调用方显式确认后才能重发。 */
export function isStoryDecisionResumePending(cause: unknown) {
  return Boolean(cause && typeof cause === "object" && (cause as { code?: string }).code === "STORY_DECISION_RESUME_PENDING");
}

/** 会话内提示已直接展示的决策不再重复出现在右上角浮层；其他会话的决策保持可见。 */
export function storyDecisionItemsOutsideSessionDisplay(
  items: readonly StoryDecisionInboxItem[],
  displayedDecisionIds: ReadonlySet<string>,
) {
  if (!displayedDecisionIds.size) return [...items];
  return items.filter((item) => !displayedDecisionIds.has(item.decision.id));
}

/** 提交后把权威响应写回决策缓存，保证面板、左树与审批中心消费同一份快照。 */
export function applyStoryDecisionUpdate(current: StoryDecisionList | undefined, updated: StoryDecision) {
  if (!current) return current;
  const decisions = current.decisions.some((decision) => decision.id === updated.id)
    ? current.decisions.map((decision) => (decision.id === updated.id ? updated : decision))
    : [...current.decisions, updated];
  return { decisions };
}
