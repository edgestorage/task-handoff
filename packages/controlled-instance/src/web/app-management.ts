import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AppManagementJobSchema,
  AppManagementSnapshotSchema,
  type AppManagementEvent,
  type AppManagementJob,
  type AppManagementOperation,
  type AppManagementSnapshot,
  type FinalComputerCapabilities,
} from "@task-handoff/protocol/control-plane";
import {
  builtinManagedAppDefinitions,
  detectFinalComputerCapabilities,
  detectManagedApp,
  managedAppProjection,
  selectInstallRecipe,
} from "@task-handoff/app-runtime";
import type { InstallRecipe, ManagedAppDefinition, ManagedAppDetectionResult } from "@task-handoff/app-runtime/types";
import { AppRecipeExecutionError, createAppRecipeExecutor, type AppRecipeExecutionContext } from "./app-recipe-executor";

const ACTIVE_STATES = new Set<AppManagementJob["state"]>(["queued", "running"]);
const JOB_LOG_LIMIT = 32_768;
const JOB_FIELDS = new Set(["id", "requestId", "appId", "operation", "state", "phase", "progress", "command", "logTail", "logTruncated", "error", "requestedAt", "startedAt", "finishedAt", "updatedAt"]);

function commandArgument(value: string) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

function commandLine(command: { executable: string; args: string[] }) {
  return [command.executable, ...command.args].map(commandArgument).join(" ");
}

function sanitizedOutput(value: string) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r(?!\n)/g, "\n");
}

function appendJobLog(job: AppManagementJob, value: string) {
  const combined = `${job.logTail || ""}${sanitizedOutput(value)}`;
  const truncated = combined.length > JOB_LOG_LIMIT;
  return {
    logTail: truncated ? combined.slice(-JOB_LOG_LIMIT) : combined,
    ...(job.logTruncated || truncated ? { logTruncated: true } : {}),
  };
}

export class AppManagementRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, statusCode: number, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppManagementRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

type StoredJobs = { schemaVersion: 1; jobs: AppManagementJob[] };

export class AppManagementJobStore {
  private readonly jobs = new Map<string, AppManagementJob>();

  constructor(private readonly filePath: string, private readonly warn: (message: string) => void = () => undefined) {
    this.load();
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  save(job: AppManagementJob) {
    const parsed = AppManagementJobSchema.parse(job);
    this.jobs.set(parsed.id, parsed);
    this.flush();
    return parsed;
  }

  private load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const candidates = Array.isArray(source.jobs) ? source.jobs : [];
      if (Object.keys(source).some((key) => !["schemaVersion", "jobs"].includes(key))) this.warn("App management job store contains unknown top-level fields; they were ignored.");
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          this.warn("An invalid app management job was ignored.");
          continue;
        }
        const record = candidate as Record<string, unknown>;
        const unknown = Object.keys(record).filter((key) => !JOB_FIELDS.has(key));
        if (unknown.length) this.warn(`App management job ${String(record.id || "unknown")} contains unknown fields; they were ignored.`);
        const sanitized = Object.fromEntries([...JOB_FIELDS].filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]));
        const parsed = AppManagementJobSchema.safeParse(sanitized);
        if (!parsed.success) {
          this.warn(`App management job ${String(record.id || "unknown")} is invalid and was ignored.`);
          continue;
        }
        this.jobs.set(parsed.data.id, parsed.data);
      }
    } catch (error) {
      this.warn(`App management job store could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private flush() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: StoredJobs = { schemaVersion: 1, jobs: this.list() };
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}

export type AppManagementManagerOptions = {
  stateDir: string;
  installBaseDir: string;
  definitions?: () => ManagedAppDefinition[];
  capabilities?: () => FinalComputerCapabilities;
  detection?: (definition: ManagedAppDefinition) => ManagedAppDetectionResult;
  execute?: (operation: AppManagementOperation, recipe: InstallRecipe, context: AppRecipeExecutionContext) => Promise<unknown>;
  sessions?: () => Array<{ id: string; appId: string; status: string }>;
  publish?: (event: AppManagementEvent) => void;
  warn?: (message: string) => void;
  now?: () => string;
};

export class AppManagementManager {
  private readonly store: AppManagementJobStore;
  private readonly definitions: () => ManagedAppDefinition[];
  private readonly capabilities: () => FinalComputerCapabilities;
  private readonly detection: (definition: ManagedAppDefinition) => ManagedAppDetectionResult;
  private readonly execute: AppManagementManagerOptions["execute"];
  private readonly sessions: NonNullable<AppManagementManagerOptions["sessions"]>;
  private readonly publishEvent: NonNullable<AppManagementManagerOptions["publish"]>;
  private readonly now: NonNullable<AppManagementManagerOptions["now"]>;
  private readonly streamId = `appstream_${crypto.randomUUID().replaceAll("-", "")}`;
  private sequence = 0;
  private queue = Promise.resolve();

  constructor(options: AppManagementManagerOptions) {
    this.store = new AppManagementJobStore(path.join(options.stateDir, "jobs.json"), options.warn);
    this.definitions = options.definitions || (() => builtinManagedAppDefinitions());
    this.capabilities = options.capabilities || (() => detectFinalComputerCapabilities());
    this.detection = options.detection || ((definition) => detectManagedApp(definition));
    this.execute = options.execute || createAppRecipeExecutor({ installBaseDir: options.installBaseDir, stateDir: options.stateDir });
    this.sessions = options.sessions || (() => []);
    this.publishEvent = options.publish || (() => undefined);
    this.now = options.now || (() => new Date().toISOString());
    this.recoverInterrupted();
  }

  snapshot(): AppManagementSnapshot {
    const capabilities = this.capabilities();
    const jobs = this.store.list();
    const activeJobs = jobs.filter((job) => ACTIVE_STATES.has(job.state));
    const activeByApp = new Map(activeJobs.map((job) => [job.appId, job]));
    const apps = this.definitions().map((definition) => {
      const projection = managedAppProjection(definition, this.detection(definition), capabilities);
      const active = activeByApp.get(projection.id);
      return active ? {
        ...projection,
        canInstall: false,
        canUninstall: false,
        installReason: { code: "OPERATION_IN_PROGRESS" as const, message: "An app management operation is already in progress." },
        uninstallReason: { code: "OPERATION_IN_PROGRESS" as const, message: "An app management operation is already in progress." },
        activeJobId: active.id,
      } : projection;
    });
    return AppManagementSnapshotSchema.parse({
      streamId: this.streamId,
      sequence: this.sequence,
      capabilities,
      apps,
      activeJobs,
      recentJobs: jobs.filter((job) => !ACTIVE_STATES.has(job.state)).slice(0, 50),
      observedAt: this.now(),
    });
  }

  getJob(jobId: string) {
    const job = this.store.get(jobId);
    if (!job) throw new AppManagementRequestError("app_job_not_found", "App management job not found.", 404);
    return job;
  }

  request(appId: string, operation: AppManagementOperation, requestId?: string) {
    const definition = this.definitions().find((entry) => entry.launcher.id === appId);
    if (!definition) throw new AppManagementRequestError("unknown_app", "The requested built-in app does not exist.", 404);
    if (requestId) {
      const prior = this.store.list().find((job) => job.requestId === requestId);
      if (prior) {
        if (prior.appId === appId && prior.operation === operation) return prior;
        throw new AppManagementRequestError("app_request_id_conflict", "The app management request id is already bound to a different operation.", 409, {
          jobId: prior.id,
          appId: prior.appId,
          operation: prior.operation,
        });
      }
    }
    const active = this.store.list().find((job) => job.appId === appId && ACTIVE_STATES.has(job.state));
    if (active) {
      if (active.operation === operation) return active;
      throw new AppManagementRequestError("app_operation_conflict", "A conflicting app operation is already active.", 409, { activeJobId: active.id });
    }
    const runningSessions = operation === "uninstall"
      ? this.sessions().filter((session) => session.appId === appId && ["created", "running", "stopping"].includes(session.status))
      : [];
    if (runningSessions.length) {
      throw new AppManagementRequestError("app_sessions_running", "The app has running sessions and cannot be uninstalled.", 409, { sessionIds: runningSessions.map((session) => session.id) });
    }
    const capabilities = this.capabilities();
    const selected = selectInstallRecipe(definition, capabilities);
    const detection = this.detection(definition);
    const projection = managedAppProjection(definition, detection, capabilities);
    if (!selected.recipe || (operation === "install" ? !projection.canInstall : !projection.canUninstall)) {
      const reason = operation === "install" ? projection.installReason : projection.uninstallReason;
      throw new AppManagementRequestError("app_operation_unavailable", reason?.message || "The requested app operation is unavailable.", 409, { reason });
    }
    const timestamp = this.now();
    const job = this.store.save({
      id: `appjob_${crypto.randomUUID().replaceAll("-", "")}`,
      ...(requestId ? { requestId } : {}),
      appId,
      operation,
      state: "queued",
      requestedAt: timestamp,
      updatedAt: timestamp,
    });
    this.emit(job, true);
    this.queue = this.queue.then(() => this.run(job.id, definition, selected.recipe!)).catch(() => undefined);
    return job;
  }

  waitForIdle() {
    return this.queue;
  }

  snapshotEvent(): AppManagementEvent {
    return {
      type: "app-management",
      streamId: this.streamId,
      sequence: this.sequence,
      observedAt: this.now(),
      snapshot: this.snapshot(),
    };
  }

  private recoverInterrupted() {
    let recovered = false;
    for (const job of this.store.list()) {
      if (!ACTIVE_STATES.has(job.state)) continue;
      recovered = true;
      const timestamp = this.now();
      this.store.save({
        ...job,
        state: "interrupted",
        error: { code: "controlled_instance_restarted", message: "The controlled instance restarted before the operation completed.", retryable: true },
        finishedAt: timestamp,
        updatedAt: timestamp,
      });
    }
    if (recovered) {
      for (const definition of this.definitions()) this.detection(definition);
    }
  }

  private async run(jobId: string, definition: ManagedAppDefinition, recipe: InstallRecipe) {
    let job = this.getJob(jobId);
    let pendingOutput = "";
    let outputTimer: ReturnType<typeof setTimeout> | undefined;
    const flushOutput = () => {
      if (outputTimer) clearTimeout(outputTimer);
      outputTimer = undefined;
      if (!pendingOutput) return;
      const output = pendingOutput;
      pendingOutput = "";
      const current = this.getJob(jobId);
      const updated = this.store.save({ ...current, ...appendJobLog(current, output), updatedAt: this.now() });
      this.emit(updated);
    };
    const scheduleOutputFlush = () => {
      if (outputTimer) return;
      outputTimer = setTimeout(flushOutput, 100);
      outputTimer.unref?.();
    };
    const startedAt = this.now();
    job = this.store.save({ ...job, state: "running", phase: "starting", startedAt, updatedAt: startedAt });
    this.emit(job, true);
    try {
      await this.execute!(job.operation, recipe, {
        appId: job.appId,
        capabilities: this.capabilities(),
        onPhase: (phase, progress) => {
          flushOutput();
          const current = this.getJob(jobId);
          const updated = this.store.save({ ...current, phase, progress, updatedAt: this.now() });
          this.emit(updated);
        },
        onCommand: (command) => {
          flushOutput();
          const current = this.getJob(jobId);
          const updated = this.store.save({
            ...current,
            command,
            ...appendJobLog(current, `${current.logTail && !current.logTail.endsWith("\n") ? "\n" : ""}$ ${commandLine(command)}\n`),
            updatedAt: this.now(),
          });
          this.emit(updated);
        },
        onOutput: (_stream, chunk) => {
          pendingOutput += chunk;
          scheduleOutputFlush();
        },
      });
      flushOutput();
      const detection = this.detection(definition);
      const satisfied = job.operation === "install" ? detection.state === "installed" : detection.state === "not-installed";
      if (!satisfied) throw new AppRecipeExecutionError("postcondition_failed", `App ${job.operation} completed but detection did not confirm the required state.`, true);
      const finishedAt = this.now();
      job = this.store.save({ ...this.getJob(jobId), state: "succeeded", phase: "verify", progress: undefined, finishedAt, updatedAt: finishedAt });
    } catch (error) {
      flushOutput();
      const finishedAt = this.now();
      const code = error instanceof AppRecipeExecutionError ? error.code : "app_operation_failed";
      const retryable = error instanceof AppRecipeExecutionError ? error.retryable : true;
      job = this.store.save({
        ...this.getJob(jobId),
        state: "failed",
        progress: undefined,
        error: { code, message: error instanceof Error ? error.message : String(error), retryable },
        finishedAt,
        updatedAt: finishedAt,
      });
    }
    this.emit(job, true);
  }

  private emit(job: AppManagementJob, includeSnapshot = false) {
    this.publishEvent({
      type: "app-management",
      streamId: this.streamId,
      sequence: ++this.sequence,
      observedAt: this.now(),
      job,
      ...(includeSnapshot ? { snapshot: this.snapshot() } : {}),
    });
  }
}
