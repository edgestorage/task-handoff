import { router } from 'expo-router';
import { storyNodeIsVisible } from '@task-handoff/control-plane-client';
import { StoryEditor } from '../../src/stories/StoryEditor';
import { useActiveDirectories } from '../../src/directories/use-directories';
import { useStoryNodeFilter } from '../../src/stories/use-story-node-filter';

export default function NewStoryRoute() {
  const { state } = useActiveDirectories();
  const { filter } = useStoryNodeFilter();
  const preferredNode = state.nodes.find((node) => node.status === 'online' && storyNodeIsVisible(filter, node.id))
    ?? state.nodes.find((node) => node.status === 'online');
  return <StoryEditor nodeId={preferredNode?.id} onSaved={(story) => router.replace({ pathname: '/stories/[storyId]' as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })} />;
}
