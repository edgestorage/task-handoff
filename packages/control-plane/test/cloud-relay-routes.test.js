import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_PLANE_PERMISSION_IDS } from "@task-handoff/protocol/control-plane-access";
import { can, cloudAccountAuthorization } from "../src/control-plane/auth/authorization.ts";
import { cloudRelayRouteReachable, routeAuthorization } from "../src/control-plane/http/cloud-relay-authorization.ts";

const VIEWER_PERMISSIONS = CONTROL_PLANE_PERMISSION_IDS.filter((id) => id.endsWith(":read"));
const OPERATOR_DENIED_PREFIXES = ["users:", "roles:", "identity-providers:", "settings:", "secrets:", "chat-bridges:"];
const OPERATOR_PERMISSIONS = CONTROL_PLANE_PERMISSION_IDS.filter((id) => !OPERATOR_DENIED_PREFIXES.some((prefix) => id.startsWith(prefix)));

function cloudActor(roleId, permissionIds) {
  return {
    type: "cloud-account",
    accountId: "account_a",
    ownerAccountId: "account_a",
    deviceSessionId: "device_a",
    bindingId: "binding_a",
    bindingRevision: 4,
    accessMode: "owner",
    accessRoleId: roleId,
    roleIds: [roleId],
    permissionIds,
    authorizationRevision: 7,
    nodeScope: { kind: "all" },
  };
}

test("cloud authorization projects the resolved role without a parallel permission model", () => {
  const actor = cloudActor("role_viewer", [...VIEWER_PERMISSIONS]);
  assert.deepEqual(cloudAccountAuthorization(actor), {
    userId: "cloud-account:account_a",
    identityId: "cloud-device:device_a",
    roleIds: ["role_viewer"],
    permissionIds: [...VIEWER_PERMISSIONS],
    nodeScope: { kind: "all" },
    instanceScope: { kind: "inherit-node-scope" },
    authorizationRevision: 7,
  });
  for (const type of ["project", "node", "instance", "app-session", "ai-session", "attachment"]) {
    assert.equal(can(actor, "read", { type }), true, `viewer should read ${type}`);
    assert.equal(can(actor, "create", { type }), false, `viewer must not create ${type}`);
  }
  assert.equal(can(actor, "start", { type: "instance" }), false);
  assert.equal(can(actor, "send-message", { type: "ai-session" }), false);
});

test("operator and admin roles use exactly the permissions resolved by the Control Plane", () => {
  const operator = cloudActor("role_operator", [...OPERATOR_PERMISSIONS]);
  assert.equal(can(operator, "start", { type: "instance" }), true);
  assert.equal(can(operator, "send-message", { type: "ai-session" }), true);
  for (const [action, type] of [
    ["manage-members", "user"],
    ["update", "role"],
    ["manage-settings", "control-plane-settings"],
    ["manage-secrets", "secret"],
    ["read", "chat-bridge"],
    ["manage-node-auth", "node"],
  ]) assert.equal(can(operator, action, { type }), false, `operator must not ${action} ${type}`);

  const admin = cloudActor("role_admin", [...CONTROL_PLANE_PERMISSION_IDS]);
  assert.equal(can(admin, "manage-settings", { type: "control-plane-settings" }), true);
  assert.equal(can(admin, "manage-members", { type: "user" }), true);
  assert.equal(can(admin, "manage-secrets", { type: "secret" }), true);
});

test("relayed cloud accounts reach credential-free bootstrap and mapped routes only", () => {
  for (const [method, path] of [
    ["GET", "/api/auth/session"],
    ["GET", "/api/auth/session?signal=1"],
    ["GET", "/api/access/me"],
    ["GET", "/api/control-plane/identity"],
    ["GET", "/api/health"],
    ["GET", "/api/controlled-instances/instance_a/ai-sessions"],
    ["GET", "/api/nodes"],
  ]) assert.equal(cloudRelayRouteReachable(method, path), true, `${method} ${path} must stay reachable`);

  assert.equal(cloudRelayRouteReachable("POST", "/api/ai-sessions/sync?hierarchy=subagents"), true);
  for (const [method, path] of [
    ["POST", "/api/ai-sessions/sync"],
    ["GET", "/api/ai-sessions"],
  ]) {
    const authorization = routeAuthorization(method, path);
    assert.deepEqual(authorization, { action: "read", resource: { type: "ai-session" } });
    assert.equal(can(cloudActor("role_session_reader", ["ai-sessions:read"]), authorization.action, authorization.resource), true, `${method} ${path} must allow AI Session readers`);
    assert.equal(can(cloudActor("role_directory_reader", ["public-directory:read"]), authorization.action, authorization.resource), false, `${method} ${path} must reject actors without AI Session read`);
  }

  // Timeline sync reads history through a POST body carrying the client's known
  // revisions. It must map to AI Session read for both mobile route shapes.
  for (const path of [
    "/api/controlled-instances/instance_a/ai-sessions/session_a/timeline/sync",
    "/api/controlled-instances/instance_a/ai-sessions/session_a/turns/turn_a/timeline/sync",
  ]) {
    assert.equal(cloudRelayRouteReachable("POST", path), true, `${path} must stay reachable`);
    const authorization = routeAuthorization("POST", path);
    assert.deepEqual(authorization, { action: "read", resource: { type: "ai-session" } });
    assert.equal(can(cloudActor("role_timeline_reader", ["ai-sessions:read"]), authorization.action, authorization.resource), true, `${path} must allow AI Session readers`);
    assert.equal(can(cloudActor("role_without_timeline_read", ["instances:read"]), authorization.action, authorization.resource), false, `${path} must reject actors without AI Session read`);
  }

  for (const [method, path] of [
    ["GET", "/api/auth/login"],
    ["POST", "/api/auth/login"],
    ["POST", "/api/auth/bootstrap-admin"],
    ["POST", "/api/auth/mobile/login"],
    ["POST", "/api/auth/mobile/logout"],
    ["POST", "/api/operation-approvals/approval_a/decide"],
    ["GET", "/health"],
  ]) assert.equal(cloudRelayRouteReachable(method, path), false, `${method} ${path} must stay unreachable`);
});

test("mapped management routes still fail closed when the resolved role lacks the permission", () => {
  const viewer = cloudActor("role_custom_read", ["instances:read"]);
  for (const path of [
    "/api/users", "/api/roles", "/api/git-credentials",
    "/api/control-plane/settings", "/api/control-plane/diagnostic-logs/export",
  ]) {
    assert.equal(cloudRelayRouteReachable("GET", path), true, `${path} is matched by an RBAC mapping`);
    const authorization = routeAuthorization("GET", path);
    assert.equal(can(viewer, authorization.action, authorization.resource), false, `${path} must stay forbidden for viewer`);
  }
  assert.deepEqual(routeAuthorization("PATCH", "/api/shares/share_a"), {
    action: "update",
    resource: { type: "control-plane-settings" },
  });
});
