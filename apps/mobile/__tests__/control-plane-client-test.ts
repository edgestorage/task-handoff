import { createMobileControlPlaneClient } from '../src/control-plane/client';
import type { MobileCloudRelayControlPlaneProfile } from '../src/control-plane/profile';
import type { SecureValueStore } from '../src/platform/secure-storage';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { variant: 'development', featureFlags: { officialAccount: true } } } },
}));

const credential = JSON.stringify({ refreshCredential: 'r'.repeat(48), deviceSessionId: 'device_a', accountId: 'account_a' });

const profile: MobileCloudRelayControlPlaneProfile = {
  version: 1,
  identity: {
    controlPlaneId: 'control_plane_a',
    publicKeyFingerprint: `sha256:${'a'.repeat(43)}`,
  },
  access: {
    kind: 'cloud-relay',
    serviceOrigin: 'https://cloud.test.example.com',
    bindingId: 'binding_a',
    bindingRevision: 1,
    accountSession: { id: 'device_a', secureCredentialKey: 'cloud.account.device_a' },
    transport: { request: true, stream: true, webSocket: true },
  },
  capabilities: {
    authentication: 'required',
    aiSessions: true,
    nodes: true,
    instanceBoard: true,
    triggers: true,
  },
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

type CloudClient = Extract<ReturnType<typeof createMobileControlPlaneClient>, { account: unknown }>;
function cloudClientOf(profile: MobileCloudRelayControlPlaneProfile, secureStore: SecureValueStore, options?: Parameters<typeof createMobileControlPlaneClient>[2]): CloudClient { return createMobileControlPlaneClient(profile, secureStore, options) as CloudClient; }

function store(): SecureValueStore {
  return {
    available: async () => true,
    get: async () => credential,
    set: async () => undefined,
    remove: async () => undefined,
  };
}

test('cloud Relay clients share one account session and transport per secure store and binding', () => {
  const secureStore = store();
  const first = cloudClientOf(profile, secureStore);
  const second = cloudClientOf({ ...profile }, secureStore);

  expect(second).toBe(first);
  expect(second.transport).toBe(first.transport);
  expect(second.account).toBe(first.account);
});

test('a changed binding revision or secure store gets its own client', () => {
  const secureStore = store();
  const first = cloudClientOf(profile, secureStore);
  const rebinding = cloudClientOf({ ...profile, access: { ...profile.access, bindingRevision: 2 } }, secureStore);
  const otherStore = cloudClientOf(profile, store());

  expect(rebinding).not.toBe(first);
  expect(rebinding.transport).not.toBe(first.transport);
  expect(otherStore).not.toBe(first);
});

test('explicit transport options bypass the shared client cache', () => {
  const secureStore = store();
  const relayChannelFactory = jest.fn();
  const injected = cloudClientOf(profile, secureStore, { relayChannelFactory });
  const again = cloudClientOf(profile, secureStore, { relayChannelFactory });
  const shared = cloudClientOf(profile, secureStore);

  expect(again).not.toBe(injected);
  expect(shared).not.toBe(injected);
  expect(cloudClientOf(profile, secureStore)).toBe(shared);
});
