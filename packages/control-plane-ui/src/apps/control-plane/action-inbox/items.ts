import type { ApprovalRequest } from "@task-handoff/protocol/operation-approvals";
import type { aiSessionApprovalItems } from "./aiSessionApprovals";

export type ActionInboxItem = ReturnType<typeof aiSessionApprovalItems>[number] | {
  type: "operation-approval";
  key: string;
  request: ApprovalRequest;
};

export function mergeActionInboxItems(aiItems: ReturnType<typeof aiSessionApprovalItems>, requests: ApprovalRequest[]): ActionInboxItem[] {
  return [
    ...aiItems,
    ...requests.map((request) => ({ type: "operation-approval" as const, key: `operation-approval:${request.id}`, request })),
  ].sort((left, right) => (right.type === "operation-approval" ? right.request.createdAt : right.session.updatedAt)
    .localeCompare(left.type === "operation-approval" ? left.request.createdAt : left.session.updatedAt) || left.key.localeCompare(right.key));
}

export function visibleActionInboxCount(availableHeight: number) {
  return availableHeight < 440 ? 1 : 2;
}

export function visibleActionInboxItems<T>(items: readonly T[], offset: number, count: number): T[] {
  if (!items.length) return [];
  const first = offset % items.length;
  return [...items.slice(first), ...items.slice(0, first)].slice(0, count);
}
