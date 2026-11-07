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

type PreferencesModule = typeof import('../src/ai-sessions/session-view-preferences');

function loadPreferences(): PreferencesModule {
  let loaded: PreferencesModule | undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { loaded = require('../src/ai-sessions/session-view-preferences') as PreferencesModule; });
  return loaded!;
}

async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

beforeEach(() => { secureStore.__store.clear(); });

test('parses the persisted session view and defaults unknown values to compact', () => {
  const { parseAiSessionViewPreferences } = loadPreferences();
  expect(parseAiSessionViewPreferences(JSON.stringify({ version: 1, detailMode: 'conversation' }))).toEqual({ detailMode: 'conversation' });
  expect(parseAiSessionViewPreferences(JSON.stringify({ version: 1, detailMode: 'turn' }))).toEqual({ detailMode: 'turn' });
  expect(parseAiSessionViewPreferences(JSON.stringify({ version: 1, detailMode: 'unsupported' }))).toEqual({ detailMode: 'turn' });
  expect(parseAiSessionViewPreferences(JSON.stringify({ version: 99, detailMode: 'conversation' }))).toBeUndefined();
  expect(parseAiSessionViewPreferences('not json')).toBeUndefined();
  expect(parseAiSessionViewPreferences(null)).toBeUndefined();
});

test('keeps the selected session view after the module reloads', async () => {
  const first = loadPreferences();
  const unsubscribe = first.subscribeAiSessionViewPreferences(() => undefined);
  first.updateAiSessionViewPreferences({ detailMode: 'conversation' });
  await flush();
  expect(secureStore.__store.size).toBe(1);
  unsubscribe();

  const reloaded = loadPreferences();
  expect(reloaded.getAiSessionViewPreferences()).toEqual({ detailMode: 'turn' });
  const unsubscribeReloaded = reloaded.subscribeAiSessionViewPreferences(() => undefined);
  await flush();
  expect(reloaded.getAiSessionViewPreferences()).toEqual({ detailMode: 'conversation' });
  unsubscribeReloaded();
});
