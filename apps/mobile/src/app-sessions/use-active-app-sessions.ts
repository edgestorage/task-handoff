import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { AppSessionAccessLease } from '@task-handoff/protocol/app-sessions';

import {
  MobileControlPlaneRuntimeProvider,
  useMobileControlPlaneRuntime,
  useOptionalMobileControlPlaneRuntime,
} from '../control-plane/use-mobile-control-plane-runtime';
import type { MobileControlPlaneTransport } from '../control-plane/transport';
import { mobileControlPlaneProfileAddress } from '../control-plane/profile';
import { MobileAppSessionController } from './controller';
import { mobileAppSessionStore } from './store';

type ActiveAppSessions = {
  closeSession(instanceId: string, sessionId: string): Promise<void>;
  createAccess(instanceId: string, sessionId: string): Promise<AppSessionAccessLease>;
  refresh(): Promise<void>;
  renameSession(instanceId: string, sessionId: string, title: string): Promise<void>;
  revokeAccess(instanceId: string, sessionId: string, token: string): Promise<void>;
  controlPlaneId?: string;
  state: ReturnType<typeof mobileAppSessionStore.profile>;
  transport?: MobileControlPlaneTransport;
};
const Context = createContext<ActiveAppSessions | undefined>(undefined);

export function ActiveAppSessionsProvider({ children }: { children: ReactNode }): ReactNode {
  const runtime = useOptionalMobileControlPlaneRuntime();
  if (!runtime) {
    return createElement(MobileControlPlaneRuntimeProvider, null,
      createElement(ActiveAppSessionsProvider, null, children),
    );
  }
  return createElement(ActiveAppSessionsBoundary, null, children);
}

function ActiveAppSessionsBoundary({ children }: { children: ReactNode }) {
  const runtime = useMobileControlPlaneRuntime();
  const controller = useMemo(() => runtime.controlPlaneId && runtime.api && runtime.transport
    ? new MobileAppSessionController(runtime.controlPlaneId, runtime.api, runtime.transport, mobileAppSessionStore)
    : undefined, [runtime.api, runtime.controlPlaneId, runtime.transport]);
  useEffect(() => {
    if (!runtime.coordinator || !controller) return;
    return runtime.coordinator.register({
      key: 'app-sessions',
      topics: ['app.sessions'],
      start: (signal) => controller.start(signal, { managed: true }),
      stop: () => controller.stop(),
      offline: () => controller.offline(),
      onEvent: (event) => { controller.applyEvent(event); },
      onConnectionError: (error) => controller.onConnectionError(error),
    });
  }, [controller, runtime.coordinator]);
  const empty = mobileAppSessionStore.profile(runtime.controlPlaneId || '__booting__');
  const state = useSyncExternalStore(
    (listener) => runtime.controlPlaneId ? mobileAppSessionStore.subscribe(runtime.controlPlaneId, listener) : () => undefined,
    () => runtime.controlPlaneId ? mobileAppSessionStore.profile(runtime.controlPlaneId) : empty,
    () => empty,
  );
  const closeSession = useCallback(async (instanceId: string, sessionId: string) => {
    if (!runtime.api || !runtime.controlPlaneId) throw new Error('No active Control Plane.');
    const session = await runtime.api.appSessions.stop(instanceId, sessionId);
    mobileAppSessionStore.upsertSession(runtime.controlPlaneId, instanceId, session);
  }, [runtime.api, runtime.controlPlaneId]);
  const renameSession = useCallback(async (instanceId: string, sessionId: string, title: string) => {
    if (!runtime.api || !runtime.controlPlaneId) throw new Error('No active Control Plane.');
    const session = await runtime.api.appSessions.rename(instanceId, sessionId, title);
    mobileAppSessionStore.upsertSession(runtime.controlPlaneId, instanceId, session);
  }, [runtime.api, runtime.controlPlaneId]);
  const refresh = useCallback(async () => {
    if (!controller) throw new Error('No active Control Plane.');
    await controller.refresh();
  }, [controller]);
  const createAccess = useCallback(async (instanceId: string, sessionId: string) => {
    if (!runtime.api || !runtime.transport) throw new Error('No active Control Plane.');
    const access = await runtime.api.appSessions.access(instanceId, sessionId);
    return { ...access, url: new URL(access.url, mobileControlPlaneProfileAddress(runtime.transport.profile)).toString() };
  }, [runtime.api, runtime.transport]);
  const revokeAccess = useCallback(async (instanceId: string, sessionId: string, token: string) => {
    await runtime.api?.appSessions.revokeAccess(instanceId, sessionId, token);
  }, [runtime.api]);
  const value = useMemo(() => ({
    closeSession,
    controlPlaneId: runtime.controlPlaneId,
    createAccess,
    refresh,
    renameSession,
    revokeAccess,
    state,
    transport: runtime.transport,
  }), [closeSession, createAccess, refresh, renameSession, revokeAccess, runtime.controlPlaneId, runtime.transport, state]);
  return createElement(Context.Provider, { value }, children);
}

export function useActiveAppSessions() {
  const value = useContext(Context);
  if (!value) throw new Error('useActiveAppSessions must be used inside ActiveAppSessionsProvider.');
  return value;
}
