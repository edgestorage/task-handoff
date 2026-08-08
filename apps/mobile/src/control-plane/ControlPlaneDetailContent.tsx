import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Screen } from '../components/Screen';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { MobileControlPlaneProfile } from './profile';

export type ControlPlaneDetailContentProps = {
  active: boolean;
  busy: boolean;
  error?: string;
  onMakeActive(): void;
  onRemove(): void;
  profile: MobileControlPlaneProfile;
};

export function ControlPlaneDetailContent(props: ControlPlaneDetailContentProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();

  return (
    <Screen>
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{t('controlPlane.connection')}</Text>
        <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <DetailRow label={t('controlPlane.status')} value={props.active ? t('controlPlane.active') : t('controlPlane.saved')} valueColor={props.active ? colors.primary : undefined} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow label={t('controlPlane.address')} value={props.profile.access.origin} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow label={t('controlPlane.id')} value={props.profile.identity.controlPlaneId} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow label={t('controlPlane.fingerprint')} value={props.profile.identity.publicKeyFingerprint} />
        </View>
        <Text style={[styles.footnote, { color: colors.textMuted }]}>{t('controlPlane.fingerprintHelp')}</Text>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{t('controlPlane.actions')}</Text>
        <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {!props.active ? <>
            <ActionRow disabled={props.busy} icon={{ android: 'check_circle', ios: 'checkmark.circle' }} label={t('controlPlane.makeActive')} onPress={props.onMakeActive} tint={colors.primary} />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
          </> : null}
          <ActionRow disabled={props.busy} icon={{ android: 'delete', ios: 'trash' }} label={t('controlPlane.remove')} onPress={props.onRemove} tint={colors.error} />
        </View>
        <Text style={[styles.footnote, { color: colors.textMuted }]}>{t('controlPlane.removeHelp')}</Text>
      </View>

      {props.busy ? <ActivityIndicator accessibilityLabel={t('controlPlane.updating')} /> : null}
      {props.error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.error }]}>{props.error}</Text> : null}
    </Screen>
  );
}

function DetailRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  const { colors } = useMobileTheme();
  return (
    <View style={styles.detailRow}>
      <Text style={[styles.detailLabel, { color: colors.text }]}>{label}</Text>
      <Text numberOfLines={2} selectable style={[styles.detailValue, { color: valueColor ?? colors.textMuted }]}>{value}</Text>
    </View>
  );
}

function ActionRow({ disabled, icon, label, onPress, tint }: { disabled: boolean; icon: { android: 'check_circle' | 'delete'; ios: 'checkmark.circle' | 'trash' }; label: string; onPress(): void; tint: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.actionRow, disabled && styles.disabled, pressed && styles.pressed]}>
      <SystemIcon android={icon.android} color={tint} ios={icon.ios} size={18} />
      <Text style={[styles.actionLabel, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: 7 },
  sectionLabel: { fontSize: 12, marginLeft: 16 },
  group: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  detailRow: { gap: 4, minHeight: 58, paddingHorizontal: 16, paddingVertical: 10 },
  detailLabel: { fontSize: 15 },
  detailValue: { fontFamily: 'monospace', fontSize: 12, lineHeight: 17 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  footnote: { fontSize: 12, lineHeight: 17, marginHorizontal: 16 },
  actionRow: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 50, paddingHorizontal: 16 },
  actionLabel: { fontSize: 16 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.55 },
  error: { fontSize: 13, lineHeight: 19 },
});
