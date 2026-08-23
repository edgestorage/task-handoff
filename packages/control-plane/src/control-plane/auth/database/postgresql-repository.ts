import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { z } from "zod";
import { postgresqlMigrations } from "./migrations/index.ts";
import {
  databaseStartupError,
  recordFromDatabase,
  rowForDatabase,
  userRecordSchemas,
  type ControlPlaneRawRecordCollection,
  type ControlPlaneRawUserRepository,
  type ControlPlaneUserStoreMetadata,
} from "./repository.ts";
import * as schema from "./schema-postgresql.ts";

type PostgresqlDatabase = ReturnType<typeof drizzle>;

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function migrate(pool: Pool, schemaName: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`task-handoff:user-access:${schemaName}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)}`);
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(schemaName)}`);
    await client.query(`CREATE TABLE IF NOT EXISTS control_plane_migration_ledger (
      id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, details JSONB NOT NULL
    )`);
    for (const migration of postgresqlMigrations) {
      const current = await client.query<{ checksum: string }>("SELECT checksum FROM control_plane_migration_ledger WHERE id = $1", [migration.id]);
      if (current.rows[0]) {
        if (current.rows[0].checksum !== migration.checksum) throw new Error(`Migration checksum mismatch for ${migration.id}.`);
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO control_plane_migration_ledger (id, checksum, applied_at, details) VALUES ($1, $2, $3, $4)",
        [migration.id, migration.checksum, new Date().toISOString(), { dialect: "postgresql" }],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function collection<T extends { id: string }>(
  db: any,
  table: any,
  recordSchema: z.ZodType<T>,
): ControlPlaneRawRecordCollection<T> {
  return {
    async list() {
      const rows = await db.select().from(table);
      return rows.map((row) => recordFromDatabase(recordSchema, row as Record<string, unknown>));
    },
    async get(id) {
      const rows = await db.select().from(table).where(eq(table.id, id)).limit(1);
      return rows[0] ? recordFromDatabase(recordSchema, rows[0] as Record<string, unknown>) : undefined;
    },
    async put(input) {
      const record = recordSchema.parse(input);
      const values = rowForDatabase(record as Record<string, unknown>);
      const set = Object.fromEntries(Object.entries(values).filter(([key]) => key !== "id"));
      await db.insert(table).values(values as any).onConflictDoUpdate({ target: table.id, set: set as any });
      return recordFromDatabase(recordSchema, values);
    },
    async delete(id) {
      const rows = await db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
      return rows.length > 0;
    },
  };
}

function repositoryFor(db: any, close: () => Promise<void>): ControlPlaneRawUserRepository {
  const repository: ControlPlaneRawUserRepository = {
    dialect: "postgresql",
    users: collection(db, schema.users, userRecordSchemas.users),
    identities: collection(db, schema.identities, userRecordSchemas.identities),
    roles: collection(db, schema.roles, userRecordSchemas.roles),
    grants: collection(db, schema.grants, userRecordSchemas.grants),
    sessions: collection(db, schema.sessions, userRecordSchemas.sessions),
    providers: collection(db, schema.providers, userRecordSchemas.providers),
    approvals: collection(db, schema.approvals, userRecordSchemas.approvals),
    audit: collection(db, schema.audit, userRecordSchemas.audit),
    async metadata() {
      const rows = await db.select().from(schema.metadata).where(eq(schema.metadata.key, "user_store")).limit(1);
      return (rows[0]?.value || { schemaVersion: 1 }) as ControlPlaneUserStoreMetadata;
    },
    async putMetadata(value) {
      await db.insert(schema.metadata).values({ key: "user_store", value }).onConflictDoUpdate({
        target: schema.metadata.key,
        set: { value },
      });
    },
    async migration(id) {
      const rows = await db.select().from(schema.migrationLedger).where(eq(schema.migrationLedger.id, id)).limit(1);
      return rows[0];
    },
    async putMigration(record) {
      await db.insert(schema.migrationLedger).values(record).onConflictDoUpdate({
        target: schema.migrationLedger.id,
        set: { checksum: record.checksum, appliedAt: record.appliedAt, details: record.details },
      });
    },
    async transaction(operation) {
      return db.transaction(async (transaction: unknown) => operation(repositoryFor(transaction, async () => {})));
    },
    close,
  };
  return repository;
}

export async function createPostgresqlUserRepository(options: {
  connectionString: string;
  schema: string;
}): Promise<ControlPlaneRawUserRepository> {
  const pool = new Pool({
    connectionString: options.connectionString,
    options: `-c search_path=${options.schema}`,
    application_name: "task-handoff-control-plane",
  });
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end().catch(() => {});
    throw databaseStartupError("postgresql", "connect", error);
  }
  try {
    await migrate(pool, options.schema);
    const db = drizzle({ client: pool });
    return repositoryFor(db, () => pool.end());
  } catch (error) {
    await pool.end().catch(() => {});
    throw databaseStartupError("postgresql", "migrate", error);
  }
}
