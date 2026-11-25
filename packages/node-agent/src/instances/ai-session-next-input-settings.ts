import {
  AI_SESSION_NEXT_INPUT_SUGGESTION_DEFAULT_REASONING_EFFORT,
  type AiSessionNextInputSuggestionReasoningEffort,
} from "@task-handoff/protocol/ai-sessions";

export type AiSessionNextInputSettingsRequest = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number }>;

/**
 * Push the instance-level next-input suggestion switch to a running instance.
 * The cache key includes the process incarnation so a restarted instance always
 * converges even when the setting value itself did not change.
 */
export async function syncAiSessionNextInputSuggestionSettings(input: {
  instanceId: string;
  webUrl: string;
  registrationToken: string;
  enabled: boolean;
  reasoningEffort?: AiSessionNextInputSuggestionReasoningEffort;
  reasoningEffortSupported?: boolean;
  processIncarnationId?: string;
  syncKeys: Map<string, string>;
  request: AiSessionNextInputSettingsRequest;
  warn: (data: Record<string, unknown>, message: string) => void;
}): Promise<boolean> {
  const reasoningEffort = input.reasoningEffort ?? AI_SESSION_NEXT_INPUT_SUGGESTION_DEFAULT_REASONING_EFFORT;
  const reasoningEffortSyncKey = input.reasoningEffortSupported ? reasoningEffort : "unsupported";
  const syncKey = `${input.processIncarnationId || "unknown"}:${input.enabled}:${reasoningEffortSyncKey}`;
  if (input.syncKeys.get(input.instanceId) === syncKey) return true;
  try {
    const response = await input.request(`${input.webUrl}/api/internal/ai-session-next-input-suggestion-settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.registrationToken}`,
      },
      body: JSON.stringify({
        enabled: input.enabled,
        ...(input.reasoningEffortSupported ? { reasoningEffort } : {}),
      }),
    });
    if (!response.ok) {
      input.warn({ instanceId: input.instanceId, statusCode: response.status }, "node instance next-input suggestion settings live sync deferred");
      return false;
    }
    input.syncKeys.set(input.instanceId, syncKey);
    return true;
  } catch (error) {
    input.warn({ instanceId: input.instanceId, error: error instanceof Error ? error.message : String(error) }, "node instance next-input suggestion settings live sync deferred");
    return false;
  }
}
