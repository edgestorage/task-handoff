import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { externalIdentityProviderAdapter } from "../src/control-plane/auth/external-identity-providers.ts";
import { ControlPlaneIdentityProviderService } from "../src/control-plane/auth/identity-provider-service.ts";
import { ControlPlaneUserStore } from "../src/control-plane/auth/user-store.ts";
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
    const store = new ControlPlaneUserStore(paths);
    await store.init();
    await store.initializeForBootstrap();
    const service = new ControlPlaneIdentityProviderService(paths, store, { fetch: async () => new Response(JSON.stringify({
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
    assert.equal(service.clientSecret(provider.id), "top-secret");
    const stored = store.providers.get(provider.id)!;
    assert.notEqual(stored.clientSecretCiphertext, "top-secret");
    await store.close();
    assert.equal(fs.readFileSync(paths.userDatabasePath).includes(Buffer.from("top-secret")), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
