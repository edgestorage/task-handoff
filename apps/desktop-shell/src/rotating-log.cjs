const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_BACKUP_COUNT = 2;

function rotatedPath(filePath, generation) {
  const extension = path.extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  return `${stem}.${generation}${extension}`;
}

function readTail(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const bytes = Math.min(stat.size, maxBytes);
  const buffer = Buffer.allocUnsafe(bytes);
  const descriptor = fs.openSync(filePath, "r");
  let offset = 0;
  try {
    while (offset < bytes) {
      const read = fs.readSync(descriptor, buffer, offset, bytes - offset, stat.size - bytes + offset);
      if (read === 0) break;
      offset += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return offset === bytes ? buffer : buffer.subarray(0, offset);
}

function appendRotatingLog(filePath, value, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const backupCount = options.backupCount ?? DEFAULT_BACKUP_COUNT;
  const payload = Buffer.from(value);
  const bytes = payload.byteLength > maxBytes ? payload.subarray(payload.byteLength - maxBytes) : payload;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Desktop log path must be a regular file: ${filePath}`);
    if (stat.size + bytes.byteLength > maxBytes) {
      if (backupCount > 0) {
        fs.rmSync(rotatedPath(filePath, backupCount), { force: true });
        for (let generation = backupCount - 1; generation >= 1; generation -= 1) {
          const source = rotatedPath(filePath, generation);
          if (fs.existsSync(source)) fs.renameSync(source, rotatedPath(filePath, generation + 1));
        }
        if (stat.size > maxBytes) {
          fs.writeFileSync(rotatedPath(filePath, 1), readTail(filePath, maxBytes), { mode: 0o600 });
          fs.rmSync(filePath, { force: true });
        } else {
          fs.renameSync(filePath, rotatedPath(filePath, 1));
        }
      } else {
        fs.rmSync(filePath, { force: true });
      }
    }
  }
  fs.appendFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

module.exports = { appendRotatingLog, DEFAULT_MAX_BYTES, DEFAULT_BACKUP_COUNT };
