import fs from "node:fs";
import path from "node:path";

export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

type RetentionLogger = (message: string, details: Record<string, unknown>) => void;

function directChild(root: string, name: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, name);
  if (path.dirname(resolved) !== resolvedRoot || path.basename(resolved) !== name) {
    throw new Error(`Retention entry is not a direct child of its managed root: ${name}`);
  }
  return resolved;
}

export function ensurePrivateDirectory(directory: string) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Managed persistence path must be a real directory: ${directory}`);
    }
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function retireManagedDirectory(options: {
  sourceRoot: string;
  entryName: string;
  trashRoot: string;
  nowMs?: number;
}) {
  const source = directChild(options.sourceRoot, options.entryName);
  if (!fs.existsSync(source)) return undefined;
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Retention source must be a real directory: ${source}`);
  }
  ensurePrivateDirectory(options.trashRoot);
  const timestamp = options.nowMs ?? Date.now();
  let suffix = 0;
  let name = `${timestamp}-${options.entryName}`;
  while (fs.existsSync(directChild(options.trashRoot, name))) {
    suffix += 1;
    name = `${timestamp}-${suffix}-${options.entryName}`;
  }
  const destination = directChild(options.trashRoot, name);
  fs.renameSync(source, destination);
  return destination;
}

export function sweepRetiredDirectories(options: {
  trashRoot: string;
  retentionMs?: number;
  nowMs?: number;
  logger?: RetentionLogger;
}) {
  if (!fs.existsSync(options.trashRoot)) return [];
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const deleted: string[] = [];
  for (const entry of fs.readdirSync(options.trashRoot, { withFileTypes: true })) {
    const target = directChild(options.trashRoot, entry.name);
    try {
      const retiredAt = Number(entry.name.split("-", 1)[0]);
      if (!Number.isFinite(retiredAt) || retiredAt + retentionMs > nowMs) continue;
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fs.unlinkSync(target);
      else if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
      else fs.unlinkSync(target);
      deleted.push(target);
    } catch (error) {
      options.logger?.("retired persistence entry cleanup failed", {
        path: target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return deleted;
}
