import { useActiveDirectories } from '../directories/use-directories';
import { nodeDisplayName } from '../directories/presentation';
import { useI18n } from '../i18n';
import { ScopeHeaderButton } from '../instance-scope/ScopeHeaderButton';
import { useOpenInstanceDrawer } from '../instance-scope/use-open-instance-drawer';
import { useStoryNodeFilter } from './use-story-node-filter';

export function StoryNodeFilterHeaderButton({ onPress }: { onPress?(): void } = {}) {
  const { t } = useI18n();
  const { state } = useActiveDirectories();
  const { filter } = useStoryNodeFilter();
  const openDrawer = useOpenInstanceDrawer();
  const handlePress = onPress ?? openDrawer;
  const selectedNode = filter.kind === 'selected' ? state.nodes.find((node) => node.id === filter.nodeIds[0]) : undefined;
  const label = filter.kind === 'all'
    ? t('directories.allNodes')
    : filter.nodeIds.length > 1
      ? t('controlPlane.selectedNodes', { count: filter.nodeIds.length })
      : selectedNode ? nodeDisplayName(selectedNode, t) : filter.nodeIds[0] || t('directories.allNodes');
  return <ScopeHeaderButton syncTopic="stories" icon="server-outline" label={label} onPress={handlePress} />;
}
