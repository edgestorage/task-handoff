import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";

export type AtomicWriteOptions = {
  directoryMode?: number;
  fileMode?: number;
};

export function atomicWriteFileSync(filePath: string, contents: string | Buffer, options: AtomicWriteOptions = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: options.directoryMode ?? 0o700 });
  writeFileAtomic.sync(filePath, contents, {
    encoding: typeof contents === "string" ? "utf8" : undefined,
    fsync: true,
    mode: options.fileMode ?? 0o600,
  });
}

export function atomicWriteJsonSync(filePath: string, value: unknown, options: AtomicWriteOptions = {}) {
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}
