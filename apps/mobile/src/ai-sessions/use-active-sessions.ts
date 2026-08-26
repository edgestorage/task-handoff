import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  const latestTurnId = summary?.latestTurnRef?.id;
  const latestTurnRevision = summary?.latestTurnRef?.bodyRevision;
  const [detailRetry, setDetailRetry] = useState(0);
  const [indexRetry, setIndexRetry] = useState(0);
  const [bodyRetry, setBodyRetry] = useState(0);
  const detailRetryAttempt = useRef(0);
  const indexRetryAttempt = useRef(0);
  const bodyRetryAttempt = useRef(0);
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
    if (!controlPlaneId || runtime.controlPlaneId !== controlPlaneId || !runtime.api || !detailRevision) return;
    const abort = new AbortController();
    const cachedDetailRevision = mobileAiSessionStore.sessionDetailRevision(controlPlaneId, instanceId, sessionId);
    void runtime.api.aiSessions.detail(instanceId, sessionId, cachedDetailRevision, abort.signal).then((read) => {
      if (abort.signal.aborted) return;
      const current = mobileAiSessionStore.sessionSummary(controlPlaneId, instanceId, sessionId);
      if (read.kind === 'updated' && current && read.revision === aiSessionDetailCacheRevision(current)) {
        mobileAiSessionStore.setSessionDetail(controlPlaneId, instanceId, read.revision, read.detail);
      }
      detailRetryAttempt.current = 0;
    }).catch(() => {
      if (abort.signal.aborted) return;
      const delay = Math.min(4_000, 400 * (2 ** detailRetryAttempt.current));
      detailRetryAttempt.current = Math.min(detailRetryAttempt.current + 1, 4);
      setTimeout(() => { if (!abort.signal.aborted) setDetailRetry((value) => value + 1); }, delay);
    });
    return () => abort.abort();
  }, [controlPlaneId, detailRetry, detailRevision, instanceId, runtime.api, runtime.controlPlaneId, sessionId]);
  useEffect(() => {
    if (!controlPlaneId || runtime.controlPlaneId !== controlPlaneId || !runtime.api || !turnsRevision) return;
    const abort = new AbortController();
    const cachedTurnsRevision = mobileAiSessionStore.sessionTurnsRevision(controlPlaneId, instanceId, sessionId);
    void runtime.api.aiSessions.turnIndex(instanceId, sessionId, cachedTurnsRevision, abort.signal).then(async (read) => {
      if (abort.signal.aborted) return;
      const current = mobileAiSessionStore.sessionSummary(controlPlaneId, instanceId, sessionId);
      if (read.kind === 'updated' && current && read.revision === aiSessionTurnsCacheRevision(current)) {
        mobileAiSessionStore.setSessionTurnIndex(controlPlaneId, instanceId, read.revision, read.index);
      }
      indexRetryAttempt.current = 0;
      if (current?.latestTurnRef) return;
      const indexedLatest = mobileAiSessionStore.sessionTurnIndex(controlPlaneId, instanceId, sessionId)?.turns.at(-1);
      const latest = indexedLatest ? { id: indexedLatest.id, bodyRevision: indexedLatest.bodyRevision } : undefined;
      if (!latest) return;
      const cachedRevision = mobileAiSessionStore.sessionTurnRevision(controlPlaneId, instanceId, sessionId, latest.id);
      const bodyRead = await runtime.api!.aiSessions.turnBody(instanceId, sessionId, latest.id, cachedRevision, abort.signal);
      if (!abort.signal.aborted && bodyRead.kind === 'updated' && latest.bodyRevision === bodyRead.revision) {
        mobileAiSessionStore.setSessionTurn(controlPlaneId, instanceId, sessionId, bodyRead.revision, bodyRead.body.turn);
      }
    }).catch(() => {
      if (abort.signal.aborted) return;
      const delay = Math.min(4_000, 400 * (2 ** indexRetryAttempt.current));
      indexRetryAttempt.current = Math.min(indexRetryAttempt.current + 1, 4);
      setTimeout(() => { if (!abort.signal.aborted) setIndexRetry((value) => value + 1); }, delay);
    });
    return () => abort.abort();
  }, [controlPlaneId, indexRetry, instanceId, runtime.api, runtime.controlPlaneId, sessionId, turnsRevision]);
  useEffect(() => {
    const latest = latestTurnId && latestTurnRevision ? { id: latestTurnId, bodyRevision: latestTurnRevision } : undefined;
    if (!controlPlaneId || runtime.controlPlaneId !== controlPlaneId || !runtime.api || !latest) return;
    const abort = new AbortController();
    const cachedRevision = mobileAiSessionStore.sessionTurnRevision(controlPlaneId, instanceId, sessionId, latest.id);
    void runtime.api.aiSessions.turnBody(instanceId, sessionId, latest.id, cachedRevision, abort.signal).then((read) => {
      if (abort.signal.aborted) return;
      const current = mobileAiSessionStore.sessionSummary(controlPlaneId, instanceId, sessionId)?.latestTurnRef;
      if (read.kind === 'updated' && current?.id === latest.id && current.bodyRevision === read.revision) {
        mobileAiSessionStore.setSessionTurn(controlPlaneId, instanceId, sessionId, read.revision, read.body.turn, current.bodyRevision);
      }
      bodyRetryAttempt.current = 0;
    }).catch(() => {
      if (abort.signal.aborted) return;
      const delay = Math.min(4_000, 400 * (2 ** bodyRetryAttempt.current));
      bodyRetryAttempt.current = Math.min(bodyRetryAttempt.current + 1, 4);
      setTimeout(() => { if (!abort.signal.aborted) setBodyRetry((value) => value + 1); }, delay);
    });
    return () => abort.abort();
  }, [bodyRetry, controlPlaneId, instanceId, latestTurnId, latestTurnRevision, runtime.api, runtime.controlPlaneId, sessionId]);
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
