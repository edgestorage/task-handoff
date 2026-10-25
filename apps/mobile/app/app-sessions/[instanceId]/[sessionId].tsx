import { useLocalSearchParams } from 'expo-router';

import { AppSessionDetailScreen } from '../../../src/app-sessions/AppSessionDetailScreen';
import { useActiveAppSessions } from '../../../src/app-sessions/use-active-app-sessions';
import { useMasterDetailLayout } from '../../../src/components/MasterDetailLayout';
import { appSessionDetailSelection } from '../../../src/master-detail/selection';
import { useWideDetailRoute } from '../../../src/master-detail/use-wide-detail-route';

export default function AppSessionRoute() {
  const params = useLocalSearchParams<{ instanceId: string; sessionId: string }>();
  const instanceId = first(params.instanceId);
  const sessionId = first(params.sessionId);
  const { controlPlaneId } = useActiveAppSessions();
  const { wide } = useMasterDetailLayout();
  useWideDetailRoute({
    href: '/(tabs)/(main)/apps',
    selectionKey: `${controlPlaneId || ''}:${instanceId}:${sessionId}`,
    select: () => {
      if (controlPlaneId) appSessionDetailSelection.set({ controlPlaneId, instanceId, sessionId });
    },
    wide,
  });
  return wide ? null : <AppSessionDetailScreen instanceId={instanceId} sessionId={sessionId} />;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}
