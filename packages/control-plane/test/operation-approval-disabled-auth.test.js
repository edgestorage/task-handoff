import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { createControlPlaneApp } from "../src/control-plane/http/server.ts";

test("disabled authentication uses the built-in local operator for operation approvals", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "operation-approval-disabled-auth-"));
  const app = await createControlPlaneApp({
    dataDir,
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-control-plane-ui"),
    auth: { mode: "disabled" },
    cloudConnectivityEnabled: false,
    operationApprovalPolicy: { "node.remove": true },
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const session = await app.inject({
    method: "POST",
    url: "/api/auth/cli/local",
    payload: { client: { name: "operation-approval-test", platform: "darwin" } },
  });
  assert.equal(session.statusCode, 200, session.body);
  const cliAuthorization = `Bearer ${session.json().data.sessionToken}`;

  const webSession = await app.inject({ method: "GET", url: "/api/auth/session" });
  assert.equal(webSession.statusCode, 200, webSession.body);
  assert.equal(webSession.json().data.authenticated, true);
  assert.equal(webSession.json().data.user.id, session.json().data.session.user.id);
  assert.equal(webSession.json().data.user.displayName, "Local Operator");
  assert.equal(webSession.json().data.authorization.permissionIds.includes("settings:manage"), true);

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events?aiSessionTransient=1`);
  t.after(() => socket.close());
  const frames = [];
  socket.on("message", (value) => frames.push(JSON.parse(value.toString())));
  await once(socket, "open");
  socket.send(JSON.stringify({ v: 1, type: "subscribe", topics: ["operation.approvals"] }));

  const pending = await app.inject({
    method: "DELETE",
    url: "/api/nodes/node_missing",
    headers: { authorization: cliAuthorization },
  });
  assert.equal(pending.statusCode, 202, pending.body);
  assert.equal(pending.json().data.kind, "operation-approval");
  const approvalId = pending.json().data.id;

  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("operation approval event timed out")), 2_000);
    const poll = setInterval(() => {
      if (!frames.some((frame) => frame.type === "operation-approval.changed" && frame.payload?.request?.id === approvalId)) return;
      clearTimeout(deadline);
      clearInterval(poll);
      resolve();
    }, 10);
  });

  const snapshot = await app.inject({ method: "GET", url: "/api/operation-approvals" });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.deepEqual(snapshot.json().data.requests.map((request) => request.id), [approvalId]);

  const nonJsonDecision = await app.inject({
    method: "POST",
    url: `/api/operation-approvals/${approvalId}/decision`,
    headers: { "content-type": "text/plain" },
    payload: '{"decision":"approve"}',
  });
  assert.equal(nonJsonDecision.statusCode, 415, nonJsonDecision.body);
  assert.equal(nonJsonDecision.json().error.code, "OPERATION_APPROVAL_ORIGIN_INVALID");

  const cliAuthorizationDecision = await app.inject({
    method: "POST",
    url: "/api/auth/cli/requests/request_missing/approve",
    headers: { "content-type": "application/json" },
    payload: {},
  });
  assert.equal(cliAuthorizationDecision.statusCode, 401, cliAuthorizationDecision.body);
  assert.equal(cliAuthorizationDecision.json().error.code, "CONTROL_PLANE_AUTH_REQUIRED");

  const decision = await app.inject({
    method: "POST",
    url: `/api/operation-approvals/${approvalId}/decision`,
    headers: { "content-type": "application/json" },
    payload: { decision: "approve" },
  });
  assert.equal(decision.statusCode, 200, decision.body);
  assert.equal(decision.json().data.status, "approved");

  const status = await app.inject({
    method: "GET",
    url: `/api/operation-approvals/${approvalId}/status`,
    headers: { authorization: cliAuthorization },
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().data.status, "approved");
});
