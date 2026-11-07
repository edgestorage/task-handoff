import { createPersistedPreferenceStore } from '../platform/persisted-preferences';
import type { SessionDetailMode } from './SessionDetail';

export type AiSessionViewPreferences = { detailMode: SessionDetailMode };

export const AI_SESSION_VIEW_PREFERENCES_KEY = 'task-handoff.mobile.ai-session-view-preferences';
const STORAGE_VERSION = 1;
const DEFAULT_PREFERENCES: AiSessionViewPreferences = { detailMode: 'turn' };

export function parseAiSessionViewPreferences(raw: string | null | undefined): AiSessionViewPreferences | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STORAGE_VERSION) return undefined;
    return { detailMode: value.detailMode === 'conversation' ? 'conversation' : 'turn' };
  } catch {
    return undefined;
  }
}

const store = createPersistedPreferenceStore<AiSessionViewPreferences>({
  defaults: DEFAULT_PREFERENCES,
  parse: parseAiSessionViewPreferences,
  storageKey: AI_SESSION_VIEW_PREFERENCES_KEY,
  version: STORAGE_VERSION,
});

export function getAiSessionViewPreferences() { return store.get(); }
export function subscribeAiSessionViewPreferences(listener: () => void) { return store.subscribe(listener); }
export function updateAiSessionViewPreferences(patch: Partial<AiSessionViewPreferences>) { store.update(patch); }
