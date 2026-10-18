import { useEffect, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { router, usePathname } from 'expo-router';

import { useMobileControlPlaneRuntime } from './use-mobile-control-plane-runtime';
import { cloudAccountReauthenticationRoute, mobileSessionRecoveryRoute } from './session-recovery';
import {
  acknowledgeCloudAccountReauthentication,
  cloudAccountReauthenticationRequired,
  subscribeCloudAccountReauthentication,
} from './account-reauthentication';
import { useI18n } from '../i18n';

export function MobileSessionRecovery() {
  const pathname = usePathname();
  const runtime = useMobileControlPlaneRuntime();
  const { t } = useI18n();
  const accountReauthenticationRequired = useSyncExternalStore(
    subscribeCloudAccountReauthentication,
    cloudAccountReauthenticationRequired,
    cloudAccountReauthenticationRequired,
  );

  useEffect(() => {
    const route = mobileSessionRecoveryRoute(runtime.phase, runtime.profile, pathname);
    if (route) router.replace(route);
  }, [pathname, runtime.phase, runtime.profile]);

  useEffect(() => {
    if (!accountReauthenticationRequired) return;
    const route = cloudAccountReauthenticationRoute(pathname);
    // The local account state is already signed out. This prompt only explains
    // why cloud profiles disappeared and offers the shortest recovery path.
    acknowledgeCloudAccountReauthentication();
    if (!route) return;
    Alert.alert(
      t('cloudAccount.reauthenticationTitle'),
      t('cloudAccount.reauthenticationDescription'),
      [
        { text: t('cloudAccount.reauthenticationLater'), style: 'cancel' },
        { text: t('cloudAccount.signIn'), onPress: () => router.push(route as never) },
      ],
    );
  }, [accountReauthenticationRequired, pathname, t]);

  return null;
}
