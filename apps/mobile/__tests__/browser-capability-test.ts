import { mobileBrowserCapability, prepareMobileBrowserContext, releaseBrowserContext, releaseAllBrowserContexts } from '../src/control-plane/browser-context';
import { prepareBrowserContext, subscribeBrowserDiagnostics, releaseBrowserContext as nativeReleaseBrowserContext } from '../modules/task-handoff-browser/src';
import { diagnosticLog } from '../src/observability/diagnostic-logs';

import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import type { MobileControlPlaneProfile } from '../src/control-plane/profile';

jest.mock('../src/observability/diagnostic-logs', () => ({ diagnosticLog: { info: jest.fn(), warn: jest.fn() } }));

jest.mock('../modules/task-handoff-browser/src', () => ({
  browserCapabilities: jest.fn(async () => ({
    supported: true,
    platform: 'ios',
    proxyOverride: true,
    isolatedProfile: true,
  })),
  prepareBrowserContext: jest.fn(async () => ({ contextId: 'opaque-context' })),
  isBridgedBrowserTransportAvailable: jest.fn(() => true),
  createBridgedBrowserTransport: jest.fn(async () => ({ transportId: 'bridge_1', close: jest.fn(), isClosed: () => false })),
  releaseBrowserContext: jest.fn(),
  releaseAllBrowserContexts: jest.fn(),
  subscribeBrowserDiagnostics: jest.fn(() => ({ remove: jest.fn() })),
}));


const direct: MobileControlPlaneProfile = {
  version: 1,
  identity: { controlPlaneId: 'cp_1', publicKeyFingerprint: `sha256:${'a'.repeat(43)}` },
  capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true, triggers: true },
  access: { kind: 'direct', origin: 'https://cp.example.test/base', secureSessionKey: 'mobile.session' },
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};
const timeline = { sessionReadAgents: [], turnReadAgents: [], liveItemAgents: [], toolActivityAgents: [] };
afterEach(async () => { await releaseAllBrowserContexts(); });

test('Browser capability requires native, directory, and Direct transport support', async () => {
  await expect(mobileBrowserCapability(direct, { browserTunnel: true, aiSessionTimeline: timeline })).resolves.toMatchObject({ supported: true });
  await expect(mobileBrowserCapability(direct, { aiSessionTimeline: timeline })).resolves.toMatchObject({
    supported: false,
    reason: 'INSTANCE_BROWSER_TUNNEL_UNAVAILABLE',
  });
  await expect(mobileBrowserCapability({
    ...direct,
    access: {
      kind: 'cloud-relay', serviceOrigin: 'https://cloud.example.test', bindingId: 'binding_1', bindingRevision: 1,
      accountSession: { id: 'account_1', secureCredentialKey: 'cloud.session' },
      transport: { request: true, stream: true, webSocket: true },
    },
  }, { browserTunnel: true, aiSessionTimeline: timeline })).resolves.toMatchObject({
    supported: false,
    reason: 'TRANSPORT_BROWSER_CHANNEL_UNAVAILABLE',
  });
});

test('Browser access credential crosses JS only at the Control Plane/native boundary', async () => {
  const api = {
    browser: { access: jest.fn(async () => ({ relayPath: '/browser-relay', token: 'x'.repeat(32) })) },
  } as unknown as ControlPlaneClient;
  await expect(prepareMobileBrowserContext({ api, profile: direct, instanceId: 'instance/1' })).resolves.toEqual({ contextId: 'opaque-context' });
  expect(prepareBrowserContext).toHaveBeenCalledWith({
    controlPlaneId: 'cp_1',
    instanceId: 'instance/1',
    relayUrl: 'wss://cp.example.test/browser-relay',
    token: 'x'.repeat(32),
  });
});


test('cloud browser capability is negotiated through the shared client rather than profile kind', async () => {
  const cloud: MobileControlPlaneProfile = { ...direct, access: {
    kind: 'cloud-relay', serviceOrigin: 'https://cloud.example.test', bindingId: 'binding_1', bindingRevision: 1,
    accountSession: { id: 'account_1', secureCredentialKey: 'cloud.session' }, transport: { request: true, stream: true, webSocket: true },
  } };
  const api = { browser: { supportsChannel: jest.fn(async () => true), openChannel: jest.fn() } } as unknown as ControlPlaneClient;
  await expect(mobileBrowserCapability(cloud, { browserTunnel: true, aiSessionTimeline: timeline }, api)).resolves.toMatchObject({ supported: true, directTransport: false });
  await expect(prepareMobileBrowserContext({ api, profile: cloud, instanceId: 'instance_1' })).resolves.toEqual({ contextId: 'opaque-context' });
  expect(prepareBrowserContext).toHaveBeenLastCalledWith({ controlPlaneId: 'cp_1', instanceId: 'instance_1', transportId: 'bridge_1' });
});

test('native stages are scoped to the preparing instance and the listener is removed on failure', async () => {
  jest.clearAllMocks();
  const remove = jest.fn();
  jest.mocked(subscribeBrowserDiagnostics).mockReturnValueOnce({ remove });
  const failure = Object.assign(new Error('private native detail'), { code: 'BROWSER_CONTEXT_PREPARE_FAILED' });
  jest.mocked(prepareBrowserContext).mockImplementationOnce(async () => {
    const listener = jest.mocked(subscribeBrowserDiagnostics).mock.calls[0][0];
    listener({ controlPlaneId: 'other_cp', instanceId: 'inst_1', stage: 'wrong-profile', elapsedMs: 1 });
    listener({ controlPlaneId: 'cp_1', instanceId: 'other_inst', stage: 'wrong-instance', elapsedMs: 1 });
    listener({ controlPlaneId: 'cp_1', instanceId: 'inst_1', stage: 'hello.send', elapsedMs: 2 });
    throw failure;
  });
  const api = { browser: { access: async () => ({ accessId: 'access_1', relayPath: '/browser-relay', token: 'private-access-token' }) } } as unknown as ControlPlaneClient;
  await expect(prepareMobileBrowserContext({ api, profile: direct, instanceId: 'inst_1' })).rejects.toBe(failure);
  expect(remove).toHaveBeenCalledTimes(1);
  const stages = jest.mocked(diagnosticLog.info).mock.calls.filter(([event]) => event === 'browser.native.stage');
  expect(stages).toHaveLength(1);
  expect(stages[0][1]).toMatchObject({ controlPlaneId: 'cp_1', instanceId: 'inst_1', stage: 'hello.send', connectionId: expect.any(String) });
  const logs = JSON.stringify([...jest.mocked(diagnosticLog.info).mock.calls, ...jest.mocked(diagnosticLog.warn).mock.calls]);
  expect(logs).not.toContain('private-access-token');
  expect(logs).not.toContain('private native detail');
});

test('Direct native closure after prepare remains observable until release, with codes and context isolation', async () => {
  jest.clearAllMocks();
  const remove = jest.fn();
  jest.mocked(subscribeBrowserDiagnostics).mockReturnValueOnce({ remove });
  const onClose = jest.fn();
  const api = { browser: { access: async () => ({ relayPath: '/browser-relay', token: 'private' }) } } as unknown as ControlPlaneClient;
  const prepared = await prepareMobileBrowserContext({ api, profile: direct, instanceId: 'inst', onClose });
  const listener = jest.mocked(subscribeBrowserDiagnostics).mock.calls[0][0];
  expect(remove).not.toHaveBeenCalled();
  listener({ controlPlaneId: 'cp_1', instanceId: 'inst', contextId: 'stale', stage: 'tunnel.closed', elapsedMs: 10 });
  expect(onClose).not.toHaveBeenCalled();
  const event = { controlPlaneId: 'cp_1', instanceId: 'inst', contextId: prepared.contextId, stage: 'tunnel.closed',
    elapsedMs: 15, closeSource: 'frame.decode', errorDomain: 'BrowserTunnelProtocolError', errorCode: 1 };
  listener(event); listener(event);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: 'BROWSER_NATIVE_TUNNEL_CLOSED', closeSource: 'native.frame.decode', nativeErrorDomain: 'BrowserTunnelProtocolError', nativeErrorCode: 1 }));
  await releaseBrowserContext(prepared.contextId);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(nativeReleaseBrowserContext).toHaveBeenCalledWith(prepared.contextId);
  listener(event);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('an older native build without diagnostic subscription retains Direct preparation support', async () => {
  jest.mocked(subscribeBrowserDiagnostics).mockReturnValueOnce(undefined);
  const api = { browser: { access: async () => ({ relayPath: '/browser-relay', token: 'private' }) } } as unknown as ControlPlaneClient;
  await expect(prepareMobileBrowserContext({ api, profile: direct, instanceId: 'inst' })).resolves.toEqual({ contextId: 'opaque-context' });
});
