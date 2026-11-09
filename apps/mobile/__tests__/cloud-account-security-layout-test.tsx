import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { DeviceSessionSchema } from '@task-handoff/cloud-contracts/mobile';

import CloudAccountSecurityScreen from '../app/cloud-account-security';
import { cloudMobileErrorMessage } from '../src/control-plane/cloud-error';
import { restoreActiveCloudAccountSession } from '../src/control-plane/runtime';
import type { CloudAccountSecurityController } from '../src/control-plane/use-cloud-account-security';
import { translate } from '../src/i18n';
import type { MessageKey } from '../src/i18n/messages';

const mockNativeController: { current?: CloudAccountSecurityController } = {};
const mockNativeNavigation: { current?: { controlPlanes(): void; securityActions(): void } } = {};

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    Redirect: () => null,
    router: { back: jest.fn(), dismissAll: jest.fn(), push: jest.fn(), replace: jest.fn() },
    Stack: { Screen: () => null },
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  };
});
jest.mock('../src/control-plane/NativeCloudAccountSecurityScreen', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    NativeCloudAccountSecurityScreen: ({ controller, onOpenControlPlanes, onOpenSecurityActions }: {
      controller: CloudAccountSecurityController;
      onOpenControlPlanes(): void;
      onOpenSecurityActions(): void;
    }) => {
      mockNativeController.current = controller;
      mockNativeNavigation.current = { controlPlanes: onOpenControlPlanes, securityActions: onOpenSecurityActions };
      return React.createElement(Text, { testID: 'native-account-security' }, controller.message ?? controller.profile?.email ?? 'loading');
    },
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
const MOBILE_DEVICE = { id: 'device_a', kind: 'mobile', deviceName: 'TaskHandoff Mobile', createdAt: at, expiresAt: '2026-09-10T00:00:00.000Z' };
const setPlatform = (os: 'android' | 'ios') => Object.defineProperty(Platform, 'OS', { configurable: true, value: os, writable: true });
const originalPlatform = Platform.OS;

afterEach(() => {
  jest.clearAllMocks();
  setPlatform(originalPlatform as 'android' | 'ios');
});

function mockSession(totpEnabled: boolean, devices: () => Promise<unknown[]> = async () => [MOBILE_DEVICE]) {
  restore.mockResolvedValue({
    client: {
      profile: async () => ({ id: 'account_a', email: 'user@example.com', emailVerified: true, status: 'active', createdAt: at, hasPassword: true, totpEnabled }),
      devices,
    },
    reference: () => ({ id: 'device_a', secureCredentialKey: 'cloud.account.device_a' }),
  } as unknown as Awaited<ReturnType<typeof restoreActiveCloudAccountSession>>);
}

test('account settings keep security actions behind one entry', async () => {
  setPlatform('android');
  mockSession(false);
  const screen = await render(<CloudAccountSecurityScreen />);

  await screen.findByText(t('cloudAccount.manageSecurityActions'));
  expect(screen.getAllByText('user@example.com')).toHaveLength(2);
  expect(screen.getByText(t('cloudAccount.accountInformation'))).toBeTruthy();
  expect(screen.getByText(t('cloudAccount.emailVerified'))).toBeTruthy();
  expect(screen.getByText(t('cloudAccount.manageControlPlanes'))).toBeTruthy();
  expect(screen.getByText(t('cloudAccount.securityActionsTitle'))).toBeTruthy();
  expect(screen.getByText(t('cloudAccount.manageSecurityActions'))).toBeTruthy();
  expect(screen.getByText(t('cloudAccount.twoStepDisabled'))).toBeTruthy();
  expect(screen.getByText(t('cloudAccount.signOutAction'))).toBeTruthy();
  expect(screen.queryByText(t('cloudAccount.devices'))).toBeNull();
  expect(screen.queryByText('TaskHandoff Mobile')).toBeNull();
  expect(screen.queryByText(t('cloudAccount.deleteAccountAction'))).toBeNull();
  // Passwords and sign-in methods are managed in the cloud console, not on this screen.
  expect(screen.queryByText('Sign-in methods')).toBeNull();
  expect(screen.queryByText('Change password')).toBeNull();
});

test('the security entry opens the combined actions page', async () => {
  setPlatform('android');
  mockSession(false);
  const screen = await render(<CloudAccountSecurityScreen />);

  await screen.findByText(t('cloudAccount.manageSecurityActions'));
  await fireEvent.press(screen.getByLabelText(t('cloudAccount.manageSecurityActions')));
  expect(jest.requireMock('expo-router').router.push).toHaveBeenCalledWith('/cloud-account-security-actions');
});

test('an unreadable device projection still renders the account profile', async () => {
  setPlatform('android');
  // A newer cloud service can add device kinds this app version does not know yet.
  const unreadable = DeviceSessionSchema.safeParse({ ...MOBILE_DEVICE, kind: 'cli' });
  mockSession(false, async () => { throw (unreadable as { error: unknown }).error; });
  const screen = await render(<CloudAccountSecurityScreen />);

  expect(await screen.findByText(cloudMobileErrorMessage((unreadable as { error: unknown }).error, false))).toBeTruthy();
  expect(screen.getAllByText('user@example.com')).toHaveLength(2);
  expect(screen.getByText(t('cloudAccount.emailVerified'))).toBeTruthy();
  expect(screen.queryByText(t('cloudAccount.devices'))).toBeNull();
});

test('iOS renders the native account settings screen with the same account state', async () => {
  setPlatform('ios');
  mockSession(true);
  const screen = await render(<CloudAccountSecurityScreen />);

  expect(await screen.findByTestId('native-account-security')).toBeTruthy();
  await waitFor(() => expect(mockNativeController.current?.profile?.email).toBe('user@example.com'));
  expect(mockNativeController.current?.devices).toHaveLength(1);
  expect(mockNativeController.current?.stepUp).toBe('');
  expect(mockNativeController.current?.loaded).toBe(true);

  mockNativeNavigation.current?.controlPlanes();
  expect(jest.requireMock('expo-router').router.push).toHaveBeenCalledWith('/cloud-control-planes');
  mockNativeNavigation.current?.securityActions();
  expect(jest.requireMock('expo-router').router.push).toHaveBeenCalledWith('/cloud-account-security-actions');
});
