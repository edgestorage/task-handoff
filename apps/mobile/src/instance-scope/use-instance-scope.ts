import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from 'react';
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
  const value = useMemo(() => ({
    scope,
    setScope(next: InstanceScopeContextValue['scope']) {
      if (!controlPlaneId) return;
      setScopes((current) => ({ ...current, [controlPlaneId]: next }));
    },
  }), [controlPlaneId, scope]);
  return createElement(Context.Provider, { value }, children);
}

export function useInstanceScope() {
  const value = useContext(Context);
  if (!value) throw new Error('useInstanceScope must be used inside InstanceScopeProvider.');
  return value;
}
