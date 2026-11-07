import assert from "node:assert/strict";
import test from "node:test";
import { can } from "../src/control-plane/auth/authorization.ts";
import { cloudEventAllowed, cloudEventPermission, cloudRelayRouteReachable, routeAuthorization } from "../src/control-plane/http/cloud-relay-authorization.ts";

function sharedActor(roleId, permissionIds, extra = {}) {
  return {
    type: "cloud-account",
    accountId: "account_grantee",
    ownerAccountId: "account_owner",
    deviceSessionId: "device_a",
    bindingId: "binding_a",
    bindingRevision: 2,
    accessMode: "shared",
    accessRoleId: roleId,
    roleIds: [roleId],
    permissionIds,
    shareGrantId: "share_a",
    shareRevision: 3,
    nodeScope: { kind: "all" },
    ...extra,
  };
}

test("shared custom roles receive exactly their resolved permissions", () => {
  const readOnlyViewer = sharedActor("role_viewer", ["projects:read", "instances:read", "ai-sessions:read", "nodes:read", "attachments:read"]);
  for (const resource of [
    { type: "project" },
    { type: "instance", id: "instance_a" },
    { type: "app-session", id: "app_a" },
    { type: "ai-session", id: "ai_a" },
    { type: "node", id: "node_a" },
  ]) {
    if (resource.type === "app-session") continue;
    assert.equal(can(readOnlyViewer, "read", resource), true, `viewer should read ${resource.type}`);
  }
  for (const [action, resource] of [
    ["create", { type: "project" }],
    ["start", { type: "instance", id: "instance_a" }],
    ["proxy", { type: "instance", id: "instance_a" }],
    ["send-message", { type: "ai-session", id: "ai_a" }],
  ]) assert.equal(can(readOnlyViewer, action, resource), false, `viewer must not ${action} ${resource.type}`);

  const customOperator = sharedActor("role_custom_ops", [
    "instances:read", "instances:manage", "instances:interactive",
    "ai-sessions:read", "ai-sessions:manage", "ai-sessions:interactive",
  ]);
  assert.equal(can(customOperator, "start", { type: "instance", id: "instance_a" }), true);
  assert.equal(can(customOperator, "send-message", { type: "ai-session", id: "ai_a" }), true);
  assert.equal(can(customOperator, "manage-settings", { type: "control-plane-settings" }), false);
  assert.equal(can(customOperator, "update", { type: "role", id: "role_custom_ops" }), false);
});

test("cloud and local actors use identical role permissions for every operation", () => {
  const permissions = [
    "users:manage", "roles:manage", "identity-providers:manage",
    "chat-bridges:manage", "settings:manage", "secrets:manage",
  ];
  const operations = [
    ["manage-settings", { type: "control-plane-settings" }],
    ["manage-members", { type: "user" }],
    ["update", { type: "role" }],
    ["update", { type: "identity-provider" }],
    ["update", { type: "chat-bridge" }],
    ["manage-secrets", { type: "secret" }],
    ["manage-node-auth", { type: "node" }],
  ];
  for (const accessMode of ["owner", "shared"]) {
    const admin = sharedActor("role_custom_admin", permissions, { accessMode });
    for (const [action, resource] of operations) {
      assert.equal(can(admin, action, resource), true, `${accessMode} must allow ${action} ${resource.type}`);
      assert.equal(can(admin, action, resource), can({ ...admin, type: "user" }, action, resource));
      assert.equal(can({ ...admin, permissionIds: [] }, action, resource), false);
    }
    // A role name or owner mapping cannot add permissions that were not granted.
    assert.equal(can({ ...admin, roleIds: ["role_admin"], permissionIds: [], ownerUserId: "user_owner" }, "manage-settings", { type: "control-plane-settings" }), false);
    const policy = routeAuthorization("POST", "/api/stories/story_a/actions/action_a/run");
    assert.equal(can(admin, policy.action, policy.resource), true);
    assert.equal(can({ ...admin, permissionIds: [] }, policy.action, policy.resource), false);
  }
});

test("shared event streams follow resolved permissions and unknown families fail closed", () => {
  const actor = sharedActor("role_custom", ["instances:read", "ai-sessions:read"]);
  for (const event of [
    { type: "instance.updated", topic: "instances" },
    { type: "node.state", topic: "node.state", expected: false },
    { type: "ai.session.updated", topic: "ai.sessions" },
  ]) {
    if (event.expected === false) {
      assert.equal(cloudEventAllowed(actor, event), false, `${event.type} needs nodes:read`);
      continue;
    }
    assert.equal(cloudEventAllowed(actor, event), true, `${event.type} should remain visible`);
  }
  for (const event of [
    { type: "control-plane-proxy.binding.updated", topic: "control-plane-proxy" },
    { type: "node.pairing-invite.created", topic: "nodes" },
    { type: "settings.changed", topic: "system" },
    { type: "secret.rotated", topic: "system" },
    { type: "chat-bridge.updated", topic: "system" },
    { type: "future.unknown", topic: "system" },
  ]) assert.equal(cloudEventAllowed(actor, event), false, `${event.type} must stay denied`);
  assert.equal(cloudEventPermission({ type: "future.unknown" }), undefined);
  assert.equal(cloudEventPermission({ type: "cloud-node-relay.changed" }), "settings:manage");
  assert.equal(cloudEventPermission({ type: "node.control-plane-trust.changed" }), "settings:manage");
  assert.equal(cloudEventAllowed(actor, { type: "node.control-plane-trust.changed", topic: "nodes" }), false);
  assert.equal(cloudEventAllowed(
    sharedActor("role_admin", ["settings:manage"]),
    { type: "node.control-plane-trust.changed", topic: "nodes" },
  ), true);
  assert.equal(cloudEventAllowed(actor, { type: "cloud-node-relay.changed", topic: "cloud-node-relay" }), false);
  assert.equal(cloudEventAllowed(
    sharedActor("role_admin", ["settings:manage"]),
    { type: "cloud-node-relay.changed", topic: "cloud-node-relay" },
  ), true);
  assert.equal(cloudEventAllowed(actor, { type: "operation-approval.changed", topic: "operation.approvals" }), false);
  assert.equal(cloudEventAllowed(
    sharedActor("role_admin", ["settings:manage"]),
    { type: "operation-approval.changed", topic: "operation.approvals" },
  ), true);
  const ownerActor = sharedActor("role_admin", ["settings:manage"], { accessMode: "owner", accountId: "account_owner", ownerUserId: "usr_owner" });
  assert.equal(cloudEventAllowed(ownerActor, { type: "operation-approval.changed", topic: "operation.approvals" }), true);
});

test("only the personal operation approval snapshot and decision routes are relay reachable", () => {
  for (const [method, path] of [
    ["GET", "/api/operation-approvals"],
    ["POST", "/api/operation-approvals/approval_a/decision"],
    ["POST", "/api/operation-approvals/:id/decision"],
  ]) assert.equal(cloudRelayRouteReachable(method, path), true, `${method} ${path}`);

  for (const [method, path] of [
    ["GET", "/api/operation-approvals/approval_a/status"],
    ["DELETE", "/api/operation-approvals/approval_a"],
    ["GET", "/api/operation-approvals/support"],
    ["POST", "/api/operation-approvals/approval_a/decide"],
  ]) assert.equal(cloudRelayRouteReachable(method, path), false, `${method} ${path}`);
});

test("cloud binding routes require settings permission for owner and shared actors", () => {
  for (const path of [
    "/api/cloud-account", "/api/cloud-account/sign-out",
    "/api/cloud-connectivity", "/api/cloud-connectivity/access-settings",
    "/api/cloud-connectivity/binding-requests",
  ]) {
    const policy = routeAuthorization("POST", path);
    for (const accessMode of ["owner", "shared"]) {
      assert.equal(cloudRelayRouteReachable("POST", path), true);
      assert.equal(can(sharedActor("role_custom", ["settings:manage"], { accessMode }), policy.action, policy.resource), true);
      assert.equal(can(sharedActor("role_admin", [], { accessMode }), policy.action, policy.resource), false);
    }
  }
});

test("route mappings preserve resource semantics instead of path blacklists", () => {
  assert.equal(routeAuthorization("GET", "/api/users").resource.type, "user");
  assert.equal(routeAuthorization("GET", "/api/control-plane/node-relay-trace").resource.type, "control-plane-settings");
  assert.equal(routeAuthorization("POST", "/api/controlled-instances/instance_a/start").action, "start");
  assert.deepEqual(routeAuthorization("PATCH", "/api/shares/share_a"), {
    action: "update",
    resource: { type: "control-plane-settings" },
  });
  assert.equal(routeAuthorization("POST", "/api/future-sensitive-operation").resource.type, "control-plane-settings");
  assert.deepEqual(routeAuthorization("POST", "/api/controlled-instances/instance_a/ai-sessions/session_a/timeline/sync"), {
    action: "read",
    resource: { type: "ai-session" },
  });
  for (const [method, path] of [
    ["GET", "/api/ai-sessions"],
    ["POST", "/api/ai-sessions/sync"],
  ]) assert.deepEqual(routeAuthorization(method, path), {
    action: "read",
    resource: { type: "ai-session" },
  });
});
