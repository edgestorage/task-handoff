import { spawn } from "node:child_process";
import type { ControlledInstance, ImageProfile, LocalDockerImage, Node, NodeRuntime, Project } from "@task-handoff/protocol/control-plane";

export type ExecutorContext = {
  project: Project;
  image: ImageProfile;
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

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
export type DockerExecutorOptions = {
  publishHost?: string;
};

export function defaultCommandRunner(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const error = new Error(result.stderr || `${command} exited with code ${code}`);
      Object.assign(error, { statusCode: 502, code: "RUNTIME_EXECUTOR_FAILED", details: result });
      reject(error);
    });
  });
}

export class LocalDockerExecutor implements NodeRuntimeExecutor {
  private readonly runCommand: CommandRunner;
  private readonly publishHost: string;

  constructor(runCommand: CommandRunner = defaultCommandRunner, options: DockerExecutorOptions = {}) {
    this.runCommand = runCommand;
    this.publishHost = options.publishHost || "127.0.0.1";
  }

  async start(context: ExecutorContext): Promise<ExecutorStartResult> {
    validateStartContext(context);
    const containerName = context.instance.runtime.containerName || containerNameForInstance(context.instance.id);
    const existing = await this.runCommand("docker", ["start", containerName]).catch(() => undefined);
    if (existing) {
      return this.runningResult(context, containerName, context.instance.runtime.containerId);
    }
    await this.ensureImageAvailable(context.image);
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

  async restart(context: ExecutorContext): Promise<ExecutorStartResult> {
    validateStartContext(context);
    const containerName = context.instance.runtime.containerName || containerNameForInstance(context.instance.id);
    await this.runCommand("docker", ["restart", containerName]);
    return this.runningResult(context, containerName, context.instance.runtime.containerId);
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

  private async containerPort(containerName: string, containerPort: string) {
    const result = await this.runCommand("docker", ["port", containerName, containerPort]).catch(() => ({ stdout: "", stderr: "" }));
    const line = result.stdout.split(/\r?\n/).find(Boolean);
    const match = line?.match(/:(\d+)$/);
    return match?.[1];
  }

  private async ensureImageAvailable(image: ImageProfile) {
    const inspected = await this.runCommand("docker", ["image", "inspect", image.image]).then(
      () => true,
      () => false,
    );
    if (inspected) {
      return;
    }
    if (image.registry === "local") {
      const error = new Error(`Local Docker image ${image.image} was not found. Build it or add an existing local image before starting an instance.`);
      Object.assign(error, { statusCode: 400, code: "LOCAL_IMAGE_NOT_FOUND" });
      throw error;
    }
    await this.runCommand("docker", ["pull", image.image]);
  }
}

export async function listLocalDockerImages(runCommand: CommandRunner = defaultCommandRunner): Promise<LocalDockerImage[]> {
  const result = await runCommand("docker", ["images", "--format", "{{json .}}"]);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const record = JSON.parse(line) as Record<string, string>;
      const repository = record.Repository || "<none>";
      const tag = record.Tag || "<none>";
      const id = record.ID || record.IDShort || "";
      const reference = repository !== "<none>" && tag !== "<none>" ? `${repository}:${tag}` : id;
      return {
        repository,
        tag,
        id,
        createdSince: record.CreatedSince,
        size: record.Size,
        reference,
      };
    })
    .filter((image) => Boolean(image.reference));
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

  args.push(context.image.image);
  return args;
}

export function validateStartContext(context: ExecutorContext) {
  if (context.project.source.type === "local-folder" && context.project.source.ownerNodeId && context.project.source.ownerNodeId !== context.node.id) {
    const error = new Error("Local folder projects can only start on the node that owns the folder.");
    Object.assign(error, { statusCode: 400, code: "LOCAL_FOLDER_REQUIRES_OWNER_NODE" });
    throw error;
  }
  if (!context.image.image.trim()) {
    const error = new Error("Image profile must reference a registered image.");
    Object.assign(error, { statusCode: 400, code: "IMAGE_PROFILE_INVALID" });
    throw error;
  }
}
