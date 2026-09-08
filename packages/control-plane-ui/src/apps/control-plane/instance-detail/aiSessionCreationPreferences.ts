import {
  AiSessionModelSelectionSchema,
  AiSessionReasoningEffortSchema,
  type AiSessionModelSelection,
  type AiSessionReasoningEffort,
} from "@task-handoff/protocol/ai-sessions";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type AiSessionCreationPreferences = {
  modelSelection?: AiSessionModelSelection;
  reasoningEffort?: AiSessionReasoningEffort;
};

const STORAGE_PREFIX = "task-handoff.control-plane.ai-session-creation-preferences";

function storageKey(agent: string) {
  return `${STORAGE_PREFIX}.${encodeURIComponent(agent)}`;
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadAiSessionCreationPreferences(
  agent: string,
  storage = browserStorage(),
): AiSessionCreationPreferences {
  if (!storage || !agent) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey(agent)) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const storedModel = record.modelSelection && typeof record.modelSelection === "object" && !Array.isArray(record.modelSelection)
      ? record.modelSelection as Record<string, unknown>
      : {};
    const modelSelection = AiSessionModelSelectionSchema.safeParse({
      modelEntityId: storedModel.modelEntityId,
      modelName: storedModel.modelName,
    });
    const reasoningEffort = AiSessionReasoningEffortSchema.safeParse(record.reasoningEffort);
    return {
      ...(modelSelection.success ? { modelSelection: modelSelection.data } : {}),
      ...(reasoningEffort.success ? { reasoningEffort: reasoningEffort.data } : {}),
    };
  } catch {
    return {};
  }
}

export function persistAiSessionCreationPreferences(
  agent: string,
  patch: AiSessionCreationPreferences,
  storage = browserStorage(),
) {
  if (!storage || !agent) return;
  const preferences = { ...loadAiSessionCreationPreferences(agent, storage), ...patch };
  try {
    storage.setItem(storageKey(agent), JSON.stringify(preferences));
  } catch {
    // Storage can be disabled or full; the current composer selection still works.
  }
}
