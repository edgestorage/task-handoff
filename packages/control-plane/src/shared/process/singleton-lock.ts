import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export type ProcessLockOwner = {
  pid: number;
  hostname: string;
  component?: string;
  command: string;
  acquiredAt: string;
  token: string;
  dataDir?: string;
  host?: string;
  port?: number;
};

export class ProcessSingletonError extends Error {
  readonly code: string;
  readonly lockPath: string;
  readonly owner?: ProcessLockOwner;

  constructor(lockPath: string, owner?: ProcessLockOwner, descriptor: { label?: string; code?: string } = {}) {
    const running = owner?.pid ? ` pid ${owner.pid}` : "";
    const label = descriptor.label || "Process";
    super(`${label} is already running${running}. Lock: ${lockPath}`);
    this.name = "ProcessSingletonError";
    this.code = descriptor.code || "PROCESS_ALREADY_RUNNING";
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

export type AcquiredProcessLock = {
  lockPath: string;
  owner: ProcessLockOwner;
  release: () => void;
};

function ownerPath(lockPath: string) {
  return path.join(lockPath, "owner.json");
}

function initializationPath(lockPath: string) {
  return path.join(lockPath, "initializing.json");
}

function recoveryPath(lockPath: string) {
  return path.join(lockPath, "recovering.json");
}

const INCOMPLETE_LOCK_STALE_MS = 2_000;
const INCOMPLETE_LOCK_RETRY_COUNT = 5;
const INCOMPLETE_LOCK_RETRY_MS = 20;

function readOwner(lockPath: string) {
  try {
    const value = JSON.parse(fs.readFileSync(ownerPath(lockPath), "utf8")) as Partial<ProcessLockOwner>;
    if (
      !Number.isInteger(value.pid) || Number(value.pid) <= 0 ||
      typeof value.hostname !== "string" || !value.hostname ||
      typeof value.command !== "string" ||
      typeof value.acquiredAt !== "string" || !Number.isFinite(Date.parse(value.acquiredAt)) ||
      typeof value.token !== "string" || !value.token
    ) return undefined;
    return value as ProcessLockOwner;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: unknown) {
  if (!Number.isInteger(pid) || Number(pid) <= 0) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeOwner(lockPath: string, owner: ProcessLockOwner) {
  const temporaryPath = path.join(lockPath, `.owner-${owner.token}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const initialization = readInitialization(lockPath);
  if (initialization?.token !== owner.token) {
    tryRemoveFile(temporaryPath);
    throw new Error(`Process lock initialization was superseded: ${lockPath}`);
  }
  fs.renameSync(temporaryPath, ownerPath(lockPath));
  tryRemoveFile(initializationPath(lockPath));
}

function readInitialization(lockPath: string) {
  try {
    return JSON.parse(fs.readFileSync(initializationPath(lockPath), "utf8")) as { token?: string; startedAt?: string };
  } catch {
    return undefined;
  }
}

function tryRemoveFile(filePath: string) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function waitForIncompleteLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, INCOMPLETE_LOCK_RETRY_MS);
}

function incompleteLockAgeMs(lockPath: string) {
  try {
    const initialization = readInitialization(lockPath);
    const startedAt = Date.parse(initialization?.startedAt || "");
    if (Number.isFinite(startedAt)) return Math.max(0, Date.now() - startedAt);
    return Math.max(0, Date.now() - fs.statSync(lockPath).mtimeMs);
  } catch {
    return 0;
  }
}

function claimStaleLock(lockPath: string, token: string) {
  try {
    fs.writeFileSync(recoveryPath(lockPath), `${JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return recoverAbandonedClaim(lockPath) ? claimStaleLock(lockPath, token) : false;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readRecoveryClaim(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as { token?: string; pid?: number; startedAt?: string };
  } catch {
    return undefined;
  }
}

function recoverAbandonedClaim(lockPath: string) {
  const markerPath = recoveryPath(lockPath);
  const observed = readRecoveryClaim(markerPath);
  const startedAt = Date.parse(observed?.startedAt || "");
  if (isPidAlive(observed?.pid) || (Number.isFinite(startedAt) && Date.now() - startedAt < INCOMPLETE_LOCK_STALE_MS)) return false;
  const quarantinePath = path.join(lockPath, `.recovering-${crypto.randomUUID()}.stale`);
  try {
    fs.renameSync(markerPath, quarantinePath);
  } catch (error) {
    if (["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code || "")) return false;
    throw error;
  }
  const moved = readRecoveryClaim(quarantinePath);
  if (moved?.token === observed?.token) {
    tryRemoveFile(quarantinePath);
    return true;
  }
  try {
    fs.linkSync(quarantinePath, markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    tryRemoveFile(quarantinePath);
  }
  return false;
}

function recoveryClaimMatches(lockPath: string, token: string) {
  return readRecoveryClaim(recoveryPath(lockPath))?.token === token;
}

export function acquireProcessSingletonLock(lockPath: string, details: {
  component?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  error?: { label?: string; code?: string };
} = {}): AcquiredProcessLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const owner: ProcessLockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    component: details.component,
    command: process.argv.join(" "),
    acquiredAt: new Date().toISOString(),
    token: crypto.randomUUID(),
    dataDir: details.dataDir,
    host: details.host,
    port: details.port,
  };

  for (let attempt = 0; attempt < INCOMPLETE_LOCK_RETRY_COUNT; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(initializationPath(lockPath), `${JSON.stringify({ token: owner.token, startedAt: new Date().toISOString() })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      writeOwner(lockPath, owner);
      return {
        lockPath,
        owner,
        release() {
          const current = readOwner(lockPath);
          if (current?.token !== owner.token) {
            return;
          }
          fs.rmSync(lockPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const current = readOwner(lockPath);
      if (isPidAlive(current?.pid)) {
        throw new ProcessSingletonError(lockPath, current, details.error);
      }
      if (!current && incompleteLockAgeMs(lockPath) < INCOMPLETE_LOCK_STALE_MS) {
        if (attempt + 1 < INCOMPLETE_LOCK_RETRY_COUNT) {
          waitForIncompleteLock();
          continue;
        }
        throw new ProcessSingletonError(lockPath, undefined, details.error);
      }
      const recoveryToken = crypto.randomUUID();
      if (!claimStaleLock(lockPath, recoveryToken)) {
        if (attempt + 1 < INCOMPLETE_LOCK_RETRY_COUNT) {
          waitForIncompleteLock();
          continue;
        }
        throw new ProcessSingletonError(lockPath, readOwner(lockPath), details.error);
      }
      const claimedOwner = readOwner(lockPath);
      if (isPidAlive(claimedOwner?.pid)) {
        tryRemoveFile(recoveryPath(lockPath));
        throw new ProcessSingletonError(lockPath, claimedOwner, details.error);
      }
      if (current?.token && claimedOwner?.token !== current.token) {
        tryRemoveFile(recoveryPath(lockPath));
        continue;
      }
      if (!recoveryClaimMatches(lockPath, recoveryToken)) continue;
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }

  const current = readOwner(lockPath);
  throw new ProcessSingletonError(lockPath, current, details.error);
}
