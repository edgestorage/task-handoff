import { createPersistedPreferenceStore } from '../platform/persisted-preferences';

export type StoryViewMode = 'compact' | 'detailed';
export type StorySortMode = 'name' | 'last-user-message' | 'manual';

export type StoryViewPreferences = { viewMode: StoryViewMode; sortMode: StorySortMode; manualKeys: string[] };

const STORAGE_KEY = 'task-handoff.mobile.story-view-preferences';
const STORAGE_VERSION = 1;
const DEFAULT_PREFERENCES: StoryViewPreferences = { viewMode: 'compact', sortMode: 'name', manualKeys: [] };

export function parseStoryViewPreferences(raw: string | null | undefined): StoryViewPreferences | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || value.version !== STORAGE_VERSION) return undefined;
    return {
      viewMode: value.viewMode === 'detailed' ? 'detailed' : 'compact',
      sortMode: value.sortMode === 'last-user-message' || value.sortMode === 'manual' ? value.sortMode : 'name',
      manualKeys: Array.isArray(value.manualKeys) ? value.manualKeys.filter((key): key is string => typeof key === 'string') : [],
    };
  } catch {
    return undefined;
  }
}

const store = createPersistedPreferenceStore<StoryViewPreferences>({
  defaults: DEFAULT_PREFERENCES,
  parse: parseStoryViewPreferences,
  storageKey: STORAGE_KEY,
  version: STORAGE_VERSION,
});

export function getStoryViewPreferences() { return store.get(); }
export function subscribeStoryViewPreferences(listener: () => void) { return store.subscribe(listener); }
export function updateStoryViewPreferences(patch: Partial<StoryViewPreferences>) { store.update(patch); }
