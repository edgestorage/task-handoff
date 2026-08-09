import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { ensurePrivateDirectory } from "@task-handoff/core/storage/retention";
import { readFileTail } from "@task-handoff/core/storage/open-log-retention";

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_BACKUP_COUNT = 2;
// Reserve 60 MiB for the node-agent's stdout/stderr generations and keep the
// complete Local Runtime log tree below the 256 MiB instance budget.
export const DEFAULT_APP_SESSION_LOG_BUDGET_BYTES = 192 * 1024 * 1024;

function rotatedPath(filePath: string, generation: number) {
  const extension = path.extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  return `${stem}.${generation}${extension}`;
}

export class RotatingLogWriter extends Writable {
  private fd: number;
  private size: number;
  readonly filePath: string;
  private readonly maxBytes: number;
  private readonly backupCount: number;

  constructor(
    filePath: string,
    maxBytes = DEFAULT_LOG_MAX_BYTES,
    backupCount = DEFAULT_LOG_BACKUP_COUNT,
  ) {
    super();
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.backupCount = backupCount;
    ensurePrivateDirectory(path.dirname(filePath));
    this.rotateOversizedExistingFile();
    this.normalizeBackupSizes();
    this.fd = fs.openSync(filePath, "a", 0o600);
    fs.chmodSync(filePath, 0o600);
    this.size = fs.fstatSync(this.fd).size;
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    try {
      if (this.size > 0 && this.size + buffer.byteLength > this.maxBytes) this.rotate();
      const value = buffer.byteLength > this.maxBytes ? buffer.subarray(buffer.byteLength - this.maxBytes) : buffer;
      this.writeBuffer(value, 0, callback);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _final(callback: (error?: Error | null) => void) {
    try {
      fs.closeSync(this.fd);
      this.fd = -1;
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    try {
      if (this.fd >= 0) fs.closeSync(this.fd);
      this.fd = -1;
      callback(error);
    } catch (closeError) {
      callback(closeError instanceof Error ? closeError : new Error(String(closeError)));
    }
  }

  private rotateOversizedExistingFile() {
    if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size >= this.maxBytes) {
      const tail = readFileTail(this.filePath, this.maxBytes);
      this.shiftBackups();
      if (this.backupCount > 0) fs.writeFileSync(rotatedPath(this.filePath, 1), tail, { mode: 0o600 });
      fs.rmSync(this.filePath, { force: true });
    }
  }

  private normalizeBackupSizes() {
    for (let generation = 1; generation <= this.backupCount; generation += 1) {
      const backup = rotatedPath(this.filePath, generation);
      if (!fs.existsSync(backup)) continue;
      const stat = fs.statSync(backup);
      if (stat.size <= this.maxBytes) continue;
      const tail = readFileTail(backup, this.maxBytes);
      fs.writeFileSync(backup, tail, { mode: 0o600 });
    }
  }

  private writeBuffer(buffer: Buffer, offset: number, callback: (error?: Error | null) => void) {
    fs.write(this.fd, buffer, offset, buffer.byteLength - offset, null, (error, written) => {
      if (error) {
        callback(error);
        return;
      }
      if (written === 0) {
        callback(new Error(`Log write made no progress: ${this.filePath}`));
        return;
      }
      const nextOffset = offset + written;
      if (nextOffset < buffer.byteLength) {
        this.writeBuffer(buffer, nextOffset, callback);
        return;
      }
      this.size += buffer.byteLength;
      callback();
    });
  }

  private rotate() {
    fs.closeSync(this.fd);
    this.fd = -1;
    this.rotateFiles();
    this.fd = fs.openSync(this.filePath, "a", 0o600);
    fs.chmodSync(this.filePath, 0o600);
    this.size = 0;
  }

  private rotateFiles() {
    if (this.backupCount <= 0) {
      fs.rmSync(this.filePath, { force: true });
      return;
    }
    this.shiftBackups();
    if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, rotatedPath(this.filePath, 1));
  }

  private shiftBackups() {
    if (this.backupCount <= 0) return;
    fs.rmSync(rotatedPath(this.filePath, this.backupCount), { force: true });
    for (let generation = this.backupCount - 1; generation >= 1; generation -= 1) {
      const source = rotatedPath(this.filePath, generation);
      if (fs.existsSync(source)) fs.renameSync(source, rotatedPath(this.filePath, generation + 1));
    }
  }
}

type LogFile = { path: string; size: number; mtimeMs: number; active: boolean; rotated: boolean };

export function enforceInstanceLogBudget(logRoot: string, activeLogDirectories: Iterable<string>, maxBytes = DEFAULT_APP_SESSION_LOG_BUDGET_BYTES) {
  if (!fs.existsSync(logRoot)) return [];
  const rootStat = fs.lstatSync(logRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  const activeRoots = [...activeLogDirectories].map((directory) => path.resolve(directory));
  const files: LogFile[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile()) {
        const stat = fs.statSync(filePath);
        const resolved = path.resolve(filePath);
        files.push({
          path: filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          active: activeRoots.some((root) => resolved.startsWith(`${root}${path.sep}`)),
          rotated: /\.\d+\.log$/.test(entry.name),
        });
      }
    }
  };
  visit(logRoot);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= maxBytes) return [];
  const candidates = files
    .filter((file) => !file.active || file.rotated)
    .sort((left, right) => Number(left.active) - Number(right.active) || left.mtimeMs - right.mtimeMs);
  const deleted: string[] = [];
  for (const file of candidates) {
    if (total <= maxBytes) break;
    fs.rmSync(file.path, { force: true });
    total -= file.size;
    deleted.push(file.path);
  }
  return deleted;
}
