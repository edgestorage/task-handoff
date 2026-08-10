import { z } from "zod";
import { canonicalJson, DateTimeSchema, IdSchema, OpaqueSecretSchema, Sha256DigestSchema } from "./common.ts";
import { OUTBOUND_CONNECTION_PROTOCOL_VERSION, OfficialAudience, RELAY_FRAMING_PROTOCOL_VERSION } from "./versions.ts";

export const TrafficClassSchema = z.enum(["interactive", "stream", "bulk"]);

export const RelayTtySnapshotEnvelopeSchema = z.object({
  type: z.literal("tty-snapshot"),
  streamId: z.string().trim().min(1).optional(),
  data: z.string(),
  pendingEscape: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
}).passthrough();
export type RelayTtySnapshotEnvelope = z.infer<typeof RelayTtySnapshotEnvelopeSchema>;

export const OutboundConnectionRegistrationPayloadSchema = z.strictObject({
  protocolVersion: z.literal(OUTBOUND_CONNECTION_PROTOCOL_VERSION),
  audience: z.literal(OfficialAudience.CoordinatorControl),
  connectionId: IdSchema,
  processInstanceId: IdSchema,
  controlPlaneId: IdSchema,
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  publicKeyFingerprint: Sha256DigestSchema,
  bindingId: IdSchema.optional(),
  bindingRevision: z.number().int().positive().optional(),
  epoch: z.number().int().nonnegative(),
  capabilities: z.array(z.enum(["request", "stream", "websocket"])).min(1),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
}).superRefine((value, context) => {
  if (Boolean(value.bindingId) !== Boolean(value.bindingRevision)) context.addIssue({ code: "custom", message: "binding id and revision must be supplied together" });
});

export const OutboundConnectionRegistrationSchema = OutboundConnectionRegistrationPayloadSchema.safeExtend({ signature: OpaqueSecretSchema });

export function outboundConnectionRegistrationSigningInput(rawPayload: unknown): string {
  const payload = OutboundConnectionRegistrationPayloadSchema.parse(rawPayload);
  return `task-handoff:outbound-control-registration:v1\n${canonicalJson(payload)}`;
}

export const OutboundConnectionLeaseSchema = z.strictObject({
  connectionId: IdSchema,
  controlPlaneId: IdSchema,
  bindingRevision: z.number().int().positive(),
  epoch: z.number().int().nonnegative(),
  relayId: IdSchema,
  relayRegion: z.string().trim().min(1).max(80),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
});

export const AccessTicketSchema = z.strictObject({
  protocolVersion: z.literal(OUTBOUND_CONNECTION_PROTOCOL_VERSION),
  audience: z.literal(OfficialAudience.ControlPlaneAccess),
  ticketId: IdSchema,
  accountId: IdSchema,
  deviceSessionId: IdSchema,
  controlPlaneId: IdSchema,
  bindingId: IdSchema,
  bindingRevision: z.number().int().positive(),
  targetPublicKeyFingerprint: Sha256DigestSchema,
  nonce: z.string().min(16).max(256),
  trafficClasses: z.array(TrafficClassSchema).min(1),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  signature: OpaqueSecretSchema,
});

export const OfficialIdentityAssertionSchema = z.strictObject({
  audience: z.literal(OfficialAudience.ControlPlaneAccess),
  accountId: IdSchema,
  deviceSessionId: IdSchema,
  controlPlaneId: IdSchema,
  bindingId: IdSchema,
  bindingRevision: z.number().int().positive(),
  authenticatedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  signature: OpaqueSecretSchema,
});

export const RelayAttachRoleSchema = z.enum(["client", "control-plane"]);
export const RelayAttachCapabilitySchema = z.strictObject({
  protocolVersion: z.literal(RELAY_FRAMING_PROTOCOL_VERSION),
  audience: z.enum([OfficialAudience.RelayClientAttach, OfficialAudience.RelayControlPlaneAttach]),
  allocationId: IdSchema,
  relayId: IdSchema,
  role: RelayAttachRoleSchema,
  controlPlaneId: IdSchema,
  accountId: IdSchema,
  deviceSessionId: IdSchema,
  bindingId: IdSchema,
  ticketId: IdSchema,
  bindingRevision: z.number().int().positive(),
  trafficClass: TrafficClassSchema,
  nonce: z.string().min(16).max(256),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  signature: OpaqueSecretSchema,
}).superRefine((value, context) => {
  const expected = value.role === "client" ? OfficialAudience.RelayClientAttach : OfficialAudience.RelayControlPlaneAttach;
  if (value.audience !== expected) context.addIssue({ code: "custom", path: ["audience"], message: `audience must match ${value.role} role` });
});

export const RelayAllocationSchema = z.object({
  allocationId: IdSchema,
  relayId: IdSchema,
  relayRegion: z.string().trim().min(1).max(80),
  relayUrl: z.string().url(),
  clientAttach: RelayAttachCapabilitySchema,
  expiresAt: DateTimeSchema,
});

export const RelayChannelSchema = z.strictObject({
  channelId: IdSchema,
  allocationId: IdSchema,
  controlPlaneId: IdSchema,
  bindingRevision: z.number().int().positive(),
  trafficClass: TrafficClassSchema,
  state: z.enum(["waiting-for-peer", "handshaking", "open", "closing", "closed"]),
  clientAttached: z.boolean(),
  controlPlaneAttached: z.boolean(),
  openedAt: DateTimeSchema.optional(),
  leaseExpiresAt: DateTimeSchema,
});

export const RelayFrameSchema = z.strictObject({
  protocolVersion: z.literal(RELAY_FRAMING_PROTOCOL_VERSION),
  channelId: IdSchema,
  sequence: z.number().int().nonnegative(),
  kind: z.enum(["handshake", "data", "cancel", "window-update", "close"]),
  ciphertext: z.string().max(1_398_102).optional(),
  creditBytes: z.number().int().positive().optional(),
});

export const RelayCloseSchema = z.strictObject({
  channelId: IdSchema,
  code: z.enum(["normal", "expired", "revoked", "quota-exceeded", "idle-timeout", "slow-consumer", "protocol-error", "peer-disconnected"]),
  retryable: z.boolean(),
});

export const RelayRevocationSchema = z.strictObject({
  protocolVersion: z.literal(RELAY_FRAMING_PROTOCOL_VERSION),
  audience: z.literal(OfficialAudience.RelayRevocation),
  revocationId: IdSchema,
  relayId: IdSchema.optional(),
  allocationId: IdSchema.optional(),
  accountId: IdSchema.optional(),
  deviceSessionId: IdSchema.optional(),
  bindingId: IdSchema.optional(),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  signature: OpaqueSecretSchema,
}).refine((value) => [value.allocationId, value.accountId, value.deviceSessionId, value.bindingId].some(Boolean), "revocation target is required");

export type AccessTicket = z.infer<typeof AccessTicketSchema>;
export type RelayAllocation = z.infer<typeof RelayAllocationSchema>;
export type RelayAttachCapability = z.infer<typeof RelayAttachCapabilitySchema>;
export type RelayFrame = z.infer<typeof RelayFrameSchema>;
