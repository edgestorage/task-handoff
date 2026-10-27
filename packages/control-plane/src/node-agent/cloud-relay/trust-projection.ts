import type {
  NodeAgentCloudControlPlanePin,
  NodeAgentCloudControlPlaneTrustRequest,
} from "./trust-types.ts";
import type { AccessRepository } from "../persistence/access-repository.ts";
import type {
  NodeAgentControlPlaneTrustPin,
  NodeAgentControlPlaneTrustRequest,
  NodeAgentControlPlaneTrustSnapshot,
} from "@task-handoff/protocol/node-agent-control-plane-trust";
import { nodeAgentControlPlaneComparisonCode } from "../../shared/cloud-relay/node-relay-session.ts";

export function projectNodeAgentControlPlaneTrust(
  repository: AccessRepository,
  snapshot: { nodeId: string; nodeHandle?: string; pins: NodeAgentCloudControlPlanePin[]; requests: NodeAgentCloudControlPlaneTrustRequest[] },
): NodeAgentControlPlaneTrustSnapshot {
  const pins = snapshot.pins.map((pin) => projectPin(repository, pin));
  return {
    nodeId: snapshot.nodeId,
    ...(snapshot.nodeHandle ? { nodeHandle: snapshot.nodeHandle } : {}),
    requests: snapshot.requests.map((request) => projectRequest(repository, request)),
    pins,
  };
}

function accessSummary(value: NodeAgentCloudControlPlanePin | NodeAgentCloudControlPlaneTrustRequest) {
  return {
    accountId: value.accessAccountId,
    ownerAccountId: value.ownerAccountId,
    accessMode: value.accessMode,
    ...(value.shareGrantId ? { shareGrantId: value.shareGrantId } : {}),
    ...(value.shareRole ? { shareRole: value.shareRole } : {}),
    ...(value.shareRevision ? { shareRevision: value.shareRevision } : {}),
  };
}

function comparisonCode(repository: AccessRepository, value: NodeAgentCloudControlPlanePin | NodeAgentCloudControlPlaneTrustRequest) {
  return nodeAgentControlPlaneComparisonCode(value.controlPlaneId, value.controlPlanePublicKey);
}

function projectPin(repository: AccessRepository, pin: NodeAgentCloudControlPlanePin): NodeAgentControlPlaneTrustPin {
  return {
    pinId: pin.id,
    status: pin.status,
    controlPlaneId: pin.controlPlaneId,
    fingerprint: repository.cloudControlPlaneTrustFingerprint(pin.controlPlanePublicKey),
    comparisonCode: comparisonCode(repository, pin),
    nodeHandle: pin.nodeHandle,
    bindingId: pin.bindingId,
    bindingRevision: pin.bindingRevision,
    access: accessSummary(pin),
    approvedAt: pin.approvedAt,
    approvedByActorType: pin.approvedByActorType,
    approvedByActorId: pin.approvedByActorId,
    lastSeenAt: pin.lastSeenAt,
    ...(pin.revokedAt ? { revokedAt: pin.revokedAt } : {}),
    ...(pin.revokeReason ? { revokeReason: pin.revokeReason } : {}),
    revision: pin.authorizationRevision,
  };
}

function projectRequest(repository: AccessRepository, request: NodeAgentCloudControlPlaneTrustRequest): NodeAgentControlPlaneTrustRequest {
  return {
    requestId: request.id,
    status: request.status,
    reason: repository.cloudControlPlaneTrustRequestReason(request),
    controlPlaneId: request.controlPlaneId,
    fingerprint: repository.cloudControlPlaneTrustFingerprint(request.controlPlanePublicKey),
    comparisonCode: comparisonCode(repository, request),
    nodeHandle: request.nodeHandle,
    bindingId: request.bindingId,
    bindingRevision: request.bindingRevision,
    access: accessSummary(request),
    requestedAt: request.requestedAt,
    lastSeenAt: request.lastSeenAt,
    expiresAt: request.expiresAt,
    ...(request.decidedAt ? { decidedAt: request.decidedAt } : {}),
    ...(request.decidedByActorType ? { decidedByActorType: request.decidedByActorType } : {}),
    ...(request.decidedByActorId ? { decidedByActorId: request.decidedByActorId } : {}),
    ...(request.decisionReason ? { decisionReason: request.decisionReason } : {}),
    ...(request.pinId ? { pinId: request.pinId } : {}),
    revision: request.revision,
  };
}
