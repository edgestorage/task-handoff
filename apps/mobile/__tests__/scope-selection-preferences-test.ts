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
type PreferencesModule = typeof import('../src/scope-selection/preferences');

function loadPreferences(): PreferencesModule {
  let loaded: PreferencesModule | undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { loaded = require('../src/scope-selection/preferences') as PreferencesModule; });
  return loaded!;
}

async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

beforeEach(() => { secureStore.__store.clear(); });

test('parses scope selections and ignores malformed entries', () => {
  const { parseScopeSelectionPreferences } = loadPreferences();
  expect(parseScopeSelectionPreferences(JSON.stringify({
    version: 1,
    instanceScopeByControlPlane: {
      'cp-1': { kind: 'instance', instanceId: 'instance-a' },
      'cp-2': { kind: 'all' },
      'cp-3': { kind: 'instance', instanceId: '' },
      'cp-4': 'invalid',
    },
    storyNodeFilterByControlPlane: {
      'cp-1': { kind: 'selected', nodeIds: ['node-a', 'node-a', '', 'node-b'] },
      'cp-2': { kind: 'selected', nodeIds: [] },
      'cp-3': { kind: 'all' },
    },
  }))).toEqual({
    instanceScopeByControlPlane: {
      'cp-1': { kind: 'instance', instanceId: 'instance-a' },
      'cp-2': { kind: 'all' },
    },
    storyNodeFilterByControlPlane: {
      'cp-1': { kind: 'selected', nodeIds: ['node-a', 'node-b'] },
      'cp-2': { kind: 'all' },
      'cp-3': { kind: 'all' },
    },
  });
  expect(parseScopeSelectionPreferences(JSON.stringify({ version: 99 }))).toBeUndefined();
  expect(parseScopeSelectionPreferences('not json')).toBeUndefined();
  expect(parseScopeSelectionPreferences(null)).toBeUndefined();
});

test('keeps instance and Story node selections after the module reloads', async () => {
  const first = loadPreferences();
  const unsubscribe = first.subscribeScopeSelectionPreferences(() => undefined);
  first.setInstanceScopeSelection('cp-1', { kind: 'instance', instanceId: 'instance-a' });
  first.setStoryNodeFilterSelection('cp-1', { kind: 'selected', nodeIds: ['node-a', 'node-b'] });
  await flush();
  unsubscribe();

  const reloaded = loadPreferences();
  expect(reloaded.getScopeSelectionPreferences()).toEqual({
    instanceScopeByControlPlane: {},
    storyNodeFilterByControlPlane: {},
  });
  const unsubscribeReloaded = reloaded.subscribeScopeSelectionPreferences(() => undefined);
  await flush();
  expect(reloaded.getScopeSelectionPreferences()).toEqual({
    instanceScopeByControlPlane: { 'cp-1': { kind: 'instance', instanceId: 'instance-a' } },
    storyNodeFilterByControlPlane: { 'cp-1': { kind: 'selected', nodeIds: ['node-a', 'node-b'] } },
  });
  unsubscribeReloaded();
});

test('a selection made before hydration wins over the stored snapshot', async () => {
  secureStore.__store.set('task-handoff.mobile.scope-selection-preferences', JSON.stringify({
    version: 1,
    instanceScopeByControlPlane: { 'cp-1': { kind: 'instance', instanceId: 'stored-instance' } },
    storyNodeFilterByControlPlane: {},
  }));

  const preferences = loadPreferences();
  const unsubscribe = preferences.subscribeScopeSelectionPreferences(() => undefined);
  preferences.setInstanceScopeSelection('cp-1', { kind: 'all' });
  await flush();
  expect(preferences.getScopeSelectionPreferences().instanceScopeByControlPlane['cp-1']).toEqual({ kind: 'all' });
  unsubscribe();
});

test('clearing a removed Control Plane keeps other profile selections', async () => {
  const preferences = loadPreferences();
  const unsubscribe = preferences.subscribeScopeSelectionPreferences(() => undefined);
  preferences.setInstanceScopeSelection('cp-1', { kind: 'instance', instanceId: 'instance-a' });
  preferences.setStoryNodeFilterSelection('cp-1', { kind: 'selected', nodeIds: ['node-a'] });
  preferences.setInstanceScopeSelection('cp-2', { kind: 'instance', instanceId: 'instance-b' });
  preferences.clearScopeSelectionPreferences('cp-1');
  await flush();
  expect(preferences.getScopeSelectionPreferences()).toEqual({
    instanceScopeByControlPlane: { 'cp-2': { kind: 'instance', instanceId: 'instance-b' } },
    storyNodeFilterByControlPlane: {},
  });
  unsubscribe();
});
