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

  constructor(lockPath: string, owner?: ProcessLockOwner, component = "process") {
    const running = owner?.pid ? ` pid ${owner.pid}` : "";
    const label = component === "control-plane" ? "Control plane" : component === "node-agent" ? "Node agent" : "Process";
    super(`${label} is already running${running}. Lock: ${lockPath}`);
    this.name = "ProcessSingletonError";
    this.code = component === "control-plane"
      ? "CONTROL_PLANE_ALREADY_RUNNING"
      : component === "node-agent"
        ? "NODE_AGENT_ALREADY_RUNNING"
        : "PROCESS_ALREADY_RUNNING";
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

function readOwner(lockPath: string) {
  try {
    return JSON.parse(fs.readFileSync(ownerPath(lockPath), "utf8")) as ProcessLockOwner;
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
  fs.writeFileSync(ownerPath(lockPath), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
}

export function defaultControlPlaneSingletonLockPath() {
  return path.join(os.tmpdir(), `task-handoff-control-plane-${process.getuid?.() ?? "user"}.lock`);
}

export function defaultNodeAgentSingletonLockPath() {
  return path.join(os.tmpdir(), `task-handoff-node-agent-${process.getuid?.() ?? "user"}.lock`);
}

export function acquireProcessSingletonLock(lockPath: string, details: { component?: string; dataDir?: string; host?: string; port?: number } = {}): AcquiredProcessLock {
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

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
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
        throw new ProcessSingletonError(lockPath, current, details.component);
      }
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }

  const current = readOwner(lockPath);
  throw new ProcessSingletonError(lockPath, current, details.component);
}
