import type { NodeRuntime, RuntimeArtifactIdentity } from "@task-handoff/protocol/control-plane";
import type { ResolvedRuntimeArtifact } from "../runtime-artifacts.ts";
import { LocalDockerExecutor, type CommandRunner } from "./docker.ts";
import { normalizeRuntimeCapabilities } from "../runtime-capabilities.ts";
import {
  finalComputerPlatform,
  isManagedRuntimeAdapter,
  type ExecutorContext,
  type InstanceDeleteInput,
  type InstanceDeleteResult,
  type ManagedRuntimeAdapter,
  type RuntimeAdapter,
  type RuntimeLiveness,
} from "./contracts.ts";

// 共享契约定义在 ./contracts.ts；这里保留同名 re-export，既有调用点无需改动。
export { finalComputerPlatform, isManagedRuntimeAdapter } from "./contracts.ts";
export type {
  ExecutorContext,
  ExecutorStartResult,
  ManagedRuntimeAdapter,
  RuntimeAdapter,
  RuntimeLiveness,
} from "./contracts.ts";

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

  resolveInstanceWeb(context: ExecutorContext) {
    return this.executor.resolveInstanceWeb(context);
  }

  resolveNodeAgentUrl(context: ExecutorContext) {
    return this.executor.resolveNodeAgentUrl(context);
  }

  runtimeState(context: ExecutorContext) {
    const containerName = context.instance.runtime.containerName;
    if (!containerName) return Promise.resolve<RuntimeLiveness>("absent");
    return this.executor.runtimeState(containerName);
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
    return artifactIdentityMatches(await this.executor.inspectRuntimeVersion(containerName), expected);
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
          ...normalizeRuntimeCapabilities("docker", runtime.capabilities),
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
          ...normalizeRuntimeCapabilities("docker", runtime.capabilities),
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

export type RuntimeAdapterMember = {
  type: string;
  adapter: RuntimeAdapter;
};

/**
 * Provider-neutral runtime 成员表（openspec change refactor-runtime-adapter-registry，D1）。
 *
 * 新增 runtime 只需 `register(type, adapter)`，MUST NOT 修改分发实现。未注册类型保持结构化
 * `NODE_RUNTIME_TYPE_UNSUPPORTED`（statusCode 400）且不回退到其它 runtime。
 */
export class RuntimeAdapterRegistry {
  private readonly members = new Map<string, RuntimeAdapter>();

  constructor(members: Iterable<RuntimeAdapterMember> = []) {
    for (const member of members) this.register(member.type, member.adapter);
  }

  register(type: string, adapter: RuntimeAdapter) {
    this.members.set(type, adapter);
    return this;
  }

  has(type: string) {
    return this.members.has(type);
  }

  types() {
    return [...this.members.keys()];
  }

  forRuntime(runtime: NodeRuntime) {
    const adapter = this.members.get(runtime.type);
    if (!adapter) {
      throw Object.assign(
        new Error(`Runtime type ${runtime.type} is not supported by this node agent.`),
        { statusCode: 400, code: "NODE_RUNTIME_TYPE_UNSUPPORTED" },
      );
    }
    return adapter;
  }

  managedAdapters(): ManagedRuntimeAdapter[] {
    return [...this.members.values()].filter(isManagedRuntimeAdapter);
  }

  /** 只停止显式声明 `stopOnShutdown` 的成员；受管实例由 runtime 自身持有，Node Agent 退出不得牵连。 */
  async stopAll() {
    for (const adapter of this.members.values()) {
      if (adapter.stopOnShutdown !== true) continue;
      await adapter.stopAll?.();
    }
  }
}
