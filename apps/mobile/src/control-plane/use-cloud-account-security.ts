import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';

import type { AccountPublicProfile, DeviceSession, OfficialMobileAccountClient, TotpEnrollmentResponse } from '@task-handoff/cloud-contracts/mobile';

import { useI18n } from '../i18n';
import { cloudMobileErrorMessage } from './cloud-error';
import { hasActiveCloudAccount, logoutActiveCloudAccount, restoreActiveCloudAccountSession } from './runtime';

export type CloudAccountSecurityController = {
  busy: boolean;
  currentDeviceId?: string;
  devices: DeviceSession[];
  enrollment?: TotpEnrollmentResponse;
  loaded: boolean;
  message?: string;
  profile?: AccountPublicProfile;
  recoveryCodes: string[];
  stepCode: string;
  stepUp: string;
  totpCode: string;
  beginTotp(): void;
  confirmTotp(): void;
  disableTotp(): void;
  revokeDevice(deviceSessionId: string): void;
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
  const [stepUp, setStepUp] = useState('');
  const [stepCode, setStepCode] = useState('');
  const [enrollment, setEnrollment] = useState<TotpEnrollmentResponse>();
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const load = useCallback(async () => {
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

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const stepUpToken = useCallback((client: OfficialMobileAccountClient) => {
    return client.stepUp({ password: stepUp, ...(stepCode.includes('-') ? { recoveryCode: stepCode } : stepCode ? { totpCode: stepCode } : {}) });
  }, [stepCode, stepUp]);

  const action = useCallback(async (operation: (client: OfficialMobileAccountClient) => Promise<unknown>, done?: (result: unknown) => void) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const session = await restoreActiveCloudAccountSession();
      const result = await operation(session.client);
      done?.(result);
      await load();
    } catch (error) {
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

  const beginTotp = useCallback(() => {
    void action(
      async (client) => client.beginTotp(profile?.totpEnabled ? { replace: true, stepUp: await stepUpToken(client) } : {}),
      (result) => setEnrollment(result as TotpEnrollmentResponse),
    );
  }, [action, profile?.totpEnabled, stepUpToken]);

  const confirmTotp = useCallback(() => {
    if (!enrollment) return;
    void action(
      (client) => client.confirmTotp({ enrollmentToken: enrollment.enrollmentToken, code: totpCode }),
      (result) => { setRecoveryCodes((result as { recoveryCodes?: string[] })?.recoveryCodes ?? []); setEnrollment(undefined); },
    );
  }, [action, enrollment, totpCode]);

  const disableTotp = useCallback(() => {
    void action(async (client) => client.disableTotp({ stepUp: await stepUpToken(client) }));
  }, [action, stepUpToken]);

  const revokeDevice = useCallback((deviceSessionId: string) => {
    void action((client) => client.revokeDevice(deviceSessionId));
  }, [action]);

  return {
    busy,
    currentDeviceId,
    devices,
    enrollment,
    loaded: Boolean(profile || message),
    message,
    profile,
    recoveryCodes,
    stepCode,
    stepUp,
    totpCode,
    beginTotp,
    confirmTotp,
    disableTotp,
    revokeDevice,
    setStepCode,
    setStepUp,
    setTotpCode,
    signOut,
  };
}
