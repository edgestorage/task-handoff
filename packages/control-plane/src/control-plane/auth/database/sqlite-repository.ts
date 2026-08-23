import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import type { z } from "zod";
import { sqliteMigrations } from "./migrations/index.ts";
import {
  databaseStartupError,
  recordFromDatabase,
  rowForDatabase,
  type ControlPlaneRawRecordCollection,
  type ControlPlaneRawUserRepository,
  type ControlPlaneUserStoreMetadata,
  userRecordSchemas,
} from "./repository.ts";
import * as schema from "./schema-sqlite.ts";

type SqliteDatabase = ReturnType<typeof drizzle>;

function migrate(client: DatabaseSync) {
  client.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  client.exec(`CREATE TABLE IF NOT EXISTS control_plane_migration_ledger (
    id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, details TEXT NOT NULL
  )`);
  client.exec("BEGIN IMMEDIATE");
  try {
    const find = client.prepare("SELECT checksum FROM control_plane_migration_ledger WHERE id = ?");
    const insert = client.prepare("INSERT INTO control_plane_migration_ledger (id, checksum, applied_at, details) VALUES (?, ?, ?, ?)");
    for (const migration of sqliteMigrations) {
      const current = find.get(migration.id) as { checksum: string } | undefined;
      if (current) {
        if (current.checksum !== migration.checksum) throw new Error(`Migration checksum mismatch for ${migration.id}.`);
        continue;
      }
      client.exec(migration.sql);
      insert.run(migration.id, migration.checksum, new Date().toISOString(), JSON.stringify({ dialect: "sqlite" }));
    }
    client.exec("COMMIT");
  } catch (error) {
    client.exec("ROLLBACK");
    throw error;
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
      const result = await db.delete(table).where(eq(table.id, id));
      return Number(result.changes) > 0;
    },
  };
}

function repositoryFor(db: any, close: () => Promise<void>, client?: DatabaseSync): ControlPlaneRawUserRepository {
  const repository: ControlPlaneRawUserRepository = {
    dialect: "sqlite",
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
      if (!client) return operation(repository);
      client.exec("BEGIN IMMEDIATE");
      try {
        const result = await operation(repositoryFor(db, async () => {}, client));
        client.exec("COMMIT");
        return result;
      } catch (error) {
        client.exec("ROLLBACK");
        throw error;
      }
    },
    close,
  };
  return repository;
}

export async function createSqliteUserRepository(databasePath: string): Promise<ControlPlaneRawUserRepository> {
  try {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const client = new DatabaseSync(databasePath);
    try {
      migrate(client);
    } catch (error) {
      client.close();
      throw databaseStartupError("sqlite", "migrate", error);
    }
    const db = drizzle({ client });
    return repositoryFor(db, async () => client.close(), client);
  } catch (error) {
    if ((error as { code?: string }).code === "CONTROL_PLANE_DATABASE_MIGRATE_FAILED") throw error;
    throw databaseStartupError("sqlite", "connect", error);
  }
}
