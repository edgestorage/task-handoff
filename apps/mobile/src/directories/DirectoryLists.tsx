import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { AnchoredSelectMenu, type AnchoredSelectOption } from '../components/AnchoredSelectMenu';
import type { MobileDirectoryProfileState } from './store';
import { useMobileTheme } from '../components/theme';
import { Icon, type IconName } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { ScreenFlatList } from '../components/ScreenFlatList';
import { usePullToRefresh } from '../components/use-pull-to-refresh';
import { connectionModeLabel } from '../control-plane/connection-presentation';
import { aiSessionSummary, instanceStateLabel, nodeDisplayName, nodeStateLabel, nodeSummary, relativeObservedAt } from './presentation';
import { useI18n, type Translate } from '../i18n';

export function NodesDirectory({ state, onOpen }: { state: MobileDirectoryProfileState; onOpen?(node: ControlPlaneNodeDirectoryEntry): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <View style={[styles.screen, { backgroundColor: colors.background }]}><DirectoryList emptyIcon="server-outline" state={state} data={state.nodes} keyOf={(node) => node.id} render={(node) => {
    const fleetState = state.nodeStates.find((entry) => entry.nodeId === node.id && entry.resource === 'instances');
    return (
    <DirectoryCard icon="node" onPress={() => onOpen?.(node)} title={nodeDisplayName(node, t)} subtitle={connectionModeLabel(node.connectionMode, t)}>
      <View style={styles.nodeSummary}>
        <Text style={[styles.meta, { color: colors.textMuted }]}>{nodeSummary(state.instances.filter((instance) => instance.nodeId === node.id).length, node, t)}</Text>
      </View>
      {node.status === 'online' && node.health === 'ok' ? null : <Text style={[styles.meta, { color: colors.textMuted }]}>{relativeObservedAt(node.lastSeenAt || node.observedAt, t)}</Text>}
      {node.error ? <Text style={[styles.error, { color: colors.error }]}>{node.error.code}: {node.error.message}</Text> : null}
      {fleetState?.phase === 'loading' || fleetState?.phase === 'uninitialized' ? <Text style={[styles.meta, { color: colors.textMuted }]}>{t('directories.loading')}</Text> : null}
      {fleetState?.error ? <Text style={[styles.error, { color: colors.error }]}>{fleetState.error.message}</Text> : null}
    </DirectoryCard>
    );
  }} /></View>;
}

export function InstancesDirectory({ state, nodeId, onOpen, onRefresh }: { state: MobileDirectoryProfileState; nodeId?: string; onOpen?(instance: ControlPlaneInstanceDirectoryEntry): void; onRefresh?: () => Promise<void> }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [selectedNode, setSelectedNode] = useState(nodeId || 'all');
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [selectedAi, setSelectedAi] = useState<InstanceAiFilter>('all');
  const pullToRefresh = usePullToRefresh(onRefresh);
  const nodes = useMemo(() => [...new Set(state.instances.map((instance) => instance.nodeId))].sort(), [state.instances]);
  const statuses = useMemo(() => [...new Set(state.instances.map((instance) => instance.status))].sort(), [state.instances]);
  const instances = filterInstances(state.instances, {
    nodeId: nodeId || selectedNode,
    status: selectedStatus,
    ai: selectedAi,
  });
  const node = nodeId ? state.nodes.find((candidate) => candidate.id === nodeId) : undefined;
  const nodeOptions = useMemo<AnchoredSelectOption[]>(() => ['all', ...nodes].map((value) => ({
    label: value === 'all' ? t('directories.allNodes') : nodeLabel(state, value, t),
    systemImage: 'server.rack' as const,
    value,
  })), [nodes, state, t]);
  const statusOptions = useMemo<AnchoredSelectOption[]>(() => ['all', ...statuses].map((value) => ({ label: filterValueLabel(value, t), value })), [statuses, t]);
  const aiOptions = useMemo<AnchoredSelectOption[]>(() => (['all', 'active', 'problem', 'idle'] as const).map((value) => ({ label: filterValueLabel(value, t), systemImage: 'sparkles' as const, value })), [t]);
  return <View style={[styles.screen, { backgroundColor: colors.background }]}>
    {nodeId ? (
      <View style={[styles.nodeStatusSummary, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
        <View style={[styles.nodeStatusDot, { backgroundColor: node?.health === 'ok' ? '#34c759' : colors.textMuted }]} />
        <Text numberOfLines={1} style={[styles.nodeStatusText, { color: colors.textMuted }]}>{node ? `${nodeStateLabel(node, t)} · ${connectionModeLabel(node.connectionMode, t)}` : t('directories.nodeUnavailable')}</Text>
      </View>
    ) : null}
    {nodeId ? <View style={styles.sectionHeading}><Text style={[styles.sectionTitle, { color: colors.text }]}>{t('directories.instances')}</Text><Text style={[styles.sectionCount, { backgroundColor: colors.surfaceMuted, color: colors.textMuted }]}>{instances.length}</Text></View> : null}
    <View accessibilityRole="toolbar" style={styles.filterBar}>
      <ScrollView contentContainerStyle={styles.filterBarContent} horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}>
        {!nodeId && nodes.length > 1 ? <FilterPill label={t('nav.node')} onChange={setSelectedNode} options={nodeOptions} title={t('nav.node')} value={selectedNode} /> : null}
        {statuses.length > 1 ? <FilterPill label={t('directories.status')} onChange={setSelectedStatus} options={statusOptions} title={t('directories.status')} value={selectedStatus} /> : null}
        <FilterPill label={t('directories.ai')} onChange={(value) => setSelectedAi(value as InstanceAiFilter)} options={aiOptions} title={t('directories.ai')} value={selectedAi} />
      </ScrollView>
    </View>
    <DirectoryListContent emptyIcon="layers-outline" state={state} data={instances} keyOf={(instance) => instance.id} onRefresh={pullToRefresh.onRefresh} refreshing={pullToRefresh.refreshing} render={(instance) => (
      <DirectoryCard icon="instance" onPress={() => onOpen?.(instance)} title={instance.name} subtitle={instanceStateLabel(instance, t)}>
      <Text style={[styles.meta, { color: colors.textMuted }]}>{!nodeId ? `${nodeLabel(state, instance.nodeId, t)} · ` : ''}{runtimeSummary(instance)}</Text>
      <Text style={[styles.meta, { color: colors.textMuted }]}>{instance.lastHeartbeatAt ? relativeObservedAt(instance.lastHeartbeatAt, t) : t('directories.heartbeatMissing')}</Text>
      {aiSessionSummary(instance.aiSessions, t) ? <Text style={[styles.meta, { color: colors.textMuted }]}>AI · {aiSessionSummary(instance.aiSessions, t)}</Text> : null}
      {!instance.protocol.compatible ? <Text style={[styles.warning, { color: colors.noticeText }]}>{instance.protocol.warning || t('directories.protocolWarning')}</Text> : null}
      {instance.error ? <Text style={[styles.error, { color: colors.error }]}>{instance.error.code}: {instance.error.message}</Text> : null}
    </DirectoryCard>
    )} />
  </View>;
}

type DirectoryEmptyIcon = IconName;

function DirectoryList<T>({ state, data, emptyIcon, keyOf, render }: { state: MobileDirectoryProfileState; data: readonly T[]; emptyIcon: DirectoryEmptyIcon; keyOf(item: T): string; render(item: T): React.ReactElement }) {
  const { colors } = useMobileTheme();
  return <View style={[styles.screen, { backgroundColor: colors.background }]}>
    <DirectoryListContent emptyIcon={emptyIcon} state={state} data={data} keyOf={keyOf} render={render} />
  </View>;
}

function DirectoryListContent<T>({ state, data, emptyIcon, keyOf, onRefresh, refreshing, render }: { state: MobileDirectoryProfileState; data: readonly T[]; emptyIcon: DirectoryEmptyIcon; keyOf(item: T): string; onRefresh?: () => void; refreshing?: boolean; render(item: T): React.ReactElement }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <>
    {state.phase === 'stale' ? <DirectoryBanner text={t('directories.cached')} /> : null}
    {state.phase === 'offline' ? <DirectoryBanner text={t('directories.offlineCached')} /> : null}
    {state.error ? <DirectoryBanner error text={state.error} /> : null}
    <ScreenFlatList contentContainerStyle={data.length ? styles.list : styles.empty} data={[...data]} keyExtractor={keyOf} ListEmptyComponent={state.phase === 'loading'
      ? <Text style={[styles.loadingText, { color: colors.textMuted }]}>{t('directories.loading')}</Text>
      : <EmptyState icon={emptyIcon} message={t('directories.noEntries')} />}
      onRefresh={onRefresh} refreshing={refreshing} renderItem={({ item }) => render(item)} />
  </>;
}

function DirectoryBanner({ error, text }: { error?: boolean; text: string }) {
  const { colors } = useMobileTheme();
  return <View style={[styles.banner, { backgroundColor: error ? colors.errorSoft : colors.notice }]}>
    <Icon color={error ? colors.error : colors.noticeText} name={error ? 'alert-circle' : 'warning'} size={17} />
    <Text style={[styles.bannerText, { color: error ? colors.error : colors.noticeText }]}>{text}</Text>
  </View>;
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

/**
 * Filters open an iOS-style menu instead of a row of chips: long node names stay readable,
 * the collapsed bar keeps a single compact line, and Android mirrors the iOS picker flow.
 */
function FilterPill({ label, onChange, options, title, value }: { label: string; onChange(value: string): void; options: readonly AnchoredSelectOption[]; title: string; value: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const active = value !== 'all';
  const selected = options.find((option) => option.value === value);
  const valueLabel = selected?.label ?? value;
  return <AnchoredSelectMenu cancelLabel={t('common.cancel')} onSelect={onChange} options={[...options]} selectedValue={value} title={title}>
    {(onPress) => <Pressable accessibilityLabel={`${label}: ${valueLabel}`} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.filterPill, { backgroundColor: active ? colors.primarySoft : colors.surface, borderColor: active ? colors.primary : colors.border }, pressed && styles.pressed]}>
      <Text style={[styles.filterPillLabel, { color: active ? colors.primary : colors.textMuted }]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.filterPillValue, { color: active ? colors.primary : colors.text }]}>{valueLabel}</Text>
      <Icon color={active ? colors.primary : colors.textMuted} name="chevron-down" size={11} />
    </Pressable>}
  </AnchoredSelectMenu>;
}

function nodeLabel(state: MobileDirectoryProfileState, nodeId: string, t: Translate) {
  const node = state.nodes.find((candidate) => candidate.id === nodeId);
  return node ? nodeDisplayName(node, t) : nodeId;
}

/** Keeps the runtime line short: "Local Docker" already carries its type, so it is not repeated. */
function runtimeSummary(instance: ControlPlaneInstanceDirectoryEntry) {
  const name = instance.runtime.name || instance.runtime.id;
  const type = instance.runtime.type;
  if (!type || name.toLocaleLowerCase().includes(type.toLocaleLowerCase())) return name;
  return `${name} · ${type.charAt(0).toUpperCase()}${type.slice(1)} runtime`;
}

function filterValueLabel(value: string, t: Translate) {
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
        <Icon color={colors.textMuted} name={icon === 'node' ? 'server-outline' : 'layers-outline'} size={20} />
      </View>
      <View style={styles.cardHeading}>
        <Text numberOfLines={1} style={[styles.cardTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>{subtitle}</Text>
      </View>
      <Icon color={colors.textMuted} name="chevron-forward" size={14} />
    </View>
    <View style={styles.cardBody}>{children}</View>
  </Pressable>;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: '#f8fafc', flex: 1 },
  list: { gap: 10, padding: 16 }, empty: { alignItems: 'center', flexGrow: 1, justifyContent: 'center' }, loadingText: { fontSize: 14 },
  banner: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 9, marginHorizontal: 16, marginTop: 12, padding: 12 }, bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  filterBar: { flexGrow: 0 }, filterBarContent: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingBottom: 4, paddingHorizontal: 16, paddingTop: 12 },
  filterPill: { alignItems: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 6, maxWidth: 260, minHeight: 38, paddingHorizontal: 11 },
  filterPillLabel: { fontSize: 12, fontWeight: '700' }, filterPillValue: { flexShrink: 1, fontSize: 14, fontWeight: '600' }, pressed: { opacity: 0.72 },
  card: { backgroundColor: '#fff', borderColor: '#e2e8f0', borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 10, padding: 14 }, cardPressed: { opacity: 0.72 },
  cardHeader: { alignItems: 'center', flexDirection: 'row', gap: 11 }, cardIcon: { alignItems: 'center', borderRadius: 10, height: 38, justifyContent: 'center', width: 38 }, cardHeading: { flex: 1, gap: 2 }, cardBody: { gap: 6, paddingLeft: 49 }, cardTitle: { color: '#0f172a', fontSize: 16, fontWeight: '700' },
  subtitle: { color: '#334155', fontSize: 13, textTransform: 'capitalize' }, meta: { color: '#64748b', fontSize: 12 }, warning: { color: '#92400e', fontSize: 12 }, error: { color: '#b91c1c', fontSize: 12 },
  nodeSummary: { alignItems: 'baseline', flexDirection: 'row', gap: 5 }, nodeCount: { fontSize: 14, fontWeight: '700' }, summaryDivider: { marginHorizontal: 3 },
  nodeStatusSummary: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, marginHorizontal: 16, marginTop: 12, minHeight: 42, paddingHorizontal: 12 },
  nodeStatusDot: { borderRadius: 999, height: 8, width: 8 }, nodeStatusText: { flex: 1, fontSize: 13, textTransform: 'capitalize' },
  sectionHeading: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 16 }, sectionTitle: { fontSize: 19, fontWeight: '700' }, sectionCount: { borderRadius: 999, fontSize: 12, fontWeight: '700', overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 3 },
});
