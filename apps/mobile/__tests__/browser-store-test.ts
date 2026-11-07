import { MobileBrowserController } from '../src/browser/controller';
import { MobileBrowserTabStore } from '../src/browser/store';
import { fromBrowserTransportAddress, normalizeBrowserAddress, toBrowserTransportAddress } from '../src/browser/url';
import { activateMobileBrowserContext, prepareMobileBrowserContext, releaseBrowserContext } from '../src/control-plane/browser-context';
import type { MobileControlPlaneProfile } from '../src/control-plane/profile';

import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

jest.mock('../src/control-plane/browser-context', () => ({
  prepareMobileBrowserContext: jest.fn(async () => ({ contextId: 'native_context_1' })),
  activateMobileBrowserContext: jest.fn(async () => undefined),
  releaseBrowserContext: jest.fn(async () => undefined),
}));


const profile: MobileControlPlaneProfile = {
  version: 1,
  identity: { controlPlaneId: 'cp_1', publicKeyFingerprint: `sha256:${'a'.repeat(43)}` },
  capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true, triggers: true },
  access: { kind: 'direct', origin: 'https://cp.example.test', secureSessionKey: 'session' },
  createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
};
const api = {} as ControlPlaneClient;

beforeEach(() => jest.clearAllMocks());

test('Browser addresses default to HTTPS and reject credentials or external schemes', () => {
  expect(normalizeBrowserAddress('example.test/path')).toBe('https://example.test/path');
  expect(normalizeBrowserAddress('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
  expect(toBrowserTransportAddress('http://127.0.0.1:3000')).toBe('http://127-0-0-1.internal:3000/');
  expect(toBrowserTransportAddress('http://127.0.0.2:3000')).toBe('http://127-0-0-2.internal:3000/');
  expect(fromBrowserTransportAddress('http://127-0-0-1.internal:3000/path')).toBe('http://127.0.0.1:3000/path');
  expect(fromBrowserTransportAddress('http://127-0-0-2.internal:3000/path')).toBe('http://127.0.0.2:3000/path');
  expect(() => normalizeBrowserAddress('file:///tmp/private')).toThrow(/HTTP or HTTPS/);
  expect(() => normalizeBrowserAddress('https://user:password@example.test')).toThrow(/HTTP or HTTPS/);
});

test('local Browser tabs share one native context until the last tab closes', async () => {
  const store = new MobileBrowserTabStore(
    (() => { let id = 0; return () => `tab_${++id}`; })(),
    () => '2026-08-29T00:00:00.000Z',
  );
  const controller = new MobileBrowserController(store);
  const first = await controller.create({ api, profile, instanceId: 'instance_1' });
  const second = await controller.create({ api, profile, instanceId: 'instance_1', initialUrl: 'localhost:3000' });
  expect(prepareMobileBrowserContext).toHaveBeenCalledTimes(1);
  expect(store.tabsFor('cp_1', 'instance_1').map((tab) => tab.id)).toEqual(['tab_1', 'tab_2']);
  expect(controller.contextId('cp_1', 'instance_1')).toBe('native_context_1');
  await controller.close('cp_1', 'instance_1', first.id);
  expect(releaseBrowserContext).not.toHaveBeenCalled();
  await controller.close('cp_1', 'instance_1', second.id);
  expect(releaseBrowserContext).toHaveBeenCalledWith('native_context_1');
});

test('profile cleanup removes only its tabs and releases each instance context', async () => {
  const store = new MobileBrowserTabStore(() => Math.random().toString(36), () => '2026-08-29T00:00:00.000Z');
  const controller = new MobileBrowserController(store);
  await controller.create({ api, profile, instanceId: 'instance_1' });
  await controller.create({ api, profile, instanceId: 'instance_2' });
  await controller.clearProfile('cp_1');
  expect(store.tabsFor('cp_1')).toEqual([]);
  expect(releaseBrowserContext).toHaveBeenCalledTimes(2);
});

test('Relay loss releases the old context, preserves tabs, and creates a fresh tunnel on activation', async () => {
  jest.mocked(prepareMobileBrowserContext)
    .mockResolvedValueOnce({ contextId: 'before_rekey' })
    .mockResolvedValueOnce({ contextId: 'after_rekey' });
  const store = new MobileBrowserTabStore(() => 'retained_tab', () => '2026-11-07T00:00:00.000Z');
  const controller = new MobileBrowserController(store);
  const tab = await controller.create({ api, profile, instanceId: 'instance_1', initialUrl: 'http://localhost:3000' });
  const oldConnection = jest.mocked(prepareMobileBrowserContext).mock.calls[0][0];
  oldConnection.onClose?.(new Error('Relay rekey'));
  expect(controller.contextId('cp_1', 'instance_1')).toBeUndefined();
  expect(store.tabsFor('cp_1', 'instance_1')).toEqual([tab]);
  await controller.activate(api, profile, 'instance_1');
  expect(releaseBrowserContext).toHaveBeenCalledWith('before_rekey');
  expect(controller.contextId('cp_1', 'instance_1')).toBe('after_rekey');
  // A late notification from the old Relay must not release its replacement.
  oldConnection.onClose?.();
  expect(controller.contextId('cp_1', 'instance_1')).toBe('after_rekey');
  await controller.clearProfile('cp_1');
});

test('a context that resolves after profile cleanup is released instead of resurrected', async () => {
  let resolveContext!: (value: { contextId: string }) => void;
  jest.mocked(prepareMobileBrowserContext).mockReturnValueOnce(new Promise((resolve) => { resolveContext = resolve; }));
  const store = new MobileBrowserTabStore(() => 'tab_late', () => '2026-08-29T00:00:00.000Z');
  const controller = new MobileBrowserController(store);
  const creating = controller.create({ api, profile, instanceId: 'instance_late' });
  while (!jest.mocked(prepareMobileBrowserContext).mock.calls.length) await Promise.resolve();
  const clearing = controller.clearProfile('cp_1');
  resolveContext({ contextId: 'native_context_late' });
  await expect(creating).resolves.toMatchObject({ id: 'tab_late' });
  await clearing;
  expect(controller.contextId('cp_1', 'instance_late')).toBeUndefined();
  expect(releaseBrowserContext).toHaveBeenCalledWith('native_context_late');
});

test('activating another instance retains both contexts and rebinds the proxy when returning', async () => {
  jest.mocked(prepareMobileBrowserContext)
    .mockResolvedValueOnce({ contextId: 'native_instance_1' })
    .mockResolvedValueOnce({ contextId: 'native_instance_2' });
  const store = new MobileBrowserTabStore(
    (() => { let id = 0; return () => `switch_${++id}`; })(),
    () => '2026-08-29T00:00:00.000Z',
  );
  const controller = new MobileBrowserController(store);
  await controller.create({ api, profile, instanceId: 'instance_1' });
  await controller.create({ api, profile, instanceId: 'instance_2' });
  expect(releaseBrowserContext).not.toHaveBeenCalledWith('native_instance_1');
  expect(controller.contextId('cp_1', 'instance_1')).toBe('native_instance_1');
  expect(controller.contextId('cp_1', 'instance_2')).toBe('native_instance_2');
  await controller.activate(api, profile, 'instance_1');
  expect(activateMobileBrowserContext).toHaveBeenCalledWith('native_instance_1');
  expect(store.tabsFor('cp_1').map((tab) => tab.instanceId)).toEqual(['instance_1', 'instance_2']);
});

test('browser context suspension is delayed so a blurred route can resume without rebuilding its views', async () => {
  jest.useFakeTimers();
  try {
    const store = new MobileBrowserTabStore(() => 'tab_grace', () => '2026-08-29T00:00:00.000Z');
    const controller = new MobileBrowserController(store);
    await controller.create({ api, profile, instanceId: 'instance_grace' });
    await controller.suspend('cp_1', 'instance_grace');
    jest.advanceTimersByTime(29_999);
    expect(releaseBrowserContext).not.toHaveBeenCalled();
    await controller.activate(api, profile, 'instance_grace');
    jest.advanceTimersByTime(1_000);
    expect(releaseBrowserContext).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('browser tabs retain loading state for the session list', () => {
  const store = new MobileBrowserTabStore(() => 'tab_loading', () => '2026-08-29T00:00:00.000Z');
  const tab = store.create('cp_1', 'instance_1', 'https://example.test/');
  expect(tab.loading).toBe(false);
  expect(store.update('cp_1', 'instance_1', tab.id, { loading: true })).toBe(true);
  expect(store.snapshot().tabs[0]?.loading).toBe(true);
});

describe('foreground browser recovery', () => {
  const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
  beforeEach(() => { jest.useFakeTimers(); jest.spyOn(Math, 'random').mockReturnValue(0.5); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  test('a close rebuilds without a lifecycle event, after old cleanup, and ignores old notifications', async () => {
    jest.mocked(prepareMobileBrowserContext).mockResolvedValueOnce({ contextId: 'old' }).mockResolvedValueOnce({ contextId: 'new' });
    const store = new MobileBrowserTabStore(() => 'retained', () => 'now');
    const controller = new MobileBrowserController(store);
    const tab = await controller.create({ api, profile, instanceId: 'inst', initialUrl: 'http://localhost:3000/' });
    await controller.activate(api, profile, 'inst');
    const old = jest.mocked(prepareMobileBrowserContext).mock.calls[0][0];
    let finishRelease!: () => void;
    jest.mocked(releaseBrowserContext).mockImplementationOnce(() => new Promise((resolve) => { finishRelease = resolve; }));
    old.onClose?.();
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(prepareMobileBrowserContext).toHaveBeenCalledTimes(1);
    expect(controller.contextId('cp_1', 'inst')).toBeUndefined();
    finishRelease(); await flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(controller.contextId('cp_1', 'inst')).toBe('new');
    expect(store.tabsFor('cp_1', 'inst')).toEqual([tab]);
    old.onClose?.(); await flush();
    expect(controller.contextId('cp_1', 'inst')).toBe('new');
    expect(prepareMobileBrowserContext).toHaveBeenCalledTimes(2);
    await controller.clearProfile('cp_1');
  });

  test.each(['suspend', 'suspendAll', 'close', 'clearProfile'] as const)('%s cancels recovery before its retry runs', async (action) => {
    const store = new MobileBrowserTabStore(() => 'tab', () => 'now');
    const controller = new MobileBrowserController(store);
    const tab = await controller.create({ api, profile, instanceId: 'inst' });
    await controller.activate(api, profile, 'inst');
    jest.mocked(prepareMobileBrowserContext).mock.calls[0][0].onClose?.();
    await flush();
    if (action === 'suspend') await controller.suspend('cp_1', 'inst');
    if (action === 'suspendAll') await controller.suspendAll();
    if (action === 'close') await controller.close('cp_1', 'inst', tab.id);
    if (action === 'clearProfile') await controller.clearProfile('cp_1');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(prepareMobileBrowserContext).toHaveBeenCalledTimes(1);
    await controller.clearProfile('cp_1');
  });

  test('failed attempts and rapid successful closes share the existing exponential backoff', async () => {
    const controller = new MobileBrowserController(new MobileBrowserTabStore(() => 'tab', () => 'now'));
    await controller.create({ api, profile, instanceId: 'inst' });
    await controller.activate(api, profile, 'inst');
    jest.mocked(prepareMobileBrowserContext).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ contextId: 'replacement' });
    jest.mocked(prepareMobileBrowserContext).mock.calls[0][0].onClose?.();
    await flush(); await jest.advanceTimersByTimeAsync(0);
    expect(prepareMobileBrowserContext).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(249);
    expect(prepareMobileBrowserContext).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(controller.contextId('cp_1', 'inst')).toBe('replacement');
    jest.mocked(prepareMobileBrowserContext).mock.calls[2][0].onClose?.();
    await flush(); await jest.advanceTimersByTimeAsync(499);
    expect(prepareMobileBrowserContext).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(prepareMobileBrowserContext).toHaveBeenCalledTimes(4);
    await controller.clearProfile('cp_1');
  });

  test('profile removal during a recovery handshake releases its late result without resurrecting the context', async () => {
    const controller = new MobileBrowserController(new MobileBrowserTabStore(() => 'tab', () => 'now'));
    await controller.create({ api, profile, instanceId: 'inst' });
    await controller.activate(api, profile, 'inst');
    let finish!: (value: { contextId: string }) => void;
    jest.mocked(prepareMobileBrowserContext).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    jest.mocked(prepareMobileBrowserContext).mock.calls[0][0].onClose?.();
    await flush(); await jest.advanceTimersByTimeAsync(0);
    const clearing = controller.clearProfile('cp_1');
    finish({ contextId: 'late' }); await clearing; await flush();
    expect(releaseBrowserContext).toHaveBeenCalledWith('late');
    expect(controller.contextId('cp_1', 'inst')).toBeUndefined();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(prepareMobileBrowserContext).toHaveBeenCalledTimes(2);
  });
});
