import type { NodeRuntime } from "@task-handoff/protocol/control-plane";

const DEFAULT_INTERVAL_MS = 15_000;
const MINIMUM_INTERVAL_MS = 1_000;

export type RuntimeAvailabilityTarget = {
  runtime: NodeRuntime;
  probe(): Promise<Partial<NodeRuntime> | undefined>;
};

export type RuntimeAvailabilityMonitorHooks = {
  listTargets(): RuntimeAvailabilityTarget[];
  apply(runtime: NodeRuntime, patch: Partial<NodeRuntime>): Promise<void> | void;
  onAvailable?(next: NodeRuntime, previous: NodeRuntime): void;
  onUnavailable?(next: NodeRuntime, previous: NodeRuntime): void;
  onProbeError?(runtime: NodeRuntime, error: unknown): void;
  onCycleError?(error: unknown): void;
};

export type RuntimeAvailabilityMonitorOptions = {
  intervalMs?: number;
};

export function runtimeAvailabilityIntervalMs(value: string | number | undefined) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return DEFAULT_INTERVAL_MS;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MINIMUM_INTERVAL_MS, Math.trunc(parsed));
}

function availabilitySignature(runtime: NodeRuntime, patch: Partial<NodeRuntime>) {
  return JSON.stringify({
    status: patch.status ?? runtime.status,
    capabilities: patch.capabilities ?? runtime.capabilities,
  });
}

/**
 * Keeps every probeable runtime's persisted availability fresh so instances can
 * explain themselves with the authoritative runtime record instead of with
 * whichever operation happened to fail last. Availability is producer-owned
 * node topology state: instances never derive or persist it themselves.
 */
export class RuntimeAvailabilityMonitor {
  private readonly hooks: RuntimeAvailabilityMonitorHooks;
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private probing = false;
  private stopped = false;

  constructor(hooks: RuntimeAvailabilityMonitorHooks, options: RuntimeAvailabilityMonitorOptions = {}) {
    this.hooks = hooks;
    this.intervalMs = runtimeAvailabilityIntervalMs(options.intervalMs);
  }

  start() {
    if (this.stopped || this.timer) return;
    void this.runCycle();
  }

  /** Probe every runtime immediately instead of waiting for the next interval. */
  async checkNow() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.runCycle();
  }

  /** Probe a single runtime on demand; returns false when the runtime is not probeable here. */
  async checkRuntime(runtimeId: string) {
    const target = this.hooks.listTargets().find((candidate) => candidate.runtime.id === runtimeId);
    if (!target) return false;
    await this.probeTarget(target);
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async runCycle() {
    if (this.stopped) return;
    try {
      await this.probeAll();
    } catch (error) {
      this.hooks.onCycleError?.(error);
    }
    this.schedule(this.intervalMs);
  }

  private schedule(delayMs: number) {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runCycle();
    }, delayMs);
    this.timer.unref?.();
  }

  private async probeAll() {
    if (this.stopped || this.probing) return;
    this.probing = true;
    try {
      for (const target of this.hooks.listTargets()) {
        if (this.stopped) return;
        await this.probeTarget(target);
      }
    } finally {
      this.probing = false;
    }
  }

  private async probeTarget(target: RuntimeAvailabilityTarget) {
    const runtime = target.runtime;
    let patch: Partial<NodeRuntime> | undefined;
    try {
      patch = await target.probe();
    } catch (error) {
      this.hooks.onProbeError?.(runtime, error);
      return;
    }
    if (!patch) return;
    if (availabilitySignature(runtime, patch) !== availabilitySignature(runtime, {})) {
      await this.hooks.apply(runtime, patch);
    }
    const nextStatus = patch.status ?? runtime.status;
    if (nextStatus === runtime.status) return;
    const next = { ...runtime, ...patch, status: nextStatus };
    if (nextStatus === "online") {
      this.hooks.onAvailable?.(next, runtime);
    } else if (nextStatus === "offline" || nextStatus === "degraded") {
      this.hooks.onUnavailable?.(next, runtime);
    }
  }
}
