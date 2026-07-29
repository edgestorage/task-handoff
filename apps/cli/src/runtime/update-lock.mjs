import { acquireProcessSingletonLock } from "@task-handoff/core/core/process-singleton-lock";

const defaultLockPath = "/run/task-handoff-server-update.lock";
const legacyLockGraceMs = 30_000;

export function acquireUpdateLock(lockPath = defaultLockPath, options = {}) {
  const lock = acquireProcessSingletonLock(lockPath, {
    component: "server-update",
    incompleteLockStaleMs: options.legacyGraceMs ?? legacyLockGraceMs,
    error: { label: "TaskHandoff server update", code: "SERVER_UPDATE_ALREADY_RUNNING" },
  });
  return lock.release;
}

export function cleanUpLockOnSignals(releaseLock) {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      releaseLock();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}
