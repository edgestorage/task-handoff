import { router } from 'expo-router';
import { InstancesDirectory } from '../../../../src/directories/DirectoryLists';
import { useActiveDirectories } from '../../../../src/directories/use-directories';
import { useInstanceScope } from '../../../../src/instance-scope/use-instance-scope';
export default function InstancesRoute() {
  const { state } = useActiveDirectories();
  const { scope } = useInstanceScope();
  const visible = scope.kind === 'instance' ? { ...state, instances: state.instances.filter((instance) => instance.id === scope.instanceId) } : state;
  return <InstancesDirectory state={visible} onOpen={(instance) => router.push({ pathname: '/instances/[instanceId]', params: { instanceId: instance.id } })} />;
}
