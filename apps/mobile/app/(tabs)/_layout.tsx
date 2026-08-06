import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileTheme } from '../../src/components/theme';
import { useI18n } from '../../src/i18n';

export default function PrimaryTabsLayout() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const liquidGlassTabs = Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;
  return (
    <SafeAreaView edges={Platform.OS === 'ios' ? [] : ['top']} style={{ flex: 1 }} testID="primary-tabs-safe-area">
      <NativeTabs
        backgroundColor={liquidGlassTabs ? undefined : colors.surface}
        disableTransparentOnScrollEdge={!liquidGlassTabs}
        iconColor={{ default: colors.textMuted, selected: colors.primary }}
        labelStyle={{ color: colors.textMuted, fontSize: 12, fontWeight: '500' }}
        minimizeBehavior={liquidGlassTabs ? 'onScrollDown' : undefined}
        tintColor={colors.primary}
      >
        <NativeTabs.Trigger disableAutomaticContentInsets name="inbox">
          <NativeTabs.Trigger.Icon
            md={{ default: 'chat_bubble_outline', selected: 'chat_bubble' }}
            sf={{ default: 'list.bullet.rectangle', selected: 'list.bullet.rectangle' }}
          />
          <NativeTabs.Trigger.Label>{t('nav.aiSessions')}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger disableAutomaticContentInsets name="nodes">
          <NativeTabs.Trigger.Icon
            md={{ default: 'dns', selected: 'dns' }}
            sf={{ default: 'square.stack.3d.up', selected: 'square.stack.3d.up.fill' }}
          />
          <NativeTabs.Trigger.Label>{t('nav.nodes')}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger disableAutomaticContentInsets hidden name="instances" />
        <NativeTabs.Trigger name="profiles">
          <NativeTabs.Trigger.Icon
            md={{ default: 'tune', selected: 'tune' }}
            sf={{ default: 'slider.horizontal.3', selected: 'slider.horizontal.3' }}
          />
          <NativeTabs.Trigger.Label>{t('nav.controlPlanes')}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </SafeAreaView>
  );
}
