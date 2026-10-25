import { router, useLocalSearchParams } from 'expo-router';
import { useMasterDetailLayout } from '../../src/components/MasterDetailLayout';
import { useMobileControlPlaneRuntime } from '../../src/control-plane/use-mobile-control-plane-runtime';
import { storyDetailSelection } from '../../src/master-detail/selection';
import { useWideDetailRoute } from '../../src/master-detail/use-wide-detail-route';
import { StoryDetail } from '../../src/stories/StoryDetail';

export default function StoryDetailRoute() {
  const { storyId, nodeId } = useLocalSearchParams<{ storyId: string; nodeId: string }>();
  const runtime = useMobileControlPlaneRuntime();
  const { wide } = useMasterDetailLayout();
  useWideDetailRoute({
    href: '/(tabs)/(main)/stories',
    selectionKey: `${runtime.controlPlaneId || ''}:${nodeId || ''}:${storyId}`,
    select: () => {
      if (runtime.controlPlaneId) storyDetailSelection.set({ controlPlaneId: runtime.controlPlaneId, nodeId, storyId });
    },
    wide,
  });
  const openSession = (instanceId: string, sessionId: string) => {
    router.push({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId, sessionId } });
  };
  return wide ? null : <StoryDetail storyId={storyId} nodeId={nodeId} onOpenSession={openSession} />;
}
