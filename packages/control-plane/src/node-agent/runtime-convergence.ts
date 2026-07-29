import {
  ControlledInstanceSchema,
  RuntimeConvergenceErrorSchema,
  type ControlledInstance,
  type RuntimeConvergenceError,
  type RuntimeVersionState,
} from "@task-handoff/protocol/control-plane";

type ConvergenceStore = {
  get(id: string): ControlledInstance | undefined;
  put(instance: ControlledInstance): ControlledInstance;
};

export type RuntimeConvergenceHooks = {
  isInstalled?(instance: ControlledInstance, desiredVersion: string): Promise<boolean>;
  install(instance: ControlledInstance, desiredVersion: string): Promise<void>;
  restart(instance: ControlledInstance): Promise<void>;
  rollback?(instance: ControlledInstance): Promise<void>;
  onForcedDrain?(instance: ControlledInstance): Promise<void> | void;
};

export type RuntimeConvergenceOptions = {
  drainTimeoutMs?: number;
  verificationTimeoutMs?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  now?: () => Date;
  delay?: (milliseconds: number) => Promise<void>;
};

export class RuntimeConvergenceCoordinator {
  private readonly store: ConvergenceStore;
  private readonly desiredVersion: () => string;
  private readonly hooks: RuntimeConvergenceHooks;
  private readonly inFlight = new Map<string, Promise<ControlledInstance>>();
  private readonly requests = new Map<string, { startRequested: boolean; resumeCancelled: boolean }>();
  private readonly cancelled = new Set<string>();
  private readonly now: () => Date;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly drainTimeoutMs: number;
  private readonly verificationTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(
    store: ConvergenceStore,
    desiredVersion: () => string,
    hooks: RuntimeConvergenceHooks,
    options: RuntimeConvergenceOptions = {},
  ) {
    this.store = store;
    this.desiredVersion = desiredVersion;
    this.hooks = hooks;
    this.now = options.now || (() => new Date());
    this.delay = options.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5 * 60_000;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 60_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 3, "maxAttempts");
    this.retryBaseDelayMs = nonnegativeNumber(options.retryBaseDelayMs ?? 1_000, "retryBaseDelayMs");
    this.retryMaxDelayMs = nonnegativeNumber(options.retryMaxDelayMs ?? 30_000, "retryMaxDelayMs");
  }

  schedule(instanceId: string, options: { startRequested?: boolean; resumeCancelled?: boolean } = {}) {
    const request = this.requests.get(instanceId) || { startRequested: false, resumeCancelled: false };
    request.startRequested ||= options.startRequested === true;
    request.resumeCancelled ||= options.resumeCancelled === true || options.startRequested === true;
    if (request.resumeCancelled) this.cancelled.delete(instanceId);
    this.requests.set(instanceId, request);
    const existing = this.inFlight.get(instanceId);
    if (existing) return existing;
    // Start in a microtask so concurrent callers can merge stronger intent (notably
    // startRequested) before a stopped instance is classified as pending-only.
    const running = Promise.resolve()
      .then(() => this.reconcile(instanceId, request))
      .finally(() => {
        this.inFlight.delete(instanceId);
        this.requests.delete(instanceId);
      });
    this.inFlight.set(instanceId, running);
    return running;
  }

  isRunning(instanceId: string) {
    return this.inFlight.has(instanceId);
  }

  cancel(instanceId: string) {
    this.cancelled.add(instanceId);
    return this.inFlight.get(instanceId);
  }

  private async reconcile(instanceId: string, options: { startRequested: boolean; resumeCancelled: boolean }) {
    let instance = this.requireInstance(instanceId);
    const desiredVersion = this.desiredVersion();
    if (this.cancelled.has(instanceId) && !options.resumeCancelled) {
      return this.storePhase(instance, "pending");
    }
    const actualVersion = reportedVersion(instance);
    const desiredReleaseInstalled = actualVersion === desiredVersion
      ? await this.hooks.isInstalled?.(instance, desiredVersion) ?? true
      : false;
    if (this.cancelled.has(instanceId)) return this.storePhase(this.requireInstance(instanceId), "pending");
    if (actualVersion === desiredVersion && desiredReleaseInstalled) {
      return this.storeState(instance, {
        desiredVersion,
        actualVersion,
        phase: "matched",
        attempt: instance.runtimeVersion?.attempt || 0,
        matchedAt: this.timestamp(),
      }, !isStopped(instance) && instance.health !== "failed");
    }

    const sameRollout = instance.runtimeVersion?.desiredVersion === desiredVersion;
    if (sameRollout && (instance.runtimeVersion?.attempt || 0) >= this.maxAttempts) {
      if (instance.runtimeVersion?.phase === "failed" && instance.runtimeVersion.error) return instance;
      return this.storePermanentFailure(instance, desiredVersion, exhaustedError(
        desiredVersion,
        actualVersion,
        this.maxAttempts,
        instance.runtimeVersion?.error,
      ));
    }

    instance = this.storeState(instance, mismatchState(instance, desiredVersion, actualVersion, desiredReleaseInstalled), false);
    if (isStopped(instance) && !options.startRequested) return instance;

    while ((instance.runtimeVersion?.attempt || 0) < this.maxAttempts) {
      if (this.cancelled.has(instanceId)) return this.storePhase(this.requireInstance(instanceId), "pending");
      let failure: RuntimeConvergenceError;
      let installed = false;
      try {
        if (hasActiveWork(instance)) {
          instance = this.storePhase(instance, "draining");
        const drained = await this.waitUntil(instanceId, this.drainTimeoutMs, (candidate) => !hasActiveWork(candidate));
        instance = this.requireInstance(instanceId);
        if (!drained) {
          if (this.cancelled.has(instanceId)) return this.storePhase(instance, "pending");
          await this.hooks.onForcedDrain?.(instance);
        }
        }

        instance = this.storePhase(this.requireInstance(instanceId), "installing", true);
        await this.hooks.install(instance, desiredVersion);
        installed = true;

        if (this.cancelled.has(instanceId) || (isStopped(this.requireInstance(instanceId)) && !options.startRequested)) {
          return this.storePhase(this.requireInstance(instanceId), "pending");
        }

        instance = this.storePhase(this.requireInstance(instanceId), "restarting");
        await this.hooks.restart(instance);
        if (this.cancelled.has(instanceId)) return this.storePhase(this.requireInstance(instanceId), "pending");

        instance = this.storePhase(this.requireInstance(instanceId), "verifying");
        const verified = await this.waitUntil(instanceId, this.verificationTimeoutMs, (candidate) => reportedVersion(candidate) === desiredVersion);
        if (this.cancelled.has(instanceId)) return this.storePhase(this.requireInstance(instanceId), "pending");
        if (!verified) {
          throw convergenceError(
            "INSTANCE_RUNTIME_VERIFICATION_FAILED",
            `Instance ${instanceId} did not register controlled-instance ${desiredVersion} after restart.`,
            desiredVersion,
            reportedVersion(this.requireInstance(instanceId)),
            true,
          );
        }
        const verifiedInstance = this.requireInstance(instanceId);
        if (this.hooks.isInstalled && !await this.hooks.isInstalled(verifiedInstance, desiredVersion)) {
          throw convergenceError(
            "INSTANCE_RUNTIME_VERIFICATION_FAILED",
            `Instance ${instanceId} reported controlled-instance ${desiredVersion}, but its active runtime release is missing.`,
            desiredVersion,
            reportedVersion(verifiedInstance),
            true,
          );
        }
        return this.storeState(verifiedInstance, {
          desiredVersion,
          actualVersion: desiredVersion,
          phase: "matched",
          attempt: verifiedInstance.runtimeVersion?.attempt || 1,
          matchedAt: this.timestamp(),
        }, !isStopped(verifiedInstance) && verifiedInstance.health !== "failed");
      } catch (error) {
        if (this.cancelled.has(instanceId)) return this.storePhase(this.requireInstance(instanceId), "pending");
        failure = normalizeConvergenceError(error, desiredVersion, reportedVersion(this.store.get(instanceId)));
        if (installed && this.hooks.rollback) {
          try {
            await this.hooks.rollback(this.requireInstance(instanceId));
          } catch (rollbackError) {
            failure.message = `${failure.message} Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
            failure.retryable = false;
          }
        }
      }

      instance = this.requireInstance(instanceId);
      const attempt = instance.runtimeVersion?.attempt || 1;
      if (!failure.retryable || attempt >= this.maxAttempts) {
        return this.storePermanentFailure(instance, desiredVersion,
          attempt >= this.maxAttempts && failure.retryable
            ? exhaustedError(desiredVersion, reportedVersion(instance), this.maxAttempts, failure)
            : failure);
      }

      instance = this.storeState(instance, {
        desiredVersion,
        ...(reportedVersion(instance) ? { actualVersion: reportedVersion(instance) } : {}),
        phase: "pending",
        attempt,
        lastAttemptAt: this.timestamp(),
        error: failure,
      }, false);
      await this.delay(this.retryDelayMs(attempt));
    }

    return this.storePermanentFailure(instance, desiredVersion, exhaustedError(
      desiredVersion,
      reportedVersion(instance),
      this.maxAttempts,
      instance.runtimeVersion?.error,
    ));
  }

  private storePermanentFailure(instance: ControlledInstance, desiredVersion: string, error: RuntimeConvergenceError) {
    const actualVersion = reportedVersion(instance);
    return this.storeState(instance, {
      desiredVersion,
      ...(actualVersion ? { actualVersion } : {}),
      phase: "failed",
      attempt: instance.runtimeVersion?.attempt || 0,
      lastAttemptAt: this.timestamp(),
      error: { ...error, retryable: false },
    }, false);
  }

  private retryDelayMs(failedAttempt: number) {
    return Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * (2 ** Math.max(0, failedAttempt - 1)));
  }

  private storePhase(instance: ControlledInstance, phase: RuntimeVersionState["phase"], incrementAttempt = false) {
    const desiredVersion = this.desiredVersion();
    const actualVersion = reportedVersion(instance);
    const previousError = instance.runtimeVersion?.desiredVersion === desiredVersion
      ? instance.runtimeVersion.error
      : undefined;
    return this.storeState(instance, {
      desiredVersion,
      ...(actualVersion ? { actualVersion } : {}),
      phase,
      attempt: (instance.runtimeVersion?.attempt || 0) + (incrementAttempt ? 1 : 0),
      lastAttemptAt: this.timestamp(),
      ...(previousError
        ? { error: previousError }
        : phase === "pending"
          ? { error: mismatchError(desiredVersion, actualVersion) }
          : {}),
    }, false);
  }

  private storeState(instance: ControlledInstance, runtimeVersion: RuntimeVersionState, ready: boolean) {
    // Reconciliation crosses async install, restart, inspection, and verification
    // boundaries. Registration or heartbeat may have advanced the authoritative
    // instance state while those operations were in flight, so only project the
    // convergence fields onto the latest record instead of restoring a stale
    // lifecycle snapshot.
    const current = this.store.get(instance.id) || instance;
    return this.store.put(ControlledInstanceSchema.parse({
      ...current,
      runtimeVersion,
      ready,
      ...(ready ? {} : { health: current.health === "failed" ? "failed" : "degraded" }),
      updatedAt: this.timestamp(),
    }));
  }

  private async waitUntil(instanceId: string, timeoutMs: number, predicate: (instance: ControlledInstance) => boolean) {
    const deadline = this.now().getTime() + timeoutMs;
    while (true) {
      const instance = this.store.get(instanceId);
      if (instance && predicate(instance)) return true;
      if (this.cancelled.has(instanceId)) return false;
      if (this.now().getTime() >= deadline) return false;
      await this.delay(Math.min(this.pollIntervalMs, Math.max(0, deadline - this.now().getTime())));
    }
  }

  private requireInstance(instanceId: string) {
    const instance = this.store.get(instanceId);
    if (!instance) throw new Error(`Instance ${instanceId} was removed during runtime reconciliation.`);
    return instance;
  }

  private timestamp() {
    return this.now().toISOString();
  }
}

export function reportedVersion(instance: ControlledInstance | undefined) {
  return instance?.build?.packageVersion || instance?.instanceVersion;
}

export function hasActiveWork(instance: ControlledInstance) {
  return instance.apps.runningCount > 0 || instance.aiSessions.runningCount > 0;
}

function isStopped(instance: ControlledInstance) {
  return ["created", "stopped", "failed"].includes(instance.status);
}

function mismatchState(instance: ControlledInstance, desiredVersion: string, actualVersion?: string, desiredReleaseInstalled = false): RuntimeVersionState {
  const previous = instance.runtimeVersion;
  const sameRollout = previous?.desiredVersion === desiredVersion && previous.phase !== "matched";
  const resumableAttempt = sameRollout ? previous.attempt : 0;
  const previousError = sameRollout ? previous.error : undefined;
  return {
    desiredVersion,
    ...(actualVersion ? { actualVersion } : {}),
    phase: "pending",
    attempt: resumableAttempt,
    error: previousError || (actualVersion === desiredVersion && !desiredReleaseInstalled
      ? convergenceError(
        "INSTANCE_RUNTIME_VERIFICATION_FAILED",
        `Controlled-instance ${desiredVersion} is running, but the active runtime artifact does not match the desired release identity.`,
        desiredVersion,
        actualVersion,
        true,
      )
      : mismatchError(desiredVersion, actualVersion)),
  };
}

function mismatchError(desiredVersion: string, actualVersion?: string): RuntimeConvergenceError {
  return convergenceError(
    "INSTANCE_RUNTIME_VERSION_MISMATCH",
    `Expected controlled-instance ${desiredVersion}, received ${actualVersion || "an unknown version"}.`,
    desiredVersion,
    actualVersion,
    true,
  );
}

function convergenceError(
  code: RuntimeConvergenceError["code"],
  message: string,
  expectedVersion: string,
  actualVersion: string | undefined,
  retryable: boolean,
): RuntimeConvergenceError {
  return { code, message, expectedVersion, ...(actualVersion ? { actualVersion } : {}), retryable };
}

function normalizeConvergenceError(error: unknown, expectedVersion: string, actualVersion?: string): RuntimeConvergenceError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const candidate = error as { code: unknown; message: unknown; retryable?: unknown };
    const code = RuntimeConvergenceErrorSchema.shape.code.safeParse(candidate.code);
    if (code.success && typeof candidate.message === "string") {
      return convergenceError(code.data, candidate.message, expectedVersion, actualVersion, typeof candidate.retryable === "boolean" ? candidate.retryable : true);
    }
  }
  return convergenceError(
    "INSTANCE_RUNTIME_INSTALL_FAILED",
    error instanceof Error ? error.message : String(error),
    expectedVersion,
    actualVersion,
    true,
  );
}

function exhaustedError(
  expectedVersion: string,
  actualVersion: string | undefined,
  maxAttempts: number,
  previousError?: RuntimeConvergenceError,
): RuntimeConvergenceError {
  const detail = previousError?.message ? ` Last error: ${previousError.message}` : "";
  return convergenceError(
    previousError?.code || "INSTANCE_RUNTIME_INSTALL_FAILED",
    `Runtime convergence exhausted ${maxAttempts} attempts.${detail}`,
    expectedVersion,
    actualVersion,
    false,
  );
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function nonnegativeNumber(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a nonnegative finite number.`);
  return value;
}
