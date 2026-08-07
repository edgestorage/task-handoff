import { useMemo, useState } from 'react';
import { DrawerContentScrollView, type DrawerContentComponentProps } from 'expo-router/drawer';
import { router } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useActiveDirectories } from '../directories/use-directories';
import { nodeDisplayName } from '../directories/presentation';
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
  return <View style={[styles.container, { backgroundColor: colors.background }]}>
    <DrawerContentScrollView {...props} contentContainerStyle={styles.scrollContent}>
      <View style={styles.header}>
        <Image accessibilityIgnoresInvertColors source={require('../../assets/icon.png')} style={styles.brandIcon} />
        <View style={styles.brandCopy}>
          <Text style={[styles.product, { color: colors.text }]}>TaskHandoff</Text>
          <Text numberOfLines={1} style={[styles.controlPlane, { color: colors.textMuted }]}>{controlPlaneOrigin || t('nav.controlPlane')}</Text>
        </View>
      </View>
      <DrawerRow active={scope.kind === 'all'} icon="all" label={t('scope.allInstances')} onPress={() => select()} />
      <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{t('nav.instances')}</Text>
      {state.nodes.map((node) => {
        const instances = instancesByNode.get(node.id) ?? [];
        const isCollapsed = collapsed[node.id] === true;
        return <View key={node.id}>
          <Pressable onPress={() => setCollapsed((current) => ({ ...current, [node.id]: !isCollapsed }))} style={({ pressed }) => [styles.nodeRow, pressed && styles.pressed]}>
            <SystemIcon android="dns" color={colors.textMuted} ios="server.rack" size={17} />
            <Text numberOfLines={1} style={[styles.nodeLabel, { color: colors.text }]}>{nodeDisplayName(node, t)}</Text>
            <Text style={[styles.count, { color: colors.textMuted }]}>{instances.length}</Text>
            <SystemIcon android={isCollapsed ? 'expand_more' : 'expand_less'} color={colors.textMuted} ios={isCollapsed ? 'chevron.down' : 'chevron.up'} size={12} />
          </Pressable>
          {!isCollapsed ? instances.map((instance) => <DrawerRow active={scope.kind === 'instance' && scope.instanceId === instance.id} icon="instance" indent key={instance.id} label={instance.name} onPress={() => select(instance.id)} />) : null}
        </View>;
      })}
      {!state.nodes.length && state.phase !== 'loading' ? <Text style={[styles.empty, { color: colors.textMuted }]}>{t('directories.noEntries')}</Text> : null}
    </DrawerContentScrollView>
    <View style={[styles.footer, { borderTopColor: colors.border }]}>
      <DrawerRow alignEnd icon="settings" label={t('nav.settings')} onPress={() => { props.navigation.closeDrawer(); router.push('/profiles'); }} />
    </View>
  </View>;
}

function DrawerRow({ active = false, alignEnd = false, icon, indent = false, label, onPress }: { active?: boolean; alignEnd?: boolean; icon: 'all' | 'instance' | 'settings'; indent?: boolean; label: string; onPress(): void }) {
  const { colors } = useMobileTheme();
  const icons = icon === 'all' ? { android: 'select_all' as const, ios: 'square.grid.2x2' as const } : icon === 'settings' ? { android: 'settings' as const, ios: 'gearshape' as const } : { android: 'deployed_code' as const, ios: 'shippingbox' as const };
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress} style={({ pressed }) => [styles.row, alignEnd && styles.rowEnd, indent && styles.indent, active && { backgroundColor: colors.primarySoft }, pressed && styles.pressed]}>
    <SystemIcon android={icons.android} color={active ? colors.primary : colors.textMuted} ios={icons.ios} size={18} />
    <Text numberOfLines={1} style={[styles.rowLabel, alignEnd && styles.rowLabelEnd, { color: active ? colors.primary : colors.text }, active && styles.activeLabel]}>{label}</Text>
    {active ? <SystemIcon android="check" color={colors.primary} ios="checkmark" size={14} /> : null}
  </Pressable>;
}

const styles = StyleSheet.create({
  container: { flex: 1 }, scrollContent: { paddingBottom: 16 }, header: { alignItems: 'center', flexDirection: 'row', gap: 11, paddingBottom: 18, paddingHorizontal: 10, paddingTop: 8 }, brandIcon: { borderRadius: 9, height: 40, width: 40 }, brandCopy: { flex: 1, gap: 2, minWidth: 0 }, product: { fontSize: 25, fontWeight: '700' }, controlPlane: { fontSize: 12 }, sectionLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, paddingHorizontal: 22, paddingBottom: 6, paddingTop: 18, textTransform: 'uppercase' }, row: { alignItems: 'center', borderRadius: 11, flexDirection: 'row', gap: 11, marginHorizontal: 10, minHeight: 46, paddingHorizontal: 12 }, rowEnd: { justifyContent: 'flex-end' }, indent: { marginLeft: 28 }, rowLabel: { flex: 1, fontSize: 15 }, rowLabelEnd: { flex: 0 }, activeLabel: { fontWeight: '600' }, nodeRow: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 44, paddingHorizontal: 22 }, nodeLabel: { flex: 1, fontSize: 14, fontWeight: '600' }, count: { fontSize: 12 }, empty: { fontSize: 13, padding: 20 }, pressed: { opacity: 0.58 }, footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingBottom: 18, paddingTop: 8 },
});
