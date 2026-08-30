import { and, eq, gt, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { z } from "zod";
import type { ExternalIdentityApprovalRecord, UserAccessGrantRecord } from "../user-records.ts";
import { postgresqlMigrations } from "./migrations/index.ts";
import {
  databaseStartupError,
  recordFromDatabase,
  rowForDatabase,
  type ControlPlaneApprovalCollection,
  type ControlPlaneGrantCollection,
  type ControlPlaneIdentityCollection,
  type ControlPlaneRecordCollection,
  type ControlPlaneSessionCollection,
  type ControlPlaneUserRepository,
  type ControlPlaneUserStoreMetadata,
  userRecordSchemas,
} from "./repository.ts";
import * as schema from "./schema-postgresql.ts";

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
    await client.query(`CREATE TABLE IF NOT EXISTS cp_migration_ledger (
      id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, details JSONB NOT NULL
    )`);
    for (const migration of postgresqlMigrations) {
      const current = await client.query<{ checksum: string }>("SELECT checksum FROM cp_migration_ledger WHERE id = $1", [migration.id]);
      if (current.rows[0]) {
        if (current.rows[0].checksum !== migration.checksum) throw new Error(`Migration checksum mismatch for ${migration.id}.`);
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO cp_migration_ledger (id, checksum, applied_at, details) VALUES ($1, $2, $3, $4)",
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

function collection<T extends { id: string }>(db: any, table: any, recordSchema: z.ZodType<T>): ControlPlaneRecordCollection<T> {
  return {
    async list() {
      const rows = await db.select().from(table);
      return rows.map((row: Record<string, unknown>) => recordFromDatabase(recordSchema, row));
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

function identityCollection(db: any): ControlPlaneIdentityCollection {
  const base = collection(db, schema.identities, userRecordSchemas.identities);
  const first = async (condition: unknown) => {
    const rows = await db.select().from(schema.identities).where(condition).limit(1);
    return rows[0] ? recordFromDatabase(userRecordSchemas.identities, rows[0]) : undefined;
  };
  return {
    ...base,
    findByLoginName: (loginName) => first(eq(schema.identities.normalizedLoginName, loginName)),
    findByProviderSubject: (providerId, subject) => first(and(eq(schema.identities.providerId, providerId), eq(schema.identities.subject, subject))),
    async listByUser(userId) {
      const rows = await db.select().from(schema.identities).where(eq(schema.identities.userId, userId));
      return rows.map((row: Record<string, unknown>) => recordFromDatabase(userRecordSchemas.identities, row));
    },
    async existsForProvider(providerId) {
      const rows = await db.select({ id: schema.identities.id }).from(schema.identities).where(eq(schema.identities.providerId, providerId)).limit(1);
      return rows.length > 0;
    },
  };
}

function grantsFromRows(rows: Array<{ grant: Record<string, unknown>; roleId: string }>): UserAccessGrantRecord[] {
  const grouped = new Map<string, { grant: Record<string, unknown>; roleIds: string[] }>();
  for (const row of rows) {
    const userId = row.grant.userId as string;
    const current = grouped.get(userId) || { grant: row.grant, roleIds: [] };
    current.roleIds.push(row.roleId);
    grouped.set(userId, current);
  }
  return [...grouped.values()].map(({ grant, roleIds }) => userRecordSchemas.grants.parse({ ...grant, roleIds: roleIds.sort() }));
}

function grantCollection(db: any, atomic: <T>(operation: (repository: ControlPlaneUserRepository) => Promise<T>) => Promise<T>, inTransaction: boolean): ControlPlaneGrantCollection {
  const query = (userIds?: string[]) => {
    const statement = db.select({ grant: schema.grants, roleId: schema.userRoles.roleId }).from(schema.grants)
      .innerJoin(schema.userRoles, eq(schema.grants.userId, schema.userRoles.userId));
    return userIds ? statement.where(inArray(schema.grants.userId, userIds)) : statement;
  };
  const get = async (userId: string) => {
    return grantsFromRows(await query([userId]))[0];
  };
  const putInDatabase = async (input: UserAccessGrantRecord) => {
    const record = userRecordSchemas.grants.parse(input);
    const { roleIds, ...stored } = record;
    await db.insert(schema.grants).values(stored).onConflictDoUpdate({
      target: schema.grants.userId,
      set: Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "userId")),
    });
    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, record.userId));
    await db.insert(schema.userRoles).values(roleIds.map((roleId) => ({ userId: record.userId, roleId })));
    return record;
  };
  return {
    async list() {
      return grantsFromRows(await query());
    },
    get,
    async listByRole(roleId) {
      const rows = await db.select({ userId: schema.userRoles.userId }).from(schema.userRoles).where(eq(schema.userRoles.roleId, roleId));
      const userIds = rows.map((row: { userId: string }) => row.userId);
      return userIds.length === 0 ? [] : grantsFromRows(await query(userIds));
    },
    put: (record) => inTransaction ? putInDatabase(record) : atomic((repository) => repository.grants.put(record)),
    async delete(userId) {
      const rows = await db.delete(schema.grants).where(eq(schema.grants.userId, userId)).returning({ userId: schema.grants.userId });
      return rows.length > 0;
    },
  };
}

function sessionCollection(db: any): ControlPlaneSessionCollection {
  const fromRows = (rows: Array<{ session: Record<string, unknown>; userId: string }>) => rows.map((row) => (
    recordFromDatabase(userRecordSchemas.sessions, { ...row.session, userId: row.userId })
  ));
  const query = () => db.select({ session: schema.sessions, userId: schema.identities.userId })
    .from(schema.sessions).innerJoin(schema.identities, eq(schema.sessions.identityId, schema.identities.id));
  return {
    async list() { return fromRows(await query()); },
    async get(id) { return fromRows(await query().where(eq(schema.sessions.id, id)).limit(1))[0]; },
    async listByUser(userId) { return fromRows(await query().where(eq(schema.identities.userId, userId))); },
    async put(input) {
      const record = userRecordSchemas.sessions.parse(input);
      const identityRows = await db.select({ userId: schema.identities.userId }).from(schema.identities).where(eq(schema.identities.id, record.identityId)).limit(1);
      if (identityRows[0]?.userId !== record.userId) throw new Error("Session identity does not belong to the requested user.");
      const { userId: _derivedUserId, ...stored } = record;
      await db.insert(schema.sessions).values(stored).onConflictDoUpdate({
        target: schema.sessions.id,
        set: Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "id")),
      });
      return record;
    },
    async delete(id) {
      const rows = await db.delete(schema.sessions).where(eq(schema.sessions.id, id)).returning({ id: schema.sessions.id });
      return rows.length > 0;
    },
  };
}

function approvalCollection(db: any): ControlPlaneApprovalCollection {
  const base = collection<ExternalIdentityApprovalRecord>(db, schema.approvals, userRecordSchemas.approvals);
  return {
    ...base,
    async findActivePending(providerId, subject, timestamp) {
      const rows = await db.select().from(schema.approvals).where(and(
        eq(schema.approvals.providerId, providerId), eq(schema.approvals.subject, subject),
        eq(schema.approvals.status, "pending"), gt(schema.approvals.expiresAt, timestamp),
      )).limit(1);
      return rows[0] ? recordFromDatabase(userRecordSchemas.approvals, rows[0]) : undefined;
    },
    async hasActivePendingForProvider(providerId, timestamp) {
      const rows = await db.select({ id: schema.approvals.id }).from(schema.approvals).where(and(
        eq(schema.approvals.providerId, providerId), eq(schema.approvals.status, "pending"), gt(schema.approvals.expiresAt, timestamp),
      )).limit(1);
      return rows.length > 0;
    },
  };
}

function repositoryFor(db: any, close: () => Promise<void>, inTransaction = false): ControlPlaneUserRepository {
  let repository: ControlPlaneUserRepository;
  const transaction = async <T>(operation: (repository: ControlPlaneUserRepository) => Promise<T>) => {
    if (inTransaction) return operation(repository);
    return db.transaction(async (transactionDb: unknown) => operation(repositoryFor(transactionDb, async () => {}, true)));
  };
  repository = {
    dialect: "postgresql",
    users: collection(db, schema.users, userRecordSchemas.users),
    identities: identityCollection(db),
    roles: collection(db, schema.roles, userRecordSchemas.roles),
    grants: grantCollection(db, transaction, inTransaction),
    sessions: sessionCollection(db),
    providers: collection(db, schema.providers, userRecordSchemas.providers),
    approvals: approvalCollection(db),
    audit: collection(db, schema.audit, userRecordSchemas.audit),
    async metadata() {
      const rows = await db.select().from(schema.metadata).where(eq(schema.metadata.key, "user_store")).limit(1);
      return (rows[0]?.value || { schemaVersion: 1 }) as ControlPlaneUserStoreMetadata;
    },
    async putMetadata(value) {
      await db.insert(schema.metadata).values({ key: "user_store", value }).onConflictDoUpdate({ target: schema.metadata.key, set: { value } });
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
    transaction,
    close,
  };
  return repository;
}

export async function createPostgresqlUserRepository(options: { connectionString: string; schema: string }): Promise<ControlPlaneUserRepository> {
  const pool = new Pool({
    connectionString: options.connectionString,
    options: `-c search_path=${options.schema}`,
    application_name: "task-handoff-control-plane",
  });
  try { await pool.query("SELECT 1"); } catch (error) {
    await pool.end().catch(() => {});
    throw databaseStartupError("postgresql", "connect", error);
  }
  try {
    await migrate(pool, options.schema);
    return repositoryFor(drizzle({ client: pool }), () => pool.end());
  } catch (error) {
    await pool.end().catch(() => {});
    throw databaseStartupError("postgresql", "migrate", error);
  }
}
