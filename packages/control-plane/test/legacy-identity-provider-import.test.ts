import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneSecretBox } from "../src/control-plane/auth/secret-box.ts";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { migrateLegacyIdentityProviderSecrets } from "../src/control-plane/persistence/database/legacy-identity-provider-import.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService, SecretEnvelopeSchema } from "../src/control-plane/persistence/secret-envelope.ts";

// Compatibility for v0.0.28: these fixtures exercise the retired
// identity-provider ciphertext only for the supported one-time upgrade path.
test("v0.0.28 identity-provider secrets are re-encrypted with the shared envelope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-idp-secret-import-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const legacy = new ControlPlaneSecretBox(paths.identityProviderEncryptionKeyPath);
  legacy.init();
  const plaintext = "legacy-provider-secret";
  const timestamp = "2026-08-01T00:00:00.000Z";
  await database.providers.put({
    id: "idp_legacy", name: "Legacy", kind: "github", status: "enabled", loginPolicy: "existing-only",
    clientId: "client-id", clientSecretCiphertext: legacy.seal(plaintext), callbackUrl: "https://cp.example.com/callback",
    createdAt: timestamp, updatedAt: timestamp,
  });
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  try {
    assert.deepEqual(await migrateLegacyIdentityProviderSecrets(database, secrets, paths), { migrated: true, count: 1 });
    const stored = (await database.providers.get("idp_legacy"))!;
    assert.equal(SecretEnvelopeSchema.safeParse(stored.clientSecretCiphertext).success, true);
    assert.equal(secrets.open(stored.clientSecretCiphertext, "identity-provider:idp_legacy:client-secret"), plaintext);
    const ledger = await database.migration("app_0002_migrate_v0.0.28_identity_provider_secrets");
    assert.equal(JSON.stringify(ledger).includes(plaintext), false);
    assert.deepEqual(await migrateLegacyIdentityProviderSecrets(database, secrets, paths), { migrated: false, count: 1 });
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy identity-provider migration does not create a missing old key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-idp-key-missing-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const timestamp = "2026-08-01T00:00:00.000Z";
  await database.providers.put({
    id: "idp_legacy", name: "Legacy", kind: "github", status: "enabled", loginPolicy: "existing-only",
    clientId: "client-id", clientSecretCiphertext: "v1.nonce.ciphertext.tag", callbackUrl: "https://cp.example.com/callback",
    createdAt: timestamp, updatedAt: timestamp,
  });
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  try {
    await assert.rejects(
      () => migrateLegacyIdentityProviderSecrets(database, secrets, paths),
      (error: any) => error.code === "CONTROL_PLANE_LEGACY_KEYSTORE_MISSING",
    );
    assert.equal(fs.existsSync(paths.identityProviderEncryptionKeyPath), false);
    assert.equal(await database.migration("app_0002_migrate_v0.0.28_identity_provider_secrets"), undefined);
  } finally {
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
