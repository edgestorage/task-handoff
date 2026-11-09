import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import type { AccountPublicProfile, DeviceSession, OfficialMobileAccountClient, TotpEnrollmentResponse } from '@task-handoff/cloud-contracts/mobile';

import { normalizeOneTimeCode } from '../components/one-time-code';
import { normalizeSecondFactorCode } from '../components/recovery-code';
import { useI18n } from '../i18n';
import { errorHaptic, successHaptic } from '../platform/haptics';
import { cloudMobileErrorMessage } from './cloud-error';
import { hasActiveCloudAccount, logoutActiveCloudAccount, restoreActiveCloudAccountSession } from './runtime';

export type CloudAccountSecurityController = {
  busy: boolean;
  currentDeviceId?: string;
  deleteCode: string;
  deleteComplete: boolean;
  deletePassword: string;
  devices: DeviceSession[];
  enrollment?: TotpEnrollmentResponse;
  loaded: boolean;
  message?: string;
  profile?: AccountPublicProfile;
  recoveryCodes: string[];
  stepCode: string;
  stepUp: string;
  totpCode: string;
  totpFocusKey: number;
  beginTotp(): void;
  cancelTotpEnrollment(): void;
  confirmTotp(code?: string): void;
  confirmDeleteAccount(): void;
  dismissRecoveryCodes(): void;
  disableTotp(): void;
  revokeDevice(deviceSessionId: string): void;
  setDeleteCode(value: string): void;
  setDeletePassword(value: string): void;
  setStepCode(value: string): void;
  setStepUp(value: string): void;
  setTotpCode(value: string): void;
  signOut(): void;
};

/**
 * Account security state shared by the iOS native list and the JavaScript screen so both
 * platforms run the same reads, step-up credentials, and relay-free account mutations.
 */
export function useCloudAccountSecurity(): CloudAccountSecurityController {
  const { locale, t } = useI18n();
  const zh = locale === 'zh-CN';
  const [profile, setProfile] = useState<AccountPublicProfile>();
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string>();
  const [deleteCode, setDeleteCode] = useState('');
  const [deleteComplete, setDeleteComplete] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [stepUp, setStepUp] = useState('');
  const [stepCode, setStepCode] = useState('');
  const [enrollment, setEnrollment] = useState<TotpEnrollmentResponse>();
  const [totpCode, setTotpCode] = useState('');
  const [totpFocusKey, setTotpFocusKey] = useState(0);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const load = useCallback(async () => {
    setMessage(undefined);
    try {
      const session = await restoreActiveCloudAccountSession();
      setCurrentDeviceId(session.reference().id);
      // A projection this app version cannot read (for example a device kind added by a
      // newer cloud service) must not hide the projections that did load, so the two
      // account reads settle independently.
      const [profileResult, devicesResult] = await Promise.allSettled([session.client.profile(), session.client.devices()]);
      if (profileResult.status === 'fulfilled') setProfile(profileResult.value);
      if (devicesResult.status === 'fulfilled') setDevices(devicesResult.value);
      const failure = profileResult.status === 'rejected' ? profileResult.reason : devicesResult.status === 'rejected' ? devicesResult.reason : undefined;
      setMessage(failure ? cloudMobileErrorMessage(failure, zh) : undefined);
    } catch (error) {
      setMessage(cloudMobileErrorMessage(error, zh));
    }
  }, [zh]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const createStepUpToken = useCallback((client: OfficialMobileAccountClient, password: string, code: string) => {
    return client.stepUp({ password, ...(code.includes('-') ? { recoveryCode: code } : code ? { totpCode: code } : {}) });
  }, []);

  const stepUpToken = useCallback((client: OfficialMobileAccountClient) => {
    return createStepUpToken(client, stepUp, stepCode);
  }, [createStepUpToken, stepCode, stepUp]);

  const action = useCallback(async (
    operation: (client: OfficialMobileAccountClient) => Promise<unknown>,
    done?: (result: unknown) => void,
    failed?: () => void,
  ) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const session = await restoreActiveCloudAccountSession();
      const result = await operation(session.client);
      done?.(result);
      await load();
    } catch (error) {
      failed?.();
      setMessage(cloudMobileErrorMessage(error, zh));
    } finally {
      setBusy(false);
    }
  }, [load, zh]);

  const logout = useCallback(async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      await logoutActiveCloudAccount();
      router.back();
    } catch (error) {
      if (!await hasActiveCloudAccount().catch(() => false)) router.back();
      else setMessage(cloudMobileErrorMessage(error, zh));
    } finally {
      setBusy(false);
    }
  }, [zh]);

  const signOut = useCallback(() => {
    Alert.alert(t('cloudAccount.signOutTitle'), t('cloudAccount.signOutDescription'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('cloudAccount.signOutConfirm'), style: 'destructive', onPress: () => void logout() },
    ]);
  }, [logout, t]);

  const deleteAccount = useCallback(async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const session = await restoreActiveCloudAccountSession();
      const stepUp = await createStepUpToken(session.client, deletePassword, deleteCode);
      await session.client.deleteAccount({ stepUp });
      // The server revokes this device session with the account. Clear the local
      // account artifacts even if the now-invalid logout request fails.
      await logoutActiveCloudAccount().catch(() => undefined);
      setDeleteCode('');
      setDeletePassword('');
      setMessage(undefined);
      setDeleteComplete(true);
      successHaptic();
    } catch (error) {
      errorHaptic();
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
      if (code === 'TOTP_INVALID') setMessage(t('cloudAccount.totpInvalid'));
      else if (code === 'RECOVERY_CODE_INVALID_OR_CONSUMED') setMessage(t('cloudAccount.recoveryInvalid'));
      else setMessage(cloudMobileErrorMessage(error, zh));
    } finally {
      setBusy(false);
    }
  }, [createStepUpToken, deleteCode, deletePassword, t, zh]);

  const confirmDeleteAccount = useCallback(() => {
    if (busy || !deletePassword || (profile?.totpEnabled && !deleteCode)) return;
    void deleteAccount();
  }, [busy, deleteAccount, deleteCode, deletePassword, profile?.totpEnabled]);

  const beginTotp = useCallback(() => {
    void action(
      async (client) => client.beginTotp(profile?.totpEnabled ? { replace: true, stepUp: await stepUpToken(client) } : {}),
      (result) => {
        setEnrollment(result as TotpEnrollmentResponse);
        setTotpCode('');
        setStepUp('');
        setStepCode('');
        successHaptic();
      },
      errorHaptic,
    );
  }, [action, profile?.totpEnabled, stepUpToken]);

  const confirmTotp = useCallback((code = totpCode) => {
    const normalizedCode = normalizeOneTimeCode(code);
    if (!enrollment || normalizedCode.length !== 6) return;
    void action(
      (client) => client.confirmTotp({ enrollmentToken: enrollment.enrollmentToken, code: normalizedCode }),
      (result) => {
        setRecoveryCodes((result as { recoveryCodes?: string[] })?.recoveryCodes ?? []);
        setEnrollment(undefined);
        setTotpCode('');
        successHaptic();
      },
      () => {
        setTotpCode('');
        setTotpFocusKey((value) => value + 1);
        errorHaptic();
      },
    );
  }, [action, enrollment, totpCode]);

  const cancelTotpEnrollment = useCallback(() => {
    setEnrollment(undefined);
    setTotpCode('');
    setMessage(undefined);
  }, []);

  const dismissRecoveryCodes = useCallback(() => setRecoveryCodes([]), []);

  const disableTotp = useCallback(() => {
    void action(
      async (client) => client.disableTotp({ stepUp: await stepUpToken(client) }),
      () => {
        setStepUp('');
        setStepCode('');
        successHaptic();
      },
      errorHaptic,
    );
  }, [action, stepUpToken]);

  const revokeDevice = useCallback((deviceSessionId: string) => {
    void action((client) => client.revokeDevice(deviceSessionId));
  }, [action]);

  return {
    busy,
    currentDeviceId,
    deleteCode,
    deleteComplete,
    deletePassword,
    devices,
    enrollment,
    loaded: Boolean(profile || message),
    message,
    profile,
    recoveryCodes,
    stepCode,
    stepUp,
    totpCode,
    totpFocusKey,
    beginTotp,
    cancelTotpEnrollment,
    confirmTotp,
    confirmDeleteAccount,
    dismissRecoveryCodes,
    disableTotp,
    revokeDevice,
    setDeleteCode: (value: string) => setDeleteCode(normalizeSecondFactorCode(value)),
    setDeletePassword,
    setStepCode: (value: string) => setStepCode(normalizeSecondFactorCode(value)),
    setStepUp,
    setTotpCode: (value: string) => setTotpCode(normalizeOneTimeCode(value)),
    signOut,
  };
}
