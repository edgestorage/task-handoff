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
  private readonly restoreErrors = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private activeCycle?: Promise<void>;
  private started = false;
  private stopped = false;

  constructor(options: Options) {
    this.options = options;
  }

  markRestored(id: string) {
    this.restoredInstances.add(id);
    this.restoreErrors.delete(id);
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
      const runtime = state.requireRuntime(instance.runtimeId);
      if (runtime.type === "local") return RESTORABLE_INSTANCE_STATUSES.has(instance.status);
      if (runtime.type !== "docker") return false;
      return RESTORABLE_INSTANCE_STATUSES.has(instance.status)
        || (instance.status === "provisioning" && instance.imageProvisioning?.phase === "ready");
    });

    for (const instance of candidates) {
      if (this.stopped) return;
      try {
        await this.options.restoreInstance(instance.id);
        if (this.stopped) return;
        await this.options.autoImport(state.requireInstance(instance.id));
        if (this.stopped) return;
        this.markRestored(instance.id);
      } catch (error) {
        if (this.stopped) return;
        if (state.requireRuntime(instance.runtimeId).type === "local") {
          state.applyInstanceLifecycle(instance.id, { type: "start-failed", error });
        }
        const message = error instanceof Error ? error.message : String(error);
        if (this.restoreErrors.get(instance.id) !== message) {
          this.restoreErrors.set(instance.id, message);
          this.options.warn({
            instanceId: instance.id,
            action: "restore",
            runtimeId: instance.runtimeId,
            error: message,
          }, "node instance restore failed; recovery will retry");
        }
      }
    }
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
      this.scheduleNext();
    });
  }

  private scheduleNext() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.runAndContinue();
    }, this.options.intervalMs ?? 10_000);
    this.timer.unref?.();
  }
}
