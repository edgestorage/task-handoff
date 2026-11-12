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

type PreferencesModule = typeof import('../src/remote-desktop/session-floating-preview-preferences');

function loadPreferences(): PreferencesModule {
  let loaded: PreferencesModule | undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { loaded = require('../src/remote-desktop/session-floating-preview-preferences') as PreferencesModule; });
  return loaded!;
}

async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

beforeEach(() => { secureStore.__store.clear(); });

test('parses and sanitizes persisted floating preview positions', () => {
  const { parseSessionFloatingPreviewPreferences, sessionFloatingPreviewPreferenceKey } = loadPreferences();
  const key = sessionFloatingPreviewPreferenceKey('cp_1', 'instance_1', 'session_1');
  const parsed = parseSessionFloatingPreviewPreferences(JSON.stringify({
    version: 1,
    bySession: {
      [key]: { collapsed: true, futureField: true, width: 2_000, xRatio: -1, yRatio: 2 },
      invalid: { width: 'wide', xRatio: 1, yRatio: 1 },
    },
  }));
  expect(parsed?.bySession[key]).toEqual({ collapsed: true, width: 360, xRatio: 0, yRatio: 1 });
  expect(parsed?.bySession.invalid).toBeUndefined();
  expect(parseSessionFloatingPreviewPreferences(JSON.stringify({ version: 2, bySession: {} }))).toBeUndefined();
  expect(parseSessionFloatingPreviewPreferences('not json')).toBeUndefined();
});

test('keeps floating preview layout preferences isolated by session and restores them after reload', async () => {
  const first = loadPreferences();
  const unsubscribe = first.sessionFloatingPreviewPreferenceStore.subscribe(() => undefined);
  first.updateSessionFloatingPreviewPreference({
    controlPlaneId: 'cp_1',
    instanceId: 'instance_1',
    preference: { collapsed: true, width: 280, xRatio: 0.25, yRatio: 0.75 },
    sessionId: 'session_a',
  });
  first.updateSessionFloatingPreviewPreference({
    controlPlaneId: 'cp_1',
    instanceId: 'instance_1',
    preference: { collapsed: false, width: 196, xRatio: 0.9, yRatio: 0.1 },
    sessionId: 'session_b',
  });
  expect(first.sessionFloatingPreviewPreferenceFor('cp_1', 'instance_1', 'session_a')).toEqual(expect.objectContaining({ width: 280, xRatio: 0.25 }));
  expect(first.sessionFloatingPreviewPreferenceFor('cp_1', 'instance_1', 'session_b')).toEqual(expect.objectContaining({ width: 196, xRatio: 0.9 }));
  await flush();
  unsubscribe();

  const reloaded = loadPreferences();
  const unsubscribeReloaded = reloaded.sessionFloatingPreviewPreferenceStore.subscribe(() => undefined);
  await flush();
  expect(reloaded.sessionFloatingPreviewPreferenceFor('cp_1', 'instance_1', 'session_a')).toEqual({
    collapsed: true,
    width: 280,
    xRatio: 0.25,
    yRatio: 0.75,
  });
  expect(reloaded.sessionFloatingPreviewPreferenceFor('cp_1', 'instance_1', 'session_b')).toEqual({
    collapsed: false,
    width: 196,
    xRatio: 0.9,
    yRatio: 0.1,
  });
  unsubscribeReloaded();
});
