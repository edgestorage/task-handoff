import { useLocalSearchParams } from 'expo-router';
import { StoryDocumentPreview } from '../../../../src/stories/StoryDocumentPreview';

export default function StoryDocumentPreviewRoute() {
  const { storyId, nodeId, storyPath, title } = useLocalSearchParams<{ storyId: string; nodeId: string; storyPath: string; title?: string }>();
  return <StoryDocumentPreview storyId={storyId} nodeId={nodeId} storyPath={storyPath} title={title} />;
}
