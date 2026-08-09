import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceDeleteResultSchema, RuntimeArtifactIdentitySchema, type ControlledInstance, type InstanceDeleteInput, type InstanceDeleteResult, type InstanceImageSnapshot, type LocalDockerImage, type Node, type NodeRuntime, type Project, type RuntimeArtifactIdentity } from "@task-handoff/protocol/control-plane";
import { safeParseResponse } from "@task-handoff/protocol/response-validation";
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
  privateConfigPath?: string;
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
  delete(context: ExecutorContext, input: InstanceDeleteInput): Promise<InstanceDeleteResult>;
};

export type DockerExecutorOptions = {
  publishHost?: string;
  imageService?: DockerImageService;
  launcherAssetsDir?: string;
  portResolutionRetryDelaysMs?: readonly number[];
};

type DockerRunOptions = Pick<DockerExecutorOptions, "publishHost" | "launcherAssetsDir"> & {
  imageReference?: string;
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

export type DockerEnvironmentTemplateImage = {
  imageId: string;
  platform: string;
  architecture: string;
  sizeBytes: number;
};

type DockerContainerMount = {
  type: "volume" | "bind";
  destination: string;
  name?: string;
  source?: string;
};

const DOCKER_BOOTSTRAP_ABI = "1";
const DOCKER_BOOTSTRAP_CONTAINER_DIR = "/run/task-handoff/bootstrap";
const DOCKER_BOOTSTRAP_ENTRYPOINT = `${DOCKER_BOOTSTRAP_CONTAINER_DIR}/entrypoint.sh`;
const DOCKER_BOOTSTRAP_EXECUTABLE = "/bin/bash";
const DOCKER_RUNTIME_INSTALLER = `${DOCKER_BOOTSTRAP_CONTAINER_DIR}/runtime-installer.mjs`;
const DOCKER_RUNTIME_ROOT = "/opt/task-handoff/instance-runtime";

function runtimeVolumeForInstance(instanceId: string, nodeId: string) {
  const containerName = containerNameForInstance(instanceId);
  return {
    role: "runtime",
    name: `${containerName}-runtime`,
    mountPath: DOCKER_RUNTIME_ROOT,
    labels: {
      "task-handoff.owner": "task-handoff",
      "task-handoff.instance-id": instanceId,
      "task-handoff.node-id": nodeId,
      "task-handoff.volume-role": "runtime",
    },
  };
}

function persistentVolumesForInstance(instanceId: string, nodeId: string, source: Project["source"]) {
  const containerName = containerNameForInstance(instanceId);
  const roles = [
    { role: "data" as const, suffix: "data", mountPath: "/data" },
    { role: "agent-home" as const, suffix: "agent-home", mountPath: "/home/agent" },
    ...(source.type === "local-folder" ? [] : [{ role: "workspace" as const, suffix: "workspace", mountPath: "/workspace" }]),
  ];
  return roles.map(({ role, suffix, mountPath }) => ({
    role,
    name: `${containerName}-${suffix}`,
    mountPath,
    labels: {
      "task-handoff.owner": "task-handoff",
      "task-handoff.instance-id": instanceId,
      "task-handoff.node-id": nodeId,
      "task-handoff.volume-role": role,
    },
  }));
}

function persistentVolumesForContext(context: ExecutorContext) {
  return persistentVolumesForInstance(context.instance.id, context.node?.id || "node_unset", context.project.source);
}

const SENSITIVE_DOCKER_CONFIG_KEYS = new Set([
  "TASK_HANDOFF_REGISTRATION_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_MODEL",
  "TASK_HANDOFF_CODEX_BASE_URL",
  "TASK_HANDOFF_CODEX_MODEL",
  "TASK_HANDOFF_CODEX_MODEL_ID",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_MODEL",
  "TASK_HANDOFF_CLAUDE_MODEL",
  "TASK_HANDOFF_CLAUDE_MODEL_ID",
]);

export function assertDockerConfigHasNoSecrets(
  input: unknown,
  secretValues: readonly string[] = [],
) {
  const root = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const config = root.Config && typeof root.Config === "object" && !Array.isArray(root.Config)
    ? root.Config as Record<string, unknown>
    : root;
  const findings = new Set<string>();
  for (const item of Array.isArray(config.Env) ? config.Env : []) {
    if (typeof item !== "string") continue;
    const separator = item.indexOf("=");
    const key = separator === -1 ? item : item.slice(0, separator);
    const value = separator === -1 ? "" : item.slice(separator + 1);
    if (SENSITIVE_DOCKER_CONFIG_KEYS.has(key)) findings.add(`Config.Env.${key}`);
    if (secretValues.some((secret) => secret && value.includes(secret))) findings.add(`Config.Env.${key || "unknown"}`);
  }
  if (config.Labels && typeof config.Labels === "object" && !Array.isArray(config.Labels)) {
    for (const [key, value] of Object.entries(config.Labels)) {
      if (SENSITIVE_DOCKER_CONFIG_KEYS.has(key) || (typeof value === "string" && secretValues.some((secret) => secret && value.includes(secret)))) {
        findings.add(`Config.Labels.${key}`);
      }
    }
  }
  if (findings.size) {
    throw Object.assign(new Error(`Docker configuration contains instance-private values in ${[...findings].sort().join(", ")}.`), {
      statusCode: 409,
      code: "ENVIRONMENT_TEMPLATE_SECRET_IN_DOCKER_CONFIG",
      findings: [...findings].sort(),
    });
  }
}

export class LocalDockerExecutor implements NodeRuntimeExecutor {
  private readonly runCommand: CommandRunner;
  private readonly publishHost: string;
  private readonly images: DockerImageService;
  private readonly launcherAssetsDir: string;
  private readonly portResolutionRetryDelaysMs: readonly number[];

  constructor(runCommand: CommandRunner = defaultCommandRunner, options: DockerExecutorOptions = {}) {
    this.runCommand = runCommand;
    this.images = options.imageService || new DockerImageService(runCommand);
    this.publishHost = options.publishHost || "127.0.0.1";
    this.launcherAssetsDir = options.launcherAssetsDir || defaultLauncherAssetsDir();
    this.portResolutionRetryDelaysMs = options.portResolutionRetryDelaysMs?.length
      ? options.portResolutionRetryDelaysMs
      : [0, 100, 250, 500, 1_000];
  }

  async start(context: ExecutorContext): Promise<ExecutorStartResult> {
    validateStartContext(context);
    const containerName = context.instance.runtime.containerName || containerNameForInstance(context.instance.id);
    const existing = await this.inspectContainerForStart(containerName);
    if (existing) {
      assertExpectedContainerId(containerName, existing.id, context.instance.runtime.containerId, "before start", "RUNTIME_EXECUTOR_FAILED");
      const owner = existing.labels["task-handoff.instance-id"];
      if (owner !== context.instance.id) {
        throw runtimeExecutorError(
          "RUNTIME_EXECUTOR_FAILED",
          `Docker container ${containerName} belongs to ${owner || "an unknown instance"}, not ${context.instance.id}.`,
        );
      }
      const bootstrapMount = existing.mounts.find((mount) => mount.type === "bind" && mount.destination === DOCKER_BOOTSTRAP_CONTAINER_DIR);
      const authoritativeBootstrap = existing.labels["task-handoff.bootstrap-abi"] === DOCKER_BOOTSTRAP_ABI
        && existing.entrypoint[0] === DOCKER_BOOTSTRAP_EXECUTABLE
        && existing.command[0] === DOCKER_BOOTSTRAP_ENTRYPOINT
        && bootstrapMount?.source
        && path.resolve(bootstrapMount.source) === path.resolve(this.launcherAssetsDir);
      if (!authoritativeBootstrap) {
        await this.createPersistentVolumes(context);
        return this.recreateWithAuthoritativeBootstrap(context, containerName, existing);
      }
      await this.createRuntimeVolume(context);
      await this.validatePersistentVolumes(context, existing.mounts);
      try {
        await this.runCommand("docker", ["start", containerName]);
      } catch (cause) {
        throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Could not start Docker container ${containerName}.`, cause);
      }
      return this.bootstrapResult(context, containerName, existing.id);
    }
    if (context.instance.environmentTemplateOrigin) {
      const inspected = await this.inspectEnvironmentTemplateImage(context.instance.environmentTemplateOrigin.imageId);
      if (inspected.imageId !== context.instance.environmentTemplateOrigin.imageId
        || inspected.platform !== context.instance.environmentTemplateOrigin.platform
        || inspected.architecture !== context.instance.environmentTemplateOrigin.architecture) {
        throw Object.assign(new Error(`Environment template image identity or platform changed for instance ${context.instance.id}.`), {
          statusCode: 409,
          code: "ENVIRONMENT_TEMPLATE_IMAGE_IDENTITY_MISMATCH",
        });
      }
    } else {
      await this.images.ensure(context.image.resolvedReference || context.image.requestedReference!);
    }
    await this.createPersistentVolumes(context);
    let runResult;
    try {
      runResult = await this.runCommand("docker", dockerRunArgs(context, containerName, {
        publishHost: this.publishHost,
        launcherAssetsDir: this.launcherAssetsDir,
      }));
    } catch (cause) {
      throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Could not create Docker container ${containerName}.`, cause);
    }
    return this.bootstrapResult(context, containerName, runResult.stdout || undefined);
  }

  private async recreateWithAuthoritativeBootstrap(
    context: ExecutorContext,
    containerName: string,
    existing: { id: string; image?: string; running: boolean },
  ): Promise<ExecutorStartResult> {
    const backupName = `${containerName}-pre-bootstrap-${existing.id.slice(0, 12)}`;
    if (existing.running) await this.runCommand("docker", ["stop", containerName]);
    try {
      await this.runCommand("docker", ["rename", containerName, backupName]);
    } catch (cause) {
      if (existing.running) await this.runCommand("docker", ["start", containerName]).catch(() => ({ stdout: "", stderr: "" }));
      throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Could not preserve Docker container ${containerName} before bootstrap migration.`, cause);
    }
    try {
      const result = await this.runCommand("docker", dockerRunArgs(context, containerName, {
        publishHost: this.publishHost,
        launcherAssetsDir: this.launcherAssetsDir,
        imageReference: existing.image,
      }));
      return this.bootstrapResult(context, containerName, result.stdout || undefined, backupName);
    } catch (cause) {
      await this.runCommand("docker", ["rm", "-f", containerName]).catch(() => ({ stdout: "", stderr: "" }));
      await this.runCommand("docker", ["rename", backupName, containerName]).catch(() => ({ stdout: "", stderr: "" }));
      if (existing.running) await this.runCommand("docker", ["start", containerName]).catch(() => ({ stdout: "", stderr: "" }));
      throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Could not recreate Docker container ${containerName} with the node-agent bootstrap.`, cause);
    }
  }

  async inspectContainerConfigSecurity(containerName: string, secretValues: readonly string[]) {
    const inspected = await this.runCommand("docker", ["inspect", "--format", "{{json .}}", containerName])
      .then((result) => JSON.parse(result.stdout || "{}"))
      .catch((cause) => {
        throw runtimeExecutorError("ENVIRONMENT_TEMPLATE_CONTAINER_INSPECT_FAILED", `Could not inspect Docker container ${containerName}.`, cause);
      });
    assertDockerConfigHasNoSecrets(inspected, secretValues);
  }

  async inspectImageConfigSecurity(imageReference: string, secretValues: readonly string[]) {
    const inspected = await this.runCommand("docker", ["image", "inspect", "--format", "{{json .}}", imageReference])
      .then((result) => JSON.parse(result.stdout || "{}"))
      .catch((cause) => {
        throw runtimeExecutorError("ENVIRONMENT_TEMPLATE_IMAGE_INSPECT_FAILED", `Could not inspect Docker image configuration.`, cause);
      });
    assertDockerConfigHasNoSecrets(inspected, secretValues);
  }

  async commitEnvironmentTemplate(containerName: string, expectedContainerId: string | undefined, internalTag: string) {
    const currentId = await this.inspectContainerId(containerName);
    if (!currentId) throw runtimeExecutorError("ENVIRONMENT_TEMPLATE_CONTAINER_NOT_FOUND", `Docker container ${containerName} does not exist.`);
    assertExpectedContainerId(containerName, currentId, expectedContainerId, "before environment template commit", "ENVIRONMENT_TEMPLATE_CONTAINER_IDENTITY_MISMATCH");
    try {
      const result = await this.runCommand("docker", ["commit", containerName, internalTag]);
      const imageId = result.stdout.trim();
      if (!imageId) throw new Error("Docker commit did not return an image id.");
      return imageId;
    } catch (cause) {
      throw runtimeExecutorError("ENVIRONMENT_TEMPLATE_COMMIT_FAILED", `Could not save Docker container ${containerName} as an environment template.`, cause);
    }
  }

  async inspectEnvironmentTemplateImage(imageReference: string): Promise<DockerEnvironmentTemplateImage> {
    try {
      const result = await this.runCommand("docker", ["image", "inspect", "--format", "{{json .}}", imageReference]);
      const parsed = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
      const imageId = typeof parsed.Id === "string" ? parsed.Id : "";
      const platform = normalizeDockerPlatform(parsed.Os);
      const architecture = normalizeDockerArchitecture(parsed.Architecture);
      const sizeBytes = typeof parsed.Size === "number" ? parsed.Size : Number.NaN;
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || !platform || !architecture || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error("Docker image inspection did not return a valid immutable identity.");
      }
      return { imageId, platform, architecture, sizeBytes };
    } catch (cause) {
      throw runtimeExecutorError("ENVIRONMENT_TEMPLATE_IMAGE_INSPECT_FAILED", "Could not inspect the committed environment template image.", cause);
    }
  }

  async untagEnvironmentTemplate(internalTag: string, knownImageId?: string) {
    try {
      const imageId = knownImageId || (await this.inspectEnvironmentTemplateImage(internalTag)).imageId;
      await this.runCommand("docker", ["tag", imageId, environmentTemplateRetentionTag(imageId)]);
      await this.runCommand("docker", ["image", "rm", internalTag]);
      return imageId;
    } catch (cause) {
      const detail = commandFailureDetail(cause)?.toLowerCase() || "";
      if (detail.includes("no such image") || detail.includes("no such object")) return undefined;
      throw runtimeExecutorError("ENVIRONMENT_TEMPLATE_UNTAG_FAILED", "Could not remove the environment template tag.", cause);
    }
  }

  async garbageCollectEnvironmentTemplateImage(imageId: string) {
    try {
      try {
        await this.runCommand("docker", ["image", "rm", environmentTemplateRetentionTag(imageId)]);
      } catch (cause) {
        const detail = commandFailureDetail(cause)?.toLowerCase() || "";
        if (detail.includes("being used by") || detail.includes("is referenced") || detail.includes("conflict")) return false;
        if (!detail.includes("no such image") && !detail.includes("no such object")) throw cause;
      }
      await this.runCommand("docker", ["image", "rm", imageId]);
      return true;
    } catch (cause) {
      const detail = commandFailureDetail(cause)?.toLowerCase() || "";
      if (detail.includes("being used by") || detail.includes("is referenced") || detail.includes("conflict")) return false;
      if (detail.includes("no such image") || detail.includes("no such object")) return true;
      throw runtimeExecutorError("ENVIRONMENT_TEMPLATE_GC_FAILED", "Could not garbage collect the environment template image.", cause);
    }
  }

  private async createPersistentVolumes(context: ExecutorContext) {
    const runtimeVolume = runtimeVolumeForInstance(context.instance.id, context.node?.id || "node_unset");
    for (const volume of [...persistentVolumesForContext(context), runtimeVolume]) {
      await this.createVolume(volume);
      await this.validateOwnedVolume(context.instance.id, volume);
    }
  }

  private async createRuntimeVolume(context: ExecutorContext) {
    await this.createVolume(runtimeVolumeForInstance(context.instance.id, context.node?.id || "node_unset"));
  }

  private async createVolume(volume: { name: string; labels: Record<string, string> }) {
    const args = ["volume", "create"];
    for (const [key, value] of Object.entries(volume.labels).sort(([left], [right]) => left.localeCompare(right))) {
      args.push("--label", `${key}=${value}`);
    }
    args.push(volume.name);
    try {
      await this.runCommand("docker", args);
    } catch (cause) {
      throw runtimeExecutorError("INSTANCE_VOLUME_CREATE_FAILED", `Could not create managed volume ${volume.name}.`, cause);
    }
  }

  private async validatePersistentVolumes(context: ExecutorContext, mounts: DockerContainerMount[]) {
    for (const volume of persistentVolumesForContext(context)) {
      await this.validateOwnedVolume(context.instance.id, volume);
      const mount = mounts.find((item) => item.type === "volume" && item.destination === volume.mountPath);
      if (!mount || mount.name !== volume.name) {
        throw Object.assign(new Error(`Docker container mount for ${volume.role} does not match managed volume ${volume.name}.`), {
          statusCode: 409,
          code: "INSTANCE_VOLUME_MOUNT_IDENTITY_MISMATCH",
        });
      }
    }
    const runtimeVolume = runtimeVolumeForInstance(context.instance.id, context.node?.id || "node_unset");
    await this.validateOwnedVolume(context.instance.id, runtimeVolume);
    const runtimeMount = mounts.find((item) => item.type === "volume" && item.destination === runtimeVolume.mountPath);
    if (!runtimeMount || runtimeMount.name !== runtimeVolume.name) {
      throw Object.assign(new Error(`Docker container runtime mount does not match ${runtimeVolume.name}.`), {
        statusCode: 409,
        code: "INSTANCE_VOLUME_MOUNT_IDENTITY_MISMATCH",
      });
    }
    if (context.project.source.type === "local-folder") {
      const workspace = mounts.find((item) => item.destination === (context.project.workspacePolicy.path || "/workspace"));
      if (!workspace || workspace.type !== "bind" || path.resolve(workspace.source || "") !== path.resolve(context.project.source.path)) {
        throw Object.assign(new Error(`Docker container workspace bind does not match local folder ${context.project.source.path}.`), {
          statusCode: 409,
          code: "INSTANCE_WORKSPACE_MOUNT_IDENTITY_MISMATCH",
        });
      }
    }
  }

  private async validateOwnedVolume(instanceId: string, expected: { role: string; name: string; mountPath: string; labels: Record<string, string> }) {
    let result;
    try {
      result = await this.runCommand("docker", ["volume", "inspect", "--format", "{{json .}}", expected.name]);
    } catch (cause) {
      throw runtimeExecutorError("INSTANCE_VOLUME_INSPECT_FAILED", `Could not inspect managed volume ${expected.name}.`, cause);
    }
    try {
      const inspected = JSON.parse(result.stdout || "{}") as { Name?: unknown; Labels?: unknown };
      const labels = inspected.Labels && typeof inspected.Labels === "object" && !Array.isArray(inspected.Labels)
        ? inspected.Labels as Record<string, unknown>
        : {};
      if (inspected.Name !== expected.name
        || labels["task-handoff.owner"] !== "task-handoff"
        || labels["task-handoff.instance-id"] !== instanceId
        || labels["task-handoff.volume-role"] !== expected.role) {
        throw new Error("volume name or ownership labels do not match");
      }
    } catch (cause) {
      throw Object.assign(new Error(`Managed volume ${expected.name} identity does not match instance ${instanceId}.`, { cause }), {
        statusCode: 409,
        code: "INSTANCE_VOLUME_IDENTITY_MISMATCH",
      });
    }
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

  private bootstrapResult(context: ExecutorContext, containerName: string, containerId?: string, backupName?: string): ExecutorStartResult {
    return {
      status: "starting",
      health: "unknown",
      connectionStatus: "unknown",
      agentStatus: "unknown",
      targetStatus: "unknown",
      uiAccessStatus: "unknown",
      target: { strategy: "direct-port", status: "unknown" },
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
          "task-handoff.bootstrap-abi": DOCKER_BOOTSTRAP_ABI,
          ...(backupName ? { "task-handoff.bootstrap-backup": backupName } : {}),
        },
      },
    };
  }

  async stop(context: ExecutorContext): Promise<ExecutorStartResult> {
    const containerName = context.instance.runtime.containerName || containerNameForInstance(context.instance.id);
    try {
      await this.runCommand("docker", ["stop", containerName]);
    } catch (cause) {
      if (!isDockerContainerNotFound(cause)) {
        throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Could not stop Docker container ${containerName}.`, cause);
      }
    }
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

  async delete(context: ExecutorContext, input: InstanceDeleteInput): Promise<InstanceDeleteResult> {
    const containerName = context.instance.runtime.containerName || containerNameForInstance(context.instance.id);
    try {
      await this.runCommand("docker", ["rm", "-f", containerName]);
    } catch (cause) {
      if (!isDockerContainerNotFound(cause)) {
        throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Could not delete Docker container ${containerName}.`, cause);
      }
    }
    const volumeResults = [];
    for (const volume of persistentVolumesForContext(context)) {
      if (!input.deleteVolumes) {
        volumeResults.push({ role: volume.role, name: volume.name, mountPath: volume.mountPath, status: "retained" as const });
        continue;
      }
      try {
        const inspected = await this.inspectVolumeForDelete(volume.name);
        if (!inspected) {
          volumeResults.push({ role: volume.role, name: volume.name, mountPath: volume.mountPath, status: "missing" as const });
          continue;
        }
        if (inspected.name !== volume.name
          || inspected.labels["task-handoff.owner"] !== "task-handoff"
          || inspected.labels["task-handoff.instance-id"] !== context.instance.id
          || inspected.labels["task-handoff.volume-role"] !== volume.role) {
          throw Object.assign(new Error(`Managed volume ${volume.name} ownership does not match instance ${context.instance.id}.`), {
            code: "INSTANCE_VOLUME_IDENTITY_MISMATCH",
          });
        }
        await this.runCommand("docker", ["volume", "rm", volume.name]);
        volumeResults.push({ role: volume.role, name: volume.name, mountPath: volume.mountPath, status: "deleted" as const });
      } catch (error) {
        volumeResults.push({
          role: volume.role,
          name: volume.name,
          mountPath: volume.mountPath,
          status: "failed" as const,
          error: {
            code: typeof error === "object" && error && "code" in error && typeof error.code === "string" ? error.code : "INSTANCE_VOLUME_DELETE_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    await this.deleteRuntimeVolume(context);
    return InstanceDeleteResultSchema.parse({
      instanceId: context.instance.id,
      containerDeleted: true,
      completed: volumeResults.every((result) => result.status !== "failed"),
      deletedVolumes: volumeResults.filter((result) => result.status === "deleted" || result.status === "missing"),
      retainedVolumes: volumeResults.filter((result) => result.status === "retained"),
      volumeResults,
    });
  }

  private async deleteRuntimeVolume(context: ExecutorContext) {
    const volume = runtimeVolumeForInstance(context.instance.id, context.node?.id || "node_unset");
    const inspected = await this.inspectVolumeForDelete(volume.name);
    if (!inspected) return;
    if (inspected.name !== volume.name
      || inspected.labels["task-handoff.owner"] !== "task-handoff"
      || inspected.labels["task-handoff.instance-id"] !== context.instance.id
      || inspected.labels["task-handoff.volume-role"] !== "runtime") {
      throw runtimeExecutorError("INSTANCE_VOLUME_IDENTITY_MISMATCH", `Runtime volume ${volume.name} ownership does not match instance ${context.instance.id}.`);
    }
    try {
      await this.runCommand("docker", ["volume", "rm", volume.name]);
    } catch (cause) {
      throw runtimeExecutorError("INSTANCE_VOLUME_DELETE_FAILED", `Could not delete runtime volume ${volume.name}.`, cause);
    }
  }

  private async inspectVolumeForDelete(name: string) {
    try {
      const result = await this.runCommand("docker", ["volume", "inspect", "--format", "{{json .}}", name]);
      const parsed = JSON.parse(result.stdout || "{}") as { Name?: unknown; Labels?: unknown };
      return {
        name: typeof parsed.Name === "string" ? parsed.Name : "",
        labels: parsed.Labels && typeof parsed.Labels === "object" && !Array.isArray(parsed.Labels)
          ? Object.fromEntries(Object.entries(parsed.Labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
          : {},
      };
    } catch (cause) {
      if (isDockerVolumeNotFound(cause)) return undefined;
      throw runtimeExecutorError("INSTANCE_VOLUME_INSPECT_FAILED", `Could not inspect managed volume ${name}.`, cause);
    }
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
        "node",
        DOCKER_RUNTIME_INSTALLER,
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
      "node",
      DOCKER_RUNTIME_INSTALLER,
      "verify-active",
    ]).catch(() => undefined);
    if (!result?.stdout) return { containerId };
    try {
      const parsed = safeParseResponse(RuntimeArtifactIdentitySchema, JSON.parse(result.stdout));
      return parsed.success ? { containerId, ...parsed.data } : { containerId };
    } catch {
      return { containerId };
    }
  }

  async removeBootstrapBackup(backupName: string, instanceId: string): Promise<void> {
    const inspected = await this.inspectContainerForStart(backupName);
    if (!inspected) return;
    if (inspected.labels["task-handoff.instance-id"] !== instanceId) {
      throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Docker bootstrap backup ${backupName} does not belong to ${instanceId}.`);
    }
    await this.runCommand("docker", ["rm", "-f", backupName]);
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

  /** Verifies the launcher bundle mounted from this node-agent and prepares its persistent runtime root. */
  async installRuntimeLauncher(containerName: string): Promise<void> {
    const containerId = await this.inspectContainerId(containerName);
    if (!containerId) throw runtimeExecutorError("INSTANCE_BASE_RUNTIME_INCOMPATIBLE", `Docker container ${containerName} does not exist.`);
    try {
      await this.runCommand("docker", [
        "exec",
        "--user",
        "0",
        containerName,
        "bash",
        "-ceu",
        `test -r ${DOCKER_BOOTSTRAP_ENTRYPOINT}; test -r ${DOCKER_BOOTSTRAP_CONTAINER_DIR}/instance-launcher.sh; test -r ${DOCKER_RUNTIME_INSTALLER}; install -d -o root -g root -m 0755 /opt/task-handoff/instance-runtime /opt/task-handoff/instance-runtime/releases /opt/task-handoff/instance-runtime/staging /opt/task-handoff/instance-runtime/incoming; chown -R root:root /opt/task-handoff/instance-runtime; chmod -R go-w /opt/task-handoff/instance-runtime`,
      ]);
    } catch (cause) {
      throw runtimeExecutorError("INSTANCE_BASE_RUNTIME_INCOMPATIBLE", `Could not install the runtime launcher in ${containerName}.`, cause);
    }
    const after = await this.inspectContainerId(containerName);
    if (after !== containerId) throw runtimeExecutorError("INSTANCE_BASE_RUNTIME_INCOMPATIBLE", `Docker container identity changed while installing the runtime launcher in ${containerName}.`);
  }

  private async inspectContainerId(containerName: string) {
    try {
      const result = await this.runCommand("docker", ["inspect", "--format", "{{.Id}}", containerName]);
      return result.stdout.trim() || undefined;
    } catch (cause) {
      if (isDockerContainerNotFound(cause)) return undefined;
      throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Could not inspect Docker container ${containerName}.`, cause);
    }
  }

  private async inspectContainerForStart(containerName: string): Promise<{ id: string; image?: string; running: boolean; entrypoint: string[]; command: string[]; labels: Record<string, string>; mounts: DockerContainerMount[] } | undefined> {
    let result;
    try {
      result = await this.runCommand("docker", ["inspect", "--format", "{{json .}}", containerName]);
    } catch (cause) {
      if (isDockerContainerNotFound(cause)) return undefined;
      throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Could not inspect Docker container ${containerName}.`, cause);
    }
    try {
      const parsed = JSON.parse(result.stdout || "{}") as { Id?: unknown; Image?: unknown; State?: { Running?: unknown }; Config?: { Entrypoint?: unknown; Cmd?: unknown; Labels?: unknown }; Mounts?: unknown };
      if (typeof parsed.Id !== "string" || !parsed.Id) throw new Error("Docker inspect did not return a container id.");
      const labels = parsed.Config?.Labels && typeof parsed.Config.Labels === "object" && !Array.isArray(parsed.Config.Labels)
        ? Object.fromEntries(Object.entries(parsed.Config.Labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : {};
      const mounts: DockerContainerMount[] = Array.isArray(parsed.Mounts) ? parsed.Mounts.flatMap((mount): DockerContainerMount[] => {
        if (!mount || typeof mount !== "object" || Array.isArray(mount)) return [];
        const value = mount as Record<string, unknown>;
        const type = value.Type === "volume" || value.Type === "bind" ? value.Type : undefined;
        const destination = typeof value.Destination === "string" ? value.Destination : undefined;
        if (!type || !destination) return [];
        return [{
          type,
          destination,
          name: typeof value.Name === "string" ? value.Name : undefined,
          source: typeof value.Source === "string" ? value.Source : undefined,
        }];
      }) : [];
      const entrypoint = Array.isArray(parsed.Config?.Entrypoint)
        ? parsed.Config.Entrypoint.filter((item): item is string => typeof item === "string")
        : typeof parsed.Config?.Entrypoint === "string" ? [parsed.Config.Entrypoint] : [];
      const command = Array.isArray(parsed.Config?.Cmd)
        ? parsed.Config.Cmd.filter((item): item is string => typeof item === "string")
        : typeof parsed.Config?.Cmd === "string" ? [parsed.Config.Cmd] : [];
      return { id: parsed.Id, image: typeof parsed.Image === "string" ? parsed.Image : undefined, running: parsed.State?.Running === true, entrypoint, command, labels, mounts };
    } catch (cause) {
      throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Docker returned invalid inspection data for ${containerName}.`, cause);
    }
  }

  private async containerPort(containerName: string, containerPort: string) {
    let lastCause: unknown;
    let inspectedNetworkState = false;
    for (const delayMs of this.portResolutionRetryDelaysMs) {
      if (delayMs > 0) await delay(delayMs);
      try {
        const result = await this.runCommand("docker", ["port", containerName, containerPort]);
        const published = publishedPortFromDockerPortOutput(result.stdout);
        if (published) return published;
      } catch (cause) {
        lastCause = cause;
      }
      try {
        const result = await this.runCommand("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", containerName]);
        const published = publishedPortFromNetworkSettings(result.stdout, containerPort);
        inspectedNetworkState = true;
        if (published) return published;
      } catch (cause) {
        lastCause = cause;
      }
    }
    if (inspectedNetworkState) {
      throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Docker container ${containerName} does not publish ${containerPort}.`);
    }
    throw runtimeExecutorError("RUNTIME_EXECUTOR_FAILED", `Could not resolve the published port for Docker container ${containerName}.`, lastCause);
  }

}

function publishedPortFromDockerPortOutput(stdout: string) {
  const line = stdout.split(/\r?\n/).find(Boolean);
  return line?.match(/:(\d+)$/)?.[1];
}

function publishedPortFromNetworkSettings(stdout: string, containerPort: string) {
  const parsed = JSON.parse(stdout || "null") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const bindings = (parsed as Record<string, unknown>)[containerPort];
  if (!Array.isArray(bindings)) return undefined;
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
    const hostPort = (binding as Record<string, unknown>).HostPort;
    if (typeof hostPort === "string" && /^\d+$/.test(hostPort)) return hostPort;
  }
  return undefined;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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

function environmentTemplateRetentionTag(imageId: string) {
  return `task-handoff/environment-image:${imageId.replace(/^sha256:/, "")}`;
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

function isDockerContainerNotFound(cause: unknown) {
  const detail = commandFailureDetail(cause)?.toLowerCase() || "";
  return detail.includes("no such container") || detail.includes("no such object");
}

function isDockerVolumeNotFound(cause: unknown) {
  const detail = commandFailureDetail(cause)?.toLowerCase() || "";
  return detail.includes("no such volume") || detail.includes("no such object");
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

function appendDockerEnv(args: string[], key: string, value: string) {
  args.push("-e", `${key}=${value}`);
}

export function dockerRunArgs(context: ExecutorContext, containerName: string, options: DockerRunOptions = {}) {
  const publishHost = options.publishHost || "127.0.0.1";
  const launcherAssetsDir = path.resolve(options.launcherAssetsDir || defaultLauncherAssetsDir());
  const nodeId = context.node?.id || "node_unset";
  const runtimeId = context.runtime?.id || "runtime_local_docker";
  const args = [
    "run",
    "-d",
    "--name",
    containerName,
    "--user",
    "0:0",
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
    "--label",
    `task-handoff.bootstrap-abi=${DOCKER_BOOTSTRAP_ABI}`,
    "--shm-size",
    "1gb",
    "--security-opt",
    "seccomp=unconfined",
    "--network",
    "bridge",
    "--no-healthcheck",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--tmpfs",
    "/tmp:rw,mode=1777",
    "-p",
    `${publishHost}::8080`,
  ];

  if (!context.privateConfigPath) {
    throw Object.assign(new Error(`Instance ${context.instance.id} private config was not materialized.`), {
      statusCode: 409,
      code: "INSTANCE_PRIVATE_CONFIG_MISSING",
    });
  }
  args.push(
    "--mount",
    `type=bind,src=${context.privateConfigPath},dst=/run/task-handoff/instance-private-config.json,readonly`,
    "--mount",
    `type=bind,src=${launcherAssetsDir},dst=${DOCKER_BOOTSTRAP_CONTAINER_DIR},readonly`,
    "--entrypoint",
    DOCKER_BOOTSTRAP_EXECUTABLE,
  );

  for (const volume of persistentVolumesForContext(context)) {
    args.push("--mount", `type=volume,src=${volume.name},dst=${volume.mountPath}`);
  }
  const runtimeVolume = runtimeVolumeForInstance(context.instance.id, context.node?.id || "node_unset");
  args.push("--mount", `type=volume,src=${runtimeVolume.name},dst=${runtimeVolume.mountPath}`);

  const runtimeEnv = {
    TASK_HANDOFF_CONTROL_MODE: "controlled",
    TASK_HANDOFF_NODE_AGENT_URL: context.nodeAgentUrl || context.node?.endpoint || "",
    TASK_HANDOFF_INSTANCE_ID: context.instance.id,
    TASK_HANDOFF_INSTANCE_NAME: context.instance.name,
    TASK_HANDOFF_PROJECT_ID: context.project.id,
    TASK_HANDOFF_NODE_ID: nodeId,
    TASK_HANDOFF_RUNTIME_ID: runtimeId,
    TASK_HANDOFF_IMAGE_ID: context.image.id,
    TASK_HANDOFF_INSTANCE_LAUNCHER: `${DOCKER_BOOTSTRAP_CONTAINER_DIR}/instance-launcher.sh`,
    ...(context.image.tag ? { TASK_HANDOFF_IMAGE_TAG: context.image.tag } : {}),
    TASK_HANDOFF_CHAT_BRIDGES: "none",
    TASK_HANDOFF_WORKSPACE: context.project.workspacePolicy.path || "/workspace",
    TASK_HANDOFF_WORKSPACE_MODE: context.project.workspacePolicy.mode,
  };
  for (const [key, value] of Object.entries(runtimeEnv)) appendDockerEnv(args, key, value);

  if (context.project.source.type === "local-folder") {
    args.push("-v", `${context.project.source.path}:${context.project.workspacePolicy.path || "/workspace"}:${context.project.workspacePolicy.readOnly ? "ro" : "rw"}`);
  } else {
    appendDockerEnv(args, "TASK_HANDOFF_PROJECT_SOURCE", JSON.stringify(context.project.source));
    appendDockerEnv(args, "TASK_HANDOFF_WORKSPACE_POLICY", JSON.stringify(context.project.workspacePolicy));
    appendDockerEnv(args, "TASK_HANDOFF_GIT_URL", context.project.source.url);
    if (context.project.source.ref?.commit) {
      appendDockerEnv(args, "TASK_HANDOFF_GIT_COMMIT", context.project.source.ref.commit);
    } else if (context.project.source.ref?.name) {
      appendDockerEnv(args, "TASK_HANDOFF_GIT_REF", context.project.source.ref.name);
    }
    if (context.project.source.clone?.depth) {
      appendDockerEnv(args, "TASK_HANDOFF_GIT_DEPTH", String(context.project.source.clone.depth));
    }
    appendDockerEnv(args, "TASK_HANDOFF_GIT_SUBMODULES", context.project.source.clone?.submodules ? "true" : "false");
    appendDockerEnv(args, "TASK_HANDOFF_GIT_LFS", context.project.source.clone?.lfs ? "true" : "false");
    if (context.project.source.clone?.subdirectory) {
      appendDockerEnv(args, "TASK_HANDOFF_WORKSPACE_SUBDIRECTORY", context.project.source.clone.subdirectory);
    }
  }

  for (const [key, value] of Object.entries(context.image.defaultEnv)) {
    appendDockerEnv(args, key, value);
  }

  args.push(
    options.imageReference || context.instance.environmentTemplateOrigin?.imageId || context.image.resolvedReference || context.image.requestedReference!,
    DOCKER_BOOTSTRAP_ENTRYPOINT,
    "task-handoff",
    "web",
  );
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
