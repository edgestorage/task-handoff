import * as SecureStore from 'expo-secure-store';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { store.delete(key); }),
  };
});

const secureStore = SecureStore as unknown as { __store: Map<string, string> };

type PreferencesModule = typeof import('../src/ai-sessions/inbox-view-preferences');

function loadPreferences(): PreferencesModule {
  let loaded: PreferencesModule | undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { loaded = require('../src/ai-sessions/inbox-view-preferences') as PreferencesModule; });
  return loaded!;
}

async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

beforeEach(() => { secureStore.__store.clear(); });

test('parses persisted preferences and rejects unknown payloads', () => {
  const { parseAiSessionInboxViewPreferences } = loadPreferences();
  expect(parseAiSessionInboxViewPreferences(JSON.stringify({ version: 1, groupBy: 'node', sortByStatus: true }))).toEqual({ groupBy: 'node', sortByStatus: true });
  expect(parseAiSessionInboxViewPreferences(JSON.stringify({ version: 1, groupBy: 'unsupported' }))).toEqual({ groupBy: 'none', sortByStatus: false });
  expect(parseAiSessionInboxViewPreferences(JSON.stringify({ version: 99, groupBy: 'node' }))).toBeUndefined();
  expect(parseAiSessionInboxViewPreferences('not json')).toBeUndefined();
  expect(parseAiSessionInboxViewPreferences(null)).toBeUndefined();
});

test('keeps the selected grouping and status sort after the module reloads', async () => {
  const first = loadPreferences();
  const unsubscribe = first.subscribeAiSessionInboxViewPreferences(() => undefined);
  first.updateAiSessionInboxViewPreferences({ groupBy: 'instance', sortByStatus: true });
  await flush();
  expect(secureStore.__store.size).toBe(1);
  unsubscribe();

  const reloaded = loadPreferences();
  expect(reloaded.getAiSessionInboxViewPreferences()).toEqual({ groupBy: 'none', sortByStatus: false });
  const unsubscribeReloaded = reloaded.subscribeAiSessionInboxViewPreferences(() => undefined);
  await flush();
  expect(reloaded.getAiSessionInboxViewPreferences()).toEqual({ groupBy: 'instance', sortByStatus: true });
  unsubscribeReloaded();
});
