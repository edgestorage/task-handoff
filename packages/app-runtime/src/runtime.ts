import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import type { IPty } from "node-pty";
import { spawn as spawnPty } from "node-pty";
import writeFileAtomic from "write-file-atomic";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";
import { TTY_STREAM_PROTOCOL_VERSION } from "@task-handoff/protocol/app-sessions";
import { AppCatalogRepository, executablePath } from "./catalog";
import { builtinManagedAppRegistry } from "./managed-app-definitions";
import type { ManagedAppRegistry } from "./managed-app-definitions/registry";
import type { ManagedAppPreparedTtyLaunch, ManagedAppRuntimeExtension, ManagedAppRuntimeHost } from "./managed-app-definitions/types";
import { ensureNodePtySpawnHelperExecutable, formatGuiScale, guiAppHomeDir, guiScaleFromEnv, guiVncBackend, type GuiVncBackend } from "./runtime-utils";
import type { AppAutomationStatus, AppCatalogItem, AppDisplayTarget, AppLaunchOptions, AppSession, AppSessionStatus } from "./types";
import { enforceInstanceLogBudget, RotatingLogWriter } from "./log-retention";
import { TerminalScreenState } from "./terminal-screen-state";

type TtyClient = {
  send: (value: string) => void;
  close?: () => void;
  on: (event: "message" | "close", listener: (value?: unknown) => void) => void;
};

type RuntimeSession = {
  metadata: AppSession;
  processes: ChildProcessWithoutNullStreams[];
  appLifecycle?: ManagedAppPreparedTtyLaunch;
  pty?: IPty;
  ttyDimensions?: { cols: number; rows: number };
  ttyLogStream?: Writable;
  ttyLogClosed?: boolean;
  terminalScreen?: TerminalScreenState;
  clients: Set<TtyClient>;
  stopping?: boolean;
};

type SharedDisplayRuntimeSession = {
  id: string;
  display: string;
  width: number;
  height: number;
  depth: number;
  backend: GuiVncBackend;
  vncPort: number;
  websockifyPort?: number;
  xPid?: number;
  wmPid?: number;
  compositorPid?: number;
  xauthority?: string;
  sessionDir: string;
  logDir: string;
  processes: ChildProcessWithoutNullStreams[];
  appSessionIds: Set<string>;
};

type ManagedProcessTree = {
  pid: number;
  child?: ChildProcessWithoutNullStreams;
  pty?: IPty;
  rootExited: boolean;
  stopPromise?: Promise<void>;
};

function sessionId() {
  return `app_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

function now() {
  return new Date().toISOString();
}

function envFlag(name: string, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function definedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

const DISPLAY_START = 101;
const DISPLAY_END = 199;
const VNC_PORT_START = 6101;
const VNC_PORT_END = 6199;
const WEBSOCKIFY_PORT_START = 7101;
const WEBSOCKIFY_PORT_END = 7199;
const WEB_PORT_START = 8101;
const WEB_PORT_END = 8199;
const CDP_PORT_START = 9201;
const CDP_PORT_END = 9299;
const APP_PROCESS_STOP_TIMEOUT_MS = 5_000;
const APP_PROCESS_KILL_TIMEOUT_MS = 1_000;
const CLEANABLE_SESSION_STATUSES = new Set<AppSessionStatus>(["stopped", "exited", "failed"]);
const DEFAULT_SESSION_RETENTION_DAYS = 7;
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class AppRuntimeManager extends EventEmitter {
  private readonly paths: TaskHandoffStoragePaths;
  private readonly registry: ManagedAppRegistry;
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly persistedSessions = new Map<string, AppSession>();
  private nextDisplay = DISPLAY_START;
  private nextVncPort = VNC_PORT_START;
  private nextWebsockifyPort = WEBSOCKIFY_PORT_START;
  private nextWebPort = WEB_PORT_START;
  private nextCdpPort = CDP_PORT_START;
  private readonly sharedDisplays = new Map<string, SharedDisplayRuntimeSession>();
  private readonly appRuntimeExtensions = new Map<string, ManagedAppRuntimeExtension>();
  private readonly managedProcessTrees = new Map<number, ManagedProcessTree>();
  private readonly catalogRepository: AppCatalogRepository;
  private readonly persistSessionMetadata: boolean;
  private managedEnvironment: NodeJS.ProcessEnv = {};
  private draining = false;
  private readonly maintenanceTimer?: ReturnType<typeof setInterval>;

  constructor(paths: TaskHandoffStoragePaths, registry: ManagedAppRegistry = builtinManagedAppRegistry) {
    super();
    this.paths = paths;
    this.registry = registry;
    this.catalogRepository = new AppCatalogRepository(paths, registry);
    const host: ManagedAppRuntimeHost = {
      paths,
      allocatePort: (kind) => this.allocatePort(kind),
      hasCommand: (command, env, cwd) => this.hasCommand(command, env, cwd),
      spawnLogged: (command, args, env, logDir, logName, cwd) => this.spawnLogged(command, args, env, logDir, logName, cwd),
      stopProcessTree: (child, signal) => this.requestManagedProcessTreeStop(child.pid, signal || "SIGTERM", child),
      waitForUnixSocket: (socketPath, timeoutMs, getError) => this.waitForUnixSocket(socketPath, timeoutMs, getError),
      patchSession: (sessionId, patch) => this.patchSessionMetadata(sessionId, patch),
    };
    for (const provider of registry.providers) {
      if (provider.createRuntime) this.appRuntimeExtensions.set(provider.id, provider.createRuntime(host));
    }
    this.persistSessionMetadata = envFlag("TASK_HANDOFF_APP_SESSION_PERSIST");
    if (this.persistSessionMetadata) {
      this.loadPersistedSessions();
    }
    this.safeRunPersistenceMaintenance();
    this.maintenanceTimer = setInterval(() => this.safeRunPersistenceMaintenance(), MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref();
  }

  catalog() {
    return this.catalogRepository.available();
  }

  appInventory(observedAt?: string) {
    return this.catalogRepository.inventory(observedAt);
  }

  customCatalog() {
    const custom = this.catalogRepository.safeCustom();
    return custom.data
      ? { data: { path: this.catalogRepository.customPath(), ...custom.data }, error: custom.error }
      : { data: undefined, error: custom.error };
  }

  saveCustomCatalog(items: AppCatalogItem[]) {
    return {
      path: this.catalogRepository.customPath(),
      ...this.catalogRepository.saveCustom({ schemaVersion: 1, items }),
    };
  }

  replaceManagedEnvironment(env: NodeJS.ProcessEnv) {
    const changed = JSON.stringify(this.managedEnvironment) !== JSON.stringify(env);
    this.managedEnvironment = { ...env };
    if (changed) for (const extension of this.appRuntimeExtensions.values()) extension.managedEnvironmentChanged?.();
  }

  beginDrain() {
    this.draining = true;
  }

  endDrain() {
    this.draining = false;
  }

  isDraining() {
    return this.draining;
  }

  listSessions() {
    return Array.from(this.persistedSessions.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  sharedResourceInfo(appId: string) {
    return this.sharedAppResource(appId)?.info();
  }

  sharedResourceSessionAi(appId: string) {
    return this.sharedAppResource(appId)?.projectSessionAi?.();
  }

  ensureSharedResource(appId: string) {
    this.requireLaunchAdmission();
    const resource = this.sharedAppResource(appId);
    if (!resource) throw Object.assign(new Error(`${appId} does not provide a shared resource.`), { code: "APP_SHARED_RESOURCE_UNAVAILABLE" });
    const app = this.catalogRepository.find(appId);
    if (!app) throw Object.assign(new Error("Shared backend app is unavailable."), { code: "APP_NOT_FOUND" });
    const cwd = app.cwd || process.env.TASK_HANDOFF_WORKSPACE || process.cwd();
    const env = { ...process.env, ...app.env, ...this.managedEnvironment, TERM: "xterm-256color" };
    return resource.ensure({ app, cwd, env });
  }

  acquireSharedResource(appId: string, command: string, cwd: string, env: NodeJS.ProcessEnv, consumerId: string) {
    const resource = this.sharedAppResource(appId);
    if (!resource) throw Object.assign(new Error(`${appId} does not provide a shared resource.`), { code: "APP_SHARED_RESOURCE_UNAVAILABLE" });
    return resource.acquire(command, cwd, env, consumerId);
  }

  releaseSharedResource(appId: string, consumerId: string) {
    this.sharedAppResource(appId)?.release(consumerId);
  }

  private sharedAppResource(appId: string) {
    return this.appRuntimeExtensions.get(appId)?.sharedResource;
  }

  private appRuntimeExtension(app: AppCatalogItem) {
    const provider = this.registry.runtimeProvider(app);
    return provider ? this.appRuntimeExtensions.get(provider.id) : undefined;
  }

  private patchSessionMetadata(sessionId: string, patch: { ai: AppSession["ai"] }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.metadata.ai = patch.ai;
    session.metadata.updatedAt = now();
    this.persist(session.metadata);
    this.emit("updated", session.metadata);
  }

  getSession(id: string) {
    return this.sessions.get(id)?.metadata || this.persistedSessions.get(id);
  }

  runningSessionCount() {
    return Array.from(this.sessions.values()).filter((session) => session.metadata.status === "running").length;
  }

  problemSessionCount() {
    return Array.from(this.sessions.values()).filter((session) => session.metadata.status === "failed").length;
  }

  readLogs(id: string, maxBytes = 64 * 1024) {
    const metadata = this.getSession(id);
    if (!metadata) {
      throw Object.assign(new Error("App session not found."), { code: "APP_SESSION_NOT_FOUND" });
    }
    const logDir = path.resolve(metadata.paths.logDir);
    const entries = fs.existsSync(logDir) ? fs.readdirSync(logDir, { withFileTypes: true }) : [];
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const filePath = path.resolve(logDir, entry.name);
        if (!filePath.startsWith(`${logDir}${path.sep}`)) {
          throw Object.assign(new Error("Invalid log path."), { code: "APP_LOG_PATH_INVALID" });
        }
        const stat = fs.statSync(filePath);
        const start = Math.max(0, stat.size - maxBytes);
        const fd = fs.openSync(filePath, "r");
        try {
          const buffer = Buffer.alloc(stat.size - start);
          fs.readSync(fd, buffer, 0, buffer.length, start);
          return {
            name: entry.name,
            size: stat.size,
            updatedAt: stat.mtime.toISOString(),
            truncated: start > 0,
            content: buffer.toString("utf8"),
          };
        } finally {
          fs.closeSync(fd);
        }
      });
    return { sessionId: id, logDir, maxBytes, files };
  }

  start(appId = "terminal-tty", options: AppLaunchOptions = {}) {
    this.requireLaunchAdmission();
    const app = this.catalogRepository.find(appId);
    if (!app) {
      throw Object.assign(new Error("App not found."), { code: "APP_NOT_FOUND" });
    }
    if (!this.hasCommand(app.command || app.id, { ...process.env, ...app.env }, options.cwd || app.cwd)) {
      throw Object.assign(new Error(`Missing required command: ${app.command || app.id}`), { code: "APP_DEPENDENCY_MISSING" });
    }
    if (app.kind === "gui") {
      return this.startGuiApp(app, options);
    }
    if (app.kind === "web") {
      return this.startWebApp(app, options);
    }
    if (app.kind !== "tty") {
      throw Object.assign(new Error("App kind is not implemented yet."), { code: "APP_NOT_IMPLEMENTED" });
    }

    const id = sessionId();
    const shell = app.command || process.env.SHELL || "/bin/bash";
    const launch = this.normalizeLaunchOptions(options);
    const cwd = this.resolveLaunchCwd(launch.cwd, app.cwd);
    launch.cwd = cwd;
    const resumeArgs = this.aiSessionResumeArgs(app.id, launch);
    let args = [...(app.args || []), ...(launch.args || []), ...resumeArgs];
    let env: NodeJS.ProcessEnv = definedEnvironment({ ...process.env, ...app.env, ...launch.env, ...this.managedEnvironment, TERM: "xterm-256color" });
    const sessionDir = path.join(this.paths.appSessionsDir, id);
    const logDir = path.join(this.paths.logDir, "app-sessions", id);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    const appLifecycle = this.appRuntimeExtension(app)?.prepareTtyLaunch?.({
      app,
      sessionId: id,
      sessionDir,
      logDir,
      command: shell,
      cwd,
      env,
      args,
      catalogArgs: app.args || [],
      launchArgs: launch.args || [],
      resumeArgs,
    });
    args = appLifecycle?.args || args;
    env = appLifecycle?.env || env;

    const metadata: AppSession = {
      id,
      appId,
      title: launch.title || app.name,
      kind: "tty",
      status: "running",
      createdAt: now(),
      updatedAt: now(),
      workspace: { cwd },
      launch,
      tty: {
        webPath: `/api/apps/sessions/${id}/tty`,
        shell,
        cwd,
        mode: appLifecycle?.ttyMode || "pty",
      },
      process: {
        command: shell,
      },
      ai: appLifecycle?.ai,
      paths: {
        sessionDir,
        logDir,
      },
    };

    const ttyLogStream = new RotatingLogWriter(path.join(logDir, "tty.log"));
    const runtimeSession: RuntimeSession = {
      metadata,
      processes: [],
      appLifecycle,
      ttyDimensions: { cols: 120, rows: 32 },
      ttyLogStream,
      terminalScreen: new TerminalScreenState(120, 32),
      clients: new Set(),
    };
    ttyLogStream.on("error", () => {
      runtimeSession.ttyLogClosed = true;
    });
    ttyLogStream.on("close", () => {
      runtimeSession.ttyLogClosed = true;
    });
    const onOutput = (data: string) => {
      this.writeTtyLog(runtimeSession, data);
      runtimeSession.terminalScreen?.write(data);
      this.broadcast(runtimeSession, { type: "output", data });
    };
    const onExit = (exitCode: number | null | undefined, signal: string | number | null | undefined) => {
      if (!runtimeSession.stopping) {
        metadata.status = "exited";
        metadata.updatedAt = now();
        metadata.process = { ...metadata.process, exitCode, signal: signal === undefined ? undefined : String(signal) };
        this.persist(metadata);
        this.emit("updated", metadata);
      }
      runtimeSession.appLifecycle?.lifecycle?.processExited?.();
      this.broadcast(runtimeSession, { type: "exit", code: exitCode, signal });
      this.closeTtyLog(runtimeSession);
      runtimeSession.terminalScreen?.dispose();
      runtimeSession.terminalScreen = undefined;
    };
    let pty: IPty;
    try {
      pty = this.spawnTerminalPty(shell, args, cwd, env);
    } catch (error) {
      this.closeTtyLog(runtimeSession);
      appLifecycle?.lifecycle?.spawnFailed?.();
      throw error;
    }
    metadata.process = { ...metadata.process, pid: pty.pid };
    runtimeSession.pty = pty;
    pty.onData(onOutput);
    pty.onExit(({ exitCode, signal }) => onExit(exitCode, signal));
    this.sessions.set(id, runtimeSession);
    this.persist(metadata);

    this.emit("created", metadata);
    return metadata;
  }

  private startWebApp(app: AppCatalogItem, options: AppLaunchOptions) {
    const appCommand = app.command || app.id;
    if (!this.hasCommand(appCommand)) {
      throw Object.assign(new Error(`Missing required command: ${appCommand}`), { code: "APP_DEPENDENCY_MISSING" });
    }

    const id = sessionId();
    const sessionDir = path.join(this.paths.appSessionsDir, id);
    const logDir = path.join(this.paths.logDir, "app-sessions", id);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    const launch = this.normalizeLaunchOptions(options);
    const cwd = this.resolveLaunchCwd(launch.cwd, app.cwd);
    launch.cwd = cwd;
    const port = this.allocatePort("web");
    const env = { ...process.env, ...app.env, ...launch.env, ...this.managedEnvironment };
    const args = this.webArgs(app, sessionDir, cwd, port, launch.args || []);
    this.prepareWebAppSession(app, sessionDir, cwd, port, launch);
    const child = this.spawnLogged(appCommand, args, env, logDir, `${app.id}.log`, cwd);

    const metadata: AppSession = {
      id,
      appId: app.id,
      title: launch.title || app.name,
      kind: "web",
      status: "running",
      createdAt: now(),
      updatedAt: now(),
      workspace: { cwd },
      launch,
      web: {
        host: "127.0.0.1",
        port,
        webPath: `/api/apps/sessions/${id}/web/`,
        readyPath: app.web?.readyPath,
      },
      process: {
        pid: child.pid,
        command: appCommand,
      },
      paths: {
        sessionDir,
        logDir,
      },
    };

    const runtimeSession: RuntimeSession = {
      metadata,
      processes: [child],
      clients: new Set(),
    };
    this.sessions.set(id, runtimeSession);
    this.persist(metadata);
    this.watchLoggedProcess(runtimeSession, child, app.id, false);
    this.emit("created", metadata);
    return metadata;
  }

  private startGuiApp(app: AppCatalogItem, options: AppLaunchOptions) {
    const appCommand = app.command || app.id;
    const backend = guiVncBackend();
    const requiredCommands = backend === "kasmvnc"
      ? ["vncserver", "vncpasswd", "openssl", "xrdb", "xrandr", "openbox", appCommand]
      : ["Xvfb", "openbox", "x11vnc", "websockify", appCommand];
    for (const command of requiredCommands) {
      if (!this.hasCommand(command)) {
        throw Object.assign(new Error(`Missing required command: ${command}`), { code: "APP_DEPENDENCY_MISSING" });
      }
    }

    const id = sessionId();
    const sessionDir = path.join(this.paths.appSessionsDir, id);
    const logDir = path.join(this.paths.logDir, "app-sessions", id);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    const launch = this.normalizeLaunchOptions(options);
    const displayTarget = launch.displayTarget || this.normalizeDisplayTarget(app.defaultDisplayTarget) || { mode: "isolated" as const };
    launch.displayTarget = displayTarget;
    const cwd = this.resolveLaunchCwd(launch.cwd, app.cwd);
    launch.cwd = cwd;
    const cdpPort = this.allocatePort("cdp");
    const args = this.guiArgs(app, sessionDir, cdpPort, launch.args || []);

    if (displayTarget.mode === "shared") {
      const sharedDisplay = this.ensureSharedDisplay(app, launch, backend, cwd);
      const appEnv = this.appEnvForDisplay(app, launch, sharedDisplay);
      const child = this.spawnLogged(appCommand, args, appEnv, logDir, `${app.id}.log`, cwd);
      const automation = app.automation
        ? {
            type: app.automation.type,
            port: cdpPort,
            endpoint: `http://127.0.0.1:${cdpPort}${app.automation.endpointPath || ""}`,
          }
        : undefined;

      const metadata: AppSession = {
        id,
        appId: app.id,
        title: launch.title || app.name,
        kind: "gui",
        status: "running",
        createdAt: now(),
        updatedAt: now(),
        workspace: { cwd },
        launch,
        display: {
          display: sharedDisplay.display,
          mode: "shared",
          displaySessionId: sharedDisplay.id,
          width: sharedDisplay.width,
          height: sharedDisplay.height,
          depth: sharedDisplay.depth,
          xPid: sharedDisplay.xPid,
          wmPid: sharedDisplay.wmPid,
          compositorPid: sharedDisplay.compositorPid,
          xauthority: sharedDisplay.xauthority,
        },
        vnc: {
          backend: sharedDisplay.backend,
          host: "127.0.0.1",
          port: sharedDisplay.vncPort,
          websockifyPort: sharedDisplay.websockifyPort,
          webPath: sharedDisplay.backend === "kasmvnc" ? `/api/apps/sessions/${id}/web/` : `/api/apps/sessions/${id}/vnc`,
          noVncPath: sharedDisplay.backend === "kasmvnc" ? `/api/apps/sessions/${id}/web/` : `/api/apps/sessions/${id}/novnc/vnc.html`,
        },
        web: sharedDisplay.backend === "kasmvnc"
          ? {
              host: "127.0.0.1",
              port: sharedDisplay.vncPort,
              webPath: `/api/apps/sessions/${id}/web/`,
            }
          : undefined,
        automation,
        process: {
          pid: child.pid,
          command: appCommand,
        },
        paths: {
          sessionDir,
          logDir,
        },
      };

      const runtimeSession: RuntimeSession = {
        metadata,
        processes: [child],
        clients: new Set(),
      };
      sharedDisplay.appSessionIds.add(id);
      this.sessions.set(id, runtimeSession);
      this.persist(metadata);
      this.watchLoggedProcess(runtimeSession, child, app.id, false, () => this.releaseSharedDisplaySession(sharedDisplay.id, id));
      this.emit("created", metadata);
      return metadata;
    }

    const displayNumber = this.allocateDisplay();
    const display = `:${displayNumber}`;
    const vncPort = backend === "kasmvnc" ? this.allocatePort("web") : this.allocatePort("vnc");
    const websockifyPort = backend === "novnc" ? this.allocatePort("websockify") : undefined;
    const width = launch.display?.width || app.display?.width || 1440;
    const height = launch.display?.height || app.display?.height || 900;
    const depth = launch.display?.depth || app.display?.depth || 24;
    const env = { ...process.env, ...app.env, ...launch.env, ...this.managedEnvironment, DISPLAY: display };
    const scale = guiScaleFromEnv(env);
    const kasmHomeDir = path.join(sessionDir, "home");
    const xauthority = backend === "kasmvnc" ? path.join(kasmHomeDir, ".Xauthority") : undefined;
    const displayProcesses = backend === "kasmvnc"
      ? this.startKasmVncDisplay(display, width, height, depth, vncPort, env, sessionDir, logDir, scale)
      : this.startNoVncDisplay(display, width, height, depth, vncPort, websockifyPort!, env, logDir, cwd);
    const appEnv = backend === "kasmvnc"
      ? this.guiScaleEnv({
          ...env,
          HOME: guiAppHomeDir(),
          XAUTHORITY: xauthority,
        }, scale)
      : env;
    try {
      this.waitForXDisplay(display);
    } catch (error) {
      for (const process of displayProcesses) {
        if (!process.killed) {
          this.requestManagedProcessTreeStop(process.pid, "SIGTERM", process);
        }
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "APP_DISPLAY_START_FAILED" });
    }
    if (backend === "kasmvnc") {
      this.applyGuiScale(appEnv, sessionDir, scale);
    }
    const openbox = this.spawnLogged("openbox", [], appEnv, logDir, "openbox.log");
    const compositor = this.startCompositor(appEnv, logDir, cwd);
    const chromium = this.spawnLogged(
      appCommand,
      args,
      appEnv,
      logDir,
      `${app.id}.log`,
      cwd,
    );
    const automation = app.automation
      ? {
          type: app.automation.type,
          port: cdpPort,
          endpoint: `http://127.0.0.1:${cdpPort}${app.automation.endpointPath || ""}`,
        }
      : undefined;

    const metadata: AppSession = {
      id,
      appId: app.id,
      title: launch.title || app.name,
      kind: "gui",
      status: "running",
      createdAt: now(),
      updatedAt: now(),
      workspace: { cwd },
      launch,
      display: {
        display,
        mode: "isolated",
        width,
        height,
        depth,
        xPid: displayProcesses[0]?.pid,
        wmPid: openbox.pid,
        compositorPid: compositor?.pid,
        xauthority,
      },
      vnc: {
        backend,
        host: "127.0.0.1",
        port: vncPort,
        websockifyPort,
        webPath: backend === "kasmvnc" ? `/api/apps/sessions/${id}/web/` : `/api/apps/sessions/${id}/vnc`,
        noVncPath: backend === "kasmvnc" ? `/api/apps/sessions/${id}/web/` : `/api/apps/sessions/${id}/novnc/vnc.html`,
      },
      web: backend === "kasmvnc"
        ? {
            host: "127.0.0.1",
            port: vncPort,
            webPath: `/api/apps/sessions/${id}/web/`,
          }
        : undefined,
      automation,
      process: {
        pid: chromium.pid,
        command: appCommand,
      },
      paths: {
        sessionDir,
        logDir,
      },
    };

    const runtimeSession: RuntimeSession = {
      metadata,
      processes: [chromium, ...displayProcesses, openbox, ...(compositor ? [compositor] : [])],
      clients: new Set(),
    };
    this.sessions.set(id, runtimeSession);
    this.persist(metadata);
    for (const displayProcess of displayProcesses) {
      this.watchLoggedProcess(runtimeSession, displayProcess, backend === "kasmvnc" ? "kasmvnc" : "display", true);
    }
    this.watchLoggedProcess(runtimeSession, openbox, "openbox", true);
    this.watchLoggedProcess(runtimeSession, chromium, app.id, false);
    this.emit("created", metadata);
    return metadata;
  }

  private ensureSharedDisplay(app: AppCatalogItem, launch: AppLaunchOptions, backend: GuiVncBackend, cwd: string) {
    const target = launch.displayTarget?.mode === "shared" ? launch.displayTarget : undefined;
    const id = target?.id || "main";
    const existing = this.sharedDisplays.get(id);
    if (existing) {
      return existing;
    }
    if (target?.autoCreate === false) {
      throw Object.assign(new Error(`Shared display session not found: ${id}`), { code: "APP_DISPLAY_SESSION_NOT_FOUND" });
    }

    const safeId = id.replace(/[^a-z0-9._-]/gi, "_");
    const sessionDir = path.join(this.paths.appSessionsDir, `display_${safeId}`);
    const logDir = path.join(this.paths.logDir, "app-sessions", `display_${safeId}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    const displayNumber = this.allocateDisplay();
    const display = `:${displayNumber}`;
    const vncPort = backend === "kasmvnc" ? this.allocatePort("web") : this.allocatePort("vnc");
    const websockifyPort = backend === "novnc" ? this.allocatePort("websockify") : undefined;
    const width = launch.display?.width || app.display?.width || 1440;
    const height = launch.display?.height || app.display?.height || 900;
    const depth = launch.display?.depth || app.display?.depth || 24;
    const env = { ...process.env, ...app.env, ...launch.env, ...this.managedEnvironment, DISPLAY: display };
    const scale = guiScaleFromEnv(env);
    const kasmHomeDir = path.join(sessionDir, "home");
    const xauthority = backend === "kasmvnc" ? path.join(kasmHomeDir, ".Xauthority") : undefined;
    const displayProcesses = backend === "kasmvnc"
      ? this.startKasmVncDisplay(display, width, height, depth, vncPort, env, sessionDir, logDir, scale)
      : this.startNoVncDisplay(display, width, height, depth, vncPort, websockifyPort!, env, logDir, cwd);
    const appEnv = backend === "kasmvnc"
      ? this.guiScaleEnv({
          ...env,
          HOME: guiAppHomeDir(),
          XAUTHORITY: xauthority,
        }, scale)
      : env;
    try {
      this.waitForXDisplay(display);
    } catch (error) {
      for (const process of displayProcesses) {
        if (!process.killed) {
          this.requestManagedProcessTreeStop(process.pid, "SIGTERM", process);
        }
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "APP_DISPLAY_START_FAILED" });
    }
    if (backend === "kasmvnc") {
      this.applyGuiScale(appEnv, sessionDir, scale);
    }
    const openbox = this.spawnLogged("openbox", [], appEnv, logDir, "openbox.log");
    const compositor = this.startCompositor(appEnv, logDir, cwd);
    const sharedDisplay: SharedDisplayRuntimeSession = {
      id,
      display,
      width,
      height,
      depth,
      backend,
      vncPort,
      websockifyPort,
      xPid: displayProcesses[0]?.pid,
      wmPid: openbox.pid,
      compositorPid: compositor?.pid,
      xauthority,
      sessionDir,
      logDir,
      processes: [...displayProcesses, openbox, ...(compositor ? [compositor] : [])],
      appSessionIds: new Set(),
    };
    this.sharedDisplays.set(id, sharedDisplay);
    for (const process of [...displayProcesses, openbox]) {
      this.watchSharedDisplayProcess(sharedDisplay, process);
    }
    return sharedDisplay;
  }

  private appEnvForDisplay(app: AppCatalogItem, launch: AppLaunchOptions, displaySession: SharedDisplayRuntimeSession) {
    const env = {
      ...process.env,
      ...app.env,
      ...launch.env,
      ...this.managedEnvironment,
      DISPLAY: displaySession.display,
    };
    const scale = guiScaleFromEnv(env);
    return displaySession.backend === "kasmvnc"
      ? this.guiScaleEnv({
          ...env,
          HOME: guiAppHomeDir(),
          XAUTHORITY: displaySession.xauthority,
        }, scale)
      : env;
  }

  private releaseSharedDisplaySession(displayId: string, appSessionId: string) {
    const displaySession = this.sharedDisplays.get(displayId);
    if (!displaySession) {
      return;
    }
    displaySession.appSessionIds.delete(appSessionId);
    if (displaySession.appSessionIds.size > 0) {
      return;
    }
    this.stopSharedDisplay(displayId);
  }

  private stopSharedDisplay(displayId: string) {
    const displaySession = this.sharedDisplays.get(displayId);
    if (!displaySession) {
      return;
    }
    this.sharedDisplays.delete(displayId);
    for (const process of displaySession.processes) {
      if (!process.killed) {
        this.requestManagedProcessTreeStop(process.pid, "SIGTERM", process);
      }
    }
  }

  private watchSharedDisplayProcess(displaySession: SharedDisplayRuntimeSession, child: ChildProcessWithoutNullStreams) {
    child.on("exit", (exitCode, signal) => {
      if (!this.sharedDisplays.has(displaySession.id) || exitCode === 0 || displaySession.appSessionIds.size === 0) {
        return;
      }
      this.sharedDisplays.delete(displaySession.id);
      for (const sessionId of displaySession.appSessionIds) {
        const session = this.sessions.get(sessionId);
        if (session) {
          this.markFailed(session, "APP_DISPLAY_PROCESS_EXITED", `Shared display ${displaySession.id} exited unexpectedly with code ${exitCode ?? "null"} signal ${signal ?? "null"}.`);
        }
      }
    });
  }

  private startCompositor(env: NodeJS.ProcessEnv, logDir: string, cwd: string) {
    if (!this.hasCommand("picom")) {
      return undefined;
    }
    return this.spawnLogged(
      "picom",
      [
        "--config",
        "/dev/null",
        "--backend",
        "xrender",
      ],
      env,
      logDir,
      "picom.log",
      cwd,
    );
  }

  private startNoVncDisplay(display: string, width: number, height: number, depth: number, vncPort: number, websockifyPort: number, env: NodeJS.ProcessEnv, logDir: string, cwd: string) {
    const xvfb = this.spawnLogged("Xvfb", [display, "-screen", "0", `${width}x${height}x${depth}`, "-nolisten", "tcp"], env, logDir, "xvfb.log");
    const x11vnc = this.spawnLogged(
      "x11vnc",
      ["-display", display, "-localhost", "-forever", "-shared", "-nopw", "-xrandr", "resize", "-rfbport", String(vncPort)],
      env,
      logDir,
      "x11vnc.log",
    );
    const websockify = this.spawnLogged("websockify", [String(websockifyPort), `127.0.0.1:${vncPort}`], env, logDir, "websockify.log", cwd);
    return [xvfb, x11vnc, websockify];
  }

  private waitForXDisplay(display: string, timeoutMs = 5_000) {
    const displayNumber = display.replace(/^:/, "").split(".")[0];
    const socketPath = path.join("/tmp/.X11-unix", `X${displayNumber}`);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (fs.existsSync(socketPath)) {
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    throw new Error(`Display ${display} did not become ready within ${timeoutMs}ms.`);
  }

  private startKasmVncDisplay(display: string, width: number, height: number, depth: number, port: number, env: NodeJS.ProcessEnv, sessionDir: string, logDir: string, scale: number) {
    this.prepareKasmVncHome(sessionDir, width, height, depth, port, scale);
    const kasmEnv = { ...env, HOME: path.join(sessionDir, "home") };
    const launcherPath = this.writeKasmVncLauncher(sessionDir, display, width, height, depth);
    return [
      this.spawnLogged(
        "bash",
        [launcherPath],
        kasmEnv,
        logDir,
        "kasmvnc.log",
      ),
    ];
  }

  private guiScaleEnv(env: NodeJS.ProcessEnv, scale: number) {
    return {
      ...env,
      TASK_HANDOFF_GUI_SCALE: formatGuiScale(scale),
      XCURSOR_SIZE: "24",
    };
  }

  private applyGuiScale(env: NodeJS.ProcessEnv, sessionDir: string, scale: number) {
    if (scale <= 1) {
      return;
    }
    const xresourcesPath = path.join(sessionDir, "home", ".Xresources");
    if (!fs.existsSync(xresourcesPath)) {
      return;
    }
    try {
      execFileSync("xrdb", ["-merge", xresourcesPath], {
        env,
        stdio: "ignore",
      });
    } catch {
      // GTK/Chromium environment scaling still applies if X resources cannot be merged.
    }
  }

  private writeKasmVncLauncher(sessionDir: string, display: string, width: number, height: number, depth: number) {
    const launcherPath = path.join(sessionDir, "kasmvnc-launcher.sh");
    fs.writeFileSync(
      launcherPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `display=${JSON.stringify(display)}`,
        `geometry=${JSON.stringify(`${width}x${height}`)}`,
        `depth=${JSON.stringify(String(depth))}`,
        "tail_pid=\"\"",
        "cleanup() {",
        "  if [ -n \"${tail_pid:-}\" ]; then",
        "    kill \"$tail_pid\" >/dev/null 2>&1 || true",
        "    wait \"$tail_pid\" >/dev/null 2>&1 || true",
        "  fi",
        "  HOME=\"$HOME\" vncserver -kill \"$display\" >/dev/null 2>&1 || true",
        "}",
        "trap cleanup EXIT",
        "trap 'cleanup; exit 0' TERM INT",
        "HOME=\"$HOME\" vncserver \"$display\" -noxstartup -geometry \"$geometry\" -depth \"$depth\" -publicIP 127.0.0.1",
        "log_file=$(ls -t \"$HOME/.vnc\"/*.log 2>/dev/null | head -n 1 || true)",
        "if [ -z \"$log_file\" ]; then",
        "  while true; do sleep 3600; done",
        "fi",
        "tail -F \"$log_file\" &",
        "tail_pid=$!",
        "wait \"$tail_pid\"",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return launcherPath;
  }

  private prepareKasmVncHome(sessionDir: string, width: number, height: number, depth: number, port: number, scale: number) {
    const homeDir = path.join(sessionDir, "home");
    const vncDir = path.join(homeDir, ".vnc");
    const gtkDir = path.join(homeDir, ".config", "gtk-3.0");
    const fontconfigDir = path.join(homeDir, ".config", "fontconfig");
    const dpi = Math.round(96 * scale);
    const gtkDpi = dpi * 1024;
    const cursorSize = 24;
    const username = process.env.TASK_HANDOFF_KASMVNC_USERNAME || "agent";
    const password = process.env.TASK_HANDOFF_KASMVNC_PASSWORD || "taskhandoff";
    const pemPath = path.join(vncDir, "self.pem");
    fs.mkdirSync(vncDir, { recursive: true });
    fs.mkdirSync(gtkDir, { recursive: true });
    fs.mkdirSync(fontconfigDir, { recursive: true });
    execFileSync(
      "openssl",
      ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-keyout", pemPath, "-out", pemPath, "-days", "3650", "-subj", "/CN=localhost"],
      { stdio: "ignore" },
    );
    fs.writeFileSync(
      path.join(homeDir, ".Xresources"),
      [
        `Xft.dpi: ${dpi}`,
        "Xft.antialias: 1",
        "Xft.hinting: 1",
        "Xft.hintstyle: hintslight",
        "Xft.rgba: rgb",
        "Xft.lcdfilter: lcddefault",
        `Xcursor.size: ${cursorSize}`,
        "XTerm*faceName: Monospace",
        "XTerm*faceSize: 11",
        "XTerm*renderFont: true",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(gtkDir, "settings.ini"),
      [
        "[Settings]",
        `gtk-xft-dpi=${gtkDpi}`,
        "gtk-xft-antialias=1",
        "gtk-xft-hinting=1",
        "gtk-xft-hintstyle=hintslight",
        "gtk-xft-rgba=rgb",
        `gtk-cursor-theme-size=${cursorSize}`,
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(homeDir, ".gtkrc-2.0"),
      [
        `gtk-xft-dpi = ${gtkDpi}`,
        "gtk-xft-antialias = 1",
        "gtk-xft-hinting = 1",
        "gtk-xft-hintstyle = \"hintslight\"",
        "gtk-xft-rgba = \"rgb\"",
        `gtk-cursor-theme-size = ${cursorSize}`,
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(fontconfigDir, "fonts.conf"),
      [
        "<?xml version=\"1.0\"?>",
        "<!DOCTYPE fontconfig SYSTEM \"urn:fontconfig:fonts.dtd\">",
        "<fontconfig>",
        "  <match target=\"font\">",
        "    <edit name=\"antialias\" mode=\"assign\"><bool>true</bool></edit>",
        "    <edit name=\"hinting\" mode=\"assign\"><bool>true</bool></edit>",
        "    <edit name=\"hintstyle\" mode=\"assign\"><const>hintslight</const></edit>",
        "    <edit name=\"rgba\" mode=\"assign\"><const>rgb</const></edit>",
        "    <edit name=\"lcdfilter\" mode=\"assign\"><const>lcddefault</const></edit>",
        "  </match>",
        "</fontconfig>",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(vncDir, "kasmvnc.yaml"),
      [
        "desktop:",
        "  resolution:",
        `    width: ${width}`,
        `    height: ${height}`,
        "  allow_resize: true",
        `  pixel_depth: ${depth}`,
        "network:",
        "  protocol: http",
        "  interface: 127.0.0.1",
        `  websocket_port: ${port}`,
        "  use_ipv4: true",
        "  use_ipv6: false",
        "  ssl:",
        `    pem_certificate: ${pemPath}`,
        `    pem_key: ${pemPath}`,
        "    require_ssl: false",
        "user_session:",
        "  session_type: shared",
        "  concurrent_connections_prompt: false",
        "  idle_timeout: never",
        "command_line:",
        "  prompt: false",
        "",
      ].join("\n"),
    );
    execFileSync("vncpasswd", ["-u", username, "-w", "-r"], {
      env: { ...process.env, HOME: homeDir },
      input: `${password}\n${password}\n`,
      stdio: ["pipe", "ignore", "pipe"],
    });
  }

  stop(id: string) {
    const session = this.sessions.get(id);
    if (!session) {
      const metadata = this.persistedSessions.get(id);
      if (metadata) {
        return metadata;
      }
      throw Object.assign(new Error("App session not found."), { code: "APP_SESSION_NOT_FOUND" });
    }
    session.metadata.status = "stopping";
    session.metadata.updatedAt = now();
    session.stopping = true;
    this.persist(session.metadata);
    if (session.pty) this.requestManagedProcessTreeStop(session.pty.pid, "SIGTERM", undefined, session.pty);
    this.closeTtyLog(session);
    for (const client of session.clients) {
      client.send(JSON.stringify({ type: "exit", code: null, signal: "SIGHUP" }));
      client.close?.();
    }
    session.clients.clear();
    for (const process of session.processes) {
      if (!process.killed) {
        this.requestManagedProcessTreeStop(process.pid, "SIGTERM", process);
      }
    }
    session.appLifecycle?.lifecycle?.stop?.();
    session.terminalScreen?.dispose();
    session.terminalScreen = undefined;
    if (session.metadata.display?.mode === "shared" && session.metadata.display.displaySessionId) {
      this.releaseSharedDisplaySession(session.metadata.display.displaySessionId, id);
    }
    session.metadata.status = "stopped";
    session.metadata.updatedAt = now();
    this.persist(session.metadata);
    this.sessions.delete(id);
    this.emit("updated", session.metadata);
    return session.metadata;
  }

  restart(id: string) {
    this.requireLaunchAdmission();
    const metadata = this.getSession(id);
    if (!metadata) {
      throw Object.assign(new Error("App session not found."), { code: "APP_SESSION_NOT_FOUND" });
    }
    const { appId, title } = metadata;
    const launch = { ...metadata.launch, title };
    if (this.sessions.has(id)) {
      this.stop(id);
    }
    return this.start(appId, launch);
  }

  rename(id: string, title: string) {
    const metadata = this.getSession(id);
    if (!metadata) {
      throw Object.assign(new Error("App session not found."), { code: "APP_SESSION_NOT_FOUND" });
    }
    const normalizedTitle = typeof title === "string" ? title.trim() : "";
    if (!normalizedTitle || normalizedTitle.length > 120) {
      throw Object.assign(new Error("App session title must contain between 1 and 120 characters."), { code: "APP_SESSION_TITLE_INVALID" });
    }
    metadata.title = normalizedTitle;
    metadata.launch = { ...metadata.launch, title: normalizedTitle };
    metadata.updatedAt = now();
    this.persist(metadata);
    this.emit("updated", metadata);
    return metadata;
  }

  async delete(id: string) {
    const metadata = this.getSession(id);
    if (!metadata) {
      throw Object.assign(new Error("App session not found."), { code: "APP_SESSION_NOT_FOUND" });
    }
    const runtimeSession = this.sessions.get(id);
    if (runtimeSession) {
      const processes = [...runtimeSession.processes];
      const processTrees = [runtimeSession.pty?.pid, ...processes.map((process) => process.pid)]
        .flatMap((pid) => pid ? [this.managedProcessTrees.get(pid)] : [])
        .filter((processTree): processTree is ManagedProcessTree => Boolean(processTree));
      const untrackedProcesses = processes.filter((process) => !process.pid || !this.managedProcessTrees.has(process.pid));
      const gracefulExit = untrackedProcesses.map((process) => this.waitForProcessClose(process, APP_PROCESS_STOP_TIMEOUT_MS));
      this.stop(id);
      const [gracefulResults, gracefulTreeResults] = await Promise.all([
        Promise.all(gracefulExit),
        this.waitForManagedProcessTrees(processTrees, APP_PROCESS_STOP_TIMEOUT_MS),
      ]);
      let remainingProcesses = untrackedProcesses.filter((_, index) => !gracefulResults[index]);
      let remainingTrees = gracefulTreeResults;
      if (remainingProcesses.length > 0 || remainingTrees.length > 0) {
        const forcedExit = remainingProcesses.map((process) => this.waitForProcessClose(process, APP_PROCESS_KILL_TIMEOUT_MS));
        for (const process of remainingProcesses) {
          if (process.exitCode === null && process.signalCode === null) {
            this.signalManagedProcessTree(process.pid, "SIGKILL", process);
          }
        }
        for (const processTree of remainingTrees) {
          this.signalManagedProcessTree(processTree.pid, "SIGKILL", processTree.child, processTree.pty);
        }
        const [forcedResults, forcedTreeResults] = await Promise.all([
          Promise.all(forcedExit),
          this.waitForManagedProcessTrees(remainingTrees, APP_PROCESS_KILL_TIMEOUT_MS),
        ]);
        remainingProcesses = remainingProcesses.filter((_, index) => !forcedResults[index]);
        remainingTrees = forcedTreeResults;
      }
      if (remainingProcesses.length > 0 || remainingTrees.length > 0) {
        const remainingPids = [
          ...remainingProcesses.map((process) => process.pid ?? "unknown"),
          ...remainingTrees.map((processTree) => processTree.pid),
        ];
        throw Object.assign(new Error(`App session process trees did not exit: ${remainingPids.join(", ")}.`), {
          code: "APP_PROCESS_STOP_TIMEOUT",
        });
      }
    }
    this.sessions.delete(id);
    this.persistedSessions.delete(id);
    this.removeSessionFiles(metadata);
    this.emit("deleted", metadata);
    return metadata;
  }

  cleanupExpiredSessions(nowDate = new Date()) {
    const retentionMs = this.sessionRetentionMs();
    if (!retentionMs) {
      return [];
    }
    const cutoff = nowDate.getTime() - retentionMs;
    const deleted: AppSession[] = [];
    for (const metadata of this.persistedSessions.values()) {
      if (this.sessions.has(metadata.id) || !CLEANABLE_SESSION_STATUSES.has(metadata.status)) {
        continue;
      }
      const timestamp = Date.parse(metadata.updatedAt || metadata.createdAt);
      if (!Number.isFinite(timestamp) || timestamp > cutoff) {
        continue;
      }
      this.persistedSessions.delete(metadata.id);
      this.removeSessionFiles(metadata);
      deleted.push(metadata);
    }
    return deleted;
  }

  runPersistenceMaintenance(nowDate = new Date()) {
    const deletedSessions = this.cleanupExpiredSessions(nowDate);
    const activeLogDirectories = [...this.sessions.values()].map((session) => session.metadata.paths.logDir);
    const deletedLogs = enforceInstanceLogBudget(path.join(this.paths.logDir, "app-sessions"), activeLogDirectories);
    return { deletedSessions, deletedLogs };
  }

  dispose() {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
  }

  private safeRunPersistenceMaintenance() {
    try {
      this.runPersistenceMaintenance();
    } catch (error) {
      this.emit("maintenance-error", error);
      console.warn(JSON.stringify({
        message: "app runtime persistence maintenance failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  screenshot(id: string) {
    const session = this.sessions.get(id);
    if (!session) {
      throw Object.assign(new Error("App session not found."), { code: "APP_SESSION_NOT_FOUND" });
    }
    if (!session.metadata.display) {
      throw Object.assign(new Error("Screenshots are only available for GUI sessions."), { code: "APP_SCREENSHOT_UNAVAILABLE" });
    }
    if (!this.hasCommand("import")) {
      throw Object.assign(new Error("Missing required command: import. Install ImageMagick in the runtime image."), { code: "APP_DEPENDENCY_MISSING" });
    }
    try {
      const xauthority = session.metadata.display.xauthority;
      return execFileSync("import", ["-window", "root", "png:-"], {
        env: {
          ...process.env,
          DISPLAY: session.metadata.display.display,
          ...(xauthority ? { XAUTHORITY: xauthority, HOME: path.dirname(xauthority) } : {}),
        },
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (error: unknown) {
      throw Object.assign(new Error(`Screenshot failed: ${error instanceof Error ? error.message : String(error)}`), { code: "APP_SCREENSHOT_FAILED" });
    }
  }

  resizeDisplay(id: string, display: NonNullable<AppLaunchOptions["display"]>) {
    const session = this.sessions.get(id);
    const metadata = session?.metadata;
    if (!session || !metadata?.display) {
      throw Object.assign(new Error("Display session not found."), { code: "APP_DISPLAY_NOT_FOUND" });
    }
    const normalized = this.normalizeDisplayOptions(display);
    const width = normalized.width || metadata.display.width;
    const height = normalized.height || metadata.display.height;
    const depth = normalized.depth || metadata.display.depth;
    const env = this.displayCommandEnv(metadata);
    try {
      this.resizeDisplayWithXrandr(env, width, height);
    } catch (error: unknown) {
      throw Object.assign(new Error(`Display resize failed: ${error instanceof Error ? error.message : String(error)}`), { code: "APP_DISPLAY_RESIZE_FAILED" });
    }
    metadata.display = { ...metadata.display, width, height, depth };
    this.persist(metadata);
    this.emit("updated", metadata);
    return metadata;
  }

  async automationStatus(id: string): Promise<AppAutomationStatus> {
    const session = this.sessions.get(id);
    const metadata = session?.metadata || this.persistedSessions.get(id);
    if (!metadata) {
      throw Object.assign(new Error("App session not found."), { code: "APP_SESSION_NOT_FOUND" });
    }
    if (!metadata.automation) {
      throw Object.assign(new Error("Automation is not configured for this app session."), { code: "APP_AUTOMATION_UNAVAILABLE" });
    }
    const status: AppAutomationStatus = {
      sessionId: id,
      type: metadata.automation.type,
      endpoint: metadata.automation.endpoint,
      port: metadata.automation.port,
      ready: false,
    };
    if (!session || metadata.status !== "running") {
      return {
        ...status,
        error: {
          code: "APP_AUTOMATION_NOT_RUNNING",
          message: "Automation endpoint is only available while the app session is running.",
        },
      };
    }
    try {
      const response = await this.fetchCdpVersion(metadata.automation.endpoint);
      return {
        ...status,
        ready: true,
        browser: typeof response.Browser === "string" ? response.Browser : undefined,
        protocolVersion: typeof response["Protocol-Version"] === "string" ? response["Protocol-Version"] : undefined,
        webSocketDebuggerUrl: typeof response.webSocketDebuggerUrl === "string" ? response.webSocketDebuggerUrl : undefined,
      };
    } catch (error: unknown) {
      return {
        ...status,
        error: {
          code: "APP_AUTOMATION_NOT_READY",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async stopAll() {
    for (const session of this.sessions.values()) {
      session.stopping = true;
      session.metadata.status = "stopped";
      session.metadata.updatedAt = now();
      this.persist(session.metadata);
      session.appLifecycle?.lifecycle?.stop?.();
      if (session.pty) this.signalManagedProcessTree(session.pty.pid, "SIGTERM", undefined, session.pty);
      this.closeTtyLog(session);
      session.terminalScreen?.dispose();
      session.terminalScreen = undefined;
      for (const process of session.processes) {
        this.signalManagedProcessTree(process.pid, "SIGTERM", process);
      }
    }
    for (const displayId of Array.from(this.sharedDisplays.keys())) {
      this.stopSharedDisplay(displayId);
    }
    for (const extension of this.appRuntimeExtensions.values()) extension.stopAll?.();
    this.sessions.clear();
    const processTrees = Array.from(this.managedProcessTrees.values());
    for (const processTree of processTrees) this.signalManagedProcessTree(processTree.pid, "SIGTERM", processTree.child, processTree.pty);
    let remaining = await this.waitForManagedProcessTrees(processTrees, APP_PROCESS_STOP_TIMEOUT_MS);
    for (const processTree of remaining) this.signalManagedProcessTree(processTree.pid, "SIGKILL", processTree.child, processTree.pty);
    remaining = await this.waitForManagedProcessTrees(remaining, APP_PROCESS_KILL_TIMEOUT_MS);
    for (const processTree of processTrees) {
      if (!remaining.includes(processTree)) this.forgetManagedProcessTree(processTree.pid);
    }
  }

  private requireLaunchAdmission() {
    if (this.draining) {
      throw Object.assign(new Error("App launches are unavailable while the controlled instance is draining for a runtime update."), {
        code: "APP_RUNTIME_DRAINING",
      });
    }
  }

  vncTarget(id: string) {
    const session = this.sessions.get(id);
    if (!session?.metadata.vnc) {
      return undefined;
    }
    return {
      host: session.metadata.vnc.host,
      port: session.metadata.vnc.port,
    };
  }

  webTarget(id: string) {
    const session = this.sessions.get(id);
    if (!session?.metadata.web || session.metadata.status !== "running") {
      return undefined;
    }
    return {
      host: session.metadata.web.host,
      port: session.metadata.web.port,
    };
  }

  attachTty(id: string, client: TtyClient) {
    const session = this.sessions.get(id);
    if (!session || session.metadata.status !== "running") {
      client.send(JSON.stringify({ type: "error", message: "TTY session not found." }));
      client.close?.();
      return;
    }
    session.clients.add(client);
    client.send(JSON.stringify({
      type: "connected",
      protocolVersion: TTY_STREAM_PROTOCOL_VERSION,
      session: session.metadata,
      dimensions: session.ttyDimensions,
    }));
    const snapshot = session.terminalScreen?.snapshot();
    if (snapshot) {
      client.send(JSON.stringify({ type: "snapshot", data: snapshot.data, pendingEscape: snapshot.pendingEscape }));
    }
    client.on("message", (value) => {
      const raw = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
      try {
        const message = JSON.parse(raw);
        if (message.type === "input" && typeof message.data === "string") {
          session.pty?.write(message.data);
        } else if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
          const cols = message.cols;
          const rows = message.rows;
          if (session.ttyDimensions.cols === cols && session.ttyDimensions.rows === rows) {
            return;
          }
          session.ttyDimensions = { cols, rows };
          session.pty?.resize(cols, rows);
          session.terminalScreen?.resize(cols, rows);
          for (const ttyClient of session.clients) {
            if (ttyClient !== client) {
              ttyClient.send(JSON.stringify({ type: "resize", cols, rows }));
            }
          }
        }
      } catch {
        session.pty?.write(raw);
      }
    });
    client.on("close", () => {
      session.clients.delete(client);
    });
  }

  private broadcast(session: RuntimeSession, message: unknown) {
    const encoded = JSON.stringify(message);
    for (const client of session.clients) {
      client.send(encoded);
    }
  }

  private writeTtyLog(session: RuntimeSession, data: string) {
    const stream = session.ttyLogStream;
    if (!stream || session.ttyLogClosed || stream.destroyed || stream.closed || stream.writableEnded) {
      return;
    }
    stream.write(data, (error) => {
      if (error) {
        session.ttyLogClosed = true;
      }
    });
  }

  private closeTtyLog(session: RuntimeSession) {
    const stream = session.ttyLogStream;
    if (!stream || session.ttyLogClosed || stream.destroyed || stream.closed || stream.writableEnded) {
      session.ttyLogClosed = true;
      return;
    }
    session.ttyLogClosed = true;
    stream.end();
  }

  private persist(metadata: AppSession) {
    this.persistedSessions.set(metadata.id, metadata);
    if (!this.persistSessionMetadata) {
      return;
    }
    fs.mkdirSync(metadata.paths.sessionDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(metadata.paths.sessionDir, 0o700);
    writeFileAtomic.sync(path.join(metadata.paths.sessionDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  }

  private removeSessionFiles(metadata: AppSession) {
    fs.rmSync(path.join(this.paths.appSessionsDir, metadata.id), { recursive: true, force: true });
    fs.rmSync(path.join(this.paths.logDir, "app-sessions", metadata.id), { recursive: true, force: true });
  }

  private sessionRetentionMs() {
    const raw = process.env.TASK_HANDOFF_APP_SESSION_RETENTION_DAYS;
    if (!raw) return DEFAULT_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const days = Number(raw);
    if (!Number.isFinite(days) || days <= 0) {
      return DEFAULT_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    }
    return days * 24 * 60 * 60 * 1000;
  }

  private loadPersistedSessions() {
    if (!fs.existsSync(this.paths.appSessionsDir)) {
      return;
    }
    for (const entry of fs.readdirSync(this.paths.appSessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const metadataPath = path.join(this.paths.appSessionsDir, entry.name, "metadata.json");
      if (!fs.existsSync(metadataPath)) {
        continue;
      }
      try {
        const parsed = this.sanitizePersistedSession(JSON.parse(fs.readFileSync(metadataPath, "utf8")), entry.name);
        if (!parsed) {
          continue;
        }
        const metadata = this.recoverPersistedSession(parsed);
        this.persistedSessions.set(metadata.id, metadata);
        if (metadata !== parsed) {
          this.persist(metadata);
        }
      } catch {
        continue;
      }
    }
  }

  private recoverPersistedSession(metadata: AppSession) {
    if (metadata.status !== "running" && metadata.status !== "stopping") {
      return metadata;
    }
    return {
      ...metadata,
      status: "exited" as const,
      updatedAt: now(),
      error: metadata.error || {
        code: "APP_SESSION_RESTORED_WITHOUT_PROCESS",
        message: "Runtime restarted; previous app processes are not attached. Use restart to launch a new session.",
      },
      process: {
        ...metadata.process,
        exitCode: metadata.process?.exitCode ?? null,
        signal: metadata.process?.signal ?? null,
      },
    };
  }

  private sanitizePersistedSession(value: unknown, expectedId: string): AppSession | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const paths = record.paths && typeof record.paths === "object" && !Array.isArray(record.paths)
      ? record.paths as Record<string, unknown>
      : undefined;
    if (
      record.id !== expectedId
      || typeof record.appId !== "string"
      || typeof record.title !== "string"
      || !["tty", "gui", "web"].includes(String(record.kind))
      || !["created", "running", "stopping", "stopped", "exited", "failed"].includes(String(record.status))
      || typeof record.createdAt !== "string"
      || typeof record.updatedAt !== "string"
      || typeof paths?.sessionDir !== "string"
      || typeof paths?.logDir !== "string"
    ) {
      return undefined;
    }
    const objectValue = (input: unknown) => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const workspace = objectValue(record.workspace);
    const tty = objectValue(record.tty);
    const launch = objectValue(record.launch);
    const ai = objectValue(record.ai);
    const claude = objectValue(ai.claude);
    const app = this.catalogRepository.find(record.appId);
    const candidate = [workspace.cwd, tty.cwd, claude.cwd, launch.cwd, app?.cwd, process.env.TASK_HANDOFF_WORKSPACE, process.cwd()]
      .find((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (!candidate) return undefined;
    return {
      ...record,
      workspace: { cwd: path.resolve(candidate) },
      paths: {
        sessionDir: path.join(this.paths.appSessionsDir, expectedId),
        logDir: path.join(this.paths.logDir, "app-sessions", expectedId),
      },
    } as AppSession;
  }

  private allocateDisplay() {
    const used = new Set(
      [
        ...Array.from(this.sessions.values()).map((session) => session.metadata.display?.display),
        ...Array.from(this.sharedDisplays.values()).map((session) => session.display),
      ]
        .filter((display): display is string => Boolean(display))
        .map((display) => Number(display.replace(/^:/, "")))
        .filter((display) => Number.isInteger(display)),
    );
    const display = this.findAvailableNumber(this.nextDisplay, DISPLAY_START, DISPLAY_END, (candidate) => {
      if (used.has(candidate)) {
        return false;
      }
      return !fs.existsSync(`/tmp/.X${candidate}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${candidate}`);
    });
    this.nextDisplay = this.nextNumber(display, DISPLAY_START, DISPLAY_END);
    return display;
  }

  private allocatePort(kind: "vnc" | "websockify" | "web" | "cdp") {
    const range =
      kind === "vnc"
        ? { start: VNC_PORT_START, end: VNC_PORT_END, next: this.nextVncPort }
        : kind === "websockify"
          ? { start: WEBSOCKIFY_PORT_START, end: WEBSOCKIFY_PORT_END, next: this.nextWebsockifyPort }
          : kind === "web"
            ? { start: WEB_PORT_START, end: WEB_PORT_END, next: this.nextWebPort }
            : { start: CDP_PORT_START, end: CDP_PORT_END, next: this.nextCdpPort };
    const used = new Set(
      [
        ...Array.from(this.sessions.values()).flatMap((session) => [
          session.metadata.vnc?.port,
          session.metadata.vnc?.websockifyPort,
          session.metadata.web?.port,
          session.metadata.automation?.port,
          session.metadata.ai?.appServer?.proxyPort,
        ]),
        ...Array.from(this.sharedDisplays.values()).flatMap((session) => [
          session.vncPort,
          session.websockifyPort,
          session.backend === "kasmvnc" ? session.vncPort : undefined,
        ]),
      ].filter((port): port is number => Number.isInteger(port)),
    );
    const port = this.findAvailableNumber(range.next, range.start, range.end, (candidate) => !used.has(candidate) && this.isPortAvailable(candidate));
    const next = this.nextNumber(port, range.start, range.end);
    if (kind === "vnc") {
      this.nextVncPort = next;
    } else if (kind === "websockify") {
      this.nextWebsockifyPort = next;
    } else if (kind === "web") {
      this.nextWebPort = next;
    } else {
      this.nextCdpPort = next;
    }
    return port;
  }

  private findAvailableNumber(next: number, start: number, end: number, isAvailable: (value: number) => boolean) {
    const total = end - start + 1;
    for (let offset = 0; offset < total; offset += 1) {
      const candidate = start + ((Math.max(next, start) - start + offset) % total);
      if (isAvailable(candidate)) {
        return candidate;
      }
    }
    throw Object.assign(new Error(`No available allocation in range ${start}-${end}.`), { code: "APP_RESOURCE_EXHAUSTED" });
  }

  private nextNumber(current: number, start: number, end: number) {
    return current >= end ? start : current + 1;
  }

  private isPortAvailable(port: number) {
    const script = [
      "const net=require('node:net');",
      "const server=net.createServer();",
      "server.once('error',()=>process.exit(1));",
      "server.listen(Number(process.argv[1]),'127.0.0.1',()=>server.close(()=>process.exit(0)));",
    ].join("");
    return spawnSync(process.execPath, ["-e", script, String(port)], {
      stdio: "ignore",
      env: {
        ...process.env,
        // In a packaged desktop build process.execPath is the Electron app binary.
        // Force that executable to behave as Node for this synchronous probe.
        ELECTRON_RUN_AS_NODE: "1",
      },
    }).status === 0;
  }

  private waitForUnixSocket(socketPath: string, timeoutMs: number, getError?: () => Error | undefined) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const error = getError?.();
      if (error) {
        throw error;
      }
      if (fs.existsSync(socketPath) && this.canConnectUnixSocket(socketPath)) {
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    throw new Error(`${socketPath} did not become ready within ${timeoutMs}ms.`);
  }

  private canConnectUnixSocket(socketPath: string) {
    const script = [
      "const net=require('node:net');",
      "const socket=net.createConnection(process.argv[1]);",
      "const done=(code)=>{socket.destroy();process.exit(code);};",
      "socket.once('connect',()=>done(0));",
      "socket.once('error',()=>done(1));",
      "setTimeout(()=>done(1),250);",
    ].join("");
    return spawnSync(process.execPath, ["-e", script, socketPath], { stdio: "ignore" }).status === 0;
  }

  private markFailed(session: RuntimeSession, code: string, message: string) {
    if (session.stopping || session.metadata.status === "stopped" || session.metadata.status === "failed") {
      return;
    }
    session.metadata.status = "failed";
    session.metadata.updatedAt = now();
    session.metadata.error = { code, message };
    this.persist(session.metadata);
    this.emit("updated", session.metadata);
  }

  private waitForProcessClose(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (closed: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.off("close", onClose);
        child.off("error", onError);
        resolve(closed);
      };
      const onClose = () => finish(true);
      const onError = () => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      child.once("close", onClose);
      child.once("error", onError);
    });
  }

  private watchLoggedProcess(runtimeSession: RuntimeSession, child: ChildProcessWithoutNullStreams, label: string, critical: boolean, onExit?: () => void) {
    child.on("error", (error) => {
      this.markFailed(runtimeSession, "APP_PROCESS_ERROR", `${label} failed: ${error.message}`);
    });
    child.on("exit", (exitCode, signal) => {
      if (runtimeSession.stopping) {
        onExit?.();
        return;
      }
      if (critical && exitCode !== 0) {
        this.markFailed(runtimeSession, "APP_PROCESS_EXITED", `${label} exited unexpectedly with code ${exitCode ?? "null"} signal ${signal ?? "null"}.`);
        onExit?.();
        return;
      }
      if (!critical) {
        runtimeSession.metadata.status = exitCode === 0 ? "exited" : "failed";
        runtimeSession.metadata.updatedAt = now();
        runtimeSession.metadata.process = { ...runtimeSession.metadata.process, exitCode, signal };
        if (exitCode !== 0) {
          runtimeSession.metadata.error = {
            code: "APP_PROCESS_EXITED",
            message: `${label} exited with code ${exitCode ?? "null"} signal ${signal ?? "null"}.`,
          };
        }
        this.persist(runtimeSession.metadata);
        this.emit("updated", runtimeSession.metadata);
      }
      onExit?.();
    });
  }

  private guiArgs(app: AppCatalogItem, sessionDir: string, cdpPort: number, launchArgs: string[]) {
    const args = [...(app.args || []), ...launchArgs].map((arg) => arg.replaceAll("{sessionDir}", sessionDir).replaceAll("{cdpPort}", String(cdpPort)));
    const extensionArgs = this.appRuntimeExtension(app)?.prepareGuiArgs?.({ app, sessionDir, automationPort: cdpPort, launchArgs, defaultArgs: args });
    if (extensionArgs) return extensionArgs;
    if (app.automation?.portArg) {
      args.unshift(app.automation.portArg.replaceAll("{port}", String(cdpPort)));
    }
    return args;
  }

  private webArgs(app: AppCatalogItem, sessionDir: string, cwd: string, port: number, launchArgs: string[]) {
    const render = (arg: string) =>
      arg
        .replaceAll("{sessionDir}", sessionDir)
        .replaceAll("{cwd}", cwd)
        .replaceAll("{port}", String(port));
    const args = [...(app.args || []), ...launchArgs].map(render);
    if (app.web?.portArg) {
      args.unshift(render(app.web.portArg));
    }
    return args;
  }

  private prepareWebAppSession(app: AppCatalogItem, sessionDir: string, cwd = process.cwd(), port = 0, launch: AppLaunchOptions = {}) {
    this.appRuntimeExtension(app)?.prepareWebSession?.({ app, sessionDir, cwd, port, launch });
  }


  private async fetchCdpVersion(endpoint: string): Promise<Record<string, unknown>> {
    const url = new URL(endpoint);
    url.pathname = path.posix.join(url.pathname, "json", "version");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`CDP version endpoint returned HTTP ${response.status}.`);
      }
      return (await response.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeLaunchOptions(options: AppLaunchOptions = {}): AppLaunchOptions {
    const launch: AppLaunchOptions = {};
    if (typeof options.title === "string" && options.title.trim()) {
      launch.title = options.title.trim();
    }
    if (Array.isArray(options.args)) {
      launch.args = options.args.filter((arg): arg is string => typeof arg === "string");
    }
    if (typeof options.cwd === "string" && options.cwd.trim()) {
      launch.cwd = options.cwd.trim();
    }
    if (options.env && typeof options.env === "object" && !Array.isArray(options.env)) {
      launch.env = Object.fromEntries(
        Object.entries(options.env)
          .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string" && entry[0].trim().length > 0)
          .map(([key, value]) => [key.trim(), value]),
      );
    }
    const normalizedDisplay = this.normalizeDisplayOptions(options.display || {});
    if (Object.keys(normalizedDisplay).length > 0) {
      launch.display = normalizedDisplay;
    }
    const displayTarget = this.normalizeDisplayTarget(options.displayTarget);
    if (displayTarget) {
      launch.displayTarget = displayTarget;
    }
    if (options.aiSessionResume) {
      const aiSessionId = options.aiSessionResume.aiSessionId?.trim();
      const providerSessionId = options.aiSessionResume.providerSessionId?.trim();
      if (!aiSessionId || !providerSessionId) {
        throw Object.assign(new Error("AI session resume requires both AI and provider session ids."), { code: "APP_RESUME_INVALID" });
      }
      launch.aiSessionResume = { aiSessionId, providerSessionId };
    }
    return launch;
  }

  private resolveLaunchCwd(launchCwd?: string, catalogCwd?: string) {
    return path.resolve(launchCwd || catalogCwd || process.env.TASK_HANDOFF_WORKSPACE || process.cwd());
  }

  private aiSessionResumeArgs(appId: string, launch: AppLaunchOptions) {
    if (!launch.aiSessionResume) return [];
    const provider = this.registry.provider(appId);
    if (!provider?.capabilities?.supportsAiSessionResume || !provider.aiSessionResumeArgs) {
      throw Object.assign(new Error(`${appId} does not support AI session resume.`), { code: "APP_RESUME_UNSUPPORTED" });
    }
    return provider.aiSessionResumeArgs(launch.aiSessionResume.providerSessionId);
  }

  private normalizeDisplayTarget(target: AppLaunchOptions["displayTarget"] | AppCatalogItem["defaultDisplayTarget"]): AppDisplayTarget | undefined {
    if (!target || typeof target !== "object") {
      return undefined;
    }
    if (target.mode === "isolated") {
      return { mode: "isolated" };
    }
    if (target.mode !== "shared") {
      return undefined;
    }
    const id = typeof target.id === "string" && target.id.trim() ? target.id.trim() : "main";
    return {
      mode: "shared",
      id,
      autoCreate: target.autoCreate !== false,
    };
  }

  private normalizeDisplayOptions(display: NonNullable<AppLaunchOptions["display"]>) {
    const width = Number(display.width);
    const height = Number(display.height);
    const depth = Number(display.depth);
    const normalizedDisplay: NonNullable<AppLaunchOptions["display"]> = {};
    if (Number.isInteger(width) && width >= 320 && width <= 7680) {
      normalizedDisplay.width = width;
    }
    if (Number.isInteger(height) && height >= 240 && height <= 4320) {
      normalizedDisplay.height = height;
    }
    if (Number.isInteger(depth) && depth >= 8 && depth <= 32) {
      normalizedDisplay.depth = depth;
    }
    return normalizedDisplay;
  }

  private displayCommandEnv(metadata: AppSession) {
    const sessionDir = metadata.paths?.sessionDir;
    const homeDir = metadata.display?.xauthority ? path.dirname(metadata.display.xauthority) : sessionDir ? path.join(sessionDir, "home") : undefined;
    return {
      ...process.env,
      DISPLAY: metadata.display?.display,
      ...(homeDir ? { HOME: homeDir, XAUTHORITY: metadata.display?.xauthority || path.join(homeDir, ".Xauthority") } : {}),
    };
  }

  private resizeDisplayWithXrandr(env: NodeJS.ProcessEnv, width: number, height: number) {
    const mode = `${width}x${height}`;
    const output = this.connectedDisplayOutput(env);
    const attempts = output
      ? [["--output", output, "--mode", mode], ["--fb", mode]]
      : [["--fb", mode]];
    let lastError: unknown;
    for (const args of attempts) {
      try {
        execFileSync("xrandr", args, { env, stdio: "ignore" });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private connectedDisplayOutput(env: NodeJS.ProcessEnv) {
    try {
      const output = execFileSync("xrandr", ["--query"], { env, encoding: "utf8" });
      return output.match(/^(\S+)\s+connected\b/m)?.[1];
    } catch {
      return undefined;
    }
  }

  private hasCommand(command: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
    return Boolean(executablePath(command, env, cwd));
  }

  private spawnTerminalPty(shell: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    try {
      ensureNodePtySpawnHelperExecutable();
      const pty = spawnPty(shell, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 32,
        cwd,
        env,
      });
      this.trackManagedProcessTree({ pid: pty.pid, pty, rootExited: false });
      pty.onExit(() => this.markManagedProcessRootExited(pty.pid));
      return pty;
    } catch (error: unknown) {
      throw Object.assign(new Error(`PTY unavailable: ${error instanceof Error ? error.message : String(error)}`), { code: "PTY_UNAVAILABLE" });
    }
  }

  private spawnLogged(command: string, args: string[], env: NodeJS.ProcessEnv, logDir: string, logName: string, cwd?: string) {
    const logStream = new RotatingLogWriter(path.join(logDir, logName));
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // A separate process group is the ownership boundary for every app tree.
      // It lets the controlled instance terminate launchers and all descendants
      // without relying on provider-specific process names.
      detached: process.platform !== "win32",
    });
    if (child.pid) {
      this.trackManagedProcessTree({ pid: child.pid, child, rootExited: false });
      child.once("exit", () => this.markManagedProcessRootExited(child.pid!));
    }
    let openOutputs = 2;
    const closeLog = () => {
      openOutputs -= 1;
      if (openOutputs === 0) logStream.end();
    };
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    logStream.on("error", () => {
      child.stdout.unpipe(logStream);
      child.stderr.unpipe(logStream);
    });
    child.stdout.once("end", closeLog);
    child.stderr.once("end", closeLog);
    return child;
  }

  private trackManagedProcessTree(processTree: ManagedProcessTree) {
    this.managedProcessTrees.set(processTree.pid, processTree);
  }

  private markManagedProcessRootExited(pid: number) {
    const processTree = this.managedProcessTrees.get(pid);
    if (!processTree) return;
    processTree.rootExited = true;
    if (!this.managedProcessTreeExists(processTree)) {
      this.forgetManagedProcessTree(pid);
      return;
    }
    // A launcher that exits before its descendants has abandoned those
    // descendants. Reap that tree immediately instead of retaining it until
    // the controlled instance itself shuts down.
    this.requestManagedProcessTreeStop(pid, "SIGTERM", processTree.child, processTree.pty);
  }

  private forgetManagedProcessTree(pid: number) {
    this.managedProcessTrees.delete(pid);
  }

  private managedProcessTreeExists(processTree: ManagedProcessTree) {
    if (process.platform === "win32") return !processTree.rootExited;
    try {
      process.kill(-processTree.pid, 0);
      return true;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private signalManagedProcessTree(
    pid: number | undefined,
    signal: NodeJS.Signals,
    child?: ChildProcessWithoutNullStreams,
    pty?: IPty,
  ) {
    if (!pid) return;
    const ownedProcessTree = this.managedProcessTrees.get(pid);
    if (ownedProcessTree && process.platform === "win32") {
      const result = spawnSync("taskkill", ["/pid", String(pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], {
        windowsHide: true,
        stdio: "ignore",
      });
      if (result.status === 0) return;
    }
    if (ownedProcessTree && process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        // The root exit callback can race with an earlier whole-group signal.
        // Once the owned group is gone (ESRCH) or no longer signalable by this
        // process (EPERM), never fall back to the positive pid because it may
        // already identify a replacement process.
        if (code === "ESRCH" || code === "EPERM") return;
        throw error;
      }
    }
    try {
      if (pty) pty.kill(signal);
      else if (child && child.exitCode == null && child.signalCode == null) child.kill(signal);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private requestManagedProcessTreeStop(
    pid: number | undefined,
    signal: NodeJS.Signals,
    child?: ChildProcessWithoutNullStreams,
    pty?: IPty,
  ) {
    if (!pid) return;
    const processTree = this.managedProcessTrees.get(pid);
    this.signalManagedProcessTree(pid, signal, child, pty);
    if (!processTree || processTree.stopPromise) return;
    processTree.stopPromise = (async () => {
      let remaining = signal === "SIGKILL"
        ? [processTree]
        : await this.waitForManagedProcessTrees([processTree], APP_PROCESS_STOP_TIMEOUT_MS);
      if (remaining.length > 0 && signal !== "SIGKILL") {
        this.signalManagedProcessTree(pid, "SIGKILL", child, pty);
      }
      if (remaining.length > 0) {
        remaining = await this.waitForManagedProcessTrees(remaining, APP_PROCESS_KILL_TIMEOUT_MS);
      }
      if (remaining.length === 0) this.forgetManagedProcessTree(pid);
    })();
    void processTree.stopPromise.catch(() => {});
  }

  private async waitForManagedProcessTrees(processTrees: ManagedProcessTree[], timeoutMs: number) {
    if (processTrees.length === 0) return [];
    const deadline = Date.now() + timeoutMs;
    let remaining = processTrees.filter((processTree) => this.managedProcessTreeExists(processTree));
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      remaining = remaining.filter((processTree) => this.managedProcessTreeExists(processTree));
    }
    return remaining;
  }
}
