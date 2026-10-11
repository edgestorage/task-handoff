import type {
  ControlledInstance,
  InstanceDeleteInput,
  InstanceDeleteResult,
  InstanceImageSnapshot,
  Node,
  NodeRuntime,
  Project,
  RuntimeArtifactIdentity,
} from "@task-handoff/protocol/control-plane";
export type { InstanceDeleteInput, InstanceDeleteResult } from "@task-handoff/protocol/control-plane";
import type { GitWorkspaceProvisioningInput } from "@task-handoff/protocol/managed-git-credentials";
import type { ResolvedRuntimeArtifact } from "../runtime-artifacts.ts";

/**
 * Provider-neutral runtime adapter contracts (openspec change refactor-runtime-adapter-registry).
 *
 * 共享类型 MUST 定义在本模块；`runtimes/docker.ts`、`runtimes/adapters.ts` 只做同名 re-export，
 * 这样新增 runtime（WSL、Kubernetes、prepare-windows-local）不必 import Docker 实现文件即可获得契约类型。
 */

export const FINAL_COMPUTER_PLATFORMS = new Set([
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

export type ExecutorContext = {
  project: Project;
  image: InstanceImageSnapshot;
  node: Node;
  runtime: NodeRuntime;
  instance: ControlledInstance;
  nodeAgentUrl?: string;
  modelEnv?: Record<string, string>;
  privateConfigPath?: string;
  gitWorkspaceProvisioning?: GitWorkspaceProvisioningInput;
  completeGitWorkspaceProvisioning?: () => void;
  signal?: AbortSignal;
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

export type RuntimeLiveness = "running" | "stopped" | "absent" | "unknown";

export type RuntimeAdapter = {
  resolveInstanceWeb(context: ExecutorContext): Promise<string>;
  resolveNodeAgentUrl?(context: ExecutorContext): Promise<string>;
  /** Reports whether the runtime is alive without touching the instance itself. */
  runtimeState?(context: ExecutorContext): Promise<RuntimeLiveness>;
  start(context: ExecutorContext): Promise<ExecutorStartResult>;
  stop(context: ExecutorContext): Promise<ExecutorStartResult>;
  restart(context: ExecutorContext): Promise<ExecutorStartResult>;
  delete(context: ExecutorContext, input: InstanceDeleteInput): Promise<InstanceDeleteResult>;
  managedArtifacts?: boolean;
  check?(runtime: NodeRuntime): Promise<Partial<NodeRuntime>>;
  /**
   * 是否在 Node Agent 进程退出/重启时停止该 runtime 持有的实例。默认 false：
   * 受管实例（Docker 容器、WSL distro、Kubernetes workload）由 runtime 自身持有，
   * Node Agent 退出 MUST NOT 牵连它们；只有进程式 Local Runtime 声明 true。
   */
  stopOnShutdown?: boolean;
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
