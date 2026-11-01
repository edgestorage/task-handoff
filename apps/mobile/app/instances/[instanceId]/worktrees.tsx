import { useLocalSearchParams } from 'expo-router';

import { InstanceWorktreesScreen } from '../../../src/instances/InstanceWorktreesScreen';

export default function InstanceWorktreesRoute() {
  const params = useLocalSearchParams<{ instanceId: string }>();
  const instanceId = Array.isArray(params.instanceId) ? params.instanceId[0] || '' : params.instanceId || '';
  return <InstanceWorktreesScreen instanceId={instanceId} />;
}
