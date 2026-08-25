import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { aiSessionDetailCacheRevision, aiSessionTurnsCacheRevision, type ControlPlaneClient } from '@task-handoff/control-plane-client';

import { isCarPlayConnected, subscribeToCarPlayConnection } from '../carplay/runtime';
import { createMobileControlPlaneClient } from '../control-plane/client';
import type { MobileControlPlaneProfile } from '../control-plane/profile';
import {
  MobileControlPlaneRuntimeProvider,
  useMobileControlPlaneRuntime,
  useOptionalMobileControlPlaneRuntime,
  type MobileControlPlaneRuntimeDependencies,
} from '../control-plane/use-mobile-control-plane-runtime';
import { subscribeToAppLifecycle } from '../platform/lifecycle';
import { subscribeToNetworkState } from '../platform/network';
import { MobileAiSessionActionCoordinator } from './actions';
import { MobileAiSessionController } from './controller';
import { mobileAiSessionStore, type MobileAiSessionViewState } from './store';

type ActiveAiSessions = {
  actions?: MobileAiSessionActionCoordinator;
  client?: ControlPlaneClient;
  controlPlaneId?: string;
  refresh(): Promise<void>;
  state: ReturnType<typeof mobileAiSessionStore.profile>;
};

const ActiveAiSessionsContext = createContext<ActiveAiSessions | undefined>(undefined);
const ActiveAiSessionsRuntimeContext = createContext<Omit<ActiveAiSessions, 'state'> | undefined>(undefined);
const emptySessionView: MobileAiSessionViewState = { messages: [], timelines: {}, syncPhase: 'idle' };

export type ActiveAiSessionsDependencies = {
  activeProfile(): Promise<MobileControlPlaneProfile | undefined>;
  subscribeProfiles(listener: () => void): () => void;
  createClient(profile: MobileControlPlaneProfile): ReturnType<typeof createMobileControlPlaneClient>;
  subscribeLifecycle: typeof subscribeToAppLifecycle;
  subscribeNetwork: typeof subscribeToNetworkState;
  subscribeCarPlay?: MobileControlPlaneRuntimeDependencies['subscribeCarPlay'];
  carPlayConnected?: MobileControlPlaneRuntimeDependencies['carPlayConnected'];
};

export function ActiveAiSessionsProvider({ children, dependencies }: { children: ReactNode; dependencies?: ActiveAiSessionsDependencies }): ReactNode {
  const runtime = useOptionalMobileControlPlaneRuntime();
  if (!runtime) {
    const runtimeDependencies = dependencies ? {
      ...dependencies,
      subscribeCarPlay: dependencies.subscribeCarPlay ?? subscribeToCarPlayConnection,
      carPlayConnected: dependencies.carPlayConnected ?? isCarPlayConnected,
    } : undefined;
    return createElement(MobileControlPlaneRuntimeProvider, { dependencies: runtimeDependencies },
      createElement(ActiveAiSessionsProvider, null, children),
    );
  }
  return createElement(ActiveAiSessionsBoundary, null, children);
}

function ActiveAiSessionsBoundary({ children }: { children: ReactNode }) {
  const runtime = useMobileControlPlaneRuntime();
  const controller = useMemo(() => runtime.controlPlaneId && runtime.api && runtime.transport
    ? new MobileAiSessionController(runtime.controlPlaneId, runtime.api, runtime.transport, mobileAiSessionStore)
    : undefined, [runtime.api, runtime.controlPlaneId, runtime.transport]);
  const actions = useMemo(() => runtime.controlPlaneId && runtime.api
    ? new MobileAiSessionActionCoordinator(runtime.controlPlaneId, runtime.api, mobileAiSessionStore)
    : undefined, [runtime.api, runtime.controlPlaneId]);
  useEffect(() => {
    if (!runtime.coordinator || !controller) return;
    return runtime.coordinator.register({
      key: 'ai-sessions',
      topics: ['ai.sessions'],
      background: true,
      start: (signal) => controller.start(signal, { managed: true }),
      stop: () => controller.stop(),
      offline: () => controller.offline(),
      onEvent: (event) => { controller.applyEvent(event); },
      onConnectionError: (error) => controller.onConnectionError(error),
    });
  }, [controller, runtime.coordinator]);
  const empty = mobileAiSessionStore.profile(runtime.controlPlaneId || '__booting__');
  const state = useSyncExternalStore(
    (listener) => runtime.controlPlaneId ? mobileAiSessionStore.subscribe(runtime.controlPlaneId, listener) : () => undefined,
    () => runtime.controlPlaneId ? mobileAiSessionStore.profile(runtime.controlPlaneId) : empty,
    () => empty,
  );
  const refresh = useMemo(() => async () => {
    if (!controller) throw new Error('The active Control Plane AI Sessions are unavailable.');
    await controller.refresh();
  }, [controller]);
  const runtimeValue = useMemo(() => ({ actions, client: runtime.api, controlPlaneId: runtime.controlPlaneId, refresh }), [actions, refresh, runtime.api, runtime.controlPlaneId]);
  const value = useMemo(() => ({ ...runtimeValue, state }), [runtimeValue, state]);
  return createElement(ActiveAiSessionsRuntimeContext.Provider, { value: runtimeValue },
    createElement(ActiveAiSessionsContext.Provider, { value }, children),
  );
}

export function useActiveAiSessions() {
  const value = useContext(ActiveAiSessionsContext);
  if (!value) throw new Error('useActiveAiSessions must be used inside ActiveAiSessionsProvider.');
  return value;
}

export function useActiveAiSessionsRuntime() {
  const value = useContext(ActiveAiSessionsRuntimeContext);
  if (!value) throw new Error('useActiveAiSessionsRuntime must be used inside ActiveAiSessionsProvider.');
  return value;
}

export function useActiveAiSessionsSnapshot() {
  const { controlPlaneId } = useActiveAiSessionsRuntime();
  return useSyncExternalStore(
    (listener) => controlPlaneId
      ? mobileAiSessionStore.subscribeSnapshot(controlPlaneId, listener)
      : () => undefined,
    () => controlPlaneId ? mobileAiSessionStore.snapshot(controlPlaneId) : undefined,
    () => undefined,
  );
}

export function useActiveAiSessionView(controlPlaneId: string | undefined, instanceId: string, sessionId: string) {
  const runtime = useMobileControlPlaneRuntime();
  const summary = useSyncExternalStore(
    (listener) => controlPlaneId
      ? mobileAiSessionStore.subscribeSession(controlPlaneId, instanceId, sessionId, listener)
      : () => undefined,
    () => controlPlaneId ? mobileAiSessionStore.sessionSummary(controlPlaneId, instanceId, sessionId) : undefined,
    () => undefined,
  );
  const detailRevision = summary ? aiSessionDetailCacheRevision(summary) : '';
  const turnsRevision = summary ? aiSessionTurnsCacheRevision(summary) : '';
  useEffect(() => {
    if (!controlPlaneId || runtime.controlPlaneId !== controlPlaneId || !instanceId || !sessionId || !runtime.coordinator) return;
    const replaySince = new Date().toISOString();
    const dispose = runtime.coordinator.registerAiSessionTransientDemand({
      replaySince,
      messageDeltas: { allInstances: false, instanceIds: [instanceId] },
      timelineAllSessions: false,
      timelineSessions: [{ instanceId, sessionId }],
    });
    // Persistent AI Session events already keep the store authoritative. The
    // replay cursor only opens the transient message/timeline window and must
    // not refetch the complete session fleet on every detail selection.
    return dispose;
  }, [controlPlaneId, instanceId, runtime.controlPlaneId, runtime.coordinator, sessionId]);
  useEffect(() => {
    if (!controlPlaneId || runtime.controlPlaneId !== controlPlaneId || !runtime.api || !summary || !detailRevision || !turnsRevision) return;
    const abort = new AbortController();
    void Promise.all([
      mobileAiSessionStore.hasSessionDetail(controlPlaneId, instanceId, summary)
        ? undefined
        : runtime.api.aiSessions.detail(instanceId, sessionId, abort.signal),
      mobileAiSessionStore.hasSessionTurnIndex(controlPlaneId, instanceId, summary)
        ? undefined
        : runtime.api.aiSessions.turnIndex(instanceId, sessionId, abort.signal),
    ]).then(async ([detail, index]) => {
      if (abort.signal.aborted) return;
      if (detail) mobileAiSessionStore.setSessionDetail(controlPlaneId, instanceId, summary, detail);
      if (index) mobileAiSessionStore.setSessionTurnIndex(controlPlaneId, instanceId, summary, index);
      const latest = mobileAiSessionStore.sessionTurnIndex(controlPlaneId, instanceId, sessionId)?.turns.at(-1);
      const needed = latest && mobileAiSessionStore.neededSessionTurn(controlPlaneId, instanceId, sessionId, latest.id);
      if (!needed) return;
      const body = await runtime.api!.aiSessions.turnBody(instanceId, sessionId, needed.id, abort.signal);
      if (!abort.signal.aborted) mobileAiSessionStore.setSessionTurn(controlPlaneId, instanceId, sessionId, body.revision, body.turn);
    }).catch(() => undefined);
    return () => abort.abort();
  }, [controlPlaneId, detailRevision, instanceId, runtime.api, runtime.controlPlaneId, sessionId, summary?.id, turnsRevision]);
  return useSyncExternalStore(
    (listener) => controlPlaneId
      ? mobileAiSessionStore.subscribeSession(controlPlaneId, instanceId, sessionId, listener)
      : () => undefined,
    () => controlPlaneId
      ? mobileAiSessionStore.sessionView(controlPlaneId, instanceId, sessionId)
      : emptySessionView,
    () => emptySessionView,
  );
}
