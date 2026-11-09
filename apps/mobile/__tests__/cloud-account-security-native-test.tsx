import { fireEvent, render } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

import { NativeCloudAccountSecurityScreen } from '../src/control-plane/NativeCloudAccountSecurityScreen';
import type { CloudAccountSecurityController } from '../src/control-plane/use-cloud-account-security';
import { translate } from '../src/i18n';
import type { MessageKey } from '../src/i18n/messages';

const at = '2026-08-10T00:00:00.000Z';
const t = (key: MessageKey) => translate('en-US', key);
const MOBILE_DEVICE = { id: 'device_a', kind: 'mobile', deviceName: 'TaskHandoff Mobile', createdAt: at, expiresAt: at } as const;

type Screen = Awaited<ReturnType<typeof render>>;

// react-native-testing-library 14 dropped the props queries, so match the mounted
// native views (host components) through the rendered tree directly.
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
    profile: { id: 'account_a', email: 'user@example.com', emailVerified: true, status: 'active', createdAt: at, totpEnabled: false },
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

test('the iOS screen renders the account as a native inset grouped list', async () => {
  const onOpenControlPlanes = jest.fn();
  const onOpenSecurityActions = jest.fn();
  const screen = await render(<NativeCloudAccountSecurityScreen
    controller={controller()}
    onOpenControlPlanes={onOpenControlPlanes}
    onOpenSecurityActions={onOpenSecurityActions}
  />);

  expect(getByProps(screen, { title: t('cloudAccount.accountInformation') })).toBeTruthy();
  expect(getByProps(screen, { title: t('cloudAccount.cloudControlPlanes') })).toBeTruthy();
  expect(getByProps(screen, { title: t('cloudAccount.securityActionsTitle') })).toBeTruthy();
  expect(getByProps(screen, { text: 'user@example.com' })).toBeTruthy();
  expect(queryAllByProps(screen, { title: t('cloudAccount.devices') })).toHaveLength(0);
  expect(queryAllByProps(screen, { title: 'TaskHandoff Mobile' })).toHaveLength(0);

  await fireEvent(getByProps(screen, { label: t('cloudAccount.manageControlPlanes') }), 'buttonPress');
  expect(onOpenControlPlanes).toHaveBeenCalled();
  await fireEvent(getByProps(screen, { label: t('cloudAccount.manageSecurityActions') }), 'buttonPress');
  expect(onOpenSecurityActions).toHaveBeenCalled();
  expect(getByProps(screen, { label: t('cloudAccount.signOutAction') })).toBeTruthy();
});

test('the iOS screen keeps sensitive forms off the settings list', async () => {
  const screen = await render(<NativeCloudAccountSecurityScreen
    controller={controller({
      profile: { id: 'account_a', email: 'user@example.com', emailVerified: true, status: 'active', createdAt: at, totpEnabled: true },
    })}
    onOpenControlPlanes={jest.fn()}
    onOpenSecurityActions={jest.fn()}
  />);

  expect(queryAllByProps(screen, { placeholder: t('cloudAccount.stepUpPasswordPlaceholder') })).toHaveLength(0);
  expect(queryAllByProps(screen, { placeholder: t('cloudAccount.stepUpCodePlaceholder') })).toHaveLength(0);
  expect(queryAllByProps(screen, { placeholder: t('cloudAccount.deleteAccountPasswordPlaceholder') })).toHaveLength(0);
  expect(queryAllByProps(screen, { title: t('cloudAccount.deleteAccountTitle') })).toHaveLength(0);
});

test('the iOS screen shows a loading row until the account state arrives', async () => {
  const screen = await render(<NativeCloudAccountSecurityScreen
    controller={controller({ loaded: false, profile: undefined })}
    onOpenControlPlanes={jest.fn()}
    onOpenSecurityActions={jest.fn()}
  />);

  expect(getByProps(screen, { text: t('cloudAccount.loadingProfile') })).toBeTruthy();
  expect(getByProps(screen, { testID: 'cloud-account-loading' })).toBeTruthy();
  expect(queryAllByProps(screen, { title: t('cloudAccount.accountInformation') })).toHaveLength(0);
});
