import crypto from "node:crypto";
import { z } from "zod";

export type ControlPlaneDatabaseMigration = { id: string; checksum: string; sql: string };

export function controlPlaneDatabaseMigration(id: string, sql: string): ControlPlaneDatabaseMigration {
  return { id, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
}

export const ControlPlaneMigrationDetailsSchema = z.record(z.string(), z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
]));

export const ControlPlaneMigrationLedgerRecordSchema = z.object({
  // Compatibility for v0.0.21: retain its published application-import ID.
  id: z.string().regex(/^(?:\d{4}|app_\d{4}|import_v\d+\.\d+\.\d+)_[a-z0-9_.-]+$/),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  appliedAt: z.string().datetime(),
  details: ControlPlaneMigrationDetailsSchema,
}).strict();

export function databaseStartupError(dialect: "sqlite" | "postgresql", phase: "connect" | "migrate" | "validate", error: unknown) {
  const cause = error instanceof Error ? error : new Error(String(error));
  return Object.assign(new Error(`Control Plane ${dialect} database ${phase} failed: ${cause.message}`, { cause }), {
    code: `CONTROL_PLANE_DATABASE_${phase.toUpperCase()}_FAILED`,
    dialect,
    phase,
  });
}
