import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { processStartIdentity } from "../../../../shared/process-start-identity.cjs";

export { processStartIdentity } from "../../../../shared/process-start-identity.cjs";

export type ProcessLockOwner = {
  pid: number;
  hostname: string;
  component?: string;
  command: string;
  acquiredAt: string;
  token: string;
  startIdentity?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  instanceId?: string;
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
  updateDetails: (details: ProcessLockDetails) => boolean;
  release: () => void;
};

export type ProcessLockDetails = Pick<ProcessLockOwner, "dataDir" | "host" | "port" | "instanceId">;

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

function validPid(pid: unknown): pid is number {
  return Number.isInteger(pid) && Number(pid) > 0;
}

export function readProcessSingletonLockOwner(lockPath: string) {
  try {
    const value = JSON.parse(fs.readFileSync(ownerPath(lockPath), "utf8")) as Partial<ProcessLockOwner>;
    if (validPid(value.pid) && typeof (value as { startTime?: unknown }).startTime === "string") {
      const legacy = value as Partial<ProcessLockOwner> & { startTime: string; createdAt?: string };
      return {
        pid: legacy.pid,
        hostname: typeof legacy.hostname === "string" && legacy.hostname ? legacy.hostname : os.hostname(),
        component: legacy.component || "server-update",
        command: typeof legacy.command === "string" ? legacy.command : "",
        acquiredAt: typeof legacy.createdAt === "string" && Number.isFinite(Date.parse(legacy.createdAt)) ? legacy.createdAt : new Date(0).toISOString(),
        token: typeof legacy.token === "string" && legacy.token ? legacy.token : `legacy:${legacy.pid}:${legacy.startTime}`,
        startIdentity: legacy.startTime.startsWith("linux:") ? legacy.startTime : `linux:${legacy.startTime}`,
      } satisfies ProcessLockOwner;
    }
    if (
      !validPid(value.pid) ||
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

const readOwner = readProcessSingletonLockOwner;

function isPidAlive(pid: unknown) {
  if (!validPid(pid)) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function processLockOwnerMatchesLiveProcess(owner: Pick<ProcessLockOwner, "pid" | "startIdentity"> | undefined) {
  if (!owner || !isPidAlive(owner.pid)) return false;
  if (!owner.startIdentity) return true;
  const current = processStartIdentity(owner.pid);
  return current === undefined || current === owner.startIdentity;
}

export function verifiedProcessLockOwnerPid(owner: Pick<ProcessLockOwner, "pid" | "startIdentity"> | undefined) {
  if (!owner?.startIdentity) return undefined;
  return processStartIdentity(owner.pid) === owner.startIdentity ? owner.pid : undefined;
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

function updateOwner(lockPath: string, owner: ProcessLockOwner, details: Partial<ProcessLockDetails>) {
  const current = readOwner(lockPath);
  if (current?.token !== owner.token) return false;
  const next = { ...owner };
  for (const [key, value] of Object.entries(details) as Array<[keyof ProcessLockDetails, ProcessLockDetails[keyof ProcessLockDetails]]>) {
    if (value === undefined) delete next[key];
    else Object.assign(next, { [key]: value });
  }
  const temporaryPath = path.join(lockPath, `.owner-update-${owner.token}-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (readOwner(lockPath)?.token !== owner.token) return false;
    fs.renameSync(temporaryPath, ownerPath(lockPath));
    for (const key of Object.keys(owner) as Array<keyof ProcessLockOwner>) delete owner[key];
    Object.assign(owner, next);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    tryRemoveFile(temporaryPath);
  }
}

function readInitialization(lockPath: string) {
  try {
    return JSON.parse(fs.readFileSync(initializationPath(lockPath), "utf8")) as {
      token?: string;
      pid?: number;
      startIdentity?: string;
      startedAt?: string;
    };
  } catch {
    return undefined;
  }
}

function initializationMatchesLiveProcess(lockPath: string) {
  const initialization = readInitialization(lockPath);
  return validPid(initialization?.pid) && processLockOwnerMatchesLiveProcess({
    pid: initialization.pid,
    startIdentity: initialization.startIdentity,
  });
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
  instanceId?: string;
  incompleteLockStaleMs?: number;
  error?: { label?: string; code?: string };
} = {}): AcquiredProcessLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const startIdentity = processStartIdentity(process.pid);
  const owner: ProcessLockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    command: process.argv.join(" "),
    acquiredAt: new Date().toISOString(),
    token: crypto.randomUUID(),
    ...(details.component !== undefined ? { component: details.component } : {}),
    ...(startIdentity ? { startIdentity } : {}),
    ...(details.dataDir !== undefined ? { dataDir: details.dataDir } : {}),
    ...(details.host !== undefined ? { host: details.host } : {}),
    ...(details.port !== undefined ? { port: details.port } : {}),
    ...(details.instanceId !== undefined ? { instanceId: details.instanceId } : {}),
  };

  for (let attempt = 0; attempt < INCOMPLETE_LOCK_RETRY_COUNT; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(initializationPath(lockPath), `${JSON.stringify({
        token: owner.token,
        pid: owner.pid,
        startIdentity: owner.startIdentity,
        startedAt: new Date().toISOString(),
      })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      writeOwner(lockPath, owner);
      return {
        lockPath,
        owner,
        updateDetails(details) {
          return updateOwner(lockPath, owner, details);
        },
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
      if (processLockOwnerMatchesLiveProcess(current)) {
        throw new ProcessSingletonError(lockPath, current, details.error);
      }
      if (!current && (
        initializationMatchesLiveProcess(lockPath)
        || incompleteLockAgeMs(lockPath) < (details.incompleteLockStaleMs ?? INCOMPLETE_LOCK_STALE_MS)
      )) {
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
      if (processLockOwnerMatchesLiveProcess(claimedOwner)) {
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
