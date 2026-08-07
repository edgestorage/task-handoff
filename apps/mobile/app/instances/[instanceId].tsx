import { router, Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { mobileAiSessionStore } from '../../src/ai-sessions/store';
import { Screen } from '../../src/components/Screen';
import { SystemIcon } from '../../src/components/SystemIcon';
import { useMobileTheme } from '../../src/components/theme';
import { useActiveDirectories } from '../../src/directories/use-directories';
import { InstanceOverview } from '../../src/instances/InstanceNativeSections';
import { useI18n } from '../../src/i18n';

export default function InstanceDirectoryDetailRoute() {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const { instanceId } = useLocalSearchParams<{ instanceId: string }>();
  const { controlPlaneId, state } = useActiveDirectories();
  const instance = state.instances.find((candidate) => candidate.id === instanceId);
  const node = instance ? state.nodes.find((candidate) => candidate.id === instance.nodeId) : undefined;
  if (!instance) {
    return <Screen><Text style={[styles.error, { color: colors.error }]}>{t('instance.notFound')}</Text></Screen>;
  }

  const activeSessionCount = instance.aiSessions.runningCount + instance.aiSessions.waitingCount;
  const statusColor = instance.ready && instance.connectionStatus === 'online' ? '#34c759' : instance.status === 'failed' || instance.status === 'unhealthy' ? colors.error : colors.textMuted;
  return <>
    <Stack.Screen options={{ title: instance.name }} />
    <Screen>
      <View style={[styles.statusSummary, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusText, { color: colors.textMuted }]}>{instance.status} · {instance.connectionStatus} · {instance.health}</Text>
      </View>

      <InstanceOverview
        activeSessionCount={activeSessionCount}
        heartbeat={instance.lastHeartbeatAt ? new Date(instance.lastHeartbeatAt).toLocaleString(locale) : t('instance.notObserved')}
        nodeName={node?.name || instance.nodeId}
        onCreateSession={() => router.push({ pathname: '/sessions/new', params: { instanceId } })}
        onShowHistory={() => router.push({ pathname: '/history/[instanceId]', params: { instanceId } })}
        onShowSessions={() => {
          if (controlPlaneId) mobileAiSessionStore.setScope(controlPlaneId, { kind: 'instance', instanceId });
          router.push({ pathname: '/(tabs)/(main)/inbox', params: { instanceId } });
        }}
        problemSessionCount={instance.aiSessions.problemCount}
        protocol={instance.protocol.version || t('instance.notReported')}
        protocolCompatible={instance.protocol.compatible}
        runtime={`${instance.runtime.name || instance.runtime.id}${instance.runtime.type ? ` · ${instance.runtime.type}` : ''}`}
        workspace={instance.workspace.path || instance.workspace.status}
      />

      {instance.protocol.warning ? <Notice text={instance.protocol.warning} /> : null}
      {instance.error ? <Notice error text={`${instance.error.code}: ${instance.error.message}`} /> : null}

    </Screen>
  </>;
}

function Notice({ error, text }: { error?: boolean; text: string }) {
  const { colors } = useMobileTheme();
  return <View style={[styles.notice, { backgroundColor: error ? colors.errorSoft : colors.notice }]}>
    <SystemIcon android={error ? 'error' : 'warning'} color={error ? colors.error : colors.noticeText} ios={error ? 'xmark.circle.fill' : 'exclamationmark.triangle.fill'} size={17} />
    <Text style={[styles.noticeText, { color: error ? colors.error : colors.noticeText }]}>{text}</Text>
  </View>;
}

const styles = StyleSheet.create({
  statusSummary: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, minHeight: 42, paddingHorizontal: 12 },
  statusDot: { borderRadius: 999, height: 8, width: 8 },
  statusText: { fontSize: 13, textTransform: 'capitalize' },
  notice: { alignItems: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 9, padding: 12 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  error: { fontSize: 14, lineHeight: 20 },
});
