import { router, useLocalSearchParams } from 'expo-router';
import { StoryEditor } from '../../../src/stories/StoryEditor';

export default function EditStoryRoute() {
  const { storyId, nodeId } = useLocalSearchParams<{ storyId: string; nodeId: string }>();
  return <StoryEditor storyId={storyId} nodeId={nodeId} onSaved={(story) => router.replace({ pathname: '/stories/[storyId]' as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })} />;
}
