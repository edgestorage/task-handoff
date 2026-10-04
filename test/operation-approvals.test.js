const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { OperationApprovals } = require("../packages/control-plane/src/control-plane/approvals/operation-approvals.ts");
const { ControlPlaneEventBus } = require("../packages/control-plane/src/control-plane/events/bus.ts");

function socket() {
  const frames = [];
  return { readyState: 1, OPEN: 1, send: (frame) => frames.push(JSON.parse(frame)), on: () => {}, frames };
}

test("approval binds user, CLI session, operation, target and normalized input", (context) => {
  const approvals = new OperationApprovals(new ControlPlaneEventBus());
  context.after(() => approvals.close());
  const owner = { userId: "user-a", sessionId: "session-a" };
  const pending = approvals.gate(owner, "instance.delete", "instance-1", { deleteVolumes: false });
  assert.equal(pending.status, "pending");
  assert.equal(approvals.gate(owner, "instance.delete", "instance-1", { deleteVolumes: false }).id, pending.id);
  assert.deepEqual(approvals.snapshot("user-b").requests, []);
  assert.throws(() => approvals.decide("user-b", pending.id, "approve"));
  approvals.decide("user-a", pending.id, "approve");
  assert.equal(approvals.status(owner, pending.id).status, "approved");
  assert.throws(() => approvals.gate(owner, "instance.delete", "instance-1", { deleteVolumes: true }, pending.id));
  assert.throws(() => approvals.gate({ ...owner, sessionId: "session-b" }, "instance.delete", "instance-1", { deleteVolumes: false }, pending.id));
  assert.deepEqual(approvals.gate(owner, "instance.delete", "instance-1", { deleteVolumes: false }, pending.id), { kind: "approved" });
  assert.throws(() => approvals.gate(owner, "instance.delete", "instance-1", { deleteVolumes: false }, pending.id));
});

test("operation approval policy defaults to protected operations and rejects unknown operations", (context) => {
  const events = new ControlPlaneEventBus();
  const defaults = new OperationApprovals(events);
  context.after(() => defaults.close());
  assert.equal(defaults.requiresApproval("instance.delete"), true);
  assert.equal(defaults.requiresApproval("node.remove"), true);
  for (const operation of ["node.update.apply", "user.access.set", "user.role.update", "user.role.remove", "identity-provider.update", "identity-provider.remove", "git-credential.assign"]) {
    assert.equal(defaults.requiresApproval(operation), true, operation);
  }
  assert.equal(defaults.requiresApproval("node.external-listener.set"), false);
  const configured = new OperationApprovals(events, { "node.remove": false });
  context.after(() => configured.close());
  assert.equal(configured.requiresApproval("node.remove"), false);
  assert.equal(configured.requiresApproval("instance.delete"), true);
  const listenerEnabled = new OperationApprovals(events, { "node.external-listener.set": true });
  context.after(() => listenerEnabled.close());
  assert.equal(listenerEnabled.requiresApproval("node.external-listener.set"), true);
  assert.throws(() => new OperationApprovals(events, { "anything.at.all": false }));
});

test("all registered approval routes use the same server-side gate and execution boundary", () => {
  const routes = {
    "instance-routes.ts": ["instance.delete"],
    "node-routes.ts": ["node.remove", "node.update.apply", "node.external-listener.set"],
    "user-routes.ts": ["user.access.set", "user.role.update", "user.role.remove", "identity-provider.update", "identity-provider.remove"],
    "git-credential-routes.ts": ["git-credential.assign"],
  };
  for (const [file, operations] of Object.entries(routes)) {
    const source = fs.readFileSync(new URL(`../packages/control-plane/src/control-plane/http/${file}`, `file://${__filename}`), "utf8");
    assert.doesNotMatch(source, /gateOperation\(|operationApprovals\.gate\(/, file);
    for (const operation of operations) {
      assert.ok(source.includes(`executeApprovedOperation(request, reply, auth, operationApprovals, "${operation}"`), `${file}: ${operation}`);
    }
  }
});

test("denial and cancellation never grant execution", (context) => {
  const approvals = new OperationApprovals(new ControlPlaneEventBus());
  context.after(() => approvals.close());
  const owner = { userId: "user-a", sessionId: "session-a" };
  const denied = approvals.gate(owner, "node.remove", "node-1", { force: true });
  approvals.decide(owner.userId, denied.id, "deny");
  assert.throws(() => approvals.gate(owner, "node.remove", "node-1", { force: true }, denied.id));
  assert.equal(approvals.cancel(owner, denied.id), true);
  assert.throws(() => approvals.status(owner, denied.id));
});

test("approval expires five minutes after creation, even when it was already approved", (context) => {
  context.mock.timers.enable({ apis: ["Date"] });
  const approvals = new OperationApprovals(new ControlPlaneEventBus());
  context.after(() => approvals.close());
  const owner = { userId: "user-a", sessionId: "session-a" };
  const pending = approvals.gate(owner, "node.remove", "node-1", { force: false });
  approvals.decide(owner.userId, pending.id, "approve");
  context.mock.timers.tick(5 * 60_000 + 1);
  assert.throws(() => approvals.status(owner, pending.id), { code: "OPERATION_APPROVAL_NOT_FOUND" });
  assert.throws(() => approvals.gate(owner, "node.remove", "node-1", { force: false }, pending.id), { code: "OPERATION_APPROVAL_INVALID" });
});

test("concurrent decisions accept exactly one terminal transition and process restart loses all approvals", (context) => {
  const events = new ControlPlaneEventBus();
  const approvals = new OperationApprovals(events);
  context.after(() => approvals.close());
  const owner = { userId: "user-a", sessionId: "session-a" };
  const pending = approvals.gate(owner, "node.remove", "node-1", { force: false });
  assert.equal(approvals.decide(owner.userId, pending.id, "approve").status, "approved");
  assert.throws(() => approvals.decide(owner.userId, pending.id, "deny"), { code: "OPERATION_APPROVAL_NOT_FOUND" });
  approvals.close();
  const restarted = new OperationApprovals(events);
  context.after(() => restarted.close());
  assert.deepEqual(restarted.snapshot(owner.userId).requests, []);
  assert.throws(() => restarted.gate(owner, "node.remove", "node-1", { force: false }, pending.id), { code: "OPERATION_APPROVAL_INVALID" });
});

test("personal events never reach unbound sockets, another user's sockets, or public listeners", () => {
  const events = new ControlPlaneEventBus();
  const ownerSocket = socket();
  const otherSocket = socket();
  const cliSocket = socket();
  const anonymousSocket = socket();
  events.connect(ownerSocket, { authorization: { userId: "user-a", webSession: true, authorizationRevision: 1, permissionIds: [] } });
  events.connect(otherSocket, { authorization: { userId: "user-b", webSession: true, authorizationRevision: 1, permissionIds: [] } });
  events.connect(cliSocket, { authorization: { userId: "user-a", authorizationRevision: 1, permissionIds: [] } });
  events.connect(anonymousSocket);
  let listenerCalled = false;
  events.on(() => { listenerCalled = true; });
  const approvals = new OperationApprovals(events);
  const entry = approvals.gate({ userId: "user-a", sessionId: "session-a" }, "node.remove", "node-1", { force: true });
  assert.equal(ownerSocket.frames.filter((frame) => frame.type === "operation-approval.changed").length, 1);
  assert.equal(otherSocket.frames.length, 0);
  assert.equal(cliSocket.frames.length, 0);
  assert.equal(anonymousSocket.frames.length, 0);
  assert.equal(listenerCalled, false);
  assert.equal(JSON.stringify(ownerSocket.frames).includes("session-a"), false);
  assert.equal(approvals.snapshot("user-a").requests[0].id, entry.id);
  approvals.close();
});
