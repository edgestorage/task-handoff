import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeArtifactIdentitySchema, type ControlledInstance, type InstanceImageSnapshot, type LocalDockerImage, type Node, type NodeRuntime, type Project, type RuntimeArtifactIdentity } from "@task-handoff/protocol/control-plane";
import { defaultCommandRunner, type CommandRunner } from "../../shared/process/command-runner.ts";
import { DockerImageService, listDockerImages } from "../docker-images.ts";

export { defaultCommandRunner, type CommandResult, type CommandRunner } from "../../shared/process/command-runner.ts";

export type ExecutorContext = {
  project: Project;
  image: InstanceImageSnapshot;
  node: Node;
  runtime: NodeRuntime;
  instance: ControlledInstance;
  nodeAgentUrl?: string;
  modelEnv?: Record<string, string>;
};

export type ExecutorStartResult = {
  status?: ControlledInstance["status"];
  health?: ControlledInstance["health"];
  connectionStatus?: ControlledInstance["connectionStatus"];
  agentStatus?: ControlledInstance["agentStatus"];
  targetStatus?: ControlledInstance["targetStatus"];
  uiAccessStatus?: ControlledInstance["uiAccessStatus"];
  target?: Partial<ControlledInstance["target"]>;
  workspace?: Partial<ControlledInstance["workspace"]>;
  runtime?: Partial<ControlledInstance["runtime"]>;
};

export type NodeRuntimeExecutor = {
  start(context: ExecutorContext): Promise<ExecutorStartResult>;
  stop(context: ExecutorContext): Promise<ExecutorStartResult>;
  restart(context: ExecutorContext): Promise<ExecutorStartResult>;
  delete(context: ExecutorContext): Promise<ExecutorStartResult>;
};

export type DockerExecutorOptions = {
  publishHost?: string;
  imageService?: DockerImageService;
  launcherAssetsDir?: string;
};

export type DockerRuntimeInstallRequest = {
  containerName: string;
  artifactPath: string;
  identity: RuntimeArtifactIdentity;
  expectedContainerId?: string;
};

export type DockerRuntimeInspection = Partial<RuntimeArtifactIdentity> & {
  containerId?: string;
};

export type DockerRuntimeTarget = {
  platform: string;
  arch: string;
  launcherAbi: number;
};

export class LocalDockerExecutor implements NodeRuntimeExecutor {
  private readonly runCommand: CommandRunner;
  private readonly publishHost: string;
  private readonly images: DockerImageService;
  private readonly launcherAssetsDir: string;

  constructor(runCommand: CommandRunner = defaultCommandRunner, options: DockerExecutorOptions = {}) {
    this.runCommand = runCommand;
    this.images = options.imageService || new DockerImageService(runCommand);
    this.publishHost = options.publishHost || "127.0.0.1";
    this.launcherAssetsDir = options.launcherAssetsDir || defaultLauncherAssetsDir();
  }

  async start(context: ExecutorContext): Promise<ExecutorStartResult> {
    validateStartContext(context);
    const containerName = context.instance.runtime.containerName || containerNameForInstance(context.instance.id);
    const existing = await this.runCommand("docker", ["start", containerName]).catch(() => undefined);
    if (existing) {
      return this.runningResult(context, containerName, context.instance.runtime.containerId);
    }
    await this.images.ensure(context.image.resolvedReference || context.image.requestedReference!);
    const runResult = await this.runCommand("docker", dockerRunArgs(context, containerName, { publishHost: this.publishHost }));
    return this.runningResult(context, containerName, runResult.stdout || undefined);
  }

  private async runningResult(context: ExecutorContext, containerName: string, containerId?: string): Promise<ExecutorStartResult> {
    const webPort = await this.containerPort(containerName, "8080/tcp");
    const web = webPort ? `http://127.0.0.1:${webPort}` : undefined;
    const nodeId = context.node?.id || "node_unset";
    const runtimeId = context.runtime?.id || "runtime_local_docker";
    return {
      status: "registering",
      health: "unknown",
      connectionStatus: web ? "online" : "unknown",
      agentStatus: "unknown",
      targetStatus: "unknown",
      uiAccessStatus: "unknown",
      target: {
        strategy: "direct-port",
        status: web ? "reachable" : "unknown",
        ...(web ? { web, api: `${web}/api` } : {}),
      },
      workspace: {
        mode: context.project.workspacePolicy.mode,
        status: "pending",
        path: context.project.workspacePolicy.path,
      },
      runtime: {
        ...context.instance.runtime,
        kind: "docker",
        containerName,
        ...(containerId ? { containerId } : {}),
        labels: {
          ...context.instance.runtime.labels,
          "task-handoff.instance-id": context.instance.id,
          "task-handoff.project-id": context.project.id,
          "task-handoff.node-id": nodeId,
          "task-handoff.runtime-id": runtimeId,
          "task-handoff.image-id": context.image.id,
        },
      },
    };
  }

  async stop(context: ExecutorContext): Promise<ExecutorStartResult> {
    await this.runCommand("docker", ["stop", context.instance.runtime.containerName || containerNameForInstance(context.instance.id)]).catch(() => ({ stdout: "", stderr: "" }));
    return {
      status: "stopped",
      health: "unknown",
      connectionStatus: "offline",
      target: {
        ...context.instance.target,
        status: "unknown",
      },
      runtime: context.instance.runtime,
    };
  }

  async restart(context: ExecutorContext, expectedContainerId?: string): Promise<ExecutorStartResult> {
    validateStartContext(context);
    const containerName = context.instance.runtime.containerName || containerNameForInstance(context.instance.id);
    const before = await this.inspectContainerId(containerName);
    if (!before) throw runtimeExecutorError("INSTANCE_RUNTIME_RESTART_FAILED", `Docker container ${containerName} does not exist.`);
    assertExpectedContainerId(containerName, before, expectedContainerId, "before restart", "INSTANCE_RUNTIME_RESTART_FAILED");
    await this.runCommand("docker", ["restart", containerName]);
    const after = await this.inspectContainerId(containerName);
    if (!after || after !== before) throw runtimeExecutorError("INSTANCE_RUNTIME_RESTART_FAILED", `Docker container identity changed while restarting ${containerName}.`);
    assertExpectedContainerId(containerName, after, expectedContainerId, "after restart", "INSTANCE_RUNTIME_RESTART_FAILED");
    return this.runningResult(context, containerName, after);
  }

  async delete(context: ExecutorContext): Promise<ExecutorStartResult> {
    await this.runCommand("docker", ["rm", "-f", context.instance.runtime.containerName || containerNameForInstance(context.instance.id)]).catch(() => ({ stdout: "", stderr: "" }));
    return {
      status: "stopped",
      health: "unknown",
      connectionStatus: "offline",
      target: {
        ...context.instance.target,
        status: "unknown",
      },
      runtime: context.instance.runtime,
    };
  }

  /**
   * Installs an application release into an already-running container and
   * restarts that same container. This path intentionally contains no image
   * pull, container remove, or container create operation.
   */
  async installRuntime(request: DockerRuntimeInstallRequest): Promise<DockerRuntimeInspection> {
    const before = await this.installRuntimeRelease(request);
    assertExpectedContainerId(request.containerName, before, request.expectedContainerId, "before runtime restart", "INSTANCE_RUNTIME_RESTART_FAILED");
    try {
      await this.runCommand("docker", ["restart", request.containerName]);
    } catch (cause) {
      throw runtimeExecutorError("INSTANCE_RUNTIME_RESTART_FAILED", `Could not restart Docker container ${request.containerName}.`, cause);
    }
    const after = await this.inspectContainerId(request.containerName);
    if (!after || after !== before) {
      throw runtimeExecutorError("INSTANCE_RUNTIME_RESTART_FAILED", `Docker container identity changed while updating ${request.containerName}.`);
    }
    assertExpectedContainerId(request.containerName, after, request.expectedContainerId, "after runtime restart", "INSTANCE_RUNTIME_RESTART_FAILED");
    return this.inspectRuntimeVersion(request.containerName);
  }

  /** Installs and activates a release without changing container lifecycle. */
  async installRuntimeRelease(request: DockerRuntimeInstallRequest): Promise<string> {
    const before = await this.inspectContainerId(request.containerName);
    if (!before) throw runtimeExecutorError("INSTANCE_RUNTIME_INSTALL_FAILED", `Docker container ${request.containerName} does not exist.`);
    assertExpectedContainerId(request.containerName, before, request.expectedContainerId, "before runtime install", "INSTANCE_RUNTIME_INSTALL_FAILED");
    const remoteArtifact = `/opt/task-handoff/instance-runtime/incoming/task-handoff-runtime-${safePathSegment(request.identity.version)}-${request.identity.sha256.slice(0, 12)}.tar.gz`;
    await this.runCommand("docker", ["exec", "--user", "0", request.containerName, "install", "-d", "-o", "root", "-g", "root", "-m", "0755", "/opt/task-handoff/instance-runtime/incoming"]);
    await this.runCommand("docker", ["cp", request.artifactPath, `${request.containerName}:${remoteArtifact}`]);
    try {
      await this.runCommand("docker", [
        "exec",
        "--user",
        "0",
        request.containerName,
        "task-handoff-runtime",
        "install",
        "--artifact",
        remoteArtifact,
        "--version",
        request.identity.version,
        "--sha256",
        request.identity.sha256,
        "--platform",
        request.identity.platform,
        "--arch",
        request.identity.arch,
        "--launcher-abi",
        String(request.identity.launcherAbi),
      ]);
    } catch (cause) {
      throw runtimeExecutorError("INSTANCE_RUNTIME_INSTALL_FAILED", `Could not install controlled-instance ${request.identity.version} in ${request.containerName}.`, cause);
    } finally {
      await this.runCommand("docker", ["exec", "--user", "0", request.containerName, "rm", "-f", remoteArtifact]).catch(() => ({ stdout: "", stderr: "" }));
    }

    const after = await this.inspectContainerId(request.containerName);
    if (!after || after !== before) throw runtimeExecutorError("INSTANCE_RUNTIME_INSTALL_FAILED", `Docker container identity changed while installing ${request.containerName}.`);
    assertExpectedContainerId(request.containerName, after, request.expectedContainerId, "after runtime install", "INSTANCE_RUNTIME_INSTALL_FAILED");
    return before;
  }

  async inspectRuntimeVersion(containerName: string): Promise<DockerRuntimeInspection> {
    const containerId = await this.inspectContainerId(containerName);
    if (!containerId) return {};
    const result = await this.runCommand("docker", [
      "exec",
      "--user",
      "agent",
      containerName,
      "task-handoff-runtime",
      "verify-active",
    ]).catch(() => undefined);
    if (!result?.stdout) return { containerId };
    try {
      const parsed = RuntimeArtifactIdentitySchema.safeParse(JSON.parse(result.stdout));
      return parsed.success ? { containerId, ...parsed.data } : { containerId };
    } catch {
      return { containerId };
    }
  }

  async inspectRuntimeTarget(containerName?: string): Promise<DockerRuntimeTarget> {
    let platform: unknown;
    let arch: unknown;
    if (containerName) {
      const container = await this.runCommand("docker", ["inspect", "--format", "{{json .}}", containerName]).then((result) => JSON.parse(result.stdout.trim() || "{}") as Record<string, unknown>).catch(() => undefined);
      platform = container?.Platform;
      if (typeof container?.Image === "string" && container.Image) {
        const image = await this.runCommand("docker", ["image", "inspect", "--format", "{{json .}}", container.Image]).then((result) => JSON.parse(result.stdout.trim() || "{}") as Record<string, unknown>).catch(() => undefined);
        platform = image?.Os || platform;
        arch = image?.Architecture;
      }
    }
    if (!platform || !arch) {
      const info = await this.runCommand("docker", ["info", "--format", "{{json .}}"])
        .then((result) => JSON.parse(result.stdout.trim() || "{}") as Record<string, unknown>)
        .catch((cause) => {
          throw runtimeExecutorError("INSTANCE_BASE_RUNTIME_INCOMPATIBLE", "Could not inspect the Docker runtime target.", cause);
        });
      platform ||= info.OSType;
      arch ||= info.Architecture;
    }
    const normalizedPlatform = normalizeDockerPlatform(platform);
    const normalizedArch = normalizeDockerArchitecture(arch);
    if (!normalizedPlatform || !normalizedArch) {
      throw runtimeExecutorError("INSTANCE_BASE_RUNTIME_INCOMPATIBLE", `Docker reported an unsupported runtime target ${String(platform || "unknown")}/${String(arch || "unknown")}.`);
    }
    return { platform: normalizedPlatform, arch: normalizedArch, launcherAbi: 1 };
  }

  async rollbackRuntime(containerName: string): Promise<DockerRuntimeInspection> {
    const before = await this.inspectContainerId(containerName);
    if (!before) throw runtimeExecutorError("INSTANCE_RUNTIME_RESTART_FAILED", `Docker container ${containerName} does not exist.`);
    try {
      await this.runCommand("docker", ["exec", "--user", "0", containerName, "task-handoff-runtime", "rollback"]);
      await this.runCommand("docker", ["restart", containerName]);
    } catch (cause) {
      throw runtimeExecutorError("INSTANCE_RUNTIME_RESTART_FAILED", `Could not roll back ${containerName} to its previous controlled-instance release.`, cause);
    }
    const after = await this.inspectContainerId(containerName);
    if (!after || after !== before) throw runtimeExecutorError("INSTANCE_RUNTIME_RESTART_FAILED", `Docker container identity changed while rolling back ${containerName}.`);
    return this.inspectRuntimeVersion(containerName);
  }

  /** Installs the launcher bundle shipped by this node-agent before updating the application runtime. */
  async installRuntimeLauncher(containerName: string): Promise<void> {
    const containerId = await this.inspectContainerId(containerName);
    if (!containerId) throw runtimeExecutorError("INSTANCE_BASE_RUNTIME_INCOMPATIBLE", `Docker container ${containerName} does not exist.`);
    const assets = [
      [path.join(this.launcherAssetsDir, "entrypoint.sh"), "/root/.task-handoff-entrypoint.bootstrap"],
      [path.join(this.launcherAssetsDir, "instance-launcher.sh"), "/root/.task-handoff-instance-launcher.bootstrap"],
      [path.join(this.launcherAssetsDir, "runtime-installer.mjs"), "/root/.task-handoff-runtime-installer.bootstrap"],
    ] as const;
    for (const [source, target] of assets) await this.runCommand("docker", ["cp", source, `${containerName}:${target}`]);
    try {
      await this.runCommand("docker", [
        "exec",
        "--user",
        "0",
        containerName,
        "bash",
        "-ceu",
        "install -d -o root -g root -m 0755 /opt/task-handoff/instance-runtime /opt/task-handoff/instance-runtime/releases /opt/task-handoff/instance-runtime/staging /opt/task-handoff/instance-runtime/incoming; chown -R root:root /opt/task-handoff/instance-runtime; chmod -R go-w /opt/task-handoff/instance-runtime; install -m 0755 /root/.task-handoff-entrypoint.bootstrap /usr/local/bin/task-handoff-entrypoint; install -m 0755 /root/.task-handoff-instance-launcher.bootstrap /usr/local/bin/task-handoff-instance-launcher; install -d /usr/local/lib/task-handoff; install -m 0755 /root/.task-handoff-runtime-installer.bootstrap /usr/local/lib/task-handoff/runtime-installer.mjs; ln -sfn /usr/local/lib/task-handoff/runtime-installer.mjs /usr/local/bin/task-handoff-runtime; rm -f /root/.task-handoff-entrypoint.bootstrap /root/.task-handoff-instance-launcher.bootstrap /root/.task-handoff-runtime-installer.bootstrap",
      ]);
    } catch (cause) {
      throw runtimeExecutorError("INSTANCE_BASE_RUNTIME_INCOMPATIBLE", `Could not install the runtime launcher in ${containerName}.`, cause);
    }
    const after = await this.inspectContainerId(containerName);
    if (after !== containerId) throw runtimeExecutorError("INSTANCE_BASE_RUNTIME_INCOMPATIBLE", `Docker container identity changed while installing the runtime launcher in ${containerName}.`);
  }

  private async inspectContainerId(containerName: string) {
    const result = await this.runCommand("docker", ["inspect", "--format", "{{.Id}}", containerName]).catch(() => undefined);
    return result?.stdout.trim() || undefined;
  }

  private async containerPort(containerName: string, containerPort: string) {
    const result = await this.runCommand("docker", ["port", containerName, containerPort]).catch(() => ({ stdout: "", stderr: "" }));
    const line = result.stdout.split(/\r?\n/).find(Boolean);
    const match = line?.match(/:(\d+)$/);
    return match?.[1];
  }

}

function safePathSegment(value: string) {
  return value.replace(/[^0-9A-Za-z.+_-]/g, "-");
}

function normalizeDockerPlatform(value: unknown) {
  if (value === "linux" || value === "darwin") return value;
  if (value === "windows" || value === "win32") return "win32";
  return undefined;
}

function normalizeDockerArchitecture(value: unknown) {
  if (value === "amd64" || value === "x86_64" || value === "x64") return "x64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return undefined;
}

function defaultLauncherAssetsDir() {
  const moduleDir = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : __dirname;
  const candidates = [
    path.resolve(moduleDir, "../../../../../docker"),
    path.resolve(moduleDir, "../docker"),
    path.resolve(moduleDir, "../../docker"),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "runtime-installer.mjs"))) || candidates[0];
}

function runtimeExecutorError(code: string, message: string, cause?: unknown) {
  const detail = commandFailureDetail(cause);
  const error = new Error(detail ? `${message} Cause: ${detail}` : message, cause === undefined ? undefined : { cause });
  Object.assign(error, { statusCode: 502, code });
  return error;
}

function commandFailureDetail(cause: unknown) {
  if (!cause || typeof cause !== "object") return cause === undefined ? undefined : String(cause);
  const candidate = cause as { message?: unknown; details?: { stderr?: unknown; stdout?: unknown } };
  const output = candidate.details?.stderr || candidate.details?.stdout;
  if (typeof output === "string" && output.trim()) return output.trim();
  return typeof candidate.message === "string" && candidate.message.trim() ? candidate.message.trim() : undefined;
}

function assertExpectedContainerId(containerName: string, actual: string, expected: string | undefined, phase: string, code: string) {
  if (expected && actual !== expected) {
    throw runtimeExecutorError(code, `Docker container ${containerName} identity mismatch ${phase}: expected ${expected}, got ${actual}.`);
  }
}

export async function listLocalDockerImages(runCommand: CommandRunner = defaultCommandRunner): Promise<LocalDockerImage[]> {
  return listDockerImages(runCommand);
}

export function containerNameForInstance(instanceId: string) {
  return `task-handoff-${instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

export function dockerRunArgs(context: ExecutorContext, containerName: string, options: DockerExecutorOptions = {}) {
  const publishHost = options.publishHost || "127.0.0.1";
  const nodeId = context.node?.id || "node_unset";
  const runtimeId = context.runtime?.id || "runtime_local_docker";
  const args = [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `task-handoff.instance-id=${context.instance.id}`,
    "--label",
    `task-handoff.project-id=${context.project.id}`,
    "--label",
    `task-handoff.node-id=${nodeId}`,
    "--label",
    `task-handoff.runtime-id=${runtimeId}`,
    "--label",
    `task-handoff.image-id=${context.image.id}`,
    "--shm-size",
    "1gb",
    "--security-opt",
    "seccomp=unconfined",
    "--network",
    "bridge",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--tmpfs",
    "/tmp:rw,mode=1777",
    "-v",
    `${containerName}-data:/data`,
    "-v",
    `${containerName}-agent-home:/home/agent`,
    "-p",
    `${publishHost}::8080`,
    "-e",
    "TASK_HANDOFF_CONTROL_MODE=controlled",
    "-e",
    `TASK_HANDOFF_NODE_AGENT_URL=${context.nodeAgentUrl || context.node?.endpoint || ""}`,
    "-e",
    `TASK_HANDOFF_INSTANCE_ID=${context.instance.id}`,
    "-e",
    `TASK_HANDOFF_INSTANCE_NAME=${context.instance.name}`,
    "-e",
    `TASK_HANDOFF_REGISTRATION_TOKEN=${context.instance.registrationToken || ""}`,
    "-e",
    `TASK_HANDOFF_PROJECT_ID=${context.project.id}`,
    "-e",
    `TASK_HANDOFF_NODE_ID=${nodeId}`,
    "-e",
    `TASK_HANDOFF_RUNTIME_ID=${runtimeId}`,
    "-e",
    `TASK_HANDOFF_IMAGE_ID=${context.image.id}`,
    ...(context.image.tag ? [`TASK_HANDOFF_IMAGE_TAG=${context.image.tag}`] : []),
    "-e",
    "TASK_HANDOFF_CHAT_BRIDGES=none",
    "-e",
    `TASK_HANDOFF_WORKSPACE=${context.project.workspacePolicy.path || "/workspace"}`,
    "-e",
    `TASK_HANDOFF_WORKSPACE_MODE=${context.project.workspacePolicy.mode}`,
  ];

  if (context.project.source.type === "local-folder") {
    args.push("-v", `${context.project.source.path}:${context.project.workspacePolicy.path || "/workspace"}:${context.project.workspacePolicy.readOnly ? "ro" : "rw"}`);
  } else {
    args.push("-e", `TASK_HANDOFF_PROJECT_SOURCE=${JSON.stringify(context.project.source)}`);
    args.push("-e", `TASK_HANDOFF_WORKSPACE_POLICY=${JSON.stringify(context.project.workspacePolicy)}`);
    args.push("-e", `TASK_HANDOFF_GIT_URL=${context.project.source.url}`);
    if (context.project.source.ref?.commit) {
      args.push("-e", `TASK_HANDOFF_GIT_COMMIT=${context.project.source.ref.commit}`);
    } else if (context.project.source.ref?.name) {
      args.push("-e", `TASK_HANDOFF_GIT_REF=${context.project.source.ref.name}`);
    }
    if (context.project.source.clone?.depth) {
      args.push("-e", `TASK_HANDOFF_GIT_DEPTH=${context.project.source.clone.depth}`);
    }
    args.push("-e", `TASK_HANDOFF_GIT_SUBMODULES=${context.project.source.clone?.submodules ? "true" : "false"}`);
    args.push("-e", `TASK_HANDOFF_GIT_LFS=${context.project.source.clone?.lfs ? "true" : "false"}`);
    if (context.project.source.clone?.subdirectory) {
      args.push("-e", `TASK_HANDOFF_WORKSPACE_SUBDIRECTORY=${context.project.source.clone.subdirectory}`);
    }
  }

  for (const [key, value] of Object.entries(context.image.defaultEnv)) {
    args.push("-e", `${key}=${value}`);
  }

  for (const [key, value] of Object.entries(context.modelEnv || {})) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(context.image.resolvedReference || context.image.requestedReference!);
  return args;
}

export function validateStartContext(context: ExecutorContext) {
  if (context.project.source.type === "local-folder" && context.project.source.ownerNodeId && context.project.source.ownerNodeId !== context.node.id) {
    const error = new Error("Local folder projects can only start on the node that owns the folder.");
    Object.assign(error, { statusCode: 400, code: "LOCAL_FOLDER_REQUIRES_OWNER_NODE" });
    throw error;
  }
  if (!context.image.requestedReference?.trim()) {
    const error = new Error("Image profile must reference a registered image.");
    Object.assign(error, { statusCode: 400, code: "IMAGE_PROFILE_INVALID" });
    throw error;
  }
}
