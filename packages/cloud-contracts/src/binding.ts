import { z } from "zod";
import { DateTimeSchema, IdSchema, LocaleTextSchema, OpaqueSecretSchema, Sha256DigestSchema } from "./common.ts";
import { CONTROL_PLANE_BINDING_PROTOCOL_VERSION, OfficialAudience } from "./versions.ts";

export const ControlPlaneIdentitySchema = z.strictObject({
  controlPlaneId: IdSchema,
  algorithm: z.literal("Ed25519"),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  fingerprint: Sha256DigestSchema,
});

export const BindingChallengeCapabilitySchema = z.strictObject({
  protocolVersion: z.literal(CONTROL_PLANE_BINDING_PROTOCOL_VERSION),
  audience: z.literal(OfficialAudience.Binding),
  challengeId: IdSchema,
  challenge: OpaqueSecretSchema,
  serviceOrigin: z.string().url(),
  identity: ControlPlaneIdentitySchema,
  nonce: z.string().min(16).max(256),
  initiatingAdminSessionId: IdSchema,
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
});

export const BindingConflictSchema = z.strictObject({
  code: z.enum(["CONTROL_PLANE_ALREADY_BOUND", "REVISION_CONFLICT", "REVOCATION_PENDING", "IDENTITY_CLONE_CONFLICT"]),
  controlPlaneId: IdSchema,
  expectedRevision: z.number().int().nonnegative().optional(),
  actualRevision: z.number().int().nonnegative().optional(),
  retryable: z.boolean(),
});

export const ControlPlaneDirectoryEntrySchema = z.strictObject({
  // Independently upgraded Coordinators may omit relay binding identity.
  bindingId: IdSchema.optional(),
  controlPlaneId: IdSchema,
  displayName: LocaleTextSchema,
  publicKeyFingerprint: Sha256DigestSchema,
  bindingRevision: z.number().int().positive(),
  remoteAccess: z.enum(["enabled", "disabled", "revocation-pending"]),
  leaseExpiresAt: DateTimeSchema.optional(),
  lastConnectedAt: DateTimeSchema.optional(),
  relayUsageBytes: z.number().int().nonnegative(),
  relayQuotaBytes: z.number().int().nonnegative().optional(),
  versionWarning: z.string().trim().min(1).max(500).optional(),
  errorCode: z.string().trim().min(1).max(160).optional(),
});

export type ControlPlaneDirectoryEntry = z.infer<typeof ControlPlaneDirectoryEntrySchema>;
