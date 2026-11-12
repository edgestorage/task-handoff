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

type SessionLinksModule = typeof import('../src/remote-desktop/session-links');

function loadSessionLinks(): SessionLinksModule {
  let loaded: SessionLinksModule | undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { loaded = require('../src/remote-desktop/session-links') as SessionLinksModule; });
  return loaded!;
}

async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

beforeEach(() => { secureStore.__store.clear(); });

test('parses and sanitizes persisted session remote desktop links', () => {
  const { parseSessionRemoteDesktopLinks, sessionRemoteDesktopLinkKey } = loadSessionLinks();
  const key = sessionRemoteDesktopLinkKey('cp_1', 'instance_1', 'session_1');
  const parsed = parseSessionRemoteDesktopLinks(JSON.stringify({
    version: 1,
    bySession: {
      [key]: {
        target: { kind: 'window', sourceRef: 'window_1', title: 'Editor', unknown: true },
        openedAt: 10,
        lastUsedAt: 20,
        futureField: true,
      },
      invalid: { target: null, openedAt: 1 },
    },
  }));
  expect(parsed?.bySession[key]).toEqual({
    target: { kind: 'window', sourceRef: 'window_1', title: 'Editor' },
    openedAt: 10,
    lastUsedAt: 20,
  });
  expect(parsed?.bySession.invalid).toBeUndefined();
  expect(parseSessionRemoteDesktopLinks(JSON.stringify({ version: 2, bySession: {} }))).toBeUndefined();
  expect(parseSessionRemoteDesktopLinks('not json')).toBeUndefined();
});

test('keeps independent links per instance and session', () => {
  const {
    rememberSessionRemoteDesktopLink,
    removeSessionRemoteDesktopLink,
    sessionRemoteDesktopLinkFor,
  } = loadSessionLinks();
  rememberSessionRemoteDesktopLink({
    controlPlaneId: 'cp_1', instanceId: 'instance_1', sessionId: 'session_a',
    target: { kind: 'window', sourceRef: 'window_a', title: 'Window A' }, at: 100,
  });
  rememberSessionRemoteDesktopLink({
    controlPlaneId: 'cp_1', instanceId: 'instance_1', sessionId: 'session_b',
    target: { kind: 'display', sourceRef: 'display_1', title: 'Display' }, at: 200,
  });
  expect(sessionRemoteDesktopLinkFor('cp_1', 'instance_1', 'session_a')?.target.sourceRef).toBe('window_a');
  expect(sessionRemoteDesktopLinkFor('cp_1', 'instance_1', 'session_b')?.target.sourceRef).toBe('display_1');
  expect(sessionRemoteDesktopLinkFor('cp_2', 'instance_1', 'session_a')).toBeUndefined();

  removeSessionRemoteDesktopLink('cp_1', 'instance_1', 'session_a');
  expect(sessionRemoteDesktopLinkFor('cp_1', 'instance_1', 'session_a')).toBeUndefined();
  expect(sessionRemoteDesktopLinkFor('cp_1', 'instance_1', 'session_b')?.target.sourceRef).toBe('display_1');
});

test('preserves the first opened time and restores links after reload', async () => {
  const first = loadSessionLinks();
  const unsubscribe = first.sessionRemoteDesktopLinkStore.subscribe(() => undefined);
  first.rememberSessionRemoteDesktopLink({
    controlPlaneId: 'cp_1', instanceId: 'instance_1', sessionId: 'session_a',
    target: { kind: 'window', sourceRef: 'window_old', title: 'Old' }, at: 10,
  });
  first.rememberSessionRemoteDesktopLink({
    controlPlaneId: 'cp_1', instanceId: 'instance_1', sessionId: 'session_a',
    target: { kind: 'window', sourceRef: 'window_new', title: 'New' }, at: 20,
  });
  const link = first.sessionRemoteDesktopLinkFor('cp_1', 'instance_1', 'session_a');
  expect(link).toEqual(expect.objectContaining({ openedAt: 10, lastUsedAt: 20 }));
  expect(link?.target.sourceRef).toBe('window_new');
  await flush();
  unsubscribe();
  expect(secureStore.__store.size).toBe(1);

  const reloaded = loadSessionLinks();
  const unsubscribeReloaded = reloaded.sessionRemoteDesktopLinkStore.subscribe(() => undefined);
  await flush();
  expect(reloaded.sessionRemoteDesktopLinkFor('cp_1', 'instance_1', 'session_a')).toEqual(expect.objectContaining({
    openedAt: 10,
    lastUsedAt: 20,
    target: expect.objectContaining({ sourceRef: 'window_new', title: 'New' }),
  }));
  unsubscribeReloaded();
});
