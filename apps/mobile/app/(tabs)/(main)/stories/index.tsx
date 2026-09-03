import { router } from 'expo-router';
import { EmptyState } from '../../../../src/components/EmptyState';
import { useMobileControlPlaneRuntime } from '../../../../src/control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../../../../src/i18n';
import { StoryInbox } from '../../../../src/stories/StoryInbox';

export default function StoriesRoute() {
  const runtime = useMobileControlPlaneRuntime();
  const { t } = useI18n();
  if (!runtime.storyCapability) {
    return <EmptyState icon={{ android: 'menu_book', ios: 'book' }} message={t('stories.unsupported')} style={{ flex: 1 }} />;
  }
  return <StoryInbox
    onOpen={(story) => router.push({ pathname: '/stories/[storyId]' as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })}
    onOpenDocument={(story, document) => router.push({ pathname: '/stories/[storyId]/documents/preview' as never, params: { storyId: story.id, nodeId: story.ownerNodeId, storyPath: document.storyPath, title: document.title } })}
    onOpenSession={(instanceId, sessionId) => router.push({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId, sessionId } })}
  />;
}
