import {
  normalizeWslRuntimeCapabilities,
  type InstanceDeleteInput,
  type InstanceDeleteResult,
  type NodeRuntime,
  type RuntimeArtifactIdentity,
} from "@task-handoff/protocol/control-plane";
import {
  finalComputerPlatform,
  type ExecutorContext,
  type ExecutorStartResult,
  type ManagedRuntimeAdapter,
  type RuntimeLiveness,
} from "./contracts.ts";
import type { ResolvedRuntimeArtifact } from "../runtime-artifacts.ts";
import { WslExecutor, wslDistroNameForInstance } from "./wsl-executor.ts";
import { WslInstanceLifecycle, type WslLifecycleProvisioner } from "./wsl-lifecycle.ts";

/**
 * WSL runtime adapter（openspec change add-wsl-runtime）。
 *
 * 与 Docker 并列注册的独立执行域：一个实例一个 distro（D2）。本 adapter 组合
 * `WslInstanceLifecycle`（Phase 5 生命周期）、`WslDistroProvisioner`（Phase 4 供给）与
 * `wsl-artifacts`（Phase 7 受管 artifact），不新增平行 API，也不回退到其它 runtime。
 */

export const WSL_RUNTIME_LIFECYCLE_UNAVAILABLE = "WSL_RUNTIME_LIFECYCLE_UNAVAILABLE";

export function wslRuntimeCapabilities(overrides: Record<string, unknown> = {}) {
  return normalizeWslRuntimeCapabilities(overrides);
}

/** distro 名复用 `instance.runtime.containerName`（D2）；缺失时按同一规则从 instanceId 派生。 */
export function wslDistroNameForInstanceRecord(instance: { id: string; runtime: { containerName?: string } }) {
  return instance.runtime.containerName?.trim() || wslDistroNameForInstance(instance.id);
}

export type WslRuntimeAdapterOptions = {
  platform?: string;
  hostArch?: string;
  /** 组装好的实例生命周期；缺失时生命周期操作以结构化错误 fail closed。 */
  lifecycle?: WslInstanceLifecycle;
  /** 组装生命周期所需的供给器与执行器（与 lifecycle 二选一）。 */
  provisioner?: WslLifecycleProvisioner;
  listenerPort?: number;
  hostAddress?: string;
  fallbackNodeAgentUrl?: string;
  bootstrapDir?: string;
  wslPath?: string;
  allocatePort?: () => Promise<number>;
  logger?: (message: string, data: Record<string, unknown>) => void;
};

export class WslRuntimeAdapter implements ManagedRuntimeAdapter {
  readonly managedArtifacts = true as const;
  private readonly executor: WslExecutor;
  private readonly platform: string;
  private readonly lifecycle?: WslInstanceLifecycle;

  constructor(executor: WslExecutor, options: WslRuntimeAdapterOptions = {}) {
    this.executor = executor;
    this.platform = options.platform ?? process.platform;
    this.lifecycle = options.lifecycle ?? (options.provisioner && options.listenerPort
      ? new WslInstanceLifecycle({
        provisioner: options.provisioner,
        executor,
        listenerPort: options.listenerPort,
        hostAddress: options.hostAddress,
        fallbackNodeAgentUrl: options.fallbackNodeAgentUrl,
        bootstrapDir: options.bootstrapDir,
        hostArch: options.hostArch ?? process.arch,
        allocatePort: options.allocatePort,
        logger: options.logger,
      })
      : undefined);
  }

  private requireLifecycle(operation: string) {
    if (this.lifecycle) return this.lifecycle;
    throw Object.assign(new Error(`The WSL runtime lifecycle is not configured; cannot ${operation}.`), {
      statusCode: 503,
      code: WSL_RUNTIME_LIFECYCLE_UNAVAILABLE,
      details: { operation },
    });
  }

  /** D5：distro 内监听 Node Agent 分配的端口，公共 access strategy 保持 node-proxy。 */
  async resolveInstanceWeb(context: ExecutorContext) {
    const port = context.instance.runtime.port;
    if (!port) {
      throw Object.assign(new Error(`Instance ${context.instance.id} does not have a node-owned WSL runtime port.`), {
        statusCode: 409,
        code: "INSTANCE_RUNTIME_ENDPOINT_UNAVAILABLE",
      });
    }
    return `http://127.0.0.1:${port}`;
  }

  /** 实例回连 Node Agent（distro→宿主，经宿主网关或显式覆盖地址）。 */
  async resolveNodeAgentUrl(context: ExecutorContext) {
    if (!this.lifecycle) return context.nodeAgentUrl || "";
    const distroName = wslDistroNameForInstanceRecord(context.instance);
    return this.lifecycle.nodeAgentUrl(context, distroName);
  }

  /** 只报告 distro 级 liveness，不唤醒 distro（唤醒由保活会话负责）。 */
  async runtimeState(context: ExecutorContext): Promise<RuntimeLiveness> {
    const name = wslDistroNameForInstanceRecord(context.instance);
    if (!name) return "absent";
    try {
      return await this.executor.distroState(name);
    } catch {
      return "unknown";
    }
  }

  async start(context: ExecutorContext): Promise<ExecutorStartResult> {
    return this.requireLifecycle("start").start(context);
  }

  async stop(context: ExecutorContext): Promise<ExecutorStartResult> {
    return this.requireLifecycle("stop").stop(context);
  }

  async restart(context: ExecutorContext): Promise<ExecutorStartResult> {
    return this.requireLifecycle("restart").restart(context);
  }

  async delete(context: ExecutorContext, input: InstanceDeleteInput): Promise<InstanceDeleteResult> {
    return this.requireLifecycle("delete").delete(context, input);
  }

  /** 7.1：WSL distro 恒为 linux；架构与宿主一致，artifact 为 universal。 */
  async artifactTarget(_context?: ExecutorContext) {
    if (this.lifecycle) return this.lifecycle.artifactTarget();
    return { platform: "linux", arch: process.arch, launcherAbi: 1 };
  }

  async installRuntime(context: ExecutorContext, artifact: ResolvedRuntimeArtifact) {
    const lifecycle = this.requireLifecycle("installRuntime");
    const distroName = wslDistroNameForInstanceRecord(context.instance);
    await lifecycle.installRuntime(distroName, artifact);
  }

  async inspectRuntime(context: ExecutorContext, expected: RuntimeArtifactIdentity) {
    if (!this.lifecycle) return false;
    const distroName = wslDistroNameForInstanceRecord(context.instance);
    return this.lifecycle.inspectRuntime(distroName, expected);
  }

  /** runtime check：探测 `wsl.exe` 可用性并发布结构化在线/离线诊断（3.6）。 */
  async check(runtime: NodeRuntime): Promise<Partial<NodeRuntime>> {
    const capabilities = wslRuntimeCapabilities(runtime.capabilities);
    const hostPlatform = finalComputerPlatform(this.platform);
    try {
      const version = await this.executor.version();
      return {
        status: "online",
        capabilities: {
          ...capabilities,
          wsl: {
            status: "online",
            hostPlatform,
            executablePath: this.executor.executablePath,
            version,
          },
        },
      };
    } catch (error) {
      return {
        status: "offline",
        capabilities: {
          ...capabilities,
          wsl: {
            status: "offline",
            hostPlatform,
            executablePath: this.executor.executablePath,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }
}
