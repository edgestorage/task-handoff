import { createContext, createElement, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { AppSessionAccessLease } from '@task-handoff/protocol/app-sessions';

import { createDirectControlPlaneClient } from '../control-plane/client';
import type { MobileControlPlaneTransport } from '../control-plane/transport';
import { mobileProfileStore, mobileSecureStore } from '../control-plane/runtime';
import { subscribeToAppLifecycle } from '../platform/lifecycle';
import { subscribeToNetworkState } from '../platform/network';
import { MobileAppSessionController } from './controller';
import { mobileAppSessionStore } from './store';

type ActiveAppSessions = {
  closeSession(instanceId: string, sessionId: string): Promise<void>;
  createAccess(instanceId: string, sessionId: string): Promise<AppSessionAccessLease>;
  renameSession(instanceId: string, sessionId: string, title: string): Promise<void>;
  revokeAccess(instanceId: string, sessionId: string, token: string): Promise<void>;
  controlPlaneId?: string;
  state: ReturnType<typeof mobileAppSessionStore.profile>;
  transport?: MobileControlPlaneTransport;
};
const Context = createContext<ActiveAppSessions | undefined>(undefined);

export function ActiveAppSessionsProvider({ children }: { children: ReactNode }) {
  const [controlPlaneId, setControlPlaneId] = useState<string>();
  const [transport, setTransport] = useState<MobileControlPlaneTransport>();
  const [activeClient, setActiveClient] = useState<{ api: ControlPlaneClient; controlPlaneId: string; generation: number }>();
  useEffect(() => {
    let live = true;
    let activation = 0;
    let controller: MobileAppSessionController | undefined;
    let unsubscribeNetwork: (() => void) | undefined;
    let unsubscribeLifecycle: (() => void) | undefined;
    const stop = () => { unsubscribeNetwork?.(); unsubscribeLifecycle?.(); controller?.stop(); controller = undefined; setActiveClient(undefined); };
    const activate = async () => {
      const generation = ++activation;
      const profile = await mobileProfileStore.active();
      if (!live || generation !== activation) return;
      stop();
      if (!profile) { setControlPlaneId(undefined); setTransport(undefined); return; }
      const id = profile.identity.controlPlaneId;
      setControlPlaneId(id);
      const direct = createDirectControlPlaneClient(profile, mobileSecureStore);
      setTransport(direct.transport);
      setActiveClient({ api: direct.api, controlPlaneId: id, generation: mobileAppSessionStore.generation(id) });
      controller = new MobileAppSessionController(id, direct.api, direct.transport, mobileAppSessionStore);
      let foreground = false; let connected = true; let running = false;
      const reconcile = () => {
        const shouldRun = foreground && connected;
        if (shouldRun === running) return;
        running = shouldRun;
        if (shouldRun) void controller?.start().catch((cause) => mobileAppSessionStore.setSyncState(id, { phase: mobileAppSessionStore.profile(id).snapshot ? 'stale' : 'error', error: cause instanceof Error ? cause.message : 'Could not load App Sessions.' }));
        else if (!connected) controller?.offline(); else controller?.stop();
      };
      unsubscribeLifecycle = subscribeToAppLifecycle((phase) => { foreground = phase === 'active'; reconcile(); });
      unsubscribeNetwork = subscribeToNetworkState((network) => { connected = network.connected; reconcile(); });
    };
    const unsubscribeProfiles = mobileProfileStore.subscribe(() => { void activate(); });
    void activate();
    return () => { live = false; activation += 1; unsubscribeProfiles(); stop(); };
  }, []);
  const closeSession = useCallback(async (instanceId: string, sessionId: string) => {
    const active = activeClient;
    if (!active) throw new Error('No active Control Plane.');
    await active.api.appSessions.stop(instanceId, sessionId);
    const snapshot = await active.api.appSessions.refresh();
    if (mobileAppSessionStore.isGeneration(active.controlPlaneId, active.generation)) {
      mobileAppSessionStore.replaceSnapshot(active.controlPlaneId, snapshot);
    }
  }, [activeClient]);
  const renameSession = useCallback(async (instanceId: string, sessionId: string, title: string) => {
    const active = activeClient;
    if (!active) throw new Error('No active Control Plane.');
    await active.api.appSessions.rename(instanceId, sessionId, title);
    const snapshot = await active.api.appSessions.refresh();
    if (mobileAppSessionStore.isGeneration(active.controlPlaneId, active.generation)) {
      mobileAppSessionStore.replaceSnapshot(active.controlPlaneId, snapshot);
    }
  }, [activeClient]);
  const createAccess = useCallback(async (instanceId: string, sessionId: string) => {
    const active = activeClient;
    if (!active || !transport) throw new Error('No active Control Plane.');
    const access = await active.api.appSessions.access(instanceId, sessionId);
    return { ...access, url: new URL(access.url, transport.profile.access.origin).toString() };
  }, [activeClient, transport]);
  const revokeAccess = useCallback(async (instanceId: string, sessionId: string, token: string) => {
    const active = activeClient;
    if (!active) return;
    await active.api.appSessions.revokeAccess(instanceId, sessionId, token);
  }, [activeClient]);
  const empty = mobileAppSessionStore.profile(controlPlaneId || '__booting__');
  const state = useSyncExternalStore(
    (listener) => controlPlaneId ? mobileAppSessionStore.subscribe(controlPlaneId, listener) : () => undefined,
    () => controlPlaneId ? mobileAppSessionStore.profile(controlPlaneId) : empty,
    () => empty,
  );
  return createElement(Context.Provider, { value: { closeSession, controlPlaneId, createAccess, renameSession, revokeAccess, state, transport } }, children);
}

export function useActiveAppSessions() {
  const value = useContext(Context);
  if (!value) throw new Error('useActiveAppSessions must be used inside ActiveAppSessionsProvider.');
  return value;
}
