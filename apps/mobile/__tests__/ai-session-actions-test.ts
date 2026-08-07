import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import { MobileAiSessionActionCoordinator, MobileAiSessionDraftStore, mobileAiSessionBusyKey } from '../src/ai-sessions/actions';
import { MobileAiSessionStore } from '../src/ai-sessions/store';
import type { SecureValueStore } from '../src/platform/secure-storage';
import { MOBILE_AI_SESSION_PERMISSION_TTL_MS, MobileAiSessionPermissionStore } from '../src/ai-sessions/permission-store';

function client(overrides: Partial<ControlPlaneClient['aiSessions']> = {}) {
  const snapshot = { updatedAt: '2026-08-05T00:00:00.000Z', instances: [] };
  return { aiSessions: {
    list: jest.fn().mockResolvedValue(snapshot),
    sendMessage: jest.fn().mockResolvedValue({}), approval: jest.fn().mockResolvedValue({}), interrupt: jest.fn().mockResolvedValue({}),
    close: jest.fn().mockResolvedValue({}),
    steerQueue: jest.fn().mockResolvedValue({}), retryQueue: jest.fn().mockResolvedValue({}), removeQueue: jest.fn().mockResolvedValue({}),
    ...overrides,
  } } as unknown as ControlPlaneClient;
}

test('busy keys isolate Control Plane, session, action, and queue identity', () => {
  expect(new Set([
    mobileAiSessionBusyKey('cp-a', 'i', 's', 'send'),
    mobileAiSessionBusyKey('cp-b', 'i', 's', 'send'),
    mobileAiSessionBusyKey('cp-a', 'i', 's', 'interrupt'),
    mobileAiSessionBusyKey('cp-a', 'i', 's', 'queue-retry', 'q-1'),
    mobileAiSessionBusyKey('cp-a', 'i', 's', 'queue-retry', 'q-2'),
  ]).size).toBe(5);
});

test('blocks duplicate action submission while the first request is unresolved', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => { resolve = done; });
  const api = client({ interrupt: jest.fn().mockReturnValue(pending) });
  const coordinator = new MobileAiSessionActionCoordinator('cp', api, new MobileAiSessionStore());
  const first = coordinator.interrupt('instance', 'session');
  expect(await coordinator.interrupt('instance', 'session')).toEqual({ disposition: 'duplicate-blocked' });
  resolve({});
  expect((await first).disposition).toBe('accepted');
  expect(api.aiSessions.interrupt).toHaveBeenCalledTimes(1);
});

test('closes through the shared client with an idempotency key and refreshes authoritative state', async () => {
  const api = client();
  const coordinator = new MobileAiSessionActionCoordinator('cp', api, new MobileAiSessionStore());
  expect((await coordinator.close('instance', 'session', 'close-request-1')).disposition).toBe('accepted');
  expect(api.aiSessions.close).toHaveBeenCalledWith('instance', 'session', 'close-request-1');
  expect(api.aiSessions.list).toHaveBeenCalledTimes(1);
});

test('keeps an authoritative action response accepted when only the follow-up snapshot refresh fails', async () => {
  const api = client({ list: jest.fn().mockRejectedValue(Object.assign(new Error('offline'), { code: 'DIRECT_NETWORK_FAILED', retryable: true })) });
  const coordinator = new MobileAiSessionActionCoordinator('cp', api, new MobileAiSessionStore());
  expect((await coordinator.interrupt('instance', 'session')).disposition).toBe('accepted');
  expect(coordinator.state(mobileAiSessionBusyKey('cp', 'instance', 'session', 'interrupt')).phase).toBe('idle');
});

test('does not replay an uncertain send and recovers from the authoritative snapshot', async () => {
  const error = Object.assign(new Error('connection lost'), { code: 'DIRECT_NETWORK_FAILED', retryable: true });
  const api = client({ sendMessage: jest.fn().mockRejectedValue(error) });
  const store = new MobileAiSessionStore();
  const coordinator = new MobileAiSessionActionCoordinator('cp', api, store);
  const result = await coordinator.send('instance', 'session', 'hello');
  expect(result.disposition).toBe('result-unknown');
  expect(api.aiSessions.sendMessage).toHaveBeenCalledTimes(1);
  expect(api.aiSessions.list).toHaveBeenCalledTimes(1);
  expect(coordinator.state(mobileAiSessionBusyKey('cp', 'instance', 'session', 'send')).phase).toBe('result-unknown');
  expect((await coordinator.send('instance', 'session', 'hello')).disposition).toBe('duplicate-blocked');
  expect(api.aiSessions.sendMessage).toHaveBeenCalledTimes(1);
});

test('preserves explicit steer mode at the protocol boundary', async () => {
  const api = client();
  const coordinator = new MobileAiSessionActionCoordinator('cp', api, new MobileAiSessionStore());
  await coordinator.send('instance', 'session', 'redirect', 'ask', [], 'steer');
  expect(api.aiSessions.sendMessage).toHaveBeenCalledWith('instance', 'session', expect.objectContaining({ message: 'redirect', mode: 'steer' }));
});

test('drafts are versioned and isolated by complete session identity', async () => {
  const values = new Map<string, string>();
  const storage: SecureValueStore = {
    available: async () => true,
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
  const drafts = new MobileAiSessionDraftStore(storage);
  await drafts.write('cp-a', 'instance', 'session', 'alpha');
  await drafts.write('cp-b', 'instance', 'session', 'beta');
  expect(await drafts.read('cp-a', 'instance', 'session')).toBe('alpha');
  expect(await drafts.read('cp-b', 'instance', 'session')).toBe('beta');
  await drafts.clearProfile('cp-a');
  expect(await drafts.read('cp-a', 'instance', 'session')).toBe('');
  expect(await drafts.read('cp-b', 'instance', 'session')).toBe('beta');
});

test('draft writes are serialized so an older native write cannot overwrite newer text', async () => {
  const values = new Map<string, string>();
  const storage: SecureValueStore = {
    available: async () => true,
    get: async (key) => values.get(key),
    set: async (key, value) => {
      if (value.includes('older')) await new Promise((resolve) => setTimeout(resolve, 10));
      values.set(key, value);
    },
    remove: async (key) => { values.delete(key); },
  };
  const drafts = new MobileAiSessionDraftStore(storage);
  await Promise.all([
    drafts.write('cp', 'instance', 'session', 'older'),
    drafts.write('cp', 'instance', 'session', 'newer'),
  ]);
  expect(await drafts.read('cp', 'instance', 'session')).toBe('newer');
});

test('permission modes survive restart, expire after 30 days, and remain isolated by profile and session', async () => {
  const values = new Map<string, string>();
  const storage: SecureValueStore = {
    available: async () => true,
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
  const now = Date.parse('2026-08-06T00:00:00.000Z');
  const permissions = new MobileAiSessionPermissionStore(storage);
  await permissions.write('cp-a', 'instance', 'session', 'full-access', now);

  const afterRestart = new MobileAiSessionPermissionStore(storage);
  expect(await afterRestart.read('cp-a', 'instance', 'session', 'ask', now + 1)).toBe('full-access');
  expect(await afterRestart.read('cp-b', 'instance', 'session', 'auto-review', now + 1)).toBe('auto-review');
  expect(await afterRestart.read('cp-a', 'instance', 'other-session', 'ask', now + 1)).toBe('ask');
  expect(await afterRestart.read('cp-a', 'instance', 'session', 'auto-review', now + MOBILE_AI_SESSION_PERMISSION_TTL_MS)).toBe('auto-review');

  await afterRestart.clearProfile('cp-a');
  expect(await new MobileAiSessionPermissionStore(storage).read('cp-a', 'instance', 'session', 'ask', now + 2)).toBe('ask');
  expect(await new MobileAiSessionPermissionStore(storage).read('cp-b', 'instance', 'session', 'ask', now + 2)).toBe('auto-review');
});

test('a request finishing after page or profile switch only recovers its original Control Plane state', async () => {
  let resolve!: (value: unknown) => void;
  const oldApi = client({ approval: jest.fn().mockReturnValue(new Promise((done) => { resolve = done; })) });
  const newApi = client();
  const store = new MobileAiSessionStore();
  const oldPage = new MobileAiSessionActionCoordinator('cp-old', oldApi, store);
  const pending = oldPage.approval('instance', 'session', 'allow');
  const newPage = new MobileAiSessionActionCoordinator('cp-new', newApi, store);
  await newPage.interrupt('instance', 'session');
  resolve({});
  await pending;
  expect(oldApi.aiSessions.list).toHaveBeenCalledTimes(1);
  expect(newApi.aiSessions.list).toHaveBeenCalledTimes(1);
  expect(store.profile('cp-old').controlPlaneId).toBe('cp-old');
  expect(store.profile('cp-new').controlPlaneId).toBe('cp-new');
});

test('a request finishing after profile deletion cannot recreate cleared session cache', async () => {
  let resolveSnapshot!: (value: unknown) => void;
  const api = client({ list: jest.fn().mockReturnValue(new Promise((resolve) => { resolveSnapshot = resolve; })) });
  const store = new MobileAiSessionStore();
  store.profile('cp-deleted');
  const coordinator = new MobileAiSessionActionCoordinator('cp-deleted', api, store);
  const pending = coordinator.interrupt('instance', 'session');
  await Promise.resolve();
  store.clearProfile('cp-deleted');
  resolveSnapshot({ updatedAt: '2026-08-05T00:00:00.000Z', instances: [] });
  await pending;
  expect(store.hasProfile('cp-deleted')).toBe(false);
});
