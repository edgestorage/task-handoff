import { useLocalSearchParams } from 'expo-router';

import { AiSessionDetailScreen } from '../../../src/ai-sessions/AiSessionDetailScreen';
import { useActiveAiSessionsRuntime } from '../../../src/ai-sessions/use-active-sessions';
import { useMasterDetailLayout } from '../../../src/components/MasterDetailLayout';
import { aiSessionDetailSelection } from '../../../src/master-detail/selection';
import { useWideDetailRoute } from '../../../src/master-detail/use-wide-detail-route';

export default function SessionDetailRoute() {
  const params = useLocalSearchParams<{ instanceId: string; sessionId: string }>();
  const instanceId = first(params.instanceId);
  const sessionId = first(params.sessionId);
  const { controlPlaneId } = useActiveAiSessionsRuntime();
  const { wide } = useMasterDetailLayout();
  useWideDetailRoute({
    href: '/(tabs)/(main)/inbox',
    selectionKey: `${controlPlaneId || ''}:${instanceId}:${sessionId}`,
    select: () => {
      if (controlPlaneId) aiSessionDetailSelection.set({ controlPlaneId, instanceId, sessionId });
    },
    wide,
  });
  return wide ? null : <AiSessionDetailScreen instanceId={instanceId} sessionId={sessionId} />;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}
