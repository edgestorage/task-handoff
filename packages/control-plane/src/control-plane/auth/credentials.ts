import { ControlPlaneAuth } from "./service.ts";
import { controlPlaneStorePaths } from "../persistence/paths.ts";
import { acquireControlPlaneSingletonLock, defaultControlPlaneSingletonLockPath } from "../process/singleton-lock.ts";

export async function replaceControlPlaneCredentials(
  dataDir: string | undefined,
  input: { username: string; password: string },
  options: { lockPath?: string } = {},
) {
  const paths = controlPlaneStorePaths(dataDir);
  const lock = acquireControlPlaneSingletonLock(options.lockPath || defaultControlPlaneSingletonLockPath(), { dataDir: paths.dataDir });
  try {
    const auth = new ControlPlaneAuth(paths, { mode: "password" });
    auth.init();
    return await auth.replaceCredentials(input);
  } finally {
    lock.release();
  }
}

export async function initializeControlPlaneCredentials(
  dataDir: string | undefined,
  input: { username: string; password: string },
  options: { lockPath?: string } = {},
) {
  const paths = controlPlaneStorePaths(dataDir);
  const lock = acquireControlPlaneSingletonLock(options.lockPath || defaultControlPlaneSingletonLockPath(), { dataDir: paths.dataDir });
  try {
    const auth = new ControlPlaneAuth(paths, { mode: "password" });
    auth.init();
    if (!auth.state().requiresBootstrap) return { created: false as const };
    return { created: true as const, user: await auth.bootstrapAdmin(input) };
  } finally {
    lock.release();
  }
}
