import { Pressable, StyleSheet, Text } from 'react-native';

import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useActiveDirectories } from '../directories/use-directories';
import { nodeDisplayName } from '../directories/presentation';
import { useI18n } from '../i18n';
import { useOpenInstanceDrawer } from '../instance-scope/use-open-instance-drawer';
import { useStoryNodeFilter } from './use-story-node-filter';

export function StoryNodeFilterHeaderButton() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { state } = useActiveDirectories();
  const { filter } = useStoryNodeFilter();
  const openDrawer = useOpenInstanceDrawer();
  const selectedNode = filter.kind === 'selected' ? state.nodes.find((node) => node.id === filter.nodeIds[0]) : undefined;
  const label = filter.kind === 'all'
    ? t('directories.allNodes')
    : filter.nodeIds.length > 1
      ? t('controlPlane.selectedNodes', { count: filter.nodeIds.length })
      : selectedNode ? nodeDisplayName(selectedNode, t) : filter.nodeIds[0] || t('directories.allNodes');
  return <Pressable accessibilityRole="button" onPress={openDrawer} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
    <SystemIcon android="dns" color={colors.primary} ios="server.rack" size={17} />
    <Text numberOfLines={1} style={[styles.label, { color: colors.primary }]}>{label}</Text>
    <SystemIcon android="expand_more" color={colors.primary} ios="chevron.down" size={10} />
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', flexDirection: 'row', gap: 6, maxWidth: 166, minHeight: 34, paddingHorizontal: 6 },
  label: { flexShrink: 1, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.55 },
});
