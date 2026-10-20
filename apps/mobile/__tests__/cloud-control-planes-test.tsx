import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

import CloudControlPlanesScreen from '../app/cloud-control-planes';
import {
  mobileProfileStore,
  reconcileCloudControlPlaneProfiles,
  restoreActiveCloudAccountSession,
} from '../src/control-plane/runtime';

jest.mock('expo-router', () => ({
  Redirect: () => null,
  router: { push: jest.fn(), replace: jest.fn() },
  Stack: { Screen: () => null },
}));
jest.mock('../src/control-plane/runtime', () => ({
  mobileProfileStore: { put: jest.fn() },
  reconcileCloudControlPlaneProfiles: jest.fn(),
  restoreActiveCloudAccountSession: jest.fn(),
}));
jest.mock('../src/platform/build-variant', () => ({ isMobileFeatureEnabled: () => true }));

const mockList = jest.fn();
const mockPut = jest.mocked(mobileProfileStore.put);
const mockRestore = jest.mocked(restoreActiveCloudAccountSession);
const mockReconcile = jest.mocked(reconcileCloudControlPlaneProfiles);
const mockRouter = jest.mocked(router);

const fingerprint = `sha256:${'a'.repeat(43)}`;
const sharedFingerprint = `sha256:${'b'.repeat(43)}`;
const at = '2026-10-19T00:00:00.000Z';
const owner = {
  bindingId: 'binding_owner', controlPlaneId: 'cp_owner', displayName: { default: 'Owner Studio' }, publicKeyFingerprint: fingerprint,
  bindingRevision: 1, remoteAccess: 'enabled' as const, relayUsageBytes: 0, access: { kind: 'owner' as const },
};
const shared = {
  bindingId: 'binding_shared', controlPlaneId: 'cp_shared', displayName: { default: 'Shared Studio' }, publicKeyFingerprint: sharedFingerprint,
  bindingRevision: 2, remoteAccess: 'enabled' as const, relayUsageBytes: 0,
  access: { kind: 'shared' as const, shareId: 'shr_cp_shared', revision: 3, role: 'viewer' as const, expiresAt: '2026-11-19T00:00:00.000Z' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue([owner, shared]);
  mockReconcile.mockResolvedValue([]);
  mockRestore.mockResolvedValue({
    origin: 'https://cloud.thandoff.com',
    client: { listControlPlanes: mockList },
    reference: () => ({ id: 'device_a', secureCredentialKey: 'cloud.account.device_a' }),
  } as unknown as Awaited<ReturnType<typeof restoreActiveCloudAccountSession>>);
});

test('shared and owned Control Planes share the existing list, connection profile and direct open action', async () => {
  const screen = await render(<CloudControlPlanesScreen />);

  expect(await screen.findByText('Shared · Viewer')).toBeTruthy();
  expect(screen.getByText('Owned by you')).toBeTruthy();
  expect(mockReconcile).toHaveBeenCalledWith('device_a', [owner, shared]);

  await fireEvent.press(screen.getByLabelText('Open Shared Studio'));

  await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
  expect(mockPut.mock.calls[0][0]).toMatchObject({
    identity: { controlPlaneId: 'cp_shared', publicKeyFingerprint: sharedFingerprint },
    access: {
      kind: 'cloud-relay',
      bindingId: 'binding_shared',
      resourceAccess: { kind: 'shared', shareId: 'shr_cp_shared', revision: 3, role: 'viewer' },
    },
  });
  expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/(main)/inbox');
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('a directory refresh is applied without a separate share acceptance route', async () => {
  const screen = await render(<CloudControlPlanesScreen />);
  await screen.findByLabelText('Open Owner Studio');

  expect(mockList).toHaveBeenCalledTimes(1);
  expect(mockReconcile).toHaveBeenCalledWith('device_a', [owner, shared]);
  expect(mockRouter.push).not.toHaveBeenCalledWith(expect.stringMatching(/share|accept|invite/i));
});
