import { isAiSessionApprovalPending } from "@task-handoff/control-plane-client";
import { directoryAiSessionProviderCapability } from "@task-handoff/protocol/control-plane-directory";
import type { AiSessionSummary, InstanceWithAiSessions } from "../../../api/types";

export type AiSessionApprovalDecision = "allow" | "deny" | "skip";

export function aiSessionApprovalDecisions(session: AiSessionSummary, capabilities: unknown): AiSessionApprovalDecision[] {
  if (!isAiSessionApprovalPending(session)) return [];
  const provider = directoryAiSessionProviderCapability(capabilities, session.agent);
  if (provider) return provider.actions.approvalDecisions;
  // Compatibility for v0.0.21: provider capabilities were absent and the UI exposed all legacy decisions.
  return session.agent === "codex" || session.agent === "claude" ? ["allow", "deny", "skip"] : [];
}

export function aiSessionApprovalItems(instances: readonly InstanceWithAiSessions[]) {
  return instances.flatMap((instance) => instance.aiSessions.sessions.flatMap((session) => {
    const decisions = aiSessionApprovalDecisions(session, instance.capabilities?.features);
    return decisions.length ? [{
      type: "ai-session-approval" as const,
      key: `ai-session-approval:${instance.id}:${session.id}`,
      instanceId: instance.id,
      instanceName: instance.name,
      session,
      decisions,
    }] : [];
  })).sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt) || left.key.localeCompare(right.key));
}
