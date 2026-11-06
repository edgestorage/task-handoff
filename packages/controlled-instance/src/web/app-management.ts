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
  type ManagedAppManagementSource,
  type ManagedAppUpdateState,
} from "@task-handoff/protocol/control-plane";
import {
  builtinManagedAppDefinitions,
  detectFinalComputerCapabilities,
  detectFinalComputerCapabilitiesAsync,
  detectManagedApp,
  detectManagedAppRecipeTarget,
  detectManagedAppOwnership,
  managedAppLauncherPath,
  managedAppProjection,
  managedNativeAppLauncher,
  managedNativeAppRoot,
  readNativeAppManifest,
  resolveApp,
  selectInstallRecipe,
} from "@task-handoff/app-runtime";
import type { ManagedAppOwnershipResult, ManagedAppRecipeTarget } from "@task-handoff/app-runtime";
import type { InstallRecipe, ManagedAppDefinition, ManagedAppDetectionResult } from "@task-handoff/app-runtime/types";
import { atomicWriteJsonSync } from "@task-handoff/core/storage/atomic-write";
import { AppRecipeExecutionError, createAppRecipeExecutor, type AppRecipeExecutionContext } from "./app-recipe-executor";
import { createAppUpdateChecker, type AppUpdateCheckContext, type AppUpdateCheckResult } from "./app-update-check";
import type { AppInstallEnvironmentManager, AppInstallExecutionPolicy } from "./app-install-environment";

const ACTIVE_STATES = new Set<AppManagementJob["state"]>(["queued", "running"]);
const JOB_LOG_LIMIT = 32_768;
const JOB_FIELDS = new Set(["id", "requestId", "appId", "operation", "state", "phase", "progress", "command", "logTail", "logTruncated", "error", "requestedAt", "startedAt", "finishedAt", "updatedAt"]);

function commandArgument(value: string) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

function recipeTarget(capabilities: FinalComputerCapabilities): ManagedAppRecipeTarget {
  return detectManagedAppRecipeTarget({ platform: capabilities.platform as NodeJS.Platform });
}

function definitionWithManagedLauncher(definition: ManagedAppDefinition, installBaseDir: string, capabilities: FinalComputerCapabilities) {
  const target = managedAppLauncherPath(installBaseDir, definition, capabilities.platform as NodeJS.Platform, capabilities.arch, recipeTarget(capabilities));
  if (!target) return definition;
  const resolved = resolveApp(definition.launcher, process.env, {
    managedAppRoot: installBaseDir,
    managedAppIds: new Set([definition.launcher.id]),
    managedAppTargets: new Map([[definition.launcher.id, target]]),
  });
  return { ...definition, launcher: resolved.app };
}

function pathInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
    const payload: StoredJobs = { schemaVersion: 1, jobs: this.list() };
    atomicWriteJsonSync(this.filePath, payload);
  }
}

export type AppManagementManagerOptions = {
  stateDir: string;
  installBaseDir: string;
  installEnvironment?: AppInstallEnvironmentManager;
  definitions?: () => ManagedAppDefinition[];
  capabilities?: () => FinalComputerCapabilities;
  detection?: (definition: ManagedAppDefinition) => ManagedAppDetectionResult;
  managementSource?: (definition: ManagedAppDefinition, detection: ManagedAppDetectionResult, capabilities: FinalComputerCapabilities) => ManagedAppManagementSource | Promise<ManagedAppManagementSource>;
  ownership?: (definition: ManagedAppDefinition, detection: ManagedAppDetectionResult, capabilities: FinalComputerCapabilities) => ManagedAppOwnershipResult | Promise<ManagedAppOwnershipResult>;
  execute?: (operation: AppManagementOperation, recipe: InstallRecipe, context: AppRecipeExecutionContext, policy?: AppInstallExecutionPolicy) => Promise<unknown>;
  updateCheck?: (recipe: InstallRecipe, context: AppUpdateCheckContext) => Promise<AppUpdateCheckResult>;
  stopAppRuntime?: (appId: string) => void | Promise<void>;
  sessions?: () => Array<{ id: string; appId: string; status: string }>;
  publish?: (event: AppManagementEvent) => void;
  warn?: (message: string) => void;
  now?: () => string;
  onTerminal?: (job: AppManagementJob) => void | Promise<void>;
};

export class AppManagementManager {
  private readonly store: AppManagementJobStore;
  private readonly definitions: () => ManagedAppDefinition[];
  private readonly capabilities: () => FinalComputerCapabilities;
  private readonly refreshCapabilities: () => Promise<FinalComputerCapabilities>;
  private capabilitiesSnapshot?: FinalComputerCapabilities;
  private capabilitiesObservedAt = 0;
  private capabilitiesRefresh?: Promise<FinalComputerCapabilities>;
  private readonly detection: (definition: ManagedAppDefinition) => ManagedAppDetectionResult;
  private readonly ownership: NonNullable<AppManagementManagerOptions["ownership"]>;
  private readonly execute: AppManagementManagerOptions["execute"];
  private readonly updateCheck: NonNullable<AppManagementManagerOptions["updateCheck"]>;
  private readonly stopAppRuntime: NonNullable<AppManagementManagerOptions["stopAppRuntime"]>;
  private readonly sessions: NonNullable<AppManagementManagerOptions["sessions"]>;
  private readonly publishEvent: NonNullable<AppManagementManagerOptions["publish"]>;
  private readonly now: NonNullable<AppManagementManagerOptions["now"]>;
  private readonly onTerminal: NonNullable<AppManagementManagerOptions["onTerminal"]>;
  private readonly warn: NonNullable<AppManagementManagerOptions["warn"]>;
  private readonly installBaseDir: string;
  private readonly installEnvironment?: AppInstallEnvironmentManager;
  private readonly ownershipByApp = new Map<string, { fingerprint: string; source: ManagedAppManagementSource; recipe?: InstallRecipe }>();
  private readonly updateChecks = new Map<string, ManagedAppUpdateState>();
  private ownershipRefresh?: Promise<void>;
  private readonly streamId = `appstream_${crypto.randomUUID().replaceAll("-", "")}`;
  private sequence = 0;
  private queue = Promise.resolve();

  constructor(options: AppManagementManagerOptions) {
    this.store = new AppManagementJobStore(path.join(options.stateDir, "jobs.json"), options.warn);
    this.installBaseDir = options.installBaseDir;
    this.installEnvironment = options.installEnvironment;
    this.definitions = options.definitions || (() => builtinManagedAppDefinitions());
    const withInstallEnvironment = (capabilities: FinalComputerCapabilities) => this.installEnvironment?.capabilities(capabilities) || capabilities;
    this.capabilities = options.capabilities
      ? () => withInstallEnvironment(options.capabilities!())
      : () => this.capabilitiesSnapshot || (this.capabilitiesSnapshot = withInstallEnvironment(detectFinalComputerCapabilities()));
    this.refreshCapabilities = options.capabilities
      ? async () => withInstallEnvironment(options.capabilities!())
      : async () => withInstallEnvironment(await detectFinalComputerCapabilitiesAsync());
    this.detection = options.detection || ((definition) => detectManagedApp(definitionWithManagedLauncher(definition, options.installBaseDir, this.capabilities())));
    const defaultOwnership = (definition: ManagedAppDefinition, detection: ManagedAppDetectionResult, capabilities: FinalComputerCapabilities) => {
      const target = recipeTarget(capabilities);
      const selected = selectInstallRecipe(definition, capabilities, target).recipe;
      if (selected?.type === "node-package" && selected.managed) {
        if (detection.state !== "installed") return { source: "none" as const };
        const root = path.resolve(options.installBaseDir, "node-package", definition.launcher.id);
        return detection.executablePaths.length > 0 && detection.executablePaths.every((value) => pathInside(path.resolve(value), root))
          ? { source: "recipe" as const, recipe: selected }
          : { source: "external" as const };
      }
      return detectManagedAppOwnership(definition, detection, capabilities, {
        target,
        nativeManifestOwned: async (_definition, recipe, detected) => {
          const manifest = readNativeAppManifest(options.installBaseDir, definition.launcher.id);
          const expectedRoot = path.resolve(managedNativeAppRoot(options.installBaseDir, definition.launcher.id));
          const expectedLauncher = path.resolve(managedNativeAppLauncher(options.installBaseDir, definition.launcher.id, recipe.launchPath));
          if (!manifest || manifest.appId !== definition.launcher.id || path.resolve(manifest.installRoot) !== expectedRoot) return false;
          if (path.resolve(managedNativeAppLauncher(options.installBaseDir, definition.launcher.id, manifest.launchPath)) !== expectedLauncher) return false;
          return detected.executablePaths.length > 0 && detected.executablePaths.every((value) => {
            const candidate = path.resolve(value);
            return candidate === expectedLauncher && pathInside(candidate, expectedRoot);
          });
        },
        archiveManifestOwned: async (_definition, recipe, detected) => {
          const expectedRoot = path.resolve(options.installBaseDir, recipe.installRoot);
          const manifestFile = path.join(options.stateDir, "manifests", `${definition.launcher.id}.json`);
          try {
            const manifest = JSON.parse(await fs.promises.readFile(manifestFile, "utf8")) as { installRoot?: unknown; files?: unknown };
            if (manifest.installRoot !== expectedRoot || !Array.isArray(manifest.files)) return false;
            const owned = new Set(manifest.files.map((value) => path.resolve(expectedRoot, String(value))));
            return detected.executablePaths.some((value) => owned.has(path.resolve(value)));
          } catch {
            return false;
          }
        },
      });
    };
    this.ownership = options.ownership || (options.managementSource
      ? async (definition, detection, capabilities) => ({ source: await options.managementSource!(definition, detection, capabilities) })
      : defaultOwnership);
    this.execute = options.execute || createAppRecipeExecutor({
      installBaseDir: options.installBaseDir,
      stateDir: options.stateDir,
      ...(options.installEnvironment ? { installEnvironment: options.installEnvironment } : {}),
    });
    this.updateCheck = options.updateCheck || createAppUpdateChecker({
      stateDir: options.stateDir,
      ...(options.installEnvironment ? { installEnvironment: options.installEnvironment } : {}),
    });
    this.stopAppRuntime = options.stopAppRuntime || (() => undefined);
    this.sessions = options.sessions || (() => []);
    this.publishEvent = options.publish || (() => undefined);
    this.now = options.now || (() => new Date().toISOString());
    this.onTerminal = options.onTerminal || (() => undefined);
    this.warn = options.warn || (() => undefined);
    this.recoverInterrupted();
  }

  snapshot(): AppManagementSnapshot {
    const capabilities = this.capabilities();
    const jobs = this.store.list();
    const activeJobs = jobs.filter((job) => ACTIVE_STATES.has(job.state));
    const activeByApp = new Map(activeJobs.map((job) => [job.appId, job]));
    const apps = this.definitions().map((definition) => {
      const detection = this.detection(definition);
      const cached = this.ownershipByApp.get(definition.launcher.id);
      const fingerprint = this.ownershipFingerprint(detection, capabilities);
      const target = recipeTarget(capabilities);
      const selected = selectInstallRecipe(definition, capabilities, target).recipe;
      const source = detection.state === "not-installed" ? "none"
        : selected?.type === "bundled" ? "bundled"
          : cached?.fingerprint === fingerprint ? cached.source : "external";
      const projection = managedAppProjection(definition, detection, capabilities, source, target);
      const active = activeByApp.get(projection.id);
      const check = this.updateChecks.get(projection.id);
      const projected = check ? { ...projection, updateCheck: check } : projection;
      return active ? {
        ...projected,
        canInstall: false,
        canUninstall: false,
        canUpdate: false,
        installReason: { code: "OPERATION_IN_PROGRESS" as const, message: "An app management operation is already in progress." },
        uninstallReason: { code: "OPERATION_IN_PROGRESS" as const, message: "An app management operation is already in progress." },
        activeJobId: active.id,
      } : projected;
    });
    return AppManagementSnapshotSchema.parse({
      streamId: this.streamId,
      sequence: this.sequence,
      capabilities,
      apps,
      activeJobs,
      recentJobs: jobs.filter((job) => !ACTIVE_STATES.has(job.state)).slice(0, 50),
      ...(this.installEnvironment ? { installEnvironment: this.installEnvironment.snapshot() } : {}),
      observedAt: this.now(),
    });
  }

  async refreshSnapshot(forceCapabilities = false) {
    if (!this.ownershipRefresh) {
      this.ownershipRefresh = (async () => {
        const capabilities = await this.ensureCapabilities(forceCapabilities);
        await Promise.all(this.definitions().map(async (definition) => {
          const detection = this.detection(definition);
          await this.refreshOwnership(definition, detection, capabilities);
        }));
      })().finally(() => {
        this.ownershipRefresh = undefined;
      });
    }
    await this.ownershipRefresh;
    return this.snapshot();
  }

  getJob(jobId: string) {
    const job = this.store.get(jobId);
    if (!job) throw new AppManagementRequestError("app_job_not_found", "App management job not found.", 404);
    return job;
  }

  async checkForUpdate(appId: string) {
    const definition = this.definitions().find((entry) => entry.launcher.id === appId);
    if (!definition) throw new AppManagementRequestError("unknown_app", "The requested built-in app does not exist.", 404);
    const capabilities = await this.ensureCapabilities();
    const target = recipeTarget(capabilities);
    const selected = selectInstallRecipe(definition, capabilities, target);
    const detection = this.detection(definition);
    const cached = this.ownershipByApp.get(definition.launcher.id);
    const fingerprint = this.ownershipFingerprint(detection, capabilities);
    const source = detection.state === "not-installed" ? "none"
      : selected.recipe?.type === "bundled" ? "bundled"
        : cached?.fingerprint === fingerprint ? cached.source : "external";
    const projection = managedAppProjection(definition, detection, capabilities, source, target);
    if (!selected.recipe || projection.canUpdate !== true) {
      throw new AppManagementRequestError("app_operation_unavailable", projection.updateReason?.message || "The requested app update check is unavailable.", 409, { reason: projection.updateReason });
    }
    let outcome: AppUpdateCheckResult;
    try {
      outcome = await this.updateCheck(selected.recipe, { appId, capabilities, installBaseDir: this.installBaseDir });
    } catch (error) {
      outcome = { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
    const state: ManagedAppUpdateState = {
      status: outcome.status,
      ...(outcome.installedVersion ? { installedVersion: outcome.installedVersion } : {}),
      ...(outcome.latestVersion ? { latestVersion: outcome.latestVersion } : {}),
      checkedAt: this.now(),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
    this.updateChecks.set(appId, state);
    this.publishSnapshot();
    return { appId, ...state };
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
    const runningSessions = operation !== "install"
      ? this.sessions().filter((session) => session.appId === appId && ["created", "running", "stopping"].includes(session.status))
      : [];
    if (runningSessions.length) {
      throw new AppManagementRequestError("app_sessions_running", "The app has running sessions and cannot be changed.", 409, { sessionIds: runningSessions.map((session) => session.id) });
    }
    const capabilities = this.capabilities();
    const target = recipeTarget(capabilities);
    const selected = selectInstallRecipe(definition, capabilities, target);
    const detection = this.detection(definition);
    const cached = this.ownershipByApp.get(definition.launcher.id);
    const fingerprint = this.ownershipFingerprint(detection, capabilities);
    const source = detection.state === "not-installed" ? "none"
      : selected.recipe?.type === "bundled" ? "bundled"
        : cached?.fingerprint === fingerprint ? cached.source : "external";
    const projection = managedAppProjection(definition, detection, capabilities, source, target);
    const operationRecipe = operation === "uninstall" && cached?.fingerprint === fingerprint && cached.recipe ? cached.recipe : selected.recipe;
    const availability = operation === "install"
      ? { allowed: projection.canInstall, reason: projection.installReason }
      : operation === "uninstall"
        ? { allowed: projection.canUninstall, reason: projection.uninstallReason }
        : { allowed: projection.canUpdate === true, reason: projection.updateReason };
    if (!operationRecipe || !availability.allowed) {
      const reason = availability.reason;
      throw new AppManagementRequestError("app_operation_unavailable", reason?.message || "The requested app operation is unavailable.", 409, { reason });
    }
    const installPolicy = this.installEnvironment?.createExecutionPolicy();
    const timestamp = this.now();
    const job = this.store.save({
      id: `appjob_${crypto.randomUUID().replaceAll("-", "")}`,
      ...(requestId ? { requestId } : {}),
      ...(installPolicy ? { installSourceRevision: installPolicy.revision } : {}),
      appId,
      operation,
      state: "queued",
      requestedAt: timestamp,
      updatedAt: timestamp,
    });
    this.emit(job, true);
    this.queue = this.queue.then(() => this.run(job.id, definition, operationRecipe, installPolicy)).catch(() => undefined);
    return job;
  }

  hasActiveOperation(appId: string) {
    return this.store.list().some((job) => job.appId === appId && ACTIVE_STATES.has(job.state));
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

  publishSnapshot() {
    const event: AppManagementEvent = {
      type: "app-management",
      streamId: this.streamId,
      sequence: ++this.sequence,
      observedAt: this.now(),
      snapshot: this.snapshot(),
    };
    this.publishEvent(event);
    return event;
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

  private async run(jobId: string, definition: ManagedAppDefinition, recipe: InstallRecipe, installPolicy?: AppInstallExecutionPolicy) {
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
      if (job.operation !== "install") {
        const active = this.sessions().filter((session) => session.appId === job.appId && ["created", "running", "stopping"].includes(session.status));
        if (active.length) throw new AppRecipeExecutionError("app_sessions_running", "The app has running sessions and cannot be changed.", true);
        await this.stopAppRuntime(job.appId);
      }
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
      }, installPolicy);
      flushOutput();
      const detection = this.detection(definition);
      const satisfied = job.operation === "uninstall" ? detection.state === "not-installed" : detection.state === "installed";
      if (!satisfied) throw new AppRecipeExecutionError("postcondition_failed", `App ${job.operation} completed but detection did not confirm the required state.`, true);
      await this.refreshOwnership(definition, detection, await this.ensureCapabilities(true));
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
    this.updateChecks.delete(job.appId);
    this.emit(job, true);
    void Promise.resolve(this.onTerminal(job)).catch((error) => {
      this.warn(`App inventory refresh failed after ${job.operation} for ${job.appId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private ownershipFingerprint(detection: ManagedAppDetectionResult, capabilities: FinalComputerCapabilities) {
    return JSON.stringify({ state: detection.state, executablePaths: detection.executablePaths, platform: capabilities.platform, arch: capabilities.arch, privilege: capabilities.privilege });
  }

  private async ensureCapabilities(force = false) {
    if (!force && this.capabilitiesSnapshot && Date.now() - this.capabilitiesObservedAt < 10_000) return this.capabilitiesSnapshot;
    if (!this.capabilitiesRefresh) {
      this.capabilitiesRefresh = this.refreshCapabilities().then((capabilities) => {
        this.capabilitiesSnapshot = capabilities;
        this.capabilitiesObservedAt = Date.now();
        return capabilities;
      }).finally(() => {
        this.capabilitiesRefresh = undefined;
      });
    }
    return this.capabilitiesRefresh;
  }

  private async refreshOwnership(definition: ManagedAppDefinition, detection: ManagedAppDetectionResult, capabilities: FinalComputerCapabilities) {
    let source: ManagedAppManagementSource;
    try {
      const ownership = await this.ownership(definition, detection, capabilities);
      source = ownership.source;
      this.ownershipByApp.set(definition.launcher.id, { fingerprint: this.ownershipFingerprint(detection, capabilities), source, recipe: ownership.recipe });
      return source;
    } catch (error) {
      source = detection.state === "not-installed" ? "none" : selectInstallRecipe(definition, capabilities, recipeTarget(capabilities)).recipe?.type === "bundled" ? "bundled" : "external";
      this.warn(`App ownership detection failed for ${definition.launcher.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.ownershipByApp.set(definition.launcher.id, { fingerprint: this.ownershipFingerprint(detection, capabilities), source });
    return source;
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
