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

/**
 * Splits selectable folders into product-shipped built-in projects and operator
 * projects. Built-in projects belong to the software rather than the user, so
 * the project picker renders them apart instead of mixing them into the list.
 * Folders without an origin are legacy records and stay user projects.
 */
export function partitionInstanceCwdFolders<T extends { origin?: "user" | "builtin" }>(folders: T[]) {
  const builtin: T[] = [];
  const user: T[] = [];
  for (const folder of folders) (folder.origin === "builtin" ? builtin : user).push(folder);
  return { builtin, user };
}

export function filterInstanceCwdFolders<T extends { name?: string; path: string; localizedNames?: Record<string, string> }>(
  folders: T[],
  query: string,
  locale?: string,
) {
  const normalizedQuery = query.trim().toLowerCase();
  return folders.filter((folder) => !normalizedQuery
    || `${nodeLocalFolderDisplayName(folder, locale)} ${folder.name || ""} ${Object.values(folder.localizedNames || {}).join(" ")} ${folder.path}`
      .toLowerCase()
      .includes(normalizedQuery));
}

export function findInstanceCwdFolderByPath<T extends { path: string }>(folders: T[], path: string) {
  const selectedPath = path.trim();
  if (!selectedPath) return undefined;
  return folders.find((folder) => relativeNodePathSegments(folder.path.trim(), selectedPath)?.length === 0);
}
