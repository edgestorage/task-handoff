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
import type { CloudClientTrustOutcome } from '@task-handoff/cloud-contracts/mobile';

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
import { isMobileDeviceTrustError } from './device-trust-error';
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
  | 'waiting-device-approval'
  | 'approved-connecting'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'trust-required'
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

export type MobileControlPlaneRuntimeSnapshot = {
  phase: MobileControlPlaneRuntimePhase;
  error?: string;
  deviceTrust?: CloudClientTrustOutcome;
};

const CONNECT_TIMEOUT_MS = 12_000;
const STABLE_CONNECTION_MS = 15_000;
const IDEMPOTENCY_PENDING_RECONNECT_DELAY_MS = 10_000;
const DEVICE_TRUST_RETRY_INITIAL_MS = 2_000;
const DEVICE_TRUST_RETRY_MAX_MS = 30_000;
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
  private deviceTrustTimer?: ReturnType<typeof setTimeout>;
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
  private domainSyncPending = false;
  private mobileSessionRenewalSupported = true;
  private deviceTrustValue?: CloudClientTrustOutcome;
  private deviceTrustTerminal = false;
  private deviceTrustRetryAttempt = 0;
  private snapshotValue: MobileControlPlaneRuntimeSnapshot = { phase: 'idle' };

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
    diagnosticLog.info('runtime.domain.registered', {
      domainKey: domain.key,
      foreground: this.foreground,
      connected: this.connected,
      phase: this.snapshotValue.phase,
    });
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
    this.domainSyncPending = false;
    this.controlPlaneClosed = false;
    this.deviceTrustValue = undefined;
    this.deviceTrustTerminal = false;
    this.deviceTrustRetryAttempt = 0;
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

  /** Re-arms one user-initiated trust attempt after a terminal decision. */
  retryDeviceTrust() {
    if (!this.deviceTrustTerminal || this.snapshotValue.phase === 'trust-required') return false;
    this.transport.authorizeDeviceTrustRetry?.();
    this.deviceTrustTerminal = false;
    this.deviceTrustValue = undefined;
    this.deviceTrustRetryAttempt = 0;
    this.reconnectBackoff.reset();
    diagnosticLog.info('runtime.device_trust.retry', { previousPhase: this.snapshotValue.phase });
    this.reconcile(true);
    return true;
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
    const desired = this.desiredDomains();
    const signature = desired.map((domain) => domain.key).sort().join('\u0000');
    if (!force && signature === this.desiredSignature) return;
    this.desiredSignature = signature;
    if (!force && mode === 'domains' && this.connected && this.abortController && !this.abortController.signal.aborted) {
      // Route-scoped domains come and go as the user navigates. They share the
      // already authenticated transport, so applying a delta must not replace a
      // healthy Relay channel or reset in-flight reads.
      if (this.snapshotValue.phase === 'connected') {
        void this.applyDomainDelta(desired);
        return;
      }
      // Startup already owns the one authentication and socket attempt. A route
      // that appears while that attempt is verifying or loading joins the
      // pending domain set instead of aborting reads that are already in flight.
      if (this.snapshotValue.phase !== 'session-expired' && this.snapshotValue.phase !== 'offline') {
        this.domainSyncPending = true;
        return;
      }
    }
    void this.restart(desired);
  }

  private desiredDomains() {
    return this.connected
      ? [...this.domains.values()].filter((domain) => this.foreground || (this.carPlayConnected && domain.background))
      : [];
  }

  private async startDomains(abortController: AbortController, started: Set<string>) {
    const desired = this.desiredDomains();
    const desiredKeys = new Set(desired.map((domain) => domain.key));
    for (const domain of this.activeDomains) {
      if (!desiredKeys.has(domain.key)) domain.stop();
    }
    this.activeDomains = desired;
    this.domainSyncPending = false;
    await Promise.all(desired.filter((domain) => !started.has(domain.key)).map(async (domain) => {
      started.add(domain.key);
      await domain.start(abortController.signal);
    }));
  }

  private async applyDomainDelta(desired: MobileControlPlaneDomain[]) {
    this.domainSyncPending = false;
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
    this.domainSyncPending = false;
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
    if (this.deviceTrustTerminal && this.deviceTrustValue) {
      this.transport.suspend?.();
      diagnosticLog.info('runtime.connect.skipped', { reason: 'device-trust-terminal', previousPhase: this.snapshotValue.phase, trustState: this.deviceTrustValue.state });
      this.publishTrustOutcome(this.deviceTrustValue);
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
      this.publish(this.deviceTrustValue?.state === 'pending'
        ? { phase: 'waiting-device-approval', deviceTrust: this.deviceTrustValue }
        : { phase: this.controlPlaneClosed
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
      this.publish(this.deviceTrustValue?.state === 'pending'
        ? { phase: 'approved-connecting', deviceTrust: this.deviceTrustValue }
        : { phase: this.controlPlaneClosed
          ? 'control-plane-closed'
          : this.reconnectBackoff.attempts ? 'reconnecting' : 'loading' });
      const started = new Set<string>();
      await this.startDomains(abortController, started);
      if (!this.live(epoch, abortController)) return;
      if (this.domainSyncPending) {
        await this.startDomains(abortController, started);
        if (!this.live(epoch, abortController)) return;
      }
      if (!this.activeDomains.length) {
        this.transport.suspend?.();
        diagnosticLog.info('runtime.connect.skipped', { reason: 'no-domains', previousPhase: this.snapshotValue.phase });
        this.publish({ phase: 'idle' });
        return;
      }
      const topics = [...new Set(this.activeDomains.flatMap((domain) => [...domain.topics]))].sort();
      const aiSessionTransient = this.aggregateTransientDemand();
      this.connection = this.transport.connectEvents({
        topics,
        aiSessionTransient,
        onOpen: () => {
          if (!this.live(epoch, abortController)) return;
          this.clearConnectTimer();
          this.controlPlaneClosed = false;
          if (this.domainSyncPending) void this.applyDomainDelta(this.desiredDomains());
          diagnosticLog.info('runtime.connected', { connectionId, durationMs: Date.now() - startedAt, reconnectAttempts: this.reconnectBackoff.attempts });
          this.deviceTrustValue = undefined;
          this.deviceTrustTerminal = false;
          this.deviceTrustRetryAttempt = 0;
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
      if (isMobileDeviceTrustError(cause)) {
        this.handleDeviceTrustOutcome(cause.outcome, epoch, abortController);
        return;
      }
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
    if (isMobileDeviceTrustError(cause)) {
      this.handleDeviceTrustOutcome(cause.outcome, epoch, abortController);
      return;
    }
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

  private handleDeviceTrustOutcome(outcome: CloudClientTrustOutcome, epoch: number, abortController: AbortController) {
    if (!this.live(epoch, abortController)) return;
    this.clearConnectTimer();
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.deviceTrustTimer) clearTimeout(this.deviceTrustTimer);
    this.stableTimer = undefined;
    this.reconnectTimer = undefined;
    this.deviceTrustTimer = undefined;
    this.reconnectBackoff.reset();
    this.deviceTrustValue = outcome;
    if (outcome.state === 'pending') {
      this.deviceTrustTerminal = false;
      diagnosticLog.info('runtime.device_trust.pending', {
        requestId: outcome.requestId,
        reason: outcome.reason,
        retryAttempt: this.deviceTrustRetryAttempt,
        expiresInMs: Date.parse(outcome.expiresAt) - Date.now(),
      });
      this.publishTrustOutcome(outcome);
      this.scheduleDeviceTrustRetry(epoch, abortController, outcome);
      return;
    }
    this.deviceTrustTerminal = true;
    this.deviceTrustRetryAttempt = 0;
    diagnosticLog.warn('runtime.device_trust.terminal', { state: outcome.state, reason: outcome.reason, requestId: outcome.requestId });
    this.publishTrustOutcome(outcome);
  }

  private scheduleDeviceTrustRetry(epoch: number, abortController: AbortController, outcome: CloudClientTrustOutcome) {
    const remainingMs = Date.parse(outcome.expiresAt) - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      this.deviceTrustTerminal = true;
      this.publish({ phase: 'expired', deviceTrust: outcome });
      return;
    }
    const retryDelayMs = Math.min(
      DEVICE_TRUST_RETRY_MAX_MS,
      DEVICE_TRUST_RETRY_INITIAL_MS * (2 ** Math.min(this.deviceTrustRetryAttempt, 5)),
      remainingMs,
    );
    this.deviceTrustRetryAttempt += 1;
    diagnosticLog.info('runtime.device_trust.retry_scheduled', { retryAttempt: this.deviceTrustRetryAttempt, retryDelayMs, remainingMs });
    this.deviceTrustTimer = setTimeout(() => {
      this.deviceTrustTimer = undefined;
      if (!this.live(epoch, abortController)) return;
      if (Date.parse(outcome.expiresAt) <= Date.now()) {
        this.deviceTrustTerminal = true;
        diagnosticLog.warn('runtime.device_trust.expired', { requestId: outcome.requestId });
        this.publish({ phase: 'expired', deviceTrust: outcome });
        return;
      }
      this.reconcile(true);
    }, retryDelayMs);
  }

  private publishTrustOutcome(outcome: CloudClientTrustOutcome) {
    const phase = outcome.state === 'pending' ? 'waiting-device-approval' : outcome.state;
    this.publish({ phase, deviceTrust: outcome });
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
    if (this.deviceTrustTimer) clearTimeout(this.deviceTrustTimer);
    this.reconnectTimer = undefined;
    this.stableTimer = undefined;
    this.mobileSessionRenewalTimer = undefined;
    this.deviceTrustTimer = undefined;
    this.clearConnectTimer();
  }

  private publish(snapshot: MobileControlPlaneRuntimeSnapshot) {
    if (this.snapshotValue.phase === snapshot.phase
      && this.snapshotValue.error === snapshot.error
      && sameTrustOutcome(this.snapshotValue.deviceTrust, snapshot.deviceTrust)) return;
    diagnosticLog.info('runtime.phase', { phase: snapshot.phase, previousPhase: this.snapshotValue.phase, errorPresent: Boolean(snapshot.error) });
    this.snapshotValue = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function idempotencyPendingError(error: unknown) {
  return String((error as { code?: unknown } | null)?.code ?? '') === 'IDEMPOTENCY_REQUEST_IN_PROGRESS';
}

function sameTrustOutcome(left?: CloudClientTrustOutcome, right?: CloudClientTrustOutcome) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.state === right.state
    && left.reason === right.reason
    && left.requestId === right.requestId
    && left.issuedAt === right.issuedAt
    && left.expiresAt === right.expiresAt;
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
  deviceTrust?: CloudClientTrustOutcome;
  phase: MobileControlPlaneRuntimePhase;
  profile?: MobileControlPlaneProfile;
  retryDeviceTrust(): boolean;
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
      diagnosticLog.info('runtime.activation.start', { activation: currentActivation });
      const profile = await dependencies.activeProfile();
      if (!live || currentActivation !== activation) return;
      diagnosticLog.info('runtime.activation.profile', {
        activation: currentActivation,
        hasProfile: Boolean(profile),
        accessKind: profile?.access.kind,
        controlPlaneId: profile?.identity.controlPlaneId,
        foreground,
        connected,
      });
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
    void activate().catch((cause) => {
      diagnosticLog.error('runtime.activation.failed', diagnosticErrorDetails(cause));
    });
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
  const activeSnapshot = active?.coordinator.snapshot();
  const activePhase = activeSnapshot?.phase ?? 'idle';
  const activeDeviceTrust = activeSnapshot?.deviceTrust;
  const value = useMemo<MobileControlPlaneRuntimeValue>(() => ({
    api: active?.direct.api,
    carPlayConnected: activeCarPlayConnected,
    controlPlaneId: active?.profile.identity.controlPlaneId,
    controlPlaneOrigin: active?.profile.access.kind === 'direct' ? active.profile.access.origin : undefined,
    coordinator: active?.coordinator,
    deviceTrust: activeDeviceTrust,
    phase: activePhase,
    profile: active?.profile,
    retryDeviceTrust: () => active?.coordinator.retryDeviceTrust() ?? false,
    triggerCapability: (active?.coordinator.currentCapabilities.triggers ?? active?.direct.transport.currentCapabilities?.triggers ?? active?.profile.capabilities.triggers) === true,
    storyCapability: (active?.coordinator.currentCapabilities.stories ?? active?.direct.transport.currentCapabilities?.stories ?? active?.profile.capabilities.stories) === true,
    transport: active?.direct.transport,
  }), [active, activeCarPlayConnected, activeDeviceTrust, activePhase]);
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
