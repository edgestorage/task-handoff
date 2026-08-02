import { ControlledInstanceSchema, type ControlledInstance } from "@task-handoff/protocol/control-plane";
import type { RuntimeConvergenceCoordinator } from "./runtime-convergence.ts";
import type { RuntimeAdapterRegistry } from "./runtimes/adapters.ts";
import type { NodeAgentState } from "./state.ts";

const RESTORABLE_INSTANCE_STATUSES = new Set<ControlledInstance["status"]>([
  "provisioning",
  "starting",
  "registering",
  "registered",
  "running",
]);

type Logger = (data: Record<string, unknown>, message: string) => void;

type Options = {
  state: NodeAgentState;
  runtimeAdapters: RuntimeAdapterRegistry;
  convergence: RuntimeConvergenceCoordinator;
  restoreInstance(id: string): Promise<unknown>;
  autoImport(instance: ControlledInstance): Promise<unknown>;
  provisionImage(instance: ControlledInstance): void;
  stopImageProvisioning(): Promise<void>;
  usesManagedArtifact(instance: ControlledInstance): boolean;
  warn: Logger;
  error: Logger;
  intervalMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  crashStableWindowMs?: number;
  nowMs?: () => number;
  runInstanceOperation?<T>(instanceId: string, operation: () => Promise<T>): Promise<T>;
};

function now() {
  return new Date().toISOString();
}

function resumableLocalShutdownState(instance: ControlledInstance) {
  return ControlledInstanceSchema.parse({
    ...instance,
    health: "unknown",
    connectionStatus: "offline",
    agentStatus: "offline",
    targetStatus: "unknown",
    uiAccessStatus: "unknown",
    target: { ...instance.target, status: "unknown" },
    updatedAt: now(),
  });
}

export class NodeAgentRecoverySupervisor {
  private readonly options: Options;
  private readonly restoredInstances = new Set<string>();
  private readonly restoreErrors = new Map<string, { message: string; attempt: number; nextAttemptAt: number }>();
  private readonly unexpectedExitRetries = new Map<string, { attempt: number; lastExitAt: number }>();
  private readonly suppressedInstances = new Set<string>();
  private readonly pendingUnexpectedExits = new Map<string, unknown>();
  private readonly activeRestores = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setTimeout>;
  private activeCycle?: Promise<void>;
  private cycleRequested = false;
  private cycleRequestDelayMs?: number;
  private started = false;
  private stopped = false;

  constructor(options: Options) {
    this.options = options;
  }

  markRestored(id: string) {
    const status = this.options.state.requireInstance(id).status;
    if (["failed", "stopping", "stopped"].includes(status)) return false;
    this.restoredInstances.add(id);
    this.restoreErrors.delete(id);
    return true;
  }

  allowRecovery(id: string) {
    this.suppressedInstances.delete(id);
    const pendingExit = this.pendingUnexpectedExits.get(id);
    if (pendingExit !== undefined) {
      this.pendingUnexpectedExits.delete(id);
      this.applyUnexpectedLocalExit(id, pendingExit);
    }
  }

  completeSuppressedOperation(id: string) {
    this.pendingUnexpectedExits.delete(id);
    this.restoredInstances.delete(id);
    this.restoreErrors.delete(id);
    this.unexpectedExitRetries.delete(id);
  }

  forgetInstance(id: string) {
    this.restoredInstances.delete(id);
    this.restoreErrors.delete(id);
    this.unexpectedExitRetries.delete(id);
    this.suppressedInstances.delete(id);
    this.activeRestores.delete(id);
    this.pendingUnexpectedExits.delete(id);
  }

  async suppressRecovery(id: string) {
    this.suppressedInstances.add(id);
    await this.activeRestores.get(id)?.catch(() => undefined);
  }

  handleUnexpectedLocalExit(instanceId: string, error: unknown) {
    if (this.stopped) return;
    if (this.suppressedInstances.has(instanceId)) {
      this.pendingUnexpectedExits.set(instanceId, error);
      return;
    }
    this.applyUnexpectedLocalExit(instanceId, error);
  }

  private applyUnexpectedLocalExit(instanceId: string, error: unknown) {
    const instance = this.options.state.requireInstance(instanceId);
    if (this.options.state.requireRuntime(instance.runtimeId).type !== "local") return;
    this.restoredInstances.delete(instanceId);
    const timestamp = this.options.nowMs?.() ?? Date.now();
    const previous = this.unexpectedExitRetries.get(instanceId);
    const stableWindow = this.options.crashStableWindowMs ?? 30_000;
    const attempt = previous && timestamp - previous.lastExitAt < stableWindow
      ? previous.attempt + 1
      : 1;
    this.unexpectedExitRetries.set(instanceId, { attempt, lastExitAt: timestamp });
    const base = this.options.retryBaseDelayMs ?? 1_000;
    const delay = attempt === 1
      ? 0
      : Math.min(this.options.retryMaxDelayMs ?? 30_000, base * (2 ** Math.min(attempt - 2, 10)));
    const message = error instanceof Error ? error.message : String(error);
    this.restoreErrors.set(instanceId, { message, attempt, nextAttemptAt: timestamp + delay });
    this.options.state.applyInstanceLifecycle(instanceId, { type: "runtime-exited", error });
    this.requestCycle(delay);
  }

  async restoreManagedInstances() {
    if (this.stopped) return;
    const { state } = this.options;
    for (const instance of state.listInstances()) {
      if (this.stopped) return;
      const runtime = state.requireRuntime(instance.runtimeId);
      if (
        runtime.type === "docker"
        && ["provisioning", "starting"].includes(instance.status)
        && instance.imageProvisioning?.phase !== "ready"
      ) {
        this.options.provisionImage(instance);
      }
    }

    const candidates = state.listInstances().filter((instance) => {
      if (this.restoredInstances.has(instance.id)) return false;
      if (this.suppressedInstances.has(instance.id)) return false;
      const runtime = state.requireRuntime(instance.runtimeId);
      if (runtime.type === "local") {
        const retry = this.restoreErrors.get(instance.id);
        return (RESTORABLE_INSTANCE_STATUSES.has(instance.status) || instance.status === "failed")
          && (!retry || retry.nextAttemptAt <= (this.options.nowMs?.() ?? Date.now()));
      }
      if (runtime.type !== "docker") return false;
      return RESTORABLE_INSTANCE_STATUSES.has(instance.status)
        || (instance.status === "provisioning" && instance.imageProvisioning?.phase === "ready");
    });

    await Promise.all(candidates.map(async (instance) => {
      if (this.stopped) return;
      const restore = async () => {
        if (this.stopped) return;
        const current = state.listInstances().find((candidate) => candidate.id === instance.id);
        if (!current) return;
        if (!this.isRestoreCandidate(current)) return;
        const retryAtStart = this.restoreErrors.get(current.id);
        try {
          const restoring = this.options.restoreInstance(current.id);
          this.activeRestores.set(current.id, restoring);
          try {
            await restoring;
          } finally {
            if (this.activeRestores.get(current.id) === restoring) this.activeRestores.delete(current.id);
          }
          if (this.stopped || this.suppressedInstances.has(current.id)) return;
          await this.options.autoImport(state.requireInstance(current.id));
          if (this.stopped || this.suppressedInstances.has(current.id)) return;
          if (this.restoreErrors.get(current.id) !== retryAtStart) return;
          if (!this.markRestored(current.id)) {
            throw new Error(`Restored instance ${current.id} did not reach a recoverable running state.`);
          }
        } catch (error) {
          if (this.stopped || this.suppressedInstances.has(current.id)) return;
          if (state.requireRuntime(current.runtimeId).type === "local") {
            state.applyInstanceLifecycle(current.id, { type: "start-failed", error });
          }
          const message = error instanceof Error ? error.message : String(error);
          const previous = this.restoreErrors.get(current.id);
          const attempt = (previous?.attempt ?? 0) + 1;
          const base = this.options.retryBaseDelayMs ?? 1_000;
          const delay = Math.min(this.options.retryMaxDelayMs ?? 30_000, base * (2 ** Math.min(attempt - 1, 10)));
          const nextAttemptAt = (this.options.nowMs?.() ?? Date.now()) + delay;
          this.restoreErrors.set(current.id, { message, attempt, nextAttemptAt });
          if (previous?.message !== message || previous.attempt !== attempt) {
            this.options.warn({
              instanceId: current.id,
              action: "restore",
              runtimeId: current.runtimeId,
              error: message,
              attempt,
              nextAttemptAt: new Date(nextAttemptAt).toISOString(),
            }, "node instance restore failed; recovery will retry");
          }
        }
      };
      await (this.options.runInstanceOperation?.(instance.id, restore) ?? restore());
    }));
  }

  private isRestoreCandidate(instance: ControlledInstance) {
    if (this.restoredInstances.has(instance.id) || this.suppressedInstances.has(instance.id)) return false;
    const runtime = this.options.state.requireRuntime(instance.runtimeId);
    if (runtime.type === "local") {
      const retry = this.restoreErrors.get(instance.id);
      return (RESTORABLE_INSTANCE_STATUSES.has(instance.status) || instance.status === "failed")
        && (!retry || retry.nextAttemptAt <= (this.options.nowMs?.() ?? Date.now()));
    }
    if (runtime.type !== "docker") return false;
    return RESTORABLE_INSTANCE_STATUSES.has(instance.status)
      || (instance.status === "provisioning" && instance.imageProvisioning?.phase === "ready");
  }

  async recoverManagedInstances() {
    if (this.stopped) return;
    const { state, convergence } = this.options;
    const candidates = state.listInstances().filter((instance) => (
      this.options.usesManagedArtifact(instance)
      && !convergence.isRunning(instance.id)
      // A persisted runtime must be re-inspected before convergence consumes
      // its identity. Instances started in this process already have a target.
      && (this.restoredInstances.has(instance.id) || instance.target.status !== "unknown")
      && (!instance.ready || instance.runtimeVersion?.phase !== "matched")
      && !["created", "stopped", "failed", "provisioning", "stopping"].includes(instance.status)
    ));
    await Promise.all(candidates.map(async (instance) => {
      if (this.stopped) return;
      try {
        await convergence.schedule(instance.id);
      } catch (error) {
        this.options.error({ instanceId: instance.id, error }, "runtime convergence recovery failed");
      }
    }));
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.runAndContinue();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const imageProvisioningStopped = this.options.stopImageProvisioning();
    const cancellations = this.options.state.listInstances().map((instance) => this.options.convergence.cancel(instance.id));
    await Promise.all(cancellations);
    await this.activeCycle;
    await imageProvisioningStopped;
    await this.options.runtimeAdapters.stopAll();
    for (const instance of this.options.state.listInstances()) {
      if (this.options.state.requireRuntime(instance.runtimeId).type === "local") {
        this.options.state.controlledInstances.put(resumableLocalShutdownState(instance));
      }
    }
  }

  private async runCycle() {
    await this.restoreManagedInstances();
    if (this.stopped) return;
    await this.recoverManagedInstances();
  }

  private runAndContinue() {
    if (this.stopped) return;
    const cycle = this.runCycle()
      .catch((error) => this.options.error({ error }, "node agent startup recovery cycle failed"));
    this.activeCycle = cycle;
    void cycle.finally(() => {
      if (this.activeCycle === cycle) this.activeCycle = undefined;
      if (this.cycleRequested) {
        this.cycleRequested = false;
        this.cycleRequestDelayMs = undefined;
        this.scheduleNext();
      } else {
        this.scheduleNext();
      }
    });
  }

  private scheduleNext() {
    if (this.stopped) return;
    const timestamp = this.options.nowMs?.() ?? Date.now();
    const instances = new Map(this.options.state.listInstances().map((instance) => [instance.id, instance]));
    const nextRetryAt = [...this.restoreErrors.entries()].reduce((earliest, [instanceId, retry]) => {
      const instance = instances.get(instanceId);
      if (!instance || this.restoredInstances.has(instanceId) || this.suppressedInstances.has(instanceId)) return earliest;
      if (this.options.state.requireRuntime(instance.runtimeId).type !== "local") return earliest;
      if (!RESTORABLE_INSTANCE_STATUSES.has(instance.status) && instance.status !== "failed") return earliest;
      return Math.min(earliest, retry.nextAttemptAt);
    }, Number.POSITIVE_INFINITY);
    const delay = Math.min(
      this.options.intervalMs ?? 10_000,
      Math.max(0, nextRetryAt - timestamp),
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.runAndContinue();
    }, delay);
    this.timer.unref?.();
  }

  private requestCycle(delayMs = 0) {
    if (!this.started || this.stopped) return;
    if (this.activeCycle) {
      this.cycleRequested = true;
      this.cycleRequestDelayMs = this.cycleRequestDelayMs === undefined
        ? delayMs
        : Math.min(this.cycleRequestDelayMs, delayMs);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.runAndContinue();
    }, delayMs);
    this.timer.unref?.();
  }
}
