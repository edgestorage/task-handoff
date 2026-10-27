import type { CloudClientTrustOutcome } from '@task-handoff/cloud-contracts/mobile';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { MobileControlPlaneRuntimePhase } from '../control-plane/use-mobile-control-plane-runtime';
import { useOptionalMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useI18n, type Translate } from '../i18n';
import type { MessageKey } from '../i18n/messages';
import { useAdaptiveContentLayout } from './adaptive-layout';
import { Icon } from './Icon';
import { LoadingState } from './LoadingState';
import { useMobileTheme } from './theme';

export type InitialSyncResource = 'aiSessions' | 'stories' | 'appSessions';

export type InitialSyncConnection = {
  phase: MobileControlPlaneRuntimePhase;
  relay?: boolean;
  controlPlane?: {
    id?: string;
    name?: string;
    origin?: string;
    source?: string;
  };
  deviceTrust?: CloudClientTrustOutcome;
  onRetryDeviceTrust?: () => void;
};

const resourceLabels: Record<InitialSyncResource, { item: MessageKey; plural: MessageKey }> = {
  aiSessions: { item: 'nav.aiSession', plural: 'nav.aiSessions' },
  appSessions: { item: 'appSessions.singular', plural: 'nav.appSessions' },
  stories: { item: 'stories.singular', plural: 'nav.stories' },
};

export function InitialSyncLoading({
  connection,
  onOpenSettings,
  resource,
  testID,
}: {
  connection?: InitialSyncConnection;
  onOpenSettings?: () => void;
  resource: InitialSyncResource;
  testID?: string;
}) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const adaptive = useAdaptiveContentLayout();
  const runtime = useOptionalMobileControlPlaneRuntime();
  const effectiveConnection = runtime ? {
    phase: runtime.phase,
    relay: runtime.profile?.access.kind === 'cloud-relay',
    controlPlane: {
      id: runtime.profile?.identity?.controlPlaneId,
      name: runtime.profile?.identity?.displayName,
      origin: runtime.profile?.access.kind === 'cloud-relay'
        ? runtime.profile.access.serviceOrigin
        : runtime.profile?.access.kind === 'direct' ? runtime.profile.access.origin : undefined,
      source: runtime.profile?.access.kind === 'cloud-relay'
        ? t('deviceTrust.sourceCloudRelay')
        : runtime.profile?.access.kind === 'direct' ? t('deviceTrust.sourceDirect') : undefined,
    },
    deviceTrust: runtime.deviceTrust,
    onRetryDeviceTrust: () => { runtime.retryDeviceTrust(); },
  } satisfies InitialSyncConnection : connection;
  const phase = effectiveConnection?.phase;
  const trust = effectiveConnection?.deviceTrust;
  if (trust && phase && isDeviceTrustPhase(phase)) {
    return <DeviceTrustLoadingState
      connection={effectiveConnection}
      locale={locale}
      onOpenSettings={onOpenSettings}
      phase={phase}
      t={t}
      testID={testID}
      trust={trust}
    />;
  }
  const labels = resourceLabels[resource];
  const resourceName = t(labels.plural);
  const copy = initialLoadingCopy(effectiveConnection, resourceName, t(labels.item), t);
  return <LoadingState
    accessibilityLabel={t('common.loading.accessibility', { resource: resourceName })}
    description={copy.description}
    style={[adaptive.contentStyle, { backgroundColor: colors.background }]}
    testID={testID}
    title={copy.title}
  />;
}

const DEVICE_TRUST_PHASES = new Set<MobileControlPlaneRuntimePhase>([
  'waiting-device-approval',
  'approved-connecting',
  'rejected',
  'expired',
  'revoked',
  'trust-required',
]);

export function isDeviceTrustPhase(phase: MobileControlPlaneRuntimePhase) {
  return DEVICE_TRUST_PHASES.has(phase);
}

function DeviceTrustLoadingState({
  connection,
  locale,
  onOpenSettings,
  phase,
  t,
  testID,
  trust,
}: {
  connection: InitialSyncConnection;
  locale: string;
  onOpenSettings?: () => void;
  phase: MobileControlPlaneRuntimePhase;
  t: Translate;
  testID?: string;
  trust: CloudClientTrustOutcome;
}) {
  const { colors } = useMobileTheme();
  const adaptive = useAdaptiveContentLayout();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const copy = deviceTrustCopy(phase, trust, t);
  const controlPlaneId = connection.controlPlane?.id || trust.controlPlaneId;
  const controlPlaneName = connection.controlPlane?.name?.trim() || controlPlaneId;
  const source = [connection.controlPlane?.source, connection.controlPlane?.origin].filter(Boolean).join(' · ');
  const canRetry = phase === 'rejected' || phase === 'expired' || phase === 'revoked';
  const singleAction = Number(canRetry) + Number(Boolean(onOpenSettings)) === 1;
  const pending = phase === 'waiting-device-approval' || phase === 'approved-connecting';
  const reasonVisible = Boolean(trust.reason) && (
    phase === 'rejected'
    || phase === 'expired'
    || phase === 'revoked'
    || phase === 'trust-required'
    || trust.reason === 'role-changed'
    || trust.reason === 'share-role-changed'
  );
  return <ScrollView
    contentContainerStyle={[styles.container, adaptive.contentStyle]}
    style={{ backgroundColor: colors.background, flex: 1 }}
    testID={testID}
  >
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole={phase === 'rejected' || phase === 'revoked' ? 'alert' : undefined}
      accessibilityState={{ busy: pending }}
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
      testID="device-trust-state"
    >
      <View style={styles.heading}>
        {pending
          ? <ActivityIndicator color={colors.primary} />
          : <Icon color={colors.error} name={phase === 'trust-required' ? 'arrow-up-circle-outline' : 'alert-circle-outline'} size={26} />}
        <View style={styles.headingCopy}>
          <Text style={[styles.title, { color: colors.text }]}>{copy.title}</Text>
          <Text style={[styles.description, { color: colors.textMuted }]}>{copy.description}</Text>
        </View>
      </View>

      <View style={[styles.section, { borderColor: colors.border }]}>
        <TrustRow label={t('deviceTrust.controlPlane')} value={controlPlaneName || t('common.unknown')} />
        {source ? <Text style={[styles.meta, { color: colors.textMuted }]}>{source}</Text> : null}
        <TrustRow label={t('deviceTrust.device')} value={trust.device.name} />
        {trust.device.platform ? <Text style={[styles.meta, { color: colors.textMuted }]}>{trust.device.platform}</Text> : null}
      </View>

      <View style={[styles.section, { borderColor: colors.border }]}>
        <TrustRow
          hint={{ label: t('deviceTrust.comparisonCode'), text: t('deviceTrust.comparisonCodeHint') }}
          label={t('deviceTrust.comparisonCode')}
          strong
          value={trust.comparisonCode}
        />
        <TrustRow label={t('deviceTrust.expiresAt')} value={formatExpiryRelative(trust.expiresAt, t)} />
      </View>

      {reasonVisible && trust.reason ? <Text style={[styles.reason, { color: colors.textMuted }]}>{t(reasonKey(trust.reason))}</Text> : null}
      {phase === 'waiting-device-approval' ? <Text style={[styles.hint, { color: colors.textMuted }]}>{t('deviceTrust.waitingHint')}</Text> : null}

      <View style={[styles.actions, singleAction && styles.actionsSingle]}>
        {canRetry ? <Pressable
          accessibilityRole="button"
          onPress={connection.onRetryDeviceTrust}
          style={({ pressed }) => [styles.retry, singleAction && styles.actionFill, { backgroundColor: colors.primary, opacity: pressed ? 0.78 : 1 }]}
        >
          <Icon color="#fff" name="refresh-outline" size={18} />
          <Text style={styles.retryText}>{t('deviceTrust.retry')}</Text>
        </Pressable> : null}
        {onOpenSettings ? <Pressable
          accessibilityLabel={t('deviceTrust.backToSettings')}
          accessibilityRole="button"
          onPress={onOpenSettings}
          style={({ pressed }) => [styles.settingsAction, singleAction && styles.actionFill, { borderColor: colors.border, opacity: pressed ? 0.6 : 1 }]}
        >
          <Icon color={colors.text} name="settings-outline" size={17} />
          <Text style={[styles.settingsText, { color: colors.text }]}>{t('deviceTrust.backToSettings')}</Text>
        </Pressable> : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: detailsOpen }}
        onPress={() => setDetailsOpen((open) => !open)}
        style={({ pressed }) => [styles.detailsToggle, { opacity: pressed ? 0.6 : 1 }]}
        testID="device-trust-details-toggle"
      >
        <Text style={[styles.detailsToggleText, { color: colors.primary }]}>{detailsOpen ? t('deviceTrust.hideDetails') : t('deviceTrust.showDetails')}</Text>
        <Icon color={colors.primary} name={detailsOpen ? 'chevron-up' : 'chevron-down'} size={15} />
      </Pressable>

      {detailsOpen ? <View style={[styles.details, { borderColor: colors.border }]}>
        <TrustRow label={t('deviceTrust.controlPlaneId')} value={controlPlaneId} selectable />
        <TrustRow
          hint={{ label: t('deviceTrust.fingerprint'), text: t('deviceTrust.fingerprintHint') }}
          label={t('deviceTrust.fingerprint')}
          selectable
          value={trust.devicePublicKeyFingerprint}
        />
        <TrustRow label={t('deviceTrust.deviceType')} value={deviceMetadata(trust.device)} />
        {trust.requestId ? <TrustRow label={t('deviceTrust.requestId')} value={trust.requestId} selectable /> : null}
        {trust.reason ? <TrustRow label={t('deviceTrust.reason')} value={t(reasonKey(trust.reason))} /> : null}
        <TrustRow label={t('deviceTrust.expiresAt')} value={formatExpiry(trust.expiresAt, locale)} />
      </View> : null}
    </View>
  </ScrollView>;
}

function TrustRow({
  hint,
  label,
  selectable,
  strong,
  value,
}: {
  hint?: { label: string; text: string };
  label: string;
  selectable?: boolean;
  strong?: boolean;
  value: string;
}) {
  const { colors } = useMobileTheme();
  return <View style={styles.row}>
    <View style={styles.rowLabelLine}>
      <Text style={[styles.rowLabel, { color: colors.textMuted }]}>{label}</Text>
      {hint ? <InfoTip label={hint.label} text={hint.text} /> : null}
    </View>
    <Text selectable={selectable} style={[styles.rowValue, strong && styles.strong, { color: colors.text }]}>{value}</Text>
  </View>;
}

function InfoTip({ label, text }: { label: string; text: string }) {
  const { colors } = useMobileTheme();
  const [open, setOpen] = useState(false);
  return <>
    <Pressable accessibilityLabel={label} accessibilityRole="button" hitSlop={10} onPress={() => setOpen(true)} style={styles.infoButton}>
      <Icon color={colors.textMuted} name="information-circle-outline" size={15} />
    </Pressable>
    <Modal animationType="fade" onRequestClose={() => setOpen(false)} transparent visible={open}>
      <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={styles.tipBackdrop}>
        <View style={[styles.tipCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.tipTitle, { color: colors.text }]}>{label}</Text>
          <Text style={[styles.tipText, { color: colors.textMuted }]}>{text}</Text>
        </View>
      </Pressable>
    </Modal>
  </>;
}

function deviceTrustCopy(phase: MobileControlPlaneRuntimePhase, trust: CloudClientTrustOutcome, t: Translate) {
  if (phase === 'approved-connecting') return {
    title: t('deviceTrust.approvedTitle'),
    description: t('deviceTrust.approvedDescription'),
  };
  if (phase === 'rejected' && trust.reason === 'authorization-stale') return {
    title: t('deviceTrust.staleTitle'),
    description: t('deviceTrust.staleDescription'),
  };
  if (phase === 'rejected') return {
    title: t('deviceTrust.rejectedTitle'),
    description: t('deviceTrust.rejectedDescription'),
  };
  if (phase === 'expired') return {
    title: t('deviceTrust.expiredTitle'),
    description: t('deviceTrust.expiredDescription'),
  };
  if (phase === 'revoked') return {
    title: t('deviceTrust.revokedTitle'),
    description: t('deviceTrust.revokedDescription'),
  };
  if (phase === 'trust-required') return {
    title: t('deviceTrust.requiredTitle'),
    description: t('deviceTrust.requiredDescription'),
  };
  return {
    title: t('deviceTrust.pendingTitle'),
    description: trust.reason === 'role-changed' || trust.reason === 'share-role-changed'
      ? t('deviceTrust.pendingRoleChanged')
      : t('deviceTrust.pendingDescription'),
  };
}

function reasonKey(reason: NonNullable<CloudClientTrustOutcome['reason']>): MessageKey {
  return `deviceTrust.reason.${reason}` as MessageKey;
}

function deviceMetadata(device: CloudClientTrustOutcome['device']) {
  return [device.kind, device.platform, device.version].filter(Boolean).join(' · ');
}

function formatExpiryRelative(value: string, t: Translate) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return t('deviceTrust.expiredAlready');
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return t('deviceTrust.expiresInMinutes', { count: minutes });
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return t('deviceTrust.expiresInHours', { count: hours });
  return t('deviceTrust.expiresInDays', { count: Math.ceil(hours / 24) });
}

function formatExpiry(value: string, locale: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

const styles = StyleSheet.create({
  actionFill: { alignSelf: 'stretch', justifyContent: 'center', width: '100%' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  actionsSingle: { flexDirection: 'column' },
  card: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, gap: 14, maxWidth: 560, padding: 18, width: '100%' },
  container: { alignItems: 'center', flexGrow: 1, justifyContent: 'center', padding: 24 },
  description: { fontSize: 14, lineHeight: 20 },
  details: { borderTopWidth: StyleSheet.hairlineWidth, gap: 10, paddingTop: 12 },
  detailsToggle: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', gap: 4, minHeight: 36 },
  detailsToggleText: { fontSize: 13, fontWeight: '500' },
  heading: { alignItems: 'flex-start', flexDirection: 'row', gap: 12 },
  headingCopy: { flex: 1, gap: 5 },
  hint: { fontSize: 13, lineHeight: 19 },
  infoButton: { alignItems: 'center', justifyContent: 'center', minHeight: 20, minWidth: 20 },
  meta: { fontSize: 12, lineHeight: 17 },
  reason: { fontSize: 13, lineHeight: 19 },
  retry: { alignItems: 'center', alignSelf: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 8, minHeight: 42, paddingHorizontal: 16 },
  retryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  row: { gap: 2 },
  rowLabel: { fontSize: 12, lineHeight: 17 },
  rowLabelLine: { alignItems: 'center', flexDirection: 'row', gap: 3 },
  rowValue: { fontSize: 13, lineHeight: 19 },
  section: { borderTopWidth: StyleSheet.hairlineWidth, gap: 8, paddingTop: 12 },
  settingsAction: { alignItems: 'center', alignSelf: 'flex-start', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, minHeight: 42, paddingHorizontal: 14 },
  settingsText: { fontSize: 14, fontWeight: '500' },
  strong: { fontSize: 20, fontWeight: '600', letterSpacing: 0.8, lineHeight: 26 },
  tipBackdrop: { alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.24)', flex: 1, justifyContent: 'center', padding: 24 },
  tipCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 6, maxWidth: 320, padding: 16, width: '100%' },
  tipText: { fontSize: 13, lineHeight: 19 },
  tipTitle: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
  title: { fontSize: 19, fontWeight: '700', lineHeight: 25 },
});

function initialLoadingCopy(connection: InitialSyncConnection | undefined, resource: string, item: string, t: Translate) {
  if (connection?.phase === 'verifying') return connection.relay
    ? { title: t('common.loading.connectingRelay'), description: t('common.loading.connectingDescription', { resource }) }
    : { title: t('common.loading.connectingControlPlane'), description: t('common.loading.connectingDescription', { resource }) };
  if (connection?.phase === 'reconnecting') return connection.relay
    ? { title: t('common.loading.reconnectingRelay'), description: t('common.loading.reconnectingDescription', { resource }) }
    : { title: t('common.loading.reconnectingControlPlane'), description: t('common.loading.reconnectingDescription', { resource }) };
  if (!connection?.phase || connection.phase === 'idle') return {
    title: t('common.loading.preparing', { resource }),
    description: t('common.loading.preparingDescription'),
  };
  return {
    title: t('common.loading.syncing', { resource }),
    description: t('common.loading.syncingDescription', { item }),
  };
}
