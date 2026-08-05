import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import {
  AiSessionEventType,
  AiSessionMessageDeltaEventSchema,
  AiSessionPatchEventSchema,
  AiSessionRemovedEventSchema,
  AiSessionSnapshotEventSchema,
  AiSessionUnreadEventType,
  AiSessionUnreadStateSchema,
  type AiSessionStreamEvent,
} from '@task-handoff/protocol/ai-sessions';

import type {
  MobileControlPlaneEvent,
  MobileControlPlaneEventConnection,
  MobileControlPlaneTransport,
} from '../control-plane/transport';
import { MobileControlPlaneTransportError } from '../control-plane/transport';
import { MobileAiSessionStore } from './store';
import { mobileMetrics } from '../observability/mobile-metrics';

export class MobileAiSessionController {
  private connection?: MobileControlPlaneEventConnection;
  private readonly recoveries = new Map<string, Promise<void>>();
  private readonly firstDeltas = new Set<string>();
  private epoch = 0;
  private readonly storeGeneration: number;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly controlPlaneId: string,
    private readonly client: ControlPlaneClient,
    private readonly transport: MobileControlPlaneTransport,
    private readonly store: MobileAiSessionStore,
  ) {
    this.storeGeneration = store.generation(controlPlaneId);
  }

  async start(signal?: AbortSignal) {
    if (!this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const epoch = ++this.epoch;
    this.recoveries.clear();
    this.firstDeltas.clear();
    this.store.setSyncState(this.controlPlaneId, {
      phase: this.store.profile(this.controlPlaneId).snapshot ? 'stale' : 'loading',
      lastSyncedAt: this.store.profile(this.controlPlaneId).sync.lastSyncedAt,
    });
    try {
      await this.transport.revalidate?.();
      if (epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return;
      const auth = await this.client.auth.session(signal);
      if (!auth.authenticated) throw new MobileControlPlaneTransportError('DIRECT_SESSION_EXPIRED', 'The mobile Control Plane session expired. Sign in again.', false, 401);
      if (!(await this.refreshSnapshot(signal, epoch))) return;
      this.reconnectAttempt = 0;
      mobileMetrics.record('connection.result', { result: 'connected' });
    } catch (cause) {
      if (epoch === this.epoch && this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) this.store.setSyncState(this.controlPlaneId, {
        phase: this.store.profile(this.controlPlaneId).snapshot ? 'stale' : 'error',
        lastSyncedAt: this.store.profile(this.controlPlaneId).sync.lastSyncedAt,
        error: cause instanceof Error ? cause.message : 'Could not load AI Sessions.',
      });
      mobileMetrics.record('connection.result', { result: 'failed' });
      this.scheduleReconnect(epoch);
      throw cause;
    }
    this.connection?.close();
    if (epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return;
    this.connection = this.transport.connectEvents({
      onOpen() {},
      onEvent: (event) => {
        if (epoch === this.epoch && this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) this.applyEvent(event);
      },
      onError: (cause) => {
        if (epoch === this.epoch && this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) this.store.setSyncState(this.controlPlaneId, {
          phase: this.store.profile(this.controlPlaneId).snapshot ? 'stale' : 'error',
          lastSyncedAt: this.store.profile(this.controlPlaneId).sync.lastSyncedAt,
          error: cause.message,
        });
        this.scheduleReconnect(epoch);
      },
      onClose: () => {
        if (epoch === this.epoch && this.store.isGeneration(this.controlPlaneId, this.storeGeneration) && this.store.profile(this.controlPlaneId).snapshot) this.store.setSyncState(this.controlPlaneId, {
          phase: 'stale',
          lastSyncedAt: this.store.profile(this.controlPlaneId).sync.lastSyncedAt,
        });
        this.scheduleReconnect(epoch);
      },
    });
  }

  stop() {
    this.epoch += 1;
    this.recoveries.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectAttempt = 0;
    this.connection?.close();
    this.connection = undefined;
  }

  private scheduleReconnect(epoch: number) {
    if (epoch !== this.epoch || this.reconnectTimer || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return;
    const delay = Math.min(1_000 * (2 ** this.reconnectAttempt), 30_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return;
      void this.start().catch(() => undefined);
    }, delay);
  }

  async refreshSnapshot(signal?: AbortSignal, epoch = this.epoch) {
    const snapshot = await this.client.aiSessions.list(signal);
    if (epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return false;
    this.store.replaceSnapshot(this.controlPlaneId, snapshot);
    return true;
  }

  recoverInstance(instanceId: string) {
    const active = this.recoveries.get(instanceId);
    if (active) return active;
    const recovery = this.recoverInstanceNow(instanceId, this.epoch).finally(() => {
      if (this.recoveries.get(instanceId) === recovery) this.recoveries.delete(instanceId);
    });
    this.recoveries.set(instanceId, recovery);
    return recovery;
  }

  applyEvent(event: MobileControlPlaneEvent) {
    if (!this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return false;
    if (event.type === AiSessionEventType.MessageDelta) {
      const parsed = AiSessionMessageDeltaEventSchema.safeParse(event.payload);
      if (!parsed.success || event.scope?.instanceId !== parsed.data.instanceId) return false;
      this.store.appendMessageDelta(this.controlPlaneId, parsed.data);
      const deltaKey = `${parsed.data.instanceId}\u0000${parsed.data.sessionId}\u0000${parsed.data.turnId}\u0000${parsed.data.itemId}`;
      if (!this.firstDeltas.has(deltaKey)) {
        this.firstDeltas.add(deltaKey);
        const transitDuration = Math.max(0, Math.min(Date.now() - Date.parse(parsed.data.generatedAt), 5 * 60 * 1000));
        mobileMetrics.record('message.first-delta', { result: 'received' }, transitDuration);
      }
      return true;
    }
    if (event.type === AiSessionUnreadEventType.Updated) {
      const parsed = AiSessionUnreadStateSchema.safeParse(event.payload);
      if (!parsed.success || event.scope?.instanceId !== parsed.data.instanceId) return false;
      return this.store.applyUnread(this.controlPlaneId, parsed.data);
    }
    const schemas = {
      [AiSessionEventType.Snapshot]: AiSessionSnapshotEventSchema,
      [AiSessionEventType.Patch]: AiSessionPatchEventSchema,
      [AiSessionEventType.Removed]: AiSessionRemovedEventSchema,
    } as const;
    const schema = schemas[event.type as keyof typeof schemas];
    if (!schema) return false;
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success || event.scope?.instanceId !== parsed.data.meta.instanceId) return false;
    const result = this.store.applyStreamEvent(this.controlPlaneId, {
      type: event.type,
      payload: parsed.data,
    } as AiSessionStreamEvent);
    if (result.kind === 'gap' || result.kind === 'snapshot-required') {
      mobileMetrics.record('stream.gap', { reason: result.kind });
      void this.recoverInstance(parsed.data.meta.instanceId);
      return false;
    }
    return true;
  }

  private async recoverInstanceNow(instanceId: string, epoch: number) {
    mobileMetrics.record('snapshot.recovery', { reason: 'stream-recovery' });
    const entry = this.store.profile(this.controlPlaneId).snapshot?.instances
      .find((candidate) => candidate.instanceId === instanceId);
    if (!entry) {
      await this.refreshSnapshot(undefined, epoch);
      return;
    }
    const delta = await this.client.aiSessions.delta(instanceId, entry.streamId, entry.revision ?? 0);
    if (epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return;
    if (delta.syncRequired || delta.streamId !== entry.streamId) {
      await this.refreshSnapshot(undefined, epoch);
      return;
    }
    for (const event of delta.events) {
      const result = this.store.applyStreamEvent(this.controlPlaneId, event);
      if (result.kind === 'gap' || result.kind === 'snapshot-required') {
        await this.refreshSnapshot(undefined, epoch);
        return;
      }
    }
    const recovered = this.store.profile(this.controlPlaneId).snapshot?.instances
      .find((candidate) => candidate.instanceId === instanceId);
    if (!recovered || (recovered.revision ?? 0) < delta.latestRevision) await this.refreshSnapshot(undefined, epoch);
  }
}
