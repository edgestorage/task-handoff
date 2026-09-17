import type { InstanceBoardItem, NodeLocalFolder } from "../../../api/types";
import { isSameOrChildNodePath, nodeLocalFolderDisplayName, relativeNodePathSegments } from "../nodePath.ts";

export function selectableInstanceCwdFolders(instance: InstanceBoardItem, folders: NodeLocalFolder[]) {
  const uniqueFolders = [...new Map(folders.map((folder) => [folder.id, folder])).values()];
  const localRuntime = instance.runtime?.type === "local" || instance.runtime?.kind === "local";
  if (localRuntime) return uniqueFolders;
  const source = instance.source;
  if (source.type !== "local-folder") return [];
  return uniqueFolders.filter((folder) => isSameOrChildNodePath(folder.path, source.path));
}

export function filterInstanceCwdFolders<T extends { name?: string; path: string }>(folders: T[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  return folders.filter((folder) => !normalizedQuery
    || `${nodeLocalFolderDisplayName(folder)} ${folder.name || ""} ${folder.path}`.toLowerCase().includes(normalizedQuery));
}

export function findInstanceCwdFolderByPath<T extends { path: string }>(folders: T[], path: string) {
  const selectedPath = path.trim();
  if (!selectedPath) return undefined;
  return folders.find((folder) => relativeNodePathSegments(folder.path.trim(), selectedPath)?.length === 0);
}
