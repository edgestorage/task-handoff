import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";

export type AtomicWriteOptions = {
  directoryMode?: number;
  fileMode?: number;
};

const WINDOWS_ATOMIC_WRITE_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640] as const;

export type AtomicWriteRetryOptions = {
  platform?: NodeJS.Platform;
  wait?: (milliseconds: number) => void;
};

function waitSync(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isTransientWindowsWriteError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

export function withWindowsTransientFileRetry<T>(operation: () => T, options: AtomicWriteRetryOptions = {}): T {
  if ((options.platform ?? process.platform) !== "win32") return operation();
  const wait = options.wait ?? waitSync;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      const delay = WINDOWS_ATOMIC_WRITE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientWindowsWriteError(error)) throw error;
      wait(delay);
    }
  }
}

export function atomicWriteFileSync(filePath: string, contents: string | Buffer, options: AtomicWriteOptions = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: options.directoryMode ?? 0o700 });
  withWindowsTransientFileRetry(() => {
    writeFileAtomic.sync(filePath, contents, {
      encoding: typeof contents === "string" ? "utf8" : undefined,
      fsync: true,
      mode: options.fileMode ?? 0o600,
    });
  });
}

export function atomicWriteJsonSync(filePath: string, value: unknown, options: AtomicWriteOptions = {}) {
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}
