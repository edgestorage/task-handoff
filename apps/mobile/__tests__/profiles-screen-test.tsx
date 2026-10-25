import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ProfilesScreen, { ProfilesWelcome } from '../app/profiles';
import {
  MOBILE_CONTROL_PLANE_PROFILE_VERSION,
  MobileCloudRelayControlPlaneProfileSchema,
  MobileDirectControlPlaneProfileSchema,
} from '../src/control-plane/profile';
import { mobileProfileStore } from '../src/control-plane/runtime';
import { useCloudAccountState } from '../src/control-plane/use-cloud-account-state';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
  Stack: { Screen: () => null },
}));
jest.mock('../src/control-plane/NativeProfilesScreen', () => ({ NativeProfilesScreen: () => null }));
jest.mock('../src/control-plane/use-cloud-account-state', () => ({ useCloudAccountState: jest.fn() }));
jest.mock('../src/control-plane/runtime', () => ({
  mobileProfileStore: { active: jest.fn(), list: jest.fn(), subscribe: jest.fn(() => () => undefined) },
}));
jest.mock('../src/platform/build-variant', () => ({ isMobileFeatureEnabled: () => true, isMobileTestMode: false }));

const mockStore = jest.mocked(mobileProfileStore);
const mockCloudAccount = jest.mocked(useCloudAccountState);
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
  access: { kind: 'cloud-relay', serviceOrigin: 'https://cloud.thandoff.com', bindingId: 'binding_a', bindingRevision: 1, accountSession: { id: 'device_a', secureCredentialKey: 'cloud.account.device_a' }, transport: { request: true, stream: true, webSocket: true }, resourceAccess: { kind: 'shared', shareId: 'shr_cp_01', revision: 2, role: 'role_viewer', expiresAt: '2026-11-19T00:00:00.000Z' } },
});

const originalPlatform = Platform.OS;
beforeAll(() => { Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android', writable: true }); });
afterAll(() => { Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform, writable: true }); });
beforeEach(() => {
  mockPush.mockClear();
  mockCloudAccount.mockReturnValue({ phase: 'signed-out' });
});

test('keeps diagnostic logging out of the initial profile screen', async () => {
  const screen = await render(<SafeAreaProvider initialMetrics={metrics}><ProfilesWelcome onAdd={jest.fn()} /></SafeAreaProvider>);

  expect(screen.queryByText('Record diagnostic logs')).toBeNull();
  expect(screen.queryByTestId('diagnostic-logs-toggle')).toBeNull();
});

test('marks only the active profile when a direct and cloud Relay profile share one Control Plane', async () => {
  mockStore.list.mockResolvedValue([direct, relay]);
  mockStore.active.mockResolvedValue(relay);
  const screen = await render(<SafeAreaProvider initialMetrics={metrics}><ProfilesScreen /></SafeAreaProvider>);
  await waitFor(() => expect(screen.getByText('https://direct.example.com')).toBeTruthy());
  expect(screen.getByText('https://cloud.thandoff.com')).toBeTruthy();
  expect(screen.getByText('Shared · Viewer')).toBeTruthy();
  expect(screen.getByText('Record diagnostic logs')).toBeTruthy();
  expect(screen.getByTestId('diagnostic-logs-toggle')).toBeTruthy();
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

test('opens Thandoff account settings when the account is signed in', async () => {
  mockStore.list.mockResolvedValue([direct]);
  mockStore.active.mockResolvedValue(direct);
  mockCloudAccount.mockReturnValue({ phase: 'signed-in', profile: { email: 'user@example.com' } });
  const screen = await render(<SafeAreaProvider initialMetrics={metrics}><ProfilesScreen /></SafeAreaProvider>);

  expect(await screen.findByText('user@example.com')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Thandoff account settings'));

  expect(mockPush).toHaveBeenCalledWith('/cloud-account-security');
});

test('opens Thandoff sign-in from the empty settings screen when signed out', async () => {
  mockStore.list.mockResolvedValue([]);
  mockStore.active.mockResolvedValue(undefined);
  const screen = await render(<SafeAreaProvider initialMetrics={metrics}><ProfilesScreen /></SafeAreaProvider>);

  const accountEntry = await screen.findByLabelText('Sign in to Thandoff account');
  await fireEvent.press(accountEntry);

  expect(mockPush).toHaveBeenCalledWith('/cloud-account');
});
