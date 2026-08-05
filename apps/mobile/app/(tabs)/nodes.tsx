import { router } from 'expo-router';

import { NodesDirectory } from '../../src/directories/DirectoryLists';
import { useActiveDirectories } from '../../src/directories/use-directories';

export default function NodesRoute() {
  const { state } = useActiveDirectories();
  return <NodesDirectory state={state} onOpen={(node) => router.push({ pathname: '/nodes/[nodeId]', params: { nodeId: node.id } })} />;
}
