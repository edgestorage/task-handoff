import type { AiSessionMessageDeltaEvent } from "@task-handoff/protocol/ai-sessions";

export const DEFAULT_AI_SESSION_MESSAGE_DELTA_WINDOW_MS = 32;
export const MIN_AI_SESSION_MESSAGE_DELTA_WINDOW_MS = 20;
export const MAX_AI_SESSION_MESSAGE_DELTA_WINDOW_MS = 50;

export type AiSessionMessageDeltaFlushReason =
  | "window"
  | "manual"
  | "completed"
  | "failed"
  | "waiting"
  | "interrupted"
  | "authoritative-event"
  | "event-source-close"
  | "service-close";

export type AiSessionMessageDeltaKey = Pick<
  AiSessionMessageDeltaEvent,
  "instanceId" | "sessionId" | "turnId" | "itemId"
>;

export interface AiSessionMessageDeltaCoalescerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AiSessionMessageDeltaCoalescerDiagnostics {
  rawDeltaCount: number;
  emittedEventCount: number;
  totalBatchSize: number;
  maxBatchSize: number;
  flushReasons: Record<string, number>;
  totalFirstBatchWaitMs: number;
  maxFirstBatchWaitMs: number;
}

export interface AiSessionMessageDeltaCoalescerOptions {
  emit(payload: AiSessionMessageDeltaEvent): void;
  windowMs?: number;
  clock?: AiSessionMessageDeltaCoalescerClock;
}

interface PendingDeltaBatch {
  chunks: string[];
  firstReceivedAtMs: number;
  lastPayload: AiSessionMessageDeltaEvent;
  timer: unknown;
}

const systemClock: AiSessionMessageDeltaCoalescerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function messageKey(payload: AiSessionMessageDeltaKey): string {
  return JSON.stringify([
    payload.instanceId,
    payload.sessionId,
    payload.turnId ?? null,
    payload.itemId ?? null,
  ]);
}

function validateWindowMs(windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs < MIN_AI_SESSION_MESSAGE_DELTA_WINDOW_MS || windowMs > MAX_AI_SESSION_MESSAGE_DELTA_WINDOW_MS) {
    throw new RangeError(
      `AI session message delta coalescing window must be between ${MIN_AI_SESSION_MESSAGE_DELTA_WINDOW_MS}ms and ${MAX_AI_SESSION_MESSAGE_DELTA_WINDOW_MS}ms`,
    );
  }
  return windowMs;
}

export class AiSessionMessageDeltaCoalescer {
  readonly windowMs: number;

  private readonly clock: AiSessionMessageDeltaCoalescerClock;
  private readonly emit: (payload: AiSessionMessageDeltaEvent) => void;
  private readonly pending = new Map<string, PendingDeltaBatch>();
  private readonly diagnosticState: AiSessionMessageDeltaCoalescerDiagnostics = {
    rawDeltaCount: 0,
    emittedEventCount: 0,
    totalBatchSize: 0,
    maxBatchSize: 0,
    flushReasons: {},
    totalFirstBatchWaitMs: 0,
    maxFirstBatchWaitMs: 0,
  };
  private isClosed = false;

  constructor(options: AiSessionMessageDeltaCoalescerOptions) {
    this.emit = options.emit;
    this.clock = options.clock ?? systemClock;
    this.windowMs = validateWindowMs(options.windowMs ?? DEFAULT_AI_SESSION_MESSAGE_DELTA_WINDOW_MS);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  push(payload: AiSessionMessageDeltaEvent): void {
    if (this.isClosed) {
      throw new Error("AI session message delta coalescer is closed");
    }

    this.diagnosticState.rawDeltaCount += 1;
    const key = messageKey(payload);
    const existing = this.pending.get(key);
    if (existing) {
      existing.chunks.push(payload.delta);
      existing.lastPayload = payload;
      return;
    }

    const batch: PendingDeltaBatch = {
      chunks: [payload.delta],
      firstReceivedAtMs: this.clock.now(),
      lastPayload: payload,
      timer: undefined,
    };
    batch.timer = this.clock.setTimeout(() => {
      this.flushByKey(key, "window");
    }, this.windowMs);
    this.pending.set(key, batch);
  }

  flush(payload: AiSessionMessageDeltaKey, reason: AiSessionMessageDeltaFlushReason = "manual"): boolean {
    return this.flushByKey(messageKey(payload), reason);
  }

  flushAll(reason: AiSessionMessageDeltaFlushReason = "manual"): number {
    let flushed = 0;
    for (const key of [...this.pending.keys()]) {
      if (this.flushByKey(key, reason)) {
        flushed += 1;
      }
    }
    return flushed;
  }

  close(reason: AiSessionMessageDeltaFlushReason = "service-close"): number {
    if (this.isClosed) {
      return 0;
    }
    this.isClosed = true;
    return this.flushAll(reason);
  }

  diagnostics(): AiSessionMessageDeltaCoalescerDiagnostics {
    return {
      ...this.diagnosticState,
      flushReasons: { ...this.diagnosticState.flushReasons },
    };
  }

  private flushByKey(key: string, reason: AiSessionMessageDeltaFlushReason): boolean {
    const batch = this.pending.get(key);
    if (!batch) {
      return false;
    }

    this.pending.delete(key);
    this.clock.clearTimeout(batch.timer);

    const batchSize = batch.chunks.length;
    const waitMs = Math.max(0, this.clock.now() - batch.firstReceivedAtMs);
    this.diagnosticState.emittedEventCount += 1;
    this.diagnosticState.totalBatchSize += batchSize;
    this.diagnosticState.maxBatchSize = Math.max(this.diagnosticState.maxBatchSize, batchSize);
    this.diagnosticState.flushReasons[reason] = (this.diagnosticState.flushReasons[reason] ?? 0) + 1;
    this.diagnosticState.totalFirstBatchWaitMs += waitMs;
    this.diagnosticState.maxFirstBatchWaitMs = Math.max(this.diagnosticState.maxFirstBatchWaitMs, waitMs);

    this.emit({
      ...batch.lastPayload,
      delta: batch.chunks.join(""),
    });
    return true;
  }
}
