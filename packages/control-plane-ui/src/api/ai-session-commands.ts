import type { AiSessionCommandInput, AiSessionCommandResult } from "@task-handoff/protocol/ai-sessions";
import { sharedAiSessionsApi } from "./sharedClient";

export function executeAiSessionCommand(instanceId: string, sessionId: string, input: AiSessionCommandInput) {
  return sharedAiSessionsApi.executeCommand(instanceId, sessionId, input) as Promise<AiSessionCommandResult>;
}
