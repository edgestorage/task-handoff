export type AiSessionInboxGroupBy = 'none' | 'path' | 'instance' | 'node' | 'agent';

export type AiSessionInboxViewPreferences = {
  groupBy: AiSessionInboxGroupBy;
  sortByStatus: boolean;
};

const listeners = new Set<() => void>();
let preferences: AiSessionInboxViewPreferences = { groupBy: 'none', sortByStatus: false };

export function getAiSessionInboxViewPreferences() { return preferences; }

export function subscribeAiSessionInboxViewPreferences(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateAiSessionInboxViewPreferences(patch: Partial<AiSessionInboxViewPreferences>) {
  preferences = { ...preferences, ...patch };
  for (const listener of listeners) listener();
}
