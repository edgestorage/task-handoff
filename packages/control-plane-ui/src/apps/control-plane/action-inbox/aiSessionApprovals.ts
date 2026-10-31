import {
  aiSessionApprovalDecisions as sharedAiSessionApprovalDecisions,
  aiSessionApprovalItems as sharedAiSessionApprovalItems,
  type AiSessionApprovalDecision,
} from "@task-handoff/control-plane-client";
import type { AiSessionSummary, InstanceWithAiSessions } from "../../../api/types";

export type { AiSessionApprovalDecision };

export function aiSessionApprovalDecisions(session: AiSessionSummary, capabilities: unknown): AiSessionApprovalDecision[] {
  return [...sharedAiSessionApprovalDecisions(session, capabilities)];
}

export function aiSessionApprovalItems(instances: readonly InstanceWithAiSessions[]) {
  return sharedAiSessionApprovalItems("", instances.map((instance) => ({
    instanceId: instance.id,
    instanceName: instance.name,
    capabilities: instance.capabilities?.features,
    aiSessions: instance.aiSessions,
  }))).map(({ controlPlaneId: _controlPlaneId, instanceId, instanceName, session, decisions, ...item }) => ({
    ...item,
    instanceId,
    instanceName,
    session,
    decisions: [...decisions],
  }));
}
