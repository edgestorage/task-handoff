import { z } from "zod";
import {
  canonicalJson,
  DateTimeSchema,
  IdSchema,
  OpaqueSecretSchema,
  Sha256DigestSchema,
} from "./common.ts";
import {
  AccessTicketSchema,
  ConfirmedRelayAllocationSchema,
  RelayAttachCapabilitySchema,
  RelayCapabilitiesSchema,
  RelayRateLimitSchema,
  RelayRevocationSchema,
  RelaySelectionSchema,
  ControlPlaneAccessFieldsSchema,
  TrafficClassSchema,
  validateControlPlaneAccessFields,
} from "./relay.ts";
import {
  RELAY_MAX_CANDIDATES,
  RELAY_SESSION_LEGACY_REFRESH_INTERVAL_MS,
  RELAY_SESSION_RENEWAL_LEAD_MS,
  RELAY_SESSION_PROTOCOL_VERSION,
  RELAY_SESSION_RESUME_CAPABILITY,
  RelaySessionAudience,
} from "./versions.ts";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const IDEMPOTENCY_KEY_REUSED_CODE = "IDEMPOTENCY_KEY_REUSED";
export const IdempotencyKeySchema = z.string().trim().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** Stable names are part of the cache key; never derive them from a URL. */
export const IdempotencyOperationSchema = z.enum([
  "relay-session-bootstrap",
  "relay-selection-confirm",
  "relay-session-renew",
]);
export type IdempotencyOperation = z.infer<typeof IdempotencyOperationSchema>;

export const IdempotencyCacheEntrySchema = z.strictObject({
  accountId: IdSchema,
  deviceSessionId: IdSchema,
  operation: IdempotencyOperationSchema,
  key: IdempotencyKeySchema,
  requestHash: Sha256DigestSchema,
  response: z.unknown(),
  createdAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
}).superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "idempotency expiry must be after creation" });
  }
});
export type IdempotencyCacheEntry = z.infer<typeof IdempotencyCacheEntrySchema>;

/**
 * The only credential the E2E transcript binds. It is deliberately a separate
 * schema from the single-use, sixty-second allocation ticket, and is never
 * accepted by ticket issuance, allocation, or confirmation.
 */
export const RelaySessionTranscriptTicketSchema = z.strictObject({
  protocolVersion: z.literal(RELAY_SESSION_PROTOCOL_VERSION),
  audience: z.literal(RelaySessionAudience.Transcript),
  transcriptTicketId: IdSchema,
  accountId: IdSchema,
  deviceSessionId: IdSchema,
  controlPlaneId: IdSchema,
  bindingId: IdSchema,
  bindingRevision: z.number().int().positive(),
  targetPublicKeyFingerprint: Sha256DigestSchema,
  nonce: z.string().min(16).max(256),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  ...ControlPlaneAccessFieldsSchema.shape,
}).superRefine((value, context) => validateControlPlaneAccessFields(value, context));
export type RelaySessionTranscriptTicket = z.infer<typeof RelaySessionTranscriptTicketSchema>;

export const RelaySessionGrantPayloadSchema = z.strictObject({
  protocolVersion: z.literal(RELAY_SESSION_PROTOCOL_VERSION),
  audience: z.literal(RelaySessionAudience.Grant),
  sessionId: IdSchema,
  grantId: IdSchema,
  generation: z.number().int().positive(),
  allocationId: IdSchema,
  accessTicketId: IdSchema,
  relayId: IdSchema,
  relayRegion: z.string().trim().min(1).max(80),
  relayUrl: z.url(),
  accountId: IdSchema,
  deviceSessionId: IdSchema,
  controlPlaneId: IdSchema,
  bindingId: IdSchema,
  bindingRevision: z.number().int().positive(),
  targetPublicKeyFingerprint: Sha256DigestSchema,
  clientProofPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  controlPlaneProofPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  trafficClass: TrafficClassSchema,
  rateLimit: RelayRateLimitSchema.optional(),
  maxConcurrentChannels: z.number().int().positive().optional(),
  sessionTranscriptTicket: RelaySessionTranscriptTicketSchema,
  revocationEpoch: z.number().int().nonnegative(),
  // Coordinator-owned scheduling policy, signed and replaced with each generation.
  // Absent on mobile-v0.0.12 / runtime v0.0.49 grants; never default a signed field.
  renewAfterMs: z.number().int().positive().optional(),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  ...ControlPlaneAccessFieldsSchema.shape,
}).superRefine((value, context) => {
  validateControlPlaneAccessFields(value, context);
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (value.renewAfterMs !== undefined && value.renewAfterMs >= expiresAt - issuedAt) {
    context.addIssue({ code: "custom", path: ["renewAfterMs"], message: "renewal must precede grant expiry" });
  }
  if (expiresAt <= issuedAt) context.addIssue({ code: "custom", path: ["expiresAt"], message: "grant expiry must be after issuance" });
  const transcript = value.sessionTranscriptTicket;
  if (transcript.accountId !== value.accountId || transcript.deviceSessionId !== value.deviceSessionId
    || transcript.controlPlaneId !== value.controlPlaneId || transcript.bindingId !== value.bindingId
    || transcript.bindingRevision !== value.bindingRevision || transcript.issuedAt !== value.issuedAt
    || transcript.expiresAt !== value.expiresAt) {
    context.addIssue({ code: "custom", path: ["sessionTranscriptTicket"], message: "transcript ticket must match the grant authority" });
  }
  if (accessTuple(transcript) !== accessTuple(value)) {
    context.addIssue({ code: "custom", path: ["sessionTranscriptTicket"], message: "transcript ticket must carry the grant's access tuple" });
  }
});
export type RelaySessionGrantPayload = z.infer<typeof RelaySessionGrantPayloadSchema>;

export const RelaySessionGrantSchema = RelaySessionGrantPayloadSchema.safeExtend({ signature: OpaqueSecretSchema });
export type RelaySessionGrant = z.infer<typeof RelaySessionGrantSchema>;

export const RelayRoleProofPayloadSchema = z.strictObject({
  protocolVersion: z.literal(RELAY_SESSION_PROTOCOL_VERSION),
  role: z.enum(["client", "control-plane"]),
  sessionId: IdSchema,
  grantId: IdSchema,
  generation: z.number().int().positive(),
  allocationId: IdSchema,
  relayId: IdSchema,
  nonce: z.string().min(16).max(256),
  issuedAt: DateTimeSchema,
});
export const RelayRoleProofSchema = RelayRoleProofPayloadSchema.extend({ signature: OpaqueSecretSchema });
export type RelayRoleProof = z.infer<typeof RelayRoleProofSchema>;
export type RelayRoleProofPayload = z.infer<typeof RelayRoleProofPayloadSchema>;

export function relayRoleProofSigningInput(rawProof: unknown): string {
  if (!rawProof || typeof rawProof !== "object" || Array.isArray(rawProof)) {
    throw new Error("relay role proof must be an object");
  }
  const { signature: _signature, ...unsignedProof } = rawProof as Record<string, unknown>;
  const proof = RelayRoleProofPayloadSchema.parse(unsignedProof);
  return `task-handoff:relay-session-proof:v1\n${canonicalJson(proof)}`;
}

export const RelayInitialAttachMessageSchema = z.strictObject({
  type: z.literal("attach"),
  capability: RelayAttachCapabilitySchema,
  grant: RelaySessionGrantSchema,
  proof: RelayRoleProofSchema,
});
export type RelayInitialAttachMessage = z.infer<typeof RelayInitialAttachMessageSchema>;

export const RelaySessionAttachMessageSchema = z.strictObject({
  type: z.literal("session-attach"),
  grant: RelaySessionGrantSchema,
  proof: RelayRoleProofSchema,
});
export type RelaySessionAttachMessage = z.infer<typeof RelaySessionAttachMessageSchema>;

export const RelaySessionRenewMessageSchema = z.strictObject({
  type: z.literal("session-renew"),
  grant: RelaySessionGrantSchema,
  proof: RelayRoleProofSchema,
});
export type RelaySessionRenewMessage = z.infer<typeof RelaySessionRenewMessageSchema>;

export const RelaySessionControlMessageSchema = z.discriminatedUnion("type", [
  RelaySessionAttachMessageSchema,
  RelaySessionRenewMessageSchema,
]);
export type RelaySessionControlMessage = z.infer<typeof RelaySessionControlMessageSchema>;

export const RelaySessionResumeResultSchema = z.object({
  type: z.literal("attached"),
  role: z.enum(["client", "control-plane"]),
  sessionId: IdSchema,
  allocationId: IdSchema,
  channelId: IdSchema,
  generation: z.number().int().positive(),
  state: z.enum(["waiting-for-peer", "handshaking", "open"]),
  leaseExpiresAt: DateTimeSchema,
});
export type RelaySessionResumeResult = z.infer<typeof RelaySessionResumeResultSchema>;

export const RelaySessionRenewalResultSchema = z.object({
  type: z.literal("renewed"),
  role: z.enum(["client", "control-plane"]),
  sessionId: IdSchema,
  generation: z.number().int().positive(),
  committed: z.boolean(),
  leaseExpiresAt: DateTimeSchema,
});
export type RelaySessionRenewalResult = z.infer<typeof RelaySessionRenewalResultSchema>;

export const RelaySessionDetachedMessageSchema = z.strictObject({
  type: z.literal("peer-detached"),
  sessionId: IdSchema,
  retryable: z.literal(true),
});

/**
 * Sent before a Relay closes an attached socket so the client can distinguish a
 * recoverable idle timeout from an authoritative session failure.
 */
export const RelaySessionClosedMessageSchema = z.object({
  type: z.literal("session-closed"),
  sessionId: IdSchema,
  code: z.string().trim().min(1).max(80),
  retryable: z.boolean(),
});
export type RelaySessionClosedMessage = z.infer<typeof RelaySessionClosedMessageSchema>;

/** Errors are sanitized: no grants, tickets, nonces, or key material. */
export const RelaySessionRejectionCodeSchema = z.enum([
  "RELAY_SESSION_GRANT_INVALID",
  "RELAY_SESSION_PROOF_INVALID",
  "RELAY_SESSION_ROLE_MISMATCH",
  "RELAY_SESSION_EXPIRED",
  "RELAY_SESSION_REVOKED",
  "RELAY_SESSION_REPLAYED",
  "RELAY_SESSION_NOT_FOUND",
  "RELAY_SESSION_GENERATION_STALE",
  "RELAY_SESSION_GENERATION_CONFLICT",
  "RELAY_SESSION_REVOCATION_SYNC_PENDING",
  "RELAY_DRAINING",
]);
export type RelaySessionRejectionCode = z.infer<typeof RelaySessionRejectionCodeSchema>;

export const RelaySessionProofReplayWindow = Object.freeze({
  pastMs: 30_000,
  futureMs: 30_000,
});

/**
 * The initial bootstrap atomically issues the one-time allocation ticket and a
 * Relay selection. The authenticated account and device session come from the
 * bearer token, never the request body.
 */
export const RelaySessionBootstrapRequestSchema = z.strictObject({
  controlPlaneId: IdSchema,
  trafficClasses: z.array(TrafficClassSchema).min(1).max(3),
  trafficClass: TrafficClassSchema,
  preferredRegion: z.string().trim().min(1).max(80).optional(),
  maxCandidates: z.number().int().min(1).max(RELAY_MAX_CANDIDATES).optional(),
  preferredRelayId: IdSchema.optional(),
  clientProofPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type RelaySessionBootstrapRequest = z.infer<typeof RelaySessionBootstrapRequestSchema>;

export const RelaySessionBootstrapResultSchema = z.strictObject({
  relayTicket: AccessTicketSchema,
  selection: RelaySelectionSchema,
  clientProofPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type RelaySessionBootstrapResult = z.infer<typeof RelaySessionBootstrapResultSchema>;

export const RelaySessionConfirmationResultSchema = ConfirmedRelayAllocationSchema.extend({
  grant: RelaySessionGrantSchema,
});
export type RelaySessionConfirmationResult = z.infer<typeof RelaySessionConfirmationResultSchema>;

export const RelaySessionRenewRequestSchema = z.strictObject({
  expectedGeneration: z.number().int().positive(),
});
export type RelaySessionRenewRequest = z.infer<typeof RelaySessionRenewRequestSchema>;

export const RelaySessionRenewalResponseSchema = z.strictObject({ grant: RelaySessionGrantSchema });
export type RelaySessionRenewalResponse = z.infer<typeof RelaySessionRenewalResponseSchema>;

export const RelayRevocationSyncSchema = z.strictObject({
  protocolVersion: z.literal(RELAY_SESSION_PROTOCOL_VERSION),
  audience: z.literal(RelaySessionAudience.RevocationSync),
  relayId: IdSchema,
  throughEpoch: z.number().int().nonnegative(),
  revocations: z.array(RelayRevocationSchema).max(10_000),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  signature: OpaqueSecretSchema,
}).superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "revocation batch expiry must be after issuance" });
});
export type RelayRevocationSync = z.infer<typeof RelayRevocationSyncSchema>;

export const RelayRevocationAckSchema = z.strictObject({ throughEpoch: z.number().int().nonnegative() });
export type RelayRevocationAck = z.infer<typeof RelayRevocationAckSchema>;

export const RelayCapabilityReportSchema = z.strictObject({
  capabilities: RelayCapabilitiesSchema,
  requiredCapabilities: RelayCapabilitiesSchema.optional(),
});
export const RelaySessionResumeCapability = RELAY_SESSION_RESUME_CAPABILITY;
export type RelayCapabilityReport = z.infer<typeof RelayCapabilityReportSchema>;

export function relaySessionCapabilitiesSatisfy(reported: readonly string[] | undefined, required: readonly string[] = [RELAY_SESSION_RESUME_CAPABILITY]): boolean {
  return required.every((capability) => reported?.includes(capability) === true);
}

function accessTuple(value: { ownerAccountId?: string; accessMode?: "owner" | "shared"; shareGrantId?: string; shareRevision?: number; accessRoleId?: string }): string {
  return canonicalJson({
    ownerAccountId: value.ownerAccountId ?? null,
    accessMode: value.accessMode ?? null,
    shareGrantId: value.shareGrantId ?? null,
    shareRevision: value.shareRevision ?? null,
    accessRoleId: value.accessRoleId ?? null,
  });
}

/**
 * Read only after signature verification. Compatibility for mobile-v0.0.12:
 * persisted grants without a policy retain their original ten-minute cadence.
 */
export function relaySessionRenewalAt(grant: RelaySessionGrant): number {
  return Math.min(
    Date.parse(grant.issuedAt) + (grant.renewAfterMs ?? RELAY_SESSION_LEGACY_REFRESH_INTERVAL_MS),
    Date.parse(grant.expiresAt) - RELAY_SESSION_RENEWAL_LEAD_MS,
  );
}

/** The existing cloud capability header is shared by all optional features. */
export function relaySessionCapabilitiesFromHeader(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const report = RelayCapabilityReportSchema.safeParse({ capabilities: value.split(/[\s,]+/).filter(Boolean) });
  return report.success ? report.data.capabilities : [];
}

/** Additive capability reports preserve unknown tokens for future consumers. */
export function normalizeRelayCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return RelayCapabilitiesSchema.parse([...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))]);
}
