import fs from "node:fs";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAppServerConnectionProxy, type CodexAppServerUpstream } from "../../codex-app-server-proxy";
import {
  codexAppServerSocketPath,
  codexAppServerHealthUrl,
  codexAppServerTokenFile,
  codexAppServerTransport,
  codexAppServerWsEndpoint,
  codexAppServerWsListenArgs,
  createCodexAppServerToken,
  type CodexAppServerTransport,
} from "../../runtime-utils";
import type { AppSession } from "../../types";
import type { ManagedAppRuntimeExtension, ManagedAppRuntimeHost, ManagedAppTtyLaunchInput } from "../types";
import { codexStoryMcpArgs } from "./story-mcp-config";

type SharedCodexAppServer = {
  status: "running";
  transport: CodexAppServerTransport;
  command: string;
  args: string[];
  endpoint: string;
  /** AF_UNIX endpoints only. */
  socketPath?: string;
  /** Capability token file for the websocket endpoint. */
  tokenFile?: string;
  logPath: string;
  child: ChildProcessWithoutNullStreams;
  appSessionIds: Set<string>;
};

function codexAppServerUpstream(appServer: SharedCodexAppServer): CodexAppServerUpstream {
  return appServer.socketPath
    ? { transport: "unix", socketPath: appServer.socketPath }
    : { transport: "ws", endpoint: appServer.endpoint, tokenFile: appServer.tokenFile };
}

function removeCodexAppServerArtifacts(appServer: SharedCodexAppServer) {
  if (appServer.socketPath) fs.rmSync(appServer.socketPath, { force: true });
  if (appServer.tokenFile) fs.rmSync(appServer.tokenFile, { force: true });
}

function codexAppServerRunning(appServer: SharedCodexAppServer) {
  if (appServer.child.killed || appServer.child.exitCode !== null) return false;
  // A unix listener also owns a filesystem entity, and the CLI removes it when
  // it stops. The loopback listener has no filesystem entity, so the live child
  // process is the only signal available.
  return appServer.socketPath ? fs.existsSync(appServer.socketPath) : true;
}

/** Everything `acquire` needs to spawn and then wait for one app-server. */
type CodexAppServerListenPlan =
  | { transport: "unix"; endpoint: string; socketPath: string; listenArgs: string[] }
  | { transport: "ws"; endpoint: string; tokenFile: string; healthUrl: string; listenArgs: string[] };

/**
 * A cold app-server start is a Node wrapper that boots the CLI and then binds
 * its listener. Windows antivirus adds real time to that first launch, so the
 * socket and loopback probes share one budget wide enough not to race it.
 */
export const CODEX_APP_SERVER_READY_TIMEOUT_MS = 15_000;

function codexAppServerListenPlan(transport: CodexAppServerTransport, allocatePort: () => number, runtimeDir: string): CodexAppServerListenPlan {
  if (transport === "unix") {
    const socketPath = codexAppServerSocketPath(runtimeDir);
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    fs.rmSync(socketPath, { force: true });
    const endpoint = `unix://${socketPath}`;
    return { transport, endpoint, socketPath, listenArgs: ["--listen", endpoint] };
  }
  const port = allocatePort();
  const endpoint = codexAppServerWsEndpoint(port);
  const tokenFile = codexAppServerTokenFile(runtimeDir);
  fs.writeFileSync(tokenFile, createCodexAppServerToken(), { mode: 0o600 });
  return {
    transport,
    endpoint,
    tokenFile,
    healthUrl: codexAppServerHealthUrl(port),
    listenArgs: codexAppServerWsListenArgs(endpoint, tokenFile),
  };
}

function disabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.TASK_HANDOFF_CODEX_APP_SERVER_DISABLED || "").toLowerCase());
}

export class CodexRuntimeExtension implements ManagedAppRuntimeExtension {
  private shared?: SharedCodexAppServer;
  private privateEnvironment: NodeJS.ProcessEnv = {};
  private readonly sessionAi = new Map<string, NonNullable<AppSession["ai"]>>();

  constructor(private readonly host: ManagedAppRuntimeHost) {}

  readonly sharedResource = {
    replacePrivateEnvironment: (env: NodeJS.ProcessEnv) => {
      if (JSON.stringify(this.privateEnvironment) === JSON.stringify(env)) return;
      this.privateEnvironment = { ...env };
      this.stopAll();
    },
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
    const proxy = new CodexAppServerConnectionProxy(codexAppServerUpstream(appServer), (threadId) => this.bindThread(input.sessionId, threadId));
    proxy.start(proxyPort);
    const proxyEndpoint = proxy.endpoint || appServer.endpoint;
    const ai: NonNullable<AppSession["ai"]> = {
      agent: "codex",
      appServer: {
        transport: appServer.transport,
        endpoint: appServer.endpoint,
        ...(appServer.socketPath ? { socketPath: appServer.socketPath } : {}),
        ...(appServer.tokenFile ? { tokenFile: appServer.tokenFile } : {}),
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
        ...(appServer.socketPath ? { TASK_HANDOFF_CODEX_APP_SERVER_SOCKET: appServer.socketPath } : {}),
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
    this.host.stopProcessTree(appServer.child);
    removeCodexAppServerArtifacts(appServer);
  }

  acquire(command: string, cwd: string, env: NodeJS.ProcessEnv, appSessionId: string) {
    const existing = this.shared;
    if (existing && codexAppServerRunning(existing)) {
      existing.appSessionIds.add(appSessionId);
      return existing;
    }
    if (existing) {
      this.host.stopProcessTree(existing.child);
      removeCodexAppServerArtifacts(existing);
    }

    const transport = codexAppServerTransport();
    const runtimeDir = path.join(this.host.paths.runtimeDir, "codex-app-server");
    const logDir = path.join(this.host.paths.logDir, "app-sessions", "codex-app-server");
    const appServerCommand = process.env.TASK_HANDOFF_CODEX_APP_SERVER_COMMAND || command;
    const childEnvironment = { ...env, ...this.privateEnvironment };
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    const plan = codexAppServerListenPlan(transport, () => this.host.allocatePort("web"), runtimeDir);
    const args = [...codexStoryMcpArgs(childEnvironment), "app-server", ...plan.listenArgs];

    const child = this.host.spawnLogged(appServerCommand, args, childEnvironment, logDir, "codex-app-server.log", cwd, "codex app-server");
    const appServer: SharedCodexAppServer = {
      status: "running",
      transport,
      command: appServerCommand,
      args,
      endpoint: plan.endpoint,
      ...(plan.transport === "unix" ? { socketPath: plan.socketPath } : { tokenFile: plan.tokenFile }),
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
      if (plan.transport === "unix") {
        this.host.waitForUnixSocket(plan.socketPath, CODEX_APP_SERVER_READY_TIMEOUT_MS, () => spawnError);
      } else {
        this.host.waitForHttp(plan.healthUrl, {}, CODEX_APP_SERVER_READY_TIMEOUT_MS, () => spawnError);
      }
    } catch (error) {
      this.host.stopProcessTree(child);
      this.shared = undefined;
      removeCodexAppServerArtifacts(appServer);
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
    this.host.stopProcessTree(appServer.child);
    removeCodexAppServerArtifacts(appServer);
  }

  appServerInfo() {
    const appServer = this.shared;
    if (!appServer || !codexAppServerRunning(appServer)) return undefined;
    return {
      transport: appServer.transport,
      endpoint: appServer.endpoint,
      ...(appServer.socketPath ? { socketPath: appServer.socketPath } : {}),
      ...(appServer.tokenFile ? { tokenFile: appServer.tokenFile } : {}),
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
        transport: appServer.transport,
        endpoint: appServer.endpoint,
        ...(appServer.socketPath ? { socketPath: appServer.socketPath } : {}),
        ...(appServer.tokenFile ? { tokenFile: appServer.tokenFile } : {}),
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
