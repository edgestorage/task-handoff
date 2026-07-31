import type { SessionStreamDescriptor, SessionStreamTopic } from "@task-handoff/protocol/events";

type StreamMeta = {
  instanceId: string;
  streamId: string;
  revision: number;
};

type StreamEntry = {
  instanceId: string;
  streamId: string;
  revision?: number;
};

type StreamDelta<Event> = {
  instanceId: string;
  streamId: string;
  sinceRevision: number;
  syncRequired: boolean;
  events: Event[];
  latestRevision: number;
};

export type SessionStreamRecoveryRetryOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
};

export type SessionStreamRecoveryErrorContext = {
  topic: SessionStreamTopic;
  instanceId: string;
  streamId: string;
  attempt: number;
  retryDelayMs: number;
};

type RecoveryRecord = {
  promise: Promise<void>;
  highWater: number;
  cancelled: boolean;
  attempt: number;
  controller?: AbortController;
  retryTimer?: ReturnType<typeof setTimeout>;
  wakeRetry?: () => void;
};

const DEFAULT_RETRY_INITIAL_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_RETRY_JITTER_RATIO = 0.25;

export function createSessionStreamRecovery<Entry extends StreamEntry, Snapshot extends StreamEntry, Event>(options: {
  topic: SessionStreamTopic;
  getEntry: (instanceId: string) => Entry | undefined;
  refreshSnapshot: (instanceId: string, signal: AbortSignal) => Promise<Snapshot | undefined>;
  applySnapshot: (snapshot: Snapshot) => void;
  loadDelta: (entry: Entry, signal: AbortSignal) => Promise<StreamDelta<Event>>;
  applyEvent: (event: Event) => void;
  onStreamChanged?: (instanceId: string, streamId: string) => void;
  onError?: (error: unknown, context: SessionStreamRecoveryErrorContext) => void;
  retry?: SessionStreamRecoveryRetryOptions;
}) {
  const advertised = new Map<string, SessionStreamDescriptor>();
  const recoveries = new Map<string, RecoveryRecord>();
  const initialDelayMs = options.retry?.initialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
  const maxDelayMs = options.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const jitterRatio = options.retry?.jitterRatio ?? DEFAULT_RETRY_JITTER_RATIO;
  const random = options.retry?.random ?? Math.random;

  function observeEvent(meta: StreamMeta, snapshot: boolean, fromRecovery = false) {
    const previous = advertised.get(meta.instanceId);
    if (fromRecovery && previous?.streamId && previous.streamId !== meta.streamId) {
      return { apply: false, descriptor: previous };
    }
    const descriptor = descriptorThroughEvent(options.topic, previous, meta);
    advertised.set(meta.instanceId, descriptor);
    if (previous?.streamId && previous.streamId !== descriptor.streamId) {
      options.onStreamChanged?.(meta.instanceId, descriptor.streamId);
    }
    const recovery = recoveries.get(meta.instanceId);
    const streamChanged = Boolean(previous?.streamId && previous.streamId !== meta.streamId);
    if (recovery && streamChanged) {
      cancelRecovery(meta.instanceId, recovery);
    } else if (recovery && !fromRecovery) {
      recovery.highWater = Math.max(recovery.highWater, meta.revision);
      wakeRecovery(recovery);
    }
    if (streamChanged && !snapshot) {
      if (!fromRecovery) void recoverDescriptor(descriptor);
      return { apply: false, descriptor };
    }
    return { apply: true, descriptor };
  }

  function recoverDescriptor(descriptor?: SessionStreamDescriptor) {
    if (!descriptor) return Promise.resolve();
    const previous = advertised.get(descriptor.instanceId);
    advertised.set(descriptor.instanceId, descriptor);
    if (previous?.streamId && previous.streamId !== descriptor.streamId) {
      options.onStreamChanged?.(descriptor.instanceId, descriptor.streamId);
    }
    const existing = recoveries.get(descriptor.instanceId);
    if (existing) {
      if (previous?.streamId === descriptor.streamId) {
        existing.highWater = Math.max(existing.highWater, descriptor.latestRevision);
        wakeRecovery(existing);
        return existing.promise;
      }
      cancelRecovery(descriptor.instanceId, existing);
    }
    const record: RecoveryRecord = {
      promise: Promise.resolve(),
      highWater: descriptor.latestRevision,
      cancelled: false,
      attempt: 0,
    };
    record.promise = recover(descriptor.instanceId, record).finally(() => {
      if (recoveries.get(descriptor.instanceId) === record) recoveries.delete(descriptor.instanceId);
    });
    recoveries.set(descriptor.instanceId, record);
    return record.promise;
  }

  async function recover(instanceId: string, record: RecoveryRecord) {
    while (!record.cancelled) {
      const descriptor = advertised.get(instanceId);
      if (!descriptor) return;
      const entry = options.getEntry(instanceId);
      if (isConverged(entry, descriptor, record.highWater)) return;
      const revisionBeforeRequest = entry?.revision ?? -1;
      const streamBeforeRequest = entry?.streamId;
      record.controller = new AbortController();
      let failure: unknown;
      try {
        if (!entry || entry.streamId !== descriptor.streamId) {
          const snapshot = await options.refreshSnapshot(instanceId, record.controller.signal);
          if (record.cancelled) return;
          const latestDescriptor = advertised.get(instanceId);
          if (latestDescriptor && snapshot?.streamId === latestDescriptor.streamId) {
            const latestEntry = options.getEntry(instanceId);
            if (!latestEntry || latestEntry.streamId !== snapshot.streamId || (latestEntry.revision ?? -1) < (snapshot.revision ?? 0)) {
              options.applySnapshot(snapshot);
            }
          }
        } else {
          const delta = await options.loadDelta(entry, record.controller.signal);
          if (record.cancelled) return;
          if (delta.instanceId === instanceId && delta.streamId === entry.streamId && advertised.get(instanceId)?.streamId === entry.streamId) {
            if (delta.syncRequired) {
              const snapshot = await options.refreshSnapshot(instanceId, record.controller.signal);
              if (record.cancelled) return;
              const latestDescriptor = advertised.get(instanceId);
              if (latestDescriptor && snapshot?.streamId === latestDescriptor.streamId) {
                const latestEntry = options.getEntry(instanceId);
                if (!latestEntry || latestEntry.streamId !== snapshot.streamId || (latestEntry.revision ?? -1) < (snapshot.revision ?? 0)) {
                  options.applySnapshot(snapshot);
                }
              }
            } else {
              for (const event of delta.events) options.applyEvent(event);
              if (advertised.get(instanceId)?.streamId === entry.streamId) {
                record.highWater = Math.max(record.highWater, delta.latestRevision);
              }
            }
          }
        }
      } catch (error) {
        if (record.cancelled || isAbortError(error)) return;
        failure = error;
      } finally {
        record.controller = undefined;
      }

      const latestDescriptor = advertised.get(instanceId);
      const latest = options.getEntry(instanceId);
      if (!latestDescriptor || isConverged(latest, latestDescriptor, record.highWater)) return;
      const progressed = latest?.streamId !== streamBeforeRequest || (latest?.revision ?? -1) > revisionBeforeRequest;
      if (progressed && !failure) {
        record.attempt = 0;
        continue;
      }

      record.attempt += 1;
      const retryDelayMs = retryDelay(record.attempt);
      options.onError?.(failure ?? new Error("Session stream recovery made no progress."), {
        topic: options.topic,
        instanceId,
        streamId: latestDescriptor.streamId,
        attempt: record.attempt,
        retryDelayMs,
      });
      await waitForRetry(record, retryDelayMs);
    }
  }

  function retryDelay(attempt: number) {
    const base = Math.min(maxDelayMs, initialDelayMs * (2 ** Math.max(0, attempt - 1)));
    const factor = 1 - jitterRatio + random() * jitterRatio * 2;
    return Math.max(0, Math.min(maxDelayMs, Math.round(base * factor)));
  }

  function waitForRetry(record: RecoveryRecord, delayMs: number) {
    if (record.cancelled) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = () => {
        if (record.retryTimer) clearTimeout(record.retryTimer);
        record.retryTimer = undefined;
        record.wakeRetry = undefined;
        resolve();
      };
      record.wakeRetry = wake;
      record.retryTimer = setTimeout(wake, delayMs);
    });
  }

  function cleanupInstance(instanceId: string) {
    advertised.delete(instanceId);
    const recovery = recoveries.get(instanceId);
    if (recovery) cancelRecovery(instanceId, recovery);
  }

  function wakeRecovery(recovery: RecoveryRecord) {
    recovery.wakeRetry?.();
  }

  function cancelRecovery(instanceId: string, recovery: RecoveryRecord) {
    recovery.cancelled = true;
    recovery.controller?.abort();
    wakeRecovery(recovery);
    recoveries.delete(instanceId);
  }

  return {
    cleanupInstance,
    observeEvent,
    recoverDescriptor,
    streamId: (instanceId: string) => advertised.get(instanceId)?.streamId,
  };
}

function isConverged(entry: StreamEntry | undefined, descriptor: SessionStreamDescriptor, highWater: number) {
  return entry?.streamId === descriptor.streamId && (entry.revision ?? 0) >= highWater;
}

function isAbortError(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function descriptorThroughEvent(topic: SessionStreamTopic, descriptor: SessionStreamDescriptor | undefined, meta: StreamMeta): SessionStreamDescriptor {
  return {
    topic,
    instanceId: meta.instanceId,
    streamId: meta.streamId,
    latestRevision: descriptor?.streamId === meta.streamId ? Math.max(descriptor.latestRevision, meta.revision) : meta.revision,
    earliestRetainedRevision: descriptor?.streamId === meta.streamId ? descriptor.earliestRetainedRevision : meta.revision,
  };
}
