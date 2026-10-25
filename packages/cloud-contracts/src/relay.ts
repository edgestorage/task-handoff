import { z } from "zod";
import { canonicalJson, DateTimeSchema, IdSchema, LocaleTextSchema, OpaqueSecretSchema, Sha256DigestSchema } from "./common.ts";
import { CONTROL_PLANE_REGISTRATION_PROTOCOL_VERSION, OUTBOUND_CONNECTION_PROTOCOL_VERSION, OfficialAudience, RELAY_FRAMING_PROTOCOL_VERSION, RELAY_MAX_CANDIDATES, RELAY_REVOCATION_MIN_VALIDITY_MS, RELAY_SESSION_RESUME_CAPABILITY } from "./versions.ts";

export const TrafficClassSchema = z.enum(["interactive", "stream", "bulk"]);

/**
 * Relay channels come in two kinds: access channels pair a device client with a
 * Control Plane, node channels pair a node agent with a Control Plane. Shared
 * access distinguishes owner and shared authority with a complete signed tuple;
 * node capabilities live in `node-relay.ts` and are parsed by kind.
 */
export const RelayChannelKindSchema = z.enum(["access", "node"]);

export const RESOURCE_SHARING_CAPABILITY_HEADER = "x-task-handoff-capabilities";
export const RESOURCE_SHARING_CLIENT_CAPABILITY = "resource-sharing-v1";
export const CONTROL_PLANE_SHARED_ACCESS_CAPABILITY = "shared-access-v1";

export const ResourceTypeSchema = z.enum(["control-plane", "node"]);
export const ResourceShareStatusSchema = z.enum(["active", "revoked", "expired"]);
export const AccessRoleIdSchema = z.string().trim().min(3).max(80).regex(/^role_[a-z0-9][a-z0-9_-]*$/);
export const AccessRoleStatusSchema = z.enum(["active", "archived"]);
export const AccessRoleCatalogEntrySchema = z.strictObject({
  roleId: AccessRoleIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500).optional(),
  system: z.boolean(),
  status: AccessRoleStatusSchema,
});
export const AccessRoleCatalogSnapshotSchema = z.strictObject({
  catalogRevision: z.number().int().positive(),
  roles: z.array(AccessRoleCatalogEntrySchema).min(1).max(256),
});
export const PublishAccessRoleCatalogSchema = AccessRoleCatalogSnapshotSchema.extend({ bindingId: IdSchema });
export const ControlPlaneAccessSettingsSchema = z.strictObject({
  bindingId: IdSchema,
  ownerRoleId: AccessRoleIdSchema,
  availableRoleIds: z.array(AccessRoleIdSchema).min(1).max(256),
  settingsRevision: z.number().int().positive(),
  updatedAt: DateTimeSchema,
}).superRefine((value, context) => {
  if (new Set(value.availableRoleIds).size !== value.availableRoleIds.length) context.addIssue({ code: "custom", path: ["availableRoleIds"], message: "available roles must be unique" });
  if (!value.availableRoleIds.includes(value.ownerRoleId)) context.addIssue({ code: "custom", path: ["ownerRoleId"], message: "the owner role must be available" });
});
export const ControlPlaneAccessSettingsViewSchema = ControlPlaneAccessSettingsSchema.extend({
  catalogRevision: z.number().int().nonnegative(),
  roles: z.array(AccessRoleCatalogEntrySchema).max(256),
});
export const UpdateControlPlaneAvailableRolesSchema = z.strictObject({
  expectedSettingsRevision: z.number().int().positive(),
  availableRoleIds: z.array(AccessRoleIdSchema).min(1).max(256),
}).superRefine((value, context) => {
  if (new Set(value.availableRoleIds).size !== value.availableRoleIds.length) context.addIssue({ code: "custom", path: ["availableRoleIds"], message: "available roles must be unique" });
});
export const NodeShareRoleSchema = z.literal("use");
export const ResourceAccessModeSchema = z.enum(["owner", "shared"]);

const OwnerResourceAccessSchema = z.strictObject({ kind: z.literal("owner") });
export const ControlPlaneResourceAccessSchema = z.discriminatedUnion("kind", [
  OwnerResourceAccessSchema,
  z.strictObject({
    kind: z.literal("shared"),
    shareId: IdSchema,
    revision: z.number().int().positive(),
    role: AccessRoleIdSchema,
    expiresAt: DateTimeSchema,
  }),
]);
export const NodeResourceAccessSchema = z.discriminatedUnion("kind", [
  OwnerResourceAccessSchema,
  z.strictObject({
    kind: z.literal("shared"),
    shareId: IdSchema,
    revision: z.number().int().positive(),
    role: NodeShareRoleSchema,
    expiresAt: DateTimeSchema,
  }),
]);

/**
 * Control Plane access authority shared by access tickets, Relay capabilities,
 * and session grants. Every payload carries a role resolved by the Control
 * Plane. `accountId` is always the authenticated requester/grantee;
 * `ownerAccountId` identifies the resource owner.
 */
export const ControlPlaneAccessFieldsSchema = z.strictObject({
  ownerAccountId: IdSchema.optional(),
  accessMode: ResourceAccessModeSchema.optional(),
  shareGrantId: IdSchema.optional(),
  shareRevision: z.number().int().positive().optional(),
  accessRoleId: AccessRoleIdSchema.optional(),
});

export const NodeAccessFieldsSchema = z.strictObject({
  ownerAccountId: IdSchema.optional(),
  accessMode: ResourceAccessModeSchema.optional(),
  shareGrantId: IdSchema.optional(),
  shareRevision: z.number().int().positive().optional(),
  shareRole: NodeShareRoleSchema.optional(),
});

type ControlPlaneAccessFields = {
  accountId?: string;
  ownerAccountId?: string;
  accessMode?: "owner" | "shared";
  shareGrantId?: string;
  shareRevision?: number;
  accessRoleId?: string;
};

export function validateControlPlaneAccessFields(value: ControlPlaneAccessFields, context: z.RefinementCtx): void {
  if (!value.accessMode) {
    context.addIssue({ code: "custom", path: ["accessMode"], message: "access authority requires accessMode" });
    return;
  }
  if (!value.ownerAccountId) {
    context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "access authority requires ownerAccountId" });
    return;
  }
  if (!value.accessRoleId) context.addIssue({ code: "custom", path: ["accessRoleId"], message: "access authority requires accessRoleId" });
  if (value.accessMode === "owner") {
    if (value.shareGrantId !== undefined || value.shareRevision !== undefined) context.addIssue({ code: "custom", message: "owner access cannot carry share grant fields" });
    if (value.accountId && value.ownerAccountId !== value.accountId) context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "owner access requires ownerAccountId to equal accountId" });
    return;
  }
  if (!value.accountId) context.addIssue({ code: "custom", path: ["accountId"], message: "shared access requires accountId" });
  if (value.accountId && value.ownerAccountId === value.accountId) context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "shared access requires a different owner account" });
  if (!value.shareGrantId) context.addIssue({ code: "custom", path: ["shareGrantId"], message: "shared access requires shareGrantId" });
  if (value.shareRevision === undefined) context.addIssue({ code: "custom", path: ["shareRevision"], message: "shared access requires shareRevision" });
}

export function validateNodeAccessFields(
  value: { accountId?: string; ownerAccountId?: string; accessMode?: "owner" | "shared"; shareGrantId?: string; shareRevision?: number; shareRole?: "use" },
  context: z.RefinementCtx,
): void {
  const shareFieldsPresent = value.ownerAccountId !== undefined || value.accessMode !== undefined || value.shareGrantId !== undefined || value.shareRevision !== undefined || value.shareRole !== undefined;
  if (!value.accessMode) {
    if (shareFieldsPresent) context.addIssue({ code: "custom", message: "shared access fields require accessMode" });
    return;
  }
  if (!value.ownerAccountId) {
    context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "accessMode requires ownerAccountId" });
    return;
  }
  if (value.accessMode === "owner") {
    if (value.shareGrantId !== undefined || value.shareRevision !== undefined || value.shareRole !== undefined) context.addIssue({ code: "custom", message: "owner access cannot carry share grant fields" });
    if (value.accountId && value.ownerAccountId !== value.accountId) context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "owner access requires ownerAccountId to equal accountId" });
    return;
  }
  if (!value.accountId) context.addIssue({ code: "custom", path: ["accountId"], message: "shared access requires accountId" });
  if (value.accountId && value.ownerAccountId === value.accountId) context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "shared access requires a different owner account" });
  if (!value.shareGrantId) context.addIssue({ code: "custom", path: ["shareGrantId"], message: "shared access requires shareGrantId" });
  if (value.shareRevision === undefined) context.addIssue({ code: "custom", path: ["shareRevision"], message: "shared access requires shareRevision" });
  if (!value.shareRole) context.addIssue({ code: "custom", path: ["shareRole"], message: "shared access requires shareRole" });
}

export const CONTROL_PLANE_ACCESS_ROLE_CATALOG_CAPABILITY = "access-role-catalog-v1";

/**
 * Control Plane cloud-relay scopes. `device-access` gates account devices and
 * browsers reaching this Control Plane; `node-relay` gates claiming and holding
 * account nodes. They are independent: only both being off stops the outbound
 * control connection, and narrowing one scope never touches the other channel.
 */
export const CloudRelayScopeSchema = z.enum(["device-access", "node-relay"]);
export const CloudRelayScopesSchema = z.strictObject({
  deviceAccess: z.boolean(),
  nodeRelay: z.boolean(),
});
export type CloudRelayScope = z.infer<typeof CloudRelayScopeSchema>;
export type CloudRelayScopes = z.infer<typeof CloudRelayScopesSchema>;
export type RelayChannelKind = z.infer<typeof RelayChannelKindSchema>;

/** Opaque handle for an account-bound node. Nothing about the node resolves from it. */
export const NodeRelayHandleSchema = z.string().trim().min(8).max(160).regex(/^[a-z][a-z0-9_-]*$/);

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
  protocolVersion: z.literal(CONTROL_PLANE_REGISTRATION_PROTOCOL_VERSION),
  audience: z.literal(OfficialAudience.CoordinatorControl),
  connectionId: IdSchema,
  processInstanceId: IdSchema,
  // The identifier generated by the local Control Plane installation. It is
  // reported for mapping only and never becomes the Coordinator primary key.
  reportedControlPlaneId: IdSchema,
  // Set after the first successful registration. The Coordinator verifies that
  // this still belongs to the same public-key fingerprint.
  expectedControlPlaneId: IdSchema.optional(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  publicKeyFingerprint: Sha256DigestSchema,
  bindingId: IdSchema.optional(),
  bindingRevision: z.number().int().positive().optional(),
  // The Control Plane's local scope switches travel with every (re)registration
  // so the cloud never has to guess which channel kinds a live connection may use.
  scopes: CloudRelayScopesSchema.optional(),
  epoch: z.number().int().nonnegative(),
  capabilities: z.array(z.enum(["request", "stream", "websocket", CONTROL_PLANE_SHARED_ACCESS_CAPABILITY, CONTROL_PLANE_ACCESS_ROLE_CATALOG_CAPABILITY, RELAY_SESSION_RESUME_CAPABILITY])).min(1),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
}).superRefine((value, context) => {
  if (Boolean(value.bindingId) !== Boolean(value.bindingRevision)) context.addIssue({ code: "custom", message: "binding id and revision must be supplied together" });
});

export const OutboundConnectionRegistrationSchema = OutboundConnectionRegistrationPayloadSchema.safeExtend({ signature: OpaqueSecretSchema });

export const OutboundConnectionRegistrationResponseSchema = z.strictObject({
  type: z.literal("registered"),
  // Coordinator-generated identity. This is the only value subsequent cloud
  // binding, relay and node operations may use.
  controlPlaneId: IdSchema,
  reportedControlPlaneId: IdSchema,
  bindingId: IdSchema.optional(),
  bindingRevision: z.number().int().positive().optional(),
  leaseExpiresAt: DateTimeSchema,
});

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
  /** Bound by the combined bootstrap so confirm can bind only this proof key. */
  clientProofPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  ...ControlPlaneAccessFieldsSchema.shape,
}).superRefine((value, context) => validateControlPlaneAccessFields(value, context));

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
export const RelayRateLimitSchema = z.strictObject({
  bytesPerSecond: z.number().int().positive(),
  burstBytes: z.number().int().positive(),
});
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
  /** Optional per-account rate limit; the Relay enforces it locally on this node. */
  rateLimit: RelayRateLimitSchema.optional(),
  /** Optional per-account channel cap carried by the plan; the Relay enforces it on this node. */
  maxConcurrentChannels: z.number().int().positive().optional(),
  nonce: z.string().min(16).max(256),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  signature: OpaqueSecretSchema,
  ...ControlPlaneAccessFieldsSchema.shape,
}).superRefine((value, context) => {
  const expected = value.role === "client" ? OfficialAudience.RelayClientAttach : OfficialAudience.RelayControlPlaneAttach;
  if (value.audience !== expected) context.addIssue({ code: "custom", path: ["audience"], message: `audience must match ${value.role} role` });
  validateControlPlaneAccessFields(value, context);
});

export const RelayAllocationSchema = z.object({
  allocationId: IdSchema,
  relayId: IdSchema,
  relayRegion: z.string().trim().min(1).max(80),
  relayUrl: z.string().url(),
  clientAttach: RelayAttachCapabilitySchema,
  expiresAt: DateTimeSchema,
});

/**
 * A control-plane's own last measurement of the direct link to one Relay. The
 * Coordinator caches these and hands them to clients as advice; clients may
 * ignore them entirely, and a stale hint is reported with its `updatedAt`
 * instead of being dropped or replaced.
 */
export const RelayControlPlaneHintSchema = z.strictObject({
  relayId: IdSchema,
  rttMs: z.number().nonnegative(),
  updatedAt: DateTimeSchema,
});

/**
 * One Relay the client may connect to. Every candidate carries its own
 * `allocationId` and pre-signed `clientAttach`: Relay nodes key channels by
 * `allocationId`, so candidates cannot share one, and a losing candidate simply
 * expires. Only the confirmed winner ever gets a control-plane attach.
 */
export const RelayCandidateSchema = z.strictObject({
  allocationId: IdSchema,
  relayId: IdSchema,
  relayRegion: z.string().trim().min(1).max(80),
  relayUrl: z.string().url(),
  clientAttach: RelayAttachCapabilitySchema,
  /** Coordinator-side ranking input; lower is better. */
  serverScore: z.number().nonnegative(),
  cpHint: RelayControlPlaneHintSchema.optional(),
});

export const RelaySelectionSchema = z.strictObject({
  selectionId: IdSchema,
  expiresAt: DateTimeSchema,
  /** True when a cached `preferredRelayId` was still eligible and ranked first. */
  preferredHonored: z.boolean(),
  candidates: z.array(RelayCandidateSchema).min(1).max(RELAY_MAX_CANDIDATES),
});

export const RelayCandidateMeasurementSchema = z.strictObject({
  allocationId: IdSchema,
  relayId: IdSchema,
  mobileRttMs: z.number().nonnegative().optional(),
  sampleCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
});

/**
 * Why the client confirmed what it confirmed, recorded with the selection so
 * degraded paths are observable instead of being invisible fallbacks.
 */
export const RelaySelectionFallbackSchema = z.enum(["none", "server-order", "partial-probe", "preferred-miss"]);

export const RelaySelectionConfirmationSchema = z.strictObject({
  winnerAllocationId: IdSchema,
  /** The client's full ranking, so the Coordinator can fall back in the same order. */
  rankedAllocationIds: z.array(IdSchema).max(RELAY_MAX_CANDIDATES).optional(),
  measurements: z.array(RelayCandidateMeasurementSchema).max(RELAY_MAX_CANDIDATES).optional(),
  fallback: RelaySelectionFallbackSchema.optional(),
});

/** The final, reserved allocation: the selection's winner with its control-plane peer attached. */
export const ConfirmedRelayAllocationSchema = RelayAllocationSchema.extend({
  fallback: RelaySelectionFallbackSchema.optional(),
  /** The Coordinator could not reserve the requested winner and booked another candidate instead. */
  substituted: z.boolean().optional(),
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

export const RelayCloseSchema = z.strictObject({
  channelId: IdSchema,
  code: z.enum(["normal", "expired", "revoked", "quota-exceeded", "rate-limited", "idle-timeout", "slow-consumer", "protocol-error", "peer-disconnected"]),
  retryable: z.boolean(),
});

export const RelayRevocationSchema = z.strictObject({
  protocolVersion: z.literal(RELAY_FRAMING_PROTOCOL_VERSION),
  audience: z.literal(OfficialAudience.RelayRevocation),
  revocationId: IdSchema,
  relayId: IdSchema.optional(),
  allocationId: IdSchema.optional(),
  sessionId: IdSchema.optional(),
  accountId: IdSchema.optional(),
  deviceSessionId: IdSchema.optional(),
  bindingId: IdSchema.optional(),
  channelKind: RelayChannelKindSchema.optional(),
  controlPlaneId: IdSchema.optional(),
  nodeHandle: NodeRelayHandleSchema.optional(),
  ownerAccountId: IdSchema.optional(),
  accessMode: ResourceAccessModeSchema.optional(),
  shareGrantId: IdSchema.optional(),
  shareRevision: z.number().int().positive().optional(),
  accessRoleId: AccessRoleIdSchema.optional(),
  shareRole: NodeShareRoleSchema.optional(),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  signature: OpaqueSecretSchema,
}).superRefine((value, context) => {
  if (![value.allocationId, value.sessionId, value.accountId, value.deviceSessionId, value.bindingId, value.controlPlaneId, value.nodeHandle, value.shareGrantId].some(Boolean)) context.addIssue({ code: "custom", message: "revocation target is required" });
  if ((value.shareGrantId === undefined) !== (value.shareRevision === undefined)) context.addIssue({ code: "custom", message: "shareGrantId and shareRevision must be supplied together" });
  if (value.channelKind === "node" && value.accessRoleId !== undefined) context.addIssue({ code: "custom", path: ["accessRoleId"], message: "node revocations cannot carry a Control Plane access role" });
  if (value.channelKind !== "node" && value.shareRole !== undefined) context.addIssue({ code: "custom", path: ["shareRole"], message: "node use authority is only valid for node revocations" });
  if (value.accessMode === "shared") {
    if (value.channelKind === "node" && value.shareRole !== "use") context.addIssue({ code: "custom", path: ["shareRole"], message: "shared node revocation requires shareRole use" });
    if (value.channelKind !== "node" && !value.accessRoleId) context.addIssue({ code: "custom", path: ["accessRoleId"], message: "shared Control Plane revocation requires accessRoleId" });
  }
  if (value.accessMode === "owner") {
    if (!value.ownerAccountId) context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "owner revocation requires ownerAccountId" });
    if (value.shareGrantId !== undefined || value.shareRevision !== undefined || value.shareRole !== undefined) context.addIssue({ code: "custom", message: "owner revocation cannot carry share authority" });
    if (value.channelKind === "node") context.addIssue({ code: "custom", path: ["channelKind"], message: "owner revocation is only valid for access channels" });
  }
  if (value.sessionId && Date.parse(value.expiresAt) - Date.parse(value.issuedAt) < RELAY_REVOCATION_MIN_VALIDITY_MS) context.addIssue({ code: "custom", path: ["expiresAt"], message: "session revocation must remain valid for at least the maximum grant lifetime" });
});

/**
 * One traffic allowance window, measured in bytes. `limitBytes === null` means the
 * plan is unlimited for this window, and `percentage === null` follows from it.
 * Counts are wire bytes (frame header plus sealed payload) in both directions.
 */
export const RelayPlanWindowProgressSchema = z.strictObject({
  window: z.enum(["daily", "weekly", "monthly"]),
  limitBytes: z.number().int().nonnegative().nullable(),
  usedBytes: z.number().int().nonnegative(),
  remainingBytes: z.number().int().nonnegative().nullable(),
  percentage: z.number().min(0).nullable(),
  windowStart: DateTimeSchema.nullable(),
  resetsAt: DateTimeSchema.nullable(),
  resetsInSeconds: z.number().int().nonnegative().nullable(),
});

/** The account's own view of its relay plan: catalog identity plus window progress. */
export const RelayPlanProgressSchema = z.strictObject({
  planKey: IdSchema,
  planName: LocaleTextSchema,
  /** True when the resolved plan was reached through the fallback chain. */
  degraded: z.boolean(),
  expiresAt: DateTimeSchema.nullable(),
  expiresInSeconds: z.number().int().nonnegative().nullable(),
  windows: z.array(RelayPlanWindowProgressSchema).length(3),
});

export type RelayPlanWindowProgress = z.infer<typeof RelayPlanWindowProgressSchema>;
export type RelayPlanProgress = z.infer<typeof RelayPlanProgressSchema>;

export type AccessTicket = z.infer<typeof AccessTicketSchema>;
export type RelayAllocation = z.infer<typeof RelayAllocationSchema>;
export type ConfirmedRelayAllocation = z.infer<typeof ConfirmedRelayAllocationSchema>;
export type RelayCandidate = z.infer<typeof RelayCandidateSchema>;
export type RelayControlPlaneHint = z.infer<typeof RelayControlPlaneHintSchema>;
export type RelaySelection = z.infer<typeof RelaySelectionSchema>;
export type RelaySelectionConfirmation = z.infer<typeof RelaySelectionConfirmationSchema>;
export type RelaySelectionFallback = z.infer<typeof RelaySelectionFallbackSchema>;
export type RelayCandidateMeasurement = z.infer<typeof RelayCandidateMeasurementSchema>;
export type RelayAttachCapability = z.infer<typeof RelayAttachCapabilitySchema>;
export type RelayRateLimit = z.infer<typeof RelayRateLimitSchema>;
