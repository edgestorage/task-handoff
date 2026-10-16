import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_ACCOUNT_PERMISSION_IDS,
  can,
  cloudAccountAuthorization,
  permissionForControlPlaneOperation,
} from "../src/control-plane/auth/authorization.ts";
import { cloudRelayRouteReachable, routeAuthorization } from "../src/control-plane/http/server.ts";

const ACTIONS = [
  "read", "read-file-content", "create", "update", "delete", "start", "stop", "restart",
  "proxy", "interactive-access", "send-message", "approve", "interrupt",
  "manage-settings", "manage-secrets", "manage-members", "manage-node-auth",
];
const RESOURCE_TYPES = [
  "project", "node", "runtime", "template", "instance", "app-session", "ai-session",
  "trigger-template", "trigger-deployment", "repository", "attachment", "image", "model",
  "user", "role", "identity-provider", "user-session", "identity-approval", "user-audit",
  "chat-bridge", "control-plane-settings", "secret", "public-directory",
];
const cloudActor = { type: "cloud-account", accountId: "account_a", deviceSessionId: "device_a", bindingId: "binding_a", bindingRevision: 4 };

test("the cloud account authorization projection never grants more than the enforcement model", () => {
  const authorization = cloudAccountAuthorization(cloudActor);
  assert.deepEqual(authorization, {
    userId: "cloud-account:account_a",
    identityId: "cloud-device:device_a",
    roleIds: ["role_cloud_account"],
    permissionIds: [...CLOUD_ACCOUNT_PERMISSION_IDS],
    nodeScope: { kind: "all" },
    instanceScope: { kind: "inherit-node-scope" },
    authorizationRevision: 4,
  });
  for (const type of RESOURCE_TYPES) {
    for (const action of ACTIONS) {
      const permission = permissionForControlPlaneOperation(action, type);
      if (!permission || !authorization.permissionIds.includes(permission)) continue;
      assert.equal(can(cloudActor, action, { type }), true, `${action} ${type} projects ${permission} but is forbidden`);
    }
  }
});

test("the projection covers relayed mobile surfaces and keeps the admin surfaces closed", () => {
  const authorization = cloudAccountAuthorization(cloudActor);
  for (const action of ["read", "send-message", "approve", "interrupt"]) {
    assert.equal(authorization.permissionIds.includes(permissionForControlPlaneOperation(action, "ai-session")), true, action);
  }
  for (const [action, type] of [
    ["start", "instance"],
    ["interactive-access", "app-session"],
    ["create", "trigger-deployment"],
    ["send-message", "ai-session"],
    ["read", "model"],
  ]) {
    assert.equal(authorization.permissionIds.includes(permissionForControlPlaneOperation(action, type)), true, `${action} ${type}`);
  }
  for (const [action, type] of [
    ["read", "user"], ["manage-members", "user"], ["read", "role"], ["read", "secret"],
    ["manage-secrets", "model"], ["read", "control-plane-settings"], ["manage-settings", "control-plane-settings"],
    ["read", "chat-bridge"], ["read", "identity-provider"], ["update", "node"], ["manage-node-auth", "node"],
  ]) {
    assert.equal(can(cloudActor, action, { type }), false, `${action} ${type} must stay forbidden`);
  }
  assert.equal(authorization.permissionIds.includes("nodes:read"), true);
  assert.equal(can(cloudActor, "read", { type: "node" }), true);
});

test("relayed cloud accounts reach credential-free client bootstrap routes but nothing else", () => {
  for (const path of [
    "/api/auth/session",
    "/api/auth/session?signal=1",
    "/api/access/me",
    "/api/control-plane/identity",
    "/api/health",
    "/api/controlled-instances/instance_a/ai-sessions",
    "/api/nodes",
  ]) {
    assert.equal(cloudRelayRouteReachable("GET", path), true, `${path} must stay reachable`);
  }
  // The mobile reconnect path posts its checkpoints to the sync route; it must be
  // reachable to cloud accounts or every reconnect fails with CONTROL_PLANE_FORBIDDEN.
  assert.equal(cloudRelayRouteReachable("POST", "/api/ai-sessions/sync?hierarchy=subagents"), true);
  assert.deepEqual(routeAuthorization("POST", "/api/ai-sessions/sync"), { action: "read", resource: { type: "public-directory" } });
  assert.deepEqual(routeAuthorization("GET", "/api/ai-sessions"), { action: "read", resource: { type: "public-directory" } });
  for (const [method, path] of [
    ["GET", "/api/auth/login"],
    ["POST", "/api/auth/login"],
    ["POST", "/api/auth/bootstrap-admin"],
    ["POST", "/api/auth/mobile/login"],
    ["POST", "/api/auth/mobile/logout"],
    ["POST", "/api/operation-approvals/approval_a/decide"],
    ["GET", "/health"],
  ]) {
    assert.equal(cloudRelayRouteReachable(method, path), false, `${method} ${path} must stay unreachable`);
  }
});

test("reachable routes still pass the cloud account authorization layer", () => {
  for (const path of [
    "/api/users", "/api/roles", "/api/git-credentials",
    "/api/control-plane/settings", "/api/control-plane/diagnostic-logs/export",
    "/api/future-sensitive-operation",
  ]) {
    assert.equal(cloudRelayRouteReachable("GET", path), true, `${path} is matched by an RBAC mapping`);
  }
  assert.equal(can(cloudActor, "read", { type: "user" }), false);
  assert.equal(can(cloudActor, "read", { type: "role" }), false);
  assert.equal(can(cloudActor, "manage-secrets", { type: "secret" }), false);
  assert.equal(can(cloudActor, "manage-settings", { type: "control-plane-settings" }), false);
});
