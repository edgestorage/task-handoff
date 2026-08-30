import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import type { MobileControlPlaneProfile } from '../src/control-plane/profile';

jest.mock('../modules/task-handoff-browser/src', () => ({
  browserCapabilities: jest.fn(async () => ({
    supported: true,
    platform: 'ios',
    proxyOverride: true,
    isolatedProfile: true,
  })),
  prepareBrowserContext: jest.fn(async () => ({ contextId: 'opaque-context' })),
  releaseBrowserContext: jest.fn(),
  releaseAllBrowserContexts: jest.fn(),
}));

import { mobileBrowserCapability, prepareMobileBrowserContext } from '../src/control-plane/browser-context';
import { prepareBrowserContext } from '../modules/task-handoff-browser/src';

const direct: MobileControlPlaneProfile = {
  version: 1,
  identity: { controlPlaneId: 'cp_1', publicKeyFingerprint: `sha256:${'a'.repeat(43)}` },
  capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true, triggers: true },
  access: { kind: 'direct', origin: 'https://cp.example.test/base', secureSessionKey: 'mobile.session' },
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};
const timeline = { sessionReadAgents: [], turnReadAgents: [], liveItemAgents: [] };

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
