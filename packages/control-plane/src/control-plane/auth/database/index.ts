import type { ControlPlaneStorePaths } from "../../persistence/paths.ts";
import {
  resolveControlPlaneUserDatabaseConfig,
  type ControlPlaneUserDatabaseConfigInput,
} from "./config.ts";
import type { ControlPlaneUserRepository } from "./repository.ts";

export async function createControlPlaneUserRepository(
  paths: ControlPlaneStorePaths,
  configured?: ControlPlaneUserDatabaseConfigInput,
): Promise<ControlPlaneUserRepository> {
  const config = resolveControlPlaneUserDatabaseConfig(paths, configured);
  if (config.dialect === "postgresql") {
    const { createPostgresqlUserRepository } = await import("./postgresql-repository.ts");
    return createPostgresqlUserRepository(config);
  }
  const { createSqliteUserRepository } = await import("./sqlite-repository.ts");
  return createSqliteUserRepository(config.path!);
}

export type { ControlPlaneUserDatabaseConfigInput } from "./config.ts";
export type { ControlPlaneUserRepository } from "./repository.ts";
