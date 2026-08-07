import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileTheme } from '../../../src/components/theme';
import { useI18n } from '../../../src/i18n';

export default function PrimaryTabsLayout() {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const liquidGlassTabs = Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;
  const nativeTabBlur = Platform.OS === 'ios' && !liquidGlassTabs
    ? dark ? 'systemUltraThinMaterialDark' as const : 'systemUltraThinMaterialLight' as const
    : undefined;
  return (
    <SafeAreaView edges={Platform.OS === 'ios' ? [] : ['top']} style={{ flex: 1 }} testID="primary-tabs-safe-area">
      <NativeTabs backgroundColor={Platform.OS === 'android' ? colors.surface : undefined} blurEffect={nativeTabBlur} disableTransparentOnScrollEdge={Platform.OS === 'ios' && !liquidGlassTabs} iconColor={{ default: colors.textMuted, selected: colors.primary }} labelStyle={{ color: colors.textMuted, fontSize: 12, fontWeight: '500' }} minimizeBehavior={liquidGlassTabs ? 'onScrollDown' : undefined} tintColor={colors.primary}>
        <NativeTabs.Trigger disableAutomaticContentInsets name="inbox">
          <NativeTabs.Trigger.Icon md={{ default: 'chat_bubble_outline', selected: 'chat_bubble' }} sf={{ default: 'list.bullet.rectangle', selected: 'list.bullet.rectangle.fill' }} />
          <NativeTabs.Trigger.Label>{t('nav.aiSessions')}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger disableAutomaticContentInsets name="apps">
          <NativeTabs.Trigger.Icon md={{ default: 'terminal', selected: 'terminal' }} sf={{ default: 'macwindow', selected: 'macwindow' }} />
          <NativeTabs.Trigger.Label>{t('nav.appSessions')}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger disableAutomaticContentInsets name="instances">
          <NativeTabs.Trigger.Icon md={{ default: 'dns', selected: 'dns' }} sf={{ default: 'server.rack', selected: 'server.rack' }} />
          <NativeTabs.Trigger.Label>{t('nav.instances')}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </SafeAreaView>
  );
}
