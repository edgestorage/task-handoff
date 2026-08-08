export type WebSocketConnectionPhase = "connecting" | "handshaking" | "healthy" | "failed" | "closed";
export type WebSocketConnectionTimeout = "connect" | "handshake" | "heartbeat";

type Timer = ReturnType<typeof setTimeout>;

export type WebSocketConnectionSupervisorOptions = {
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  stableThresholdMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  ping: () => void;
  onTimeout: (kind: WebSocketConnectionTimeout) => void;
  onStable?: () => void;
  onPhase?: (phase: WebSocketConnectionPhase) => void;
};

function positive(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function unref(timer: Timer) {
  timer.unref?.();
  return timer;
}

/**
 * Owns the transport-independent lifecycle deadlines for one WebSocket generation.
 * Socket creation, retry scheduling, and state publication remain adapter concerns.
 */
export class WebSocketConnectionSupervisor {
  private readonly connectTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly stableThresholdMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly ping: () => void;
  private readonly onTimeout: (kind: WebSocketConnectionTimeout) => void;
  private readonly onStable?: () => void;
  private readonly onPhase?: (phase: WebSocketConnectionPhase) => void;
  private connectTimer?: Timer;
  private handshakeTimer?: Timer;
  private heartbeatTimer?: Timer;
  private stableTimer?: Timer;
  private awaitingPongSince?: number;
  private stable = false;
  private stopped = false;
  private currentPhase: WebSocketConnectionPhase = "connecting";
  private lastActivityAt?: number;
  private lastPongAt?: number;

  constructor(options: WebSocketConnectionSupervisorOptions) {
    this.connectTimeoutMs = positive(options.connectTimeoutMs, 10_000);
    this.handshakeTimeoutMs = positive(options.handshakeTimeoutMs, 10_000);
    this.heartbeatIntervalMs = positive(options.heartbeatIntervalMs, 25_000);
    this.heartbeatTimeoutMs = positive(options.heartbeatTimeoutMs, 10_000);
    this.stableThresholdMs = positive(options.stableThresholdMs, 60_000);
    this.now = options.now || Date.now;
    this.setTimeoutFn = options.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    this.ping = options.ping;
    this.onTimeout = options.onTimeout;
    this.onStable = options.onStable;
    this.onPhase = options.onPhase;
  }

  get phase() {
    return this.currentPhase;
  }

  start() {
    this.stopped = false;
    this.setPhase("connecting");
    this.clearTimer("connectTimer");
    this.connectTimer = unref(this.setTimeoutFn(() => this.timeout("connect"), this.connectTimeoutMs));
  }

  opened() {
    if (this.stopped) return;
    this.clearTimer("connectTimer");
    this.setPhase("handshaking");
    this.handshakeTimer = unref(this.setTimeoutFn(() => this.timeout("handshake"), this.handshakeTimeoutMs));
    this.scheduleHeartbeat(this.heartbeatIntervalMs);
  }

  healthy() {
    if (this.stopped) return;
    this.clearTimer("handshakeTimer");
    this.activity();
    this.setPhase("healthy");
    if (!this.stable && !this.stableTimer) {
      this.stableTimer = unref(this.setTimeoutFn(() => {
        this.stableTimer = undefined;
        if (this.stopped || this.currentPhase !== "healthy") return;
        this.stable = true;
        this.onStable?.();
      }, this.stableThresholdMs));
    }
  }

  activity() {
    if (!this.stopped) this.lastActivityAt = this.now();
  }

  pong() {
    if (this.stopped) return;
    const timestamp = this.now();
    this.awaitingPongSince = undefined;
    this.lastPongAt = timestamp;
    this.lastActivityAt = timestamp;
    this.scheduleHeartbeat(this.heartbeatIntervalMs);
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.awaitingPongSince = undefined;
    this.setPhase("closed");
  }

  diagnostics() {
    return {
      phase: this.currentPhase,
      stable: this.stable,
      ...(this.lastActivityAt === undefined ? {} : { lastActivityAt: new Date(this.lastActivityAt).toISOString() }),
      ...(this.lastPongAt === undefined ? {} : { lastPongAt: new Date(this.lastPongAt).toISOString() }),
    };
  }

  private scheduleHeartbeat(delay: number) {
    if (this.stopped) return;
    this.clearTimer("heartbeatTimer");
    this.heartbeatTimer = unref(this.setTimeoutFn(() => {
      this.heartbeatTimer = undefined;
      if (this.stopped) return;
      if (this.awaitingPongSince !== undefined) {
        const elapsed = Math.max(0, this.now() - this.awaitingPongSince);
        if (elapsed >= this.heartbeatTimeoutMs) {
          this.timeout("heartbeat");
          return;
        }
        this.scheduleHeartbeat(this.heartbeatTimeoutMs - elapsed);
        return;
      }
      this.awaitingPongSince = this.now();
      try {
        this.ping();
      } catch {
        this.timeout("heartbeat");
        return;
      }
      this.scheduleHeartbeat(this.heartbeatTimeoutMs);
    }, delay));
  }

  private timeout(kind: WebSocketConnectionTimeout) {
    if (this.stopped) return;
    this.clearTimers();
    this.setPhase("failed");
    this.onTimeout(kind);
  }

  private setPhase(phase: WebSocketConnectionPhase) {
    if (this.currentPhase === phase) return;
    this.currentPhase = phase;
    this.onPhase?.(phase);
  }

  private clearTimers() {
    this.clearTimer("connectTimer");
    this.clearTimer("handshakeTimer");
    this.clearTimer("heartbeatTimer");
    this.clearTimer("stableTimer");
  }

  private clearTimer(key: "connectTimer" | "handshakeTimer" | "heartbeatTimer" | "stableTimer") {
    const timer = this[key];
    if (timer) this.clearTimeoutFn(timer);
    this[key] = undefined;
  }
}
