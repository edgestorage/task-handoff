import {
  AgentRunMemberInstanceStatusSchema,
  type AgentRunMemberInstanceStatus,
} from "@task-handoff/protocol/agent-run-instance";
import { AGENT_RUN_MAX_RESULT_CHARACTERS } from "@task-handoff/protocol/agent-runs";
import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import type { AgentRunMemberBinding } from "./agent-run-member-bindings";

export function projectAgentRunMemberStatus(
  binding: AgentRunMemberBinding,
  session: Pick<AiSessionStatus, "status" | "error" | "lastMessage" | "summary">,
): AgentRunMemberInstanceStatus {
  const identity = { runId: binding.runId, memberId: binding.memberId, aiSessionId: binding.aiSessionId };
  if (session.status === "failed") {
    return AgentRunMemberInstanceStatusSchema.parse({
      ...identity,
      status: "failed",
      error: { code: "AGENT_RUN_PROVIDER_FAILED", message: session.error || "The provider member session failed.", retryable: false },
    });
  }
  if (session.status !== "idle") {
    return AgentRunMemberInstanceStatusSchema.parse({ ...identity, status: "running" });
  }
  const text = session.lastMessage || session.summary || "";
  if (!text.trim()) {
    return AgentRunMemberInstanceStatusSchema.parse({
      ...identity,
      status: "failed",
      error: { code: "AGENT_RUN_PROVIDER_NO_FINAL_MESSAGE", message: "The provider member session completed without a final message.", retryable: false },
    });
  }
  return AgentRunMemberInstanceStatusSchema.parse({
    ...identity,
    status: "completed",
    result: {
      text: text.slice(0, AGENT_RUN_MAX_RESULT_CHARACTERS),
      truncated: text.length > AGENT_RUN_MAX_RESULT_CHARACTERS,
      source: "provider-final-message",
    },
  });
}
