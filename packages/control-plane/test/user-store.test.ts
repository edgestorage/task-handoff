import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CONTROL_PLANE_PERMISSION_IDS } from "@task-handoff/protocol/control-plane-access";
import { createControlPlaneUserRepository } from "../src/control-plane/auth/database/index.ts";
import { ControlPlaneUserAuthentication } from "../src/control-plane/auth/user-authentication.ts";
import { postgresqlMigrations, sqliteMigrations } from "../src/control-plane/auth/database/migrations.ts";
import { ControlPlaneUserService } from "../src/control-plane/auth/user-service.ts";
import { ControlPlaneUserStore, SYSTEM_ROLE_IDS } from "../src/control-plane/auth/user-store.ts";
import { hashControlPlanePassword } from "../src/control-plane/auth/passwords.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-user-store-"));
}

function writeRecord(directory: string, record: { id: string } & Record<string, unknown>) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

test("database setup uses canonical ordered cp-prefixed migrations per dialect", () => {
  for (const migrations of [sqliteMigrations, postgresqlMigrations]) {
    assert.deepEqual(migrations.map((migration) => migration.id), [
      "0001_user_access",
      "0002_p0_persistence",
      "0003_p0_pairing_revoke_phase",
      "0004_p0_chat_credential_metadata",
      "0005_model_legacy_projections",
      "0006_cli_sessions",
      "0007_local_trust_identities",
      "0008_model_request_mappings",
    ]);
    assert.doesNotMatch(migrations[0]!.sql, /control_plane_/);
    assert.match(migrations[0]!.sql, /CREATE TABLE cp_user_access_grants/);
    assert.match(migrations[0]!.sql, /CREATE TABLE cp_user_roles/);
    assert.doesNotMatch(migrations[0]!.sql, /role_ids (?:TEXT|JSONB)/);
    assert.match(migrations[0]!.sql, /instance_scope (?:TEXT|JSONB) NOT NULL/);
    assert.match(migrations[1]!.sql, /CREATE TABLE cp_nodes/);
    assert.match(migrations[1]!.sql, /CREATE TABLE cp_models/);
    assert.match(migrations[1]!.sql, /CREATE TABLE cp_chat_bridges/);
    assert.match(migrations[1]!.sql, /CREATE TABLE cp_git_credentials/);
  }
});

test("local trust migration preserves published identities and sessions", async () => {
  const dataDir = tempDataDir();
  const paths = controlPlaneStorePaths(dataDir);
  fs.mkdirSync(path.dirname(paths.databasePath), { recursive: true });
  const previous = new DatabaseSync(paths.databasePath);
  const timestamp = new Date().toISOString();
  try {
    previous.exec("PRAGMA foreign_keys = ON;");
    previous.exec("CREATE TABLE cp_migration_ledger (id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, details TEXT NOT NULL)");
    const insertLedger = previous.prepare("INSERT INTO cp_migration_ledger (id, checksum, applied_at, details) VALUES (?, ?, ?, ?)");
    for (const migration of sqliteMigrations.slice(0, 6)) {
      previous.exec(migration.sql);
      insertLedger.run(migration.id, migration.checksum, timestamp, JSON.stringify({ dialect: "sqlite" }));
    }
    previous.prepare("INSERT INTO cp_users (id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("user_existing", "Existing Admin", "active", timestamp, timestamp);
    previous.prepare("INSERT INTO cp_login_identities (id, user_id, kind, normalized_login_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("identity_existing", "user_existing", "local-password", "admin", "scrypt$salt$hash", timestamp, timestamp);
    previous.prepare("INSERT INTO cp_user_sessions (id, identity_id, authorization_revision, token_hash, expires_at, client_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("sess_existing", "identity_existing", 1, "existing-token-hash", "2030-01-01T00:00:00.000Z", "web", timestamp, timestamp);
  } finally {
    previous.close();
  }

  const repository = await createControlPlaneUserRepository(paths);
  try {
    const identity = await repository.identities.get("identity_existing");
    assert.equal(identity?.kind, "local-password");
    assert.equal(identity?.normalizedLoginName, "admin");
    const session = await repository.sessions.get("sess_existing");
    assert.equal(session?.identityId, "identity_existing");
    assert.equal(session?.clientType, "web");

    await repository.identities.put({ id: "identity_local", userId: "user_existing", kind: "local-trust", createdAt: timestamp, updatedAt: timestamp });
    const written = await repository.sessions.put({
      id: "sess_local",
      userId: "user_existing",
      identityId: "identity_local",
      authorizationRevision: 1,
      tokenHash: "local-token-hash",
      expiresAt: "2030-01-01T00:00:00.000Z",
      clientType: "cli",
      clientInfo: { name: "test-box", platform: "darwin" },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    assert.equal(written.identityId, "identity_local");
    assert.equal((await repository.sessions.get("sess_local"))?.clientType, "cli");
  } finally {
    await repository.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("canonical SQLite schema coexists with indexes from the previous unreleased schema", async () => {
  const dataDir = tempDataDir();
  const paths = controlPlaneStorePaths(dataDir);
  fs.mkdirSync(path.dirname(paths.databasePath), { recursive: true });
  const legacy = new DatabaseSync(paths.databasePath);
  try {
    legacy.exec(`
      CREATE TABLE control_plane_login_identities (normalized_login_name TEXT, provider_id TEXT, subject TEXT, user_id TEXT);
      CREATE UNIQUE INDEX cp_identity_login_name_uq ON control_plane_login_identities(normalized_login_name);
      CREATE UNIQUE INDEX cp_identity_provider_subject_uq ON control_plane_login_identities(provider_id, subject);
      CREATE INDEX cp_identity_user_idx ON control_plane_login_identities(user_id);
      CREATE TABLE control_plane_roles (name TEXT, status TEXT);
      CREATE UNIQUE INDEX cp_role_active_name_uq ON control_plane_roles(name, status);
      CREATE TABLE control_plane_user_sessions (token_hash TEXT, user_id TEXT, expires_at TEXT);
      CREATE UNIQUE INDEX cp_session_token_hash_uq ON control_plane_user_sessions(token_hash);
      CREATE INDEX cp_session_user_idx ON control_plane_user_sessions(user_id);
      CREATE INDEX cp_session_expiry_idx ON control_plane_user_sessions(expires_at);
      CREATE TABLE control_plane_external_identity_approvals (provider_id TEXT, subject TEXT, status TEXT);
      CREATE INDEX cp_approval_lookup_idx ON control_plane_external_identity_approvals(provider_id, subject, status);
      CREATE TABLE control_plane_user_audit (created_at TEXT);
      CREATE INDEX cp_audit_created_idx ON control_plane_user_audit(created_at);
    `);
  } finally {
    legacy.close();
  }

  const repository = await createControlPlaneUserRepository(paths);
  try {
    const database = new DatabaseSync(paths.databasePath, { readOnly: true });
    try {
      const indexes = new Map(database.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'cp_%'").all()
        .map((row) => [row.name, row.tbl_name]));
      assert.equal(indexes.get("cp_identity_login_name_uq"), "control_plane_login_identities");
      assert.equal(indexes.get("cp_login_identities_login_name_uq"), "cp_login_identities");
      assert.equal(indexes.get("cp_roles_active_name_uq"), "cp_roles");
      assert.equal(indexes.get("cp_user_sessions_token_hash_uq"), "cp_user_sessions");
      assert.equal(indexes.get("cp_external_identity_approvals_lookup_idx"), "cp_external_identity_approvals");
      assert.equal(indexes.get("cp_user_audit_created_idx"), "cp_user_audit");
    } finally {
      database.close();
    }
  } finally {
    await repository.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fresh user store defaults to SQLite and initializes canonical system roles", async () => {
  const dataDir = tempDataDir();
  const paths = controlPlaneStorePaths(dataDir);
  const store = new ControlPlaneUserStore(paths);
  try {
    assert.deepEqual(await store.init(), { initialized: false, legacyDataPresent: false, databaseDialect: "sqlite" });
    await store.initializeForBootstrap();
    assert.equal(store.state().initialized, true);
    assert.deepEqual((await store.roles.get(SYSTEM_ROLE_IDS.admin))?.permissionIds, [...CONTROL_PLANE_PERMISSION_IDS]);
    assert.equal((await store.roles.get(SYSTEM_ROLE_IDS.operator))?.system, true);
    assert.equal((await store.roles.get(SYSTEM_ROLE_IDS.viewer))?.system, true);
    const database = new DatabaseSync(paths.databasePath, { readOnly: true });
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cp_%' ORDER BY name").all().map((row) => row.name);
      assert.deepEqual(tables, [
        "cp_chat_bridges",
        "cp_chat_session_bindings",
        "cp_external_identity_approvals",
        "cp_git_audit",
        "cp_git_credential_assignments",
        "cp_git_credentials",
        "cp_git_provisioning_intents",
        "cp_identity_providers",
        "cp_login_identities",
        "cp_metadata",
        "cp_migration_ledger",
        "cp_model_legacy_projections",
        "cp_models",
        "cp_node_pairing_revocations",
        "cp_nodes",
        "cp_roles",
        "cp_user_access_grants",
        "cp_user_audit",
        "cp_user_roles",
        "cp_user_sessions",
        "cp_users",
      ]);
      assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'control_plane_%'").get().count, 0);
      const grantColumns = database.prepare("PRAGMA table_info(cp_user_access_grants)").all().map((row) => row.name);
      const sessionColumns = database.prepare("PRAGMA table_info(cp_user_sessions)").all().map((row) => row.name);
      assert.deepEqual(grantColumns.includes("id"), false);
      assert.deepEqual(grantColumns.includes("role_ids"), false);
      assert.deepEqual(sessionColumns.includes("user_id"), false);
    } finally {
      database.close();
    }
  } finally {
    await store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("v0.0.21 users plus v0.0.24 memberships import idempotently without changing source JSON", async () => {
  const dataDir = tempDataDir();
  const paths = controlPlaneStorePaths(dataDir);
  const timestamp = new Date().toISOString();
  const user = {
    id: "user_legacy",
    username: "LegacyAdmin",
    // Compatibility fixture for v0.0.24: this derived field must be ignored
    // rather than making the historical JSON unreadable.
    normalizedUsername: "legacyadmin",
    futureServerField: { ignored: true },
    passwordHash: await hashControlPlanePassword("legacy-password-123"),
    role: "admin",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const session = {
    id: "sess_legacy",
    userId: user.id,
    tokenHash: "legacy-token-hash",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    clientType: "web",
    futureServerField: "ignored",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  writeRecord(paths.authUsersDir, user);
  writeRecord(paths.authSessionsDir, session);
  writeRecord(paths.authMembershipsDir, {
    id: "membership_legacy",
    subject: { type: "local-user", userId: user.id, futureSubjectField: true },
    role: "admin",
    nodeScope: { kind: "all" },
    status: "active",
    authorizationRevision: 3,
    futureServerField: "ignored",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const originalUserJson = fs.readFileSync(path.join(paths.authUsersDir, `${user.id}.json`), "utf8");
  const store = new ControlPlaneUserStore(paths);
  try {
    const state = await store.init();
    assert.equal(state.initialized, true);
    assert.equal(state.legacyDataPresent, true);
    assert.equal((await store.users.get(user.id))?.displayName, user.username);
    assert.equal((await store.identities.list())[0]?.passwordHash, user.passwordHash);
    assert.deepEqual((await store.grants.get(user.id))?.roleIds, [SYSTEM_ROLE_IDS.admin]);
    assert.deepEqual((await store.grants.get(user.id))?.instanceScope, { kind: "inherit-node-scope" });
    assert.equal((await store.grants.get(user.id))?.authorizationRevision, 3);
    assert.equal((await store.sessions.get(session.id))?.tokenHash, session.tokenHash);
    assert.equal((await store.sessions.get(session.id))?.authorizationRevision, 3);
    assert.equal(fs.readFileSync(path.join(paths.authUsersDir, `${user.id}.json`), "utf8"), originalUserJson);
  } finally {
    await store.close();
  }

  const users = new ControlPlaneUserService(paths);
  try {
    await users.init();
    const auth = new ControlPlaneUserAuthentication(users);
    const login = await auth.loginLocal({ username: "legacyadmin", password: "legacy-password-123" });
    assert.equal(login.user.id, user.id);
    assert.equal((await users.store.users.list()).length, 1);
    assert.equal((await users.store.sessions.list()).filter((current) => current.id === session.id).length, 1);
    assert.equal(fs.readFileSync(path.join(paths.authUsersDir, `${user.id}.json`), "utf8"), originalUserJson);
  } finally {
    await users.store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("normalized v0.0.21 username conflicts abort the whole import", async () => {
  const dataDir = tempDataDir();
  const paths = controlPlaneStorePaths(dataDir);
  const timestamp = new Date().toISOString();
  const passwordHash = await hashControlPlanePassword("legacy-password-123");
  writeRecord(paths.authUsersDir, {
    id: "user_first",
    username: "Legacy.Admin",
    passwordHash,
    role: "admin",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  writeRecord(paths.authUsersDir, {
    id: "user_second",
    username: "legacy.admin",
    passwordHash,
    role: "viewer",
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const store = new ControlPlaneUserStore(paths);
  try {
    await assert.rejects(() => store.init(), {
      code: "CONTROL_PLANE_LEGACY_AUTH_IMPORT_FAILED",
      message: /collide after normalization/,
    });
    const clean = new ControlPlaneUserStore(paths);
    fs.rmSync(paths.authUsersDir, { recursive: true, force: true });
    try {
      await clean.init();
      assert.equal((await clean.users.list()).length, 0);
      assert.equal((await clean.identities.list()).length, 0);
      assert.equal((await clean.grants.list()).length, 0);
    } finally {
      await clean.close();
    }
  } finally {
    await store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("invalid v0.0.21 JSON aborts import and leaves an empty SQL store", async () => {
  const dataDir = tempDataDir();
  const paths = controlPlaneStorePaths(dataDir);
  fs.mkdirSync(paths.authUsersDir, { recursive: true });
  fs.writeFileSync(path.join(paths.authUsersDir, "user_invalid.json"), "{}\n");
  const first = new ControlPlaneUserStore(paths);
  await assert.rejects(() => first.init(), { code: "CONTROL_PLANE_LEGACY_AUTH_IMPORT_FAILED" });

  fs.rmSync(paths.authUsersDir, { recursive: true, force: true });
  const second = new ControlPlaneUserStore(paths);
  try {
    const state = await second.init();
    assert.equal(state.initialized, false);
    assert.equal((await second.users.list()).length, 0);
    assert.equal((await second.sessions.list()).length, 0);
  } finally {
    await second.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
