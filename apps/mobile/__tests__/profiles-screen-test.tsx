import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ProfilesScreen from '../app/profiles';
import {
  MOBILE_CONTROL_PLANE_PROFILE_VERSION,
  MobileCloudRelayControlPlaneProfileSchema,
  MobileDirectControlPlaneProfileSchema,
} from '../src/control-plane/profile';
import { mobileProfileStore } from '../src/control-plane/runtime';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
  Stack: { Screen: () => null },
}));
jest.mock('../src/control-plane/NativeProfilesScreen', () => ({ NativeProfilesScreen: () => null }));
jest.mock('../src/control-plane/runtime', () => ({
  mobileProfileStore: { active: jest.fn(), list: jest.fn(), subscribe: jest.fn(() => () => undefined) },
}));

const mockStore = jest.mocked(mobileProfileStore);
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
  identity: { ...profileBase.identity, displayName: 'Alpha Direct' },
  access: { kind: 'direct', origin: 'https://direct.example.com', secureSessionKey: 'session.cp_01' },
});
const relay = MobileCloudRelayControlPlaneProfileSchema.parse({
  ...profileBase,
  identity: { ...profileBase.identity, displayName: 'Alpha Relay' },
  access: { kind: 'cloud-relay', serviceOrigin: 'https://cloud.thandoff.com', bindingId: 'binding_a', bindingRevision: 1, accountSession: { id: 'device_a', secureCredentialKey: 'cloud.account.device_a' }, transport: { request: true, stream: true, webSocket: true } },
});

const originalPlatform = Platform.OS;
beforeAll(() => { Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android', writable: true }); });
afterAll(() => { Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform, writable: true }); });

test('marks only the active profile when a direct and cloud Relay profile share one Control Plane', async () => {
  mockStore.list.mockResolvedValue([direct, relay]);
  mockStore.active.mockResolvedValue(relay);
  const screen = await render(<SafeAreaProvider initialMetrics={metrics}><ProfilesScreen /></SafeAreaProvider>);
  await waitFor(() => expect(screen.getByText('https://direct.example.com')).toBeTruthy());
  expect(screen.getByText('https://cloud.thandoff.com')).toBeTruthy();
  expect(screen.getAllByTestId('profile-active-marker', { includeHiddenElements: true })).toHaveLength(1);

  await fireEvent.press(screen.getByLabelText('View Alpha Relay details'));
  expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({
    params: expect.objectContaining({ controlPlaneId: 'cp_01', fingerprint, kind: 'cloud-relay' }),
  }));
  await fireEvent.press(screen.getByLabelText('View Alpha Direct details'));
  expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({
    params: expect.objectContaining({ controlPlaneId: 'cp_01', fingerprint, kind: 'direct' }),
  }));
});
