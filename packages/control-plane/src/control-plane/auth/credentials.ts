import { ControlPlaneUserService } from "./user-service.ts";
import { controlPlaneStorePaths } from "../persistence/paths.ts";
import { acquireControlPlaneSingletonLock, defaultControlPlaneSingletonLockPath } from "../process/singleton-lock.ts";

export async function replaceControlPlaneCredentials(
  dataDir: string | undefined,
  input: { username: string; password: string; userId?: string; targetUsername?: string },
  options: { lockPath?: string } = {},
) {
  const paths = controlPlaneStorePaths(dataDir);
  const lock = acquireControlPlaneSingletonLock(options.lockPath || defaultControlPlaneSingletonLockPath(), { dataDir: paths.dataDir });
  const users = new ControlPlaneUserService(paths);
  try {
    await users.init();
    return await users.recoverLocalCredentials(input);
  } finally {
    try {
      await users.store.close();
    } finally {
      lock.release();
    }
  }
}

export async function initializeControlPlaneCredentials(
  dataDir: string | undefined,
  input: { username: string; password: string },
  options: { lockPath?: string } = {},
) {
  const paths = controlPlaneStorePaths(dataDir);
  const lock = acquireControlPlaneSingletonLock(options.lockPath || defaultControlPlaneSingletonLockPath(), { dataDir: paths.dataDir });
  const users = new ControlPlaneUserService(paths);
  try {
    await users.init();
    if (users.store.state().initialized && (await users.store.users.list()).length > 0) return { created: false as const };
    return { created: true as const, user: await users.bootstrapAdmin(input) };
  } finally {
    try {
      await users.store.close();
    } finally {
      lock.release();
    }
  }
}
