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
import type { ControlPlanePublicCapabilities } from '@task-handoff/protocol/control-plane-access';
import { AiSessionTransientSubscriptionSchema, type AiSessionTransientSubscription } from '@task-handoff/protocol/events';

import { isCarPlayConnected, subscribeToCarPlayConnection } from '../carplay/runtime';
import { subscribeToAppLifecycle } from '../platform/lifecycle';
import { subscribeToNetworkState } from '../platform/network';
import { MobileReconnectBackoff } from '../platform/reconnect';
import { createMobileControlPlaneClient } from './client';
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
  currentCapabilities: ControlPlanePublicCapabilities;
  private readonly domains = new Map<string, MobileControlPlaneDomain>();
  private readonly listeners = new Set<() => void>();
  private readonly transientDemands = new Map<symbol, AiSessionTransientSubscription>();
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
  private readonly reconnectBackoff = new MobileReconnectBackoff();
  private desiredSignature = '';
  private reconcileQueued = false;
  private snapshotValue: RuntimeSnapshot = { phase: 'idle' };

  constructor(
    readonly profile: MobileControlPlaneProfile,
    readonly api: ControlPlaneClient,
    readonly transport: MobileControlPlaneTransport,
  ) {
    this.currentCapabilities = profile.capabilities;
  }

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

  registerAiSessionTransientDemand(input: AiSessionTransientSubscription) {
    const token = Symbol('mobile-ai-session-transient-demand');
    this.transientDemands.set(token, AiSessionTransientSubscriptionSchema.parse(input));
    this.updateTransientDemand();
    return () => {
      this.transientDemands.delete(token);
      this.updateTransientDemand();
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
      this.publish({ phase: this.reconnectBackoff.attempts ? 'reconnecting' : 'verifying' });
      await this.transport.revalidate?.();
      if (!this.live(epoch, abortController)) return;
      const auth = await this.api.auth.session(abortController.signal);
      if (!auth.authenticated) {
        this.publish({ phase: 'session-expired', error: 'The mobile Control Plane session expired.' });
        return;
      }
      const identity = await this.api.auth.identity?.().catch(() => undefined);
      const payload = identity?.data.payload;
      if (payload?.controlPlaneId === this.profile.identity.controlPlaneId
        && payload.publicKey.fingerprint === this.profile.identity.publicKeyFingerprint) {
        this.currentCapabilities = payload.capabilities;
      }
      this.publish({ phase: this.reconnectBackoff.attempts ? 'reconnecting' : 'loading' });
      await Promise.all(desired.map((domain) => domain.start(abortController.signal)));
      if (!this.live(epoch, abortController)) return;
      const topics = [...new Set(desired.flatMap((domain) => [...domain.topics]))].sort();
      const aiSessionTransient = this.aggregateTransientDemand();
      this.connection = this.transport.connectEvents({
        topics,
        aiSessionTransient: {
          ...aiSessionTransient,
          ...(this.transientDemands.size ? { replaySince: new Date().toISOString() } : {}),
        },
        onOpen: () => {
          if (!this.live(epoch, abortController)) return;
          this.clearConnectTimer();
          this.publish({ phase: 'connected' });
          this.stableTimer = setTimeout(() => {
            if (this.live(epoch, abortController)) this.reconnectBackoff.reset();
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

  private updateTransientDemand() {
    this.connection?.updateAiSessionTransient?.({
      ...this.aggregateTransientDemand(),
      ...(this.transientDemands.size ? { replaySince: new Date().toISOString() } : {}),
    });
  }

  private aggregateTransientDemand(): AiSessionTransientSubscription {
    const instanceIds = new Set<string>();
    const timelineSessions = new Map<string, { instanceId: string; sessionId: string }>();
    let allInstances = false;
    let timelineAllSessions = false;
    let replaySince: string | undefined;
    for (const demand of this.transientDemands.values()) {
      allInstances ||= demand.messageDeltas.allInstances;
      timelineAllSessions ||= demand.timelineAllSessions;
      for (const instanceId of demand.messageDeltas.instanceIds) instanceIds.add(instanceId);
      for (const session of demand.timelineSessions) timelineSessions.set(`${session.instanceId}\0${session.sessionId}`, session);
      if (demand.replaySince && (!replaySince || demand.replaySince < replaySince)) replaySince = demand.replaySince;
    }
    return {
      ...(replaySince ? { replaySince } : {}),
      messageDeltas: { allInstances, instanceIds: [...instanceIds] },
      timelineAllSessions,
      timelineSessions: [...timelineSessions.values()],
    };
  }

  private scheduleReconnect(epoch: number, abortController: AbortController, error?: string) {
    if (!this.live(epoch, abortController) || this.reconnectTimer) return;
    this.clearConnectTimer();
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    this.publish({ phase: 'reconnecting', ...(error ? { error } : {}) });
    const { delay } = this.reconnectBackoff.next();
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

type DirectClient = ReturnType<typeof createMobileControlPlaneClient>;

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
  createClient: (profile) => createMobileControlPlaneClient(profile, mobileSecureStore),
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
  profile?: MobileControlPlaneProfile;
  triggerCapability: boolean;
  storyCapability: boolean;
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
  const activeCarPlayConnected = active?.coordinator.isCarPlayConnected() ?? false;
  const activePhase = active?.coordinator.snapshot().phase ?? 'idle';
  const value = useMemo<MobileControlPlaneRuntimeValue>(() => ({
    api: active?.direct.api,
    carPlayConnected: activeCarPlayConnected,
    controlPlaneId: active?.profile.identity.controlPlaneId,
    controlPlaneOrigin: active?.profile.access.kind === 'direct' ? active.profile.access.origin : undefined,
    coordinator: active?.coordinator,
    phase: activePhase,
    profile: active?.profile,
    triggerCapability: (active?.coordinator.currentCapabilities.triggers ?? active?.direct.transport.currentCapabilities?.triggers ?? active?.profile.capabilities.triggers) === true,
    storyCapability: (active?.coordinator.currentCapabilities.stories ?? active?.direct.transport.currentCapabilities?.stories ?? active?.profile.capabilities.stories) === true,
    transport: active?.direct.transport,
  }), [active, activeCarPlayConnected, activePhase]);
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
