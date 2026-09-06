import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import type { NodeAgentStorePaths } from "../../persistence/paths.ts";
import { nodeAgentMigrations } from "./migrations.ts";
import * as schema from "./schema.ts";

const NODE_AGENT_APPLICATION_ID = 0x54484e41;
const MINIMUM_NODE_VERSION = { major: 24, minor: 15 } as const;

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

function assertSupportedNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (major !== MINIMUM_NODE_VERSION.major || minor < MINIMUM_NODE_VERSION.minor) {
    throw new Error(`Node.js 24.15 or newer within the Node.js 24 release line is required; received ${version}.`);
  }
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
  client.exec("BEGIN IMMEDIATE");
  try {
    const find = client.prepare("SELECT checksum FROM na_migration_ledger WHERE id = ?");
    const insert = client.prepare("INSERT INTO na_migration_ledger (id, checksum, applied_at, details) VALUES (?, ?, ?, ?)");
    for (const migration of nodeAgentMigrations) {
      const current = find.get(migration.id) as { checksum: string } | undefined;
      if (current) {
        if (current.checksum !== migration.checksum) throw new Error(`Migration checksum mismatch for ${migration.id}.`);
        continue;
      }
      client.exec(migration.sql);
      insert.run(migration.id, migration.checksum, new Date().toISOString(), JSON.stringify({ domain: "node-agent-story" }));
    }
    client.exec("COMMIT");
  } catch (error) {
    client.exec("ROLLBACK");
    throw error;
  }
}

export async function openNodeAgentDatabase(paths: NodeAgentStorePaths): Promise<NodeAgentDatabase> {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    throw startupError("runtime", error);
  }
  fs.mkdirSync(path.dirname(paths.databasePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(paths.databasePath), 0o700);
  let client: DatabaseSync | undefined;
  try {
    client = new DatabaseSync(paths.databasePath);
    configure(client, paths);
    migrate(client);
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
