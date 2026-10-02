import fs from "node:fs";
import path from "node:path";

/**
 * Managed config writers keep a bounded history of timestamped backups next to
 * the live file. Retention is enforced on every managed apply, so a long-lived
 * instance cannot accumulate one backup per model/settings change.
 */
export const DEFAULT_MANAGED_BACKUP_LIMIT = 10;

// Same-millisecond writes add a numeric tie suffix so two generations are never
// collapsed into one file; the ISO stamp itself stays fixed width and sortable.
const GENERATION_STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(\d+))?$/;

type BackupGeneration = {
  stamp: string;
  tie: number;
};

function backupGeneration(filePath: string, name: string): BackupGeneration | undefined {
  const prefix = `${path.basename(filePath)}.bak.`;
  if (!name.startsWith(prefix)) return undefined;
  const match = GENERATION_STAMP.exec(name.slice(prefix.length));
  if (!match) return undefined;
  return { stamp: match[1], tie: match[2] ? Number(match[2]) : 0 };
}

function compareGenerations(left: BackupGeneration, right: BackupGeneration) {
  if (left.stamp !== right.stamp) return left.stamp < right.stamp ? -1 : 1;
  return left.tie - right.tie;
}

function backupPath(filePath: string, now: Date) {
  return `${filePath}.bak.${now.toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Removes the oldest `<file>.bak.<stamp>` generations, keeping the newest
 * `limit` of them. Unrelated backups (for example a bare `.bak` copy or a
 * suffixed legacy name) are never touched.
 */
export function pruneManagedBackupsSync(filePath: string, limit: number = DEFAULT_MANAGED_BACKUP_LIMIT) {
  const directory = path.dirname(filePath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const backups = entries
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const generation = backupGeneration(filePath, entry.name);
      return generation ? [{ name: entry.name, generation }] : [];
    })
    .sort((left, right) => compareGenerations(left.generation, right.generation));
  const retained = Math.max(0, Math.trunc(limit));
  const removed = backups.slice(0, Math.max(0, backups.length - retained));
  for (const backup of removed) fs.rmSync(path.join(directory, backup.name), { force: true });
  return removed.map((backup) => path.join(directory, backup.name));
}

/** Copies `filePath` to a 0600 timestamped backup and enforces the history limit. */
export function createManagedBackupSync(filePath: string, options: { limit?: number; now?: Date } = {}) {
  const base = backupPath(filePath, options.now ?? new Date());
  let target = base;
  for (let tie = 1; fs.existsSync(target); tie += 1) target = `${base}-${tie}`;
  fs.copyFileSync(filePath, target);
  fs.chmodSync(target, 0o600);
  pruneManagedBackupsSync(filePath, options.limit);
  return target;
}
