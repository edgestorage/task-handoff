import {
  acquireServerUpdateLock,
  cleanUpServerUpdateLockOnSignals,
} from "@task-handoff/core/core/server-update-installation";

export function acquireUpdateLock(lockPath, options = {}) {
  return acquireServerUpdateLock(lockPath, options);
}

export function cleanUpLockOnSignals(releaseLock) {
  return cleanUpServerUpdateLockOnSignals(releaseLock);
}
