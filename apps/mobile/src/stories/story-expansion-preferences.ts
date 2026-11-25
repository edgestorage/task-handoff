import { ExpoFileValueStore } from '../platform/file-storage';
import { createPersistedPreferenceStore } from '../platform/persisted-preferences';

const STORAGE_VERSION = 1;

const store = createPersistedPreferenceStore<{ expandedKeys: string[] }>({
  defaults: { expandedKeys: [] },
  storage: new ExpoFileValueStore(),
  storageKey: 'task-handoff.mobile.story-expansion-preferences',
  version: STORAGE_VERSION,
  parse(raw) {
    const value: { version?: unknown; expandedKeys?: unknown } | null = raw ? JSON.parse(raw) : null;
    if (value?.version !== STORAGE_VERSION || !Array.isArray(value.expandedKeys)) return undefined;
    return { expandedKeys: [...new Set(value.expandedKeys.filter((key): key is string => typeof key === 'string' && key.length > 0))] };
  },
});

export function getExpandedStoryKeys() { return store.get().expandedKeys; }
export function subscribeExpandedStoryKeys(listener: () => void) { return store.subscribe(listener); }

export async function toggleExpandedStoryKey(key: string) {
  await store.ready();
  const { expandedKeys } = store.get();
  store.update({ expandedKeys: expandedKeys.includes(key) ? expandedKeys.filter((current) => current !== key) : [...expandedKeys, key] });
}
