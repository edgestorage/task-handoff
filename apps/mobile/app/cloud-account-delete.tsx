import { Redirect, router, Stack } from 'expo-router';
import { Platform } from 'react-native';

import { CloudAccountSecuritySectionScreen } from '../src/control-plane/CloudAccountSecuritySectionScreen';
import { NativeCloudAccountSecuritySectionScreen } from '../src/control-plane/NativeCloudAccountSecuritySectionScreen';
import { useCloudAccountSecurity } from '../src/control-plane/use-cloud-account-security';
import { useI18n } from '../src/i18n';
import { isMobileFeatureEnabled } from '../src/platform/build-variant';

export default function CloudAccountDeleteRoute() {
  if (!isMobileFeatureEnabled('officialAccount')) return <Redirect href="/profiles" />;
  return <CloudAccountDeleteContent />;
}

function CloudAccountDeleteContent() {
  const { t } = useI18n();
  const controller = useCloudAccountSecurity();
  const onDeleted = () => {
    router.dismissAll();
    router.replace('/profiles' as never);
  };

  if (Platform.OS === 'ios') {
    return <>
      <Stack.Screen options={{ title: t('cloudAccount.deleteAccountTitle'), gestureEnabled: !controller.busy }}/>
      <NativeCloudAccountSecuritySectionScreen
        controller={controller}
        onDeleted={onDeleted}
        section="delete"
      />
    </>;
  }

  return <>
    <Stack.Screen options={{ title: t('cloudAccount.deleteAccountTitle'), gestureEnabled: !controller.busy }}/>
    <CloudAccountSecuritySectionScreen
      controller={controller}
      onDeleted={onDeleted}
      section="delete"
    />
  </>;
}
