const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const { createControlPlaneApp } = require("../packages/control-plane/src/server.ts");
const { sqliteMigrations } = require("../packages/control-plane/src/control-plane/auth/database/migrations.ts");
const { controlPlaneStorePaths } = require("../packages/control-plane/src/control-plane/persistence/paths.ts");

const HOST = "control-plane.test";
const ORIGIN = `http://${HOST}`;

function tempDataDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-${name}-`));
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

async function bootstrapAdmin(app) {
  const response = await app.inject({ method: "POST", url: "/api/auth/bootstrap-admin", payload: { username: "admin", password: "password123" } });
  assert.equal(response.statusCode, 201, response.body);
}

async function webLogin(app) {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "password123" } });
  assert.equal(response.statusCode, 200, response.body);
  return response.headers["set-cookie"];
}

function browserAuthorization(overrides = {}) {
  const { verifier, challenge } = pkce();
  return {
    verifier,
    payload: {
      mode: "browser",
      client: { name: "dev-mac", platform: "darwin", version: "0.1.0" },
      redirectUri: "http://127.0.0.1:49152/callback",
      state: "cli-state-0123456789",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      ...overrides,
    },
  };
}

function decisionHeaders(cookie, extra = {}) {
  return { cookie, host: HOST, origin: ORIGIN, "sec-fetch-site": "same-origin", ...extra };
}

test("cli browser authorization exchanges a web approval for an independent cli session", async (t) => {
  const app = await createControlPlaneApp({ dataDir: tempDataDir("cp-cli-browser"), logger: false, auth: { mode: "password" } });
  t.after(() => app.close());
  await bootstrapAdmin(app);
  const cookie = await webLogin(app);

  const { verifier, payload } = browserAuthorization();
  const authorize = await app.inject({ method: "POST", url: "/api/auth/cli/authorize", payload });
  assert.equal(authorize.statusCode, 200, authorize.body);
  const authorization = authorize.json().data;
  assert.equal(authorization.mode, "browser");
  assert.match(authorization.verificationUri, /\/cli\/authorize\?request=/);
  assert.ok(Date.parse(authorization.expiresAt) > Date.now());

  const pending = await app.inject({
    method: "POST",
    url: "/api/auth/cli/token",
    payload: { grantType: "authorization_code", requestId: authorization.requestId, code: "not-approved", codeVerifier: verifier },
  });
  assert.equal(pending.statusCode, 400, pending.body);
  assert.equal(pending.json().error.code, "CLI_AUTHORIZATION_PENDING");

  const detail = await app.inject({ method: "GET", url: `/api/auth/cli/requests/${authorization.requestId}`, headers: { cookie, host: HOST } });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().data.status, "pending");
  assert.deepEqual(detail.json().data.client, { name: "dev-mac", platform: "darwin", version: "0.1.0" });
  assert.equal(detail.json().data.mode, "browser");

  const missingOrigin = await app.inject({
    method: "POST",
    url: `/api/auth/cli/requests/${authorization.requestId}/approve`,
    headers: { cookie, host: HOST },
    payload: {},
  });
  assert.equal(missingOrigin.statusCode, 403, missingOrigin.body);
  const foreignOrigin = await app.inject({
    method: "POST",
    url: `/api/auth/cli/requests/${authorization.requestId}/approve`,
    headers: decisionHeaders(cookie, { origin: "http://evil.test" }),
    payload: {},
  });
  assert.equal(foreignOrigin.statusCode, 403, foreignOrigin.body);

  const approve = await app.inject({
    method: "POST",
    url: `/api/auth/cli/requests/${authorization.requestId}/approve`,
    headers: decisionHeaders(cookie),
    payload: {},
  });
  assert.equal(approve.statusCode, 200, approve.body);
  const callback = new URL(approve.json().data.redirectUri);
  assert.equal(`${callback.origin}${callback.pathname}`, "http://127.0.0.1:49152/callback");
  assert.equal(callback.searchParams.get("state"), "cli-state-0123456789");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const wrongVerifier = await app.inject({
    method: "POST",
    url: "/api/auth/cli/token",
    payload: { grantType: "authorization_code", requestId: authorization.requestId, code, codeVerifier: pkce().verifier },
  });
  assert.equal(wrongVerifier.statusCode, 400, wrongVerifier.body);
  assert.equal(wrongVerifier.json().error.code, "CLI_AUTHORIZATION_INVALID_GRANT");

  const exchanged = await app.inject({
    method: "POST",
    url: "/api/auth/cli/token",
    payload: { grantType: "authorization_code", requestId: authorization.requestId, code, codeVerifier: verifier },
  });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  const { sessionToken, session } = exchanged.json().data;
  assert.match(sessionToken, /^csess_[^.]+\.[A-Za-z0-9_-]+$/);
  assert.equal(session.clientType, "cli");
  assert.deepEqual(session.client, { name: "dev-mac", platform: "darwin", version: "0.1.0" });
  assert.equal(session.user.primaryUsername, "admin");
  assert.equal("tokenHash" in session, false);

  const authorized = await app.inject({ method: "GET", url: "/api/projects", headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(authorized.statusCode, 200, authorized.body);
  const cliSessions = await app.inject({ method: "GET", url: "/api/auth/cli/sessions", headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(cliSessions.statusCode, 200, cliSessions.body);
  assert.deepEqual(cliSessions.json().data.map((entry) => entry.id), [session.id]);
  const mobileRoute = await app.inject({ method: "POST", url: "/api/auth/mobile/renew", headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(mobileRoute.statusCode, 401, mobileRoute.body);
  const webCookieAsCli = await app.inject({ method: "GET", url: "/api/auth/cli/sessions", headers: { cookie } });
  assert.equal(webCookieAsCli.statusCode, 401, webCookieAsCli.body);

  const reuse = await app.inject({
    method: "POST",
    url: "/api/auth/cli/token",
    payload: { grantType: "authorization_code", requestId: authorization.requestId, code, codeVerifier: verifier },
  });
  assert.equal(reuse.statusCode, 409, reuse.body);
  assert.equal(reuse.json().error.code, "CLI_AUTHORIZATION_ALREADY_USED");

  const webSession = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
  assert.equal(webSession.json().data.authenticated, true);
  const logout = await app.inject({ method: "POST", url: "/api/auth/cli/logout", headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(logout.statusCode, 200, logout.body);
  const afterLogout = await app.inject({ method: "GET", url: "/api/projects", headers: { authorization: `Bearer ${sessionToken}` } });
  assert.equal(afterLogout.statusCode, 401, afterLogout.body);
});

test("cli device authorization reports pending, slow down, denial and expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const app = await createControlPlaneApp({ dataDir: tempDataDir("cp-cli-device"), logger: false, auth: { mode: "password" } });
  t.after(() => app.close());
  await bootstrapAdmin(app);
  const cookie = await webLogin(app);
  const client = { name: "ssh-box", platform: "linux", version: "0.1.0" };

  const authorize = await app.inject({ method: "POST", url: "/api/auth/cli/authorize", payload: { mode: "device", client } });
  assert.equal(authorize.statusCode, 200, authorize.body);
  const authorization = authorize.json().data;
  assert.equal(authorization.mode, "device");
  assert.match(authorization.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(authorization.verificationUriComplete, new RegExp(`user_code=${authorization.userCode}$`));
  assert.equal(authorization.intervalSeconds, 5);

  const poll = (requestId) => app.inject({ method: "POST", url: "/api/auth/cli/token", payload: { grantType: "urn:ietf:params:oauth:grant-type:device_code", requestId } });
  const firstPoll = await poll(authorization.requestId);
  assert.equal(firstPoll.statusCode, 400, firstPoll.body);
  assert.equal(firstPoll.json().error.code, "CLI_AUTHORIZATION_PENDING");
  const fastPoll = await poll(authorization.requestId);
  assert.equal(fastPoll.statusCode, 400, fastPoll.body);
  assert.equal(fastPoll.json().error.code, "CLI_AUTHORIZATION_SLOW_DOWN");
  assert.equal(fastPoll.json().error.details.intervalSeconds, 10);

  const byUserCode = await app.inject({ method: "GET", url: `/api/auth/cli/requests?userCode=${authorization.userCode}`, headers: { cookie, host: HOST } });
  assert.equal(byUserCode.statusCode, 200, byUserCode.body);
  assert.equal(byUserCode.json().data.requestId, authorization.requestId);
  assert.equal(byUserCode.json().data.status, "pending");
  const approve = await app.inject({
    method: "POST",
    url: `/api/auth/cli/requests/${authorization.requestId}/approve`,
    headers: decisionHeaders(cookie),
    payload: {},
  });
  assert.equal(approve.statusCode, 200, approve.body);
  assert.deepEqual(approve.json().data, { mode: "device" });

  t.mock.timers.tick(11_000);
  const exchanged = await poll(authorization.requestId);
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  assert.equal(exchanged.json().data.session.clientType, "cli");
  assert.match(exchanged.json().data.sessionToken, /^csess_/);

  const denied = await app.inject({ method: "POST", url: "/api/auth/cli/authorize", payload: { mode: "device", client } });
  const deny = await app.inject({
    method: "POST",
    url: `/api/auth/cli/requests/${denied.json().data.requestId}/deny`,
    headers: decisionHeaders(cookie),
    payload: {},
  });
  assert.equal(deny.statusCode, 200, deny.body);
  const deniedPoll = await poll(denied.json().data.requestId);
  assert.equal(deniedPoll.statusCode, 403, deniedPoll.body);
  assert.equal(deniedPoll.json().error.code, "CLI_AUTHORIZATION_DENIED");

  const expired = await app.inject({ method: "POST", url: "/api/auth/cli/authorize", payload: browserAuthorization().payload });
  t.mock.timers.tick(11 * 60 * 1000);
  const expiredDetail = await app.inject({ method: "GET", url: `/api/auth/cli/requests/${expired.json().data.requestId}`, headers: { cookie, host: HOST } });
  assert.equal(expiredDetail.statusCode, 200, expiredDetail.body);
  assert.equal(expiredDetail.json().data.status, "expired");
  const expiredExchange = await app.inject({
    method: "POST",
    url: "/api/auth/cli/token",
    payload: { grantType: "authorization_code", requestId: expired.json().data.requestId, code: "expired", codeVerifier: pkce().verifier },
  });
  assert.equal(expiredExchange.statusCode, 410, expiredExchange.body);
  assert.equal(expiredExchange.json().error.code, "CLI_AUTHORIZATION_EXPIRED");
  const unknownRequest = await app.inject({ method: "GET", url: "/api/auth/cli/requests/cliauth_missing", headers: { cookie, host: HOST } });
  assert.equal(unknownRequest.statusCode, 404, unknownRequest.body);
  assert.equal(unknownRequest.json().error.code, "CLI_AUTHORIZATION_REQUEST_UNKNOWN");
});

test("cli session migration keeps existing sessions and accepts cli rows", async (t) => {
  const dataDir = tempDataDir("cp-cli-migration");
  const databasePath = controlPlaneStorePaths(dataDir).databasePath;
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE IF NOT EXISTS cp_migration_ledger (id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, details TEXT NOT NULL)");
  database.exec("PRAGMA foreign_keys = ON");
  const insertLedger = database.prepare("INSERT INTO cp_migration_ledger (id, checksum, applied_at, details) VALUES (?, ?, ?, ?)");
  for (const migration of sqliteMigrations.filter((entry) => entry.id !== "0006_cli_sessions")) {
    database.exec(migration.sql);
    insertLedger.run(migration.id, migration.checksum, new Date().toISOString(), JSON.stringify({ dialect: "sqlite" }));
  }
  const timestamp = new Date().toISOString();
  database.prepare("INSERT INTO cp_users (id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("user_legacy", "Legacy Admin", "active", timestamp, timestamp);
  database.prepare("INSERT INTO cp_login_identities (id, user_id, kind, normalized_login_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("identity_legacy", "user_legacy", "local-password", "legacy", "hash", timestamp, timestamp);
  const insertSession = database.prepare("INSERT INTO cp_user_sessions (id, identity_id, authorization_revision, token_hash, expires_at, client_type, device, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)");
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  insertSession.run("sess_legacy_web", "identity_legacy", "hash_web", expiresAt, "web", null, timestamp, timestamp);
  insertSession.run("msess_legacy_mobile", "identity_legacy", "hash_mobile", expiresAt, "mobile", JSON.stringify({ id: "device_1", name: "Phone", platform: "ios" }), timestamp, timestamp);
  database.close();

  const app = await createControlPlaneApp({ dataDir, logger: false, auth: { mode: "password" } });
  t.after(() => app.close());

  const upgraded = new DatabaseSync(databasePath);
  t.after(() => upgraded.close());
  const rows = upgraded.prepare("SELECT id, client_type, device, client_info FROM cp_user_sessions ORDER BY id").all();
  assert.deepEqual(rows.map((row) => [row.id, row.client_type]), [
    ["msess_legacy_mobile", "mobile"],
    ["sess_legacy_web", "web"],
  ]);
  assert.equal(JSON.parse(rows[0].device).platform, "ios");
  upgraded.prepare("INSERT INTO cp_user_sessions (id, identity_id, authorization_revision, token_hash, expires_at, client_type, client_info, created_at, updated_at) VALUES (?, ?, 1, ?, ?, 'cli', ?, ?, ?)")
    .run("csess_upgraded", "identity_legacy", "hash_cli", expiresAt, JSON.stringify({ name: "dev-mac", platform: "darwin" }), timestamp, timestamp);
  assert.throws(() => upgraded.prepare("INSERT INTO cp_user_sessions (id, identity_id, authorization_revision, token_hash, expires_at, client_type, created_at, updated_at) VALUES (?, ?, 1, ?, ?, 'browser', ?, ?)")
    .run("sess_invalid", "identity_legacy", "hash_invalid", expiresAt, timestamp, timestamp));
});

test("cli authorization code is consumed by exactly one concurrent exchange", async (t) => {
  const app = await createControlPlaneApp({ dataDir: tempDataDir("cp-cli-concurrent"), logger: false, auth: { mode: "password" } });
  t.after(() => app.close());
  await bootstrapAdmin(app);
  const cookie = await webLogin(app);

  const { verifier, payload } = browserAuthorization();
  const authorize = await app.inject({ method: "POST", url: "/api/auth/cli/authorize", payload });
  const requestId = authorize.json().data.requestId;
  const approve = await app.inject({
    method: "POST",
    url: `/api/auth/cli/requests/${requestId}/approve`,
    headers: decisionHeaders(cookie),
    payload: {},
  });
  const code = new URL(approve.json().data.redirectUri).searchParams.get("code");

  const exchange = () => app.inject({
    method: "POST",
    url: "/api/auth/cli/token",
    payload: { grantType: "authorization_code", requestId, code, codeVerifier: verifier },
  });
  const results = await Promise.all([exchange(), exchange()]);
  const succeeded = results.filter((response) => response.statusCode === 200);
  const rejected = results.filter((response) => response.statusCode !== 200);
  assert.equal(succeeded.length, 1, results.map((response) => response.body).join("\n"));
  assert.equal(rejected.length, 1, results.map((response) => response.body).join("\n"));
  assert.equal(rejected[0].json().error.code, "CLI_AUTHORIZATION_ALREADY_USED");
  assert.equal(succeeded[0].json().data.session.clientType, "cli");
});

test("pending cli authorization requests do not survive a control-plane restart", async (t) => {
  const dataDir = tempDataDir("cp-cli-restart");
  const first = await createControlPlaneApp({ dataDir, logger: false, auth: { mode: "password" } });
  await bootstrapAdmin(first);
  const authorize = await first.inject({ method: "POST", url: "/api/auth/cli/authorize", payload: browserAuthorization().payload });
  assert.equal(authorize.statusCode, 200, authorize.body);
  const requestId = authorize.json().data.requestId;
  await first.close();

  const second = await createControlPlaneApp({ dataDir, logger: false, auth: { mode: "password" } });
  t.after(() => second.close());
  const cookie = await webLogin(second);
  const detail = await second.inject({ method: "GET", url: `/api/auth/cli/requests/${requestId}`, headers: { cookie, host: HOST } });
  assert.equal(detail.statusCode, 404, detail.body);
  assert.equal(detail.json().error.code, "CLI_AUTHORIZATION_REQUEST_UNKNOWN");
  const exchange = await second.inject({
    method: "POST",
    url: "/api/auth/cli/token",
    payload: { grantType: "authorization_code", requestId, code: "restart", codeVerifier: browserAuthorization().verifier },
  });
  assert.equal(exchange.statusCode, 400, exchange.body);
  assert.equal(exchange.json().error.code, "CLI_AUTHORIZATION_INVALID_GRANT");
});
