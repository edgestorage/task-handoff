import { router, useLocalSearchParams } from 'expo-router';

import { StorySessionAssignForm } from '../../../../src/stories/StorySessionAssignForm';

export default function StorySessionAssignRoute() {
  const { storyId, nodeId } = useLocalSearchParams<{ storyId: string; nodeId: string }>();
  return <StorySessionAssignForm nodeId={nodeId} onSaved={() => router.back()} storyId={storyId} />;
}
