import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import { isCarPlayConnected, subscribeToCarPlayConnection } from '../carplay/runtime';
import { subscribeToAppLifecycle } from '../platform/lifecycle';
import { subscribeToNetworkState } from '../platform/network';
import { createDirectControlPlaneClient } from './client';
import type { MobileControlPlaneProfile } from './profile';
import { mobileProfileStore, mobileSecureStore } from './runtime';
import type {
  MobileControlPlaneEvent,
  MobileControlPlaneEventConnection,
  MobileControlPlaneTransport,
  MobileControlPlaneTransportError,
} from './transport';

export type MobileControlPlaneRuntimePhase =
  | 'idle'
  | 'verifying'
  | 'loading'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'session-expired'
  | 'error';

export type MobileControlPlaneDomain = {
  key: string;
  topics: readonly string[];
  background?: boolean;
  start(signal: AbortSignal): Promise<unknown>;
  stop(): void;
  offline?(): void;
  onEvent(event: MobileControlPlaneEvent): void;
  onConnectionError?(error?: MobileControlPlaneTransportError): void;
};

type RuntimeSnapshot = {
  phase: MobileControlPlaneRuntimePhase;
  error?: string;
};

const CONNECT_TIMEOUT_MS = 12_000;
const STABLE_CONNECTION_MS = 15_000;

export class MobileControlPlaneConnectionCoordinator {
  private readonly domains = new Map<string, MobileControlPlaneDomain>();
  private readonly listeners = new Set<() => void>();
  private activeDomains: MobileControlPlaneDomain[] = [];
  private connection?: MobileControlPlaneEventConnection;
  private abortController?: AbortController;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private stableTimer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private foreground = false;
  private connected = true;
  private carPlayConnected = false;
  private reconnectAttempt = 0;
  private desiredSignature = '';
  private reconcileQueued = false;
  private snapshotValue: RuntimeSnapshot = { phase: 'idle' };

  constructor(
    readonly profile: MobileControlPlaneProfile,
    readonly api: ControlPlaneClient,
    readonly transport: MobileControlPlaneTransport,
  ) {}

  snapshot = () => this.snapshotValue;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  register(domain: MobileControlPlaneDomain) {
    this.domains.set(domain.key, domain);
    this.queueReconcile();
    return () => {
      if (this.domains.get(domain.key) !== domain) return;
      this.domains.delete(domain.key);
      this.queueReconcile();
    };
  }

  setEnvironment(input: { foreground?: boolean; connected?: boolean; carPlayConnected?: boolean }) {
    const previousCarPlayConnected = this.carPlayConnected;
    if (input.foreground !== undefined) this.foreground = input.foreground;
    if (input.connected !== undefined) this.connected = input.connected;
    if (input.carPlayConnected !== undefined) this.carPlayConnected = input.carPlayConnected;
    if (previousCarPlayConnected !== this.carPlayConnected) {
      for (const listener of this.listeners) listener();
    }
    this.queueReconcile();
  }

  isCarPlayConnected() { return this.carPlayConnected; }

  stop() {
    this.desiredSignature = '';
    this.epoch += 1;
    this.clearTimers();
    this.abortController?.abort();
    this.abortController = undefined;
    this.connection?.close();
    this.connection = undefined;
    for (const domain of this.activeDomains) domain.stop();
    this.activeDomains = [];
    this.publish({ phase: 'idle' });
  }

  private queueReconcile() {
    if (this.reconcileQueued) return;
    this.reconcileQueued = true;
    queueMicrotask(() => {
      this.reconcileQueued = false;
      this.reconcile();
    });
  }

  private reconcile(force = false) {
    const desired = this.connected
      ? [...this.domains.values()].filter((domain) => this.foreground || (this.carPlayConnected && domain.background))
      : [];
    const signature = desired.map((domain) => domain.key).sort().join('\u0000');
    if (!force && signature === this.desiredSignature) return;
    this.desiredSignature = signature;
    void this.restart(desired);
  }

  private async restart(desired: MobileControlPlaneDomain[]) {
    const epoch = ++this.epoch;
    this.clearTimers();
    this.abortController?.abort();
    this.connection?.close();
    this.connection = undefined;
    for (const domain of this.activeDomains) domain.stop();
    this.activeDomains = desired;
    if (!this.connected) {
      for (const domain of this.domains.values()) domain.offline?.();
      this.publish({ phase: 'offline' });
      return;
    }
    if (!desired.length) {
      this.publish({ phase: 'idle' });
      return;
    }
    const abortController = new AbortController();
    this.abortController = abortController;
    try {
      this.publish({ phase: this.reconnectAttempt ? 'reconnecting' : 'verifying' });
      await this.transport.revalidate?.();
      if (!this.live(epoch, abortController)) return;
      const auth = await this.api.auth.session(abortController.signal);
      if (!auth.authenticated) {
        this.publish({ phase: 'session-expired', error: 'The mobile Control Plane session expired.' });
        return;
      }
      this.publish({ phase: this.reconnectAttempt ? 'reconnecting' : 'loading' });
      await Promise.all(desired.map((domain) => domain.start(abortController.signal)));
      if (!this.live(epoch, abortController)) return;
      const topics = [...new Set(desired.flatMap((domain) => [...domain.topics]))].sort();
      this.connection = this.transport.connectEvents({
        topics,
        onOpen: () => {
          if (!this.live(epoch, abortController)) return;
          this.clearConnectTimer();
          this.publish({ phase: 'connected' });
          this.stableTimer = setTimeout(() => {
            if (this.live(epoch, abortController)) this.reconnectAttempt = 0;
          }, STABLE_CONNECTION_MS);
        },
        onEvent: (event) => {
          if (!this.live(epoch, abortController)) return;
          for (const domain of desired) domain.onEvent(event);
        },
        onError: (error) => {
          if (!this.live(epoch, abortController)) return;
          for (const domain of desired) domain.onConnectionError?.(error);
          this.scheduleReconnect(epoch, abortController, error.message);
        },
        onClose: () => {
          if (!this.live(epoch, abortController)) return;
          for (const domain of desired) domain.onConnectionError?.();
          this.scheduleReconnect(epoch, abortController);
        },
      });
      this.connectTimer = setTimeout(() => {
        if (!this.live(epoch, abortController) || this.snapshotValue.phase === 'connected') return;
        this.connection?.close();
        this.scheduleReconnect(epoch, abortController, 'The Control Plane event connection timed out.');
      }, CONNECT_TIMEOUT_MS);
    } catch (cause) {
      if (!this.live(epoch, abortController)) return;
      const error = cause instanceof Error ? cause.message : 'The Control Plane connection failed.';
      for (const domain of desired) domain.onConnectionError?.();
      this.scheduleReconnect(epoch, abortController, error);
    }
  }

  private scheduleReconnect(epoch: number, abortController: AbortController, error?: string) {
    if (!this.live(epoch, abortController) || this.reconnectTimer) return;
    this.clearConnectTimer();
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    this.publish({ phase: 'reconnecting', ...(error ? { error } : {}) });
    const delay = Math.min(1_000 * (2 ** this.reconnectAttempt), 30_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.live(epoch, abortController)) return;
      this.reconcile(true);
    }, delay);
  }

  private live(epoch: number, abortController: AbortController) {
    return epoch === this.epoch && this.abortController === abortController && !abortController.signal.aborted;
  }

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.reconnectTimer = undefined;
    this.stableTimer = undefined;
    this.clearConnectTimer();
  }

  private publish(snapshot: RuntimeSnapshot) {
    if (this.snapshotValue.phase === snapshot.phase && this.snapshotValue.error === snapshot.error) return;
    this.snapshotValue = snapshot;
    for (const listener of this.listeners) listener();
  }
}

type DirectClient = ReturnType<typeof createDirectControlPlaneClient>;

export type MobileControlPlaneRuntimeDependencies = {
  activeProfile(): Promise<MobileControlPlaneProfile | undefined>;
  subscribeProfiles(listener: () => void): () => void;
  createClient(profile: MobileControlPlaneProfile): DirectClient;
  subscribeLifecycle: typeof subscribeToAppLifecycle;
  subscribeNetwork: typeof subscribeToNetworkState;
  subscribeCarPlay(listener: (connected: boolean) => void): () => void;
  carPlayConnected(): Promise<boolean>;
};

const defaultDependencies: MobileControlPlaneRuntimeDependencies = {
  activeProfile: () => mobileProfileStore.active(),
  subscribeProfiles: (listener) => mobileProfileStore.subscribe(listener),
  createClient: (profile) => createDirectControlPlaneClient(profile, mobileSecureStore),
  subscribeLifecycle: subscribeToAppLifecycle,
  subscribeNetwork: subscribeToNetworkState,
  subscribeCarPlay: subscribeToCarPlayConnection,
  carPlayConnected: isCarPlayConnected,
};

export type MobileControlPlaneRuntimeValue = {
  api?: ControlPlaneClient;
  carPlayConnected: boolean;
  controlPlaneId?: string;
  controlPlaneOrigin?: string;
  coordinator?: MobileControlPlaneConnectionCoordinator;
  phase: MobileControlPlaneRuntimePhase;
  transport?: MobileControlPlaneTransport;
};

const Context = createContext<MobileControlPlaneRuntimeValue | undefined>(undefined);

export function MobileControlPlaneRuntimeProvider({
  children,
  dependencies = defaultDependencies,
}: {
  children?: ReactNode;
  dependencies?: MobileControlPlaneRuntimeDependencies;
}) {
  const [active, setActive] = useState<{ direct: DirectClient; profile: MobileControlPlaneProfile; coordinator: MobileControlPlaneConnectionCoordinator }>();
  const [, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    let activation = 0;
    let coordinator: MobileControlPlaneConnectionCoordinator | undefined;
    let foreground = false;
    let connected = true;
    let carPlayConnected = false;
    let unsubscribeCoordinator: (() => void) | undefined;
    const applyEnvironment = () => coordinator?.setEnvironment({ foreground, connected, carPlayConnected });
    const activate = async () => {
      const currentActivation = ++activation;
      const profile = await dependencies.activeProfile();
      if (!live || currentActivation !== activation) return;
      unsubscribeCoordinator?.();
      coordinator?.stop();
      coordinator = undefined;
      if (!profile) {
        setActive(undefined);
        return;
      }
      const direct = dependencies.createClient(profile);
      coordinator = new MobileControlPlaneConnectionCoordinator(profile, direct.api, direct.transport);
      unsubscribeCoordinator = coordinator.subscribe(() => setRevision((value) => value + 1));
      applyEnvironment();
      setActive({ direct, profile, coordinator });
    };
    const unsubscribeProfiles = dependencies.subscribeProfiles(() => { void activate(); });
    const unsubscribeLifecycle = dependencies.subscribeLifecycle((phase) => { foreground = phase === 'active'; applyEnvironment(); });
    const unsubscribeNetwork = dependencies.subscribeNetwork((network) => { connected = network.connected; applyEnvironment(); });
    const unsubscribeCarPlay = dependencies.subscribeCarPlay((value) => { carPlayConnected = value; applyEnvironment(); });
    void dependencies.carPlayConnected().then((value) => { if (live) { carPlayConnected = value; applyEnvironment(); } }).catch(() => undefined);
    void activate();
    return () => {
      live = false;
      activation += 1;
      unsubscribeProfiles();
      unsubscribeLifecycle();
      unsubscribeNetwork();
      unsubscribeCarPlay();
      unsubscribeCoordinator?.();
      coordinator?.stop();
    };
  }, [dependencies]);
  const value = useMemo<MobileControlPlaneRuntimeValue>(() => ({
    api: active?.direct.api,
    carPlayConnected: active?.coordinator.isCarPlayConnected() ?? false,
    controlPlaneId: active?.profile.identity.controlPlaneId,
    controlPlaneOrigin: active?.profile.access.origin,
    coordinator: active?.coordinator,
    phase: active?.coordinator.snapshot().phase ?? 'idle',
    transport: active?.direct.transport,
  }), [active, active?.coordinator.isCarPlayConnected(), active?.coordinator.snapshot().phase]);
  return createElement(Context.Provider, { value }, children);
}

export function useMobileControlPlaneRuntime() {
  const value = useContext(Context);
  if (!value) throw new Error('useMobileControlPlaneRuntime must be used inside MobileControlPlaneRuntimeProvider.');
  return value;
}

export function useOptionalMobileControlPlaneRuntime() {
  return useContext(Context);
}
