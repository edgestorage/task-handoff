import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONTROL_PLANE_PERMISSION_IDS } from "@task-handoff/protocol/control-plane-access";
import { ControlPlaneUserAuthentication } from "../src/control-plane/auth/user-authentication.ts";
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

test("fresh user store defaults to SQLite and initializes canonical system roles", async () => {
  const dataDir = tempDataDir();
  const store = new ControlPlaneUserStore(controlPlaneStorePaths(dataDir));
  try {
    assert.deepEqual(await store.init(), { initialized: false, legacyDataPresent: false, databaseDialect: "sqlite" });
    await store.initializeForBootstrap();
    assert.equal(store.state().initialized, true);
    assert.deepEqual(store.roles.get(SYSTEM_ROLE_IDS.admin)?.permissionIds, [...CONTROL_PLANE_PERMISSION_IDS]);
    assert.equal(store.roles.get(SYSTEM_ROLE_IDS.operator)?.system, true);
    assert.equal(store.roles.get(SYSTEM_ROLE_IDS.viewer)?.system, true);
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
    assert.equal(store.users.get(user.id)?.displayName, user.username);
    assert.equal(store.identities.list()[0]?.passwordHash, user.passwordHash);
    assert.deepEqual(store.grants.get(user.id)?.roleIds, [SYSTEM_ROLE_IDS.admin]);
    assert.equal(store.grants.get(user.id)?.authorizationRevision, 3);
    assert.equal(store.sessions.get(session.id)?.tokenHash, session.tokenHash);
    assert.equal(store.sessions.get(session.id)?.authorizationRevision, 3);
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
    assert.equal(users.store.users.list().length, 1);
    assert.equal(users.store.sessions.list().filter((current) => current.id === session.id).length, 1);
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
      assert.equal(clean.users.list().length, 0);
      assert.equal(clean.identities.list().length, 0);
      assert.equal(clean.grants.list().length, 0);
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
    assert.equal(second.users.list().length, 0);
    assert.equal(second.sessions.list().length, 0);
  } finally {
    await second.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
