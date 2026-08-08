import { router, Stack, useLocalSearchParams } from 'expo-router';
import { InstancesDirectory } from '../../src/directories/DirectoryLists';
import { useActiveDirectories } from '../../src/directories/use-directories';

export default function NodeInstancesRoute() {
  const { nodeId } = useLocalSearchParams<{ nodeId: string }>();
  const { state } = useActiveDirectories();
  const node = state.nodes.find((candidate) => candidate.id === nodeId);
  return <>
    <Stack.Screen options={{ title: node?.name || 'Node' }} />
    <InstancesDirectory nodeId={nodeId} state={state} onOpen={(instance) => router.push({ pathname: '/instances/[instanceId]', params: { instanceId: instance.id } })} />
  </>;
}
