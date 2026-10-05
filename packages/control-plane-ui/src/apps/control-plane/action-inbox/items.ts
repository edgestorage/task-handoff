import type { ApprovalRequest } from "@task-handoff/protocol/operation-approvals";
import type { aiSessionApprovalItems } from "./aiSessionApprovals";
import type { storyDecisionInboxItems } from "./storyDecisionItems";

export type ActionInboxItem = ReturnType<typeof aiSessionApprovalItems>[number] | ReturnType<typeof storyDecisionInboxItems>[number] | {
  type: "operation-approval";
  key: string;
  request: ApprovalRequest;
};

function itemTimestamp(item: ActionInboxItem) {
  if (item.type === "operation-approval") return item.request.createdAt;
  if (item.type === "story-decision") return item.decision.createdAt;
  return item.session.updatedAt;
}

export function mergeActionInboxItems(
  aiItems: ReturnType<typeof aiSessionApprovalItems>,
  requests: ApprovalRequest[],
  storyItems: ReturnType<typeof storyDecisionInboxItems>,
): ActionInboxItem[] {
  return [
    ...aiItems,
    ...storyItems,
    ...requests.map((request) => ({ type: "operation-approval" as const, key: `operation-approval:${request.id}`, request })),
  ].sort((left, right) => itemTimestamp(right).localeCompare(itemTimestamp(left)) || left.key.localeCompare(right.key));
}

export function visibleActionInboxCount(availableHeight: number) {
  return availableHeight < 440 ? 1 : 2;
}

export function visibleActionInboxItems<T>(items: readonly T[], offset: number, count: number): T[] {
  if (!items.length) return [];
  const first = offset % items.length;
  return [...items.slice(first), ...items.slice(0, first)].slice(0, count);
}
