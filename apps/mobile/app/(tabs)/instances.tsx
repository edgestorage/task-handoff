import { router } from 'expo-router';

import { InstancesDirectory } from '../../src/directories/DirectoryLists';
import { useActiveDirectories } from '../../src/directories/use-directories';

export default function InstancesRoute() {
  const { state } = useActiveDirectories();
  return <InstancesDirectory state={state} onOpen={(instance) => router.push({ pathname: '/instances/[instanceId]', params: { instanceId: instance.id } })} />;
}
