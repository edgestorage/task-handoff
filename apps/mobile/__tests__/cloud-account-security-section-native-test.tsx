import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { TestInstance } from 'test-renderer';

import CloudAccountDeleteRoute from '../app/cloud-account-delete';
import CloudAccountTwoStepRoute from '../app/cloud-account-two-step';
import { NativeCloudAccountSecuritySectionScreen } from '../src/control-plane/NativeCloudAccountSecuritySectionScreen';
import { restoreActiveCloudAccountSession } from '../src/control-plane/runtime';
import type { CloudAccountSecurityController } from '../src/control-plane/use-cloud-account-security';
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

type Screen = Awaited<ReturnType<typeof render>>;

function queryAllByProps(screen: Screen, props: Record<string, unknown>): TestInstance[] {
  return screen.root!.queryAll((node) => Object.entries(props).every(([key, value]) => node.props[key] === value));
}

function getByProps(screen: Screen, props: Record<string, unknown>): TestInstance {
  const matches = queryAllByProps(screen, props);
  if (matches.length !== 1) throw new Error(`expected one view matching ${JSON.stringify(props)}, found ${matches.length}`);
  return matches[0];
}

function controller(overrides: Partial<CloudAccountSecurityController> = {}): CloudAccountSecurityController {
  return {
    busy: false,
    currentDeviceId: 'device_a',
    deleteCode: '',
    deleteComplete: false,
    deletePassword: '',
    devices: [MOBILE_DEVICE],
    loaded: true,
    profile: { id: 'account_a', email: 'user@example.com', emailVerified: true, status: 'active', createdAt: at, totpEnabled: true },
    recoveryCodes: [],
    stepCode: '',
    stepUp: '',
    totpCode: '',
    totpFocusKey: 0,
    beginTotp: jest.fn(),
    cancelTotpEnrollment: jest.fn(),
    confirmTotp: jest.fn(),
    confirmDeleteAccount: jest.fn(),
    dismissRecoveryCodes: jest.fn(),
    disableTotp: jest.fn(),
    revokeDevice: jest.fn(),
    setDeleteCode: jest.fn(),
    setDeletePassword: jest.fn(),
    setStepCode: jest.fn(),
    setStepUp: jest.fn(),
    setTotpCode: jest.fn(),
    signOut: jest.fn(),
    ...overrides,
  };
}

function mockSession() {
  restore.mockResolvedValue({
    client: {
      profile: async () => ({ id: 'account_a', email: 'user@example.com', emailVerified: true, status: 'active', createdAt: at, hasPassword: true, totpEnabled: true }),
      devices: async () => [MOBILE_DEVICE],
    },
    reference: () => ({ id: 'device_a', secureCredentialKey: 'cloud.account.device_a' }),
  } as unknown as Awaited<ReturnType<typeof restoreActiveCloudAccountSession>>);
}

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios', writable: true });
});

afterEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform, writable: true });
});

test('the iOS two-step route renders only the native two-step flow', async () => {
  mockSession();
  const screen = await render(<CloudAccountTwoStepRoute />);

  await waitFor(() => expect(queryAllByProps(screen, { placeholder: t('cloudAccount.stepUpPasswordPlaceholder') })).toHaveLength(1));
  expect(getByProps(screen, { label: t('cloudAccount.disableAuthenticator') })).toBeTruthy();
  expect(queryAllByProps(screen, { placeholder: t('cloudAccount.deleteAccountPasswordPlaceholder') })).toHaveLength(0);
});

test('the iOS deletion route renders only the native deletion flow', async () => {
  mockSession();
  const screen = await render(<CloudAccountDeleteRoute />);

  await waitFor(() => expect(queryAllByProps(screen, { placeholder: t('cloudAccount.deleteAccountPasswordPlaceholder') })).toHaveLength(1));
  expect(getByProps(screen, { label: t('cloudAccount.deleteAccountAction') })).toBeTruthy();
  expect(queryAllByProps(screen, { placeholder: t('cloudAccount.stepUpPasswordPlaceholder') })).toHaveLength(0);
});

test('the native deletion success state returns through the page callback', async () => {
  const onDeleted = jest.fn();
  const screen = await render(<NativeCloudAccountSecuritySectionScreen
    controller={controller({ deleteComplete: true })}
    onDeleted={onDeleted}
    section="delete"
  />);

  await fireEvent(getByProps(screen, { label: t('common.confirm') }), 'buttonPress');
  expect(onDeleted).toHaveBeenCalled();
});
