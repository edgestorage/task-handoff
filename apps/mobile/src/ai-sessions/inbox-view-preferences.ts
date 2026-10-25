import { createPersistedPreferenceStore } from '../platform/persisted-preferences';

export type AiSessionInboxGroupBy = 'none' | 'path' | 'instance' | 'node' | 'agent';
export type AiSessionInboxLayout = 'cards' | 'list';

export type AiSessionInboxViewPreferences = {
  collapsedGroupKeys: string[];
  groupBy: AiSessionInboxGroupBy;
  layout: AiSessionInboxLayout;
  sortByStatus: boolean;
};

const STORAGE_KEY = 'task-handoff.mobile.ai-session-inbox-view-preferences';
const STORAGE_VERSION = 1;
const GROUP_BY_MODES: readonly AiSessionInboxGroupBy[] = ['none', 'path', 'instance', 'node', 'agent'];
const LAYOUTS: readonly AiSessionInboxLayout[] = ['cards', 'list'];
const DEFAULT_PREFERENCES: AiSessionInboxViewPreferences = { collapsedGroupKeys: [], groupBy: 'none', layout: 'cards', sortByStatus: false };

export function parseAiSessionInboxViewPreferences(raw: string | null | undefined): AiSessionInboxViewPreferences | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || value.version !== STORAGE_VERSION) return undefined;
    return {
      collapsedGroupKeys: Array.isArray(value.collapsedGroupKeys)
        ? [...new Set(value.collapsedGroupKeys.filter((key): key is string => typeof key === 'string' && key.length > 0))].slice(0, 200)
        : [],
      groupBy: typeof value.groupBy === 'string' && (GROUP_BY_MODES as readonly string[]).includes(value.groupBy) ? value.groupBy as AiSessionInboxGroupBy : 'none',
      layout: typeof value.layout === 'string' && (LAYOUTS as readonly string[]).includes(value.layout) ? value.layout as AiSessionInboxLayout : 'cards',
      sortByStatus: value.sortByStatus === true,
    };
  } catch {
    return undefined;
  }
}

const store = createPersistedPreferenceStore<AiSessionInboxViewPreferences>({
  defaults: DEFAULT_PREFERENCES,
  parse: parseAiSessionInboxViewPreferences,
  storageKey: STORAGE_KEY,
  version: STORAGE_VERSION,
});

export function getAiSessionInboxViewPreferences() { return store.get(); }
export function subscribeAiSessionInboxViewPreferences(listener: () => void) { return store.subscribe(listener); }
export function updateAiSessionInboxViewPreferences(patch: Partial<AiSessionInboxViewPreferences>) { store.update(patch); }
