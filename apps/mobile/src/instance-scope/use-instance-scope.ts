import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AiSessionScope } from '../ai-sessions/store';
import { useActiveDirectories } from '../directories/use-directories';

type InstanceScopeContextValue = {
  scope: Extract<AiSessionScope, { kind: 'all' | 'instance' }>;
  setScope(scope: Extract<AiSessionScope, { kind: 'all' | 'instance' }>): void;
};

const Context = createContext<InstanceScopeContextValue | undefined>(undefined);
const ALL_SCOPE: InstanceScopeContextValue['scope'] = { kind: 'all' };

export function InstanceScopeProvider({ children }: { children: ReactNode }) {
  const { controlPlaneId, state } = useActiveDirectories();
  const [scopes, setScopes] = useState<Record<string, InstanceScopeContextValue['scope']>>({});
  const requested = scopes[controlPlaneId || '__booting__'] ?? ALL_SCOPE;
  const scope = requested.kind === 'instance' && !state.instances.some((instance) => instance.id === requested.instanceId)
    ? ALL_SCOPE
    : requested;
  const setScope = useCallback((next: InstanceScopeContextValue['scope']) => {
    if (!controlPlaneId) return;
    setScopes((current) => {
      const previous = current[controlPlaneId] ?? ALL_SCOPE;
      const unchanged = previous.kind === next.kind
        && (previous.kind !== 'instance' || (next.kind === 'instance' && previous.instanceId === next.instanceId));
      return unchanged ? current : { ...current, [controlPlaneId]: next };
    });
  }, [controlPlaneId]);
  const value = useMemo(() => ({ scope, setScope }), [scope, setScope]);
  return createElement(Context.Provider, { value }, children);
}

export function useInstanceScope() {
  const value = useContext(Context);
  if (!value) throw new Error('useInstanceScope must be used inside InstanceScopeProvider.');
  return value;
}
