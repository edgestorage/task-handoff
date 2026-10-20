import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Screen } from '../components/Screen';
import { Icon, type IconName } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { mobileControlPlaneProfileAddress, type MobileControlPlaneProfile } from './profile';
import type { ControlPlaneCurrentAuthorization } from '@task-handoff/protocol/control-plane-access';
import { controlPlaneRoleMessageKey } from './current-access';

export type ControlPlaneDetailContentProps = {
  active: boolean;
  busy: boolean;
  currentAccess?: ControlPlaneCurrentAuthorization;
  onMakeActive(): void;
  onRemove(): void;
  profile: MobileControlPlaneProfile;
};

export function ControlPlaneDetailContent(props: ControlPlaneDetailContentProps) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const sharedAccess = props.profile.access.kind === 'cloud-relay' && props.profile.access.resourceAccess?.kind === 'shared' ? props.profile.access.resourceAccess : undefined;

  return (
    <Screen>
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{t('controlPlane.connection')}</Text>
        <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <DetailRow label={t('controlPlane.status')} value={props.active ? t('controlPlane.active') : t('controlPlane.saved')} valueColor={props.active ? colors.primary : undefined} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow label={t('controlPlane.address')} value={mobileControlPlaneProfileAddress(props.profile)} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow label={t('controlPlane.id')} value={props.profile.identity.controlPlaneId} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <DetailRow label={t('controlPlane.fingerprint')} value={props.profile.identity.publicKeyFingerprint} />
          {sharedAccess ? <>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <DetailRow label={t('controlPlane.cloudAccess')} value={t('cloudControlPlanes.sharedRole', { role: t(sharedAccess.role === 'operator' ? 'controlPlane.roleOperator' : 'controlPlane.roleViewer') })} />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <DetailRow label={t('controlPlane.shareExpiry')} value={new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sharedAccess.expiresAt))} />
          </> : null}
          {props.currentAccess ? <>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <DetailRow label={t('controlPlane.memberRole')} value={props.currentAccess.roleIds.map((roleId) => { const key = controlPlaneRoleMessageKey(roleId); return key ? t(key) : roleId; }).join(', ')} />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <DetailRow label={t('controlPlane.nodeAccess')} value={props.currentAccess.nodeScope.kind === 'all' ? t('controlPlane.allNodes') : t('controlPlane.selectedNodes', { count: props.currentAccess.nodeScope.nodeIds.length })} />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <DetailRow label={t('controlPlane.authorizationRevision')} value={String(props.currentAccess.authorizationRevision)} />
          </> : null}
        </View>
        <Text style={[styles.footnote, { color: colors.textMuted }]}>{t('controlPlane.fingerprintHelp')}</Text>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{t('controlPlane.actions')}</Text>
        <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {!props.active ? <>
            <ActionRow disabled={props.busy} icon="checkmark-circle-outline" label={t('controlPlane.makeActive')} onPress={props.onMakeActive} tint={colors.primary} />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
          </> : null}
          <ActionRow disabled={props.busy} icon="trash-outline" label={t('controlPlane.remove')} onPress={props.onRemove} tint={colors.error} />
        </View>
        <Text style={[styles.footnote, { color: colors.textMuted }]}>{t('controlPlane.removeHelp')}</Text>
      </View>

      {props.busy ? <ActivityIndicator accessibilityLabel={t('controlPlane.updating')} /> : null}
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

function ActionRow({ disabled, icon, label, onPress, tint }: { disabled: boolean; icon: IconName; label: string; onPress(): void; tint: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.actionRow, disabled && styles.disabled, pressed && styles.pressed]}>
      <Icon color={tint} name={icon} size={18} />
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
});
