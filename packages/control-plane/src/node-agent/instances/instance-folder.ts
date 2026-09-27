import path from "node:path";
import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import type { NodeAgentState } from "../state.ts";

/**
 * 实例可见文件夹的解析结果。调用方按自身边界把非 resolved 结果映射为结构化错误码，
 * 避免在 Story、Agent 等业务里各写一份路径边界判定。
 */
export type InstanceFolderResolution =
  | { status: "resolved"; folderId: string; folderPath: string; workspacePath: string; runtimePath: string }
  | { status: "unknown-folder" }
  | { status: "unsupported-source" }
  | { status: "outside-workspace" };

/**
 * 把一个本地文件夹标识解析为该实例内的运行路径。
 *
 * 唯一来源是 node-agent 的本地文件夹集合：Docker/Kubernetes 实例只把源目录挂进工作区根，
 * 因此文件夹必须落在实例来源目录内；Local Runtime 直接在宿主路径执行，不需要该约束。
 */
export function resolveInstanceFolder(state: NodeAgentState, instance: ControlledInstance, folderId: string): InstanceFolderResolution {
  const folder = state.localFolders.get(folderId);
  if (!folder) return { status: "unknown-folder" };
  const workspacePath = instance.runtime.workspacePath || instance.workspace.path || "/workspace";
  const runtime = state.requireRuntime(instance.runtimeId);
  if (runtime.type === "local") {
    const folderPath = path.resolve(folder.path);
    return { status: "resolved", folderId: folder.id, folderPath, workspacePath, runtimePath: folderPath };
  }
  if (instance.source.type !== "local-folder") return { status: "unsupported-source" };
  const relative = path.relative(path.resolve(instance.source.path), path.resolve(folder.path));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { status: "outside-workspace" };
  return {
    status: "resolved",
    folderId: folder.id,
    folderPath: path.resolve(folder.path),
    workspacePath,
    runtimePath: relative ? path.posix.join(workspacePath, ...relative.split(path.sep)) : workspacePath,
  };
}
