import { z } from "zod";
import { DateTimeSchema, IdSchema, OpaqueSecretSchema, Sha256DigestSchema } from "./common.ts";
import { NodeRelayHandleSchema, ResourceAccessSchema, SharedAccessFieldsSchema, TrafficClassSchema, validateSharedAccessFields } from "./relay.ts";
import { OfficialAudience, OUTBOUND_CONNECTION_PROTOCOL_VERSION, RELAY_FRAMING_PROTOCOL_VERSION } from "./versions.ts";

/** Ed25519 public keys are 32-byte base64url strings, same shape as every other cloud key. */
export const PublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * Scope vocabulary lives in `relay.ts` because the outbound registration
 * payload carries it; re-exported here so node-relay consumers keep one import.
 */
export { CloudRelayScopeSchema, CloudRelayScopesSchema } from "./relay.ts";
export type { CloudRelayScope, CloudRelayScopes } from "./relay.ts";

export const NodeRelayRegistryStatusSchema = z.enum(["active", "suspended", "revoked"]);

/**
 * The only node fields the cloud may hold or project. Endpoints, credentials and
 * business state stay out; the handle is opaque and resolves to nothing by itself.
 */
export const NodeRelayRegistryProjectionSchema = z.strictObject({
  nodeHandle: NodeRelayHandleSchema,
  displayName: z.string().trim().min(1).max(160).optional(),
  publicKeyFingerprint: Sha256DigestSchema,
  status: NodeRelayRegistryStatusSchema,
  revision: z.number().int().positive(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
  access: ResourceAccessSchema.optional(),
});

/**
 * One-time binding token. Plaintext is shown exactly once (inside the command);
 * the cloud stores only its hash, bound to an account with a TTL. The optional
 * onboarding hint carries the Control Plane that generated the command so the
 * cloud can notify it once the node binds; the hint never becomes registry state.
 */
export const NodeRelayBindingTokenIssueRequestSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(160).optional(),
  onboardingControlPlaneId: IdSchema.optional(),
  onboardingBindingRevision: z.number().int().positive().optional(),
}).superRefine((value, context) => {
  if (Boolean(value.onboardingControlPlaneId) !== Boolean(value.onboardingBindingRevision)) context.addIssue({ code: "custom", message: "onboarding hint requires both controlPlaneId and bindingRevision" });
});

export const NodeRelayBindingTokenIssueSchema = z.strictObject({
  tokenId: IdSchema,
  expiresAt: DateTimeSchema,
  /** Full install/CLI command, rendered once and never returned by list endpoints. */
  command: z.string().min(1).max(4096),
  /**
   * The one-time plaintext token, so a Control Plane that generated the command
   * can wrap it into its own install script invocation. Shown exactly once.
   */
  bindingToken: OpaqueSecretSchema.optional(),
});

export const NodeRelayBindingRedemptionRequestSchema = z.strictObject({
  token: OpaqueSecretSchema,
  /** Stable Node Agent identity, forwarded to the claiming Control Plane. */
  nodeId: IdSchema.optional(),
  nodePublicKey: PublicKeySchema,
  nodePublicKeyFingerprint: Sha256DigestSchema,
  displayName: z.string().trim().min(1).max(160).optional(),
});

export const NodeRelayCredentialSchema = z.strictObject({
  credential: OpaqueSecretSchema,
  expiresAt: DateTimeSchema,
});

export const NodeRelayBindingRedemptionSchema = z.strictObject({
  nodeHandle: NodeRelayHandleSchema,
  accountId: IdSchema,
  /** The cloud origin the node pins its trust to; never contains the token. */
  serviceOrigin: z.string().url(),
  credential: OpaqueSecretSchema,
  credentialExpiresAt: DateTimeSchema,
  /**
   * The cloud signing key that verifies claim grants and attach capabilities,
   * shipped once at redemption so the node pins a trust anchor instead of
   * trusting whatever arrives over the same channel as the grant.
   */
  serviceSigningKey: z.strictObject({ kid: z.string().trim().min(1).max(160), publicKey: PublicKeySchema }).optional(),
});

/** Credential-authenticated node requests: renewal and node-side unbind share this shape. */
export const NodeRelayCredentialRequestSchema = z.strictObject({
  credential: OpaqueSecretSchema,
});
export const NodeRelayCredentialRenewalRequestSchema = NodeRelayCredentialRequestSchema;

/**
 * Node-channel attach capability. Roles pair `node-agent` with `control-plane`;
 * it never carries the access-only `deviceSessionId`/`ticketId` fields. The
 * node-agent role uses its own audience, the Control Plane keeps the existing
 * control-plane attach audience.
 */
export const RelayNodeChannelAttachRoleSchema = z.enum(["node-agent", "control-plane"]);
export const RelayNodeChannelAttachCapabilitySchema = z.strictObject({
  protocolVersion: z.literal(RELAY_FRAMING_PROTOCOL_VERSION),
  channelKind: z.literal("node"),
  audience: z.enum([OfficialAudience.RelayNodeAgentAttach, OfficialAudience.RelayControlPlaneAttach]),
  allocationId: IdSchema,
  relayId: IdSchema,
  role: RelayNodeChannelAttachRoleSchema,
  controlPlaneId: IdSchema,
  accountId: IdSchema,
  bindingId: IdSchema,
  bindingRevision: z.number().int().positive(),
  nodeHandle: NodeRelayHandleSchema,
  trafficClass: TrafficClassSchema,
  rateLimit: z.strictObject({ bytesPerSecond: z.number().int().positive(), burstBytes: z.number().int().positive() }).optional(),
  maxConcurrentChannels: z.number().int().positive().optional(),
  nonce: z.string().min(16).max(256),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  signature: OpaqueSecretSchema,
  ...SharedAccessFieldsSchema.shape,
}).superRefine((value, context) => {
  const expected = value.role === "node-agent" ? OfficialAudience.RelayNodeAgentAttach : OfficialAudience.RelayControlPlaneAttach;
  if (value.audience !== expected) context.addIssue({ code: "custom", path: ["audience"], message: `audience must match ${value.role} role` });
  validateSharedAccessFields(value, context, ["use"]);
});

/**
 * Cloud-signed claim grant. The node verifies it (canonical JSON + Ed25519) to
 * authorize exactly one (nodeHandle, controlPlaneId, bindingRevision) channel.
 */
export const NodeRelayClaimGrantPayloadSchema = z.strictObject({
  protocolVersion: z.literal(RELAY_FRAMING_PROTOCOL_VERSION),
  audience: z.literal(OfficialAudience.RelayNodeClaimGrant),
  grantId: IdSchema,
  allocationId: IdSchema,
  nodeHandle: NodeRelayHandleSchema,
  controlPlaneId: IdSchema,
  accountId: IdSchema,
  bindingId: IdSchema,
  bindingRevision: z.number().int().positive(),
  relayId: IdSchema,
  relayRegion: z.string().trim().min(1).max(80),
  relayUrl: z.string().url(),
  nonce: z.string().min(16).max(256),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  /**
   * The claiming Control Plane's cloud identity key. The node verifies the
   * Control Plane's end-to-end handshake signature with it, so a Relay (or
   * anyone else) cannot impersonate the Control Plane. A node that needs to
   * authenticate the peer must refuse a grant that omits it.
   */
  controlPlanePublicKey: PublicKeySchema.optional(),
  ...SharedAccessFieldsSchema.shape,
}).superRefine((value, context) => validateSharedAccessFields(value, context, ["use"]));
export const NodeRelayClaimGrantSchema = NodeRelayClaimGrantPayloadSchema.safeExtend({ signature: OpaqueSecretSchema });

/** The allocation the node fetches for itself (credential-authenticated node API). */
export const NodeRelayNodeAllocationSchema = z.strictObject({
  allocationId: IdSchema,
  relayId: IdSchema,
  relayRegion: z.string().trim().min(1).max(80),
  relayUrl: z.string().url(),
  claimGrant: NodeRelayClaimGrantSchema,
  nodeAttach: RelayNodeChannelAttachCapabilitySchema,
  expiresAt: DateTimeSchema,
});

/** The allocation the Coordinator pushes to the claiming Control Plane. */
export const NodeRelayAllocationEventSchema = z.strictObject({
  type: z.literal("node-relay-allocation"),
  protocolVersion: z.literal(OUTBOUND_CONNECTION_PROTOCOL_VERSION),
  allocationId: IdSchema,
  relayId: IdSchema,
  relayRegion: z.string().trim().min(1).max(80),
  relayUrl: z.string().url(),
  nodeHandle: NodeRelayHandleSchema,
  /** Lets a Control Plane avoid dialing a machine it already manages directly. */
  nodeId: IdSchema.optional(),
  accountId: IdSchema.optional(),
  controlPlaneId: IdSchema,
  bindingId: IdSchema,
  bindingRevision: z.number().int().positive(),
  controlPlaneAttach: RelayNodeChannelAttachCapabilitySchema,
  expiresAt: DateTimeSchema,
  /**
   * Non-secret identity of the node the Control Plane is about to meet: the
   * fingerprint pins the relay public key the node must prove possession of,
   * and the display name is the registry label for the local node record.
   */
  nodePublicKeyFingerprint: Sha256DigestSchema.optional(),
  displayName: z.string().trim().min(1).max(160).optional(),
  ...SharedAccessFieldsSchema.shape,
}).superRefine((value, context) => {
  if (value.accessMode) validateSharedAccessFields(value, context, ["use"]);
  else if (value.ownerAccountId !== undefined || value.shareGrantId !== undefined || value.shareRevision !== undefined || value.shareRole !== undefined) context.addIssue({ code: "custom", message: "shared access fields require accessMode" });
});

/**
 * What the node asks for when it (re)connects. A Control Plane whose previous
 * Relay attach was already consumed asks for a fresh allocation; otherwise the
 * Coordinator may reuse a live lease so repeated polls stay idempotent.
 */
export const NodeRelayAllocationRequestSchema = z.strictObject({
  /** Stable Node Agent identity, used to backfill bindings created before it was recorded. */
  nodeId: IdSchema.optional(),
  controlPlaneId: IdSchema.optional(),
  refreshControlPlaneIds: z.array(IdSchema).max(8).optional(),
});

export const NodeRelayAllocationResponseSchema = z.strictObject({
  allocations: z.array(NodeRelayNodeAllocationSchema),
});

/** Reconnect probing is deliberately small: at most three peers, two samples, one shared budget. */
export const NODE_RELAY_PROBE_TARGET_LIMIT = 3;
export const NODE_RELAY_PROBE_SAMPLE_COUNT = 2;
export const NODE_RELAY_PROBE_BUDGET_MS = 1_200;
export const NODE_RELAY_ADAPTIVE_SELECTION_UNSUPPORTED_CODE = "NODE_RELAY_ADAPTIVE_SELECTION_UNSUPPORTED";

export const NodeRelayProbeTargetSchema = z.strictObject({
  relayId: IdSchema,
  relayUrl: z.string().url(),
});

/**
 * Attempt-scoped target discovery. The response deliberately carries no CP
 * hint, server score, claim grant or attach capability: those stay server-side
 * until one winner has been selected.
 */
export const NodeRelayProbeTargetsRequestSchema = z.strictObject({
  nodeId: IdSchema.optional(),
  controlPlaneIds: z.array(IdSchema).max(8).optional(),
});

export const NodeRelayProbeTargetsResponseSchema = z.strictObject({
  targets: z.array(NodeRelayProbeTargetSchema).max(NODE_RELAY_PROBE_TARGET_LIMIT),
});

/**
 * Numeric and sample bounds are validated again by the Coordinator and invalid
 * rows are ignored, so one malformed measurement cannot fail a whole reconnect.
 */
export const NodeRelayProbeMeasurementSchema = z.strictObject({
  relayId: IdSchema,
  rttMs: z.number().finite().nonnegative().optional(),
  sampleCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  measuredAt: DateTimeSchema.optional(),
});

export const NodeRelayProbeEvidenceSchema = z.strictObject({
  measurements: z.array(NodeRelayProbeMeasurementSchema).max(32),
});

/** Node Relay allocation v2. The winner is still the unchanged v1 allocation shape. */
export const NodeRelayAllocationRequestV2Schema = z.strictObject({
  nodeId: IdSchema.optional(),
  controlPlaneId: IdSchema.optional(),
  refreshControlPlaneIds: z.array(IdSchema).max(8).optional(),
  probeEvidence: NodeRelayProbeEvidenceSchema.optional(),
});

export const NodeRelayAllocationErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(512),
    retryable: z.boolean().optional(),
  }),
});

export type NodeRelayRegistryProjection = z.infer<typeof NodeRelayRegistryProjectionSchema>;
export type RelayNodeChannelAttachCapability = z.infer<typeof RelayNodeChannelAttachCapabilitySchema>;
export type NodeRelayClaimGrant = z.infer<typeof NodeRelayClaimGrantSchema>;
export type NodeRelayNodeAllocation = z.infer<typeof NodeRelayNodeAllocationSchema>;
export type NodeRelayAllocationEvent = z.infer<typeof NodeRelayAllocationEventSchema>;
export type NodeRelayBindingRedemption = z.infer<typeof NodeRelayBindingRedemptionSchema>;
export type NodeRelayProbeTarget = z.infer<typeof NodeRelayProbeTargetSchema>;
export type NodeRelayProbeTargetsRequest = z.infer<typeof NodeRelayProbeTargetsRequestSchema>;
export type NodeRelayProbeTargetsResponse = z.infer<typeof NodeRelayProbeTargetsResponseSchema>;
export type NodeRelayProbeMeasurement = z.infer<typeof NodeRelayProbeMeasurementSchema>;
export type NodeRelayProbeEvidence = z.infer<typeof NodeRelayProbeEvidenceSchema>;
export type NodeRelayAllocationRequestV2 = z.infer<typeof NodeRelayAllocationRequestV2Schema>;
export type NodeRelayAllocationError = z.infer<typeof NodeRelayAllocationErrorSchema>;
