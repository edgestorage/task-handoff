import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { ControlPlaneTriggerTemplateInput } from '@task-handoff/protocol/triggers';

import type { MobileControlPlaneEvent, MobileControlPlaneTransportError } from '../control-plane/transport';
import { MobileTriggerStore } from './store';

export class MobileTriggerController {
  private epoch = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshInFlight?: Promise<void>;
  private refreshQueued = false;
  private signal?: AbortSignal;
  private readonly generation: number;

  constructor(private readonly controlPlaneId: string, private readonly client: ControlPlaneClient, private readonly store: MobileTriggerStore) {
    this.generation = store.generation(controlPlaneId);
  }

  async start(signal?: AbortSignal) {
    const epoch = ++this.epoch;
    this.signal = signal;
    const current = this.store.state(this.controlPlaneId);
    this.store.set(this.controlPlaneId, { phase: current.snapshot.triggers.length ? 'stale' : 'loading', error: undefined });
    try {
      const [snapshot, session] = await Promise.all([this.client.triggers.list(signal), this.client.auth.session(signal)]);
      if (!this.live(epoch)) return false;
      this.store.set(this.controlPlaneId, {
        snapshot,
        canMutate: !session.enabled || session.user?.role === 'admin' || session.user?.role === 'operator',
        phase: 'ready',
        error: undefined,
      });
      return true;
    } catch (cause) {
      if (!this.live(epoch)) return false;
      this.fail(cause);
      throw cause;
    }
  }

  stop() {
    this.epoch += 1;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshQueued = false;
    this.signal = undefined;
  }

  offline() {
    this.stop();
    if (this.store.isGeneration(this.controlPlaneId, this.generation)) this.store.set(this.controlPlaneId, { phase: 'offline', error: undefined });
  }

  onConnectionError(error?: MobileControlPlaneTransportError) {
    if (!this.store.isGeneration(this.controlPlaneId, this.generation)) return;
    this.store.set(this.controlPlaneId, { phase: 'stale', ...(error ? { error: error.message } : {}) });
  }

  applyEvent(event: MobileControlPlaneEvent) {
    if (event.topic !== 'triggers') return false;
    this.scheduleRefresh();
    return true;
  }

  async create(input: ControlPlaneTriggerTemplateInput) {
    this.requireMutation();
    const result = await this.client.triggers.create(input);
    await this.refresh();
    return result;
  }

  async update(configHash: string, input: ControlPlaneTriggerTemplateInput) {
    this.requireMutation();
    const result = await this.client.triggers.update(configHash, input);
    await this.refresh();
    return result;
  }

  async remove(configHash: string) {
    this.requireMutation();
    const result = await this.client.triggers.remove(configHash);
    await this.refresh();
    return result;
  }

  async bindSession(instanceId: string, sessionId: string, configHash: string) {
    this.requireMutation();
    const result = await this.client.triggers.bindSession(instanceId, sessionId, configHash);
    await this.refresh();
    return result;
  }

  async unbindSession(instanceId: string, sessionId: string, configHash: string) {
    this.requireMutation();
    const result = await this.client.triggers.unbindSession(instanceId, sessionId, configHash);
    await this.refresh();
    return result;
  }

  async run(instanceId: string, configHash: string, deploymentId?: string) {
    this.requireMutation();
    const result = await this.client.triggers.run(instanceId, configHash, deploymentId);
    await this.refresh();
    return result;
  }

  refresh() {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    const epoch = this.epoch;
    const request = this.client.triggers.list(this.signal).then((snapshot) => {
      if (this.live(epoch)) this.store.set(this.controlPlaneId, { snapshot, phase: 'ready', error: undefined });
    }).catch((cause) => {
      if (this.live(epoch)) this.fail(cause);
      throw cause;
    }).finally(() => {
      if (this.refreshInFlight !== request) return;
      this.refreshInFlight = undefined;
      if (!this.refreshQueued || !this.live(epoch)) return;
      this.refreshQueued = false;
      void this.refresh().catch(() => undefined);
    });
    this.refreshInFlight = request;
    return request;
  }

  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch(() => undefined);
    }, 100);
  }

  private live(epoch: number) {
    return epoch === this.epoch && !this.signal?.aborted && this.store.isGeneration(this.controlPlaneId, this.generation);
  }

  private requireMutation() {
    if (!this.store.state(this.controlPlaneId).canMutate) throw new Error('This account cannot change triggers.');
  }

  private fail(cause: unknown) {
    const current = this.store.state(this.controlPlaneId);
    this.store.set(this.controlPlaneId, {
      phase: current.snapshot.triggers.length ? 'stale' : 'error',
      error: cause instanceof Error ? cause.message : 'Triggers unavailable.',
    });
  }
}
