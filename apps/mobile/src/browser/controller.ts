import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import type { MobileControlPlaneProfile } from '../control-plane/profile';
import { activateMobileBrowserContext, prepareMobileBrowserContext, releaseBrowserContext } from '../control-plane/browser-context';
import { normalizeBrowserAddress } from './url';
import { MobileBrowserTabStore, mobileBrowserTabStore } from './store';
import { diagnosticLog } from '../observability/diagnostic-logs';
import { browserErrorDiagnostic, traceBrowserTask } from './diagnostics';
import { MobileReconnectBackoff } from '../platform/reconnect';

type ContextState = { contextId?: string; promise: Promise<string> };
type ContextDemand = {
  api: ControlPlaneClient;
  profile: MobileControlPlaneProfile;
  instanceId: string;
  backoff: MobileReconnectBackoff;
  retry?: ReturnType<typeof setTimeout>;
  recovering: boolean;
  readyAt?: number;
};

export class MobileBrowserController {
  private readonly contexts = new Map<string, ContextState>();
  private readonly releases = new Map<string, Promise<void>>();
  private readonly suspendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly active = new Map<string, ContextDemand>();

  constructor(private readonly store: MobileBrowserTabStore = mobileBrowserTabStore) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  async create(input: { api: ControlPlaneClient; profile: MobileControlPlaneProfile; instanceId: string; initialUrl?: string }) {
    const initialUrl = input.initialUrl ? normalizeBrowserAddress(input.initialUrl) : 'about:blank';
    const tab = this.store.create(input.profile.identity.controlPlaneId, input.instanceId, initialUrl);
    try {
      await this.ensureContext(input.api, input.profile, input.instanceId);
      return tab;
    } catch (error) {
      this.store.close(tab.controlPlaneId, tab.instanceId, tab.id);
      throw error;
    }
  }

  async close(controlPlaneId: string, instanceId: string, tabId: string) {
    if (!this.store.close(controlPlaneId, instanceId, tabId)) return false;
    if (!this.store.tabsFor(controlPlaneId, instanceId).length) {
      this.stopRecovery(contextKey(controlPlaneId, instanceId));
      await this.releaseContext(controlPlaneId, instanceId);
    }
    return true;
  }

  contextId(controlPlaneId: string, instanceId: string) { return this.contexts.get(contextKey(controlPlaneId, instanceId))?.contextId; }

  activate(api: ControlPlaneClient, profile: MobileControlPlaneProfile, instanceId: string) {
    const key = contextKey(profile.identity.controlPlaneId, instanceId);
    let demand = this.active.get(key);
    if (!demand || demand.api !== api || demand.profile !== profile) {
      this.stopRecovery(key);
      demand = { api, profile, instanceId, backoff: new MobileReconnectBackoff(), recovering: false };
      this.active.set(key, demand);
    }
    if (demand.retry) clearTimeout(demand.retry);
    demand.retry = undefined;
    const timer = this.suspendTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.suspendTimers.delete(key);
    }
    const requested = demand;
    return this.ensureContext(api, profile, instanceId, () => this.active.get(key) === requested).then((contextId) => {
      requested.readyAt ??= performance.now();
      return contextId;
    });
  }

  suspend(controlPlaneId: string, instanceId: string) {
    const key = contextKey(controlPlaneId, instanceId);
    // Stop connection demand immediately; retain the healthy context only for
    // the existing blur grace period. A background close must not reconnect.
    this.stopRecovery(key);
    if (!this.contexts.has(key) || this.suspendTimers.has(key)) return Promise.resolve();
    diagnosticLog.info('browser.suspend.scheduled', { controlPlaneId, instanceId, delayMs: 30_000 });
    const timer = setTimeout(() => {
      this.suspendTimers.delete(key);
      void this.releaseContext(controlPlaneId, instanceId);
    }, 30_000);
    this.suspendTimers.set(key, timer);
    return Promise.resolve();
  }

  async suspendAll() {
    for (const key of this.active.keys()) this.stopRecovery(key);
    for (const timer of this.suspendTimers.values()) clearTimeout(timer);
    this.suspendTimers.clear();
    const keys = [...this.contexts.keys()].map((key) => key.split('\u0000'));
    await Promise.all(keys.map(([controlPlaneId, instanceId]) => this.releaseContext(controlPlaneId, instanceId)));
  }

  async clearProfile(controlPlaneId: string) {
    for (const key of this.active.keys()) {
      if (key.startsWith(`${controlPlaneId}\u0000`)) this.stopRecovery(key);
    }
    for (const [key, timer] of this.suspendTimers) {
      if (key.startsWith(`${controlPlaneId}\u0000`)) {
        clearTimeout(timer);
        this.suspendTimers.delete(key);
      }
    }
    const instanceIds = this.store.clearProfile(controlPlaneId);
    await Promise.all(instanceIds.map((instanceId) => this.releaseContext(controlPlaneId, instanceId)));
  }

  private async ensureContext(api: ControlPlaneClient, profile: MobileControlPlaneProfile, instanceId: string, requested: () => boolean = () => true) {
    const key = contextKey(profile.identity.controlPlaneId, instanceId);
    const data = { controlPlaneId: profile.identity.controlPlaneId, instanceId };
    const generation = this.generations.get(key) ?? 0;
    const release = this.releases.get(key);
    await (release ? traceBrowserTask('browser.context.wait-release', data, () => release) : undefined);
    if (!requested() || (this.generations.get(key) ?? 0) !== generation) throw contextCancelled();
    const existing = this.contexts.get(key);
    if (existing) {
      diagnosticLog.info('browser.context.reuse', { ...data, contextId: existing.contextId, pending: !existing.contextId });
      const contextId = await traceBrowserTask('browser.context.wait-existing', data, () => existing.promise);
      if (!requested() || this.contexts.get(key) !== existing) throw contextCancelled();
      await activateMobileBrowserContext(contextId);
      if (!requested() || this.contexts.get(key) !== existing) throw contextCancelled();
      return contextId;
    }
    const state: ContextState = {
      promise: prepareMobileBrowserContext({ api, profile, instanceId, onClose: (error) => {
        diagnosticLog.info('browser.context.transport-closed', { ...data, contextId: state.contextId, current: this.contexts.get(key) === state, ...browserErrorDiagnostic(error) });
        // TCP streams cannot survive Relay rekey/reset. Drop this native context;
        // tabs retain their URLs and activation creates a fresh tunnel.
        if (this.contexts.get(key) !== state) return;
        const demand = this.active.get(key);
        void this.releaseContext(profile.identity.controlPlaneId, instanceId).then(() => {
          if (demand && this.active.get(key) === demand) this.scheduleRecovery(key, demand);
        }).catch((cause) => {
          diagnosticLog.warn('browser.context.release-failed', { ...data, ...browserErrorDiagnostic(cause) });
          if (demand && this.active.get(key) === demand) this.scheduleRecovery(key, demand);
        });
      } }).then(({ contextId }) => {
        state.contextId = contextId;
        diagnosticLog.info('browser.context.published', { ...data, contextId, current: this.contexts.get(key) === state });
        this.emit();
        return contextId;
      }).catch((error) => {
        diagnosticLog.warn('browser.context.failed', { ...data, ...browserErrorDiagnostic(error) });
        if (this.contexts.get(key) === state) this.contexts.delete(key);
        this.emit();
        throw error;
      }),
    };
    this.contexts.set(key, state);
    this.emit();
    return state.promise;
  }

  private stopRecovery(key: string) {
    const demand = this.active.get(key);
    if (demand?.retry) clearTimeout(demand.retry);
    this.active.delete(key);
  }

  private scheduleRecovery(key: string, demand: ContextDemand) {
    if (this.active.get(key) !== demand || demand.retry || demand.recovering) return;
    // Reset only after a stable connection. Rapid open/close cycles must keep
    // backing off, even when each handshake succeeds.
    if (demand.readyAt !== undefined && performance.now() - demand.readyAt >= 30_000) demand.backoff.reset();
    demand.readyAt = undefined;
    const scheduled = demand.backoff.next();
    const data = { controlPlaneId: demand.profile.identity.controlPlaneId, instanceId: demand.instanceId, ...scheduled };
    diagnosticLog.info('browser.reconnect.scheduled', data);
    // Failure-driven retry only: no periodic state checks or snapshot polling.
    demand.retry = setTimeout(() => {
      demand.retry = undefined;
      if (this.active.get(key) !== demand) return;
      demand.recovering = true;
      diagnosticLog.info('browser.reconnect.start', data);
      void this.ensureContext(demand.api, demand.profile, demand.instanceId, () => this.active.get(key) === demand).then((contextId) => {
        if (this.active.get(key) !== demand || this.contextId(demand.profile.identity.controlPlaneId, demand.instanceId) !== contextId) throw contextCancelled();
        demand.readyAt = performance.now();
        diagnosticLog.info('browser.reconnect.ready', { ...data, contextId });
      }).catch((error) => {
        diagnosticLog.warn('browser.reconnect.failed', { ...data, ...browserErrorDiagnostic(error) });
      }).finally(() => {
        demand.recovering = false;
        if (this.active.get(key) === demand && !this.contextId(demand.profile.identity.controlPlaneId, demand.instanceId)) this.scheduleRecovery(key, demand);
      });
    }, scheduled.delay);
  }

  private async releaseContext(controlPlaneId: string, instanceId: string) {
    const key = contextKey(controlPlaneId, instanceId);
    const timer = this.suspendTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.suspendTimers.delete(key);
    }
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    const state = this.contexts.get(key);
    if (!state) return;
    this.contexts.delete(key);
    diagnosticLog.info('browser.context.removed', { controlPlaneId, instanceId, contextId: state.contextId, pending: !state.contextId });
    const release = (async () => {
      const contextId = state.contextId ?? await traceBrowserTask('browser.context.wait-before-release', { controlPlaneId, instanceId }, () => state.promise).catch(() => undefined);
      if (contextId) await releaseBrowserContext(contextId);
    })().finally(() => { if (this.releases.get(key) === release) this.releases.delete(key); });
    this.releases.set(key, release);
    this.emit();
    await release;
  }

  private emit() { for (const listener of this.listeners) listener(); }
}

function contextKey(controlPlaneId: string, instanceId: string) { return `${controlPlaneId}\u0000${instanceId}`; }
function contextCancelled() { return Object.assign(new Error('Browser context preparation was cancelled.'), { code: 'BROWSER_CONTEXT_CANCELLED' }); }

export const mobileBrowserController = new MobileBrowserController();
