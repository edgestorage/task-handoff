import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAdaptiveContentLayout } from '../components/adaptive-layout';
import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { useMobileControlPlaneRuntime } from './use-mobile-control-plane-runtime';

const FLOATING_TAB_BAR_OFFSET = Platform.select({ android: 88, default: 56 });

export function ControlPlaneClosedBanner({ visible }: { visible: boolean }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const adaptive = useAdaptiveContentLayout();
  if (!visible) return null;
  return (
    <View
      pointerEvents="none"
      style={[styles.position, {
        bottom: Math.max(insets.bottom, 8) + FLOATING_TAB_BAR_OFFSET,
        left: adaptive.contentInsets.left + 16,
        right: adaptive.contentInsets.right + 16,
      }]}
      testID="control-plane-closed-banner-position"
    >
      <View
        accessibilityLiveRegion="assertive"
        accessibilityRole="alert"
        style={[styles.banner, { backgroundColor: colors.notice, borderColor: colors.noticeText }]}
        testID="control-plane-closed-banner"
      >
        <Icon color={colors.noticeText} name="cloud-offline-outline" size={20} />
        <View style={styles.copy}>
          <Text style={[styles.title, { color: colors.noticeText }]}>{t('controlPlane.closedTitle')}</Text>
          <Text style={[styles.detail, { color: colors.text }]}>{t('controlPlane.closedDescription')}</Text>
        </View>
      </View>
    </View>
  );
}

export function MobileControlPlaneStatusBanner() {
  const runtime = useMobileControlPlaneRuntime();
  return <ControlPlaneClosedBanner visible={runtime.phase === 'control-plane-closed'} />;
}

const styles = StyleSheet.create({
  position: { alignItems: 'center', position: 'absolute', zIndex: 900 },
  banner: {
    alignItems: 'flex-start',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 8,
    flexDirection: 'row',
    gap: 10,
    maxWidth: 520,
    paddingHorizontal: 14,
    paddingVertical: 12,
    shadowColor: '#000',
    shadowOffset: { height: 3, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    width: '100%',
  },
  copy: { flex: 1, gap: 2 },
  title: { fontSize: 14, fontWeight: '700', lineHeight: 19 },
  detail: { fontSize: 13, lineHeight: 18 },
});
