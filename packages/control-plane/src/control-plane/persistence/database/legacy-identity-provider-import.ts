import crypto from "node:crypto";
import type { ControlPlaneStorePaths } from "../paths.ts";
import { LegacyControlPlaneSecretReader } from "../legacy-secret-reader.ts";
import { SecretEnvelopeSchema, type SecretEnvelopeService } from "../secret-envelope.ts";
import type { ControlPlaneDatabase } from "./index.ts";

const MIGRATION_ID = "app_0002_migrate_v0.0.28_identity_provider_secrets";
const MIGRATION_CHECKSUM = crypto.createHash("sha256").update("identity-provider-secret-envelope:v1").digest("hex");

function context(providerId: string) {
  return `identity-provider:${providerId}:client-secret`;
}

// Compatibility for v0.0.28: identity-provider rows already live in SQL, but
// their ciphertext uses the retired identity-provider file key and envelope.
export async function migrateLegacyIdentityProviderSecrets(database: ControlPlaneDatabase, secrets: SecretEnvelopeService, paths: ControlPlaneStorePaths) {
  const previous = await database.migration(MIGRATION_ID);
  if (previous) {
    if (previous.checksum !== MIGRATION_CHECKSUM) throw Object.assign(new Error("Identity provider secret migration checksum does not match."), { code: "CONTROL_PLANE_IDENTITY_PROVIDER_MIGRATION_CHECKSUM_MISMATCH" });
    return { migrated: false, count: Number(previous.details.providers || 0) };
  }
  const providers = await database.providers.list();
  const legacy = providers.filter((provider) => !SecretEnvelopeSchema.safeParse(provider.clientSecretCiphertext).success);
  const reader = legacy.length ? new LegacyControlPlaneSecretReader(paths.identityProviderEncryptionKeyPath, "identity provider") : undefined;
  const plaintext = legacy.map((provider) => {
    try { return { provider, secret: reader!.open(provider.clientSecretCiphertext) }; }
    catch (error) {
      throw Object.assign(new Error("Legacy identity provider secret could not be authenticated.", { cause: error }), {
        code: "CONTROL_PLANE_IDENTITY_PROVIDER_MIGRATION_SECRET_INVALID",
        statusCode: 500,
        details: { providerId: provider.id },
      });
    }
  });
  const appliedAt = new Date().toISOString();
  await database.transaction(async (transaction) => {
    for (const { provider, secret } of plaintext) {
      await transaction.providers.put({ ...provider, clientSecretCiphertext: secrets.seal(secret, context(provider.id)) });
    }
    for (const provider of providers.filter((candidate) => SecretEnvelopeSchema.safeParse(candidate.clientSecretCiphertext).success)) {
      secrets.open(provider.clientSecretCiphertext, context(provider.id));
    }
    await transaction.putMigration({ id: MIGRATION_ID, checksum: MIGRATION_CHECKSUM, appliedAt, details: { sourceVersion: "v0.0.28", providers: plaintext.length } });
  });
  return { migrated: plaintext.length > 0, count: plaintext.length };
}
