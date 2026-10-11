import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { InstanceDeleteResultSchema } from "@task-handoff/protocol/control-plane";
import type { InstanceDeleteInput, InstanceDeleteResult } from "./contracts.ts";
import type { ExecutorContext, ExecutorStartResult, RuntimeLiveness } from "./contracts.ts";
import { INSTANCE_PRIVATE_CONFIG_FILE_NAME } from "../instances/private-config-store.ts";
import { allocateLocalPort } from "./local-process-supervisor.ts";
import { workspaceGitEnvironmentEntries } from "./docker.ts";
import { WslDistroProvisioner, type WslProvisionResult } from "./wsl-provisioning.ts";
import { normalizeNodeAgentUrl } from "./wsl-node-agent-url.ts";
import {
  WSL_RUNTIME_ARTIFACT_STAGING,
  WSL_RUNTIME_INSTALLER,
  WSL_RUNTIME_ROOT,
  installWslRuntime,
  inspectWslRuntime,
  wslArtifactTarget,
} from "./wsl-artifacts.ts";
import type { WslSessionHandle } from "./wsl-executor.ts";
import type { ResolvedRuntimeArtifact } from "../runtime-artifacts.ts";
import type { RuntimeArtifactIdentity } from "@task-handoff/protocol/control-plane";

/**
 * WSL 实例生命周期（openspec change add-wsl-runtime，Phase 5）。
 *
 * 每个 Controlled Instance 对应一个由 instanceId 派生的 distro（D2）。生命周期把既有实例 API
 * 的 start/stop/restart/delete 映射为 distro 供给 + systemd 单元操作 + 常驻保活会话（D13），
 * 不新增平行 API。distro 生命周期由「活跃 `wsl.exe` 会话」决定，因此运行中的实例 MUST 持有常驻会话。
 */

export const WSL_BOOTSTRAP_ROOT = "/opt/task-handoff/bootstrap";
export const WSL_BOOTSTRAP_ENTRYPOINT = `${WSL_BOOTSTRAP_ROOT}/entrypoint.sh`;
export const WSL_PRIVATE_CONFIG_DIR = "/run/task-handoff/private";
export const WSL_PRIVATE_CONFIG_PATH = `${WSL_PRIVATE_CONFIG_DIR}/${INSTANCE_PRIVATE_CONFIG_FILE_NAME}`;
export const WSL_UNIT_NAME = "task-handoff-instance.service";
export const WSL_UNIT_PATH = `/etc/systemd/system/${WSL_UNIT_NAME}`;
export const WSL_DEFAULT_WORKSPACE = "/workspace";
export const WSL_BOOTSTRAP_REVISION_PATH = "/var/lib/task-handoff/bootstrap-revision";
export const WSL_UNIT_READY_TIMEOUT_MS = 30_000;

export const WSL_LIFECYCLE_FAILED = "WSL_LIFECYCLE_FAILED";
export const WSL_WORKSPACE_UNSUPPORTED = "WSL_WORKSPACE_UNSUPPORTED";
export const WSL_WORKSPACE_PREPARATION_FAILED = "WSL_WORKSPACE_PREPARATION_FAILED";

/** 生命周期需要的 `wsl.exe` 子集；`WslExecutor` 结构性满足，测试可用假实现。 */
export type WslLifecycleExecutor = {
  findDistro(name: string): Promise<{ name: string; state: string } | undefined>;
  listDistros(): Promise<Array<{ name: string; state: string }>>;
  unregister(name: string): Promise<void>;
  terminate(name: string): Promise<void>;
  systemctl(name: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  unitActive(name: string, unit: string): Promise<string>;
  exec(name: string, argv: readonly string[], options?: Record<string, unknown>): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  execOrThrow(name: string, argv: readonly string[], options?: Record<string, unknown>): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  copyIntoDistro(name: string, sourcePath: string, destinationPath: string, options?: Record<string, unknown>): Promise<unknown>;
  holdSession(name: string): Promise<WslSessionHandle>;
  releaseSession(name: string): Promise<void>;
  distroState(name: string): Promise<RuntimeLiveness>;
  ensureDistroRunning(name: string, options?: Record<string, unknown>): Promise<"running">;
  defaultGateway(name: string): Promise<string | undefined>;
};

export type WslLifecycleProvisioner = Pick<WslDistroProvisioner, "provision" | "distroNameForInstance" | "forgetDistro">;

export type WslLifecycleOptions = {
  provisioner: WslLifecycleProvisioner;
  executor: WslLifecycleExecutor;
  /** Node Agent 监听端口；实例经宿主网关回连。 */
  listenerPort: number;
  /** 宿主可达地址覆盖（`TASK_HANDOFF_WSL_NODE_AGENT_URL` 优先）。缺省从 distro 默认网关推导。 */
  hostAddress?: string;
  fallbackNodeAgentUrl?: string;
  /** bootstrap 资源目录（与 Docker 共用），桥接进 distro。 */
  bootstrapDir?: string;
  /** 宿主架构，用于 artifact target。 */
  hostArch?: string;
  allocatePort?: () => Promise<number>;
  unitReadyTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  logger?: (message: string, data: Record<string, unknown>) => void;
};

function lifecycleError(code: string, message: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

/** systemd `Environment=` 值转义：双引号包裹，转义反斜杠、双引号、换行与 `%` specifier。 */
export function systemdEnvironmentValue(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/%/g, "%%");
}

/** 渲染每实例 systemd 单元：distro 内进程由 systemd 持有，独立于 Node Agent 进程。 */
export function renderWslInstanceUnit(environment: Record<string, string>, options: { workspace: string; description: string }) {
  const environmentLines = Object.entries(environment)
    .filter(([, value]) => typeof value === "string")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment="${key}=${systemdEnvironmentValue(value)}"`);
  return [
    "[Unit]",
    `Description=${options.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${options.workspace}`,
    ...environmentLines,
    `ExecStart=/bin/bash ${WSL_BOOTSTRAP_ENTRYPOINT} task-handoff web`,
    "Restart=no",
    "KillMode=mixed",
    "TimeoutStopSec=20",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** distro 内实例运行环境。与 Docker 的 runtime env 保持一致语义，新增 WSL 专属键。 */
export function buildWslRuntimeEnvironment(
  context: ExecutorContext,
  options: { nodeAgentUrl: string; workspace: string },
) {
  const runtimeEnv: Record<string, string> = {
    TASK_HANDOFF_CONTROL_MODE: "controlled",
    TASK_HANDOFF_NODE_AGENT_URL: options.nodeAgentUrl,
    TASK_HANDOFF_INSTANCE_ID: context.instance.id,
    TASK_HANDOFF_INSTANCE_NAME: context.instance.name,
    TASK_HANDOFF_PROJECT_ID: context.project.id,
    TASK_HANDOFF_NODE_ID: context.node?.id || "node_unset",
    TASK_HANDOFF_RUNTIME_ID: context.runtime?.id || "runtime_wsl_host",
    TASK_HANDOFF_RUNTIME_KIND: "wsl",
    TASK_HANDOFF_IMAGE_ID: context.image.id,
    TASK_HANDOFF_INSTANCE_LAUNCHER: `${WSL_BOOTSTRAP_ROOT}/instance-launcher.sh`,
    TASK_HANDOFF_CHAT_BRIDGES: "none",
    TASK_HANDOFF_WORKSPACE: options.workspace,
    TASK_HANDOFF_WORKSPACE_MODE: context.project.workspacePolicy.mode,
    TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: WSL_PRIVATE_CONFIG_PATH,
    ...(context.image.tag ? { TASK_HANDOFF_IMAGE_TAG: context.image.tag } : {}),
    ...(context.project.source.type === "local-folder" ? {} : { TASK_HANDOFF_SKIP_WORKSPACE_BOOTSTRAP: "true" }),
  };
  if (context.project.source.type !== "local-folder") {
    runtimeEnv.TASK_HANDOFF_PROJECT_SOURCE = JSON.stringify(context.project.source);
    runtimeEnv.TASK_HANDOFF_WORKSPACE_POLICY = JSON.stringify(context.project.workspacePolicy);
    for (const [key, value] of workspaceGitEnvironmentEntries({
      url: context.project.source.url,
      ref: context.project.source.ref,
      clone: context.project.source.clone,
    }, { legacy: true })) {
      runtimeEnv[key] = value;
    }
    if (context.project.source.clone?.subdirectory) {
      runtimeEnv.TASK_HANDOFF_WORKSPACE_SUBDIRECTORY = context.project.source.clone.subdirectory;
    }
  }
  return runtimeEnv;
}

function sha256File(filePath: string) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** bootstrap 资源指纹：内容变化时才重新桥接进 distro。 */
export function bootstrapAssetsRevision(bootstrapDir: string) {
  const hash = createHash("sha256");
  const entries = fs.existsSync(bootstrapDir)
    ? fs.readdirSync(bootstrapDir, { withFileTypes: true }).filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  for (const entry of entries) {
    const filePath = path.join(bootstrapDir, entry.name);
    hash.update(entry.name);
    hash.update("\0");
    hash.update(sha256File(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export class WslInstanceLifecycle {
  private readonly provisioner: WslLifecycleProvisioner;
  private readonly executor: WslLifecycleExecutor;
  private readonly options: WslLifecycleOptions;

  constructor(options: WslLifecycleOptions) {
    this.options = options;
    this.provisioner = options.provisioner;
    this.executor = options.executor;
  }

  distroNameFor(instance: { id: string; runtime: { containerName?: string } }) {
    return this.provisioner.distroNameForInstance({ id: instance.id, containerName: instance.runtime.containerName });
  }

  async provision(instance: { id: string; runtimeId: string; runtime: { containerName?: string } }): Promise<WslProvisionResult> {
    return this.provisioner.provision({ id: instance.id, runtimeId: instance.runtimeId, containerName: instance.runtime.containerName });
  }

  sessionAlive(distroName: string) {
    const executor = this.executor as { sessionAlive?: (name: string) => boolean };
    return typeof executor.sessionAlive === "function" ? executor.sessionAlive(distroName) : false;
  }

  async nodeAgentUrl(context: ExecutorContext, distroName: string) {
    const explicit = this.options.hostAddress?.trim() || process.env.TASK_HANDOFF_WSL_NODE_AGENT_URL?.trim();
    if (explicit) return normalizeNodeAgentUrl(explicit, this.options.listenerPort);
    const gateway = await this.executor.defaultGateway(distroName).catch(() => undefined);
    if (gateway) return `http://${gateway}:${this.options.listenerPort}`;
    if (this.options.fallbackNodeAgentUrl) return this.options.fallbackNodeAgentUrl;
    throw lifecycleError(WSL_LIFECYCLE_FAILED, `Could not resolve a node agent URL reachable from WSL distro ${distroName} for instance ${context.instance.id}.`, {
      distroName,
      instanceId: context.instance.id,
    });
  }

  /** 把 Node Agent 侧 bootstrap 资源桥接进 distro（内容变化时）。 */
  async syncBootstrapAssets(distroName: string) {
    const bootstrapDir = this.options.bootstrapDir;
    if (!bootstrapDir || !fs.existsSync(bootstrapDir)) return;
    const revision = bootstrapAssetsRevision(bootstrapDir);
    const current = await this.executor.exec(distroName, ["cat", WSL_BOOTSTRAP_REVISION_PATH]);
    if (current.exitCode === 0 && current.stdout.trim() === revision) return;
    await this.executor.execOrThrow(distroName, ["sh", "-c", `mkdir -p ${WSL_BOOTSTRAP_ROOT}`]);
    for (const entry of fs.readdirSync(bootstrapDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      await this.executor.copyIntoDistro(distroName, path.join(bootstrapDir, entry.name), `${WSL_BOOTSTRAP_ROOT}/${entry.name}`);
    }
    await this.executor.execOrThrow(distroName, ["sh", "-c", `chmod 0755 ${WSL_BOOTSTRAP_ROOT}/*.sh ${WSL_BOOTSTRAP_ROOT}/*.mjs 2>/dev/null || true`]);
    await this.executor.execOrThrow(distroName, ["sh", "-c", `mkdir -p ${path.posix.dirname(WSL_BOOTSTRAP_REVISION_PATH)} && printf '%s' ${shellSingleQuote(revision)} > ${WSL_BOOTSTRAP_REVISION_PATH}`]);
    this.options.logger?.("wsl bootstrap assets synchronized", { distroName, revision, bootstrapDir });
  }

  /** 每实例 private config 走 stdin 桥接（tmpfs，不落入 distro vhdx）。 */
  async syncPrivateConfig(context: ExecutorContext, distroName: string) {
    if (!context.privateConfigPath || !fs.existsSync(context.privateConfigPath)) return;
    await this.executor.execOrThrow(distroName, ["sh", "-c", `mkdir -p ${WSL_PRIVATE_CONFIG_DIR} && chmod 0700 ${WSL_PRIVATE_CONFIG_DIR}`]);
    await this.executor.copyIntoDistro(distroName, context.privateConfigPath, WSL_PRIVATE_CONFIG_PATH);
    await this.executor.execOrThrow(distroName, ["sh", "-c", `chmod 0600 ${WSL_PRIVATE_CONFIG_PATH}`]);
  }

  async installRuntime(distroName: string, artifact: ResolvedRuntimeArtifact) {
    await installWslRuntime(this.executor, distroName, artifact);
  }

  async inspectRuntime(distroName: string, expected: RuntimeArtifactIdentity) {
    return inspectWslRuntime(this.executor, distroName, expected);
  }

  artifactTarget() {
    return wslArtifactTarget(this.options.hostArch ?? process.arch);
  }

  private async allocatePort() {
    if (this.options.allocatePort) return this.options.allocatePort();
    return allocateLocalPort();
  }

  private async writeUnit(distroName: string, environment: Record<string, string>, workspace: string, instanceId: string) {
    const unit = renderWslInstanceUnit(environment, { workspace, description: `Task Handoff controlled instance ${instanceId}` });
    const encoded = Buffer.from(unit, "utf8").toString("base64");
    await this.executor.execOrThrow(distroName, [
      "sh",
      "-c",
      `printf '%s' ${shellSingleQuote(encoded)} | base64 -d > ${WSL_UNIT_PATH}`,
    ]);
  }

  private async waitForUnitActive(distroName: string) {
    const deadline = Date.now() + (this.options.unitReadyTimeoutMs ?? WSL_UNIT_READY_TIMEOUT_MS);
    const interval = this.options.pollIntervalMs ?? 500;
    while (Date.now() < deadline) {
      const active = await this.executor.unitActive(distroName, WSL_UNIT_NAME).catch(() => "unknown");
      if (active === "active") return "active";
      if (active === "failed") {
        throw lifecycleError(WSL_LIFECYCLE_FAILED, `systemd unit ${WSL_UNIT_NAME} failed to start in WSL distro ${distroName}.`, { distroName });
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    const active = await this.executor.unitActive(distroName, WSL_UNIT_NAME).catch(() => "unknown");
    if (active === "active") return "active";
    throw lifecycleError(WSL_LIFECYCLE_FAILED, `systemd unit ${WSL_UNIT_NAME} did not become active in WSL distro ${distroName} within the timeout.`, { distroName, state: active });
  }

  async start(context: ExecutorContext): Promise<ExecutorStartResult> {
    const distroName = this.distroNameFor(context.instance);
    const provision = await this.provisioner.provision({ id: context.instance.id, runtimeId: context.instance.runtimeId, containerName: context.instance.runtime.containerName });
    const workspace = await this.prepareWorkspace(context, distroName);
    await this.syncBootstrapAssets(distroName);
    await this.syncPrivateConfig(context, distroName);
    // 先持有保活会话，使 distro 在单元启动与就绪等待期间不会被空闲回收（D13）。
    await this.executor.holdSession(distroName);
    const nodeAgentUrl = await this.nodeAgentUrl(context, distroName);
    const environment = buildWslRuntimeEnvironment(context, { nodeAgentUrl, workspace });
    await this.writeUnit(distroName, environment, workspace, context.instance.id);
    const port = context.instance.runtime.port ?? await this.allocatePort();
    await this.executor.systemctl(distroName, ["daemon-reload"]);
    await this.executor.systemctl(distroName, ["enable", WSL_UNIT_NAME]);
    await this.executor.systemctl(distroName, ["restart", WSL_UNIT_NAME]);
    // 单元在 runtime artifact 未安装时会快速失败；与 Docker 一样，start 只负责拉起执行域，
    // 就绪由 app 层 probe 与后续 version convergence（install + restart）决定，因此这里不因
    // 单元未激活就让 start 失败，只发布诊断。
    const unitState = await this.waitForUnitActive(distroName).catch((error) => {
      this.options.logger?.("wsl unit not active after start", {
        instanceId: context.instance.id,
        distroName,
        error: error instanceof Error ? error.message : String(error),
      });
      return "unknown" as const;
    });
    const web = `http://127.0.0.1:${port}`;
    this.options.logger?.("wsl instance started", { instanceId: context.instance.id, distroName, port, nodeAgentUrl, created: provision.created, unitState });
    return {
      status: "registering",
      health: "unknown",
      connectionStatus: "online",
      agentStatus: "unknown",
      targetStatus: "unknown",
      uiAccessStatus: "unknown",
      target: { strategy: "node-proxy", status: "unknown", web, api: `${web}/api` },
      workspace: { mode: context.project.workspacePolicy.mode, status: "ready", path: workspace },
      runtime: {
        kind: "wsl",
        containerName: distroName,
        workspacePath: workspace,
        port,
        labels: { ...context.instance.runtime.labels, ...provision.labels },
      },
    };
  }

  async stop(context: ExecutorContext): Promise<ExecutorStartResult> {
    const distroName = this.distroNameFor(context.instance);
    const state = await this.executor.distroState(distroName).catch(() => "unknown" as const);
    if (state === "absent") {
      await this.executor.releaseSession(distroName).catch(() => undefined);
      return this.stoppedResult(context);
    }
    await this.executor.systemctl(distroName, ["stop", WSL_UNIT_NAME]).catch(() => undefined);
    await this.executor.releaseSession(distroName).catch(() => undefined);
    // 显式终止 distro：停止单元后仍可能处于 Running，distro 与数据保留供后续启动（5.2）。
    await this.executor.terminate(distroName).catch(() => undefined);
    this.options.logger?.("wsl instance stopped", { instanceId: context.instance.id, distroName });
    return this.stoppedResult(context);
  }

  private stoppedResult(context: ExecutorContext): ExecutorStartResult {
    return {
      status: "stopped",
      health: "unknown",
      connectionStatus: "offline",
      agentStatus: "offline",
      targetStatus: "unknown",
      uiAccessStatus: "unknown",
      target: { ...context.instance.target, status: "unknown" },
      runtime: context.instance.runtime,
    };
  }

  async restart(context: ExecutorContext): Promise<ExecutorStartResult> {
    const distroName = this.distroNameFor(context.instance);
    await this.executor.systemctl(distroName, ["stop", WSL_UNIT_NAME]).catch(() => undefined);
    await this.executor.releaseSession(distroName).catch(() => undefined);
    return this.start(context);
  }

  async delete(context: ExecutorContext, input: InstanceDeleteInput): Promise<InstanceDeleteResult> {
    const distroName = this.distroNameFor(context.instance);
    const state = await this.executor.distroState(distroName).catch(() => "unknown" as const);
    if (state === "absent") {
      await this.executor.releaseSession(distroName).catch(() => undefined);
      this.provisioner.forgetDistro(distroName);
      return InstanceDeleteResultSchema.parse({
        instanceId: context.instance.id,
        containerDeleted: true,
        completed: true,
        deletedVolumes: [],
        retainedVolumes: this.distroVolumeDispositions(distroName, "missing", input),
        volumeResults: this.distroVolumeDispositions(distroName, "missing", input),
      });
    }
    let deleted = false;
    let failure: { code: string; message: string } | undefined;
    try {
      await this.executor.systemctl(distroName, ["stop", WSL_UNIT_NAME]).catch(() => undefined);
      await this.executor.releaseSession(distroName).catch(() => undefined);
      await this.executor.unregister(distroName);
      this.provisioner.forgetDistro(distroName);
      deleted = true;
    } catch (error) {
      failure = {
        code: typeof error === "object" && error && "code" in error && typeof (error as { code?: unknown }).code === "string"
          ? String((error as { code: unknown }).code)
          : WSL_LIFECYCLE_FAILED,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const status = deleted ? "deleted" as const : input.deleteVolumes ? "failed" as const : "retained" as const;
    const volumeResults = this.distroVolumeDispositions(distroName, status, input, failure);
    this.options.logger?.(deleted ? "wsl instance deleted" : "wsl instance delete incomplete", {
      instanceId: context.instance.id,
      distroName,
      status,
      ...(failure ? { error: failure.message } : {}),
    });
    return InstanceDeleteResultSchema.parse({
      instanceId: context.instance.id,
      containerDeleted: deleted,
      completed: deleted,
      deletedVolumes: volumeResults.filter((result) => result.status === "deleted" || result.status === "missing"),
      retainedVolumes: volumeResults.filter((result) => result.status === "retained"),
      volumeResults,
    });
  }

  /**
   * distro 内承载了实例的 data/agent-home/workspace（与 Docker 的受管卷一一对应），
   * 因此删除 distro 时逐项报告同一 distro 内三类数据的去向。
   */
  private distroVolumeDispositions(
    distroName: string,
    status: "deleted" | "retained" | "missing" | "failed",
    input: InstanceDeleteInput,
    failure?: { code: string; message: string },
  ) {
    const effective = status === "failed" && !input.deleteVolumes ? "retained" as const : status;
    const roles: Array<{ role: "data" | "agent-home" | "workspace"; mountPath: string }> = [
      { role: "data", mountPath: "/data" },
      { role: "agent-home", mountPath: "/home/agent" },
      { role: "workspace", mountPath: WSL_DEFAULT_WORKSPACE },
    ];
    return roles.map(({ role, mountPath }) => ({
      role,
      name: `${distroName}:${role}`,
      mountPath,
      status: effective,
      ...(effective === "failed" ? { error: failure ?? { code: WSL_LIFECYCLE_FAILED, message: `Could not remove WSL distro ${distroName}.` } } : {}),
    }));
  }

  /** Phase 6：Git 与 local-folder 工作区。 */
  private async prepareWorkspace(context: ExecutorContext, distroName: string): Promise<string> {
    const workspacePath = context.project.workspacePolicy.path || WSL_DEFAULT_WORKSPACE;
    if (context.project.source.type === "local-folder") {
      return this.prepareLocalFolderWorkspace(context, distroName, workspacePath);
    }
    await this.executor.execOrThrow(distroName, ["sh", "-c", `mkdir -p ${shellSingleQuote(workspacePath)}`]);
    return workspacePath;
  }

  /**
   * local-folder：把 Windows 路径映射为 distro 内可访问的工作区（`/mnt/<drive>/...`），
   * 以符号链接暴露工作区路径。Node Agent 自身路径与 distro 内路径 MUST NOT 进入公共字段。
   */
  private async prepareLocalFolderWorkspace(context: ExecutorContext, distroName: string, workspacePath: string) {
    if (context.project.source.type !== "local-folder") throw lifecycleError(WSL_WORKSPACE_UNSUPPORTED, "Local folder workspace preparation requires a local-folder source.");
    const mapped = windowsPathToDrvfs(context.project.source.path);
    if (!mapped) {
      throw lifecycleError(WSL_WORKSPACE_UNSUPPORTED, `Local folder ${context.project.source.path} is not a Windows absolute path mapable into WSL.`, {
        instanceId: context.instance.id,
        path: context.project.source.path,
      });
    }
    const exists = await this.executor.exec(distroName, ["test", "-d", mapped]);
    if (exists.exitCode !== 0) {
      throw lifecycleError(WSL_WORKSPACE_PREPARATION_FAILED, `Mapped local folder ${mapped} is not accessible inside WSL distro ${distroName}.`, {
        instanceId: context.instance.id,
        mapped,
      });
    }
    await this.executor.execOrThrow(distroName, ["sh", "-c", `mkdir -p ${shellSingleQuote(path.posix.dirname(workspacePath))} && ln -sfn ${shellSingleQuote(mapped)} ${shellSingleQuote(workspacePath)}`]);
    return workspacePath;
  }
}

/** `C:\Users\x` → `/mnt/c/Users/x`；非 Windows 绝对路径返回 undefined。 */
export function windowsPathToDrvfs(value: string) {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(value.trim());
  if (!match) return undefined;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export { WSL_RUNTIME_ROOT, WSL_RUNTIME_INSTALLER, WSL_RUNTIME_ARTIFACT_STAGING };
