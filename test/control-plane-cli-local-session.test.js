const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const { createControlPlaneApp } = require("../packages/control-plane/src/server.ts");
const { controlPlaneStorePaths } = require("../packages/control-plane/src/control-plane/persistence/paths.ts");

const CLIENT = { name: "dev-mac", platform: "darwin", version: "1.0.0" };

function tempDataDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-${name}-`));
}

async function bootstrapAdmin(app) {
  const response = await app.inject({ method: "POST", url: "/api/auth/bootstrap-admin", payload: { username: "admin", password: "password123" } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().data;
}

async function webLogin(app) {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "password123" } });
  assert.equal(response.statusCode, 200, response.body);
  return response.headers["set-cookie"];
}

function auditActions(dataDir) {
  const database = new DatabaseSync(path.join(controlPlaneStorePaths(dataDir).databasePath));
  try {
    return database.prepare("select action, actor_user_id, target_type from cp_user_audit order by created_at").all();
  } finally {
    database.close();
  }
}

test("disabled control plane issues an auditable local cli session to loopback", async (t) => {
  const dataDir = tempDataDir("cp-cli-local");
  const app = await createControlPlaneApp({ dataDir, logger: false, auth: { mode: "disabled" } });
  t.after(() => app.close());

  const identity = await app.inject({ method: "GET", url: "/api/control-plane/identity" });
  assert.equal(identity.statusCode, 200, identity.body);
  const capabilities = identity.json().data.payload.capabilities;
  assert.equal(capabilities.authentication, "disabled");
  assert.equal(capabilities.localCliSessions, true);
  assert.equal(capabilities.cliSessions, false);

  const first = await app.inject({ method: "POST", url: "/api/auth/cli/local", payload: { client: CLIENT } });
  assert.equal(first.statusCode, 200, first.body);
  const { sessionToken, session, authorization } = first.json().data;
  assert.match(sessionToken, /^csess_[^.]+\.[A-Za-z0-9_-]+$/);
  assert.equal(session.clientType, "cli");
  assert.deepEqual(session.client, CLIENT);
  assert.equal(session.user.displayName, "Local Operator");
  assert.equal(session.user.primaryUsername, undefined);
  assert.equal(authorization.nodeScope.kind, "all");
  assert.ok(authorization.permissionIds.includes("instances:manage"));
  assert.ok(authorization.permissionIds.includes("users:manage"));

  const current = await app.inject({ method: "GET", url: "/api/auth/session", headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(current.json().data.authenticated, true);
  assert.equal(current.json().data.user.id, session.user.id);
  assert.equal(current.json().data.authorization.userId, session.user.id);
  const access = await app.inject({ method: "GET", url: "/api/access/me", headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(access.statusCode, 200, access.body);
  assert.equal(access.json().data.userId, session.user.id);

  const anonymous = await app.inject({ method: "GET", url: "/api/projects", headers: { authorization: "Bearer not-a-session.token" } });
  assert.equal(anonymous.statusCode, 200, anonymous.body);
  const authorized = await app.inject({ method: "GET", url: "/api/projects", headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(authorized.statusCode, 200, authorized.body);

  const second = await app.inject({ method: "POST", url: "/api/auth/cli/local", payload: { client: CLIENT } });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().data.session.user.id, session.user.id);
  assert.notEqual(second.json().data.session.id, session.id);
  const sessions = await app.inject({ method: "GET", url: "/api/auth/cli/sessions", headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(sessions.statusCode, 200, sessions.body);
  assert.deepEqual(sessions.json().data.map((entry) => entry.id).sort(), [session.id, second.json().data.session.id].sort());

  const remote = await app.inject({ method: "POST", url: "/api/auth/cli/local", payload: { client: CLIENT }, remoteAddress: "10.1.2.3" });
  assert.equal(remote.statusCode, 403, remote.body);
  assert.equal(remote.json().error.code, "AUTH_LOCAL_SESSION_NOT_LOCAL");
  const invalid = await app.inject({ method: "POST", url: "/api/auth/cli/local", payload: { client: { name: "dev-mac" } } });
  assert.equal(invalid.statusCode, 400, invalid.body);

  const audit = auditActions(dataDir);
  assert.deepEqual(audit.map((entry) => entry.action), [
    "cli-local-session.operator-create",
    "cli-local-session.create",
    "cli-local-session.create",
  ]);
  assert.ok(audit.every((entry) => entry.actor_user_id === session.user.id));

  const logout = await app.inject({ method: "POST", url: "/api/auth/cli/logout", headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(logout.statusCode, 200, logout.body);
  const afterLogout = await app.inject({ method: "GET", url: "/api/auth/session", headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(afterLogout.json().data.authenticated, true);
  assert.equal(afterLogout.json().data.user, undefined);
});

test("local sessions stay closed for pw-authenticated control planes and keep bootstrap usable", async (t) => {
  const dataDir = tempDataDir("cp-cli-local-switch");
  const disabled = await createControlPlaneApp({ dataDir, logger: false, auth: { mode: "disabled" } });
  const issued = await disabled.inject({ method: "POST", url: "/api/auth/cli/local", payload: { client: CLIENT } });
  assert.equal(issued.statusCode, 200, issued.body);
  const operatorUserId = issued.json().data.session.user.id;
  await disabled.close();

  const secured = await createControlPlaneApp({ dataDir, logger: false, auth: { mode: "password" } });
  t.after(() => secured.close());

  const identity = await secured.inject({ method: "GET", url: "/api/control-plane/identity" });
  const capabilities = identity.json().data.payload.capabilities;
  assert.equal(capabilities.cliSessions, true);
  assert.equal(capabilities.localCliSessions, false);

  const session = await secured.inject({ method: "GET", url: "/api/auth/session" });
  assert.equal(session.statusCode, 200, session.body);
  assert.equal(session.json().data.requiresBootstrap, true);

  const refused = await secured.inject({ method: "POST", url: "/api/auth/cli/local", payload: { client: CLIENT } });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().error.code, "AUTH_LOCAL_SESSION_UNAVAILABLE");

  const admin = await bootstrapAdmin(secured);
  const cookie = await webLogin(secured);
  const detail = await secured.inject({ method: "GET", url: `/api/users/${operatorUserId}`, headers: { cookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  const identitySummary = detail.json().data.identities.find((entry) => entry.kind === "local-trust");
  assert.ok(identitySummary);
  assert.equal(identitySummary.providerId, undefined);
  assert.equal(identitySummary.loginName, undefined);

  const archived = await secured.inject({ method: "PATCH", url: `/api/users/${admin.id}`, headers: { cookie }, payload: { status: "archived" } });
  assert.equal(archived.statusCode, 409, archived.body);
  assert.equal(archived.json().error.code, "CONTROL_PLANE_LAST_ACTIVE_ADMIN");
});
