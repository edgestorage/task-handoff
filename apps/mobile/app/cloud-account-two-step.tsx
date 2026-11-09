import { Redirect, Stack } from 'expo-router';
import { Platform } from 'react-native';

import { CloudAccountSecuritySectionScreen } from '../src/control-plane/CloudAccountSecuritySectionScreen';
import { NativeCloudAccountSecuritySectionScreen } from '../src/control-plane/NativeCloudAccountSecuritySectionScreen';
import { useCloudAccountSecurity } from '../src/control-plane/use-cloud-account-security';
import { useI18n } from '../src/i18n';
import { isMobileFeatureEnabled } from '../src/platform/build-variant';

export default function CloudAccountTwoStepRoute() {
  if (!isMobileFeatureEnabled('officialAccount')) return <Redirect href="/profiles" />;
  return <CloudAccountTwoStepContent />;
}

function CloudAccountTwoStepContent() {
  const { t } = useI18n();
  const controller = useCloudAccountSecurity();

  if (Platform.OS === 'ios') {
    return <>
      <Stack.Screen options={{ title: t('cloudAccount.totpTitle'), gestureEnabled: !controller.busy }}/>
      <NativeCloudAccountSecuritySectionScreen
        controller={controller}
        section="two-step"
      />
    </>;
  }

  return <>
    <Stack.Screen options={{ title: t('cloudAccount.totpTitle'), gestureEnabled: !controller.busy }}/>
    <CloudAccountSecuritySectionScreen
      controller={controller}
      section="two-step"
    />
  </>;
}
