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
import {
  MOBILE_CONTROL_PLANE_CLOSED_MESSAGE,
  MobileControlPlaneTransportError,
  mobileControlPlaneClosedErrorCode,
} from './transport';
import { diagnosticErrorDetails, diagnosticLog } from '../observability/diagnostic-logs';
import type {
  MobileControlPlaneEvent,
  MobileControlPlaneEventConnection,
  MobileControlPlaneTransport,
} from './transport';

export type MobileControlPlaneRuntimePhase =
  | 'idle'
  | 'verifying'
  | 'loading'
  | 'connected'
  | 'reconnecting'
  | 'control-plane-closed'
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
const IDEMPOTENCY_PENDING_RECONNECT_DELAY_MS = 10_000;
const MOBILE_SESSION_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
const MINIMUM_MOBILE_SESSION_RENEWAL_DELAY_MS = 60_000;

export class MobileControlPlaneConnectionCoordinator {
  currentCapabilities: ControlPlanePublicCapabilities;
  private readonly domains = new Map<string, MobileControlPlaneDomain>();
  private readonly listeners = new Set<() => void>();
  private readonly transientDemands = new Map<symbol, AiSessionTransientSubscription>();
  private activeDomains: MobileControlPlaneDomain[] = [];
  private connection?: MobileControlPlaneEventConnection;
  private abortController?: AbortController;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private mobileSessionRenewalTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private stableTimer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private connectionSequence = 0;
  private foreground = false;
  private connected = true;
  private controlPlaneClosed = false;
  private carPlayConnected = false;
  private readonly reconnectBackoff = new MobileReconnectBackoff();
  private desiredSignature = '';
  private reconcileQueued = false;
  private pendingReconcileMode: 'domains' | 'environment' = 'environment';
  private mobileSessionRenewalSupported = true;
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
    this.queueReconcile('domains');
    return () => {
      if (this.domains.get(domain.key) !== domain) return;
      this.domains.delete(domain.key);
      this.queueReconcile('domains');
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
    this.queueReconcile('environment');
  }

  isCarPlayConnected() { return this.carPlayConnected; }

  stop() {
    this.desiredSignature = '';
    this.controlPlaneClosed = false;
    this.epoch += 1;
    this.clearTimers();
    this.abortController?.abort();
    this.abortController = undefined;
    this.connection?.close();
    this.connection = undefined;
    for (const domain of this.activeDomains) domain.stop();
    this.activeDomains = [];
    this.transport.suspend?.();
    this.publish({ phase: 'idle' });
  }

  private queueReconcile(mode: 'domains' | 'environment' = 'environment') {
    if (this.reconcileQueued) {
      if (mode === 'environment') this.pendingReconcileMode = 'environment';
      return;
    }
    this.reconcileQueued = true;
    this.pendingReconcileMode = mode;
    queueMicrotask(() => {
      const pendingMode = this.pendingReconcileMode;
      this.reconcileQueued = false;
      this.pendingReconcileMode = 'environment';
      this.reconcile(false, pendingMode);
    });
  }

  private reconcile(force = false, mode: 'domains' | 'environment' = 'environment') {
    const desired = this.connected
      ? [...this.domains.values()].filter((domain) => this.foreground || (this.carPlayConnected && domain.background))
      : [];
    const signature = desired.map((domain) => domain.key).sort().join('\u0000');
    if (!force && signature === this.desiredSignature) return;
    this.desiredSignature = signature;
    if (!force && mode === 'domains' && this.connected && this.connection && this.abortController && !this.abortController.signal.aborted) {
      // Route-scoped domains come and go as the user navigates. They share the
      // already authenticated transport, so applying a delta must not replace a
      // healthy Relay channel or reset in-flight reads.
      if (this.snapshotValue.phase === 'reconnecting') return;
      if (this.snapshotValue.phase === 'connected') {
        void this.applyDomainDelta(desired);
        return;
      }
    }
    void this.restart(desired);
  }

  private async applyDomainDelta(desired: MobileControlPlaneDomain[]) {
    const desiredKeys = new Set(desired.map((domain) => domain.key));
    const activeKeys = new Set(this.activeDomains.map((domain) => domain.key));
    for (const domain of this.activeDomains) {
      if (!desiredKeys.has(domain.key)) domain.stop();
    }
    const added = desired.filter((domain) => !activeKeys.has(domain.key));
    this.activeDomains = desired;

    const abortController = this.abortController;
    if (!abortController || abortController.signal.aborted) return;
    const topics = [...new Set(desired.flatMap((domain) => [...domain.topics]))].sort();
    this.connection?.updateTopics?.(topics);
    await Promise.all(added.map(async (domain) => {
      try {
        await domain.start(abortController.signal);
      } catch (cause) {
        // A newly opened route must never tear down an otherwise healthy shared
        // connection. Its cached view stays visible and its own retry policy owns
        // the failed read.
        domain.onConnectionError?.(cause instanceof Error
          ? new MobileControlPlaneTransportError('CONTROL_PLANE_DOMAIN_START_FAILED', cause.message, true)
          : undefined);
      }
    }));
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
      this.transport.suspend?.();
      for (const domain of this.domains.values()) domain.offline?.();
      diagnosticLog.info('runtime.connect.skipped', { reason: 'offline', previousPhase: this.snapshotValue.phase });
      this.publish({ phase: 'offline' });
      return;
    }
    if (!desired.length) {
      this.transport.suspend?.();
      diagnosticLog.info('runtime.connect.skipped', { reason: 'no-domains', previousPhase: this.snapshotValue.phase });
      this.publish({ phase: 'idle' });
      return;
    }
    const connectionId = `runtime_${Date.now().toString(36)}_${++this.connectionSequence}`;
    const startedAt = Date.now();
    diagnosticLog.info('runtime.connect.start', {
      connectionId,
      accessKind: this.profile.access.kind,
      reconnectAttempts: this.reconnectBackoff.attempts,
      domains: desired.length,
      domainKeys: desired.map((domain) => domain.key).sort(),
      foreground: this.foreground,
      carPlayConnected: this.carPlayConnected,
    });
    const abortController = new AbortController();
    this.abortController = abortController;
    try {
      this.publish({ phase: this.controlPlaneClosed
        ? 'control-plane-closed'
        : this.reconnectBackoff.attempts ? 'reconnecting' : 'verifying' });
      await this.revalidateTransport(abortController.signal);
      diagnosticLog.info('runtime.transport.ready', { connectionId, durationMs: Date.now() - startedAt, reconnectAttempts: this.reconnectBackoff.attempts });
      if (!this.live(epoch, abortController)) return;
      if (this.profile.access.kind === 'direct' && this.mobileSessionRenewalSupported) {
        try {
          const renewal = await this.api.auth.renewMobileSession(abortController.signal);
          if (!this.live(epoch, abortController)) return;
          this.scheduleMobileSessionRenewal(renewal.expiresAt);
        } catch (cause) {
          // Compatibility for v0.0.28: older Control Planes do not expose mobile session renewal.
          const fallback = mobileRenewalFallback(cause);
          if (!fallback) throw cause;
          if (fallback === 'unsupported') this.mobileSessionRenewalSupported = false;
        }
      }
      if (!this.live(epoch, abortController)) return;
      const auth = await this.api.auth.session(abortController.signal);
      if (!this.live(epoch, abortController)) return;
      if (!auth.authenticated) {
        this.publish({ phase: 'session-expired', error: 'The mobile Control Plane session expired.' });
        return;
      }
      const identity = await this.api.auth.identity?.().catch(() => undefined);
      if (!this.live(epoch, abortController)) return;
      const payload = identity?.data.payload;
      if (payload?.controlPlaneId === this.profile.identity.controlPlaneId
        && payload.publicKey.fingerprint === this.profile.identity.publicKeyFingerprint) {
        this.currentCapabilities = payload.capabilities;
      }
      this.publish({ phase: this.controlPlaneClosed
        ? 'control-plane-closed'
        : this.reconnectBackoff.attempts ? 'reconnecting' : 'loading' });
      await Promise.all(desired.map((domain) => domain.start(abortController.signal)));
      if (!this.live(epoch, abortController)) return;
      const topics = [...new Set(desired.flatMap((domain) => [...domain.topics]))].sort();
      const aiSessionTransient = this.aggregateTransientDemand();
      this.connection = this.transport.connectEvents({
        topics,
        aiSessionTransient,
        onOpen: () => {
          if (!this.live(epoch, abortController)) return;
          this.clearConnectTimer();
          this.controlPlaneClosed = false;
          diagnosticLog.info('runtime.connected', { connectionId, durationMs: Date.now() - startedAt, reconnectAttempts: this.reconnectBackoff.attempts });
          this.publish({ phase: 'connected' });
          this.stableTimer = setTimeout(() => {
            if (this.live(epoch, abortController)) this.reconnectBackoff.reset();
          }, STABLE_CONNECTION_MS);
        },
        onEvent: (event) => {
          if (!this.live(epoch, abortController)) return;
          for (const domain of this.activeDomains) domain.onEvent(event);
        },
        onError: (error) => {
          if (!this.live(epoch, abortController)) return;
          diagnosticLog.warn('runtime.connection.failed', { connectionId, phase: this.snapshotValue.phase, durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) });
          for (const domain of this.activeDomains) domain.onConnectionError?.(error);
          this.scheduleReconnect(epoch, abortController, error);
        },
        onClose: () => {
          if (!this.live(epoch, abortController)) return;
          diagnosticLog.warn('runtime.connection.closed', { connectionId, phase: this.snapshotValue.phase, durationMs: Date.now() - startedAt });
          for (const domain of this.activeDomains) domain.onConnectionError?.();
          this.scheduleReconnect(epoch, abortController);
        },
      });
      this.connectTimer = setTimeout(() => {
        if (!this.live(epoch, abortController) || this.snapshotValue.phase === 'connected') return;
        diagnosticLog.warn('runtime.connect.timeout', { connectionId, timeoutMs: CONNECT_TIMEOUT_MS, phase: this.snapshotValue.phase, durationMs: Date.now() - startedAt });
        this.connection?.close();
        this.scheduleReconnect(epoch, abortController, 'The Control Plane event connection timed out.');
      }, CONNECT_TIMEOUT_MS);
    } catch (cause) {
      if (!this.live(epoch, abortController)) return;
      diagnosticLog.error('runtime.connect.failed', { connectionId, durationMs: Date.now() - startedAt, phase: this.snapshotValue.phase, ...diagnosticErrorDetails(cause) });
      const connectionError = mobileConnectionError(cause);
      for (const domain of desired) domain.onConnectionError?.(connectionError);
      this.scheduleReconnect(epoch, abortController, cause);
    }
  }

  private updateTransientDemand() {
    const next = this.aggregateTransientDemand();
    this.connection?.updateAiSessionTransient?.(next);
  }

  private aggregateTransientDemand(): AiSessionTransientSubscription {
    const instanceIds = new Set<string>();
    const timelineSessions = new Map<string, { instanceId: string; sessionId: string }>();
    let allInstances = false;
    let timelineAllSessions = false;
    for (const demand of this.transientDemands.values()) {
      allInstances ||= demand.messageDeltas.allInstances;
      timelineAllSessions ||= demand.timelineAllSessions;
      for (const instanceId of demand.messageDeltas.instanceIds) instanceIds.add(instanceId);
      for (const session of demand.timelineSessions) timelineSessions.set(`${session.instanceId}\0${session.sessionId}`, session);
    }
    return {
      messageDeltas: { allInstances, instanceIds: [...instanceIds] },
      timelineAllSessions,
      timelineSessions: [...timelineSessions.values()],
    };
  }

  private scheduleReconnect(epoch: number, abortController: AbortController, cause?: unknown) {
    if (!this.live(epoch, abortController) || this.reconnectTimer) return;
    this.clearConnectTimer();
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    const closedCode = mobileControlPlaneClosedErrorCode(cause);
    if (closedCode) {
      this.controlPlaneClosed = true;
      diagnosticLog.warn('runtime.control_plane.closed', { code: closedCode, phase: this.snapshotValue.phase });
    }
    const error = this.controlPlaneClosed
      ? MOBILE_CONTROL_PLANE_CLOSED_MESSAGE
      : cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined;
    this.publish(this.controlPlaneClosed
      ? { phase: 'control-plane-closed', error }
      : { phase: 'reconnecting', ...(error ? { error } : {}) });
    const backoff = this.reconnectBackoff.next();
    const delay = Math.max(backoff.delay, idempotencyPendingError(cause) ? IDEMPOTENCY_PENDING_RECONNECT_DELAY_MS : 0);
    diagnosticLog.warn('runtime.reconnect.scheduled', { attempt: backoff.attempt, delayMs: delay, errorPresent: Boolean(error) });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.live(epoch, abortController)) return;
      this.reconcile(true);
    }, delay);
  }

  private revalidateTransport(signal: AbortSignal) {
    // Each runtime epoch owns its reconnect attempt. Coalescing this across epochs
    // can make a foreground restart wait forever on an attempt frozen by iOS.
    return Promise.resolve(this.transport.revalidate?.(signal));
  }

  private live(epoch: number, abortController: AbortController) {
    return epoch === this.epoch && this.abortController === abortController && !abortController.signal.aborted;
  }

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  private scheduleMobileSessionRenewal(expiresAt: string) {
    if (this.mobileSessionRenewalTimer) clearTimeout(this.mobileSessionRenewalTimer);
    const delay = Math.max(
      MINIMUM_MOBILE_SESSION_RENEWAL_DELAY_MS,
      Date.parse(expiresAt) - Date.now() - MOBILE_SESSION_RENEWAL_WINDOW_MS,
    );
    this.mobileSessionRenewalTimer = setTimeout(() => {
      this.mobileSessionRenewalTimer = undefined;
      if (this.desiredSignature) this.reconcile(true);
    }, delay);
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.mobileSessionRenewalTimer) clearTimeout(this.mobileSessionRenewalTimer);
    this.reconnectTimer = undefined;
    this.stableTimer = undefined;
    this.mobileSessionRenewalTimer = undefined;
    this.clearConnectTimer();
  }

  private publish(snapshot: RuntimeSnapshot) {
    if (this.snapshotValue.phase === snapshot.phase && this.snapshotValue.error === snapshot.error) return;
    diagnosticLog.info('runtime.phase', { phase: snapshot.phase, previousPhase: this.snapshotValue.phase, errorPresent: Boolean(snapshot.error) });
    this.snapshotValue = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function idempotencyPendingError(error: unknown) {
  return String((error as { code?: unknown } | null)?.code ?? '') === 'IDEMPOTENCY_REQUEST_IN_PROGRESS';
}

function mobileConnectionError(cause: unknown) {
  if (cause instanceof MobileControlPlaneTransportError) return cause;
  if (!cause || typeof cause !== 'object') return undefined;
  const code = 'code' in cause && typeof (cause as { code?: unknown }).code === 'string'
    ? String((cause as { code: string }).code)
    : 'CONTROL_PLANE_CONNECTION_FAILED';
  const message = cause instanceof Error && cause.message ? cause.message : 'The Control Plane connection failed.';
  const status = 'status' in cause && typeof (cause as { status?: unknown }).status === 'number'
    ? Number((cause as { status: number }).status)
    : undefined;
  return new MobileControlPlaneTransportError(code, message, true, status);
}

function mobileRenewalFallback(cause: unknown) {
  if (!cause || typeof cause !== 'object') return undefined;
  const status = 'status' in cause && typeof cause.status === 'number' ? cause.status : undefined;
  if (status === 404 || status === 405) return 'unsupported' as const;
  if (status === 401 || status === 403) return 'unauthorized' as const;
  return undefined;
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
