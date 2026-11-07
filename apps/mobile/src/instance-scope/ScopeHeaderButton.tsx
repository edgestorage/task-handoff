import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime, useMobileControlPlaneTopicSyncing, type MobileControlPlaneRuntimePhase } from '../control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/messages';

// Recovery errors follow the shared connection. Loading ends when this Tab's
// snapshot is ready, without waiting for other domains or the event socket.
const phaseLabels: Partial<Record<MobileControlPlaneRuntimePhase, MessageKey>> = {
  verifying: 'common.loading',
  loading: 'common.loading',
  reconnecting: 'common.loading',
  'approved-connecting': 'common.loading',
  offline: 'status.offline',
  'session-expired': 'scope.sessionExpired',
  'waiting-device-approval': 'deviceTrust.pendingTitle',
  rejected: 'deviceTrust.rejectedTitle',
  expired: 'deviceTrust.expiredTitle',
  revoked: 'deviceTrust.revokedTitle',
  'trust-required': 'deviceTrust.requiredTitle',
  'control-plane-closed': 'controlPlane.closedTitle',
  error: 'status.failed',
};

export function ScopeHeaderButton({ icon, label, onPress, syncTopic }: {
  syncTopic: string;
  icon: IconName;
  label: string;
  onPress(): void;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { phase } = useMobileControlPlaneRuntime();
  const syncing = useMobileControlPlaneTopicSyncing(syncTopic);
  const mappedLabel = phaseLabels[phase];
  const phaseLabel = mappedLabel === 'common.loading' && !syncing ? undefined : mappedLabel;
  const busy = phaseLabel === 'common.loading';
  const statusLabel = phaseLabel ? t(phaseLabel) : undefined;
  return <Pressable
    accessibilityLabel={statusLabel ? `${label}, ${statusLabel}` : label}
    accessibilityRole="button"
    accessibilityState={{ busy }}
    hitSlop={{ top: 5, bottom: 5 }}
    onPress={onPress}
    style={({ pressed }) => [styles.button, pressed && styles.pressed]}
  >
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.icon}>
      {busy
        ? <ActivityIndicator color={colors.primary} size="small" testID="scope-header-loading" />
        : <Icon color={colors.primary} name={statusLabel ? 'alert-circle-outline' : icon} size={17} />}
    </View>
    <Text numberOfLines={1} style={[styles.label, { color: colors.primary }]}>{statusLabel ?? label}</Text>
    <Icon color={colors.primary} name="chevron-down" size={10} />
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', flexDirection: 'row', gap: 6, maxWidth: 166, minHeight: 34, paddingHorizontal: 6 },
  icon: { alignItems: 'center', justifyContent: 'center', height: 20, width: 20 },
  label: { flexShrink: 1, fontSize: 14, fontWeight: '500' },
  pressed: { opacity: 0.55 },
});
