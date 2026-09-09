import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneUserAuthentication } from "../src/control-plane/auth/user-authentication.ts";
import { ControlPlaneUserService } from "../src/control-plane/auth/user-service.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-user-authentication-"));
  const users = new ControlPlaneUserService(controlPlaneStorePaths(dataDir));
  const auth = new ControlPlaneUserAuthentication(users, { maxFailuresPerUsername: 2 });
  return { users, auth, dispose: async () => { await users.store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("local login creates a session bound to user identity and authorization revision", async () => {
  const current = fixture();
  try {
    const user = await current.users.bootstrapAdmin({ username: "admin", password: "password123" });
    const login = await current.auth.loginLocal({ username: "ADMIN", password: "password123" }, { sourceId: "test" });
    assert.equal(login.user.id, user.id);
    assert.equal(login.authorization.userId, user.id);
    assert.equal(login.authorization.identityId, user.identities[0].id);
    assert.equal(login.session.identityId, user.identities[0].id);
    assert.equal((await current.auth.resolve(login.sessionToken))?.authorization.authorizationRevision, 1);
  } finally {
    await current.dispose();
  }
});

test("authorization change invalidates an existing session", async () => {
  const current = fixture();
  try {
    const user = await current.users.bootstrapAdmin({ username: "admin", password: "password123" });
    const login = await current.auth.loginLocal({ username: "admin", password: "password123" });
    await current.users.setAccess(user.id, {
      roleIds: user.accessGrant.roleIds,
      nodeScope: { kind: "all" },
      expectedAuthorizationRevision: 1,
    });
    assert.equal(await current.auth.resolve(login.sessionToken), undefined);
  } finally {
    await current.dispose();
  }
});

test("temporary-password sessions remain restricted until the password is changed", async () => {
  const current = fixture();
  try {
    await current.users.bootstrapAdmin({ username: "admin", password: "password123" });
    const user = await current.users.createLocalUser({
      username: "operator",
      password: "temporary-password",
      roleIds: ["role_operator"],
      nodeScope: { kind: "all" },
      requirePasswordChange: true,
    });
    const login = await current.auth.loginLocal({ username: "operator", password: "temporary-password" });
    assert.equal(login.requiresPasswordChange, true);
    assert.equal((await current.auth.currentSession(login.sessionToken))?.requiresPasswordChange, true);
    await assert.rejects(() => current.auth.createSessionForIdentity(user.identities[0].id, "mobile", {
      id: "device_temporary_password",
      name: "Phone",
      platform: "ios",
    }), { code: "AUTH_PASSWORD_CHANGE_REQUIRED" });

    const changed = await current.auth.changeLocalPassword(login.sessionToken, {
      currentPassword: "temporary-password",
      newPassword: "permanent-password",
    });
    assert.equal(changed.requiresPasswordChange, false);
    assert.equal((await current.auth.currentSession(changed.sessionToken))?.requiresPasswordChange, false);
  } finally {
    await current.dispose();
  }
});

test("resolving a session tracks activity without persisting the session", async () => {
  const current = fixture();
  try {
    await current.users.bootstrapAdmin({ username: "admin", password: "password123" });
    const login = await current.auth.loginLocal({ username: "admin", password: "password123" });
    const sessionId = login.session.id;
    assert.equal((await current.users.store.sessions.get(sessionId))?.lastSeenAt, undefined);

    let writes = 0;
    const put = current.users.store.sessions.put.bind(current.users.store.sessions);
    current.users.store.sessions.put = (record) => {
      writes += 1;
      return put(record);
    };

    const resolved = await current.auth.resolve(login.sessionToken);
    assert.equal(writes, 0);
    assert.equal((await current.users.store.sessions.get(sessionId))?.lastSeenAt, undefined);
    assert.equal(resolved?.session.lastSeenAt, (await current.auth.listSessions(resolved!.user.id))[0]?.lastSeenAt);
  } finally {
    await current.dispose();
  }
});

test("mobile session renewal extends only sessions inside the renewal window", async () => {
  const current = fixture();
  try {
    await current.users.bootstrapAdmin({ username: "admin", password: "password123" });
    const login = await current.auth.loginLocal({ username: "admin", password: "password123" }, {
      clientType: "mobile",
      device: { id: "device_renewal", name: "Phone", platform: "ios" },
    });
    const initial = (await current.users.store.sessions.get(login.session.id))!;
    const nearExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await current.users.store.sessions.put({ ...initial, expiresAt: nearExpiry });

    const renewed = await current.auth.renewMobileSession(login.sessionToken);
    assert.ok(renewed);
    assert.ok(Date.parse(renewed.expiresAt) > Date.parse(nearExpiry));
    assert.equal((await current.auth.resolve(login.sessionToken, "mobile"))?.session.expiresAt, renewed.expiresAt);

    const farExpiry = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    await current.users.store.sessions.put({ ...(await current.users.store.sessions.get(login.session.id))!, expiresAt: farExpiry });
    assert.deepEqual(await current.auth.renewMobileSession(login.sessionToken), { expiresAt: farExpiry });
    assert.equal((await current.users.store.sessions.get(login.session.id))?.expiresAt, farExpiry);
  } finally {
    await current.dispose();
  }
});

test("mobile session renewal rejects Web and expired credentials", async () => {
  const current = fixture();
  try {
    await current.users.bootstrapAdmin({ username: "admin", password: "password123" });
    const web = await current.auth.loginLocal({ username: "admin", password: "password123" });
    assert.equal(await current.auth.renewMobileSession(web.sessionToken), undefined);
    const mobile = await current.auth.loginLocal({ username: "admin", password: "password123" }, {
      clientType: "mobile",
      device: { id: "device_expired", name: "Phone", platform: "ios" },
    });
    const stored = (await current.users.store.sessions.get(mobile.session.id))!;
    await current.users.store.sessions.put({ ...stored, expiresAt: new Date(Date.now() - 1_000).toISOString() });
    assert.equal(await current.auth.renewMobileSession(mobile.sessionToken), undefined);
  } finally {
    await current.dispose();
  }
});

test("v0.0.28 mobile session probes renew without changing the session response", async () => {
  const current = fixture();
  try {
    await current.users.bootstrapAdmin({ username: "admin", password: "password123" });
    const login = await current.auth.loginLocal({ username: "admin", password: "password123" }, {
      clientType: "mobile",
      device: { id: "device_legacy", name: "Phone", platform: "ios" },
    });
    const stored = (await current.users.store.sessions.get(login.session.id))!;
    const nearExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await current.users.store.sessions.put({ ...stored, expiresAt: nearExpiry });

    const session = await current.auth.currentSession(login.sessionToken, "mobile");
    assert.equal(session.authenticated, true);
    assert.ok(Date.parse((await current.users.store.sessions.get(login.session.id))!.expiresAt) > Date.parse(nearExpiry));
    assert.equal("sessionToken" in session, false);
    assert.equal("expiresAt" in session, false);
  } finally {
    await current.dispose();
  }
});

test("local login has a uniform failure and rate limit", async () => {
  const current = fixture();
  try {
    await current.users.bootstrapAdmin({ username: "admin", password: "password123" });
    await assert.rejects(() => current.auth.loginLocal({ username: "missing", password: "bad" }, { sourceId: "one" }), { code: "AUTH_LOGIN_FAILED" });
    await assert.rejects(() => current.auth.loginLocal({ username: "missing", password: "bad" }, { sourceId: "one" }), { code: "AUTH_LOGIN_FAILED" });
    await assert.rejects(() => current.auth.loginLocal({ username: "missing", password: "bad" }, { sourceId: "one" }), { code: "AUTH_LOGIN_RATE_LIMITED" });
  } finally {
    await current.dispose();
  }
});
