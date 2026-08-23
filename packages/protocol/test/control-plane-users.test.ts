import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_PLANE_PERMISSION_IDS,
  ControlPlaneCurrentAuthorizationSchema,
  ControlPlaneIdentityProviderSummarySchema,
  ControlPlanePermissionIdSchema,
  ControlPlanePublicCapabilitiesSchema,
  ControlPlaneUserDetailSchema,
  controlPlaneAccessManagementCapabilities,
  normalizeControlPlanePublicCapabilities,
  supportsControlPlaneCustomRoles,
  supportsControlPlaneExternalIdentityLogin,
  supportsControlPlaneUserManagement,
} from "../src/control-plane-access.ts";
import { parseResponse } from "../src/response-validation.ts";

const baseCapabilities = {
  authentication: "required" as const,
  aiSessions: true,
  nodes: true,
  instanceBoard: true,
};

const accessManagement = {
  userManagement: { users: true as const, identities: true as const, sessions: true as const },
  authentication: { externalIdentity: { oidc: true, oauthAdapters: ["github" as const] } },
  authorization: { customRoles: true, nodeScopes: true as const, authorizationRevisions: true as const },
};

test("access management capabilities normalize through one query boundary", () => {
  assert.equal(supportsControlPlaneUserManagement(baseCapabilities), false);
  assert.equal(supportsControlPlaneExternalIdentityLogin(baseCapabilities), false);
  assert.equal(supportsControlPlaneCustomRoles(baseCapabilities), false);
  const wire = { ...baseCapabilities, accessManagement: { ...accessManagement, future: true }, future: true };
  assert.equal(supportsControlPlaneUserManagement(wire), true);
  assert.equal(supportsControlPlaneExternalIdentityLogin(wire), true);
  assert.equal(supportsControlPlaneCustomRoles(wire), true);
  assert.deepEqual(controlPlaneAccessManagementCapabilities(wire), accessManagement);
  assert.deepEqual(normalizeControlPlanePublicCapabilities(wire), { ...baseCapabilities, accessManagement });
  assert.equal(ControlPlanePublicCapabilitiesSchema.safeParse(wire).success, false);
});

test("user wire models ignore unknown response fields and keep secrets out", () => {
  const user = parseResponse(ControlPlaneUserDetailSchema, {
    id: "user_1",
    displayName: "Alice",
    primaryUsername: "alice",
    status: "active",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    identities: [{
      id: "identity_1",
      userId: "user_1",
      kind: "local-password",
      loginName: "alice",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      passwordHash: "must-not-survive",
    }],
    accessGrant: {
      userId: "user_1",
      roleIds: ["role_admin"],
      nodeScope: { kind: "all", future: true },
      authorizationRevision: 1,
      updatedAt: "2026-08-23T00:00:00.000Z",
    },
    privateNotes: "must-not-survive",
  });
  assert.equal("privateNotes" in user, false);
  assert.equal("passwordHash" in user.identities[0], false);
  assert.equal(ControlPlaneUserDetailSchema.safeParse({ ...user, id: undefined }).success, false);
});

test("authorization accepts only catalog permissions", () => {
  const authorization = ControlPlaneCurrentAuthorizationSchema.parse({
    userId: "user_1",
    identityId: "identity_1",
    roleIds: ["role_operator"],
    permissionIds: ["nodes:read", "instances:interactive"],
    nodeScope: { kind: "selected", nodeIds: ["node_1"] },
    authorizationRevision: 2,
  });
  assert.deepEqual(authorization.permissionIds, ["nodes:read", "instances:interactive"]);
  assert.equal(ControlPlaneCurrentAuthorizationSchema.safeParse({ ...authorization, permissionIds: ["unknown:permission"] }).success, false);
  assert.equal(CONTROL_PLANE_PERMISSION_IDS.every((id) => ControlPlanePermissionIdSchema.safeParse(id).success), true);
});

test("identity provider public model rejects secrets and requires OIDC issuer", () => {
  const provider = {
    id: "provider_1",
    name: "Company Login",
    kind: "oidc" as const,
    status: "enabled" as const,
    loginPolicy: "existing-only" as const,
    issuer: "https://id.example.com",
    clientId: "control-plane",
    callbackUrl: "https://cp.example.com/api/auth/external/callback",
    clientSecretConfigured: true,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
  assert.equal(ControlPlaneIdentityProviderSummarySchema.safeParse(provider).success, true);
  assert.equal(ControlPlaneIdentityProviderSummarySchema.safeParse({ ...provider, issuer: undefined }).success, false);
  assert.equal(ControlPlaneIdentityProviderSummarySchema.safeParse({ ...provider, clientSecret: "secret" }).success, false);
});
