import os from "node:os";
import path from "node:path";
import {
  acquireProcessSingletonLock,
  readProcessSingletonLockOwner,
} from "./process-singleton-lock.ts";

function localUserKey() {
  const uid = process.getuid?.();
  if (uid !== undefined) return String(uid);
  return os.userInfo().username.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function localControlledInstanceLockPath() {
  const root = process.platform === "win32" ? os.tmpdir() : "/tmp";
  return path.join(root, `task-handoff-local-controlled-instance-${localUserKey()}.lock`);
}

export function acquireLocalControlledInstanceLock(details: {
  instanceId: string;
  dataDir?: string;
  host?: string;
  port?: number;
}, lockPath = localControlledInstanceLockPath()) {
  return acquireProcessSingletonLock(lockPath, {
    ...details,
    component: "local-controlled-instance",
    error: {
      label: "Local controlled instance",
      code: "LOCAL_CONTROLLED_INSTANCE_ALREADY_RUNNING",
    },
  });
}

export function readLocalControlledInstanceLockOwner(lockPath = localControlledInstanceLockPath()) {
  return readProcessSingletonLockOwner(lockPath);
}
