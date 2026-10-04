const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createControlPlaneApp } = require("../packages/control-plane/src/server.ts");
const { createControlPlaneClient } = require("../packages/control-plane-client/src/client.ts");
const { createThctlTransport } = require("../apps/thctl/src/control-plane.ts");
const { guardApprovalProtocol } = require("../apps/thctl/src/operation-approvals.ts");

const origin = "http://control-plane.test";
const headers = (cookie) => ({ cookie, host: "control-plane.test", origin, "sec-fetch-site": "same-origin" });

async function cliSession(app, cookie) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const auth = await app.inject({ method: "POST", url: "/api/auth/cli/authorize", payload: {
    mode: "browser", client: { name: "test", platform: "linux", version: "1" },
    redirectUri: "http://127.0.0.1:41000/callback", state: "approval-test-state",
    codeChallenge: crypto.createHash("sha256").update(verifier).digest("base64url"), codeChallengeMethod: "S256",
  } });
  assert.equal(auth.statusCode, 200, auth.body);
  const requestId = auth.json().data.requestId;
  const approval = await app.inject({ method: "POST", url: `/api/auth/cli/requests/${requestId}/approve`, headers: headers(cookie), payload: {} });
  assert.equal(approval.statusCode, 200, approval.body);
  const code = new URL(approval.json().data.redirectUri).searchParams.get("code");
  const exchanged = await app.inject({ method: "POST", url: "/api/auth/cli/token", payload: { grantType: "authorization_code", requestId, code, codeVerifier: verifier } });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  return exchanged.json().data.sessionToken;
}

test("CLI node removal waits for a same-user Web decision and executes exactly once", async (context) => {
  const app = await createControlPlaneApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "operation-approval-")), logger: false, auth: { mode: "password" } });
  const sockets = [];
  context.after(async () => { sockets.forEach((socket) => socket.terminate()); await app.close(); });
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/bootstrap-admin", payload: { username: "admin", password: "password123" } })).statusCode, 201);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "password123" } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.headers["set-cookie"];
  const token = await cliSession(app, cookie);
  const cliHeaders = { authorization: `Bearer ${token}` };
  const node = await app.inject({ method: "POST", url: "/api/nodes", headers: headers(cookie), payload: {
    id: "approval-test-node", name: "Approval test node", connectionMode: "reverse-wss",
    auth: { mode: "paired-hmac", keyId: "test-key", secret: "test-secret-12345678901234567890" },
  } });
  assert.equal(node.statusCode, 201, node.body);
  const support = await app.inject({ method: "GET", url: "/api/operation-approvals/support", headers: cliHeaders });
  assert.equal(support.statusCode, 200, support.body);
  const webSockets = await Promise.all([app.injectWS("/api/events", { headers: { cookie } }), app.injectWS("/api/events", { headers: { cookie } })]);
  sockets.push(...webSockets);
  const webFrames = webSockets.map(() => []);
  webSockets.forEach((socket, index) => socket.on("message", (frame) => webFrames[index].push(JSON.parse(String(frame)))));
  const first = await app.inject({ method: "DELETE", url: "/api/nodes/approval-test-node", headers: cliHeaders });
  assert.equal(first.statusCode, 202, first.body);
  const approvalId = first.json().data.id;
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const frames of webFrames) {
    assert.equal(frames.filter((frame) => frame.type === "operation-approval.changed" && frame.payload.status === "pending" && frame.payload.request.id === approvalId).length, 1);
  }
  const nodeStillExists = await app.inject({ method: "GET", url: "/api/nodes/approval-test-node", headers: cliHeaders });
  assert.equal(nodeStillExists.statusCode, 200, nodeStillExists.body);
  const snapshot = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { cookie } });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.equal(snapshot.json().data.requests[0].id, approvalId);
  assert.equal(JSON.stringify(snapshot.json()).includes("test-secret"), false);
  const createdViewer = await app.inject({ method: "POST", url: "/api/users", headers: { cookie }, payload: {
    username: "second-admin", password: "viewer-password-123", roleIds: ["role_admin"], nodeScope: { kind: "all" },
  } });
  assert.equal(createdViewer.statusCode, 201, createdViewer.body);
  const viewerLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "second-admin", password: "viewer-password-123" } });
  const viewerCookie = viewerLogin.headers["set-cookie"];
  const otherSocket = await app.injectWS("/api/events", { headers: { cookie: viewerCookie } });
  sockets.push(otherSocket);
  const otherFrames = [];
  otherSocket.on("message", (frame) => otherFrames.push(JSON.parse(String(frame))));
  const otherSnapshot = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { cookie: viewerCookie } });
  assert.equal(otherSnapshot.statusCode, 200, otherSnapshot.body);
  assert.deepEqual(otherSnapshot.json().data.requests, []);
  const otherDecision = await app.inject({ method: "POST", url: `/api/operation-approvals/${approvalId}/decision`, headers: headers(viewerCookie), payload: { decision: "approve" } });
  assert.equal(otherDecision.statusCode, 404, otherDecision.body);
  const badOrigin = await app.inject({ method: "POST", url: `/api/operation-approvals/${approvalId}/decision`, headers: { cookie, host: "control-plane.test", origin: "http://evil.test" }, payload: { decision: "approve" } });
  assert.equal(badOrigin.statusCode, 403, badOrigin.body);
  const approved = await app.inject({ method: "POST", url: `/api/operation-approvals/${approvalId}/decision`, headers: headers(cookie), payload: { decision: "approve" } });
  assert.equal(approved.statusCode, 200, approved.body);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(otherFrames.some((frame) => frame.type === "operation-approval.changed"), false);
  for (const frames of webFrames) assert.equal(frames.filter((frame) => frame.type === "operation-approval.changed" && frame.payload.status === "approved" && frame.payload.request.id === approvalId).length, 1);
  const status = await app.inject({ method: "GET", url: `/api/operation-approvals/${approvalId}/status`, headers: cliHeaders });
  assert.equal(status.json().data.status, "approved");
  const execute = await app.inject({ method: "DELETE", url: "/api/nodes/approval-test-node", headers: { ...cliHeaders, "x-task-handoff-approval-id": approvalId } });
  assert.equal(execute.statusCode, 200, execute.body);
  assert.equal(execute.json().data.deleted, true);
  const retry = await app.inject({ method: "DELETE", url: "/api/nodes/approval-test-node", headers: { ...cliHeaders, "x-task-handoff-approval-id": approvalId } });
  assert.notEqual(retry.statusCode, 200);
  const another = await app.inject({ method: "POST", url: "/api/nodes", headers: headers(cookie), payload: {
    id: "web-test-node", name: "Web test node", connectionMode: "reverse-wss",
    auth: { mode: "paired-hmac", keyId: "test-key", secret: "test-secret-12345678901234567890" },
  } });
  assert.equal(another.statusCode, 201, another.body);
  const webDelete = await app.inject({ method: "DELETE", url: "/api/nodes/web-test-node", headers: headers(cookie) });
  assert.equal(webDelete.statusCode, 200, webDelete.body);
  assert.equal(webDelete.json().data.deleted, true);
  const cliTarget = await app.inject({ method: "POST", url: "/api/nodes", headers: headers(cookie), payload: {
    id: "cli-end-to-end-node", name: "CLI end-to-end node", connectionMode: "reverse-wss",
    auth: { mode: "paired-hmac", keyId: "test-key", secret: "test-secret-12345678901234567890" },
  } });
  assert.equal(cliTarget.statusCode, 201, cliTarget.body);
  const approvalWait = { signal: new AbortController().signal, async sleep() {
    const pending = (await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { cookie } })).json().data.requests;
    assert.equal(pending.length, 1);
    const decision = await app.inject({ method: "POST", url: `/api/operation-approvals/${pending[0].id}/decision`, headers: headers(cookie), payload: { decision: "approve" } });
    assert.equal(decision.statusCode, 200, decision.body);
  } };
  const transport = createThctlTransport({ origin, sessionToken: () => token, approvalWait, fetchImpl: async (url, init) => {
    const address = new URL(url);
    const response = await app.inject({ method: init.method || "GET", url: address.pathname + address.search, headers: Object.fromEntries(new Headers(init.headers)), payload: init.body });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  } });
  const client = createControlPlaneClient(transport);
  const result = await guardApprovalProtocol({ client }, () => client.approvals.removeNode("cli-end-to-end-node", false));
  assert.equal(result.deleted, true);
  const revokeTarget = await app.inject({ method: "POST", url: "/api/nodes", headers: headers(cookie), payload: {
    id: "approval-revoked-node", name: "Revoked node", connectionMode: "reverse-wss",
    auth: { mode: "paired-hmac", keyId: "test-key", secret: "test-secret-12345678901234567890" },
  } });
  assert.equal(revokeTarget.statusCode, 201, revokeTarget.body);
  const pendingRevoke = await app.inject({ method: "DELETE", url: "/api/nodes/approval-revoked-node", headers: cliHeaders });
  assert.equal(pendingRevoke.statusCode, 202, pendingRevoke.body);
  const revokeId = pendingRevoke.json().data.id;
  const allowed = await app.inject({ method: "POST", url: `/api/operation-approvals/${revokeId}/decision`, headers: headers(cookie), payload: { decision: "approve" } });
  assert.equal(allowed.statusCode, 200, allowed.body);
  const logout = await app.inject({ method: "POST", url: "/api/auth/cli/logout", headers: cliHeaders });
  assert.equal(logout.statusCode, 200, logout.body);
  const revokedExecution = await app.inject({ method: "DELETE", url: "/api/nodes/approval-revoked-node", headers: { ...cliHeaders, "x-task-handoff-approval-id": revokeId } });
  assert.equal(revokedExecution.statusCode, 401, revokedExecution.body);
  const remainingNode = await app.inject({ method: "GET", url: "/api/nodes/approval-revoked-node", headers: { cookie } });
  assert.equal(remainingNode.statusCode, 200, remainingNode.body);
});

test("deployments without Web sign-in fail closed for bearer deletion requests", async (context) => {
  const app = await createControlPlaneApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "operation-approval-disabled-")), logger: false, auth: { mode: "disabled" } });
  context.after(() => app.close());
  const response = await app.inject({ method: "DELETE", url: "/api/nodes/any-node", headers: { authorization: "Bearer untrusted" } });
  assert.equal(response.statusCode, 403, response.body);
  const snapshot = await app.inject({ method: "GET", url: "/api/operation-approvals" });
  assert.equal(snapshot.statusCode, 403, snapshot.body);
});

test("server policy, not the CLI, decides whether a supported operation needs approval", async (context) => {
  const app = await createControlPlaneApp({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "operation-approval-policy-")),
    logger: false,
    auth: { mode: "password" },
    operationApprovalPolicy: { "node.remove": false },
  });
  context.after(() => app.close());
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/bootstrap-admin", payload: { username: "admin", password: "password123" } })).statusCode, 201);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "password123" } });
  const cookie = login.headers["set-cookie"];
  const token = await cliSession(app, cookie);
  const cliHeaders = { authorization: `Bearer ${token}` };
  const support = await app.inject({ method: "GET", url: "/api/operation-approvals/support", headers: cliHeaders });
  assert.deepEqual(support.json().data, { supported: true });
  const created = await app.inject({ method: "POST", url: "/api/nodes", headers: headers(cookie), payload: {
    id: "approval-policy-node", name: "Policy test node", connectionMode: "reverse-wss",
    auth: { mode: "paired-hmac", keyId: "test-key", secret: "test-secret-12345678901234567890" },
  } });
  assert.equal(created.statusCode, 201, created.body);
  const forgedApproval = await app.inject({ method: "DELETE", url: "/api/nodes/approval-policy-node", headers: { ...cliHeaders, "x-task-handoff-approval-id": "stale" } });
  assert.equal(forgedApproval.statusCode, 400, forgedApproval.body);
  const transport = createThctlTransport({ origin, sessionToken: () => token, approvalWait: {
    signal: new AbortController().signal,
    async sleep() { assert.fail("The disabled server policy must not make the CLI wait."); },
  }, fetchImpl: async (url, init) => {
    const address = new URL(url);
    const response = await app.inject({ method: init.method || "GET", url: address.pathname + address.search, headers: Object.fromEntries(new Headers(init.headers)), payload: init.body });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  } });
  const client = createControlPlaneClient(transport);
  const removed = await guardApprovalProtocol({ client }, () => client.approvals.removeNode("approval-policy-node", false));
  assert.equal(removed.deleted, true);
  const snapshot = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { cookie } });
  assert.deepEqual(snapshot.json().data.requests, []);
});

test("new protected writes are gated before effects and expose only safe details", async (context) => {
  const app = await createControlPlaneApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "operation-approval-expanded-")), logger: false, auth: { mode: "password" } });
  let socket;
  context.after(async () => { socket?.terminate(); await app.close(); });
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/bootstrap-admin", payload: { username: "admin", password: "password123" } })).statusCode, 201);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "password123" } });
  const cookie = login.headers["set-cookie"];
  const token = await cliSession(app, cookie);
  socket = await app.injectWS("/api/events", { headers: { cookie } });
  const frames = [];
  socket.on("message", (frame) => frames.push(JSON.parse(String(frame))));
  const node = await app.inject({ method: "POST", url: "/api/nodes", headers: headers(cookie), payload: {
    id: "expanded-approval-node", name: "Expanded approval node", connectionMode: "reverse-wss",
    auth: { mode: "paired-hmac", keyId: "test-key", secret: "test-secret-12345678901234567890" },
  } });
  assert.equal(node.statusCode, 201, node.body);
  const requests = [
    ["POST", "/api/nodes/expanded-approval-node/updates/apply", { channel: "stable", targetVersion: "v1.2.3", preflightToken: "secret-preflight-123456789" }, "node.update.apply"],
    ["PUT", "/api/users/missing/access", { roleIds: ["role_admin"], nodeScope: { kind: "all" }, expectedAuthorizationRevision: 1 }, "user.access.set"],
    ["PATCH", "/api/roles/missing", { name: "Updated role" }, "user.role.update"],
    ["DELETE", "/api/roles/missing", undefined, "user.role.remove"],
    ["PATCH", "/api/identity-providers/missing", { clientSecret: "secret-provider-123456789" }, "identity-provider.update"],
    ["DELETE", "/api/identity-providers/missing", undefined, "identity-provider.remove"],
  ];
  for (const [method, url, payload, operation] of requests) {
    const pending = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
    assert.equal(pending.statusCode, 202, `${operation}: ${pending.body}`);
    assert.equal(pending.json().data.kind, "operation-approval");
    const snapshot = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { cookie } });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    const entry = snapshot.json().data.requests.find((request) => request.id === pending.json().data.id);
    assert.equal(entry?.operation, operation);
    assert.doesNotMatch(snapshot.body, /secret-preflight|secret-provider/);
    const cancelled = await app.inject({ method: "DELETE", url: `/api/operation-approvals/${entry.id}`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const approvalFrames = frames.filter((frame) => frame.type === "operation-approval.changed");
  assert.ok(approvalFrames.length >= requests.length);
  assert.doesNotMatch(JSON.stringify(approvalFrames), /secret-preflight|secret-provider/);
});

test("the server can enable external-listener approval independently", async (context) => {
  const app = await createControlPlaneApp({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "operation-approval-listener-")), logger: false,
    auth: { mode: "password" }, operationApprovalPolicy: { "node.external-listener.set": true },
  });
  context.after(() => app.close());
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/bootstrap-admin", payload: { username: "admin", password: "password123" } })).statusCode, 201);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "password123" } });
  const cookie = login.headers["set-cookie"];
  const token = await cliSession(app, cookie);
  const node = await app.inject({ method: "POST", url: "/api/nodes", headers: headers(cookie), payload: {
    id: "listener-approval-node", name: "Listener approval node", connectionMode: "reverse-wss",
    auth: { mode: "paired-hmac", keyId: "test-key", secret: "test-secret-12345678901234567890" },
  } });
  assert.equal(node.statusCode, 201, node.body);
  const pending = await app.inject({ method: "PATCH", url: "/api/nodes/listener-approval-node/settings/external-listener", headers: { authorization: `Bearer ${token}` }, payload: { bindScope: "all-ipv4", port: 8080 } });
  assert.equal(pending.statusCode, 202, pending.body);
  const snapshot = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { cookie } });
  assert.deepEqual(snapshot.json().data.requests[0].details, [{ field: "bindScope", value: "all-ipv4" }, { field: "port", value: "8080" }]);
});
