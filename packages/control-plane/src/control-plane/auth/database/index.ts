import type { ControlPlaneStorePaths } from "../../persistence/paths.ts";
import {
  resolveControlPlaneUserDatabaseConfig,
  type ControlPlaneUserDatabaseConfigInput,
} from "./config.ts";
import { databaseStartupError, type ControlPlaneRawUserRepository, type ControlPlaneUserRepository } from "./repository.ts";
import { createCachedUserRepository } from "./cached-repository.ts";

export async function createControlPlaneUserRepository(
  paths: ControlPlaneStorePaths,
  configured?: ControlPlaneUserDatabaseConfigInput,
): Promise<ControlPlaneUserRepository> {
  const config = resolveControlPlaneUserDatabaseConfig(paths, configured);
  let raw: ControlPlaneRawUserRepository;
  if (config.dialect === "postgresql") {
    const { createPostgresqlUserRepository } = await import("./postgresql-repository.ts");
    raw = await createPostgresqlUserRepository(config);
  } else {
    const { createSqliteUserRepository } = await import("./sqlite-repository.ts");
    raw = await createSqliteUserRepository(config.path!);
  }
  try {
    return await createCachedUserRepository(raw);
  } catch (error) {
    await raw.close().catch(() => {});
    throw databaseStartupError(config.dialect, "validate", error);
  }
}

export type { ControlPlaneUserDatabaseConfigInput } from "./config.ts";
export type { ControlPlaneUserRepository } from "./repository.ts";
