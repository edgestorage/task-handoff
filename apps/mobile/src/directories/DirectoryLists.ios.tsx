import { useMemo, useState } from 'react';
import {
  Button,
  HStack,
  Host,
  Image,
  List,
  Picker,
  Section,
  Spacer,
  Text,
  VStack,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listStyle,
  pickerStyle,
  tag,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';
import { StyleSheet, Text as NativeText } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileTheme } from '../components/theme';
import {
  aiSessionSummary,
  connectionModeLabel,
  instanceStateLabel,
  nodeDisplayName,
  nodeStateLabel,
  nodeSummary,
  relativeObservedAt,
} from './presentation';
import type { MobileDirectoryProfileState } from './store';
import { useI18n, type Translate } from '../i18n';

type NodesDirectoryProps = {
  state: MobileDirectoryProfileState;
  onOpen?(node: ControlPlaneNodeDirectoryEntry): void;
};

export function NodesDirectory({ state, onOpen }: NodesDirectoryProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const instancesByNode = useMemo(() => groupInstancesByNode(state.instances), [state.instances]);

  return (
    <SafeAreaView edges={['top']} style={[styles.screen, { backgroundColor: colors.background }]}> 
      <NativeText accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('nav.nodes')}</NativeText>
      <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ flex: 1 }} useViewportSizeMeasurement>
        <List modifiers={[listStyle('insetGrouped'), tint(colors.primary)]}>
        <DirectoryStateSections state={state} />
        {!state.nodes.length ? <EmptySection loading={state.phase === 'loading'} /> : null}
        {state.nodes.map((node) => {
          const instances = instancesByNode.get(node.id) ?? [];
          return (
            <Section
              key={node.id}
              footer={node.error ? <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.error)]}>{node.error.code}: {node.error.message}</Text> : undefined}
            >
              <Button
                modifiers={[buttonStyle('plain'), frame({ maxWidth: Infinity, alignment: 'leading' }), accessibilityLabel(t('directories.open', { name: node.name }))]}
                onPress={() => onOpen?.(node)}
              >
                <HStack alignment="center" spacing={12}>
                  <Image color={colors.primary} size={21} systemName="server.rack" />
                  <VStack alignment="leading" spacing={2}>
                    <HStack spacing={6}>
                      <Text modifiers={[font({ textStyle: 'body', weight: 'semibold' }), lineLimit(1)]}>{nodeDisplayName(node, t)}</Text>
                      <Image color={nodeStatusColor(node, colors.textMuted)} size={7} systemName="circle.fill" />
                    </HStack>
                    <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' }), lineLimit(1)]}>
                      {nodeConnectionSummary(node, t)}
                    </Text>
                  </VStack>
                  <Spacer />
                  <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>{nodeSummary(instances.length, node, t)}</Text>
                  <Image color={colors.textMuted} size={12} systemName="chevron.right" />
                </HStack>
              </Button>
              {instances.map((instance) => <InstanceSummaryRow instance={instance} key={instance.id} />)}
              {!instances.length ? (
                <Text modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>{t('directories.noInstancesOnNode')}</Text>
              ) : null}
            </Section>
          );
        })}
        </List>
      </Host>
    </SafeAreaView>
  );
}

type InstancesDirectoryProps = {
  state: MobileDirectoryProfileState;
  nodeId?: string;
  onOpen?(instance: ControlPlaneInstanceDirectoryEntry): void;
};

export function InstancesDirectory({ state, nodeId, onOpen }: InstancesDirectoryProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const [selectedNode, setSelectedNode] = useState(nodeId || 'all');
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [selectedAi, setSelectedAi] = useState<InstanceAiFilter>('all');
  const nodeIds = useMemo(() => [...new Set(state.instances.map((instance) => instance.nodeId))].sort(), [state.instances]);
  const statuses = useMemo(() => [...new Set(state.instances.map((instance) => instance.status))].sort(), [state.instances]);
  const instances = filterInstances(state.instances, {
    nodeId: nodeId || selectedNode,
    status: selectedStatus,
    ai: selectedAi,
  });
  const instancesByNode = groupInstancesByNode(instances);
  const visibleNodeIds = nodeId ? [nodeId] : [...instancesByNode.keys()].sort((left, right) => nodeLabel(state, left).localeCompare(nodeLabel(state, right)));
  const node = nodeId ? state.nodes.find((candidate) => candidate.id === nodeId) : undefined;

  return (
    <SafeAreaView edges={nodeId ? [] : ['top']} style={[styles.screen, { backgroundColor: colors.background }]}> 
      <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ flex: 1 }} useViewportSizeMeasurement>
        <List modifiers={[listStyle('insetGrouped'), tint(colors.primary)]}>
        <DirectoryStateSections state={state} />
        {nodeId ? (
          <Section title={t('directories.status')}>
            <HStack alignment="center" spacing={8}>
              <Image color={node?.health === 'ok' ? '#34c759' : colors.textMuted} size={8} systemName="circle.fill" />
              <Text modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
                {node ? `${nodeStateLabel(node, t)} · ${connectionModeLabel(node.connectionMode, t)}` : t('directories.nodeUnavailable')}
              </Text>
            </HStack>
          </Section>
        ) : null}
        <Section title={t('directories.filters')}>
          {!nodeId && nodeIds.length > 1 ? (
            <NativeFilter label={t('nav.node')} onChange={setSelectedNode} value={selectedNode} values={['all', ...nodeIds]} labelFor={(value) => value === 'all' ? t('directories.allNodes') : nodeLabel(state, value)} />
          ) : null}
          {statuses.length > 1 ? <NativeFilter label={t('directories.status')} labelFor={(value) => localizedFilterValue(value, t)} onChange={setSelectedStatus} value={selectedStatus} values={['all', ...statuses]} /> : null}
          <NativeFilter label={t('directories.aiActivity')} labelFor={(value) => localizedFilterValue(value, t)} onChange={(value) => setSelectedAi(value as InstanceAiFilter)} value={selectedAi} values={['all', 'active', 'problem', 'idle']} />
        </Section>
        {!instances.length ? <EmptySection loading={state.phase === 'loading'} /> : null}
        {visibleNodeIds.map((visibleNodeId) => (
          <Section key={visibleNodeId} title={nodeId ? `${t('directories.instances')} (${instances.length})` : nodeLabel(state, visibleNodeId)}>
            {(instancesByNode.get(visibleNodeId) ?? []).map((instance) => (
              <InstanceButton instance={instance} key={instance.id} onPress={() => onOpen?.(instance)} />
            ))}
          </Section>
        ))}
        </List>
      </Host>
    </SafeAreaView>
  );
}

function InstanceButton({ instance, onPress }: { instance: ControlPlaneInstanceDirectoryEntry; onPress(): void }) {
  const { t } = useI18n();
  return (
    <Button modifiers={[buttonStyle('plain'), frame({ maxWidth: Infinity, alignment: 'leading' }), accessibilityLabel(t('directories.open', { name: instance.name }))]} onPress={onPress}>
      <HStack alignment="center" spacing={12}>
        <InstanceIdentity instance={instance} />
        <Spacer />
        <Image size={12} systemName="chevron.right" />
      </HStack>
    </Button>
  );
}

function InstanceSummaryRow({ instance }: { instance: ControlPlaneInstanceDirectoryEntry }) {
  const { t } = useI18n();
  const activity = aiSessionSummary(instance.aiSessions, t);
  return (
    <HStack alignment="center" spacing={12}>
      <InstanceIdentity instance={instance} />
      <Spacer />
      {activity ? <Text modifiers={[font({ textStyle: 'caption', weight: 'medium' }), foregroundStyle(instance.aiSessions.problemCount ? '#ff3b30' : instance.aiSessions.waitingCount ? '#9a6700' : '#007aff')]}>{activity}</Text> : null}
    </HStack>
  );
}

function InstanceIdentity({ instance }: { instance: ControlPlaneInstanceDirectoryEntry }) {
  const { t } = useI18n();
  return (
    <HStack alignment="center" spacing={10}>
      <Image size={19} systemName="shippingbox" />
      <VStack alignment="leading" spacing={3}>
        <Text modifiers={[font({ textStyle: 'body', weight: 'medium' }), lineLimit(1)]}>{instance.name}</Text>
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' }), lineLimit(1)]}>{instanceStateLabel(instance, t)} · {runtimeLabel(instance)}</Text>
        {!instance.protocol.compatible ? <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle('#9a6700')]}>{instance.protocol.warning || t('directories.protocolWarning')}</Text> : null}
        {instance.error ? <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle('#c9342f')]}>{instance.error.code}: {instance.error.message}</Text> : null}
      </VStack>
    </HStack>
  );
}

function NativeFilter({ label, labelFor = capitalize, onChange, value, values }: { label: string; labelFor?(value: string): string; onChange(value: string): void; value: string; values: readonly string[] }) {
  return (
    <Picker label={label} modifiers={[pickerStyle('menu')]} onSelectionChange={onChange} selection={value}>
      {values.map((option) => <Text key={option} modifiers={[tag(option)]}>{labelFor(option)}</Text>)}
    </Picker>
  );
}

function DirectoryStateSections({ state }: { state: MobileDirectoryProfileState }) {
  const { t } = useI18n();
  const message = state.phase === 'stale'
    ? t('directories.cached')
    : state.phase === 'offline'
      ? t('directories.offlineCached')
      : undefined;
  return (
    <>
      {message ? <Section><Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('#9a6700')]}>{message}</Text></Section> : null}
      {state.error ? <Section><Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('#c9342f')]}>{state.error}</Text></Section> : null}
    </>
  );
}

function EmptySection({ loading }: { loading: boolean }) {
  const { t } = useI18n();
  return <Section><Text modifiers={[font({ textStyle: 'body' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>{loading ? t('directories.loading') : t('directories.noEntries')}</Text></Section>;
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

function groupInstancesByNode(instances: readonly ControlPlaneInstanceDirectoryEntry[]) {
  const grouped = new Map<string, ControlPlaneInstanceDirectoryEntry[]>();
  for (const instance of instances) {
    const group = grouped.get(instance.nodeId) ?? [];
    group.push(instance);
    grouped.set(instance.nodeId, group);
  }
  for (const group of grouped.values()) group.sort((left, right) => left.name.localeCompare(right.name));
  return grouped;
}

function nodeLabel(state: MobileDirectoryProfileState, nodeId: string) {
  return state.nodes.find((node) => node.id === nodeId)?.name || nodeId;
}

function capitalize(value: string) {
  return value === 'all' ? 'All' : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function localizedFilterValue(value: string, t: Translate) {
  if (value === 'all') return t('sessions.filterAll');
  if (value === 'active') return t('sessions.filterActive');
  if (value === 'problem') return t('sessions.filterProblem');
  if (value === 'idle') return t('sessions.filterIdle');
  if (value === 'running') return t('status.running');
  if (value === 'failed') return t('status.failed');
  if (value === 'stopped') return t('status.stopped');
  return capitalize(value);
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  title: { fontSize: 34, fontWeight: '700', letterSpacing: -0.8, lineHeight: 41, paddingHorizontal: 16, paddingTop: 16 },
});

function nodeConnectionSummary(node: ControlPlaneNodeDirectoryEntry, t: Translate) {
  const connection = connectionModeLabel(node.connectionMode, t);
  return node.status === 'online' && node.health === 'ok'
    ? connection
    : `${connection} · ${relativeObservedAt(node.lastSeenAt || node.observedAt, t)}`;
}

function nodeStatusColor(node: ControlPlaneNodeDirectoryEntry, fallback: string) {
  if (node.status === 'online' && node.health === 'ok') return '#34c759';
  if (node.status === 'degraded' || node.health === 'degraded') return '#ff9f0a';
  if (node.status === 'offline' || node.health === 'failed') return '#ff3b30';
  return fallback;
}

function runtimeLabel(instance: ControlPlaneInstanceDirectoryEntry) {
  const name = instance.runtime.name || instance.runtime.id;
  const type = instance.runtime.type ? `${capitalize(instance.runtime.type)} runtime` : undefined;
  return type && name.toLocaleLowerCase() !== type.toLocaleLowerCase() ? `${name} · ${type}` : name;
}
