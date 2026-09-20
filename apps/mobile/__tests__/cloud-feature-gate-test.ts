import { createMobileControlPlaneClient } from '../src/control-plane/client';
import type { MobileCloudRelayControlPlaneProfile } from '../src/control-plane/profile';
import type { SecureValueStore } from '../src/platform/secure-storage';

const profile: MobileCloudRelayControlPlaneProfile = {
  version: 1,
  identity: {
    controlPlaneId: 'control_plane_a',
    publicKeyFingerprint: `sha256:${'a'.repeat(43)}`,
  },
  access: {
    kind: 'cloud-relay',
    serviceOrigin: 'https://cloud.thandoff.com',
    bindingId: 'binding_a',
    bindingRevision: 1,
    accountSession: {
      id: 'device_a',
      secureCredentialKey: 'cloud.account.device_a',
    },
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

const secureStore: SecureValueStore = {
  available: async () => true,
  get: async () => undefined,
  set: async () => undefined,
  remove: async () => undefined,
};

test('a build with cloud Relay disabled rejects cloud profiles at the transport boundary', () => {
  expect(() => createMobileControlPlaneClient(profile, secureStore)).toThrow(
    expect.objectContaining({ code: 'CLOUD_RELAY_FEATURE_DISABLED' }),
  );
});
