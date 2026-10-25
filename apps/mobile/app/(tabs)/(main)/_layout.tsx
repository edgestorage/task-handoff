import Ionicons from '@expo/vector-icons/Ionicons';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useEffect, useState } from 'react';
import { Platform, View, type ColorValue } from 'react-native';

import { useMobileTheme } from '../../../src/components/theme';
import { useAdaptiveContentLayout } from '../../../src/components/adaptive-layout';
import { MobileControlPlaneStatusBanner } from '../../../src/control-plane/MobileControlPlaneStatusBanner';
import { useMobileControlPlaneRuntime } from '../../../src/control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../../../src/i18n';

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
  const runtime = useMobileControlPlaneRuntime();
  const android = Platform.OS === 'android';
  const { regular } = useAdaptiveContentLayout();
  const iosMajorVersion = Platform.OS === 'ios' ? Number.parseInt(String(Platform.Version), 10) : 0;
  const liquidGlassTabs = iosMajorVersion >= 26;
  // UIKit does not rebuild the iPhone Duo side rail when native tabs cold-launch while unfolded.
  // Toggle using the public tab-bar visibility prop until react-native-screens ships the frame fix.
  // https://github.com/software-mansion/react-native-screens/issues/4989
  const recoverDuoSideRail = Platform.OS === 'ios' && iosMajorVersion >= 27 && regular;
  const [nativeTabsHidden, setNativeTabsHidden] = useState(false);
  useEffect(() => {
    if (!recoverDuoSideRail) return;
    const hide = setTimeout(() => setNativeTabsHidden(true), 100);
    const show = setTimeout(() => setNativeTabsHidden(false), 250);
    return () => {
      clearTimeout(hide);
      clearTimeout(show);
      setNativeTabsHidden(false);
    };
  }, [recoverDuoSideRail]);
  const nativeTabBlur = Platform.OS === 'ios' && !liquidGlassTabs
    ? dark ? 'systemUltraThinMaterialDark' as const : 'systemUltraThinMaterialLight' as const
    : undefined;
  return (
    // Native headers and the native tab bar own their own insets; adding a top inset here duplicated
    // the status-bar padding on Android edge-to-edge builds.
    <View style={{ flex: 1 }} testID="primary-tabs-root">
      {/* Material 3 hides the unselected labels and tints the active pill with a muted grey that
          reads oddly next to the brand blue, so every Android destination stays labeled and the
          pill uses the theme's soft primary instead. */}
      <NativeTabs
        backgroundColor={android ? colors.surface : undefined}
        blurEffect={nativeTabBlur}
        disableTransparentOnScrollEdge={Platform.OS === 'ios' && !liquidGlassTabs}
        iconColor={{ default: colors.textMuted, selected: colors.primary }}
        indicatorColor={android ? colors.primarySoft : undefined}
        labelStyle={{ color: colors.textMuted, fontSize: 12, fontWeight: '500' }}
        labelVisibilityMode={android ? 'labeled' : undefined}
        hidden={nativeTabsHidden}
        minimizeBehavior={liquidGlassTabs ? regular ? 'never' : 'onScrollDown' : undefined}
        tintColor={colors.primary}
      >
        <NativeTabs.Trigger disableAutomaticContentInsets name="inbox">
          <NativeTabs.Trigger.Icon
            renderingMode="template"
            src={<NativeTabs.Trigger.VectorIcon family={aiSessionTabIconFamily} name="chatbubbles-outline" />}
          />
          <NativeTabs.Trigger.Label>{t('nav.aiSessions')}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger disableAutomaticContentInsets name="stories">
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
      {runtime.phase === 'control-plane-closed' ? <MobileControlPlaneStatusBanner /> : null}
    </View>
  );
}
