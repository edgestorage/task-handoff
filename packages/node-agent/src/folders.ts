import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { NodeFolderTreeEntry } from "@task-handoff/protocol/control-plane";
import { FolderTreeQuerySchema } from "./schemas.ts";

export const MAX_FOLDER_TREE_CHILDREN = 80;

function folderPathError(message: string, statusCode: number, code: string) {
  return Object.assign(new Error(message), { statusCode, code });
}

export function requireBrowsableFolderPath(folderPath: string) {
  const resolvedPath = path.resolve(folderPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (cause) {
    const code = cause && typeof cause === "object" ? (cause as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw folderPathError(`Folder ${resolvedPath} was not found.`, 404, "NODE_FOLDER_PATH_NOT_FOUND");
    }
    throw folderPathError(`Folder ${resolvedPath} is not accessible.`, 403, "NODE_FOLDER_PATH_UNREADABLE");
  }
  if (!stat.isDirectory()) {
    throw folderPathError(`Path ${resolvedPath} is not a folder.`, 400, "NODE_FOLDER_PATH_NOT_DIRECTORY");
  }
  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw folderPathError(`Folder ${resolvedPath} is not accessible.`, 403, "NODE_FOLDER_PATH_UNREADABLE");
  }
  return resolvedPath;
}

function isDirectory(folderPath: string) {
  try {
    return fs.statSync(folderPath).isDirectory();
  } catch {
    return false;
  }
}

export function filesystemRoots() {
  if (process.platform !== "win32") {
    return [path.parse(path.resolve(process.cwd())).root];
  }

  const currentRoot = path.parse(path.resolve(process.cwd())).root;
  const driveRoots = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  return [...new Set([currentRoot, ...driveRoots])].filter(isDirectory);
}

export function folderPlaces() {
  const home = path.resolve(os.homedir());
  const roots = filesystemRoots().map((root) => path.resolve(root));
  return [
    ...(isDirectory(home) ? [{ kind: "home" as const, name: path.basename(home) || home, path: home }] : []),
    ...roots.map((root) => ({ kind: "root" as const, name: root, path: root })),
  ];
}

function readFolderTree(folderPath: string, depth: number): NodeFolderTreeEntry | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(folderPath);
  } catch {
    return undefined;
  }
  if (!stat.isDirectory()) {
    return undefined;
  }
  const resolvedPath = path.resolve(folderPath);
  const name = path.basename(resolvedPath) || resolvedPath;
  let entries: fs.Dirent[] = [];
  try {
    entries = depth > 0 ? fs.readdirSync(resolvedPath, { withFileTypes: true }) : [];
  } catch {
    entries = [];
  }
  const children = depth > 0
    ? entries
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(resolvedPath, entry.name))))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_FOLDER_TREE_CHILDREN)
      .flatMap((entry) => {
        const child = readFolderTree(path.join(resolvedPath, entry.name), depth - 1);
        return child ? [child] : [];
      })
    : [];
  return { name, path: resolvedPath, children };
}

export function listFolderTree(input: z.infer<typeof FolderTreeQuerySchema>) {
  const roots = input.path ? [requireBrowsableFolderPath(input.path)] : filesystemRoots();
  return roots.flatMap((root) => {
    const entry = readFolderTree(root, input.depth);
    return entry ? [entry] : [];
  });
}
