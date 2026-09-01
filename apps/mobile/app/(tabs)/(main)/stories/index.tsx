import { router } from 'expo-router';
import { StoryInbox } from '../../../../src/stories/StoryInbox';

export default function StoriesRoute() {
  return <StoryInbox onOpen={(story) => router.push({ pathname: '/stories/[storyId]' as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })} />;
}
