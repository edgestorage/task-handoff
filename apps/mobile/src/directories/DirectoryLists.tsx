import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import type { MobileDirectoryProfileState } from './store';
import { useMobileTheme } from '../components/theme';
import { SystemIcon } from '../components/SystemIcon';
import { ScreenFlatList } from '../components/ScreenFlatList';
import { aiSessionSummary, connectionModeLabel, instanceStateLabel, nodeDisplayName, nodeStateLabel, nodeSummary, relativeObservedAt } from './presentation';
import { useI18n } from '../i18n';

export function NodesDirectory({ state, onOpen }: { state: MobileDirectoryProfileState; onOpen?(node: ControlPlaneNodeDirectoryEntry): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <View style={[styles.screen, { backgroundColor: colors.background }]}><DirectoryList state={state} data={state.nodes} keyOf={(node) => node.id} render={(node) => (
    <DirectoryCard icon="node" onPress={() => onOpen?.(node)} title={nodeDisplayName(node, t)} subtitle={connectionModeLabel(node.connectionMode, t)}>
      <View style={styles.nodeSummary}>
        <Text style={[styles.meta, { color: colors.textMuted }]}>{nodeSummary(state.instances.filter((instance) => instance.nodeId === node.id).length, node, t)}</Text>
      </View>
      {node.status === 'online' && node.health === 'ok' ? null : <Text style={[styles.meta, { color: colors.textMuted }]}>{relativeObservedAt(node.lastSeenAt || node.observedAt, t)}</Text>}
      {node.error ? <Text style={[styles.error, { color: colors.error }]}>{node.error.code}: {node.error.message}</Text> : null}
    </DirectoryCard>
  )} /></View>;
}

export function InstancesDirectory({ state, nodeId, onOpen }: { state: MobileDirectoryProfileState; nodeId?: string; onOpen?(instance: ControlPlaneInstanceDirectoryEntry): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [selectedNode, setSelectedNode] = useState(nodeId || 'all');
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [selectedAi, setSelectedAi] = useState<InstanceAiFilter>('all');
  const nodes = useMemo(() => [...new Set(state.instances.map((instance) => instance.nodeId))].sort(), [state.instances]);
  const statuses = useMemo(() => [...new Set(state.instances.map((instance) => instance.status))].sort(), [state.instances]);
  const instances = filterInstances(state.instances, {
    nodeId: nodeId || selectedNode,
    status: selectedStatus,
    ai: selectedAi,
  });
  const node = nodeId ? state.nodes.find((candidate) => candidate.id === nodeId) : undefined;
  return <View style={[styles.screen, { backgroundColor: colors.background }]}>
    {nodeId ? (
      <View style={[styles.nodeStatusSummary, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
        <View style={[styles.nodeStatusDot, { backgroundColor: node?.health === 'ok' ? '#34c759' : colors.textMuted }]} />
        <Text numberOfLines={1} style={[styles.nodeStatusText, { color: colors.textMuted }]}>{node ? `${nodeStateLabel(node, t)} · ${connectionModeLabel(node.connectionMode, t)}` : t('directories.nodeUnavailable')}</Text>
      </View>
    ) : <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('directories.instances')}</Text>}
    {nodeId ? <View style={styles.sectionHeading}><Text style={[styles.sectionTitle, { color: colors.text }]}>{t('directories.instances')}</Text><Text style={[styles.sectionCount, { backgroundColor: colors.surfaceMuted, color: colors.textMuted }]}>{instances.length}</Text></View> : null}
    <View accessibilityRole="toolbar" style={styles.filters}>
      {!nodeId && nodes.length > 1 ? <FilterRow label={t('nav.node')} values={['all', ...nodes]} value={selectedNode} onChange={setSelectedNode} /> : null}
      {statuses.length > 1 ? <FilterRow label={t('directories.status')} values={['all', ...statuses]} value={selectedStatus} onChange={setSelectedStatus} /> : null}
      <FilterRow label={t('directories.ai')} values={['all', 'active', 'problem', 'idle']} value={selectedAi} onChange={(value) => setSelectedAi(value as InstanceAiFilter)} />
    </View>
    <DirectoryListContent state={state} data={instances} keyOf={(instance) => instance.id} render={(instance) => (
      <DirectoryCard icon="instance" onPress={() => onOpen?.(instance)} title={instance.name} subtitle={instanceStateLabel(instance, t)}>
      <Text style={[styles.meta, { color: colors.textMuted }]}>{!nodeId ? `Node ${instance.nodeId} · ` : ''}{instance.runtime.name || instance.runtime.id}{instance.runtime.type ? ` · ${instance.runtime.type}` : ''}</Text>
      <Text style={[styles.meta, { color: colors.textMuted }]}>{instance.lastHeartbeatAt ? relativeObservedAt(instance.lastHeartbeatAt, t) : t('directories.heartbeatMissing')}</Text>
      {aiSessionSummary(instance.aiSessions, t) ? <Text style={[styles.meta, { color: colors.textMuted }]}>AI · {aiSessionSummary(instance.aiSessions, t)}</Text> : null}
      {!instance.protocol.compatible ? <Text style={[styles.warning, { color: colors.noticeText }]}>{instance.protocol.warning || t('directories.protocolWarning')}</Text> : null}
      {instance.error ? <Text style={[styles.error, { color: colors.error }]}>{instance.error.code}: {instance.error.message}</Text> : null}
    </DirectoryCard>
    )} />
  </View>;
}

function DirectoryList<T>({ state, data, keyOf, render }: { state: MobileDirectoryProfileState; data: readonly T[]; keyOf(item: T): string; render(item: T): React.ReactElement }) {
  const { colors } = useMobileTheme();
  return <View style={[styles.screen, { backgroundColor: colors.background }]}>
    <DirectoryListContent state={state} data={data} keyOf={keyOf} render={render} />
  </View>;
}

function DirectoryListContent<T>({ state, data, keyOf, render }: { state: MobileDirectoryProfileState; data: readonly T[]; keyOf(item: T): string; render(item: T): React.ReactElement }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <>
    {state.phase === 'stale' ? <Text style={[styles.notice, { backgroundColor: colors.notice, color: colors.noticeText }]}>{t('directories.cached')}</Text> : null}
    {state.phase === 'offline' ? <Text style={[styles.notice, { backgroundColor: colors.notice, color: colors.noticeText }]}>{t('directories.offlineCached')}</Text> : null}
    {state.error ? <Text style={[styles.error, { color: colors.error }]}>{state.error}</Text> : null}
    <ScreenFlatList contentContainerStyle={data.length ? styles.list : styles.empty} data={[...data]} keyExtractor={keyOf} ListEmptyComponent={<Text style={[styles.emptyText, { color: colors.textMuted }]}>{state.phase === 'loading' ? t('directories.loading') : t('directories.noEntries')}</Text>} renderItem={({ item }) => render(item)} />
  </>;
}

type InstanceAiFilter = 'all' | 'active' | 'problem' | 'idle';
export function filterInstances(instances: readonly ControlPlaneInstanceDirectoryEntry[], filters: { nodeId?: string; status?: string; ai?: InstanceAiFilter }) {
  return instances.filter((instance) => {
    if (filters.nodeId && filters.nodeId !== 'all' && instance.nodeId !== filters.nodeId) return false;
    if (filters.status && filters.status !== 'all' && instance.status !== filters.status) return false;
    const ai = filters.ai ?? 'all';
    if (ai === 'active' && instance.aiSessions.runningCount + instance.aiSessions.waitingCount === 0) return false;
    if (ai === 'problem' && instance.aiSessions.problemCount === 0) return false;
    if (ai === 'idle' && instance.aiSessions.runningCount + instance.aiSessions.waitingCount + instance.aiSessions.problemCount > 0) return false;
    return true;
  });
}

function FilterRow({ label, values, value, onChange }: { label: string; values: readonly string[]; value: string; onChange(value: string): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <View style={styles.filterRow}><Text style={[styles.filterLabel, { color: colors.textMuted }]}>{label}</Text><FlatList horizontal data={[...values]} keyExtractor={(item) => item} renderItem={({ item }) => (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: item === value }} onPress={() => onChange(item)} style={[styles.filter, { backgroundColor: colors.surfaceMuted }, item === value && { backgroundColor: colors.primarySoft }]}><Text style={[styles.filterText, { color: colors.text }]}>{filterValueLabel(item, t)}</Text></Pressable>
  )} showsHorizontalScrollIndicator={false} /></View>;
}

function filterValueLabel(value: string, t: ReturnType<typeof useI18n>['t']) {
  if (value === 'all') return t('sessions.filterAll');
  if (value === 'active') return t('sessions.filterActive');
  if (value === 'problem') return t('sessions.filterProblem');
  if (value === 'idle') return t('sessions.filterIdle');
  if (value === 'running') return t('status.running');
  if (value === 'failed') return t('status.failed');
  if (value === 'stopped') return t('status.stopped');
  return value;
}

function DirectoryCard({ title, subtitle, children, icon, onPress }: React.PropsWithChildren<{ title: string; subtitle: string; icon: 'node' | 'instance'; onPress(): void }>) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.cardPressed]}>
    <View style={styles.cardHeader}>
      <View style={[styles.cardIcon, { backgroundColor: colors.surfaceMuted }]}>
        <SystemIcon android={icon === 'node' ? 'dns' : 'deployed_code'} color={colors.textMuted} ios={icon === 'node' ? 'server.rack' : 'shippingbox'} size={20} />
      </View>
      <View style={styles.cardHeading}>
        <Text numberOfLines={1} style={[styles.cardTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>{subtitle}</Text>
      </View>
      <SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={14} />
    </View>
    <View style={styles.cardBody}>{children}</View>
  </Pressable>;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: '#f8fafc', flex: 1, paddingTop: 16 }, title: { color: '#0f172a', fontSize: 28, fontWeight: '700', paddingHorizontal: 16 },
  list: { gap: 10, padding: 16 }, empty: { alignItems: 'center', flexGrow: 1, justifyContent: 'center' }, emptyText: { color: '#64748b', fontSize: 14 },
  notice: { backgroundColor: '#fef3c7', color: '#854d0e', fontSize: 12, margin: 16, marginBottom: 0, padding: 9 },
  filters: { gap: 7, paddingHorizontal: 16, paddingTop: 10 }, filterRow: { alignItems: 'center', flexDirection: 'row', gap: 8 }, filterLabel: { color: '#475569', fontSize: 12, fontWeight: '700', width: 44 },
  filter: { backgroundColor: '#e2e8f0', borderRadius: 14, justifyContent: 'center', marginRight: 6, minHeight: 44, paddingHorizontal: 10, paddingVertical: 6 }, filterActive: { backgroundColor: '#bfdbfe' }, filterText: { color: '#334155', fontSize: 12, textTransform: 'capitalize' },
  card: { backgroundColor: '#fff', borderColor: '#e2e8f0', borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 10, padding: 14 }, cardPressed: { opacity: 0.72 },
  cardHeader: { alignItems: 'center', flexDirection: 'row', gap: 11 }, cardIcon: { alignItems: 'center', borderRadius: 10, height: 38, justifyContent: 'center', width: 38 }, cardHeading: { flex: 1, gap: 2 }, cardBody: { gap: 6, paddingLeft: 49 }, cardTitle: { color: '#0f172a', fontSize: 16, fontWeight: '700' },
  subtitle: { color: '#334155', fontSize: 13, textTransform: 'capitalize' }, meta: { color: '#64748b', fontSize: 12 }, warning: { color: '#92400e', fontSize: 12 }, error: { color: '#b91c1c', fontSize: 12 },
  nodeSummary: { alignItems: 'baseline', flexDirection: 'row', gap: 5 }, nodeCount: { fontSize: 14, fontWeight: '700' }, summaryDivider: { marginHorizontal: 3 },
  nodeStatusSummary: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, marginHorizontal: 16, minHeight: 42, paddingHorizontal: 12 },
  nodeStatusDot: { borderRadius: 999, height: 8, width: 8 }, nodeStatusText: { flex: 1, fontSize: 13, textTransform: 'capitalize' },
  sectionHeading: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 18 }, sectionTitle: { fontSize: 19, fontWeight: '700' }, sectionCount: { borderRadius: 999, fontSize: 12, fontWeight: '700', overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 3 },
});
