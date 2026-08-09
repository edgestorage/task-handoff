import fs from "node:fs";
import path from "node:path";

export const DEFAULT_OPEN_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_OPEN_LOG_BACKUP_COUNT = 2;

function rotatedPath(filePath: string, generation: number) {
  const extension = path.extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  return `${stem}.${generation}${extension}`;
}

function shiftBackups(filePath: string, backupCount: number) {
  if (backupCount <= 0) return;
  fs.rmSync(rotatedPath(filePath, backupCount), { force: true });
  for (let generation = backupCount - 1; generation >= 1; generation -= 1) {
    const source = rotatedPath(filePath, generation);
    if (fs.existsSync(source)) fs.renameSync(source, rotatedPath(filePath, generation + 1));
  }
}

export function appendRotatingLogSync(
  filePath: string,
  value: string | Buffer,
  maxBytes = DEFAULT_OPEN_LOG_MAX_BYTES,
  backupCount = DEFAULT_OPEN_LOG_BACKUP_COUNT,
) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const bytes = payload.byteLength > maxBytes ? payload.subarray(payload.byteLength - maxBytes) : payload;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Managed log path must be a regular file: ${filePath}`);
    if (stat.size + bytes.byteLength > maxBytes) {
      shiftBackups(filePath, backupCount);
      if (backupCount > 0) {
        if (stat.size > maxBytes) {
          fs.writeFileSync(rotatedPath(filePath, 1), readFileTail(filePath, maxBytes), { mode: 0o600 });
          fs.rmSync(filePath, { force: true });
        } else {
          fs.renameSync(filePath, rotatedPath(filePath, 1));
        }
      } else fs.rmSync(filePath, { force: true });
    }
  }
  fs.appendFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export function readFileTail(filePath: string, maxBytes: number) {
  const stat = fs.statSync(filePath);
  const bytes = Math.min(stat.size, maxBytes);
  const buffer = Buffer.allocUnsafe(bytes);
  const source = fs.openSync(filePath, "r");
  let offset = 0;
  try {
    while (offset < bytes) {
      const read = fs.readSync(source, buffer, offset, bytes - offset, stat.size - bytes + offset);
      if (read === 0) break;
      offset += read;
    }
  } finally {
    fs.closeSync(source);
  }
  return offset === bytes ? buffer : buffer.subarray(0, offset);
}

export function copyTruncateOpenLog(
  filePath: string,
  maxBytes = DEFAULT_OPEN_LOG_MAX_BYTES,
  backupCount = DEFAULT_OPEN_LOG_BACKUP_COUNT,
) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= maxBytes) return false;

  if (backupCount > 0) {
    shiftBackups(filePath, backupCount);
    const buffer = readFileTail(filePath, maxBytes);
    fs.writeFileSync(rotatedPath(filePath, 1), buffer, { mode: 0o600 });
  }
  fs.truncateSync(filePath, 0);
  fs.chmodSync(filePath, 0o600);
  return true;
}
