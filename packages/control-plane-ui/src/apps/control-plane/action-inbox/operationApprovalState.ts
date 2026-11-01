import {
  ApprovalChangedEventSchema,
  OPERATION_APPROVAL_PERMISSION,
  type ApprovalSnapshot,
  type ApprovalChangedEvent,
} from "@task-handoff/protocol/operation-approvals";

export function canReadOperationApprovals(session: {
  authenticated: boolean;
  enabled: boolean;
  user?: { id: string };
  authorization?: { permissionIds: string[] };
} | undefined) {
  if (!session) return false;
  if (!session.authenticated) return false;
  if (session.authorization) return session.authorization.permissionIds.includes(OPERATION_APPROVAL_PERMISSION);
  // Compatibility for older disabled-mode servers that did not expose a local
  // operator in the session response.
  return !session.enabled;
}

export function applyOperationApprovalEvent(snapshot: ApprovalSnapshot, input: unknown): ApprovalSnapshot {
  const parsed = ApprovalChangedEventSchema.safeParse(input);
  if (!parsed.success
    || (snapshot.generation !== "" && parsed.data.generation !== snapshot.generation)
    || parsed.data.revision <= snapshot.revision) return snapshot;
  const event: ApprovalChangedEvent = parsed.data;
  const requests = snapshot.requests.filter((request) => request.id !== event.request.id);
  if (event.status === "pending") requests.push(event.request);
  return { generation: event.generation, revision: event.revision, requests };
}

export function applyOperationApprovalSnapshot(current: ApprovalSnapshot, incoming: ApprovalSnapshot): ApprovalSnapshot {
  return incoming.generation !== current.generation || incoming.revision >= current.revision ? incoming : current;
}

export function operationApprovalEventNeedsRecovery(snapshot: ApprovalSnapshot, input: unknown) {
  const parsed = ApprovalChangedEventSchema.safeParse(input);
  return parsed.success && snapshot.generation !== "" && parsed.data.generation !== snapshot.generation;
}
