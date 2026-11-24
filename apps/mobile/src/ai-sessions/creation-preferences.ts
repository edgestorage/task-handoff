import {
  mergeAiSessionCreationPreferences,
  sanitizeAiSessionCreationPreferences,
  type AiSessionCreationPreferences,
} from '@task-handoff/control-plane-client';

import { createPersistedPreferenceStore } from '../platform/persisted-preferences';

export const AI_SESSION_CREATION_PREFERENCES_KEY = 'task-handoff.mobile.ai-session-creation-preferences';
const STORAGE_VERSION = 1;
const MAX_CONTROL_PLANES = 100;
const MAX_AGENTS_PER_CONTROL_PLANE = 20;

export type MobileAiSessionCreationPreferences = {
  byControlPlane: Record<string, Record<string, AiSessionCreationPreferences>>;
};

const DEFAULT_PREFERENCES: MobileAiSessionCreationPreferences = { byControlPlane: {} };

export function parseAiSessionCreationPreferences(raw: string | null | undefined): MobileAiSessionCreationPreferences | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORAGE_VERSION) return undefined;
    return { byControlPlane: parseControlPlanePreferences(value.byControlPlane) };
  } catch {
    return undefined;
  }
}

export function aiSessionCreationPreferencesFor(
  preferences: MobileAiSessionCreationPreferences,
  controlPlaneId: string | undefined,
  agent: string,
): AiSessionCreationPreferences {
  if (!controlPlaneId || !agent) return {};
  return preferences.byControlPlane[controlPlaneId]?.[agent] ?? {};
}

const store = createPersistedPreferenceStore<MobileAiSessionCreationPreferences>({
  defaults: DEFAULT_PREFERENCES,
  parse: parseAiSessionCreationPreferences,
  storageKey: AI_SESSION_CREATION_PREFERENCES_KEY,
  version: STORAGE_VERSION,
});

export function getAiSessionCreationPreferences() {
  return store.get();
}

export function subscribeAiSessionCreationPreferences(listener: () => void) {
  return store.subscribe(listener);
}

export async function rememberAiSessionCreationPreferences(
  controlPlaneId: string | undefined,
  agent: string,
  patch: AiSessionCreationPreferences,
) {
  if (!controlPlaneId || !agent) return;
  const sanitizedPatch = sanitizeAiSessionCreationPreferences(patch);
  if (!sanitizedPatch.modelSelection && !sanitizedPatch.reasoningEffort) return;
  // Merge against the hydrated snapshot so a fast first selection cannot
  // overwrite preferences for other control planes or agents.
  await store.ready();
  const current = store.get();
  const controlPlane = current.byControlPlane[controlPlaneId] ?? {};
  store.update({
    byControlPlane: {
      ...current.byControlPlane,
      [controlPlaneId]: {
        ...controlPlane,
        [agent]: mergeAiSessionCreationPreferences(controlPlane[agent] ?? {}, sanitizedPatch),
      },
    },
  });
}

export async function clearAiSessionCreationPreferences(controlPlaneId: string) {
  await store.ready();
  const current = store.get();
  if (!(controlPlaneId in current.byControlPlane)) return;
  const { [controlPlaneId]: _removed, ...byControlPlane } = current.byControlPlane;
  store.update({ byControlPlane });
}

function parseControlPlanePreferences(input: unknown): Record<string, Record<string, AiSessionCreationPreferences>> {
  const result: Record<string, Record<string, AiSessionCreationPreferences>> = {};
  for (const [controlPlaneId, value] of Object.entries(plainRecord(input)).slice(0, MAX_CONTROL_PLANES)) {
    if (!controlPlaneId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const agents: Record<string, AiSessionCreationPreferences> = {};
    for (const [agent, preferences] of Object.entries(value).slice(0, MAX_AGENTS_PER_CONTROL_PLANE)) {
      if (!agent) continue;
      const sanitized = sanitizeAiSessionCreationPreferences(preferences);
      if (sanitized.modelSelection || sanitized.reasoningEffort) agents[agent] = sanitized;
    }
    if (Object.keys(agents).length) result[controlPlaneId] = agents;
  }
  return result;
}

function plainRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}
