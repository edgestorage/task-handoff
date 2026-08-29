import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import type { MobileControlPlaneProfile } from '../control-plane/profile';
import { prepareMobileBrowserContext, releaseBrowserContext } from '../control-plane/browser-context';
import { normalizeBrowserAddress } from './url';
import { MobileBrowserTabStore, mobileBrowserTabStore } from './store';

type ContextState = { contextId?: string; promise: Promise<string> };

export class MobileBrowserController {
  private readonly contexts = new Map<string, ContextState>();
  private readonly releases = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

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
    if (!this.store.tabsFor(controlPlaneId, instanceId).length) await this.releaseContext(controlPlaneId, instanceId);
    return true;
  }

  contextId(controlPlaneId: string, instanceId: string) { return this.contexts.get(contextKey(controlPlaneId, instanceId))?.contextId; }

  activate(api: ControlPlaneClient, profile: MobileControlPlaneProfile, instanceId: string) {
    return this.ensureContext(api, profile, instanceId);
  }

  suspend(controlPlaneId: string, instanceId: string) {
    return this.releaseContext(controlPlaneId, instanceId);
  }

  async suspendAll() {
    const keys = [...this.contexts.keys()].map((key) => key.split('\u0000'));
    await Promise.all(keys.map(([controlPlaneId, instanceId]) => this.releaseContext(controlPlaneId, instanceId)));
  }

  async clearProfile(controlPlaneId: string) {
    const instanceIds = this.store.clearProfile(controlPlaneId);
    await Promise.all(instanceIds.map((instanceId) => this.releaseContext(controlPlaneId, instanceId)));
  }

  private async ensureContext(api: ControlPlaneClient, profile: MobileControlPlaneProfile, instanceId: string) {
    const key = contextKey(profile.identity.controlPlaneId, instanceId);
    await this.releases.get(key);
    const generation = this.generations.get(key) ?? 0;
    const existing = this.contexts.get(key);
    if (existing) return existing.promise;
    // Only the focused instance owns a mobile Browser context. This matches
    // Android's process-wide proxy boundary and also keeps iOS background tabs
    // from retaining idle relay channels.
    const otherKeys = [...this.contexts.keys()].filter((candidate) => candidate !== key).map((candidate) => candidate.split('\u0000'));
    await Promise.all(otherKeys.map(([controlPlaneId, otherInstanceId]) => this.releaseContext(controlPlaneId, otherInstanceId)));
    if ((this.generations.get(key) ?? 0) !== generation) throw Object.assign(new Error('Browser context preparation was cancelled.'), { code: 'BROWSER_CONTEXT_CANCELLED' });
    const state: ContextState = {
      promise: prepareMobileBrowserContext({ api, profile, instanceId }).then(({ contextId }) => {
        state.contextId = contextId;
        this.emit();
        return contextId;
      }).catch((error) => {
        if (this.contexts.get(key) === state) this.contexts.delete(key);
        this.emit();
        throw error;
      }),
    };
    this.contexts.set(key, state);
    this.emit();
    return state.promise;
  }

  private async releaseContext(controlPlaneId: string, instanceId: string) {
    const key = contextKey(controlPlaneId, instanceId);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    const state = this.contexts.get(key);
    if (!state) return;
    this.contexts.delete(key);
    this.emit();
    const release = (async () => {
      const contextId = state.contextId ?? await state.promise.catch(() => undefined);
      if (contextId) await releaseBrowserContext(contextId);
    })().finally(() => { if (this.releases.get(key) === release) this.releases.delete(key); });
    this.releases.set(key, release);
    await release;
  }

  private emit() { for (const listener of this.listeners) listener(); }
}

function contextKey(controlPlaneId: string, instanceId: string) { return `${controlPlaneId}\u0000${instanceId}`; }

export const mobileBrowserController = new MobileBrowserController();
