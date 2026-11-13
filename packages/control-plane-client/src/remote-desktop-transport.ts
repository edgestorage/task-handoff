export type RemoteDesktopMetricStatus = 'idle' | 'measuring' | 'active' | 'unavailable';

export type RemoteDesktopRttProbeRequest = {
  requestId: string;
  sentAt: number;
};

export type RemoteDesktopRttProbeSnapshot = {
  status: RemoteDesktopMetricStatus;
  latencyMs?: number;
};

export type RemoteDesktopReceiveRateSnapshot = {
  status: RemoteDesktopMetricStatus;
  mbps?: number;
};

export type RemoteDesktopTransportDiagnostics = {
  path?: 'p2p' | 'turn' | 'websocket';
  protocol?: string;
  localCandidateType?: string;
  remoteCandidateType?: string;
  latencyMs?: number;
  latencyStatus?: RemoteDesktopMetricStatus;
  bandwidthMbps?: number;
  bandwidthStatus?: RemoteDesktopMetricStatus;
  codec?: string;
  frameRate?: number;
};

export type RemoteDesktopFallbackDiagnostics = RemoteDesktopTransportDiagnostics & {
  path: 'websocket';
  latencyStatus: RemoteDesktopMetricStatus;
  bandwidthStatus: RemoteDesktopMetricStatus;
};

/** The app-layer WS ping cannot use browser WebSocket control frames, so the
 * probe keeps one request in flight and completes it from a control pong. */
export const REMOTE_DESKTOP_RTT_INTERVAL_MS = 2_000;
export const REMOTE_DESKTOP_RTT_TIMEOUT_MS = 5_000;
export const REMOTE_DESKTOP_RECEIVE_RATE_WINDOW_MS = 2_000;
export const REMOTE_DESKTOP_DIAGNOSTICS_INTERVAL_MS = 1_000;

const RECEIVE_RATE_BUCKET_MS = 100;
const RECEIVE_RATE_MIN_SAMPLE_MS = 500;

export function remoteDesktopMonotonicNow(performanceValue = globalThis.performance) {
  return typeof performanceValue?.now === 'function' ? performanceValue.now() : Date.now();
}

export class RemoteDesktopRttProbe {
  private pending?: RemoteDesktopRttProbeRequest;
  private latencyMs?: number;
  private failures = 0;
  private attempts = 0;
  private requestCounter = 0;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(now: () => number = () => remoteDesktopMonotonicNow(), timeoutMs = REMOTE_DESKTOP_RTT_TIMEOUT_MS) {
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  begin(): RemoteDesktopRttProbeRequest | undefined {
    const now = this.now();
    this.expire(now);
    if (this.pending) return undefined;
    const requestId = `rtt-${++this.requestCounter}-${Math.floor(now).toString(36)}`;
    this.pending = { requestId, sentAt: now };
    this.attempts += 1;
    return this.pending;
  }

  complete(requestId: string): number | undefined {
    if (!requestId || this.pending?.requestId !== requestId) return undefined;
    const now = this.now();
    const elapsedMs = now - this.pending.sentAt;
    this.pending = undefined;
    if (!(elapsedMs >= 0) || elapsedMs > this.timeoutMs) {
      this.fail();
      return undefined;
    }
    const sample = Math.max(0, Math.round(elapsedMs));
    this.latencyMs = this.latencyMs === undefined
      ? sample
      : Math.max(0, Math.round(this.latencyMs * 0.8 + sample * 0.2));
    this.failures = 0;
    return this.latencyMs;
  }

  cancel(requestId: string) {
    if (this.pending?.requestId === requestId) this.pending = undefined;
  }

  expire(now = this.now()) {
    if (!this.pending || now - this.pending.sentAt <= this.timeoutMs) return false;
    this.pending = undefined;
    this.fail();
    return true;
  }

  snapshot(): RemoteDesktopRttProbeSnapshot {
    if (this.failures >= 2) return { status: 'unavailable' };
    if (this.latencyMs !== undefined) return { status: 'active', latencyMs: this.latencyMs };
    return { status: this.attempts > 0 ? 'measuring' : 'idle' };
  }

  reset() {
    this.pending = undefined;
    this.latencyMs = undefined;
    this.failures = 0;
    this.attempts = 0;
    this.requestCounter = 0;
  }

  private fail() {
    this.failures += 1;
    if (this.failures >= 2) this.latencyMs = undefined;
  }
}

/** Counts bytes actually received on the media WebSocket. The result is a
 * receive rate, not an estimate of available link bandwidth. */
export class RemoteDesktopReceiveRateMeter {
  private readonly buckets = new Map<number, number>();
  private startedAt?: number;
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(now: () => number = () => remoteDesktopMonotonicNow(), windowMs = REMOTE_DESKTOP_RECEIVE_RATE_WINDOW_MS) {
    this.now = now;
    this.windowMs = windowMs;
  }

  add(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    const now = this.now();
    this.startedAt ??= now;
    const bucket = Math.floor(now / RECEIVE_RATE_BUCKET_MS) * RECEIVE_RATE_BUCKET_MS;
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + bytes);
    this.prune(now);
  }

  sample(): RemoteDesktopReceiveRateSnapshot {
    const now = this.now();
    this.prune(now);
    if (this.startedAt === undefined) return { status: 'idle' };
    const elapsedMs = Math.min(this.windowMs, now - this.startedAt);
    if (elapsedMs < RECEIVE_RATE_MIN_SAMPLE_MS) return { status: 'measuring' };
    let bytes = 0;
    for (const value of this.buckets.values()) bytes += value;
    const mbps = Math.round((bytes * 8) / elapsedMs / 1_000 * 10) / 10;
    return { status: 'active', mbps };
  }

  reset() {
    this.buckets.clear();
    this.startedAt = undefined;
  }

  private prune(now: number) {
    const cutoff = now - this.windowMs;
    for (const bucket of this.buckets.keys()) {
      if (bucket < cutoff) this.buckets.delete(bucket);
    }
  }
}
