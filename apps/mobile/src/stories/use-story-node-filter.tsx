import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { allNodesVisible, normalizeNodeVisibilityFilter, type NodeVisibilityFilter } from '@task-handoff/control-plane-client';

import { useActiveDirectories } from '../directories/use-directories';

type StoryNodeFilterContextValue = {
  filter: NodeVisibilityFilter;
  setFilter(filter: NodeVisibilityFilter): void;
};

const ALL_NODES = allNodesVisible();
const DEFAULT_VALUE: StoryNodeFilterContextValue = {
  filter: ALL_NODES,
  setFilter: () => undefined,
};
const Context = createContext<StoryNodeFilterContextValue>(DEFAULT_VALUE);

export function StoryNodeFilterProvider({ children }: { children: ReactNode }) {
  const { controlPlaneId, state } = useActiveDirectories();
  const [filters, setFilters] = useState<Record<string, NodeVisibilityFilter>>({});
  const key = controlPlaneId || '__booting__';
  const availableNodeIds = useMemo(() => state.nodes.map((node) => node.id), [state.nodes]);
  const filter = normalizeNodeVisibilityFilter(filters[key] ?? ALL_NODES, availableNodeIds);
  const setFilter = useCallback((next: NodeVisibilityFilter) => {
    if (!controlPlaneId) return;
    const normalized = normalizeNodeVisibilityFilter(next, availableNodeIds);
    setFilters((current) => {
      const previous = normalizeNodeVisibilityFilter(current[controlPlaneId] ?? ALL_NODES, availableNodeIds);
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
