import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { processStartIdentity } from "@task-handoff/core/core/process-singleton-lock";
import { InstanceDeleteResultSchema, type ControlledInstance, type InstanceDeleteInput, type NodeRuntime } from "@task-handoff/protocol/control-plane";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";
import { copyTruncateOpenLog } from "@task-handoff/core/storage/open-log-retention";
import {
  type CommandRunner,
  type ExecutorContext,
  type ExecutorStartResult,
} from "./docker.ts";
import type { RuntimeAdapter } from "./adapters.ts";
import {
  LOCAL_PROCESS_NONCE_LABEL,
  LocalProcessSupervisor,
  allocateLocalPort,
  canListenOnLocalPort,
  waitForChildExit,
  waitForChildSpawn,
  type LocalProcessExit,
} from "./local-process-supervisor.ts";
import { desiredControlledInstanceVersion } from "../runtime-version-state.ts";
import { localRuntimeCapabilities } from "../state.ts";

function localWorkspacePath(instance: ControlledInstance) {
  if (instance.source.type !== "local-folder") {
    const error = new Error("Localhost runtime currently supports local folder sources only.");
    Object.assign(error, { statusCode: 400, code: "LOCAL_RUNTIME_REQUIRES_LOCAL_FOLDER" });
    throw error;
  }
  return path.resolve(instance.source.path);
}

export function configuredLocalControlledCommand() {
  const value = process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV?.trim();
  if (!value) {
    const command = process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND?.trim();
    return command ? command.split(/\s+/) : undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw Object.assign(new Error("TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV must be valid JSON."), { code: "LOCAL_CONTROLLED_COMMAND_INVALID" });
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => typeof item !== "string" || !item)) {
    throw Object.assign(new Error("TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV must be a non-empty string array."), { code: "LOCAL_CONTROLLED_COMMAND_INVALID" });
  }
  return parsed as string[];
}

function localControlledInstanceCommand(configured?: string[]) {
  if (configured) return configured;
  const repositoryCli = path.resolve(process.cwd(), "bin", "task-handoff.js");
  if (fs.existsSync(repositoryCli)) return [process.execPath, repositoryCli, "web"];
  throw Object.assign(
    new Error("The bundled controlled-instance command is unavailable."),
    { statusCode: 500, code: "LOCAL_CONTROLLED_COMMAND_MISSING" },
  );
}
async function commandVersion(runCommand: CommandRunner, command: string) {
  try {
    const result = await runCommand(command, ["--version"]);
    return {
      available: true,
      command,
      version: (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() || undefined,
    };
  } catch {
    return { available: false };
  }
}

export class LocalhostRuntimeAdapter implements RuntimeAdapter {
  private readonly runCommand: CommandRunner;
  private readonly paths: NodeAgentStorePaths;
  private readonly nodeAgentUrl: () => string;
  private readonly processSupervisor: LocalProcessSupervisor;
  private readonly commandOverride?: string[];
  private readonly lockPath?: string;

  constructor(runCommand: CommandRunner, paths: NodeAgentStorePaths, nodeAgentUrl: () => string, commandOverride?: string[], lockPath?: string, onUnexpectedExit?: (event: LocalProcessExit) => void | Promise<void>, onUnexpectedExitError?: (error: unknown, event: LocalProcessExit) => void) {
    this.runCommand = runCommand;
    this.paths = paths;
    this.nodeAgentUrl = nodeAgentUrl;
    this.commandOverride = commandOverride;
    this.lockPath = lockPath;
    this.processSupervisor = new LocalProcessSupervisor(lockPath, onUnexpectedExit, onUnexpectedExitError);
  }

  async start(context: ExecutorContext): Promise<ExecutorStartResult> {
    // A Local Runtime is a host-user singleton and may outlive the node-agent
    // that launched it (for example when Desktop is terminated before the
    // node-agent finishes its graceful shutdown). Verify and stop that
    // previously owned process before launching the controlled-instance
    // bundled with the current node-agent.
    await this.processSupervisor.stop(context.instance);
    const workspacePath = localWorkspacePath(context.instance);
    const configuredPort = context.instance.runtime.port;
    const configuredPortAvailable = configuredPort ? await canListenOnLocalPort(configuredPort) : false;
    const allocateOnConflict = process.env.TASK_HANDOFF_LOCAL_INSTANCE_PORT_CONFLICT === "allocate";
    if (configuredPort && !configuredPortAvailable && !allocateOnConflict) {
      throw Object.assign(
        new Error(`Local controlled instance port 127.0.0.1:${configuredPort} is already in use.`),
        { statusCode: 409, code: "LOCAL_INSTANCE_PORT_IN_USE" },
      );
    }
    const port = configuredPort && configuredPortAvailable ? configuredPort : await allocateLocalPort();
    const dataDir = path.join(this.paths.dataDir, "local-instances", context.instance.id);
    const logDir = path.join(dataDir, "logs");
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    fs.chmodSync(logDir, 0o700);
    const [command, ...baseArgs] = localControlledInstanceCommand(this.commandOverride);
    const args = [...baseArgs, "--host", "127.0.0.1", "--port", String(port)];
    const processNonce = crypto.randomUUID();
    const outPath = path.join(logDir, "controlled-instance.out.log");
    const errPath = path.join(logDir, "controlled-instance.err.log");
    copyTruncateOpenLog(outPath);
    copyTruncateOpenLog(errPath);
    const out = fs.openSync(outPath, "a", 0o600);
    const err = fs.openSync(errPath, "a", 0o600);
    const child = spawn(command, args, {
      cwd: workspacePath,
      detached: false,
      stdio: ["ignore", out, err],
      env: {
        ...process.env,
        TASK_HANDOFF_CONTROL_MODE: "controlled",
        TASK_HANDOFF_RUNTIME_KIND: "local",
        TASK_HANDOFF_CONTROLLED_INSTANCE_VERSION: desiredControlledInstanceVersion(),
        ...(this.lockPath ? { TASK_HANDOFF_LOCAL_CONTROLLED_INSTANCE_LOCK_PATH: this.lockPath } : {}),
        TASK_HANDOFF_NODE_AGENT_URL: this.nodeAgentUrl(),
        TASK_HANDOFF_INSTANCE_ID: context.instance.id,
        TASK_HANDOFF_INSTANCE_NAME: context.instance.name,
        TASK_HANDOFF_REGISTRATION_TOKEN: context.instance.registrationToken || "",
        TASK_HANDOFF_PROJECT_ID: context.project.id,
        TASK_HANDOFF_NODE_ID: context.node.id,
        TASK_HANDOFF_RUNTIME_ID: context.runtime.id,
        TASK_HANDOFF_LOCAL_PROCESS_NONCE: processNonce,
        TASK_HANDOFF_WORKSPACE: workspacePath,
        TASK_HANDOFF_WORKSPACE_MODE: "local-bind",
        TASK_HANDOFF_DATA_DIR: dataDir,
        TASK_HANDOFF_LOG_DIR: logDir,
        TASK_HANDOFF_APP_SESSION_PERSIST: "1",
        TASK_HANDOFF_CODEX_APP_SERVER: process.env.TASK_HANDOFF_CODEX_APP_SERVER || "1",
        TASK_HANDOFF_WEB_PORT: String(port),
        TASK_HANDOFF_WEB_HOST: "127.0.0.1",
        ...(context.modelEnv || {}),
      },
    });
    fs.closeSync(out);
    fs.closeSync(err);
    try {
      await waitForChildSpawn(child);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        fs.appendFileSync(
          path.join(logDir, "controlled-instance.lifecycle.log"),
          `[${new Date().toISOString()}] spawn failed command=${command} cwd=${workspacePath} error=${message}\n`,
        );
      } catch {
        // Best-effort lifecycle logging.
      }
      throw Object.assign(
        new Error(`Controlled instance process could not start with command ${command} in ${workspacePath}: ${message}`),
        { statusCode: 500, code: "LOCAL_INSTANCE_PROCESS_SPAWN_FAILED" },
      );
    }
    const lifecycleLogPath = path.join(logDir, "controlled-instance.lifecycle.log");
    this.processSupervisor.track(context.instance.id, child, (event) => {
      fs.appendFileSync(
        lifecycleLogPath,
        `[${new Date().toISOString()}] shutdown stage=${event.stage} pid=${event.pid ?? ""} signal=${event.signal ?? ""} timeoutMs=${event.timeoutMs ?? ""}\n`,
      );
    });
    child.on("error", (error) => {
      try {
        fs.appendFileSync(
          lifecycleLogPath,
          `[${new Date().toISOString()}] process error pid=${child.pid ?? ""} error=${error.message}\n`,
        );
      } catch {
        // Best-effort lifecycle logging.
      }
    });
    child.once("exit", (code, signal) => {
      try {
        fs.appendFileSync(
          lifecycleLogPath,
          `[${new Date().toISOString()}] exited pid=${child.pid ?? ""} code=${code ?? ""} signal=${signal ?? ""}\n`,
        );
      } catch {
        // Best-effort lifecycle logging.
      }
    });
    const web = `http://127.0.0.1:${port}`;
    const childStartIdentity = child.pid ? processStartIdentity(child.pid) : undefined;
    const ready = child.pid && context.instance.registrationToken
      ? await this.processSupervisor.waitUntilHealthy(
          web,
          { instanceId: context.instance.id, pid: child.pid, processNonce, startIdentity: childStartIdentity },
          child,
          context.instance.registrationToken,
        )
      : false;
    if (!ready || !this.processSupervisor.markReady(context.instance.id, child)) {
      this.processSupervisor.release(context.instance.id, child);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await waitForChildExit(child);
      throw Object.assign(
        new Error(`Controlled instance process did not become ready for instance ${context.instance.id} on ${web}.`),
        { statusCode: 503, code: "LOCAL_INSTANCE_PROCESS_NOT_READY" },
      );
    }
    return {
      status: "registering",
      health: "unknown",
      connectionStatus: "online",
      agentStatus: "unknown",
      targetStatus: "unknown",
      uiAccessStatus: "unknown",
      target: {
        strategy: "direct-port",
        status: "unknown",
        web,
        api: `${web}/api`,
      },
      workspace: {
        mode: "local-bind",
        status: "pending",
        path: workspacePath,
      },
      runtime: {
        kind: "local",
        workspacePath,
        pid: child.pid,
        port,
        labels: {
          ...context.instance.runtime.labels,
          "task-handoff.runtime-kind": "local",
          [LOCAL_PROCESS_NONCE_LABEL]: processNonce,
        },
      },
    };
  }

  async stop(context: ExecutorContext): Promise<ExecutorStartResult> {
    await this.processSupervisor.stop(context.instance);
    return {
      status: "stopped",
      health: "unknown",
      connectionStatus: "offline",
      agentStatus: "offline",
      targetStatus: "unknown",
      uiAccessStatus: "unknown",
      target: {
        ...context.instance.target,
        status: "unknown",
      },
      runtime: context.instance.runtime,
    };
  }

  async restart(context: ExecutorContext): Promise<ExecutorStartResult> {
    return this.start(context);
  }

  async delete(context: ExecutorContext, _input: InstanceDeleteInput) {
    await this.stop(context);
    return InstanceDeleteResultSchema.parse({
      instanceId: context.instance.id,
      containerDeleted: true,
      completed: true,
      deletedVolumes: [],
      retainedVolumes: [],
      volumeResults: [],
    });
  }

  async check(runtime: NodeRuntime): Promise<Partial<NodeRuntime>> {
    const [codex, claude] = await Promise.all([
      commandVersion(this.runCommand, "codex"),
      commandVersion(this.runCommand, "claude"),
    ]);
    return {
      status: "online",
      capabilities: localRuntimeCapabilities({
        ...runtime.capabilities,
        apps: {
          terminal: true,
          codex,
          claude,
        },
      }),
    };
  }

  async stopAll() {
    await this.processSupervisor.stopAll();
  }
}
