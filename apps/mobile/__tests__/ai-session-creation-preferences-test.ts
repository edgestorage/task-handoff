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

type PreferencesModule = typeof import('../src/ai-sessions/creation-preferences');

function loadPreferences(): PreferencesModule {
  let loaded: PreferencesModule | undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { loaded = require('../src/ai-sessions/creation-preferences') as PreferencesModule; });
  return loaded!;
}

async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

beforeEach(() => { secureStore.__store.clear(); });

test('parses and sanitizes creation preferences per control plane and agent', () => {
  const { parseAiSessionCreationPreferences } = loadPreferences();
  expect(parseAiSessionCreationPreferences(JSON.stringify({
    version: 1,
    byControlPlane: {
      'cp-1': {
        codex: {
          modelSelection: {
            modelEntityId: 'model-one',
            modelName: 'gpt-5.6',
            modelUpstreamName: 'upstream-one',
            privateEndpoint: 'hidden',
          },
          reasoningEffort: 'high',
          futureField: true,
        },
        claude: { reasoningEffort: 'unsupported' },
      },
    },
  }))).toEqual({
    byControlPlane: {
      'cp-1': {
        codex: {
          modelSelection: {
            modelEntityId: 'model-one',
            modelName: 'gpt-5.6',
            modelUpstreamName: 'upstream-one',
          },
          reasoningEffort: 'high',
        },
      },
    },
  });
  expect(parseAiSessionCreationPreferences(JSON.stringify({ version: 2, byControlPlane: {} }))).toBeUndefined();
  expect(parseAiSessionCreationPreferences('not json')).toBeUndefined();
  expect(parseAiSessionCreationPreferences(null)).toBeUndefined();
});

test('remembers model and reasoning selections independently and survives a module reload', async () => {
  const first = loadPreferences();
  const unsubscribe = first.subscribeAiSessionCreationPreferences(() => undefined);
  await first.rememberAiSessionCreationPreferences('cp-1', 'codex', {
    modelSelection: { modelEntityId: 'model-one', modelName: 'gpt-5.6' },
  });
  await first.rememberAiSessionCreationPreferences('cp-1', 'codex', { reasoningEffort: 'high' });
  await first.rememberAiSessionCreationPreferences('cp-1', 'claude', { reasoningEffort: 'low' });
  await first.rememberAiSessionCreationPreferences('cp-2', 'codex', { reasoningEffort: 'max' });
  await flush();
  expect(secureStore.__store.size).toBe(1);
  expect(first.aiSessionCreationPreferencesFor(first.getAiSessionCreationPreferences(), 'cp-1', 'codex')).toEqual({
    modelSelection: { modelEntityId: 'model-one', modelName: 'gpt-5.6' },
    reasoningEffort: 'high',
  });
  unsubscribe();

  const reloaded = loadPreferences();
  expect(reloaded.getAiSessionCreationPreferences()).toEqual({ byControlPlane: {} });
  const unsubscribeReloaded = reloaded.subscribeAiSessionCreationPreferences(() => undefined);
  await flush();
  expect(reloaded.aiSessionCreationPreferencesFor(reloaded.getAiSessionCreationPreferences(), 'cp-1', 'claude')).toEqual({ reasoningEffort: 'low' });
  expect(reloaded.aiSessionCreationPreferencesFor(reloaded.getAiSessionCreationPreferences(), 'cp-2', 'codex')).toEqual({ reasoningEffort: 'max' });
  expect(reloaded.aiSessionCreationPreferencesFor(reloaded.getAiSessionCreationPreferences(), 'cp-1', 'missing')).toEqual({});

  await reloaded.clearAiSessionCreationPreferences('cp-1');
  await flush();
  expect(reloaded.aiSessionCreationPreferencesFor(reloaded.getAiSessionCreationPreferences(), 'cp-1', 'codex')).toEqual({});
  expect(reloaded.aiSessionCreationPreferencesFor(reloaded.getAiSessionCreationPreferences(), 'cp-2', 'codex')).toEqual({ reasoningEffort: 'max' });
  unsubscribeReloaded();
});

test('hydrates before writing so a first selection preserves other stored preferences', async () => {
  secureStore.__store.set('task-handoff.mobile.ai-session-creation-preferences', JSON.stringify({
    version: 1,
    byControlPlane: {
      'cp-1': { claude: { reasoningEffort: 'low' } },
    },
  }));
  const preferences = loadPreferences();
  await preferences.rememberAiSessionCreationPreferences('cp-1', 'codex', { reasoningEffort: 'high' });
  expect(preferences.aiSessionCreationPreferencesFor(preferences.getAiSessionCreationPreferences(), 'cp-1', 'claude')).toEqual({ reasoningEffort: 'low' });
  expect(preferences.aiSessionCreationPreferencesFor(preferences.getAiSessionCreationPreferences(), 'cp-1', 'codex')).toEqual({ reasoningEffort: 'high' });
});
