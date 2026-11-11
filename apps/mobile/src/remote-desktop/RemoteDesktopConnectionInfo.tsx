import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gauge, Maximize2, MousePointer2, Users, X } from 'lucide-react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { RemoteDesktopTransportKey } from './preferences';
import { candidateTypeLabel, transportIcon, transportLabel, transportStateLabel } from './transport-presentation';
import type { RemoteDesktopSnapshot } from './types';

type Props = {
  onClose(): void;
  snapshot: RemoteDesktopSnapshot;
  visible: boolean;
};

const transports: readonly RemoteDesktopTransportKey[] = ['p2p', 'websocket', 'turn'];

export function RemoteDesktopConnectionInfo({ onClose, snapshot, visible }: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const activeTransport = snapshot.path ?? transports.find((key) => snapshot.transportStates[key] === 'active');
  const diagnostics = snapshot.transportDiagnostics;
  const latency = activeTransport === 'websocket'
    ? t('remoteDesktop.latencyNotReported')
    : diagnostics?.latencyMs !== undefined
      ? t('remoteDesktop.latencyValue', { value: diagnostics.latencyMs })
      : t('remoteDesktop.latencyMeasuring');
  const candidate = diagnostics && (diagnostics.protocol || diagnostics.localCandidateType || diagnostics.remoteCandidateType)
    ? [
      diagnostics.protocol?.toUpperCase(),
      [candidateTypeLabel(diagnostics.localCandidateType, t), candidateTypeLabel(diagnostics.remoteCandidateType, t)].join(' ↔ '),
    ].filter(Boolean).join(' · ')
    : t('remoteDesktop.candidateUnknown');
  const resolution = snapshot.videoWidth > 0 && snapshot.videoHeight > 0
    ? `${snapshot.videoWidth} × ${snapshot.videoHeight}`
    : t('remoteDesktop.candidateUnknown');
  const inputState = !snapshot.inputRequested
    ? t('remoteDesktop.inputDisabled')
    : snapshot.inputEnabled
      ? t('remoteDesktop.controlling')
      : snapshot.controlRequestPending
        ? t('remoteDesktop.requestingControl')
        : snapshot.hasController && !snapshot.isController
          ? t('remoteDesktop.anotherViewerControls')
          : t('remoteDesktop.inputStarting');

  return <Modal animationType="fade" navigationBarTranslucent onRequestClose={onClose} statusBarTranslucent transparent visible={visible}>
    <Pressable accessibilityLabel={t('remoteDesktop.closeConnectionInfo')} onPress={onClose} style={styles.backdrop}>
      <Pressable accessibilityViewIsModal onPress={() => undefined} style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>{t('remoteDesktop.connectionInfo')}</Text>
          <Pressable accessibilityLabel={t('remoteDesktop.closeConnectionInfo')} accessibilityRole="button" hitSlop={8} onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
            <X color={colors.textMuted} size={20} strokeWidth={1.9} />
          </Pressable>
        </View>

        {activeTransport ? <View style={[styles.route, { backgroundColor: colors.surfaceInset }]}>
          <View style={[styles.routeIcon, { backgroundColor: colors.primarySoft }]}>
            {(() => {
              const RouteIcon = transportIcon(activeTransport);
              return <RouteIcon color={colors.primary} size={22} strokeWidth={1.9} />;
            })()}
          </View>
          <View style={styles.routeCopy}>
            <Text style={[styles.routeTitle, { color: colors.text }]}>{transportLabel(activeTransport, t)}</Text>
            <Text style={[styles.routeState, { color: colors.textMuted }]}>{t('remoteDesktop.transportActive')}</Text>
          </View>
        </View> : null}

        <View style={styles.metrics}>
          <Metric icon={<Gauge color={colors.textMuted} size={16} strokeWidth={1.9} />} label={t('remoteDesktop.latency')} value={latency} />
          <Metric icon={<Users color={colors.textMuted} size={16} strokeWidth={1.9} />} label={t('remoteDesktop.viewersLabel')} value={t('remoteDesktop.viewers', { count: snapshot.viewerCount })} />
          <Metric icon={<Maximize2 color={colors.textMuted} size={16} strokeWidth={1.9} />} label={t('remoteDesktop.resolution')} value={resolution} />
          <Metric icon={<MousePointer2 color={colors.textMuted} size={16} strokeWidth={1.9} />} label={t('remoteDesktop.input')} value={inputState} />
        </View>

        <View style={[styles.section, { borderTopColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('remoteDesktop.pathDetails')}</Text>
          <Text style={[styles.detail, { color: colors.text }]}>{candidate}</Text>
        </View>

        <View style={[styles.section, { borderTopColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('remoteDesktop.connectionMethods')}</Text>
          {transports.map((key) => {
            const MethodIcon = transportIcon(key);
            return <View key={key} style={styles.methodRow}>
              <View style={[styles.methodIcon, { backgroundColor: snapshot.path === key ? colors.primarySoft : colors.surfaceInset }]}>
                <MethodIcon color={snapshot.path === key ? colors.primary : colors.textMuted} size={16} strokeWidth={1.9} />
              </View>
              <Text style={[styles.methodLabel, { color: colors.text }]}>{transportLabel(key, t)}</Text>
              <Text style={[styles.methodState, { color: snapshot.path === key ? colors.primary : colors.textMuted }]}>{transportStateLabel(key, snapshot, t)}</Text>
            </View>;
          })}
        </View>
      </Pressable>
    </Pressable>
  </Modal>;
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.metric}>
    <View style={styles.metricLabel}>{icon}<Text style={[styles.metricLabelText, { color: colors.textMuted }]}>{label}</Text></View>
    <Text numberOfLines={2} style={[styles.metricValue, { color: colors.text }]}>{value}</Text>
  </View>;
}

const styles = StyleSheet.create({
  backdrop: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.56)', flex: 1, justifyContent: 'center', padding: 18 },
  sheet: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, maxWidth: 440, padding: 16, width: '100%' },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 17, fontWeight: '500', lineHeight: 22 },
  close: { alignItems: 'center', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  route: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 11, padding: 11 },
  routeIcon: { alignItems: 'center', borderRadius: 11, height: 42, justifyContent: 'center', width: 42 },
  routeCopy: { flex: 1, gap: 2, minWidth: 0 },
  routeTitle: { fontSize: 15, fontWeight: '500', lineHeight: 20 },
  routeState: { fontSize: 12, lineHeight: 16 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  metric: { backgroundColor: 'rgba(127,127,127,0.09)', borderRadius: 12, flexBasis: '47%', flexGrow: 1, gap: 5, minHeight: 70, padding: 10 },
  metricLabel: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  metricLabelText: { fontSize: 12, lineHeight: 16 },
  metricValue: { fontSize: 14, fontWeight: '500', lineHeight: 19 },
  section: { borderTopWidth: StyleSheet.hairlineWidth, gap: 8, marginTop: 14, paddingTop: 12 },
  sectionTitle: { fontSize: 12, lineHeight: 16 },
  detail: { fontSize: 13, lineHeight: 18 },
  methodRow: { alignItems: 'center', flexDirection: 'row', gap: 9, minHeight: 32 },
  methodIcon: { alignItems: 'center', borderRadius: 8, height: 28, justifyContent: 'center', width: 28 },
  methodLabel: { flex: 1, fontSize: 13, lineHeight: 18 },
  methodState: { fontSize: 12, lineHeight: 16 },
  pressed: { opacity: 0.58 },
});
