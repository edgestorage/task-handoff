import type { CloudClientTrustOutcome } from '@task-handoff/cloud-contracts/mobile';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

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
  resource,
  testID,
}: {
  connection?: InitialSyncConnection;
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
  phase,
  t,
  testID,
  trust,
}: {
  connection: InitialSyncConnection;
  locale: string;
  phase: MobileControlPlaneRuntimePhase;
  t: Translate;
  testID?: string;
  trust: CloudClientTrustOutcome;
}) {
  const { colors } = useMobileTheme();
  const adaptive = useAdaptiveContentLayout();
  const copy = deviceTrustCopy(phase, trust, t);
  const controlPlaneId = connection.controlPlane?.id || trust.controlPlaneId;
  const controlPlaneName = connection.controlPlane?.name?.trim() || controlPlaneId;
  const source = [connection.controlPlane?.source, connection.controlPlane?.origin].filter(Boolean).join(' · ');
  const canRetry = phase === 'rejected' || phase === 'expired' || phase === 'revoked';
  const pending = phase === 'waiting-device-approval' || phase === 'approved-connecting';
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
        {controlPlaneName !== controlPlaneId ? <TrustRow label={t('deviceTrust.controlPlaneId')} value={controlPlaneId} selectable /> : null}
        {source ? <TrustRow label={t('deviceTrust.source')} value={source} /> : null}
      </View>

      <View style={[styles.section, { borderColor: colors.border }]}>
        <TrustRow label={t('deviceTrust.device')} value={trust.device.name} />
        <TrustRow label={t('deviceTrust.deviceType')} value={deviceMetadata(trust.device)} />
        <TrustRow label={t('deviceTrust.fingerprint')} value={trust.devicePublicKeyFingerprint} selectable />
        <TrustRow label={t('deviceTrust.comparisonCode')} value={trust.comparisonCode} selectable strong />
      </View>

      <View style={[styles.section, { borderColor: colors.border }]}>
        {trust.reason ? <TrustRow label={t('deviceTrust.reason')} value={t(reasonKey(trust.reason))} /> : null}
        {trust.requestId ? <TrustRow label={t('deviceTrust.requestId')} value={trust.requestId} selectable /> : null}
        <TrustRow label={t('deviceTrust.expiresAt')} value={formatExpiry(trust.expiresAt, locale)} />
      </View>

      {phase === 'waiting-device-approval' ? <Text style={[styles.hint, { color: colors.textMuted }]}>{t('deviceTrust.waitingHint')}</Text> : null}
      {canRetry ? <Pressable
        accessibilityRole="button"
        onPress={connection.onRetryDeviceTrust}
        style={({ pressed }) => [styles.retry, { backgroundColor: colors.primary, opacity: pressed ? 0.78 : 1 }]}
      >
        <Icon color="#fff" name="refresh-outline" size={18} />
        <Text style={styles.retryText}>{t('deviceTrust.retry')}</Text>
      </Pressable> : null}
    </View>
  </ScrollView>;
}

function TrustRow({ label, selectable, strong, value }: { label: string; selectable?: boolean; strong?: boolean; value: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.row}>
    <Text style={[styles.rowLabel, { color: colors.textMuted }]}>{label}</Text>
    <Text selectable={selectable} style={[styles.rowValue, strong && styles.strong, { color: colors.text }]}>{value}</Text>
  </View>;
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

function formatExpiry(value: string, locale: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

const styles = StyleSheet.create({
  card: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, gap: 18, maxWidth: 560, padding: 20, width: '100%' },
  container: { alignItems: 'center', flexGrow: 1, justifyContent: 'center', padding: 24 },
  description: { fontSize: 14, lineHeight: 20 },
  heading: { alignItems: 'flex-start', flexDirection: 'row', gap: 12 },
  headingCopy: { flex: 1, gap: 5 },
  hint: { fontSize: 13, lineHeight: 19 },
  retry: { alignItems: 'center', alignSelf: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 8, minHeight: 42, paddingHorizontal: 16 },
  retryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  row: { gap: 2 },
  rowLabel: { fontSize: 12, lineHeight: 17 },
  rowValue: { fontSize: 13, lineHeight: 19 },
  section: { borderTopWidth: StyleSheet.hairlineWidth, gap: 11, paddingTop: 14 },
  strong: { fontSize: 16, fontWeight: '600', letterSpacing: 0.6, lineHeight: 22 },
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
