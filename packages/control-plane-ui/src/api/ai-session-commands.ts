import type { AiSessionCommandInput, AiSessionCommandResult } from "@task-handoff/protocol/ai-sessions";
import { postApiData } from "./client";

export function executeAiSessionCommand(instanceId: string, sessionId: string, input: AiSessionCommandInput) {
  return postApiData<AiSessionCommandResult>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/commands`, input);
}
