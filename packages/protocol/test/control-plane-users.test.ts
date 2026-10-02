import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_PLANE_PERMISSION_IDS,
  CONTROL_PLANE_CLI_DEVICE_CODE_GRANT_TYPE,
  ControlPlaneCliAuthorizationErrorCodeSchema,
  ControlPlaneCliAuthorizationRequestSchema,
  ControlPlaneCliTokenRequestSchema,
  ControlPlaneCliTokenResponseSchema,
  ControlPlaneCurrentAuthorizationSchema,
  ControlPlaneExternalIdentityApprovalSummarySchema,
  ControlPlaneIdentityProviderSummarySchema,
  ControlPlanePermissionIdSchema,
  ControlPlanePublicCapabilitiesSchema,
  ControlPlaneLoginIdentitySummarySchema,
  ControlPlaneUserDetailSchema,
  ControlPlaneUpdateUserInputSchema,
  controlPlaneAccessManagementCapabilities,
  normalizeControlPlanePublicCapabilities,
  parseControlPlaneCliLoopbackRedirectUri,
  supportsControlPlaneCustomRoles,
  supportsControlPlaneCliSessions,
  supportsControlPlaneLocalCliSessions,
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
  authorization: { customRoles: true, nodeScopes: true as const, instanceScopes: true as const, authorizationRevisions: true as const },
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

test("cli session capability normalizes through the same capability boundary", () => {
  assert.equal(supportsControlPlaneCliSessions(baseCapabilities), false);
  assert.equal(supportsControlPlaneCliSessions({ ...baseCapabilities, cliSessions: true }), true);
  assert.equal(supportsControlPlaneCliSessions({ ...baseCapabilities, cliSessions: "true" }), false);
  assert.deepEqual(normalizeControlPlanePublicCapabilities({ ...baseCapabilities, cliSessions: true, future: true }), {
    ...baseCapabilities,
    cliSessions: true,
  });
});

test("local cli session capability stays additive and independent from cli sessions", () => {
  assert.equal(supportsControlPlaneLocalCliSessions(baseCapabilities), false);
  assert.equal(supportsControlPlaneLocalCliSessions({ ...baseCapabilities, localCliSessions: true }), true);
  assert.equal(supportsControlPlaneLocalCliSessions({ ...baseCapabilities, localCliSessions: "true" }), false);
  const disabled = { ...baseCapabilities, authentication: "disabled" as const, localCliSessions: true };
  assert.equal(supportsControlPlaneCliSessions(disabled), false);
  assert.deepEqual(normalizeControlPlanePublicCapabilities({ ...disabled, future: true }), disabled);
});

test("local trust identities project without login name or external provider", () => {
  const identity = ControlPlaneLoginIdentitySummarySchema.parse({
    id: "identity_local",
    userId: "user_local",
    kind: "local-trust",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(identity.kind, "local-trust");
  assert.equal(identity.providerId, undefined);
  assert.equal(ControlPlaneLoginIdentitySummarySchema.safeParse({ ...identity, passwordHash: "must-not-survive" }).success, false);
  assert.equal(ControlPlaneLoginIdentitySummarySchema.safeParse({ ...identity, kind: "oauth" }).success, false);
});

test("cli authorization requests separate the browser and device modes", () => {
  const client = { name: "dev-mac", platform: "darwin" as const, version: "0.1.0" };
  const browser = ControlPlaneCliAuthorizationRequestSchema.parse({
    mode: "browser",
    client,
    redirectUri: "http://127.0.0.1:49152/callback",
    state: "cli-state-0123456789",
    codeChallenge: "A".repeat(43),
    codeChallengeMethod: "S256",
  });
  assert.equal(browser.mode, "browser");
  assert.equal(ControlPlaneCliAuthorizationRequestSchema.parse({ mode: "device", client }).mode, "device");

  const browserInput = { mode: "browser" as const, client, state: "cli-state-0123456789", codeChallenge: "A".repeat(43), codeChallengeMethod: "S256" as const };
  for (const redirectUri of [
    "https://127.0.0.1:49152/callback",
    "http://localhost:49152/callback",
    "http://127.0.0.1:49152/other",
    "http://192.168.1.10:49152/callback",
    "http://127.0.0.1:49152/callback?next=evil",
    "thctl://callback",
  ]) {
    assert.equal(ControlPlaneCliAuthorizationRequestSchema.safeParse({ ...browserInput, redirectUri }).success, false, redirectUri);
  }
  assert.equal(parseControlPlaneCliLoopbackRedirectUri("http://[::1]:8080/callback")?.port, "8080");
  assert.equal(ControlPlaneCliAuthorizationRequestSchema.safeParse({ ...browserInput, redirectUri: "http://[::1]:8080/callback" }).success, true);
});

test("cli token exchange keeps the two grants apart and rejects mixed shapes", () => {
  const codeGrant = ControlPlaneCliTokenRequestSchema.parse({
    grantType: "authorization_code",
    requestId: "cliauth_1",
    code: "one-time-code",
    codeVerifier: "v".repeat(43),
  });
  assert.equal(codeGrant.grantType, "authorization_code");
  assert.equal(CONTROL_PLANE_CLI_DEVICE_CODE_GRANT_TYPE, "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(ControlPlaneCliTokenRequestSchema.parse({
    grantType: CONTROL_PLANE_CLI_DEVICE_CODE_GRANT_TYPE,
    requestId: "cliauth_1",
  }).grantType, CONTROL_PLANE_CLI_DEVICE_CODE_GRANT_TYPE);
  assert.equal(ControlPlaneCliTokenRequestSchema.safeParse({
    grantType: CONTROL_PLANE_CLI_DEVICE_CODE_GRANT_TYPE,
    requestId: "cliauth_1",
    codeVerifier: "v".repeat(43),
  }).success, false);
  assert.equal(ControlPlaneCliTokenRequestSchema.safeParse({ grantType: "authorization_code", requestId: "cliauth_1" }).success, false);
  assert.equal(ControlPlaneCliAuthorizationErrorCodeSchema.safeParse("CLI_AUTHORIZATION_SLOW_DOWN").success, true);
  assert.equal(ControlPlaneCliAuthorizationErrorCodeSchema.safeParse("CLI_AUTHORIZATION_INVALID_PASSWORD").success, false);
});

test("cli token response keeps session secrets out of the wire model", () => {
  const session = {
    id: "csess_0000000000000",
    userId: "user_1",
    identityId: "identity_1",
    clientType: "cli" as const,
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-15T00:00:00.000Z",
    lastSeenAt: "2026-10-01T00:00:00.000Z",
    client: { name: "dev-mac", platform: "darwin" as const, version: "0.1.0" },
    user: {
      id: "user_1",
      displayName: "Alice",
      status: "active" as const,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  };
  const parsed = parseResponse(ControlPlaneCliTokenResponseSchema, {
    data: {
      sessionToken: "csess_0000000000000.abcdefghijklmnopqrstuvwxyz012345",
      session: { ...session, tokenHash: "leaked-hash" },
      authorization: {
        userId: "user_1",
        identityId: "identity_1",
        roleIds: ["role_admin"],
        permissionIds: ["ai-sessions:read"],
        nodeScope: { kind: "all" as const },
        instanceScope: { kind: "inherit-node-scope" as const },
        authorizationRevision: 3,
      },
    },
  });
  assert.equal(parsed.data.session.clientType, "cli");
  assert.equal(parsed.data.session.client.name, "dev-mac");
  assert.equal("tokenHash" in parsed.data.session, false);
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
  assert.deepEqual(user.accessGrant.instanceScope, { kind: "inherit-node-scope" });
  assert.equal(ControlPlaneUserDetailSchema.safeParse({ ...user, id: undefined }).success, false);
});

test("user update input keeps local username changes inside the user API boundary", () => {
  assert.deepEqual(ControlPlaneUpdateUserInputSchema.parse({ displayName: "Alice Doe", username: "Alice.New" }), {
    displayName: "Alice Doe",
    username: "Alice.New",
  });
  assert.equal(ControlPlaneUpdateUserInputSchema.safeParse({ username: "invalid username" }).success, false);
  assert.equal(ControlPlaneUpdateUserInputSchema.safeParse({}).success, false);
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
  assert.deepEqual(authorization.instanceScope, { kind: "inherit-node-scope" });
  assert.deepEqual(ControlPlaneCurrentAuthorizationSchema.parse({
    ...authorization,
    instanceScope: { kind: "selected", instanceIds: ["instance_1"] },
  }).instanceScope, { kind: "selected", instanceIds: ["instance_1"] });
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

test("external identity approvals expose only the review wire model", () => {
  const approval = parseResponse(ControlPlaneExternalIdentityApprovalSummarySchema, {
    id: "approval_1",
    providerId: "provider_1",
    subject: "subject_1",
    verifiedEmail: "alice@example.com",
    displayName: "Alice",
    status: "pending",
    expiresAt: "2026-08-24T00:00:00.000Z",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    internalState: "must-not-survive",
  });
  assert.equal("internalState" in approval, false);
  assert.equal(ControlPlaneExternalIdentityApprovalSummarySchema.safeParse({ ...approval, subject: undefined }).success, false);
});
