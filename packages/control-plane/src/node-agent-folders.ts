import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { NodeFolderTreeEntry } from "@task-handoff/protocol/control-plane";
import { FolderTreeQuerySchema } from "./node-agent-schemas.ts";

export const MAX_FOLDER_TREE_CHILDREN = 80;

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
  const roots = input.path ? [input.path] : filesystemRoots();
  return roots.flatMap((root) => {
    const entry = readFolderTree(root, input.depth);
    return entry ? [entry] : [];
  });
}
