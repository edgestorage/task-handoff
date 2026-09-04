export type StoryViewMode = 'compact' | 'detailed';
export type StorySortMode = 'name' | 'last-user-message' | 'manual';

type StoryViewPreferences = { viewMode: StoryViewMode; sortMode: StorySortMode; manualKeys: string[] };
const listeners = new Set<() => void>();
let preferences: StoryViewPreferences = { viewMode: 'compact', sortMode: 'name', manualKeys: [] };

export function getStoryViewPreferences() { return preferences; }
export function subscribeStoryViewPreferences(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }
export function updateStoryViewPreferences(patch: Partial<StoryViewPreferences>) {
  preferences = { ...preferences, ...patch };
  for (const listener of listeners) listener();
}
