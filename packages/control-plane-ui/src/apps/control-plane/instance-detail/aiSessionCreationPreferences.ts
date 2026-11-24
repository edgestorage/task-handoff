import {
  mergeAiSessionCreationPreferences,
  sanitizeAiSessionCreationPreferences,
  type AiSessionCreationPreferences,
} from "@task-handoff/control-plane-client";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type { AiSessionCreationPreferences } from "@task-handoff/control-plane-client";

const STORAGE_PREFIX = "task-handoff.control-plane.ai-session-creation-preferences";
const AGENT_STORAGE_KEY = `${STORAGE_PREFIX}.agent`;

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

export function loadAiSessionCreationAgent(storage = browserStorage()): string {
  if (!storage) return "";
  try {
    return storage.getItem(AGENT_STORAGE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function persistAiSessionCreationAgent(agent: string, storage = browserStorage()) {
  if (!storage || !agent) return;
  try {
    storage.setItem(AGENT_STORAGE_KEY, agent);
  } catch {
    // Storage can be disabled or full; the current composer selection still works.
  }
}

export function preferredAiSessionCreationAgent(
  requestedAgent: string,
  availableAgentIds: readonly string[],
  storage = browserStorage(),
): string {
  const rememberedAgent = loadAiSessionCreationAgent(storage);
  for (const agent of [requestedAgent, rememberedAgent]) {
    if (agent && availableAgentIds.includes(agent)) return agent;
  }
  return availableAgentIds[0] || "";
}

export function loadAiSessionCreationPreferences(
  agent: string,
  storage = browserStorage(),
): AiSessionCreationPreferences {
  if (!storage || !agent) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey(agent)) || "{}");
    return sanitizeAiSessionCreationPreferences(parsed);
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
  const preferences = mergeAiSessionCreationPreferences(loadAiSessionCreationPreferences(agent, storage), patch);
  try {
    storage.setItem(storageKey(agent), JSON.stringify(preferences));
  } catch {
    // Storage can be disabled or full; the current composer selection still works.
  }
}
