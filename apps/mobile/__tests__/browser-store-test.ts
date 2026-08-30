import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

jest.mock('../src/control-plane/browser-context', () => ({
  prepareMobileBrowserContext: jest.fn(async () => ({ contextId: 'native_context_1' })),
  activateMobileBrowserContext: jest.fn(async () => undefined),
  releaseBrowserContext: jest.fn(async () => undefined),
}));

import { MobileBrowserController } from '../src/browser/controller';
import { MobileBrowserTabStore } from '../src/browser/store';
import { fromBrowserTransportAddress, normalizeBrowserAddress, toBrowserTransportAddress } from '../src/browser/url';
import { activateMobileBrowserContext, prepareMobileBrowserContext, releaseBrowserContext } from '../src/control-plane/browser-context';
import type { MobileControlPlaneProfile } from '../src/control-plane/profile';

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
