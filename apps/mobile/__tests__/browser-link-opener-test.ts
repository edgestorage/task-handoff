import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import { openEmbeddedWebBrowserLink } from '../src/browser/link-opener';
import type { MobileBrowserCapability } from '../src/control-plane/browser-context';
import type { MobileControlPlaneProfile } from '../src/control-plane/profile';

const direct: MobileControlPlaneProfile = {
  version: 1,
  identity: { controlPlaneId: 'cp_1', publicKeyFingerprint: `sha256:${'a'.repeat(43)}` },
  capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true, triggers: true },
  access: { kind: 'direct', origin: 'https://cp.example.test', secureSessionKey: 'session' },
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};
const cloud: MobileControlPlaneProfile = {
  ...direct,
  access: {
    kind: 'cloud-relay',
    serviceOrigin: 'https://cloud.example.test',
    bindingId: 'binding_1',
    bindingRevision: 1,
    accountSession: { id: 'account_1', secureCredentialKey: 'cloud.session' },
    transport: { request: true, stream: true, webSocket: true },
  },
};
const api = {} as ControlPlaneClient;
const timeline = { sessionReadAgents: [], turnReadAgents: [], liveItemAgents: [], toolActivityAgents: [] };

function dependencies(capability: MobileBrowserCapability) {
  return {
    browserCapability: jest.fn(async () => capability),
    createTab: jest.fn(async () => ({ id: 'tab_1' })),
    openAppBrowser: jest.fn(async () => ({ type: 'opened' })),
    diagnostic: jest.fn(),
  };
}

test('uses the instance-tunneled Browser tab when the transport supports it', async () => {
  const deps = dependencies({ supported: true, platform: 'ios', proxyOverride: true, isolatedProfile: true, directory: true, directTransport: true });
  await expect(openEmbeddedWebBrowserLink({ api, capabilities: { aiSessionTimeline: timeline, browserTunnel: true }, instanceId: 'instance_1', profile: direct, url: 'example.com/docs' }, deps))
    .resolves.toEqual({ kind: 'tab', tabId: 'tab_1' });
  expect(deps.createTab).toHaveBeenCalledWith(expect.objectContaining({ initialUrl: 'https://example.com/docs' }));
  expect(deps.openAppBrowser).not.toHaveBeenCalled();
});

test('falls back to the native in-app browser when cloud Relay cannot carry Browser Tunnel', async () => {
  const deps = dependencies({
    supported: false,
    platform: 'ios',
    proxyOverride: true,
    isolatedProfile: true,
    directory: true,
    directTransport: false,
    reason: 'TRANSPORT_BROWSER_CHANNEL_UNAVAILABLE',
  });
  await expect(openEmbeddedWebBrowserLink({ api, capabilities: { aiSessionTimeline: timeline, browserTunnel: true }, instanceId: 'instance_1', profile: cloud, url: 'https://example.com/docs' }, deps))
    .resolves.toEqual({ kind: 'app-browser' });
  expect(deps.createTab).not.toHaveBeenCalled();
  expect(deps.openAppBrowser).toHaveBeenCalledWith('https://example.com/docs');
  expect(deps.diagnostic).toHaveBeenCalledWith('info', 'browser.link.native_fallback', expect.objectContaining({
    reason: 'TRANSPORT_BROWSER_CHANNEL_UNAVAILABLE',
  }));
});

test('uses the native in-app browser without a Control Plane runtime and rejects non-web links', async () => {
  const deps = dependencies({ supported: true, platform: 'ios', proxyOverride: true, isolatedProfile: true, directory: true, directTransport: true });
  await expect(openEmbeddedWebBrowserLink({ instanceId: 'instance_1', url: 'https://example.com/docs' }, deps)).resolves.toEqual({ kind: 'app-browser' });
  await expect(openEmbeddedWebBrowserLink({ api, instanceId: 'instance_1', profile: direct, url: 'mailto:test@example.com' }, deps))
    .rejects.toMatchObject({ code: 'BROWSER_ADDRESS_INVALID' });
  expect(deps.openAppBrowser).toHaveBeenCalledTimes(1);
});
