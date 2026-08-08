import os from "node:os";
import path from "node:path";
import { acquireProcessSingletonLock } from "../../shared/process/singleton-lock.ts";

export function defaultControlPlaneSingletonLockPath() {
  const override = process.env.TASK_HANDOFF_CONTROL_PLANE_LOCK_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(os.tmpdir(), `task-handoff-control-plane-${process.getuid?.() ?? "user"}.lock`);
}

export function acquireControlPlaneSingletonLock(
  lockPath: string,
  details: { dataDir?: string; host?: string; port?: number } = {},
) {
  return acquireProcessSingletonLock(lockPath, {
    ...details,
    component: "control-plane",
    error: { label: "Control plane", code: "CONTROL_PLANE_ALREADY_RUNNING" },
  });
}
