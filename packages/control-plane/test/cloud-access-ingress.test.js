import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CONTROL_PLANE_PERMISSION_IDS } from "@task-handoff/protocol/control-plane-access";
import { cloudAccountAuthorization } from "../src/control-plane/auth/authorization.ts";
import { ControlPlaneIdentityService } from "../src/control-plane/identity/service.ts";
import { CloudAccessIngress } from "../src/control-plane/cloud-connectivity/access-ingress.ts";
import { CloudConnectivityService } from "../src/control-plane/cloud-connectivity/service.ts";
import { cloudRelayRouteReachable, routeAuthorization } from "../src/control-plane/http/cloud-relay-authorization.ts";

const VIEWER_PERMISSIONS = CONTROL_PLANE_PERMISSION_IDS.filter((id) => id.endsWith(":read"));
const OPERATOR_DENIED_PREFIXES = ["users:", "roles:", "identity-providers:", "settings:", "secrets:", "chat-bridges:"];
const OPERATOR_PERMISSIONS = CONTROL_PLANE_PERMISSION_IDS.filter((id) => !OPERATOR_DENIED_PREFIXES.some((prefix) => id.startsWith(prefix)));

async function role(roleId) {
  if (roleId === "role_admin") return { roleIds: [roleId], permissionIds: [...CONTROL_PLANE_PERMISSION_IDS], authorizationRevision: 11 };
  if (roleId === "role_operator") return { roleIds: [roleId], permissionIds: [...OPERATOR_PERMISSIONS], authorizationRevision: 12 };
  if (roleId === "role_viewer") return { roleIds: [roleId], permissionIds: [...VIEWER_PERMISSIONS], authorizationRevision: 13 };
  throw Object.assign(new Error("Cloud access references an unavailable Control Plane role."), {
    code: "CONTROL_PLANE_ROLE_INACTIVE",
    statusCode: 403,
  });
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-ingress-"));
  const identity = new ControlPlaneIdentityService(path.join(directory, "identity.json"), () => "control_plane_a"); identity.init();
  const state = new CloudConnectivityService({ statePath: path.join(directory, "cloud.json"), identity, serviceOrigin: "https://cloud.example.test" }); state.init();
  const challenge = state.createChallenge(); state.consumeChallenge({ challengeCode: challenge.challengeCode, controlPlaneId: challenge.payload.controlPlaneId, fingerprint: challenge.payload.publicKeyFingerprint });
  state.setCloudControlPlaneId("cp_cloud_a");
  state.activate({ accountId: "account_a", bindingId: "binding_a", bindingRevision: 4, backgroundCredential: "x".repeat(48) });
  const assertion = {
    accountId: "account_a",
    ownerAccountId: "account_a",
    deviceSessionId: "device_a",
    controlPlaneId: "cp_cloud_a",
    bindingId: "binding_a",
    bindingRevision: 4,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    accessMode: "owner",
    accessRoleId: "role_admin",
  };
  const ingress = new CloudAccessIngress({ state, verifyAssertion: (value) => value, resolveRole: role });
  return { state, assertion, ingress };
}

test("cloud ingress resolves the owner role through the local role store", async () => {
  const { assertion, ingress } = await fixture();
  const actor = await ingress.authorize(assertion, "manage-settings", { type: "control-plane-settings" });
  assert.equal(actor.type, "cloud-account");
  assert.equal(actor.accessRoleId, "role_admin");
  assert.deepEqual(actor.roleIds, ["role_admin"]);
  assert.deepEqual(actor.permissionIds, [...CONTROL_PLANE_PERMISSION_IDS]);
  assert.equal(actor.authorizationRevision, 11);
  await ingress.authorize(assertion, "start", { type: "instance", id: "instance_a" });
  await ingress.authorize(assertion, "send-message", { type: "ai-session", id: "session_a" });
});

test("cloud ingress actor projects the resolved role through /api/access/me", async () => {
  const { assertion, ingress } = await fixture();
  const actor = await ingress.actor(assertion);
  assert.equal(cloudRelayRouteReachable("GET", "/api/access/me"), true);
  assert.equal(routeAuthorization("GET", "/api/access/me"), undefined);
  assert.deepEqual(cloudAccountAuthorization(actor), {
    userId: "cloud-account:account_a",
    identityId: "cloud-device:device_a",
    roleIds: ["role_admin"],
    permissionIds: [...CONTROL_PLANE_PERMISSION_IDS],
    nodeScope: { kind: "all" },
    instanceScope: { kind: "inherit-node-scope" },
    authorizationRevision: 11,
  });
});

test("cloud ingress rejects stale revision, disabled remote access and expired assertions", async () => {
  const { state, assertion, ingress } = await fixture();
  await assert.rejects(() => ingress.actor({ ...assertion, bindingRevision: 3 }), { code: "CLOUD_ASSERTION_NOT_AUTHORIZED" });
  state.setRemoteAccess(false);
  await assert.rejects(() => ingress.actor(assertion), { code: "CLOUD_ASSERTION_NOT_AUTHORIZED" });
});

test("shared cloud view assertions use the exact local viewer permissions", async () => {
  const { assertion, ingress } = await fixture();
  const shared = {
    ...assertion,
    accountId: "account_grantee",
    accessMode: "shared",
    shareGrantId: "share_a",
    shareRevision: 3,
    accessRoleId: "role_viewer",
  };
  const actor = await ingress.authorize(shared, "read", { type: "instance", id: "instance_a" });
  assert.equal(actor.type, "cloud-account");
  assert.equal(actor.accountId, "account_grantee");
  assert.equal(actor.ownerAccountId, "account_a");
  assert.equal(actor.accessRoleId, "role_viewer");
  assert.deepEqual(actor.permissionIds, [...VIEWER_PERMISSIONS]);
  await assert.rejects(() => ingress.authorize(shared, "start", { type: "instance", id: "instance_a" }), { code: "CONTROL_PLANE_FORBIDDEN" });
  await assert.rejects(() => ingress.authorize(shared, "proxy", { type: "instance", id: "instance_a" }), { code: "CONTROL_PLANE_FORBIDDEN" });
  await assert.rejects(() => ingress.authorize({ ...shared, ownerAccountId: "account_forged" }, "read", { type: "instance", id: "instance_a" }), { code: "CLOUD_ASSERTION_NOT_AUTHORIZED" });
});

test("shared operator assertions follow the local operator permissions", async () => {
  const { assertion, ingress } = await fixture();
  const shared = {
    ...assertion,
    accountId: "account_grantee",
    accessMode: "shared",
    shareGrantId: "share_operator",
    shareRevision: 7,
    accessRoleId: "role_operator",
  };
  await ingress.authorize(shared, "start", { type: "instance", id: "instance_a" });
  await ingress.authorize(shared, "proxy", { type: "instance", id: "instance_a" });
  for (const [action, resource] of [
    ["manage-members", { type: "user" }],
    ["manage-members", { type: "role" }],
    ["manage-settings", { type: "control-plane-settings" }],
    ["manage-secrets", { type: "secret" }],
    ["read", { type: "chat-bridge" }],
    ["manage-node-auth", { type: "node" }],
  ]) await assert.rejects(() => ingress.authorize(shared, action, resource), { code: "CONTROL_PLANE_FORBIDDEN" });
});

test("missing and archived roles fail closed without a legacy fallback", async () => {
  const { assertion, ingress } = await fixture();
  for (const accessRoleId of ["role_archived", "role_missing"]) {
    await assert.rejects(
      () => ingress.authorize({ ...assertion, accessRoleId }, "read", { type: "instance", id: "instance_a" }),
      { code: "CONTROL_PLANE_ROLE_INACTIVE", statusCode: 403 },
    );
  }
  await assert.rejects(
    () => ingress.authorize({ ...assertion, accessRoleId: undefined }, "read", { type: "instance", id: "instance_a" }),
    { code: "CONTROL_PLANE_ROLE_INACTIVE", statusCode: 403 },
  );
});
