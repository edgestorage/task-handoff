import type { RepositoryChangeScope } from '@task-handoff/protocol/repository';

/** View references and scroll offsets only; HTTP/WS remain authoritative for content. */
export type RepositoryViewNavigation = {
  directories: string[];
  filePath?: string;
  change?: { path: string; scope: RepositoryChangeScope };
};

type ViewMemory = { navigation: RepositoryViewNavigation; offsets: Map<string, number> };
const memories = new Map<string, ViewMemory>();
export function repositoryViewMemory(key: string): ViewMemory {
  let memory = memories.get(key);
  if (!memory) {
    memory = { navigation: { directories: [''] }, offsets: new Map() };
    memories.set(key, memory);
  }
  return memory;
}
export function updateRepositoryViewNavigation(key: string, update: (current: RepositoryViewNavigation) => RepositoryViewNavigation) {
  const memory = repositoryViewMemory(key);
  memory.navigation = update(memory.navigation);
  return memory.navigation;
}
export function clearRepositoryViewProfile(controlPlaneId: string) {
  for (const key of memories.keys()) {
    // The identity is minted locally from the tuple, never read from the server.
    const [workspaceIdentity] = JSON.parse(key) as [string];
    const [context] = JSON.parse(workspaceIdentity) as [string];
    if (JSON.parse(context)[0] === controlPlaneId) memories.delete(key);
  }
}
