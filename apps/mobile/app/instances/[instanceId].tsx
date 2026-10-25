import { useLocalSearchParams } from 'expo-router';

import { useMasterDetailLayout } from '../../src/components/MasterDetailLayout';
import { useActiveDirectories } from '../../src/directories/use-directories';
import { InstanceDetailScreen } from '../../src/instances/InstanceDetailScreen';
import { instanceDetailSelection } from '../../src/master-detail/selection';
import { useWideDetailRoute } from '../../src/master-detail/use-wide-detail-route';

export default function InstanceDirectoryDetailRoute() {
  const params = useLocalSearchParams<{ instanceId: string }>();
  const instanceId = first(params.instanceId);
  const { controlPlaneId } = useActiveDirectories();
  const { wide } = useMasterDetailLayout();
  useWideDetailRoute({
    href: '/(tabs)/(main)/instances',
    selectionKey: `${controlPlaneId || ''}:${instanceId}`,
    select: () => {
      if (controlPlaneId && instanceId) instanceDetailSelection.set({ controlPlaneId, instanceId });
    },
    wide,
  });
  return wide ? null : <InstanceDetailScreen instanceId={instanceId} />;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}
