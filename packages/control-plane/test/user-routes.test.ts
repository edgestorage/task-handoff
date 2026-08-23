import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createControlPlaneApp } from "../src/control-plane/http/server.ts";

const dataDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

async function passwordApp(t: TestContext) {
  const app = await createControlPlaneApp({ dataDir: dataDir("user-routes"), logger: false, staticDir: path.join(os.tmpdir(), "missing-control-plane-ui"), auth: { mode: "password" } });
  t.after(() => app.close());
  const bootstrap = await app.inject({ method: "POST", url: "/api/auth/bootstrap-admin", payload: { username: "Admin", password: "password123" } });
  assert.equal(bootstrap.statusCode, 201);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "password123" } });
  assert.equal(login.statusCode, 200);
  return { app, cookie: String(login.headers["set-cookie"]) };
}

test("access management capability is advertised only when authentication is enabled", async (t) => {
  const disabled = await createControlPlaneApp({ dataDir: dataDir("users-disabled"), logger: false, staticDir: path.join(os.tmpdir(), "missing-control-plane-ui"), auth: { mode: "disabled" } });
  t.after(() => disabled.close());
  const disabledIdentity = await disabled.inject({ method: "GET", url: "/api/control-plane/identity" });
  assert.equal(disabledIdentity.json().data.payload.capabilities.accessManagement, undefined);

  const { app } = await passwordApp(t);
  const identity = await app.inject({ method: "GET", url: "/api/control-plane/identity" });
  assert.deepEqual(identity.json().data.payload.capabilities.accessManagement.userManagement, { users: true, identities: true, sessions: true });
});

test("user management routes create accounts and enforce permission plus node scope", async (t) => {
  const { app, cookie } = await passwordApp(t);
  const created = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie },
    payload: { username: "alice", password: "password456", displayName: "Alice", roleIds: ["role_operator"], nodeScope: { kind: "selected", nodeIds: ["node-a"] }, requirePasswordChange: false },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().data.primaryUsername, "alice");
  assert.deepEqual(created.json().data.accessGrant.roleIds, ["role_operator"]);
  assert.deepEqual(created.json().data.accessGrant.nodeScope, { kind: "selected", nodeIds: ["node-a"] });

  const users = await app.inject({ method: "GET", url: "/api/users", headers: { cookie } });
  assert.equal(users.statusCode, 200);
  assert.equal(users.json().data.some((user: { primaryUsername?: string }) => user.primaryUsername === "alice"), true);

  const renamed = await app.inject({
    method: "PATCH",
    url: `/api/users/${created.json().data.id}`,
    headers: { cookie },
    payload: { displayName: "Alice Doe", username: "Alice.New" },
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().data.displayName, "Alice Doe");
  assert.equal(renamed.json().data.primaryUsername, "alice.new");
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "password456" } })).statusCode, 401);

  const aliceLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ALICE.NEW", password: "password456" } });
  assert.equal(aliceLogin.statusCode, 200);
  const aliceCookie = String(aliceLogin.headers["set-cookie"]);
  const authorization = await app.inject({ method: "GET", url: "/api/access/me", headers: { cookie: aliceCookie } });
  assert.equal(authorization.statusCode, 200);
  assert.equal(authorization.json().data.permissionIds.includes("instances:manage"), true);
  assert.deepEqual(authorization.json().data.nodeScope, { kind: "selected", nodeIds: ["node-a"] });

  const forbidden = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: aliceCookie } });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error.code, "CONTROL_PLANE_FORBIDDEN");

  const alice = created.json().data;
  const localIdentity = alice.identities.find((identity: { kind: string }) => identity.kind === "local-password");
  assert.ok(localIdentity);
  const localUnbind = await app.inject({ method: "DELETE", url: `/api/users/${alice.id}/identities/${localIdentity.id}`, headers: { cookie } });
  assert.equal(localUnbind.statusCode, 409);
  assert.equal(localUnbind.json().error.code, "CONTROL_PLANE_LOCAL_IDENTITY_IMMUTABLE");

  const manualBind = await app.inject({ method: "POST", url: `/api/users/${alice.id}/identities`, headers: { cookie }, payload: { providerId: "provider", subject: "subject", kind: "oauth" } });
  assert.equal(manualBind.statusCode, 404);
});

test("temporary-password Web sessions can only change password or sign out", async (t) => {
  const { app, cookie } = await passwordApp(t);
  const created = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie },
    payload: {
      username: "temporary",
      password: "temporary-password",
      roleIds: ["role_operator"],
      nodeScope: { kind: "all" },
      requirePasswordChange: true,
    },
  });
  assert.equal(created.statusCode, 201, created.body);

  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "temporary", password: "temporary-password" } });
  const temporaryCookie = String(login.headers["set-cookie"]);
  const session = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: temporaryCookie } });
  assert.equal(session.json().data.requiresPasswordChange, true);

  const blocked = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: temporaryCookie } });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error.code, "AUTH_PASSWORD_CHANGE_REQUIRED");

  const changed = await app.inject({
    method: "PATCH",
    url: "/api/auth/password",
    headers: { cookie: temporaryCookie },
    payload: { currentPassword: "temporary-password", newPassword: "permanent-password" },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const renewedCookie = String(changed.headers["set-cookie"]);
  assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: renewedCookie } })).statusCode, 200);
});
