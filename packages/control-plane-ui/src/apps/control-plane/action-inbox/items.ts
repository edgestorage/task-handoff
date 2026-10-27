import type { ApprovalRequest } from "@task-handoff/protocol/operation-approvals";
import type { CloudDeviceTrustRequest, CloudDeviceTrustRoleOption, CloudDeviceTrustSnapshot } from "@task-handoff/protocol/device-trust";
import type { NodeAgentControlPlaneTrustRequest } from "@task-handoff/protocol/node-agent-control-plane-trust";
import type { CloudNodeRelayTrust } from "../../../api/types";
import type { aiSessionApprovalItems } from "./aiSessionApprovals";
import type { storyDecisionInboxItems } from "./storyDecisionItems";

export type ActionInboxItem = ReturnType<typeof aiSessionApprovalItems>[number] | ReturnType<typeof storyDecisionInboxItems>[number] | {
  type: "operation-approval";
  key: string;
  request: ApprovalRequest;
} | {
  type: "device-trust";
  key: string;
  request: CloudDeviceTrustRequest;
  roles: CloudDeviceTrustRoleOption[];
} | {
  type: "node-control-plane-trust";
  key: string;
  nodeId: string;
  trust: CloudNodeRelayTrust;
};

function itemTimestamp(item: ActionInboxItem) {
  if (item.type === "operation-approval") return item.request.createdAt;
  if (item.type === "story-decision") return item.decision.createdAt;
  if (item.type === "device-trust") return item.request.requestedAt;
  if (item.type === "node-control-plane-trust") return item.trust.requestedAt;
  return item.session.updatedAt;
}

export function mergeActionInboxItems(
  aiItems: ReturnType<typeof aiSessionApprovalItems>,
  requests: ApprovalRequest[],
  storyItems: ReturnType<typeof storyDecisionInboxItems>,
  deviceTrust?: CloudDeviceTrustSnapshot,
  nodeControlPlaneTrust: CloudNodeRelayTrust[] = [],
): ActionInboxItem[] {
  return [
    ...aiItems,
    ...storyItems,
    ...requests.map((request) => ({ type: "operation-approval" as const, key: `operation-approval:${request.id}`, request })),
    ...deviceTrustInboxItems(deviceTrust),
    ...nodeControlPlaneTrustInboxItems(nodeControlPlaneTrust),
  ].sort((left, right) => itemTimestamp(right).localeCompare(itemTimestamp(left)) || left.key.localeCompare(right.key));
}

export function deviceTrustInboxItems(snapshot: CloudDeviceTrustSnapshot | undefined): Array<Extract<ActionInboxItem, { type: "device-trust" }>> {
  if (!snapshot) return [];
  return snapshot.requests
    .filter((request) => request.status === "pending")
    .map((request) => ({
      type: "device-trust" as const,
      key: `device-trust:${request.requestId}`,
      request,
      roles: snapshot.roles,
    }));
}

export function nodeControlPlaneTrustInboxItems(trust: readonly CloudNodeRelayTrust[]): Array<Extract<ActionInboxItem, { type: "node-control-plane-trust" }>> {
  return trust
    .filter((item) => item.state === "pending" && Boolean(item.requestId))
    .map((item) => ({
      type: "node-control-plane-trust" as const,
      key: `node-control-plane-trust:${item.nodeId}:${item.requestId || item.observedAt}`,
      nodeId: item.nodeId,
      trust: item,
    }));
}

export function nodeControlPlaneTrustProjection(
  node: { id: string; name: string },
  request: NodeAgentControlPlaneTrustRequest,
): CloudNodeRelayTrust {
  return {
    nodeHandle: request.nodeHandle,
    nodeId: node.id,
    displayName: node.name,
    state: request.status === "pending" ? "pending" : request.status === "expired" ? "expired" : "rejected",
    reason: request.reason,
    controlPlaneId: request.controlPlaneId,
    controlPlaneFingerprint: request.fingerprint,
    comparisonCode: request.comparisonCode,
    requestId: request.requestId,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    observedAt: request.lastSeenAt,
  };
}

export function visibleActionInboxCount(availableHeight: number) {
  return availableHeight < 440 ? 1 : 2;
}

export function visibleActionInboxItems<T>(items: readonly T[], offset: number, count: number): T[] {
  if (!items.length) return [];
  const first = offset % items.length;
  return [...items.slice(first), ...items.slice(0, first)].slice(0, count);
}
