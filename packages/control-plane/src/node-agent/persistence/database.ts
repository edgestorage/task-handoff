import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import type { NodeAgentStorePaths } from "./paths.ts";
import { nodeAgentMigrations, type NodeAgentMigration } from "./migrations.ts";
import { migrateLegacyP0State } from "./legacy-migration.ts";

const NODE_AGENT_APPLICATION_ID = 0x54484e41;
const MINIMUM_NODE_VERSION = [24, 15, 0] as const;
const MINIMUM_BUN_VERSION = [1, 4, 4] as const;

export type NodeAgentDatabase = {
  db: NodeSQLiteDatabase;
  client: DatabaseSync;
  checkpoint(): Promise<void>;
  close(): Promise<void>;
};

function startupError(phase: string, cause: unknown) {
  return Object.assign(new Error(`Node Agent database ${phase} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }), {
    code: "NODE_AGENT_DATABASE_STARTUP_FAILED",
    statusCode: 500,
    details: { phase, recovery: "Restore or remove the invalid node-agent.sqlite before restarting the Node Agent." },
  });
}

function scalar(client: DatabaseSync, pragma: string) {
  const row = client.prepare(pragma).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

export function isSupportedNodeVersion(version = process.versions.node) {
  return isMinimumVersion(version, MINIMUM_NODE_VERSION);
}

export function isSupportedBunVersion(version: string) {
  return isMinimumVersion(version, MINIMUM_BUN_VERSION);
}

function isMinimumVersion(version: string, minimum: readonly number[]) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function assertSupportedRuntimeVersion(versions = process.versions) {
  const bunVersion = (versions as NodeJS.ProcessVersions & { bun?: unknown }).bun;
  if (typeof bunVersion === "string" && bunVersion) {
    if (!isSupportedBunVersion(bunVersion)) {
      throw new Error(`Bun.js ${MINIMUM_BUN_VERSION.join(".")} or newer is required; received ${bunVersion}.`);
    }
    return;
  }
  if (!isSupportedNodeVersion(versions.node)) {
    throw new Error(`Node.js ${MINIMUM_NODE_VERSION.join(".")} or newer is required; received ${versions.node}.`);
  }
}

function assertNodeSqliteCapabilities(client: DatabaseSync) {
  for (const method of ["exec", "prepare", "close"] as const) {
    if (typeof client[method] !== "function") {
      throw new Error(`node:sqlite is missing required DatabaseSync.${method}().`);
    }
  }
  const statement = client.prepare("SELECT 1 AS value");
  for (const method of ["run", "get", "all"] as const) {
    if (typeof statement[method] !== "function") {
      throw new Error(`node:sqlite is missing required StatementSync.${method}().`);
    }
  }
  const row = statement.get() as { value?: unknown } | undefined;
  if (Number(row?.value) !== 1) throw new Error("node:sqlite capability probe returned an invalid result.");
}

function chmodDatabaseFiles(paths: NodeAgentStorePaths) {
  for (const filePath of [paths.databasePath, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`]) {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  }
}

function configure(client: DatabaseSync, paths: NodeAgentStorePaths) {
  client.exec("PRAGMA foreign_keys = ON");
  client.exec("PRAGMA busy_timeout = 5000");
  client.exec("PRAGMA journal_mode = WAL");
  client.exec("PRAGMA synchronous = FULL");
  const applicationId = Number(scalar(client, "PRAGMA application_id"));
  if (applicationId === 0) client.exec(`PRAGMA application_id = ${NODE_AGENT_APPLICATION_ID}`);
  else if (applicationId !== NODE_AGENT_APPLICATION_ID) throw new Error(`Unexpected application_id ${applicationId}.`);
  if (Number(scalar(client, "PRAGMA foreign_keys")) !== 1) throw new Error("foreign_keys could not be enabled.");
  if (String(scalar(client, "PRAGMA journal_mode")).toLowerCase() !== "wal") throw new Error("WAL could not be enabled.");
  if (Number(scalar(client, "PRAGMA busy_timeout")) !== 5000) throw new Error("busy_timeout=5000 could not be enabled.");
  if (Number(scalar(client, "PRAGMA synchronous")) !== 2) throw new Error("synchronous=FULL could not be enabled.");
  if (String(scalar(client, "PRAGMA quick_check")) !== "ok") throw new Error("quick_check failed.");
  chmodDatabaseFiles(paths);
}

function migrate(client: DatabaseSync) {
  client.exec(`CREATE TABLE IF NOT EXISTS na_migration_ledger (
    id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, details TEXT NOT NULL
  )`);
  const find = client.prepare("SELECT checksum FROM na_migration_ledger WHERE id = ?");
  const insert = client.prepare("INSERT INTO na_migration_ledger (id, checksum, applied_at, details) VALUES (?, ?, ?, ?)");
  const record = (migration: NodeAgentMigration) => insert.run(
    migration.id,
    migration.checksum,
    new Date().toISOString(),
    JSON.stringify({ domain: "node-agent-story" }),
  );

  let inTransaction = false;
  const begin = () => { client.exec("BEGIN IMMEDIATE"); inTransaction = true; };
  const commit = () => { client.exec("COMMIT"); inTransaction = false; };
  const rollbackQuietly = () => {
    if (!inTransaction) return;
    try {
      client.exec("ROLLBACK");
    } finally {
      inTransaction = false;
    }
  };

  begin();
  try {
    for (const migration of nodeAgentMigrations) {
      const current = find.get(migration.id) as { checksum: string } | undefined;
      if (current) {
        if (current.checksum !== migration.checksum) throw new Error(`Migration checksum mismatch for ${migration.id}.`);
        continue;
      }
      if (migration.foreignKeysOff) {
        // 表重建必须完全关闭 FK：SQLite 在事务内不接受 `PRAGMA foreign_keys`，而
        // `ON DELETE RESTRICT` 不能被 defer，因此 DROP/RENAME 只能在 FK 关闭时执行。
        commit();
        client.exec("PRAGMA foreign_keys = OFF");
        if (Number(scalar(client, "PRAGMA foreign_keys")) !== 0) {
          throw new Error(`foreign_keys could not be disabled for migration ${migration.id}.`);
        }
        begin();
        client.exec(migration.sql);
        const violations = client.prepare("PRAGMA foreign_key_check").all();
        if (violations.length) throw new Error(`Migration ${migration.id} left ${violations.length} foreign key violation(s).`);
        record(migration);
        commit();
        client.exec("PRAGMA foreign_keys = ON");
        if (Number(scalar(client, "PRAGMA foreign_keys")) !== 1) {
          throw new Error(`foreign_keys could not be restored after migration ${migration.id}.`);
        }
        begin();
        continue;
      }
      client.exec(migration.sql);
      record(migration);
    }
    commit();
  } catch (error) {
    rollbackQuietly();
    throw error;
  }
}

export function openNodeAgentDatabaseSync(
  paths: NodeAgentStorePaths,
  options: { legacyMigration?: { rename?: (source: string, target: string) => void } } = {},
): NodeAgentDatabase {
  try {
    assertSupportedRuntimeVersion();
  } catch (error) {
    throw startupError("runtime", error);
  }
  fs.mkdirSync(path.dirname(paths.databasePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(paths.databasePath), 0o700);
  let client: DatabaseSync | undefined;
  try {
    client = new DatabaseSync(paths.databasePath);
    assertNodeSqliteCapabilities(client);
    configure(client, paths);
    migrate(client);
    migrateLegacyP0State(client, paths, options.legacyMigration);
    if (String(scalar(client, "PRAGMA quick_check")) !== "ok") throw new Error("post-migration quick_check failed.");
    chmodDatabaseFiles(paths);
    const db = drizzle({ client });
    let closed = false;
    return {
      db,
      client,
      async checkpoint() {
        if (!closed) {
          client!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          chmodDatabaseFiles(paths);
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        client!.close();
      },
    };
  } catch (error) {
    try { client?.close(); } catch {}
    throw startupError(client ? "initialize" : "connect", error);
  }
}

export async function openNodeAgentDatabase(paths: NodeAgentStorePaths): Promise<NodeAgentDatabase> {
  return openNodeAgentDatabaseSync(paths);
}
