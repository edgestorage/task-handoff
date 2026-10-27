import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ControlPlaneDetailContent } from '../src/control-plane/ControlPlaneDetailContent.tsx';
import {
  MOBILE_CONTROL_PLANE_PROFILE_VERSION,
  MobileCloudRelayControlPlaneProfileSchema,
  MobileDirectControlPlaneProfileSchema,
} from '../src/control-plane/profile';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { bottom: 34, left: 0, right: 0, top: 47 } };
const fingerprint = `sha256:${'a'.repeat(43)}`;
const profileBase = {
  version: MOBILE_CONTROL_PLANE_PROFILE_VERSION,
  identity: { controlPlaneId: 'cp_01', publicKeyFingerprint: fingerprint, protocolVersion: '2026-08-05' },
  capabilities: { authentication: 'required' as const, aiSessions: true, nodes: true, instanceBoard: true, triggers: true },
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
};
const direct = MobileDirectControlPlaneProfileSchema.parse({
  ...profileBase,
  access: { kind: 'direct', origin: 'https://direct.example.com', secureSessionKey: 'session.cp_01' },
});
const cloud = MobileCloudRelayControlPlaneProfileSchema.parse({
  ...profileBase,
  access: {
    kind: 'cloud-relay',
    serviceOrigin: 'https://cloud.thandoff.com',
    bindingId: 'binding_a',
    bindingRevision: 1,
    accountSession: { id: 'device_a', secureCredentialKey: 'cloud.account.device_a' },
    transport: { request: true, stream: true, webSocket: true },
  },
});
const sharedCloud = MobileCloudRelayControlPlaneProfileSchema.parse({
  ...cloud,
  access: {
    ...cloud.access,
    resourceAccess: { kind: 'shared', shareId: 'shr_cp_01', revision: 2, role: 'role_viewer', expiresAt: '2026-11-19T00:00:00.000Z' },
  },
});

function renderDetail(profile: typeof direct | typeof cloud | typeof sharedCloud) {
  return render(
    <SafeAreaProvider initialMetrics={metrics}>
      <ControlPlaneDetailContent
        active
        busy={false}
        onMakeActive={jest.fn()}
        onRemove={jest.fn()}
        profile={profile}
      />
    </SafeAreaProvider>,
  );
}

test('shows the address for direct Control Planes', async () => {
  const screen = await renderDetail(direct);

  expect(screen.getByText('Address')).toBeTruthy();
  expect(screen.getByText('https://direct.example.com')).toBeTruthy();
  expect(screen.queryByText('Cloud access')).toBeNull();
});

test('shows cloud ownership instead of the cloud service origin', async () => {
  const screen = await renderDetail(cloud);

  expect(screen.getByText('Cloud access')).toBeTruthy();
  expect(screen.getByText('Owned by you')).toBeTruthy();
  expect(screen.queryByText('Address')).toBeNull();
  expect(screen.queryByText('https://cloud.thandoff.com')).toBeNull();
});

test('shows shared cloud access without the cloud service origin', async () => {
  const screen = await renderDetail(sharedCloud);

  expect(screen.getByText('Cloud access')).toBeTruthy();
  expect(screen.getByText('Shared · Viewer')).toBeTruthy();
  expect(screen.queryByText('Address')).toBeNull();
  expect(screen.queryByText('https://cloud.thandoff.com')).toBeNull();
});
