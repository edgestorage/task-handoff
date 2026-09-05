import { router, useLocalSearchParams } from 'expo-router';

import { StoryAutomationForm } from '../../../../src/stories/StoryAutomationForm';

export default function NewStoryAutomationRoute() {
  const { storyId, nodeId } = useLocalSearchParams<{ storyId: string; nodeId: string }>();
  return <StoryAutomationForm nodeId={nodeId} onSaved={() => router.back()} storyId={storyId} />;
}
