import type { NodeAgentControlPlaneAccessContext } from "@task-handoff/protocol/node-relay-channel";

export type NodeAgentControlPlaneTrustActorType = "local" | "control-plane" | "system";

export type NodeAgentControlPlaneTrustActor = {
  type: NodeAgentControlPlaneTrustActorType;
  id: string;
  /** Diagnostic only. The authenticated HMAC key decides the calling CP. */
  connectionType?: string;
};

export type NodeAgentCloudControlPlaneTrustContext = NodeAgentControlPlaneAccessContext & {
  nodeId: string;
  nodeHandle: string;
  controlPlaneId: string;
  controlPlanePublicKey: string;
  bindingId: string;
  bindingRevision: number;
};

export type NodeAgentCloudControlPlanePin = {
  id: string;
  nodeId: string;
  nodeHandle: string;
  controlPlaneId: string;
  controlPlanePublicKey: string;
  bindingId: string;
  bindingRevision: number;
  accessAccountId: string;
  ownerAccountId: string;
  accessMode: "owner" | "shared";
  shareGrantId?: string;
  shareRole?: "use";
  shareRevision?: number;
  status: "active" | "revoked";
  approvedByActorType: NodeAgentControlPlaneTrustActorType;
  approvedByActorId: string;
  approvedAt: string;
  lastSeenAt: string;
  revokedAt?: string;
  revokeReason?: string;
  authorizationRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type NodeAgentCloudControlPlaneTrustRequest = {
  id: string;
  nodeId: string;
  nodeHandle: string;
  controlPlaneId: string;
  controlPlanePublicKey: string;
  bindingId: string;
  bindingRevision: number;
  accessAccountId: string;
  ownerAccountId: string;
  accessMode: "owner" | "shared";
  shareGrantId?: string;
  shareRole?: "use";
  shareRevision?: number;
  status: "pending" | "approved" | "rejected" | "expired";
  requestedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedByActorType?: NodeAgentControlPlaneTrustActorType;
  decidedByActorId?: string;
  decisionReason?: string;
  pinId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type NodeAgentCloudControlPlaneTrustObservation =
  | { kind: "active"; pin: NodeAgentCloudControlPlanePin }
  | { kind: "pending"; request: NodeAgentCloudControlPlaneTrustRequest; reason: "first-seen" | "key-changed" | "access-context-changed" }
  | { kind: "rejected"; request: NodeAgentCloudControlPlaneTrustRequest }
  | { kind: "expired"; request: NodeAgentCloudControlPlaneTrustRequest };

export type NodeAgentCloudControlPlaneTrustDecision = {
  action: "approve" | "reject";
  requestId: string;
  expectedFingerprint: string;
  expectedRevision: number;
  reason?: string;
  /** Only an explicit administrator choice may keep an older key active. */
  retainPreviousKey?: boolean;
  actor: NodeAgentControlPlaneTrustActor;
};

export type NodeAgentCloudControlPlaneTrustDecisionResult = {
  request: NodeAgentCloudControlPlaneTrustRequest;
  pin?: NodeAgentCloudControlPlanePin;
  revokedPins: NodeAgentCloudControlPlanePin[];
};

export type NodeAgentCloudControlPlaneRevokeInput = {
  pinId: string;
  expectedFingerprint: string;
  expectedRevision: number;
  reason?: string;
  actor: NodeAgentControlPlaneTrustActor;
};
