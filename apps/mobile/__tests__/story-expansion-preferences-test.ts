jest.mock('../src/platform/file-storage', () => {
  const files = new Map<string, string>();
  return {
    files,
    ExpoFileValueStore: class {
      async get(key: string) { return files.get(key); }
      async set(key: string, value: string) { files.set(key, value); }
    },
  };
});

type PreferencesModule = typeof import('../src/stories/story-expansion-preferences');

const { files } = jest.requireMock<{ files: Map<string, string> }>('../src/platform/file-storage');

function reloadPreferences() {
  let preferences!: PreferencesModule;
  jest.isolateModules(() => {
    preferences = jest.requireActual<PreferencesModule>('../src/stories/story-expansion-preferences');
  });
  return preferences;
}

const flushStorage = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { files.clear(); });

test('restores Story disclosure on restart and persists a collapse without losing other nodes', async () => {
  const initial = reloadPreferences();
  expect(initial.getExpandedStoryKeys()).toEqual([]);
  await Promise.all([
    initial.toggleExpandedStoryKey('node-a:story-a'),
    initial.toggleExpandedStoryKey('node-b:story-a'),
  ]);
  await flushStorage();

  const reopened = reloadPreferences();
  const unsubscribe = reopened.subscribeExpandedStoryKeys(jest.fn());
  await flushStorage();
  expect(reopened.getExpandedStoryKeys()).toEqual(['node-a:story-a', 'node-b:story-a']);
  await reopened.toggleExpandedStoryKey('node-a:story-a');
  await flushStorage();
  unsubscribe();

  const restarted = reloadPreferences();
  const unsubscribeRestarted = restarted.subscribeExpandedStoryKeys(jest.fn());
  await flushStorage();
  expect(restarted.getExpandedStoryKeys()).toEqual(['node-b:story-a']);
  unsubscribeRestarted();
});

test('a toggle before hydration completes applies to the saved keys', async () => {
  files.set('task-handoff.mobile.story-expansion-preferences', JSON.stringify({
    version: 1,
    expandedKeys: ['node-a:story-a', 'node-b:story-a', 'node-b:story-a', null],
  }));
  const preferences = reloadPreferences();
  await preferences.toggleExpandedStoryKey('node-a:story-a');
  await flushStorage();
  expect(preferences.getExpandedStoryKeys()).toEqual(['node-b:story-a']);
});
