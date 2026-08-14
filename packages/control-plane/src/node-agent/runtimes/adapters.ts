import type {
  InstanceDeleteInput,
  InstanceDeleteResult,
  NodeRuntime,
  RuntimeArtifactIdentity,
} from "@task-handoff/protocol/control-plane";
import type { ResolvedRuntimeArtifact } from "../runtime-artifacts.ts";
import {
  LocalDockerExecutor,
  type CommandRunner,
  type ExecutorContext,
  type ExecutorStartResult,
} from "./docker.ts";

const FINAL_COMPUTER_PLATFORMS = new Set([
  "linux",
  "darwin",
  "win32",
  "freebsd",
  "openbsd",
  "aix",
  "sunos",
]);

export function finalComputerPlatform(platform: string) {
  return FINAL_COMPUTER_PLATFORMS.has(platform) ? platform : "unknown";
}

export type RuntimeAdapter = {
  start(context: ExecutorContext): Promise<ExecutorStartResult>;
  stop(context: ExecutorContext): Promise<ExecutorStartResult>;
  restart(context: ExecutorContext): Promise<ExecutorStartResult>;
  delete(context: ExecutorContext, input: InstanceDeleteInput): Promise<InstanceDeleteResult>;
  managedArtifacts?: boolean;
  check?(runtime: NodeRuntime): Promise<Partial<NodeRuntime>>;
  stopAll?(): Promise<void>;
};

export type ManagedRuntimeAdapter = RuntimeAdapter & {
  managedArtifacts: true;
  artifactTarget(context?: ExecutorContext): Promise<{ platform: string; arch: string; launcherAbi: number }>;
  installRuntime(context: ExecutorContext, artifact: ResolvedRuntimeArtifact): Promise<void>;
  inspectRuntime(context: ExecutorContext, expected: RuntimeArtifactIdentity): Promise<boolean>;
};

export function isManagedRuntimeAdapter(adapter: RuntimeAdapter): adapter is ManagedRuntimeAdapter {
  return adapter.managedArtifacts === true;
}

function artifactIdentityMatches(actual: Partial<RuntimeArtifactIdentity>, expected: RuntimeArtifactIdentity) {
  return actual.packageName === expected.packageName
    && actual.version === expected.version
    && actual.platform === expected.platform
    && actual.arch === expected.arch
    && actual.formatVersion === expected.formatVersion
    && actual.launcherAbi === expected.launcherAbi
    && actual.entrypoint === expected.entrypoint
    && actual.sha256 === expected.sha256;
}

export class DockerRuntimeAdapter implements RuntimeAdapter {
  readonly managedArtifacts = true as const;
  private readonly executor: LocalDockerExecutor;
  private readonly runCommand: CommandRunner;
  private readonly platform: string;
  private readonly arch: string;

  constructor(
    executor: LocalDockerExecutor,
    runCommand: CommandRunner,
    platform: string,
    arch: string,
  ) {
    this.executor = executor;
    this.runCommand = runCommand;
    this.platform = platform;
    this.arch = arch;
  }

  artifactTarget(context?: ExecutorContext) {
    return this.executor.inspectRuntimeTarget(context?.instance.runtime.containerName);
  }

  async installRuntime(context: ExecutorContext, artifact: ResolvedRuntimeArtifact) {
    const containerName = context.instance.runtime.containerName;
    if (!containerName) {
      throw Object.assign(
        new Error(`Instance ${context.instance.id} does not have a Docker container.`),
        { code: "INSTANCE_RUNTIME_INSTALL_FAILED" },
      );
    }
    await this.executor.installRuntimeReleaseWithRecovery({
      containerName,
      expectedContainerId: context.instance.runtime.containerId,
      artifactPath: artifact.archivePath,
      identity: artifact.identity,
    });
  }

  async inspectRuntime(context: ExecutorContext, expected: RuntimeArtifactIdentity) {
    const containerName = context.instance.runtime.containerName;
    if (!containerName) return false;
    const matches = artifactIdentityMatches(await this.executor.inspectRuntimeVersion(containerName), expected);
    const backupName = context.instance.runtime.labels["task-handoff.bootstrap-backup"];
    if (matches && backupName) await this.executor.removeBootstrapBackup(backupName, context.instance.id);
    return matches;
  }

  start(context: ExecutorContext) {
    return this.executor.start(context);
  }

  stop(context: ExecutorContext) {
    return this.executor.stop(context);
  }

  restart(context: ExecutorContext) {
    return this.executor.restart(context, context.instance.runtime.containerId);
  }

  delete(context: ExecutorContext, input: InstanceDeleteInput) {
    return this.executor.delete(context, input);
  }

  async check(runtime: NodeRuntime): Promise<Partial<NodeRuntime>> {
    try {
      const result = await this.runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 5_000 });
      const serverVersion = result.stdout.trim();
      return {
        status: "online",
        capabilities: {
          ...runtime.capabilities,
          daemon: {
            status: "online",
            hostPlatform: finalComputerPlatform(this.platform),
            ...(serverVersion ? { serverVersion } : {}),
          },
        },
      };
    } catch (error) {
      return {
        status: "offline",
        capabilities: {
          ...runtime.capabilities,
          daemon: {
            status: "offline",
            hostPlatform: finalComputerPlatform(this.platform),
            error: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }
}

export class RuntimeAdapterRegistry {
  private readonly docker: RuntimeAdapter;
  private readonly local: RuntimeAdapter;

  constructor(
    docker: RuntimeAdapter,
    local: RuntimeAdapter,
  ) {
    this.docker = docker;
    this.local = local;
  }

  forRuntime(runtime: NodeRuntime) {
    if (runtime.type === "docker") return this.docker;
    if (runtime.type === "local") return this.local;
    throw Object.assign(
      new Error(`Runtime type ${runtime.type} is not supported by this node agent.`),
      { statusCode: 400, code: "NODE_RUNTIME_TYPE_UNSUPPORTED" },
    );
  }

  managedAdapters() {
    return [this.docker, this.local].filter(isManagedRuntimeAdapter);
  }

  async stopAll() {
    await this.local.stopAll?.();
  }
}
