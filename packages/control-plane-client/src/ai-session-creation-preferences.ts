import {
  AiSessionModelSelectionSchema,
  AiSessionReasoningEffortSchema,
  type AiSessionModelSelection,
  type AiSessionReasoningEffort,
} from "@task-handoff/protocol/ai-sessions";

/**
 * Local composer defaults shared by the Web and mobile clients. This is client
 * preference state rather than a wire model, so it never belongs in the
 * Control Plane protocol.
 */
export type AiSessionCreationPreferences = {
  modelSelection?: AiSessionModelSelection;
  reasoningEffort?: AiSessionReasoningEffort;
};

export function sanitizeAiSessionCreationPreferences(input: unknown): AiSessionCreationPreferences {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const storedModel = record.modelSelection && typeof record.modelSelection === "object" && !Array.isArray(record.modelSelection)
    ? record.modelSelection as Record<string, unknown>
    : {};
  const modelSelection = AiSessionModelSelectionSchema.safeParse({
    modelEntityId: storedModel.modelEntityId,
    modelName: storedModel.modelName,
    // Keep the optional identity absent when it was never stored; an explicit
    // undefined would leave an empty own-key on the parsed object.
    ...(typeof storedModel.modelUpstreamName === "string" ? { modelUpstreamName: storedModel.modelUpstreamName } : {}),
  });
  const reasoningEffort = AiSessionReasoningEffortSchema.safeParse(record.reasoningEffort);
  return {
    ...(modelSelection.success ? { modelSelection: modelSelection.data } : {}),
    ...(reasoningEffort.success ? { reasoningEffort: reasoningEffort.data } : {}),
  };
}

export function mergeAiSessionCreationPreferences(
  current: AiSessionCreationPreferences,
  patch: AiSessionCreationPreferences,
): AiSessionCreationPreferences {
  return { ...current, ...patch };
}
