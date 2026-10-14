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

type PreferencesModule = typeof import('../src/stories/story-view-preferences');

function loadPreferences(): PreferencesModule {
  let loaded: PreferencesModule | undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { loaded = require('../src/stories/story-view-preferences') as PreferencesModule; });
  return loaded!;
}

async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

beforeEach(() => { secureStore.__store.clear(); });

test('parses persisted preferences and ignores unknown payloads', () => {
  const { parseStoryViewPreferences } = loadPreferences();
  expect(parseStoryViewPreferences(JSON.stringify({ version: 1, viewMode: 'detailed', sortMode: 'manual', manualKeys: ['node-a:story-a', 42] }))).toEqual({
    viewMode: 'detailed', sortMode: 'manual', manualKeys: ['node-a:story-a'],
  });
  expect(parseStoryViewPreferences(JSON.stringify({ version: 1, sortMode: 'unsupported' }))).toEqual({ viewMode: 'compact', sortMode: 'name', manualKeys: [] });
  expect(parseStoryViewPreferences(JSON.stringify({ version: 99, sortMode: 'manual' }))).toBeUndefined();
  expect(parseStoryViewPreferences('not json')).toBeUndefined();
  expect(parseStoryViewPreferences(null)).toBeUndefined();
});

test('keeps the selected sort mode after the module reloads', async () => {
  const first = loadPreferences();
  const unsubscribe = first.subscribeStoryViewPreferences(() => undefined);
  first.updateStoryViewPreferences({ sortMode: 'manual', manualKeys: ['node-a:story-a', 'node-a:story-b'] });
  await flush();
  expect(secureStore.__store.size).toBe(1);
  unsubscribe();

  const reloaded = loadPreferences();
  expect(reloaded.getStoryViewPreferences().sortMode).toBe('name');
  const unsubscribeReloaded = reloaded.subscribeStoryViewPreferences(() => undefined);
  await flush();
  expect(reloaded.getStoryViewPreferences()).toEqual({ viewMode: 'compact', sortMode: 'manual', manualKeys: ['node-a:story-a', 'node-a:story-b'] });
  unsubscribeReloaded();
});

test('a change made before hydration wins over the stored snapshot', async () => {
  const first = loadPreferences();
  const unsubscribe = first.subscribeStoryViewPreferences(() => undefined);
  first.updateStoryViewPreferences({ sortMode: 'last-user-message' });
  await flush();
  unsubscribe();

  const reloaded = loadPreferences();
  const unsubscribeReloaded = reloaded.subscribeStoryViewPreferences(() => undefined);
  reloaded.updateStoryViewPreferences({ sortMode: 'name' });
  await flush();
  expect(reloaded.getStoryViewPreferences().sortMode).toBe('name');
  unsubscribeReloaded();
});
