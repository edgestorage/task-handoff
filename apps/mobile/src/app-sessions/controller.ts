import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import {
  AppSessionEventType,
  AppSessionPatchEventSchema,
  AppSessionRemovedEventSchema,
  AppSessionSnapshotEventSchema,
  type AppSessionStreamEvent,
} from '@task-handoff/protocol/app-sessions';
import { safeParseResponse } from '@task-handoff/protocol/response-validation';

import type { MobileControlPlaneEvent, MobileControlPlaneEventConnection, MobileControlPlaneTransport } from '../control-plane/transport';
import { MobileAppSessionStore } from './store';

export class MobileAppSessionController {
  private connection?: MobileControlPlaneEventConnection;
  private epoch = 0;
  private readonly recoveries = new Map<string, Promise<void>>();
  private readonly generation: number;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly id: string, private readonly client: ControlPlaneClient, private readonly transport: MobileControlPlaneTransport, private readonly store: MobileAppSessionStore) {
    this.generation = store.generation(id);
  }
  async start(signal?: AbortSignal) {
    if (!this.store.isGeneration(this.id, this.generation)) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const epoch = ++this.epoch;
    const current = this.store.profile(this.id);
    this.store.setSyncState(this.id, { phase: current.snapshot ? 'stale' : 'loading', lastSyncedAt: current.sync.lastSyncedAt });
    try {
      await this.transport.revalidate?.();
      const snapshot = await this.client.appSessions.list(signal);
      if (!this.live(epoch)) return;
      this.store.replaceSnapshot(this.id, snapshot);
      this.reconnectAttempt = 0;
    } catch (cause) {
      if (this.live(epoch)) this.store.setSyncState(this.id, {
        phase: this.store.profile(this.id).snapshot ? 'stale' : 'error',
        lastSyncedAt: this.store.profile(this.id).sync.lastSyncedAt,
        error: cause instanceof Error ? cause.message : 'Could not load App Sessions.',
      });
      this.scheduleReconnect(epoch);
      throw cause;
    }
    if (!this.live(epoch)) return;
    this.connection?.close();
    this.connection = this.transport.connectEvents({
      onOpen() {},
      onEvent: (event) => { if (this.live(epoch)) this.applyEvent(event); },
      onError: (error) => {
        if (this.live(epoch)) this.store.setSyncState(this.id, { phase: 'stale', lastSyncedAt: this.store.profile(this.id).sync.lastSyncedAt, error: error.message });
        this.scheduleReconnect(epoch);
      },
      onClose: () => {
        if (this.live(epoch)) this.store.setSyncState(this.id, { phase: 'stale', lastSyncedAt: this.store.profile(this.id).sync.lastSyncedAt });
        this.scheduleReconnect(epoch);
      },
    });
  }
  stop() {
    this.epoch += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectAttempt = 0;
    this.connection?.close();
    this.connection = undefined;
    this.recoveries.clear();
  }
  offline() { this.stop(); this.store.setSyncState(this.id, { phase: 'offline', lastSyncedAt: this.store.profile(this.id).sync.lastSyncedAt }); }
  applyEvent(event: MobileControlPlaneEvent) {
    if (event.topic && event.topic !== 'app.sessions') return false;
    const schemas = {
      [AppSessionEventType.Snapshot]: AppSessionSnapshotEventSchema,
      [AppSessionEventType.Patch]: AppSessionPatchEventSchema,
      [AppSessionEventType.Removed]: AppSessionRemovedEventSchema,
    } as const;
    const schema = schemas[event.type as keyof typeof schemas];
    if (!schema) return false;
    const parsed = safeParseResponse(schema, event.payload);
    if (!parsed.success || event.scope?.instanceId !== parsed.data.meta.instanceId) return false;
    const result = this.store.applyStreamEvent(this.id, { type: event.type, payload: parsed.data } as AppSessionStreamEvent);
    if (result.kind === 'gap' || result.kind === 'snapshot-required') void this.recover(parsed.data.meta.instanceId);
    return result.kind === 'applied';
  }
  private recover(instanceId: string) {
    const active = this.recoveries.get(instanceId);
    if (active) return active;
    const recovery = this.recoverNow(instanceId, this.epoch).finally(() => this.recoveries.delete(instanceId));
    this.recoveries.set(instanceId, recovery);
    return recovery;
  }
  private async recoverNow(instanceId: string, epoch: number) {
    const entry = this.store.profile(this.id).snapshot?.instances.find((candidate) => candidate.instanceId === instanceId);
    if (!entry) return this.refresh(epoch);
    const delta = await this.client.appSessions.delta(instanceId, entry.streamId, entry.revision ?? 0);
    if (!this.live(epoch)) return;
    if (delta.syncRequired || delta.streamId !== entry.streamId) return this.refresh(epoch);
    for (const event of delta.events) {
      const result = this.store.applyStreamEvent(this.id, event);
      if (result.kind === 'gap' || result.kind === 'snapshot-required') return this.refresh(epoch);
    }
  }
  private async refresh(epoch: number) {
    const snapshot = await this.client.appSessions.refresh();
    if (this.live(epoch)) this.store.replaceSnapshot(this.id, snapshot);
  }
  private scheduleReconnect(epoch: number) {
    if (!this.live(epoch) || this.reconnectTimer) return;
    const delay = Math.min(1_000 * (2 ** this.reconnectAttempt), 30_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.live(epoch)) return;
      void this.start().catch(() => undefined);
    }, delay);
  }
  private live(epoch: number) { return epoch === this.epoch && this.store.isGeneration(this.id, this.generation); }
}
