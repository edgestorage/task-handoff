import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, eq, gt, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import type { z } from "zod";
import { sqliteMigrations } from "./migrations/index.ts";
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
import type { ExternalIdentityApprovalRecord, UserAccessGrantRecord } from "../user-records.ts";
import * as schema from "./schema-sqlite.ts";

class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function migrate(client: DatabaseSync) {
  client.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  client.exec(`CREATE TABLE IF NOT EXISTS cp_migration_ledger (
    id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, details TEXT NOT NULL
  )`);
  client.exec("BEGIN IMMEDIATE");
  try {
    const find = client.prepare("SELECT checksum FROM cp_migration_ledger WHERE id = ?");
    const insert = client.prepare("INSERT INTO cp_migration_ledger (id, checksum, applied_at, details) VALUES (?, ?, ?, ?)");
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
  mutate: <R>(operation: () => Promise<R>) => Promise<R>,
): ControlPlaneRecordCollection<T> {
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
      return mutate(async () => {
        const record = recordSchema.parse(input);
        const values = rowForDatabase(record as Record<string, unknown>);
        const set = Object.fromEntries(Object.entries(values).filter(([key]) => key !== "id"));
        await db.insert(table).values(values as any).onConflictDoUpdate({ target: table.id, set: set as any });
        return recordFromDatabase(recordSchema, values);
      });
    },
    async delete(id) {
      return mutate(async () => {
        const result = await db.delete(table).where(eq(table.id, id));
        return Number(result.changes) > 0;
      });
    },
  };
}

function identityCollection(db: any, mutate: <R>(operation: () => Promise<R>) => Promise<R>): ControlPlaneIdentityCollection {
  const base = collection(db, schema.identities, userRecordSchemas.identities, mutate);
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

function grantCollection(
  db: any,
  atomic: <T>(operation: (repository: ControlPlaneUserRepository) => Promise<T>) => Promise<T>,
  mutate: <R>(operation: () => Promise<R>) => Promise<R>,
  inTransaction: boolean,
): ControlPlaneGrantCollection {
  const query = (userIds?: string[]) => {
    const statement = db.select({ grant: schema.grants, roleId: schema.userRoles.roleId }).from(schema.grants)
      .innerJoin(schema.userRoles, eq(schema.grants.userId, schema.userRoles.userId));
    return userIds ? statement.where(inArray(schema.grants.userId, userIds)) : statement;
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
    async get(userId) {
      return grantsFromRows(await query([userId]))[0];
    },
    async listByRole(roleId) {
      const rows = await db.select({ userId: schema.userRoles.userId }).from(schema.userRoles).where(eq(schema.userRoles.roleId, roleId));
      const userIds = rows.map((row: { userId: string }) => row.userId);
      return userIds.length === 0 ? [] : grantsFromRows(await query(userIds));
    },
    put: (record) => inTransaction ? putInDatabase(record) : atomic((repository) => repository.grants.put(record)),
    async delete(userId) {
      return mutate(async () => {
        const result = await db.delete(schema.grants).where(eq(schema.grants.userId, userId));
        return Number(result.changes) > 0;
      });
    },
  };
}

function sessionCollection(db: any, mutate: <R>(operation: () => Promise<R>) => Promise<R>): ControlPlaneSessionCollection {
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
      return mutate(async () => {
        const record = userRecordSchemas.sessions.parse(input);
        const identityRows = await db.select({ userId: schema.identities.userId }).from(schema.identities).where(eq(schema.identities.id, record.identityId)).limit(1);
        if (identityRows[0]?.userId !== record.userId) throw new Error("Session identity does not belong to the requested user.");
        const { userId: _derivedUserId, ...stored } = record;
        await db.insert(schema.sessions).values(stored).onConflictDoUpdate({
          target: schema.sessions.id,
          set: Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "id")),
        });
        return record;
      });
    },
    async delete(id) {
      return mutate(async () => {
        const result = await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
        return Number(result.changes) > 0;
      });
    },
  };
}

function approvalCollection(db: any, mutate: <R>(operation: () => Promise<R>) => Promise<R>): ControlPlaneApprovalCollection {
  const base = collection<ExternalIdentityApprovalRecord>(db, schema.approvals, userRecordSchemas.approvals, mutate);
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

function repositoryFor(
  db: any,
  close: () => Promise<void>,
  client: DatabaseSync,
  inTransaction = false,
  queue = new MutationQueue(),
): ControlPlaneUserRepository {
  let repository: ControlPlaneUserRepository;
  const mutate = <T>(operation: () => Promise<T>) => inTransaction ? operation() : queue.run(operation);
  const transaction = async <T>(operation: (repository: ControlPlaneUserRepository) => Promise<T>) => {
    if (inTransaction) return operation(repository);
    return mutate(async () => {
      client.exec("BEGIN IMMEDIATE");
      try {
        const result = await operation(repositoryFor(db, async () => {}, client, true, queue));
        client.exec("COMMIT");
        return result;
      } catch (error) {
        client.exec("ROLLBACK");
        throw error;
      }
    });
  };
  repository = {
    dialect: "sqlite",
    users: collection(db, schema.users, userRecordSchemas.users, mutate),
    identities: identityCollection(db, mutate),
    roles: collection(db, schema.roles, userRecordSchemas.roles, mutate),
    grants: grantCollection(db, transaction, mutate, inTransaction),
    sessions: sessionCollection(db, mutate),
    providers: collection(db, schema.providers, userRecordSchemas.providers, mutate),
    approvals: approvalCollection(db, mutate),
    audit: collection(db, schema.audit, userRecordSchemas.audit, mutate),
    async metadata() {
      const rows = await db.select().from(schema.metadata).where(eq(schema.metadata.key, "user_store")).limit(1);
      return (rows[0]?.value || { schemaVersion: 1 }) as ControlPlaneUserStoreMetadata;
    },
    async putMetadata(value) {
      await mutate(() => db.insert(schema.metadata).values({ key: "user_store", value }).onConflictDoUpdate({ target: schema.metadata.key, set: { value } }));
    },
    async migration(id) {
      const rows = await db.select().from(schema.migrationLedger).where(eq(schema.migrationLedger.id, id)).limit(1);
      return rows[0];
    },
    async putMigration(record) {
      await mutate(() => db.insert(schema.migrationLedger).values(record).onConflictDoUpdate({
        target: schema.migrationLedger.id,
        set: { checksum: record.checksum, appliedAt: record.appliedAt, details: record.details },
      }));
    },
    transaction,
    close,
  };
  return repository;
}

export async function createSqliteUserRepository(databasePath: string): Promise<ControlPlaneUserRepository> {
  try {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const client = new DatabaseSync(databasePath);
    try { migrate(client); } catch (error) {
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
