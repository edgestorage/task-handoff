import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { allStoryNodes, normalizeStoryNodeFilter, type StoryNodeFilter } from '@task-handoff/control-plane-client';

import { useActiveDirectories } from '../directories/use-directories';

type StoryNodeFilterContextValue = {
  filter: StoryNodeFilter;
  setFilter(filter: StoryNodeFilter): void;
};

const ALL_NODES = allStoryNodes();
const DEFAULT_VALUE: StoryNodeFilterContextValue = {
  filter: ALL_NODES,
  setFilter: () => undefined,
};
const Context = createContext<StoryNodeFilterContextValue>(DEFAULT_VALUE);

export function StoryNodeFilterProvider({ children }: { children: ReactNode }) {
  const { controlPlaneId, state } = useActiveDirectories();
  const [filters, setFilters] = useState<Record<string, StoryNodeFilter>>({});
  const key = controlPlaneId || '__booting__';
  const availableNodeIds = useMemo(() => state.nodes.map((node) => node.id), [state.nodes]);
  const filter = normalizeStoryNodeFilter(filters[key] ?? ALL_NODES, availableNodeIds);
  const setFilter = useCallback((next: StoryNodeFilter) => {
    if (!controlPlaneId) return;
    const normalized = normalizeStoryNodeFilter(next, availableNodeIds);
    setFilters((current) => {
      const previous = normalizeStoryNodeFilter(current[controlPlaneId] ?? ALL_NODES, availableNodeIds);
      const unchanged = previous.kind === normalized.kind
        && (previous.kind === 'all' || (normalized.kind === 'selected' && previous.nodeIds.join('\0') === normalized.nodeIds.join('\0')));
      return unchanged ? current : { ...current, [controlPlaneId]: normalized };
    });
  }, [availableNodeIds, controlPlaneId]);
  const value = useMemo(() => ({ filter, setFilter }), [filter, setFilter]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useStoryNodeFilter() {
  return useContext(Context);
}
