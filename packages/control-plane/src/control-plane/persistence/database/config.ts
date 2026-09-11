import path from "node:path";
import { z } from "zod";
import type { ControlPlaneStorePaths } from "../paths.ts";

const SqliteDatabaseConfigSchema = z.object({
  dialect: z.literal("sqlite").default("sqlite"),
  path: z.string().trim().min(1).optional(),
}).strict();

const PostgresqlDatabaseConfigSchema = z.object({
  dialect: z.literal("postgresql"),
  connectionString: z.string().trim().url(),
  schema: z.string().trim().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).default("public"),
}).strict();

export const ControlPlaneDatabaseConfigSchema = z.discriminatedUnion("dialect", [
  SqliteDatabaseConfigSchema,
  PostgresqlDatabaseConfigSchema,
]);

export type ControlPlaneDatabaseConfigInput = z.input<typeof ControlPlaneDatabaseConfigSchema>;
export type ControlPlaneDatabaseConfig = z.output<typeof ControlPlaneDatabaseConfigSchema>;

export function resolveControlPlaneDatabaseConfig(
  paths: ControlPlaneStorePaths,
  configured?: ControlPlaneDatabaseConfigInput,
): ControlPlaneDatabaseConfig {
  const dialect = configured?.dialect || process.env.TASK_HANDOFF_CONTROL_PLANE_DATABASE_DIALECT || "sqlite";
  if (dialect === "postgresql") {
    return ControlPlaneDatabaseConfigSchema.parse(configured || {
      dialect,
      connectionString: process.env.TASK_HANDOFF_CONTROL_PLANE_DATABASE_URL,
      schema: process.env.TASK_HANDOFF_CONTROL_PLANE_DATABASE_SCHEMA,
    });
  }
  if (dialect !== "sqlite") {
    throw Object.assign(new Error(`Unsupported Control Plane database dialect: ${dialect}.`), {
      code: "CONTROL_PLANE_DATABASE_DIALECT_UNSUPPORTED",
    });
  }
  const parsed = SqliteDatabaseConfigSchema.parse(configured || {
    dialect: "sqlite",
    path: process.env.TASK_HANDOFF_CONTROL_PLANE_SQLITE_PATH,
  });
  return { ...parsed, path: path.resolve(parsed.path || paths.databasePath) };
}
