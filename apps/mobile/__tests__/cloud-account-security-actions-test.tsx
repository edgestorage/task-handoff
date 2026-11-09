import { fireEvent, render } from '@testing-library/react-native';
import { Platform } from 'react-native';

import CloudAccountSecurityActionsRoute from '../app/cloud-account-security-actions';
import { restoreActiveCloudAccountSession } from '../src/control-plane/runtime';
import { translate } from '../src/i18n';
import type { MessageKey } from '../src/i18n/messages';

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    Redirect: () => null,
    router: { back: jest.fn(), dismissAll: jest.fn(), push: jest.fn(), replace: jest.fn() },
    Stack: { Screen: () => null },
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  };
});
jest.mock('../src/control-plane/runtime', () => ({
  hasActiveCloudAccount: jest.fn(async () => true),
  logoutActiveCloudAccount: jest.fn(async () => undefined),
  restoreActiveCloudAccountSession: jest.fn(),
}));
jest.mock('../src/platform/build-variant', () => ({ isMobileFeatureEnabled: () => true }));

const restore = jest.mocked(restoreActiveCloudAccountSession);
const t = (key: MessageKey) => translate('en-US', key);
const at = '2026-08-10T00:00:00.000Z';
const MOBILE_DEVICE = { id: 'device_a', kind: 'mobile', deviceName: 'TaskHandoff Mobile', createdAt: at, expiresAt: at } as const;
const originalPlatform = Platform.OS;

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android', writable: true });
});

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform, writable: true });
});

function mockSession(
  totpEnabled: boolean,
  client: Record<string, unknown> = {},
  devices: () => Promise<unknown[]> = async () => [MOBILE_DEVICE],
) {
  restore.mockResolvedValue({
    client: {
      profile: async () => ({ id: 'account_a', email: 'user@example.com', emailVerified: true, status: 'active', createdAt: at, hasPassword: true, totpEnabled }),
      devices,
      ...client,
    },
    reference: () => ({ id: 'device_a', secureCredentialKey: 'cloud.account.device_a' }),
  } as unknown as Awaited<ReturnType<typeof restoreActiveCloudAccountSession>>);
}

test('the security page only exposes two-step and deletion entries while keeping signed-in devices inline', async () => {
  mockSession(false);
  const screen = await render(<CloudAccountSecurityActionsRoute />);

  expect(await screen.findByTestId('two-step-verification-entry-section')).toBeTruthy();
  expect(screen.getByTestId('signed-in-devices-section')).toBeTruthy();
  expect(screen.getByTestId('account-deletion-entry-section')).toBeTruthy();
  expect(screen.getByText(t('cloudAccount.twoStepDisabled'))).toBeTruthy();
  expect(screen.getByText('TaskHandoff Mobile')).toBeTruthy();
  expect(screen.getByText(t('cloudAccount.thisDevice'))).toBeTruthy();
  expect(screen.getByText(t('cloudAccount.deleteAccountEntryDescription'))).toBeTruthy();
  expect(screen.queryByLabelText(t('cloudAccount.enableAuthenticator'))).toBeNull();
  expect(screen.queryByLabelText(t('cloudAccount.deleteAccountPassword'))).toBeNull();
  expect(screen.queryByTestId('delete-account-submit')).toBeNull();
});

test('another signed-in device can still be revoked from the security page', async () => {
  const revokeDevice = jest.fn();
  mockSession(false, { revokeDevice }, async () => [
    MOBILE_DEVICE,
    { id: 'device_b', kind: 'control-plane', deviceName: 'Control Plane control_plane_a', createdAt: at, expiresAt: at },
  ]);
  const screen = await render(<CloudAccountSecurityActionsRoute />);

  await screen.findByTestId('signed-in-devices-section');
  expect(screen.getByText(t('cloudAccount.deviceKind.controlPlane'))).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(`${t('cloudAccount.revoke')} Control Plane control_plane_a`));
  expect(revokeDevice).toHaveBeenCalledWith('device_b');
});

test('the two-step and deletion entries open their dedicated pages', async () => {
  mockSession(true);
  const screen = await render(<CloudAccountSecurityActionsRoute />);

  await screen.findByTestId('two-step-verification-entry-section');
  await fireEvent.press(screen.getByLabelText(t('cloudAccount.totpTitle')));
  expect(jest.requireMock('expo-router').router.push).toHaveBeenCalledWith('/cloud-account-two-step');

  await fireEvent.press(screen.getByLabelText(t('cloudAccount.deleteAccountTitle')));
  expect(jest.requireMock('expo-router').router.push).toHaveBeenCalledWith('/cloud-account-delete');
});
