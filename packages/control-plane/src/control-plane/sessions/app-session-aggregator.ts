import {
  APP_SESSION_DELTA_RETENTION_MS,
  AppSessionDeltaResponseSchema,
  AppSessionEventType,
  AppSessionPatchEventSchema,
  AppSessionRemovedEventSchema,
  AppSessionSnapshotEventSchema,
  activeAppSessionsSnapshotFromRecords,
  applyAppSessionStreamEvent,
  type AppSessionDeltaResponse,
  type AppSessionPatchEvent,
  type AppSessionRemovedEvent,
  type AppSessionSnapshotEvent,
  type AppSessionsSnapshot,
  type AppSessionsState,
} from "@task-handoff/protocol/app-sessions";
import type { EventEnvelope, SessionStreamDescriptor } from "@task-handoff/protocol/events";
import { safeParseResponse } from "@task-handoff/protocol/response-validation";

type Logger = {
  info?: (data: Record<string, unknown>, message?: string) => void;
  warn?: (data: Record<string, unknown>, message?: string) => void;
};
type AppSessionEvent =
  | { type: typeof AppSessionEventType.Snapshot; payload: AppSessionSnapshotEvent }
  | { type: typeof AppSessionEventType.Patch; payload: AppSessionPatchEvent }
  | { type: typeof AppSessionEventType.Removed; payload: AppSessionRemovedEvent };
type AppSessionHistoryEntry = AppSessionEvent & { createdAtMs: number };
type RecoveryRecord = { promise: Promise<void>; streamId: string; highWater: number };
type BootstrapEntry = { instanceId: string; streamId: string; appSessions: AppSessionsSnapshot; revision: number; lastEventAt: string };

export type ControlPlaneAppSessionsView = { updatedAt: string; instances: BootstrapEntry[] };

export class ControlPlaneAppSessionAggregator {
  private readonly snapshots = new Map<string, AppSessionsState>();
  private readonly history = new Map<string, AppSessionHistoryEntry[]>();
  private readonly advertisedStreams = new Map<string, SessionStreamDescriptor>();
  private readonly recoveries = new Map<string, RecoveryRecord>();
  private readonly bootstrap: () => Promise<{ instances: BootstrapEntry[] }>;
  private readonly logger?: Logger;
  private readonly recoverDelta?: (instanceId: string, streamId: string, sinceRevision: number) => Promise<AppSessionDeltaResponse>;
  private readonly recoverSnapshot?: (instanceId: string) => Promise<AppSessionsState>;
  private readonly onRecoveredEvent?: (event: AppSessionEvent) => void;
  private recoveryCount = 0;
  private readonly counters = { streamResets: 0, gaps: 0, deltaRecoveries: 0, snapshotRecoveries: 0, recoveryFailures: 0 };

  constructor(options: { bootstrap: () => Promise<{ instances: BootstrapEntry[] }>; logger?: Logger; recoverDelta?: ControlPlaneAppSessionAggregator["recoverDelta"]; recoverSnapshot?: ControlPlaneAppSessionAggregator["recoverSnapshot"]; onRecoveredEvent?: ControlPlaneAppSessionAggregator["onRecoveredEvent"] }) {
    this.bootstrap = options.bootstrap;
    this.logger = options.logger;
    this.recoverDelta = options.recoverDelta;
    this.recoverSnapshot = options.recoverSnapshot;
    this.onRecoveredEvent = options.onRecoveredEvent;
  }

  handleEvent(event: EventEnvelope) {
    const schema = event.type === AppSessionEventType.Snapshot
      ? AppSessionSnapshotEventSchema
      : event.type === AppSessionEventType.Patch
        ? AppSessionPatchEventSchema
        : event.type === AppSessionEventType.Removed
          ? AppSessionRemovedEventSchema
          : undefined;
    if (!schema) return false;
    const parsed = safeParseResponse(schema, event.payload);
    if (!parsed.success) {
      this.logger?.warn?.({ eventType: event.type, issues: parsed.error.issues, errorCode: "APP_SESSION_EVENT_INVALID" }, "app-session.aggregator.event.invalid");
      return false;
    }
    if (event.type === AppSessionEventType.Snapshot) return this.applySnapshot(parsed.data as AppSessionSnapshotEvent);
    if (event.type === AppSessionEventType.Patch) return this.applyPatch(parsed.data as AppSessionPatchEvent);
    return this.applyRemoved(parsed.data as AppSessionRemovedEvent);
  }

  applySnapshot(payload: AppSessionSnapshotEvent) {
    const advertisedStreamId = this.advertisedStreams.get(payload.meta.instanceId)?.streamId;
    if (advertisedStreamId && advertisedStreamId !== payload.meta.streamId) {
      this.logger?.warn?.({ instanceId: payload.meta.instanceId, advertisedStreamId, streamId: payload.meta.streamId, revision: payload.meta.revision }, "app-session.aggregator.snapshot.obsolete-stream");
      return false;
    }
    return this.apply({ type: AppSessionEventType.Snapshot, payload });
  }

  advertiseStream(instanceId: string, descriptor: SessionStreamDescriptor) {
    this.advertisedStreams.set(instanceId, descriptor);
    return this.recoverStream(instanceId, descriptor.streamId, descriptor.latestRevision).catch((error) => {
      this.counters.recoveryFailures += 1;
      this.logger?.warn?.({ instanceId, streamId: descriptor.streamId, error: error instanceof Error ? error.message : String(error) }, "app-session.aggregator.recovery.failed");
    });
  }

  diagnostics() {
    return { ...this.counters, recoveriesStarted: this.recoveryCount, activeRecoveries: this.recoveries.size };
  }

  removeInstance(instanceId: string) {
    this.snapshots.delete(instanceId);
    this.history.delete(instanceId);
    this.advertisedStreams.delete(instanceId);
  }

  applyPatch(payload: AppSessionPatchEvent) {
    return this.apply({ type: AppSessionEventType.Patch, payload });
  }

  applyRemoved(payload: AppSessionRemovedEvent) {
    return this.apply({ type: AppSessionEventType.Removed, payload });
  }

  async list(options: { refresh?: boolean } = {}): Promise<ControlPlaneAppSessionsView> {
    if (options.refresh || this.snapshots.size === 0) await this.bootstrapFromInstances();
    return this.view();
  }

  async streamDescriptors() {
    if (this.snapshots.size === 0) await this.bootstrapFromInstances();
    return [...this.snapshots.entries()].map(([instanceId, entry]) => ({
      topic: "app.sessions" as const,
      instanceId,
      streamId: entry.streamId,
      latestRevision: entry.revision,
      earliestRetainedRevision: this.history.get(instanceId)?.[0]?.payload.meta.revision ?? entry.revision + 1,
    }));
  }

  async delta(input: { instanceId?: string; streamId: string; sinceRevision: number }): Promise<AppSessionDeltaResponse> {
    if (this.snapshots.size === 0) await this.bootstrapFromInstances();
    const instanceId = this.resolveDeltaInstanceId(input.instanceId);
    this.pruneHistory(instanceId);
    const latestRevision = this.snapshots.get(instanceId)?.revision ?? 0;
    const streamId = this.snapshots.get(instanceId)?.streamId || "unavailable";
    const earliestRetainedRevision = this.history.get(instanceId)?.[0]?.payload.meta.revision ?? latestRevision + 1;
    if (input.streamId !== streamId || input.sinceRevision > latestRevision) {
      return AppSessionDeltaResponseSchema.parse({ streamId, instanceId, sinceRevision: input.sinceRevision, latestRevision, earliestRetainedRevision, syncRequired: true, events: [] });
    }
    if (input.sinceRevision === latestRevision) {
      return AppSessionDeltaResponseSchema.parse({ streamId, instanceId, sinceRevision: input.sinceRevision, latestRevision, earliestRetainedRevision, syncRequired: false, events: [] });
    }
    const events = (this.history.get(instanceId) ?? []).filter((event) => event.payload.meta.revision > input.sinceRevision);
    const syncRequired = !events.length || events[0].payload.meta.revision !== input.sinceRevision + 1;
    return AppSessionDeltaResponseSchema.parse({
      streamId,
      instanceId,
      sinceRevision: input.sinceRevision,
      latestRevision,
      earliestRetainedRevision,
      syncRequired,
      events: syncRequired ? [] : events.map(({ type, payload }) => ({ type, payload })),
    });
  }

  private apply(event: AppSessionEvent, recovering = false) {
    const { meta } = event.payload;
    const advertisedStreamId = this.advertisedStreams.get(meta.instanceId)?.streamId;
    if (advertisedStreamId && advertisedStreamId !== meta.streamId) {
      this.logger?.warn?.({ instanceId: meta.instanceId, advertisedStreamId, streamId: meta.streamId, revision: meta.revision }, "app-session.aggregator.event.obsolete-stream");
      return false;
    }
    const activeRecovery = this.recoveries.get(meta.instanceId);
    if (activeRecovery && !recovering) {
      if (activeRecovery.streamId === meta.streamId) activeRecovery.highWater = Math.max(activeRecovery.highWater, meta.revision);
      return false;
    }
    const current = this.snapshots.get(meta.instanceId);
    if (event.type === AppSessionEventType.Snapshot && current && current.streamId !== meta.streamId) {
      this.counters.streamResets += 1;
      this.logger?.info?.({ instanceId: meta.instanceId, previousStreamId: current.streamId, streamId: meta.streamId, previousRevision: current.revision, revision: meta.revision, traceId: meta.traceId, resetCount: this.counters.streamResets }, "app-session.aggregator.stream-reset");
    }
    const result = applyAppSessionStreamEvent(current, event);
    if (result.kind !== "applied") {
      this.logger?.warn?.({ traceId: meta.traceId, streamId: meta.streamId, instanceId: meta.instanceId, currentRevision: current?.revision, revision: meta.revision, outcome: result.kind }, `app-session.aggregator.event.${result.kind}`);
      if (result.kind === "gap" || result.kind === "snapshot-required") {
        if (result.kind === "gap") this.counters.gaps += 1;
        void this.recoverStream(meta.instanceId, meta.streamId, meta.revision).catch((error) => {
          this.logger?.warn?.({ instanceId: meta.instanceId, streamId: meta.streamId, revision: meta.revision, error: error instanceof Error ? error.message : String(error) }, "app-session.aggregator.recovery.failed");
        });
      }
      return false;
    }
    const projection = result.projection;
    this.snapshots.set(meta.instanceId, projection);
    this.rememberEvent(meta.instanceId, event);
    this.logger?.info?.({ traceId: meta.traceId, streamId: meta.streamId, instanceId: meta.instanceId, revision: meta.revision, reason: meta.reason, sessionCount: projection.snapshot.sessions.length, runningCount: projection.snapshot.runningCount, problemCount: projection.snapshot.problemCount }, "app-session.aggregator.event.accepted");
    return true;
  }

  private async bootstrapFromInstances() {
    this.logger?.info?.({}, "app-session.aggregator.bootstrap");
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
      const event: AppSessionEvent = {
        type: AppSessionEventType.Snapshot,
        payload: {
          meta: {
            streamId: entry.streamId,
            instanceId: entry.instanceId,
            revision: entry.revision,
            traceId: `aps_bootstrap_${Date.now().toString(36)}`,
            generatedAt: entry.lastEventAt,
            reason: "startup",
          },
          snapshot: activeAppSessionsSnapshotFromRecords(entry.appSessions.sessions, entry.appSessions.updatedAt),
        },
      };
      // Snapshot reconciliation and realtime ingestion must have the same
      // observable commit boundary: advancing the shared revision also emits.
      if (this.apply(event)) this.onRecoveredEvent?.(event);
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
    this.logger?.info?.({ instanceId, highWater, recoveryNumber }, "app-session.aggregator.recovery.started");
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
          const event: AppSessionEvent = { type: AppSessionEventType.Snapshot, payload: { meta: { streamId: state.streamId, instanceId, revision: state.revision, traceId: `aps_recovery_${Date.now().toString(36)}`, generatedAt: state.lastEventAt, reason: "startup" }, snapshot: state.snapshot } };
          if (this.apply(event, true)) this.onRecoveredEvent?.(event);
          this.counters.snapshotRecoveries += 1;
          this.logger?.info?.({ instanceId, streamId: state.streamId, revision: state.revision, recoveryNumber, outcome: "snapshot" }, "app-session.aggregator.recovery.snapshot");
        } else if (current.revision < Math.max(descriptor.latestRevision, record.highWater)) {
          const delta = await this.recoverDelta!(instanceId, current.streamId, current.revision);
          if (this.advertisedStreams.get(instanceId)?.streamId !== delta.streamId || record.streamId !== delta.streamId) continue;
          if (delta.syncRequired) {
            const state = await this.recoverSnapshot!(instanceId);
            if (this.advertisedStreams.get(instanceId)?.streamId !== state.streamId) continue;
            const event: AppSessionEvent = { type: AppSessionEventType.Snapshot, payload: { meta: { streamId: state.streamId, instanceId, revision: state.revision, traceId: `aps_recovery_${Date.now().toString(36)}`, generatedAt: state.lastEventAt, reason: "startup" }, snapshot: state.snapshot } };
            if (this.apply(event, true)) this.onRecoveredEvent?.(event);
            this.counters.snapshotRecoveries += 1;
            this.logger?.info?.({ instanceId, streamId: state.streamId, revision: state.revision, recoveryNumber, outcome: "snapshot-fallback" }, "app-session.aggregator.recovery.snapshot");
          } else {
            for (const event of delta.events) if (this.apply(event, true)) this.onRecoveredEvent?.(event);
            this.counters.deltaRecoveries += 1;
            record.highWater = Math.max(record.highWater, delta.latestRevision);
            this.logger?.info?.({ instanceId, streamId: delta.streamId, sinceRevision: delta.sinceRevision, latestRevision: delta.latestRevision, eventCount: delta.events.length, recoveryNumber, outcome: "delta" }, "app-session.aggregator.recovery.delta");
          }
        }
        const latest = this.snapshots.get(instanceId);
        const advertised = this.advertisedStreams.get(instanceId);
        if (latest && advertised && latest.streamId === advertised.streamId && latest.revision >= Math.max(advertised.latestRevision, record.highWater)) {
          this.logger?.info?.({ instanceId, streamId: latest.streamId, revision: latest.revision, recoveryNumber, outcome: "success" }, "app-session.aggregator.recovery.completed");
          return;
        }
      }
    })().finally(() => this.recoveries.delete(instanceId));
    this.recoveries.set(instanceId, record);
    return record.promise;
  }

  private rememberEvent(instanceId: string, event: AppSessionEvent) {
    const current = this.history.get(instanceId) ?? [];
    const events = current.length && current[0].payload.meta.streamId !== event.payload.meta.streamId ? [] : current;
    events.push({ ...event, createdAtMs: Date.now() });
    this.history.set(instanceId, events);
    this.pruneHistory(instanceId);
  }

  private pruneHistory(instanceId: string) {
    const events = this.history.get(instanceId);
    if (!events?.length) return;
    const retained = events.filter((event) => event.createdAtMs >= Date.now() - APP_SESSION_DELTA_RETENTION_MS);
    if (retained.length) this.history.set(instanceId, retained);
    else this.history.delete(instanceId);
  }

  private resolveDeltaInstanceId(instanceId?: string) {
    if (instanceId) return instanceId;
    const instanceIds = [...this.snapshots.keys()];
    if (instanceIds.length === 1) return instanceIds[0];
    throw new Error("APP_SESSION_DELTA_INSTANCE_ID_REQUIRED");
  }

  private view(): ControlPlaneAppSessionsView {
    return {
      updatedAt: new Date().toISOString(),
      instances: [...this.snapshots.entries()].map(([instanceId, entry]) => ({ instanceId, streamId: entry.streamId, appSessions: entry.snapshot, revision: entry.revision, lastEventAt: entry.lastEventAt })),
    };
  }
}
