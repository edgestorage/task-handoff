import assert from "node:assert/strict";
import test from "node:test";
import { can } from "../src/control-plane/auth/authorization.ts";
import { cloudEventAllowed, cloudEventPermission, cloudOwnerOnlyRoute, routeAuthorization } from "../src/control-plane/http/cloud-relay-authorization.ts";

function sharedActor(roleId, permissionIds) {
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
    { type: "operation-approval.changed", topic: "system" },
    { type: "control-plane-proxy.binding.updated", topic: "control-plane-proxy" },
    { type: "node.pairing-invite.created", topic: "nodes" },
    { type: "settings.changed", topic: "system" },
    { type: "secret.rotated", topic: "system" },
    { type: "chat-bridge.updated", topic: "system" },
    { type: "future.unknown", topic: "system" },
  ]) assert.equal(cloudEventAllowed(actor, event), false, `${event.type} must stay denied`);
  assert.equal(cloudEventPermission({ type: "future.unknown" }), undefined);
});

test("shared users cannot reach owner-only binding routes even with broad permissions", () => {
  for (const path of [
    "/api/cloud-account",
    "/api/cloud-account/sign-out",
    "/api/cloud-connectivity",
    "/api/cloud-connectivity/access-settings",
    "/api/cloud-connectivity/binding-requests",
  ]) assert.equal(cloudOwnerOnlyRoute(path), true, `owner-only guard must cover ${path}`);
  for (const path of ["/api/users", "/api/controlled-instances/instance_a", "/api/nodes"]) {
    assert.equal(cloudOwnerOnlyRoute(path), false, `${path} is permission-controlled, not owner-only`);
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
