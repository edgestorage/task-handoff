import { router } from 'expo-router';
import { StoryEditor } from '../../src/stories/StoryEditor';

export default function NewStoryRoute() {
  return <StoryEditor onSaved={(story) => router.replace({ pathname: '/stories/[storyId]' as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })} />;
}
