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
  controlPlaneId: IdSchema.optional(),
  refreshControlPlaneIds: z.array(IdSchema).max(8).optional(),
});

export const NodeRelayAllocationResponseSchema = z.strictObject({
  allocations: z.array(NodeRelayNodeAllocationSchema),
});

export type NodeRelayRegistryProjection = z.infer<typeof NodeRelayRegistryProjectionSchema>;
export type RelayNodeChannelAttachCapability = z.infer<typeof RelayNodeChannelAttachCapabilitySchema>;
export type NodeRelayClaimGrant = z.infer<typeof NodeRelayClaimGrantSchema>;
export type NodeRelayNodeAllocation = z.infer<typeof NodeRelayNodeAllocationSchema>;
export type NodeRelayAllocationEvent = z.infer<typeof NodeRelayAllocationEventSchema>;
export type NodeRelayBindingRedemption = z.infer<typeof NodeRelayBindingRedemptionSchema>;
