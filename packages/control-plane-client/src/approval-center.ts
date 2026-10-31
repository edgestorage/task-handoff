import type {
  ControlPlaneAiSessionsSnapshot,
} from "./ai-sessions.ts";
import type { ControlPlaneAiSessionSummary } from "./ai-sessions.ts";
import { isAiSessionApprovalPending } from "./ai-session-state.ts";
import { directoryAiSessionProviderCapability } from "@task-handoff/protocol/control-plane-directory";
import type { ApprovalRequest } from "@task-handoff/protocol/operation-approvals";
import type { CloudDeviceTrustRequest, CloudDeviceTrustRoleOption, CloudDeviceTrustSnapshot } from "@task-handoff/protocol/device-trust";
import type { NodeAgentControlPlaneTrustRequest, NodeAgentControlPlaneTrustSnapshot } from "@task-handoff/protocol/node-agent-control-plane-trust";
import type { Story, StoryDecision } from "@task-handoff/protocol/stories";
import {
  nodeAgentCapabilitiesFromPublicNode,
  nodeStoryAgentToolCapabilities,
} from "@task-handoff/protocol/node-agent-capabilities";

/** Platform-neutral source discriminator used only by approval-center consumers. */
export type ApprovalCenterSource =
  | "ai-session-approval"
  | "story-decision"
  | "operation-approval"
  | "device-trust"
  | "node-control-plane-trust";

export type AiSessionApprovalDecision = "allow" | "deny" | "skip";

type AiSessionApprovalSourceInstance = {
  instanceId: string;
  instanceName: string;
  capabilities: unknown;
  aiSessions: Pick<ControlPlaneAiSessionsSnapshot, "sessions">;
};

export type AiSessionApprovalItem = {
  type: "ai-session-approval";
  key: string;
  controlPlaneId: string;
  instanceId: string;
  instanceName: string;
  session: ControlPlaneAiSessionSummary;
  decisions: readonly AiSessionApprovalDecision[];
};

export type StoryDecisionApprovalItem = {
  type: "story-decision";
  key: string;
  controlPlaneId: string;
  story: Story;
  decision: StoryDecision;
};

export type OperationApprovalItem = {
  type: "operation-approval";
  key: string;
  controlPlaneId: string;
  request: ApprovalRequest;
  /** Display-only label derived from the existing directory snapshot. */
  targetName?: string;
};

export type DeviceTrustApprovalItem = {
  type: "device-trust";
  key: string;
  controlPlaneId: string;
  request: CloudDeviceTrustRequest;
  roles: readonly CloudDeviceTrustRoleOption[];
};

export type NodeControlPlaneTrustApprovalItem = {
  type: "node-control-plane-trust";
  key: string;
  controlPlaneId: string;
  nodeId: string;
  request: NodeAgentControlPlaneTrustRequest;
  /** Display-only label derived from the existing node directory snapshot. */
  nodeName?: string;
};

export type ApprovalCenterItem =
  | AiSessionApprovalItem
  | StoryDecisionApprovalItem
  | OperationApprovalItem
  | DeviceTrustApprovalItem
  | NodeControlPlaneTrustApprovalItem;

export type ApprovalCenterSourcePhase = "idle" | "loading" | "ready" | "stale" | "unavailable";

export type ApprovalCenterSourceHealth = {
  source: ApprovalCenterSource;
  phase: ApprovalCenterSourcePhase;
  pendingCount: number;
  lastLoadedAt?: string;
  retryable: boolean;
  diagnostic?: string;
};

export type ApprovalCenterView = {
  items: readonly ApprovalCenterItem[];
  health: readonly ApprovalCenterSourceHealth[];
};

export type StoryDecisionSourceEntry = {
  story: Story;
  decisions: readonly StoryDecision[];
};

export type NodeControlPlaneTrustSourceEntry = {
  nodeId: string;
  snapshot: NodeAgentControlPlaneTrustSnapshot;
};

function scopedKey(controlPlaneId: string, key: string) {
  return controlPlaneId ? `${controlPlaneId}:${key}` : key;
}

export function approvalCenterItemTimestamp(item: ApprovalCenterItem) {
  switch (item.type) {
    case "ai-session-approval": return item.session.updatedAt;
    case "story-decision": return item.decision.createdAt;
    case "operation-approval": return item.request.createdAt;
    case "device-trust": return item.request.requestedAt;
    case "node-control-plane-trust": return item.request.requestedAt;
  }
}

export function compareApprovalCenterItems(left: ApprovalCenterItem, right: ApprovalCenterItem) {
  return approvalCenterItemTimestamp(right).localeCompare(approvalCenterItemTimestamp(left))
    || left.key.localeCompare(right.key);
}

export function mergeApprovalCenterItems(items: readonly ApprovalCenterItem[]) {
  return [...items].sort(compareApprovalCenterItems);
}

export function approvalCenterPendingCount(items: readonly ApprovalCenterItem[]) {
  return new Set(items.map((item) => item.key)).size;
}

export function approvalCenterBadgeText(count: number) {
  return count > 99 ? "99+" : String(Math.max(0, count));
}

/**
 * A provider must explicitly advertise at least one executable approval action.
 * v0.0.21 compatibility remains local to this query and is not inferred from a
 * Node Agent package version.
 */
export function aiSessionApprovalDecisions(session: ControlPlaneAiSessionSummary, capabilities: unknown): readonly AiSessionApprovalDecision[] {
  if (!isAiSessionApprovalPending(session)) return [];
  const provider = directoryAiSessionProviderCapability(capabilities, session.agent);
  if (provider) return provider.actions.approvalDecisions;
  // Compatibility for v0.0.21: provider capabilities were absent and all
  // legacy Codex/Claude decisions were available.
  return session.agent === "codex" || session.agent === "claude" ? ["allow", "deny", "skip"] : [];
}

export function aiSessionApprovalItems(
  controlPlaneId: string,
  instances: readonly AiSessionApprovalSourceInstance[],
): AiSessionApprovalItem[] {
  return mergeApprovalCenterItems(instances.flatMap((instance) => instance.aiSessions.sessions.flatMap((session) => {
    const decisions = aiSessionApprovalDecisions(session, instance.capabilities);
    return decisions.length ? [{
      type: "ai-session-approval" as const,
      key: scopedKey(controlPlaneId, `ai-session-approval:${instance.instanceId}:${session.id}`),
      controlPlaneId,
      instanceId: instance.instanceId,
      instanceName: instance.instanceName,
      session,
      decisions,
    }] : [];
  }))) as AiSessionApprovalItem[];
}

/** Only nodes that explicitly publish Story decision tools create this source. */
export function storyDecisionNodes<T extends { capabilities: unknown }>(nodes: readonly T[]): T[] {
  return nodes.filter((node) => nodeStoryAgentToolCapabilities(nodeAgentCapabilitiesFromPublicNode(node.capabilities)).decisions);
}

export function storyDecisionApprovalItems(
  controlPlaneId: string,
  entries: readonly StoryDecisionSourceEntry[],
): StoryDecisionApprovalItem[] {
  return mergeApprovalCenterItems(entries.flatMap(({ story, decisions }) => story.archivedAt ? [] : decisions
    .filter((decision) => decision.status === "pending")
    .map((decision) => ({
      type: "story-decision" as const,
      key: scopedKey(controlPlaneId, `story-decision:${story.ownerNodeId}:${story.id}:${decision.id}`),
      controlPlaneId,
      story,
      decision,
    })))) as StoryDecisionApprovalItem[];
}

export function operationApprovalItems(controlPlaneId: string, requests: readonly ApprovalRequest[]): OperationApprovalItem[] {
  return mergeApprovalCenterItems(requests.map((request) => ({
    type: "operation-approval" as const,
    key: scopedKey(controlPlaneId, `operation-approval:${request.id}`),
    controlPlaneId,
    request,
  }))) as OperationApprovalItem[];
}

/** Ownership device trust is the only source accepted by this approval center. */
export function deviceTrustApprovalItems(controlPlaneId: string, snapshot: CloudDeviceTrustSnapshot | undefined): DeviceTrustApprovalItem[] {
  if (!snapshot) return [];
  return mergeApprovalCenterItems(snapshot.requests
    .filter((request) => request.source === "control-plane-device" && request.status === "pending")
    .map((request) => ({
      type: "device-trust" as const,
      key: scopedKey(controlPlaneId, `device-trust:${request.source}:${request.bindingId}:${request.requestId}`),
      controlPlaneId,
      request,
      roles: snapshot.roles,
    }))) as DeviceTrustApprovalItem[];
}

export function nodeControlPlaneTrustApprovalItems(
  controlPlaneId: string,
  entries: readonly NodeControlPlaneTrustSourceEntry[],
): NodeControlPlaneTrustApprovalItem[] {
  return mergeApprovalCenterItems(entries.flatMap(({ nodeId, snapshot }) => snapshot.requests
    .filter((request) => request.status === "pending")
    .map((request) => ({
      type: "node-control-plane-trust" as const,
      key: scopedKey(controlPlaneId, `node-control-plane-trust:${nodeId}:${request.requestId}`),
      controlPlaneId,
      nodeId,
      request,
    })))) as NodeControlPlaneTrustApprovalItem[];
}

export function applyApprovalCenterStoryDecision(
  items: readonly ApprovalCenterItem[],
  updated: StoryDecision,
): ApprovalCenterItem[] {
  return mergeApprovalCenterItems(items.flatMap((item) => item.type === "story-decision" && item.decision.id === updated.id
    ? updated.status === "pending" ? [{ ...item, decision: updated }] : []
    : [item]));
}
