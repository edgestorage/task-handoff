import { createContext, createElement, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { AiSessionScope } from '../ai-sessions/store';
import { useActiveDirectories } from '../directories/use-directories';
import {
  getScopeSelectionPreferences,
  setInstanceScopeSelection,
  subscribeScopeSelectionPreferences,
} from '../scope-selection/preferences';

type InstanceScopeContextValue = {
  scope: Extract<AiSessionScope, { kind: 'all' | 'instance' }>;
  setScope(scope: Extract<AiSessionScope, { kind: 'all' | 'instance' }>): void;
};

const Context = createContext<InstanceScopeContextValue | undefined>(undefined);
const ALL_SCOPE: InstanceScopeContextValue['scope'] = { kind: 'all' };

export function InstanceScopeProvider({ children }: { children: ReactNode }) {
  const { controlPlaneId, state } = useActiveDirectories();
  const preferences = useSyncExternalStore(
    subscribeScopeSelectionPreferences,
    getScopeSelectionPreferences,
    getScopeSelectionPreferences,
  );
  const requested = controlPlaneId
    ? preferences.instanceScopeByControlPlane[controlPlaneId] ?? ALL_SCOPE
    : ALL_SCOPE;
  const scope = requested.kind === 'instance' && !state.instances.some((instance) => instance.id === requested.instanceId)
    ? ALL_SCOPE
    : requested;
  const setScope = useCallback((next: InstanceScopeContextValue['scope']) => {
    setInstanceScopeSelection(controlPlaneId, next);
  }, [controlPlaneId]);
  const value = useMemo(() => ({ scope, setScope }), [scope, setScope]);
  return createElement(Context.Provider, { value }, children);
}

export function useInstanceScope() {
  const value = useContext(Context);
  if (!value) throw new Error('useInstanceScope must be used inside InstanceScopeProvider.');
  return value;
}
