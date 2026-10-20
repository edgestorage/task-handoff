import assert from "node:assert/strict";
import test from "node:test";
import { can, cloudAccountAuthorization } from "../src/control-plane/auth/authorization.ts";
import { routeAuthorization, sharedCloudEventAllowed, sharedCloudRouteAllowed } from "../src/control-plane/http/cloud-relay-authorization.ts";

const base = {
  type: "cloud-account",
  accountId: "account_grantee",
  ownerAccountId: "account_owner",
  deviceSessionId: "device_a",
  bindingId: "binding_a",
  bindingRevision: 2,
  accessMode: "shared",
  shareGrantId: "share_a",
  shareRevision: 3,
};

test("shared viewer is read-only across ordinary panel resources", () => {
  const viewer = { ...base, shareRole: "viewer" };
  for (const resource of [
    { type: "project" },
    { type: "instance", id: "instance_a" },
    { type: "app-session", id: "app_a" },
    { type: "ai-session", id: "ai_a" },
    { type: "node", id: "node_a" },
  ]) assert.equal(can(viewer, "read", resource), true, `viewer should read ${resource.type}`);
  for (const [action, resource] of [
    ["create", { type: "project" }],
    ["start", { type: "instance", id: "instance_a" }],
    ["proxy", { type: "instance", id: "instance_a" }],
    ["interactive-access", { type: "app-session", id: "app_a" }],
    ["send-message", { type: "ai-session", id: "ai_a" }],
    ["read-file-content", { type: "attachment", id: "attachment_a" }],
  ]) assert.equal(can(viewer, action, resource), false, `viewer must not ${action} ${resource.type}`);
  const authorization = cloudAccountAuthorization(viewer);
  assert.equal(authorization.roleIds[0], "role_cloud_shared_viewer");
  assert.equal(authorization.permissionIds.every((permission) => permission.endsWith(":read")), true);
});

test("shared operator gets ordinary interaction but never administration or node authentication", () => {
  const operator = { ...base, shareRole: "operator" };
  assert.equal(can(operator, "start", { type: "instance", id: "instance_a" }), true);
  assert.equal(can(operator, "proxy", { type: "instance", id: "instance_a" }), true);
  assert.equal(can(operator, "send-message", { type: "ai-session", id: "ai_a" }), true);
  for (const [action, resource] of [
    ["manage-members", { type: "user" }],
    ["update", { type: "role" }],
    ["update", { type: "identity-provider" }],
    ["manage-settings", { type: "control-plane-settings" }],
    ["manage-secrets", { type: "secret" }],
    ["read", { type: "chat-bridge" }],
    ["manage-node-auth", { type: "node", id: "node_a" }],
  ]) assert.equal(can(operator, action, resource), false, `operator must not ${action} ${resource.type}`);
  assert.equal(cloudAccountAuthorization(operator).roleIds[0], "role_cloud_shared_operator");
});

test("malformed shared authority and legacy owner actors fail closed", () => {
  assert.equal(can({ ...base, accessMode: "shared", shareGrantId: undefined, shareRole: "operator" }, "read", { type: "instance" }), false);
  assert.equal(can({ type: "cloud-account", accountId: "account_owner", deviceSessionId: "device_a", bindingId: "binding_a", bindingRevision: 2 }, "start", { type: "instance" }), true);
});

test("shared event streams exclude management activity but retain ordinary resource updates", () => {
  for (const event of [
    { type: "operation-approval.changed", topic: "system" },
    { type: "control-plane-proxy.binding.updated", topic: "control-plane-proxy" },
    { type: "node.pairing-invite.created", topic: "nodes" },
    { type: "node.remote-connect.requested", topic: "nodes" },
    { type: "node.control-plane-pairing.deleted", topic: "nodes" },
    { type: "settings.changed", topic: "system" },
    { type: "secret.rotated", topic: "system" },
    { type: "chat-bridge.updated", topic: "system" },
  ]) assert.equal(sharedCloudEventAllowed(event), false, `${event.type} must stay owner-only`);
  for (const event of [
    { type: "instance.updated", topic: "instances" },
    { type: "node.state", topic: "node.state" },
    { type: "ai.session.updated", topic: "ai.sessions" },
    { type: "attachment.created", topic: "system" },
    { type: "repository.updated", topic: "system" },
  ]) assert.equal(sharedCloudEventAllowed(event), true, `${event.type} should remain visible`);
});

test("shared actors cannot reach administration and binding routes through generic read mappings", () => {
  for (const path of [
    "/api/users",
    "/api/roles",
    "/api/identity-providers",
    "/api/control-plane/settings",
    "/api/git-credentials",
    "/api/chat-gateway/status",
    "/api/cloud-connectivity",
    "/api/control-plane-proxy/bindings",
    "/api/node-proxy/claims",
    "/api/operation-approvals",
    "/api/nodes/node_a/control-plane-pairings",
    "/api/controlled-instances/instance_a/git-credential-assignments",
  ]) assert.equal(sharedCloudRouteAllowed(path), false, `shared access must reject ${path}`);
  for (const path of ["/api/auth/session", "/api/access/me", "/api/control-plane/identity", "/api/nodes", "/api/controlled-instances/instance_a"]) {
    assert.equal(sharedCloudRouteAllowed(path), true, `shared access should retain ${path}`);
  }
  assert.equal(routeAuthorization("GET", "/api/users").resource.type, "user");
  assert.equal(routeAuthorization("POST", "/api/controlled-instances/instance_a/start").action, "start");
  assert.equal(routeAuthorization("PATCH", "/api/shares/share_a").resource.type, "control-plane-settings");
});
