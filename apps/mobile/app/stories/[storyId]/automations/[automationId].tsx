import { router, useLocalSearchParams } from 'expo-router';

import { StoryAutomationForm } from '../../../../src/stories/StoryAutomationForm';

export default function EditStoryAutomationRoute() {
  const { storyId, automationId, nodeId } = useLocalSearchParams<{ storyId: string; automationId: string; nodeId: string }>();
  return <StoryAutomationForm automationId={automationId} nodeId={nodeId} onSaved={() => router.back()} storyId={storyId} />;
}
