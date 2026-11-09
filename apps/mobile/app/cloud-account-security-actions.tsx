import { Redirect, router, Stack } from 'expo-router';
import { Platform } from 'react-native';

import { CloudAccountSecurityActionsScreen } from '../src/control-plane/CloudAccountSecurityActionsScreen';
import { NativeCloudAccountSecurityActionsScreen } from '../src/control-plane/NativeCloudAccountSecurityActionsScreen';
import { useCloudAccountSecurity } from '../src/control-plane/use-cloud-account-security';
import { useI18n } from '../src/i18n';
import { isMobileFeatureEnabled } from '../src/platform/build-variant';

export default function CloudAccountSecurityActionsRoute() {
  if (!isMobileFeatureEnabled('officialAccount')) return <Redirect href="/profiles" />;
  return <CloudAccountSecurityActionsContent />;
}

function CloudAccountSecurityActionsContent() {
  const { t } = useI18n();
  const controller = useCloudAccountSecurity();
  const onOpenTwoStep = () => router.push('/cloud-account-two-step' as never);
  const onOpenDelete = () => router.push('/cloud-account-delete' as never);

  if (Platform.OS === 'ios') {
    return <>
      <Stack.Screen options={{ title: t('cloudAccount.securityActionsTitle'), gestureEnabled: !controller.busy }}/>
      <NativeCloudAccountSecurityActionsScreen
        controller={controller}
        onOpenDelete={onOpenDelete}
        onOpenTwoStep={onOpenTwoStep}
      />
    </>;
  }

  return <>
    <Stack.Screen options={{ title: t('cloudAccount.securityActionsTitle'), gestureEnabled: !controller.busy }}/>
    <CloudAccountSecurityActionsScreen
      controller={controller}
      onOpenDelete={onOpenDelete}
      onOpenTwoStep={onOpenTwoStep}
    />
  </>;
}
