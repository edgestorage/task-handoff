import { router, useLocalSearchParams } from 'expo-router';
import { StoryDetail } from '../../src/stories/StoryDetail';

export default function StoryDetailRoute() {
  const { storyId, nodeId } = useLocalSearchParams<{ storyId: string; nodeId: string }>();
  return <StoryDetail storyId={storyId} nodeId={nodeId} onOpenSession={(instanceId, sessionId) => router.push({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId, sessionId } })} />;
}
