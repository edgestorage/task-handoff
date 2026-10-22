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
  RelayRateLimitSchema,
  RelayRevocationSchema,
  RelaySelectionSchema,
  SharedAccessFieldsSchema,
  TrafficClassSchema,
  validateSharedAccessFields,
} from "./relay.ts";
import {
  RELAY_SESSION_MAX_GRANT_TTL_MS,
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
  ...SharedAccessFieldsSchema.shape,
}).superRefine((value, context) => validateSharedAccessFields(value, context, ["viewer", "operator"]));
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
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  ...SharedAccessFieldsSchema.shape,
}).superRefine((value, context) => {
  validateSharedAccessFields(value, context, ["viewer", "operator"]);
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (expiresAt <= issuedAt) context.addIssue({ code: "custom", path: ["expiresAt"], message: "grant expiry must be after issuance" });
  if (expiresAt - issuedAt > RELAY_SESSION_MAX_GRANT_TTL_MS) context.addIssue({ code: "custom", path: ["expiresAt"], message: "grant exceeds the Relay attach lease ceiling" });
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

export const RelaySessionResumeResultSchema = z.strictObject({
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

export const RelaySessionRenewalResultSchema = z.strictObject({
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
export const RelaySessionClosedMessageSchema = z.strictObject({
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
  maxCandidates: z.number().int().min(1).max(5).optional(),
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
  capabilities: z.array(z.string().trim().min(1).max(80)).max(32),
  requiredCapabilities: z.array(z.string().trim().min(1).max(80)).max(32).optional(),
});
export const RelaySessionResumeCapability = RELAY_SESSION_RESUME_CAPABILITY;
export type RelayCapabilityReport = z.infer<typeof RelayCapabilityReportSchema>;

export function relaySessionCapabilitiesSatisfy(reported: readonly string[] | undefined, required: readonly string[] = [RELAY_SESSION_RESUME_CAPABILITY]): boolean {
  return required.every((capability) => reported?.includes(capability) === true);
}

function accessTuple(value: { ownerAccountId?: string; accessMode?: "owner" | "shared"; shareGrantId?: string; shareRevision?: number; shareRole?: "viewer" | "operator" | "use" }): string {
  return canonicalJson({
    ownerAccountId: value.ownerAccountId ?? null,
    accessMode: value.accessMode ?? null,
    shareGrantId: value.shareGrantId ?? null,
    shareRevision: value.shareRevision ?? null,
    shareRole: value.shareRole ?? null,
  });
}
