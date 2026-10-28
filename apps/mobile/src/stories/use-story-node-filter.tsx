import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { allNodesVisible, normalizeNodeVisibilityFilter, type NodeVisibilityFilter } from '@task-handoff/control-plane-client';

import { useActiveDirectories } from '../directories/use-directories';
import {
  getScopeSelectionPreferences,
  setStoryNodeFilterSelection,
  subscribeScopeSelectionPreferences,
} from '../scope-selection/preferences';

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
  const preferences = useSyncExternalStore(
    subscribeScopeSelectionPreferences,
    getScopeSelectionPreferences,
    getScopeSelectionPreferences,
  );
  const requested = controlPlaneId
    ? preferences.storyNodeFilterByControlPlane[controlPlaneId] ?? ALL_NODES
    : ALL_NODES;
  const availableNodeIds = useMemo(() => state.nodes.map((node) => node.id), [state.nodes]);
  const filter = normalizeNodeVisibilityFilter(requested, availableNodeIds);
  const setFilter = useCallback((next: NodeVisibilityFilter) => {
    setStoryNodeFilterSelection(controlPlaneId, normalizeNodeVisibilityFilter(next, availableNodeIds));
  }, [availableNodeIds, controlPlaneId]);
  const value = useMemo(() => ({ filter, setFilter }), [filter, setFilter]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useStoryNodeFilter() {
  return useContext(Context);
}
