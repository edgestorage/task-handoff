import { router, useLocalSearchParams } from 'expo-router';

import { StoryActionEditor } from '../../../../src/stories/StoryActionEditor';

export default function NewStoryActionRoute() {
  const { storyId, nodeId } = useLocalSearchParams<{ storyId: string; nodeId: string }>();
  return <StoryActionEditor nodeId={nodeId} onSaved={() => router.back()} storyId={storyId} />;
}
