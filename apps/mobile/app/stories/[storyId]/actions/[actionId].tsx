import { router, useLocalSearchParams } from 'expo-router';
import { StoryActionForm } from '../../../../src/stories/StoryActionForm';

export default function StoryActionRoute() {
  const { storyId, actionId, nodeId } = useLocalSearchParams<{ storyId: string; actionId: string; nodeId?: string }>();
  return <StoryActionForm storyId={storyId} actionId={actionId} nodeId={nodeId} onCreated={(instanceId, message) => router.push({ pathname: '/sessions/new', params: { instanceId, storyId, message } })} />;
}
