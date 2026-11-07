import * as SecureStore from 'expo-secure-store';

jest.mock('expo-secure-store', () => {
  const values = new Map<string, string>();
  return {
    __values: values,
    getItemAsync: jest.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, raw: string) => { values.set(key, raw); }),
  };
});

const storage = SecureStore as unknown as { __values: Map<string, string> };
type Preferences = typeof import('../src/app-sessions/launch-preferences');
function load(): Preferences {
  let preferences!: Preferences;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { preferences = require('../src/app-sessions/launch-preferences'); });
  return preferences;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => storage.__values.clear());

test('restores choices after restart, isolates profiles, and clears only the removed profile', async () => {
  const first = load();
  const unsubscribe = first.subscribeAppLaunchPreferences(() => undefined);
  await flush();
  first.rememberAppLaunchChoice('cp', 'instance', 'editor');
  first.rememberAppLaunchChoice('cp', 'other', 'terminal');
  first.rememberAppLaunchChoice('other-cp', 'instance', 'browser');
  await flush();
  unsubscribe();
  const second = load();
  const stop = second.subscribeAppLaunchPreferences(() => undefined);
  await flush();
  expect(second.getAppLaunchPreferences().appByScope).toEqual({
    '["cp","instance"]': 'editor', '["cp","other"]': 'terminal', '["other-cp","instance"]': 'browser',
  });
  second.clearAppLaunchPreferences('cp');
  expect(second.getAppLaunchPreferences().appByScope).toEqual({ '["other-cp","instance"]': 'browser' });
  await flush();
  stop();
});

test('ignores malformed saved entries and preserves opaque IDs and unknown fields', () => {
  const { parseAppLaunchPreferences } = load();
  expect(parseAppLaunchPreferences(JSON.stringify({ version: 1, future: true, appByScope: {
    '["legacy/cp","legacy/instance"]': 'future-app', broken: 'terminal', '["cp",null]': 'terminal', '["cp","other"]': 1,
  } }))).toEqual({ appByScope: { '["legacy/cp","legacy/instance"]': 'future-app' } });
  expect(parseAppLaunchPreferences('bad json')).toBeUndefined();
});

test('an explicit choice wins over a late stored preference', async () => {
  const prefs = load();
  storage.__values.set(prefs.APP_LAUNCH_PREFERENCES_KEY, JSON.stringify({ version: 1, appByScope: { '["cp","instance"]': 'old' } }));
  const stop = prefs.subscribeAppLaunchPreferences(() => undefined);
  prefs.rememberAppLaunchChoice('cp', 'instance', 'new');
  await flush();
  expect(prefs.getAppLaunchPreferences().appByScope['["cp","instance"]']).toBe('new');
  stop();
});
