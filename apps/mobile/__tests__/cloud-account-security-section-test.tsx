import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import CloudAccountDeleteRoute from '../app/cloud-account-delete';
import CloudAccountTwoStepRoute from '../app/cloud-account-two-step';
import { logoutActiveCloudAccount, restoreActiveCloudAccountSession } from '../src/control-plane/runtime';
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

function mockSession(totpEnabled: boolean, client: Record<string, unknown> = {}) {
  restore.mockResolvedValue({
    client: {
      profile: async () => ({ id: 'account_a', email: 'user@example.com', emailVerified: true, status: 'active', createdAt: at, hasPassword: true, totpEnabled }),
      devices: async () => [MOBILE_DEVICE],
      ...client,
    },
    reference: () => ({ id: 'device_a', secureCredentialKey: 'cloud.account.device_a' }),
  } as unknown as Awaited<ReturnType<typeof restoreActiveCloudAccountSession>>);
}

const enrollment = {
  enrollmentToken: 'enrollment_a',
  secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1',
  digits: 6,
  periodSeconds: 30,
  otpauthUri: 'otpauth://totp/TaskHandoff:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=TaskHandoff',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};

test('the dedicated two-step page opens authenticator setup without showing deletion controls', async () => {
  mockSession(false, { beginTotp: async () => enrollment });
  const screen = await render(<CloudAccountTwoStepRoute />);

  await screen.findByTestId('two-step-verification-section');
  await fireEvent.press(screen.getByLabelText(t('cloudAccount.enableAuthenticator')));

  expect(await screen.findByTestId('totp-enrollment-qr')).toBeTruthy();
  expect(screen.getByTestId('two-step-verification-screen')).toBeTruthy();
  expect(screen.queryByTestId('account-deletion-section')).toBeNull();
});

test('a recent-authentication recovery code is normalized on the dedicated two-step page', async () => {
  mockSession(true);
  const screen = await render(<CloudAccountTwoStepRoute />);

  await screen.findByTestId('two-step-verification-section');
  const input = screen.getByPlaceholderText(t('cloudAccount.stepUpCodePlaceholder'));
  await fireEvent.changeText(input, 'abcde fghij-klmno p');
  await waitFor(() => expect(input.props.value).toBe('ABCDE-FGHIJ-KLMNO-P'));
});

test('the dedicated deletion page verifies recent authentication and shows its success state', async () => {
  const stepUp = jest.fn(async () => ({ authenticatedAt: at, expiresAt: at, accountId: 'account_a', deviceSessionId: 'device_a' }));
  const deleteAccount = jest.fn(async () => ({ scheduled: true }));
  mockSession(true, { deleteAccount, stepUp });
  const screen = await render(<CloudAccountDeleteRoute />);

  await screen.findByTestId('account-deletion-section');
  await fireEvent.changeText(screen.getByLabelText(t('cloudAccount.deleteAccountPassword')), 'correct horse battery staple');
  await fireEvent.changeText(screen.getByLabelText(t('cloudAccount.deleteAccountSecondFactor')), '123456');

  await waitFor(() => expect(screen.getByTestId('delete-account-submit').props.accessibilityState).toEqual({ disabled: false }));
  await fireEvent.press(screen.getByTestId('delete-account-submit'));

  await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith({ stepUp: expect.any(Object) }));
  expect(stepUp).toHaveBeenCalledWith({ password: 'correct horse battery staple', totpCode: '123456' });
  expect(logoutActiveCloudAccount).toHaveBeenCalled();
  expect(await screen.findByTestId('delete-account-complete-screen')).toBeTruthy();

  await fireEvent.press(screen.getByLabelText(t('common.confirm')));
  expect(jest.requireMock('expo-router').router.dismissAll).toHaveBeenCalled();
  expect(jest.requireMock('expo-router').router.replace).toHaveBeenCalledWith('/profiles');
});

test('the dedicated deletion page reveals its password and normalizes a recovery code', async () => {
  mockSession(true);
  const screen = await render(<CloudAccountDeleteRoute />);

  await screen.findByTestId('account-deletion-section');
  expect(screen.getByLabelText(t('cloudAccount.deleteAccountPassword')).props.secureTextEntry).toBe(true);
  await fireEvent.press(screen.getByLabelText(t('common.show')));
  expect(screen.getByLabelText(t('cloudAccount.deleteAccountPassword')).props.secureTextEntry).toBe(false);

  const recoveryCode = screen.getByLabelText(t('cloudAccount.deleteAccountSecondFactor'));
  await fireEvent.changeText(recoveryCode, 'abcde fghij-klmno p');
  await waitFor(() => expect(screen.getByLabelText(t('cloudAccount.deleteAccountSecondFactor')).props.value).toBe('ABCDE-FGHIJ-KLMNO-P'));
});
