import { useMemo, useState } from 'react';
import { DrawerContentScrollView, type DrawerContentComponentProps } from 'expo-router/drawer';
import { router } from 'expo-router';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useActiveDirectories } from '../directories/use-directories';
import { instanceStateLabel, nodeDisplayName, nodeStateLabel } from '../directories/presentation';
import { useI18n } from '../i18n';
import { useInstanceScope } from './use-instance-scope';

export function InstanceDrawerContent(props: DrawerContentComponentProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { controlPlaneOrigin, state } = useActiveDirectories();
  const { scope, setScope } = useInstanceScope();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const instancesByNode = useMemo(() => new Map(state.nodes.map((node) => [node.id, state.instances.filter((instance) => instance.nodeId === node.id)])), [state.instances, state.nodes]);
  const select = (instanceId?: string) => {
    setScope(instanceId ? { kind: 'instance', instanceId } : { kind: 'all' });
    props.navigation.closeDrawer();
  };
  return <View style={[styles.container, { backgroundColor: colors.surface }]}>
    <DrawerContentScrollView {...props} contentContainerStyle={styles.scrollContent}>
      <View style={styles.header}>
        <Image accessibilityIgnoresInvertColors source={require('../../assets/icon.png')} style={styles.brandIcon} />
        <View style={styles.brandCopy}>
          <Text style={[styles.product, { color: colors.text }]}>TaskHandoff</Text>
          <Text numberOfLines={1} style={[styles.controlPlane, { color: colors.textMuted }]}>{controlPlaneOrigin || t('nav.controlPlane')}</Text>
        </View>
      </View>
      <DrawerRow active={scope.kind === 'all'} count={state.instances.length} icon="all" label={t('scope.allInstances')} onPress={() => select()} />
      <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{t('nav.instances')}</Text>
      <View style={styles.nodeGroups}>
        {state.nodes.map((node) => {
          const instances = instancesByNode.get(node.id) ?? [];
          const isCollapsed = collapsed[node.id] === true;
          const connecting = node.connectionPhase === 'connecting' || node.connectionPhase === 'handshaking' || node.connectionPhase === 'reconnecting';
          const status = nodeStateLabel(node, t);
          return <View key={node.id}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: !isCollapsed }}
              onPress={() => setCollapsed((current) => ({ ...current, [node.id]: !isCollapsed }))}
              style={({ pressed }) => [styles.nodeRow, pressed && styles.pressed]}
            >
              <SystemIcon android="dns" color={colors.textMuted} ios="server.rack" size={16} />
              <View style={styles.nodeCopy}>
                <Text numberOfLines={1} style={[styles.nodeLabel, { color: colors.text }]}>{nodeDisplayName(node, t)}</Text>
                {status ? <View style={styles.nodeStatusRow}>
                  {connecting ? <ActivityIndicator color={colors.primary} size="small" /> : <View style={[styles.statusDot, { backgroundColor: node.health === 'ok' && node.status === 'online' ? colors.sessionActive : node.health === 'failed' ? colors.error : colors.textMuted }]} />}
                  <Text style={[styles.nodeStatus, { color: connecting ? colors.primary : colors.textMuted }]}>{status}</Text>
                </View> : null}
              </View>
              <Text style={[styles.count, { color: colors.textMuted }]}>{instances.length}</Text>
              <SystemIcon android={isCollapsed ? 'expand_more' : 'expand_less'} color={colors.textMuted} ios={isCollapsed ? 'chevron.down' : 'chevron.up'} size={12} />
            </Pressable>
            {!isCollapsed ? <View style={styles.instanceList}>{instances.map((instance) =>
              <DrawerRow
                active={scope.kind === 'instance' && scope.instanceId === instance.id}
                icon="instance"
                key={instance.id}
                label={instance.name}
                onPress={() => select(instance.id)}
                subtitle={instanceStateLabel(instance, t)}
              />
            )}</View> : null}
          </View>;
        })}
      </View>
      {!state.nodes.length && state.phase !== 'loading' ? <Text style={[styles.empty, { color: colors.textMuted }]}>{t('directories.noEntries')}</Text> : null}
    </DrawerContentScrollView>
    <View style={styles.footer}>
      <Pressable
        accessibilityLabel={t('nav.settings')}
        accessibilityRole="button"
        onPress={() => { props.navigation.closeDrawer(); router.push('/profiles'); }}
        style={({ pressed }) => [styles.settingsButton, { backgroundColor: colors.surfaceMuted }, pressed && styles.pressed]}
      >
        <SystemIcon android="settings" color={colors.text} ios="gearshape" size={23} />
      </Pressable>
    </View>
  </View>;
}

function DrawerRow({ active = false, count, icon, label, onPress, subtitle }: { active?: boolean; count?: number; icon: 'all' | 'instance' | 'settings'; label: string; onPress(): void; subtitle?: string }) {
  const { colors } = useMobileTheme();
  const icons = icon === 'all' ? { android: 'select_all' as const, ios: 'square.grid.2x2' as const } : icon === 'settings' ? { android: 'settings' as const, ios: 'gearshape' as const } : { android: 'deployed_code' as const, ios: 'shippingbox' as const };
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress} style={({ pressed }) => [styles.row, active && { backgroundColor: colors.surfaceMuted }, pressed && !active && styles.pressed]}>
    <SystemIcon android={icons.android} color={active ? colors.text : colors.textMuted} ios={icons.ios} size={18} />
    <View style={styles.rowCopy}>
      <Text numberOfLines={1} style={[styles.rowLabel, { color: colors.text }, active && styles.activeLabel]}>{label}</Text>
      {subtitle ? <Text numberOfLines={1} style={[styles.rowSubtitle, { color: colors.textMuted }]}>{subtitle}</Text> : null}
    </View>
    {count !== undefined ? <Text style={[styles.count, { color: colors.textMuted }]}>{count}</Text> : null}
  </Pressable>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingBottom: 24, paddingHorizontal: 20 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingBottom: 28, paddingHorizontal: 4, paddingTop: 16 },
  brandIcon: { borderRadius: 10, height: 42, width: 42 },
  brandCopy: { flex: 1, gap: 3, minWidth: 0 },
  product: { fontSize: 22, fontWeight: '700' },
  controlPlane: { fontSize: 12 },
  sectionLabel: { fontSize: 14, fontWeight: '600', paddingBottom: 12, paddingHorizontal: 8, paddingTop: 34 },
  nodeGroups: { gap: 20 },
  row: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 13, minHeight: 54, paddingHorizontal: 12, paddingVertical: 7 },
  rowCopy: { flex: 1, gap: 2, minWidth: 0 },
  rowLabel: { fontSize: 16 },
  rowSubtitle: { fontSize: 12 },
  activeLabel: { fontWeight: '600' },
  nodeRow: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 10, minHeight: 48, paddingHorizontal: 9, paddingVertical: 4 },
  nodeCopy: { flex: 1, gap: 2, minWidth: 0 },
  nodeLabel: { fontSize: 15, fontWeight: '600' },
  nodeStatusRow: { alignItems: 'center', flexDirection: 'row', gap: 5, minHeight: 16 },
  nodeStatus: { fontSize: 12 },
  statusDot: { borderRadius: 999, height: 6, width: 6 },
  count: { fontSize: 12, fontVariant: ['tabular-nums'], fontWeight: '500' },
  instanceList: { gap: 2, paddingTop: 4 },
  empty: { fontSize: 13, paddingHorizontal: 4, paddingVertical: 20 },
  pressed: { opacity: 0.58 },
  footer: { alignItems: 'flex-end', paddingBottom: 22, paddingHorizontal: 24, paddingTop: 10 },
  settingsButton: { alignItems: 'center', borderRadius: 27, height: 54, justifyContent: 'center', width: 54 },
});
