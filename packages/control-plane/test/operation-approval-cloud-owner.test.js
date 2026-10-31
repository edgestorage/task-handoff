import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { ControlPlaneEventBus } from "../src/control-plane/events/bus.ts";
import { OperationApprovals } from "../src/control-plane/approvals/operation-approvals.ts";
import { registerOperationApprovalRoutes } from "../src/control-plane/http/operation-approval-routes.ts";
import { setControlPlaneRequestActor } from "../src/control-plane/http/request-actor.ts";

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

async function harness() {
  const app = Fastify({ logger: false });
  const events = new ControlPlaneEventBus();
  const approvals = new OperationApprovals(events, { "node.remove": true });
  const audit = [];
  const auth = {
    enabled: () => true,
    users: { store: { audit: { async put(record) { audit.push(record); return record; } } } },
  };
  app.addHook("preHandler", async (request) => {
    const raw = request.headers["x-test-actor"];
    if (typeof raw === "string") setControlPlaneRequestActor(request, JSON.parse(raw));
  });
  registerOperationApprovalRoutes(app, auth, approvals, async () => undefined);
  await app.ready();
  return { app, approvals, audit };
}

test("Cloud owner snapshots and decides only the mapped local user's operation approvals", async (t) => {
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

  const snapshot = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { "x-test-actor": mapped } });
  assert.equal(snapshot.statusCode, 200);
  assert.deepEqual(snapshot.json().data.requests.map((request) => request.id), [ownerRequest.id]);
  assert.ok(!snapshot.body.includes(otherRequest.id));

  const unmapped = await app.inject({ method: "GET", url: "/api/operation-approvals", headers: { "x-test-actor": JSON.stringify(ownerCloudActor()) } });
  assert.equal(unmapped.statusCode, 403);

  const wrongOwnerDecision = await app.inject({
    method: "POST",
    url: `/api/operation-approvals/${otherRequest.id}/decision`,
    headers: { "x-test-actor": mapped, "content-type": "application/json" },
    payload: { decision: "approve" },
  });
  assert.equal(wrongOwnerDecision.statusCode, 404);

  const decision = await app.inject({
    method: "POST",
    url: `/api/operation-approvals/${ownerRequest.id}/decision`,
    headers: { "x-test-actor": mapped, "content-type": "application/json" },
    payload: { decision: "approve" },
  });
  assert.equal(decision.statusCode, 200);
  assert.equal(decision.json().data.status, "approved");
  assert.deepEqual(approvals.snapshot("user_owner").requests, []);
  assert.equal(approvals.snapshot("user_other").requests.length, 1);
  assert.equal(audit.at(-1).actorUserId, "user_owner");
});
