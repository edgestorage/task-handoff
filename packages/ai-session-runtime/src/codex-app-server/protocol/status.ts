import type { AiSessionLifecycle, AiSessionPhase } from "@task-handoff/protocol/ai-sessions";
import type { CodexThreadStatus } from "./types";

export function lifecycleForStatus(status: CodexThreadStatus): {
  status: AiSessionLifecycle;
  phase: AiSessionPhase;
} {
  const type = String(status.type || "");
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags.map(String) : [];
  if (type === "active" && flags.includes("waitingOnApproval")) {
    return { status: "waiting", phase: "approval" };
  }
  if (type === "active" && flags.includes("waitingOnUserInput")) {
    return { status: "waiting", phase: "thinking" };
  }
  if (type === "active") return { status: "running", phase: "thinking" };
  if (type === "systemError") return { status: "failed", phase: "unknown" };
  return { status: "idle", phase: "unknown" };
}
