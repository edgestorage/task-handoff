import fs from "node:fs";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAppServerConnectionProxy } from "../../codex-app-server-proxy";
import { codexAppServerSocketPath } from "../../runtime-utils";
import type { AppSession } from "../../types";
import type { ManagedAppRuntimeExtension, ManagedAppRuntimeHost, ManagedAppTtyLaunchInput } from "../types";

type SharedCodexAppServer = {
  status: "running";
  command: string;
  args: string[];
  socketPath: string;
  endpoint: string;
  logPath: string;
  child: ChildProcessWithoutNullStreams;
  appSessionIds: Set<string>;
};

function disabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.TASK_HANDOFF_CODEX_APP_SERVER_DISABLED || "").toLowerCase());
}

export class CodexRuntimeExtension implements ManagedAppRuntimeExtension {
  private shared?: SharedCodexAppServer;
  private readonly sessionAi = new Map<string, NonNullable<AppSession["ai"]>>();

  constructor(private readonly host: ManagedAppRuntimeHost) {}

  readonly sharedResource = {
    ensure: ({ app, cwd, env }: { app: ManagedAppTtyLaunchInput["app"]; cwd: string; env: NodeJS.ProcessEnv }) => {
      const command = app.command || process.env.TASK_HANDOFF_CODEX_COMMAND || "codex";
      if (!this.host.hasCommand(command)) {
        throw Object.assign(new Error(`Missing required command: ${command}`), { code: "APP_DEPENDENCY_MISSING" });
      }
      return this.sharedResourceInfo(this.acquire(command, cwd, env, "__shared_codex_app_server__"));
    },
    acquire: (command: string, cwd: string, env: NodeJS.ProcessEnv, consumerId: string) => this.sharedResourceInfo(this.acquire(command, cwd, env, consumerId)),
    release: (consumerId: string) => this.release(consumerId),
    info: () => {
      const info = this.appServerInfo();
      return info ? this.sharedResourceInfo(info) : undefined;
    },
    projectSessionAi: () => {
      const appServer = this.appServerInfo();
      return appServer ? { agent: "codex" as const, appServer } : undefined;
    },
  };

  prepareTtyLaunch(input: ManagedAppTtyLaunchInput) {
    if (disabled()) return {};
    const appServer = this.acquire(input.command, input.cwd, input.env, input.sessionId);
    const proxyPort = this.host.allocatePort("web");
    const proxy = new CodexAppServerConnectionProxy(appServer.socketPath, (threadId) => this.bindThread(input.sessionId, threadId));
    proxy.start(proxyPort);
    const proxyEndpoint = proxy.endpoint || appServer.endpoint;
    const ai: NonNullable<AppSession["ai"]> = {
      agent: "codex",
      appServer: {
        transport: "unix",
        endpoint: appServer.endpoint,
        socketPath: appServer.socketPath,
        proxyEndpoint,
        proxyPort,
        pid: appServer.child.pid,
        command: appServer.command,
        args: appServer.args,
        logPath: appServer.logPath,
        status: "running",
      },
    };
    this.sessionAi.set(input.sessionId, ai);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      proxy.stop();
      this.release(input.sessionId);
      this.sessionAi.delete(input.sessionId);
    };
    return {
      args: [...input.catalogArgs, "--remote", proxyEndpoint, "--cd", input.cwd, ...input.launchArgs, ...input.resumeArgs],
      env: {
        ...input.env,
        TASK_HANDOFF_APP_SESSION_ID: input.sessionId,
        TASK_HANDOFF_CODEX_APP_SERVER_SOCKET: appServer.socketPath,
        TASK_HANDOFF_CODEX_APP_SERVER_URL: appServer.endpoint,
        TASK_HANDOFF_CODEX_APP_SERVER_PROXY_URL: proxyEndpoint,
      },
      ai,
      lifecycle: { processExited: cleanup, spawnFailed: cleanup, stop: cleanup },
    };
  }

  managedEnvironmentChanged() {
    this.stopAll();
  }

  stopAll() {
    const appServer = this.shared;
    if (!appServer) return;
    this.shared = undefined;
    if (!appServer.child.killed && appServer.child.exitCode === null) appServer.child.kill("SIGTERM");
    fs.rmSync(appServer.socketPath, { force: true });
  }

  acquire(command: string, cwd: string, env: NodeJS.ProcessEnv, appSessionId: string) {
    const existing = this.shared;
    if (existing && existing.child.exitCode === null && !existing.child.killed && fs.existsSync(existing.socketPath)) {
      existing.appSessionIds.add(appSessionId);
      return existing;
    }
    if (existing && !existing.child.killed) existing.child.kill("SIGTERM");
    if (process.platform === "win32") {
      throw Object.assign(new Error("Codex shared app-server uses unix sockets, which are unavailable on Windows."), { code: "CODEX_APP_SERVER_UNSUPPORTED" });
    }

    const runtimeDir = path.join(this.host.paths.runtimeDir, "codex-app-server");
    const logDir = path.join(this.host.paths.logDir, "app-sessions", "codex-app-server");
    const socketPath = codexAppServerSocketPath(runtimeDir);
    const endpoint = `unix://${socketPath}`;
    const appServerCommand = process.env.TASK_HANDOFF_CODEX_APP_SERVER_COMMAND || command;
    const args = ["app-server", "--listen", endpoint];
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    fs.rmSync(socketPath, { force: true });

    const child = this.host.spawnLogged(appServerCommand, args, env, logDir, "codex-app-server.log", cwd);
    const appServer: SharedCodexAppServer = {
      status: "running",
      command: appServerCommand,
      args,
      socketPath,
      endpoint,
      logPath: path.join(logDir, "codex-app-server.log"),
      child,
      appSessionIds: new Set([appSessionId]),
    };
    this.shared = appServer;
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.on("exit", (exitCode, signal) => {
      if (this.shared?.child !== child) return;
      const status = exitCode === 0 ? "exited" : "failed";
      for (const sessionId of appServer.appSessionIds) this.updateMetadata(sessionId, status, exitCode, signal);
      this.shared = undefined;
    });
    try {
      this.host.waitForUnixSocket(socketPath, 5_000, () => spawnError);
    } catch (error) {
      if (!child.killed) child.kill("SIGTERM");
      this.shared = undefined;
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "CODEX_APP_SERVER_START_FAILED" });
    }
    return appServer;
  }

  release(appSessionId: string) {
    const appServer = this.shared;
    if (!appServer) return;
    appServer.appSessionIds.delete(appSessionId);
    if (appServer.appSessionIds.size > 0) return;
    this.shared = undefined;
    if (!appServer.child.killed && appServer.child.exitCode === null) appServer.child.kill("SIGTERM");
    fs.rmSync(appServer.socketPath, { force: true });
  }

  appServerInfo() {
    const appServer = this.shared;
    if (!appServer || appServer.child.killed || appServer.child.exitCode !== null || !fs.existsSync(appServer.socketPath)) return undefined;
    return {
      transport: "unix" as const,
      endpoint: appServer.endpoint,
      socketPath: appServer.socketPath,
      pid: appServer.child.pid,
      command: appServer.command,
      args: appServer.args,
      logPath: appServer.logPath,
      status: "running" as const,
    };
  }

  private updateMetadata(sessionId: string, status: "exited" | "failed", exitCode: number | null, signal: NodeJS.Signals | null) {
    const ai = this.sessionAi.get(sessionId);
    if (!ai?.appServer) return;
    const updated = { ...ai, appServer: { ...ai.appServer, status, exitCode, signal } };
    this.sessionAi.set(sessionId, updated);
    this.host.patchSession(sessionId, { ai: updated });
  }

  private bindThread(sessionId: string, threadId: string) {
    const ai = this.sessionAi.get(sessionId);
    if (!ai) return;
    const existing = Array.isArray(ai.threadIds) ? ai.threadIds : [];
    const updated = { ...ai, activeThreadId: threadId, threadIds: existing.includes(threadId) ? existing : [...existing, threadId] };
    this.sessionAi.set(sessionId, updated);
    this.host.patchSession(sessionId, { ai: updated });
  }

  private sharedResourceInfo(appServer: ReturnType<CodexRuntimeExtension["appServerInfo"]> | SharedCodexAppServer) {
    if (!appServer) throw new Error("Codex app-server is not running.");
    return {
      kind: "codex-app-server",
      status: "running" as const,
      details: {
        transport: "unix",
        endpoint: appServer.endpoint,
        socketPath: appServer.socketPath,
        pid: "child" in appServer ? appServer.child.pid : appServer.pid,
        command: appServer.command,
        args: appServer.args,
        logPath: appServer.logPath,
      },
    };
  }
}

export function createCodexRuntime(host: ManagedAppRuntimeHost) {
  return new CodexRuntimeExtension(host);
}
