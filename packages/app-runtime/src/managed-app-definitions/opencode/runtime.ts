import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ManagedAppRuntimeExtension, ManagedAppRuntimeHost, ManagedAppTtyLaunchInput } from "../types";

type SharedOpenCodeServer = {
  command: string;
  endpoint: string;
  port: number;
  username: string;
  password: string;
  headers: Record<string, string>;
  logPath: string;
  child: ChildProcessWithoutNullStreams;
  consumers: Set<string>;
};

export class OpenCodeRuntimeExtension implements ManagedAppRuntimeExtension {
  private shared?: SharedOpenCodeServer;

  constructor(private readonly host: ManagedAppRuntimeHost) {}

  readonly sharedResource = {
    ensure: ({ app, cwd, env }: { app: ManagedAppTtyLaunchInput["app"]; cwd: string; env: NodeJS.ProcessEnv }) => {
      const command = app.command || process.env.TASK_HANDOFF_OPENCODE_COMMAND || "opencode";
      return this.publicInfo(this.acquire(command, cwd, env, "__shared_opencode_server__"));
    },
    acquire: (command: string, cwd: string, env: NodeJS.ProcessEnv, consumerId: string) => this.publicInfo(this.acquire(command, cwd, env, consumerId)),
    release: (consumerId: string) => this.release(consumerId),
    info: () => this.shared && this.isRunning(this.shared) ? this.publicInfo(this.shared) : undefined,
    privateConnection: () => this.shared && this.isRunning(this.shared)
      ? { endpoint: this.shared.endpoint, headers: { ...this.shared.headers } }
      : undefined,
  };

  prepareTtyLaunch(input: ManagedAppTtyLaunchInput) {
    const server = this.acquire(input.command, input.cwd, input.env, input.sessionId);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.release(input.sessionId);
    };
    return {
      args: ["attach", server.endpoint, "--dir", input.cwd, ...input.launchArgs, ...input.resumeArgs],
      env: {
        ...input.env,
        OPENCODE_SERVER_USERNAME: server.username,
        OPENCODE_SERVER_PASSWORD: server.password,
        OPENCODE_CLIENT: "task-handoff",
      },
      ai: { agent: "opencode" },
      lifecycle: { processExited: cleanup, spawnFailed: cleanup, stop: cleanup },
    };
  }

  managedEnvironmentChanged() {
    this.stopAll();
  }

  stopAll() {
    const server = this.shared;
    if (!server) return;
    this.shared = undefined;
    this.host.stopProcessTree(server.child);
  }

  private acquire(command: string, cwd: string, env: NodeJS.ProcessEnv, consumerId: string) {
    if (!this.host.hasCommand(command, env, cwd)) {
      throw Object.assign(new Error(`Missing required command: ${command}`), { code: "APP_DEPENDENCY_MISSING" });
    }
    if (this.shared && this.isRunning(this.shared)) {
      this.shared.consumers.add(consumerId);
      return this.shared;
    }
    if (this.shared) this.host.stopProcessTree(this.shared.child);

    const port = this.host.allocatePort("web");
    const endpoint = `http://127.0.0.1:${port}`;
    const username = "task-handoff";
    const password = randomBytes(32).toString("base64url");
    const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
    const logDir = path.join(this.host.paths.logDir, "app-sessions", "opencode-server");
    fs.mkdirSync(logDir, { recursive: true });
    const serverEnv = {
      ...env,
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CLIENT: "task-handoff",
      ...(env.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT
        ? { OPENCODE_CONFIG_CONTENT: env.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT }
        : {}),
    };
    const child = this.host.spawnLogged(command, ["serve", "--hostname=127.0.0.1", `--port=${port}`], serverEnv, logDir, "opencode-server.log", cwd);
    const server: SharedOpenCodeServer = {
      command,
      endpoint,
      port,
      username,
      password,
      headers,
      logPath: path.join(logDir, "opencode-server.log"),
      child,
      consumers: new Set([consumerId]),
    };
    this.shared = server;
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("exit", () => {
      if (this.shared?.child === child) this.shared = undefined;
    });
    try {
      this.host.waitForHttp(`${endpoint}/global/health`, headers, 10_000, () => spawnError);
    } catch (error) {
      this.host.stopProcessTree(child);
      this.shared = undefined;
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "OPENCODE_SERVER_START_FAILED" });
    }
    return server;
  }

  private release(consumerId: string) {
    const server = this.shared;
    if (!server) return;
    server.consumers.delete(consumerId);
    if (server.consumers.size > 0) return;
    this.shared = undefined;
    this.host.stopProcessTree(server.child);
  }

  private isRunning(server: SharedOpenCodeServer) {
    return !server.child.killed && server.child.exitCode === null;
  }

  private publicInfo(server: SharedOpenCodeServer) {
    return {
      kind: "opencode-server",
      status: "running" as const,
      details: {
        transport: "http",
        endpoint: server.endpoint,
        pid: server.child.pid,
        command: server.command,
        logPath: server.logPath,
      },
    };
  }
}

export function createOpenCodeRuntime(host: ManagedAppRuntimeHost) {
  return new OpenCodeRuntimeExtension(host);
}
