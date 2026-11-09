import * as Clipboard from 'expo-clipboard';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { TotpEnrollmentPanel } from '../src/control-plane/TotpEnrollmentPanel';
import type { CloudAccountSecurityController } from '../src/control-plane/use-cloud-account-security';
import { translate } from '../src/i18n';
import type { MessageKey } from '../src/i18n/messages';

const t = (key: MessageKey) => translate('en-US', key);
const at = '2026-08-10T00:00:00.000Z';

function controller(overrides: Partial<CloudAccountSecurityController> = {}): CloudAccountSecurityController {
  return {
    busy: false,
    deleteCode: '',
    deleteComplete: false,
    deletePassword: '',
    devices: [],
    enrollment: {
      enrollmentToken: 'enrollment_a',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      periodSeconds: 30,
      otpauthUri: 'otpauth://totp/TaskHandoff:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=TaskHandoff',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
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

afterEach(() => jest.restoreAllMocks());

test('TOTP enrollment renders a local QR code and reveals the secret', async () => {
  const enrollment = controller().enrollment!;
  const screen = await render(<TotpEnrollmentPanel controller={controller()} enrollment={enrollment}/>);

  expect(screen.getByTestId('totp-enrollment-qr')).toBeTruthy();
  expect(screen.getByText(t('cloudAccount.totpEnrollDescription'))).toBeTruthy();
  expect(screen.queryByText('JBSW Y3DP EHPK 3PXP')).toBeNull();

  await fireEvent.press(screen.getByLabelText(t('cloudAccount.totpShowSecret')));
  expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeTruthy();
});

test('TOTP enrollment copies the key, opens the authenticator link, and auto-submits a complete code', async () => {
  const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const confirmTotp = jest.fn();
  const enrollment = controller().enrollment!;
  const screen = await render(<TotpEnrollmentPanel controller={controller({ confirmTotp })} enrollment={controller().enrollment!}/>);

  await fireEvent.press(screen.getByLabelText(t('cloudAccount.totpCopySecret')));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(enrollment.secret));
  expect(screen.getByText(t('cloudAccount.totpSecretCopied'))).toBeTruthy();

  await fireEvent.press(screen.getByLabelText(t('cloudAccount.totpOpenAuthenticator')));
  await waitFor(() => expect(open).toHaveBeenCalledWith(enrollment.otpauthUri));

  await fireEvent.changeText(screen.getByLabelText(t('cloudAccount.totpCode')), '12a 34-56');
  expect(confirmTotp).toHaveBeenCalledWith('123456');
});

test('TOTP enrollment shows an expiry countdown and blocks confirmation when expired', async () => {
  const confirmTotp = jest.fn();
  const expiredEnrollment = { ...controller().enrollment!, expiresAt: new Date(Date.now() - 1_000).toISOString() };
  const screen = await render(<TotpEnrollmentPanel controller={controller({ confirmTotp })} enrollment={expiredEnrollment}/>);

  expect(await screen.findByText(t('cloudAccount.totpExpired'))).toBeTruthy();
  expect(screen.getByLabelText(t('cloudAccount.confirmAuthenticator')).props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.changeText(screen.getByLabelText(t('cloudAccount.totpCode')), '123456');
  expect(confirmTotp).not.toHaveBeenCalled();
});
