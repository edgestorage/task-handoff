import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { ControlPlaneEventBus } from "../src/control-plane/events/bus.ts";
import { OperationApprovals } from "../src/control-plane/approvals/operation-approvals.ts";
import { executeApprovedOperation, registerOperationApprovalRoutes } from "../src/control-plane/http/operation-approval-routes.ts";
import { setControlPlaneRequestActor } from "../src/control-plane/http/request-actor.ts";

test("operation approval generations fence revisions across Control Plane restarts", () => {
  const published = [];
  const events = new ControlPlaneEventBus();
  events.on((event) => published.push(event));
  const first = new OperationApprovals(events, { "node.remove": true });
  const request = first.gate(
    { userId: "user_owner", sessionId: "cli_owner" },
    "node.remove",
    "node_owner",
    { nodeId: "node_owner" },
  );
  const firstSnapshot = first.snapshot();
  first.close();

  const second = new OperationApprovals(events, { "node.remove": true });
  const secondSnapshot = second.snapshot();
  second.close();

  assert.notEqual(firstSnapshot.generation, secondSnapshot.generation);
  assert.equal(firstSnapshot.revision, 1);
  assert.equal(secondSnapshot.revision, 0);
  assert.equal(published[0].payload.generation, firstSnapshot.generation);
  assert.equal(published[0].payload.request.id, request.id);
});

function ownerCloudActor(userId) {
  return {
    type: "cloud-account",
    accountId: "acct_owner",
    ownerAccountId: "acct_owner",
    deviceSessionId: "device_owner",
    bindingId: "binding_owner",
    bindingRevision: 1,
    accessMode: "owner",
    accessRoleId: "role_admin",
    roleIds: ["role_admin"],
    permissionIds: ["settings:manage"],
    authorizationRevision: 1,
    nodeScope: { kind: "all" },
    instanceScope: { kind: "inherit-node-scope" },
    ...(userId ? { ownerUserId: userId } : {}),
  };
}

function localUser(userId) {
  return {
    type: "user",
    userId,
    identityId: "identity_local",
    roleIds: ["role_admin"],
    permissionIds: ["settings:manage"],
    nodeScope: { kind: "all" },
    instanceScope: { kind: "inherit-node-scope" },
    authorizationRevision: 1,
    requiresPasswordChange: false,
  };
}

async function harness({ enabled = true, currentAccess } = {}) {
  const app = Fastify({ logger: false });
  const events = new ControlPlaneEventBus();
  const approvals = new OperationApprovals(events, { "node.remove": true });
  const audit = [];
  let executions = 0;
  const auth = {
    enabled: () => enabled,
    authorizationForSessionToken: async () => localUser("user_owner"),
    disabledModeAuthorization: async () => localUser("user_owner"),
    currentAccess: async () => currentAccess,
    users: { store: { audit: { async put(record) { audit.push(record); return record; } } } },
  };
  app.addHook("preHandler", async (request) => {
    const raw = request.headers["x-test-actor"];
    if (typeof raw === "string") setControlPlaneRequestActor(request, JSON.parse(raw));
  });
  app.post("/test/remove-node", async (request, reply) => executeApprovedOperation(
    request,
    reply,
    auth,
    approvals,
    "node.remove",
    "node_test",
    {},
    undefined,
    async () => {
      executions += 1;
      return { removed: true };
    },
  ));
  registerOperationApprovalRoutes(app, auth, approvals, async () => undefined);
  await app.ready();
  return { app, approvals, audit, executions: () => executions };
}

test("Control Plane administrators share the operation approval queue", async (t) => {
  const { app, approvals, audit } = await harness();
  t.after(async () => { approvals.close(); await app.close(); });
  const ownerRequest = approvals.gate(
    { userId: "user_owner", sessionId: "cli_owner" },
    "node.remove",
    "node_owner",
    { nodeId: "node_owner" },
  );
  const otherRequest = approvals.gate(
    { userId: "user_other", sessionId: "cli_other" },
    "node.remove",
    "node_other",
    { nodeId: "node_other" },
  );
  const mapped = JSON.stringify(ownerCloudActor("user_owner"));
  const localAdmin = JSON.stringify(localUser("user_admin"));
  const nonAdmin = JSON.stringify({ ...localUser("user_viewer"), roleIds: ["role_viewer"], permissionIds: ["instances:read"] });

  const snapshot = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { "x-test-actor": mapped } });
  assert.equal(snapshot.statusCode, 200);
  assert.deepEqual(snapshot.json().data.requests.map((request) => request.id), [ownerRequest.id, otherRequest.id]);

  const localSnapshot = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { "x-test-actor": localAdmin } });
  assert.equal(localSnapshot.statusCode, 200, localSnapshot.body);
  assert.deepEqual(localSnapshot.json().data.requests.map((request) => request.id), [ownerRequest.id, otherRequest.id]);

  const forbidden = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { "x-test-actor": nonAdmin } });
  assert.equal(forbidden.statusCode, 403);

  const unmapped = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { "x-test-actor": JSON.stringify(ownerCloudActor()) } });
  assert.equal(unmapped.statusCode, 200);

  const otherAdminDecision = await app.inject({
    method: "POST",
    url: `/api/operation-approvals/${otherRequest.id}/decision`,
    headers: { "x-test-actor": localAdmin, "content-type": "application/json" },
    payload: { decision: "approve" },
  });
  assert.equal(otherAdminDecision.statusCode, 200, otherAdminDecision.body);
  assert.equal(otherAdminDecision.json().data.status, "approved");

  const decision = await app.inject({
    method: "POST",
    url: `/api/operation-approvals/${ownerRequest.id}/decision`,
    headers: { "x-test-actor": mapped, "content-type": "application/json" },
    payload: { decision: "approve" },
  });
  assert.equal(decision.statusCode, 200);
  assert.equal(decision.json().data.status, "approved");
  assert.deepEqual(approvals.snapshot().requests, []);
  assert.equal(audit.at(-1).actorUserId, undefined);
  assert.deepEqual(audit.at(-1).details, { actorType: "cloud-account", accountId: "acct_owner", deviceSessionId: "device_owner" });
});

test("Cloud owner approval routes remain available when password authentication is disabled", async (t) => {
  const { app, approvals } = await harness({ enabled: false });
  t.after(async () => { approvals.close(); await app.close(); });
  const pending = approvals.gate(
    { userId: "user_owner", sessionId: "cli_owner" },
    "node.remove",
    "node_owner",
    { nodeId: "node_owner" },
  );
  const actor = JSON.stringify(ownerCloudActor("user_owner"));

  const snapshot = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { "x-test-actor": actor } });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.deepEqual(snapshot.json().data.requests.map((request) => request.id), [pending.id]);

  const decision = await app.inject({
    method: "POST",
    url: `/api/operation-approvals/${pending.id}/decision`,
    headers: { "x-test-actor": actor, "content-type": "application/json" },
    payload: { decision: "approve" },
  });
  assert.equal(decision.statusCode, 200, decision.body);
  assert.equal(decision.json().data.status, "approved");
});

test("disabled local CLI operations gate, surface and consume approvals through the local operator", async (t) => {
  const localOperator = localUser("user_owner");
  const { app, approvals, executions } = await harness({ enabled: false, currentAccess: localOperator });
  t.after(async () => { approvals.close(); await app.close(); });
  const disabledActor = JSON.stringify(localOperator);
  const cliHeaders = { authorization: "Bearer cli_session.token" };

  const pendingResponse = await app.inject({ method: "POST", url: "/test/remove-node", headers: cliHeaders });
  assert.equal(pendingResponse.statusCode, 202, pendingResponse.body);
  assert.equal(pendingResponse.json().data.kind, "operation-approval");
  const pendingId = pendingResponse.json().data.id;

  const snapshot = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { "x-test-actor": disabledActor } });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.deepEqual(snapshot.json().data.requests.map((request) => request.id), [pendingId]);

  const decision = await app.inject({
    method: "POST",
    url: `/api/operation-approvals/${pendingId}/decision`,
    headers: { "x-test-actor": disabledActor, "content-type": "application/json" },
    payload: { decision: "approve" },
  });
  assert.equal(decision.statusCode, 200, decision.body);

  const approved = await app.inject({
    method: "POST",
    url: "/test/remove-node",
    headers: { ...cliHeaders, "x-task-handoff-approval-id": pendingId },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.deepEqual(approved.json(), { data: { removed: true } });
  assert.equal(executions(), 1);
});

for (const accessMode of ["owner", "shared"]) {
  test(`${accessMode} cloud approvals follow permissions without a local owner identity`, async (t) => {
    const { app, approvals, audit } = await harness();
    t.after(async () => { approvals.close(); await app.close(); });
    const pending = approvals.gate({ userId: "user_requester", sessionId: "cli_requester" }, "node.remove", "node_a", {});
    const actor = { ...ownerCloudActor(), accessMode, accountId: "acct_actual_approver", roleIds: ["role_custom_approver"] };
    const snapshot = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { "x-test-actor": JSON.stringify(actor) } });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    assert.equal(snapshot.json().data.requests[0].id, pending.id);
    const denied = await app.inject({ method: "POST", url: `/api/operation-approvals/${pending.id}/decision`, headers: { "x-test-actor": JSON.stringify({ ...actor, permissionIds: [] }) }, payload: { decision: "approve" } });
    assert.equal(denied.statusCode, 403);
    const decision = await app.inject({ method: "POST", url: `/api/operation-approvals/${pending.id}/decision`, headers: { "x-test-actor": JSON.stringify(actor) }, payload: { decision: "approve" } });
    assert.equal(decision.statusCode, 200, decision.body);
    assert.equal(audit.at(-1).actorUserId, undefined);
    assert.equal(audit.at(-1).details.accountId, actor.accountId);
  });
}
