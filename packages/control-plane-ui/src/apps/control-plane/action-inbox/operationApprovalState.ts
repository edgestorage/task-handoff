import { ApprovalChangedEventSchema, type ApprovalSnapshot, type ApprovalChangedEvent } from "@task-handoff/protocol/operation-approvals";

export function applyOperationApprovalEvent(snapshot: ApprovalSnapshot, input: unknown): ApprovalSnapshot {
  const parsed = ApprovalChangedEventSchema.safeParse(input);
  if (!parsed.success || parsed.data.revision <= snapshot.revision) return snapshot;
  const event: ApprovalChangedEvent = parsed.data;
  const requests = snapshot.requests.filter((request) => request.id !== event.request.id);
  if (event.status === "pending") requests.push(event.request);
  return { revision: event.revision, requests };
}

export function applyOperationApprovalSnapshot(current: ApprovalSnapshot, incoming: ApprovalSnapshot): ApprovalSnapshot {
  return incoming.revision >= current.revision ? incoming : current;
}
