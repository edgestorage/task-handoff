import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { externalIdentityProviderAdapter } from "../src/control-plane/auth/external-identity-providers.ts";
import { ControlPlaneIdentityProviderService } from "../src/control-plane/auth/identity-provider-service.ts";
import { ControlPlaneUserService } from "../src/control-plane/auth/user-service.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";

test("provider adapters derive stable subjects without email fallback", () => {
  assert.deepEqual(externalIdentityProviderAdapter("oidc").normalizeClaims({ sub: "subject-1", email: "a@example.com", email_verified: true }), {
    subject: "subject-1",
    verifiedEmail: "a@example.com",
  });
  assert.deepEqual(externalIdentityProviderAdapter("github").normalizeClaims({ id: 1234, login: "alice", email: "a@example.com" }), {
    subject: "1234",
    verifiedEmail: "a@example.com",
    displayName: "alice",
  });
  assert.throws(() => externalIdentityProviderAdapter("github").normalizeClaims({ login: "alice", email: "a@example.com" }));
});

test("provider service validates discovery, encrypts client secrets and never returns them", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-idp-"));
  try {
    const paths = controlPlaneStorePaths(dataDir);
    const users = new ControlPlaneUserService(paths);
    await users.bootstrapAdmin({ username: "admin", password: "password123" });
    const service = new ControlPlaneIdentityProviderService(paths, users, { fetch: async () => new Response(JSON.stringify({
      issuer: "https://id.example.com",
      authorization_endpoint: "https://id.example.com/authorize",
      token_endpoint: "https://id.example.com/token",
      jwks_uri: "https://id.example.com/jwks",
    }), { status: 200, headers: { "content-type": "application/json" } }) });
    service.init();
    const provider = await service.create({
      name: "Company Login",
      kind: "oidc",
      issuer: "https://id.example.com",
      clientId: "control-plane",
      clientSecret: "top-secret",
      callbackUrl: "https://cp.example.com/api/auth/external/callback",
    });
    assert.equal(provider.clientSecretConfigured, true);
    assert.equal("clientSecret" in provider, false);
    assert.equal(await service.clientSecret(provider.id), "top-secret");
    const stored = (await users.store.providers.get(provider.id))!;
    assert.notEqual(stored.clientSecretCiphertext, "top-secret");
    await users.store.close();
    assert.equal(fs.readFileSync(paths.userDatabasePath).includes(Buffer.from("top-secret")), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("provider identity namespace is immutable while identities or pending approvals reference it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-idp-namespace-"));
  try {
    const paths = controlPlaneStorePaths(dataDir);
    const users = new ControlPlaneUserService(paths);
    const admin = await users.bootstrapAdmin({ username: "admin", password: "password123" });
    let discoveryRequests = 0;
    const service = new ControlPlaneIdentityProviderService(paths, users, { fetch: async () => {
      discoveryRequests += 1;
      return new Response(JSON.stringify({
        issuer: "https://id.example.com",
        authorization_endpoint: "https://id.example.com/authorize",
        token_endpoint: "https://id.example.com/token",
        jwks_uri: "https://id.example.com/jwks",
      }), { status: 200, headers: { "content-type": "application/json" } });
    } });
    service.init();
    const provider = await service.create({
      name: "Company Login",
      kind: "oidc",
      issuer: "https://id.example.com",
      clientId: "control-plane",
      clientSecret: "top-secret",
      callbackUrl: "https://cp.example.com/api/auth/external/callback",
    });
    const identityTimestamp = new Date().toISOString();
    await users.store.identities.put({ id: "identity_oidc_admin", userId: admin.id, providerId: provider.id, subject: "admin-subject", kind: "oidc", createdAt: identityTimestamp, updatedAt: identityTimestamp });

    await assert.rejects(
      () => service.update(provider.id, { issuer: "https://other.example.com" }),
      { code: "CONTROL_PLANE_IDENTITY_PROVIDER_NAMESPACE_IMMUTABLE", statusCode: 409 },
    );
    assert.equal(discoveryRequests, 1, "referenced namespace changes should fail before remote discovery");

    const renamed = await service.update(provider.id, { name: "Renamed Login", issuer: "https://id.example.com/" });
    assert.equal(renamed.name, "Renamed Login");
    assert.equal(discoveryRequests, 2);

    const pendingProvider = await service.create({
      name: "Pending Login",
      kind: "oidc",
      issuer: "https://id.example.com",
      clientId: "pending-control-plane",
      clientSecret: "pending-secret",
      callbackUrl: "https://cp.example.com/api/auth/external/callback",
    });
    const timestamp = new Date().toISOString();
    await users.store.approvals.put({
      id: "approval_pending",
      providerId: pendingProvider.id,
      subject: "pending-subject",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await assert.rejects(
      () => service.update(pendingProvider.id, { kind: "github" }),
      { code: "CONTROL_PLANE_IDENTITY_PROVIDER_NAMESPACE_IMMUTABLE", statusCode: 409 },
    );
    await users.store.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
