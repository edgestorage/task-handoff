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

test("resolving a session tracks activity without persisting the session", async () => {
  const current = fixture();
  try {
    await current.users.bootstrapAdmin({ username: "admin", password: "password123" });
    const login = await current.auth.loginLocal({ username: "admin", password: "password123" });
    const sessionId = login.session.id;
    assert.equal(current.users.store.sessions.get(sessionId)?.lastSeenAt, undefined);

    let writes = 0;
    const put = current.users.store.sessions.put.bind(current.users.store.sessions);
    current.users.store.sessions.put = (record) => {
      writes += 1;
      return put(record);
    };

    const resolved = await current.auth.resolve(login.sessionToken);
    assert.equal(writes, 0);
    assert.equal(current.users.store.sessions.get(sessionId)?.lastSeenAt, undefined);
    assert.equal(resolved?.session.lastSeenAt, current.auth.listSessions(resolved!.user.id)[0]?.lastSeenAt);
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
