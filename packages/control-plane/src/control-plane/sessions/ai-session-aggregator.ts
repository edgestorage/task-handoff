import {
  AI_SESSION_DELTA_RETENTION_MS,
  AiSessionDeltaResponseSchema,
  AiSessionEventType,
  AiSessionPatchEventSchema,
  AiSessionMessageDeltaEventSchema,
  AiSessionRemovedEventSchema,
  AiSessionSnapshotEventSchema,
  applyAiSessionStreamEvent,
  type AiSessionDeltaResponse,
  type AiSessionPatchEvent,
  type AiSessionMessageDeltaEvent,
  type AiSessionRemovedEvent,
  type AiSessionSnapshotEvent,
  type AiSessionsSnapshot,
  type AiSessionsState,
} from "@task-handoff/protocol/ai-sessions";
import type { EventEnvelope } from "@task-handoff/protocol/events";
import type { SessionStreamDescriptor } from "@task-handoff/protocol/events";

type Logger = {
  info?: (data: Record<string, unknown>, message?: string) => void;
  warn?: (data: Record<string, unknown>, message?: string) => void;
};

type AiSessionEvent =
  | { type: typeof AiSessionEventType.Snapshot; payload: AiSessionSnapshotEvent }
  | { type: typeof AiSessionEventType.Patch; payload: AiSessionPatchEvent }
  | { type: typeof AiSessionEventType.Removed; payload: AiSessionRemovedEvent };
type AiSessionHistoryEntry = AiSessionEvent & { createdAtMs: number };
type RecoveryRecord = { promise: Promise<void>; streamId: string; highWater: number };
type BootstrapEntry = {
  instanceId: string;
  streamId: string;
  aiSessions: AiSessionsSnapshot;
  revision: number;
  lastEventAt: string;
};

export type ControlPlaneAiSessionsView = {
  updatedAt: string;
  instances: Array<BootstrapEntry>;
};

export type ControlPlaneAiSessionSnapshotUpdate = BootstrapEntry;

export class ControlPlaneAiSessionAggregator {
  private readonly snapshots = new Map<string, AiSessionsState>();
  private readonly history = new Map<string, AiSessionHistoryEntry[]>();
  private readonly advertisedStreams = new Map<string, SessionStreamDescriptor>();
  private readonly recoveries = new Map<string, RecoveryRecord>();
  private readonly listeners = new Set<(update: ControlPlaneAiSessionSnapshotUpdate) => void>();
  private readonly messageDeltaBuffers = new Map<string, string>();
  private readonly bootstrap: () => Promise<{ instances: BootstrapEntry[] }>;
  private readonly logger?: Logger;
  private readonly recoverDelta?: (instanceId: string, streamId: string, sinceRevision: number) => Promise<AiSessionDeltaResponse>;
  private readonly recoverSnapshot?: (instanceId: string) => Promise<AiSessionsState>;
  private readonly onRecoveredEvent?: (event: AiSessionEvent) => void;
  private recoveryCount = 0;
  private readonly counters = { streamResets: 0, gaps: 0, deltaRecoveries: 0, snapshotRecoveries: 0, recoveryFailures: 0 };

  constructor(options: { bootstrap: () => Promise<{ instances: BootstrapEntry[] }>; logger?: Logger; recoverDelta?: ControlPlaneAiSessionAggregator["recoverDelta"]; recoverSnapshot?: ControlPlaneAiSessionAggregator["recoverSnapshot"]; onRecoveredEvent?: ControlPlaneAiSessionAggregator["onRecoveredEvent"] }) {
    this.bootstrap = options.bootstrap;
    this.logger = options.logger;
    this.recoverDelta = options.recoverDelta;
    this.recoverSnapshot = options.recoverSnapshot;
    this.onRecoveredEvent = options.onRecoveredEvent;
  }

  handleEvent(event: EventEnvelope) {
    if (event.type === AiSessionEventType.MessageDelta) {
      const parsed = AiSessionMessageDeltaEventSchema.safeParse(event.payload);
      if (!parsed.success) {
        this.logger?.warn?.({ eventType: event.type, issues: parsed.error.issues, errorCode: "AI_SESSION_MESSAGE_DELTA_INVALID" }, "ai-session.aggregator.message-delta.invalid");
        return true;
      }
      this.applyMessageDelta(parsed.data);
      return true;
    }
    const schema = event.type === AiSessionEventType.Snapshot
      ? AiSessionSnapshotEventSchema
      : event.type === AiSessionEventType.Patch
        ? AiSessionPatchEventSchema
        : event.type === AiSessionEventType.Removed
          ? AiSessionRemovedEventSchema
          : undefined;
    if (!schema) {
      return false;
    }
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) {
      this.logger?.warn?.({ eventType: event.type, issues: parsed.error.issues, errorCode: "AI_SESSION_EVENT_INVALID" }, "ai-session.aggregator.event.invalid");
      return true;
    }
    if (event.type === AiSessionEventType.Snapshot) this.applySnapshot(parsed.data as AiSessionSnapshotEvent);
    if (event.type === AiSessionEventType.Patch) this.applyPatch(parsed.data as AiSessionPatchEvent);
    if (event.type === AiSessionEventType.Removed) this.applyRemoved(parsed.data as AiSessionRemovedEvent);
    return true;
  }

  onSnapshot(listener: (update: ControlPlaneAiSessionSnapshotUpdate) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private applyMessageDelta(payload: AiSessionMessageDeltaEvent) {
    const current = this.snapshots.get(payload.instanceId);
    if (!current) return false;
    const key = [payload.instanceId, payload.sessionId, payload.turnId || "", payload.itemId || ""].join("\u0000");
    const text = `${this.messageDeltaBuffers.get(key) || ""}${payload.delta}`;
    this.messageDeltaBuffers.set(key, text);
    let matched = false;
    const sessions = current.snapshot.sessions.map((session) => {
      if (session.id !== payload.sessionId) return session;
      matched = true;
      const turns = [...(session.turns || [])];
      const turnIndex = payload.turnId
        ? turns.findIndex((turn) => turn.id === payload.turnId || turn.providerTurnId === payload.turnId)
        : turns.length - 1;
      if (turnIndex >= 0) {
        turns[turnIndex] = { ...turns[turnIndex], lastMessage: text, summary: text, phase: "responding", updatedAt: payload.generatedAt };
      }
      return { ...session, lastMessage: text, summary: text, phase: "responding" as const, updatedAt: payload.generatedAt, turns };
    });
    if (!matched) return false;
    const snapshot = { ...current.snapshot, sessions };
    const update = { instanceId: payload.instanceId, streamId: current.streamId, aiSessions: snapshot, revision: current.revision, lastEventAt: payload.generatedAt };
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch {
        this.listeners.delete(listener);
      }
    }
    return true;
  }

  applySnapshot(payload: AiSessionSnapshotEvent) {
    const advertisedStreamId = this.advertisedStreams.get(payload.meta.instanceId)?.streamId;
    if (advertisedStreamId && advertisedStreamId !== payload.meta.streamId) {
      this.logger?.warn?.({ instanceId: payload.meta.instanceId, advertisedStreamId, streamId: payload.meta.streamId, revision: payload.meta.revision }, "ai-session.aggregator.snapshot.obsolete-stream");
      return false;
    }
    return this.apply({ type: AiSessionEventType.Snapshot, payload });
  }

  advertiseStream(instanceId: string, descriptor: SessionStreamDescriptor) {
    this.advertisedStreams.set(instanceId, descriptor);
    return this.recoverStream(instanceId, descriptor.streamId, descriptor.latestRevision).catch((error) => {
      this.counters.recoveryFailures += 1;
      this.logger?.warn?.({ instanceId, streamId: descriptor.streamId, error: error instanceof Error ? error.message : String(error) }, "ai-session.aggregator.recovery.failed");
    });
  }

  diagnostics() {
    return { ...this.counters, recoveriesStarted: this.recoveryCount, activeRecoveries: this.recoveries.size };
  }

  removeInstance(instanceId: string) {
    this.snapshots.delete(instanceId);
    this.history.delete(instanceId);
    this.advertisedStreams.delete(instanceId);
    const prefix = `${instanceId}\u0000`;
    for (const key of this.messageDeltaBuffers.keys()) {
      if (key.startsWith(prefix)) this.messageDeltaBuffers.delete(key);
    }
  }

  applyPatch(payload: AiSessionPatchEvent) {
    return this.apply({ type: AiSessionEventType.Patch, payload });
  }

  applyRemoved(payload: AiSessionRemovedEvent) {
    return this.apply({ type: AiSessionEventType.Removed, payload });
  }

  async list(options: { refresh?: boolean } = {}): Promise<ControlPlaneAiSessionsView> {
    if (options.refresh || this.snapshots.size === 0) await this.bootstrapFromInstances();
    return this.view();
  }

  async streamDescriptors() {
    if (this.snapshots.size === 0) await this.bootstrapFromInstances();
    return [...this.snapshots.entries()].map(([instanceId, entry]) => ({
      topic: "ai.sessions" as const,
      instanceId,
      streamId: entry.streamId,
      latestRevision: entry.revision,
      earliestRetainedRevision: this.history.get(instanceId)?.[0]?.payload.meta.revision ?? entry.revision + 1,
    }));
  }

  async delta(input: { instanceId?: string; streamId: string; sinceRevision: number }): Promise<AiSessionDeltaResponse> {
    if (this.snapshots.size === 0) await this.bootstrapFromInstances();
    const instanceId = this.resolveDeltaInstanceId(input.instanceId);
    this.pruneHistory(instanceId);
    const latestRevision = this.snapshots.get(instanceId)?.revision ?? 0;
    const streamId = this.snapshots.get(instanceId)?.streamId || "unavailable";
    const earliestRetainedRevision = this.history.get(instanceId)?.[0]?.payload.meta.revision ?? latestRevision + 1;
    if (input.streamId !== streamId || input.sinceRevision > latestRevision) {
      return AiSessionDeltaResponseSchema.parse({ streamId, instanceId, sinceRevision: input.sinceRevision, latestRevision, earliestRetainedRevision, syncRequired: true, events: [] });
    }
    if (input.sinceRevision === latestRevision) {
      return AiSessionDeltaResponseSchema.parse({ streamId, instanceId, sinceRevision: input.sinceRevision, latestRevision, earliestRetainedRevision, syncRequired: false, events: [] });
    }
    const events = (this.history.get(instanceId) ?? []).filter((event) => event.payload.meta.revision > input.sinceRevision);
    const syncRequired = !events.length || events[0].payload.meta.revision !== input.sinceRevision + 1;
    return AiSessionDeltaResponseSchema.parse({
      streamId,
      instanceId,
      sinceRevision: input.sinceRevision,
      latestRevision,
      earliestRetainedRevision,
      syncRequired,
      events: syncRequired ? [] : events.map(({ type, payload }) => ({ type, payload })),
    });
  }

  private apply(event: AiSessionEvent, recovering = false) {
    const { meta } = event.payload;
    const advertisedStreamId = this.advertisedStreams.get(meta.instanceId)?.streamId;
    if (advertisedStreamId && advertisedStreamId !== meta.streamId) {
      this.logger?.warn?.({ instanceId: meta.instanceId, advertisedStreamId, streamId: meta.streamId, revision: meta.revision }, "ai-session.aggregator.event.obsolete-stream");
      return false;
    }
    const activeRecovery = this.recoveries.get(meta.instanceId);
    if (activeRecovery && !recovering) {
      if (activeRecovery.streamId === meta.streamId) activeRecovery.highWater = Math.max(activeRecovery.highWater, meta.revision);
      return false;
    }
    const current = this.snapshots.get(meta.instanceId);
    if (event.type === AiSessionEventType.Snapshot && current && current.streamId !== meta.streamId) {
      this.counters.streamResets += 1;
      this.logger?.info?.({ instanceId: meta.instanceId, previousStreamId: current.streamId, streamId: meta.streamId, previousRevision: current.revision, revision: meta.revision, traceId: meta.traceId, resetCount: this.counters.streamResets }, "ai-session.aggregator.stream-reset");
    }
    const result = applyAiSessionStreamEvent(current, event);
    if (result.kind !== "applied") {
      this.logger?.warn?.({ traceId: meta.traceId, streamId: meta.streamId, instanceId: meta.instanceId, currentRevision: current?.revision, revision: meta.revision, outcome: result.kind }, `ai-session.aggregator.event.${result.kind}`);
      if (result.kind === "gap" || result.kind === "snapshot-required") {
        if (result.kind === "gap") this.counters.gaps += 1;
        void this.recoverStream(meta.instanceId, meta.streamId, meta.revision).catch((error) => {
          this.logger?.warn?.({ instanceId: meta.instanceId, streamId: meta.streamId, revision: meta.revision, error: error instanceof Error ? error.message : String(error) }, "ai-session.aggregator.recovery.failed");
        });
      }
      return false;
    }
    const projection = result.projection;
    this.snapshots.set(meta.instanceId, projection);
    for (const session of projection.snapshot.sessions) {
      if (session.status === "running") continue;
      const prefix = `${meta.instanceId}\u0000${session.id}\u0000`;
      for (const key of this.messageDeltaBuffers.keys()) {
        if (key.startsWith(prefix)) this.messageDeltaBuffers.delete(key);
      }
    }
    this.rememberEvent(meta.instanceId, event);
    const update = { instanceId: meta.instanceId, streamId: projection.streamId, aiSessions: projection.snapshot, revision: projection.revision, lastEventAt: projection.lastEventAt };
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch {
        this.listeners.delete(listener);
      }
    }
    this.logger?.info?.({ traceId: meta.traceId, streamId: meta.streamId, instanceId: meta.instanceId, revision: meta.revision, reason: meta.reason, sessionCount: projection.snapshot.sessions.length }, "ai-session.aggregator.event.accepted");
    return true;
  }

  private async bootstrapFromInstances() {
    this.logger?.info?.({}, "ai-session.aggregator.bootstrap");
    const projectionsAtStart = new Map(this.snapshots);
    const state = await this.bootstrap();
    const authoritativeInstanceIds = new Set(state.instances.map((entry) => entry.instanceId));
    for (const [instanceId, projectionAtStart] of projectionsAtStart) {
      if (authoritativeInstanceIds.has(instanceId) || this.snapshots.get(instanceId) !== projectionAtStart) continue;
      this.snapshots.delete(instanceId);
      this.history.delete(instanceId);
      this.advertisedStreams.delete(instanceId);
    }
    for (const entry of state.instances) {
      const current = this.snapshots.get(entry.instanceId);
      if (current !== projectionsAtStart.get(entry.instanceId)) continue;
      const advertisedStreamId = this.advertisedStreams.get(entry.instanceId)?.streamId;
      if (advertisedStreamId && advertisedStreamId !== entry.streamId) continue;
      if (current?.streamId === entry.streamId && current.revision >= entry.revision) continue;
      if (current?.streamId !== entry.streamId) this.history.delete(entry.instanceId);
      this.snapshots.set(entry.instanceId, { streamId: entry.streamId, snapshot: entry.aiSessions, revision: entry.revision, lastEventAt: entry.lastEventAt });
    }
  }

  private recoverStream(instanceId: string, streamId: string, highWater: number) {
    const existing = this.recoveries.get(instanceId);
    if (existing) {
      if (existing.streamId === streamId) existing.highWater = Math.max(existing.highWater, highWater);
      else {
        existing.streamId = streamId;
        existing.highWater = highWater;
      }
      return existing.promise;
    }
    if (!this.recoverDelta || !this.recoverSnapshot) return Promise.resolve();
    const record = { promise: Promise.resolve(), streamId, highWater } as RecoveryRecord;
    const recoveryNumber = ++this.recoveryCount;
    this.logger?.info?.({ instanceId, highWater, recoveryNumber }, "ai-session.aggregator.recovery.started");
    record.promise = (async () => {
      while (true) {
        const descriptor = this.advertisedStreams.get(instanceId);
        if (!descriptor) return;
        if (record.streamId !== descriptor.streamId) {
          record.streamId = descriptor.streamId;
          record.highWater = descriptor.latestRevision;
        }
        const current = this.snapshots.get(instanceId);
        if (!current || current.streamId !== descriptor.streamId) {
          const state = await this.recoverSnapshot!(instanceId);
          if (this.advertisedStreams.get(instanceId)?.streamId !== state.streamId) continue;
          const event: AiSessionEvent = { type: AiSessionEventType.Snapshot, payload: { meta: { streamId: state.streamId, instanceId, revision: state.revision, traceId: `ais_recovery_${Date.now().toString(36)}`, generatedAt: state.lastEventAt, reason: "startup" }, snapshot: state.snapshot } };
          if (this.apply(event, true)) this.onRecoveredEvent?.(event);
          this.counters.snapshotRecoveries += 1;
          this.logger?.info?.({ instanceId, streamId: state.streamId, revision: state.revision, recoveryNumber, outcome: "snapshot" }, "ai-session.aggregator.recovery.snapshot");
        } else if (current.revision < Math.max(descriptor.latestRevision, record.highWater)) {
          const delta = await this.recoverDelta!(instanceId, current.streamId, current.revision);
          if (this.advertisedStreams.get(instanceId)?.streamId !== delta.streamId || record.streamId !== delta.streamId) continue;
          if (delta.syncRequired) {
            const state = await this.recoverSnapshot!(instanceId);
            if (this.advertisedStreams.get(instanceId)?.streamId !== state.streamId) continue;
            const event: AiSessionEvent = { type: AiSessionEventType.Snapshot, payload: { meta: { streamId: state.streamId, instanceId, revision: state.revision, traceId: `ais_recovery_${Date.now().toString(36)}`, generatedAt: state.lastEventAt, reason: "startup" }, snapshot: state.snapshot } };
            if (this.apply(event, true)) this.onRecoveredEvent?.(event);
            this.counters.snapshotRecoveries += 1;
            this.logger?.info?.({ instanceId, streamId: state.streamId, revision: state.revision, recoveryNumber, outcome: "snapshot-fallback" }, "ai-session.aggregator.recovery.snapshot");
          } else {
            for (const event of delta.events) if (this.apply(event, true)) this.onRecoveredEvent?.(event);
            this.counters.deltaRecoveries += 1;
            record.highWater = Math.max(record.highWater, delta.latestRevision);
            this.logger?.info?.({ instanceId, streamId: delta.streamId, sinceRevision: delta.sinceRevision, latestRevision: delta.latestRevision, eventCount: delta.events.length, recoveryNumber, outcome: "delta" }, "ai-session.aggregator.recovery.delta");
          }
        }
        const latest = this.snapshots.get(instanceId);
        const advertised = this.advertisedStreams.get(instanceId);
        if (latest && advertised && latest.streamId === advertised.streamId && latest.revision >= Math.max(advertised.latestRevision, record.highWater)) {
          this.logger?.info?.({ instanceId, streamId: latest.streamId, revision: latest.revision, recoveryNumber, outcome: "success" }, "ai-session.aggregator.recovery.completed");
          return;
        }
      }
    })().finally(() => this.recoveries.delete(instanceId));
    this.recoveries.set(instanceId, record);
    return record.promise;
  }

  private rememberEvent(instanceId: string, event: AiSessionEvent) {
    const current = this.history.get(instanceId) ?? [];
    const events = current.length && current[0].payload.meta.streamId !== event.payload.meta.streamId ? [] : current;
    events.push({ ...event, createdAtMs: Date.now() });
    this.history.set(instanceId, events);
    this.pruneHistory(instanceId);
  }

  private pruneHistory(instanceId: string) {
    const events = this.history.get(instanceId);
    if (!events?.length) return;
    const retained = events.filter((event) => event.createdAtMs >= Date.now() - AI_SESSION_DELTA_RETENTION_MS);
    if (retained.length) this.history.set(instanceId, retained);
    else this.history.delete(instanceId);
  }

  private resolveDeltaInstanceId(instanceId?: string) {
    if (instanceId) return instanceId;
    const instanceIds = [...this.snapshots.keys()];
    if (instanceIds.length === 1) return instanceIds[0];
    throw new Error("AI_SESSION_DELTA_INSTANCE_ID_REQUIRED");
  }

  private view(): ControlPlaneAiSessionsView {
    return {
      updatedAt: new Date().toISOString(),
      instances: [...this.snapshots.entries()].map(([instanceId, entry]) => ({ instanceId, streamId: entry.streamId, aiSessions: entry.snapshot, revision: entry.revision, lastEventAt: entry.lastEventAt })),
    };
  }
}
