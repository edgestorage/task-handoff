import type { NodeLocalFolder } from "../../../api/types";
import { findInstanceCwdFolderByPath } from "./instanceCwdFolders.ts";

function conflictFolderId(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { code?: unknown; details?: unknown };
  if (record.code !== "NODE_LOCAL_FOLDER_ALREADY_EXISTS") return undefined;
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details as { folderId?: unknown }
    : undefined;
  return typeof details?.folderId === "string" && details.folderId.trim() ? details.folderId.trim() : "";
}

function matchFolder(folders: NodeLocalFolder[], path: string, folderId: string) {
  return (folderId ? folders.find((folder) => folder.id === folderId) : undefined)
    || findInstanceCwdFolderByPath(folders, path);
}

/**
 * Resolves the project that won a duplicate-path create request. The current
 * projection is checked first; a conflict can race a just-created project, so
 * the authoritative node list is fetched only when the cache has no match.
 */
export async function resolveExistingNodeLocalFolder(input: {
  error: unknown;
  knownFolders: NodeLocalFolder[];
  loadFolders: (nodeId: string) => Promise<NodeLocalFolder[]>;
  nodeId: string;
  path: string;
}) {
  const errorFolderId = conflictFolderId(input.error);
  if (errorFolderId === undefined) return undefined;
  const folderId = errorFolderId;
  const cached = matchFolder(input.knownFolders, input.path, folderId);
  if (cached) return cached;
  let folders: NodeLocalFolder[];
  try {
    folders = await input.loadFolders(input.nodeId);
  } catch {
    return undefined;
  }
  return matchFolder(folders, input.path, folderId);
}

export async function createOrReuseNodeLocalFolder(input: {
  createFolder: () => Promise<NodeLocalFolder>;
  knownFolders: NodeLocalFolder[];
  loadFolders: (nodeId: string) => Promise<NodeLocalFolder[]>;
  nodeId: string;
  path: string;
}) {
  try {
    return await input.createFolder();
  } catch (error) {
    const existing = await resolveExistingNodeLocalFolder({
      error,
      knownFolders: input.knownFolders,
      loadFolders: input.loadFolders,
      nodeId: input.nodeId,
      path: input.path,
    });
    if (!existing) throw error;
    return existing;
  }
}
