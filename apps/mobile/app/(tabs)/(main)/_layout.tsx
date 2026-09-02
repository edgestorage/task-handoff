import Ionicons from '@expo/vector-icons/Ionicons';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Platform, type ColorValue } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileTheme } from '../../../src/components/theme';
import { useI18n } from '../../../src/i18n';
import { useOptionalMobileControlPlaneRuntime } from '../../../src/control-plane/use-mobile-control-plane-runtime';

const TAB_ICON_SIZE = 25;

const aiSessionTabIconFamily = {
  getImageSource(_name: 'chatbubbles-outline', _size: number, color: ColorValue) {
    return Ionicons.getImageSource('chatbubbles-outline', TAB_ICON_SIZE, color);
  },
};

const appSessionTabIconFamily = {
  getImageSource(_name: 'cube-outline', _size: number, color: ColorValue) {
    return Ionicons.getImageSource('cube-outline', TAB_ICON_SIZE, color);
  },
};

const instanceTabIconFamily = {
  getImageSource(_name: 'layers-outline', _size: number, color: ColorValue) {
    return Ionicons.getImageSource('layers-outline', TAB_ICON_SIZE, color);
  },
};

const storyTabIconFamily = {
  getImageSource(_name: 'book-outline', _size: number, color: ColorValue) {
    return Ionicons.getImageSource('book-outline', TAB_ICON_SIZE, color);
  },
};

export default function PrimaryTabsLayout() {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const runtime = useOptionalMobileControlPlaneRuntime();
  const liquidGlassTabs = Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;
  const nativeTabBlur = Platform.OS === 'ios' && !liquidGlassTabs
    ? dark ? 'systemUltraThinMaterialDark' as const : 'systemUltraThinMaterialLight' as const
    : undefined;
  return (
    <SafeAreaView edges={Platform.OS === 'ios' ? [] : ['top']} style={{ flex: 1 }} testID="primary-tabs-safe-area">
      <NativeTabs backgroundColor={Platform.OS === 'android' ? colors.surface : undefined} blurEffect={nativeTabBlur} disableTransparentOnScrollEdge={Platform.OS === 'ios' && !liquidGlassTabs} iconColor={{ default: colors.textMuted, selected: colors.primary }} labelStyle={{ color: colors.textMuted, fontSize: 12, fontWeight: '500' }} minimizeBehavior={liquidGlassTabs ? 'onScrollDown' : undefined} tintColor={colors.primary}>
        <NativeTabs.Trigger disableAutomaticContentInsets name="inbox">
          <NativeTabs.Trigger.Icon
            renderingMode="template"
            src={<NativeTabs.Trigger.VectorIcon family={aiSessionTabIconFamily} name="chatbubbles-outline" />}
          />
          <NativeTabs.Trigger.Label>{t('nav.aiSessions')}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger disableAutomaticContentInsets hidden={!runtime?.storyCapability} name="stories">
          <NativeTabs.Trigger.Icon renderingMode="template" src={<NativeTabs.Trigger.VectorIcon family={storyTabIconFamily} name="book-outline" />} />
          <NativeTabs.Trigger.Label>{t('nav.stories')}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger disableAutomaticContentInsets name="apps">
          <NativeTabs.Trigger.Icon
            renderingMode="template"
            src={<NativeTabs.Trigger.VectorIcon family={appSessionTabIconFamily} name="cube-outline" />}
          />
          <NativeTabs.Trigger.Label>{t('nav.appSessions')}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger disableAutomaticContentInsets name="instances">
          <NativeTabs.Trigger.Icon
            renderingMode="template"
            src={<NativeTabs.Trigger.VectorIcon family={instanceTabIconFamily} name="layers-outline" />}
          />
          <NativeTabs.Trigger.Label>{t('nav.instances')}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </SafeAreaView>
  );
}
