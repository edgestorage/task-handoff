import { z } from "zod";
import { canonicalJson, DateTimeSchema, IdSchema, Sha256DigestSchema } from "./common.ts";
import { AccessTicketSchema, type AccessTicket } from "./relay.ts";
import {
  RelaySessionGrantSchema,
  RelaySessionTranscriptTicketSchema,
  type RelaySessionGrant,
  type RelaySessionTranscriptTicket,
} from "./relay-session.ts";

/**
 * Device authentication is deliberately separate from the node-only E2E
 * implementation. This module must stay platform neutral so mobile clients can
 * consume the exact same canonical inputs as the Control Plane.
 */
export const CLOUD_DEVICE_AUTH_PROTOCOL_VERSION = "2026-10-26";
export const CLOUD_DEVICE_AUTH_AUDIENCE = "task-handoff:cloud-device-auth";
export const CLOUD_DEVICE_TRUST_AUDIENCE = "task-handoff:cloud-device-trust";
export const CLOUD_CLIENT_HANDSHAKE_AUDIENCE = "task-handoff:cloud-client-handshake";
export const CLOUD_DEVICE_AUTH_SIGNING_DOMAIN = "task-handoff:cloud-device-auth:v1";
export const CLOUD_DEVICE_TRUST_SIGNING_DOMAIN = "task-handoff:cloud-device-trust:v1";
export const CLOUD_DEVICE_SAS_SIGNING_DOMAIN = "task-handoff:cloud-device-sas:v1";
export const CLOUD_DEVICE_AUTH_MAX_DEVICE_NAME_LENGTH = 160;
export const CLOUD_DEVICE_AUTH_MAX_VERSION_LENGTH = 80;

const PublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const SignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const DeviceTokenSchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9._-]*$/);

export const CloudDeviceDescriptorSchema = z.strictObject({
  name: z.string().trim().min(1).max(CLOUD_DEVICE_AUTH_MAX_DEVICE_NAME_LENGTH),
  kind: DeviceTokenSchema,
  platform: DeviceTokenSchema,
  version: z.string().trim().min(1).max(CLOUD_DEVICE_AUTH_MAX_VERSION_LENGTH).optional(),
});
export type CloudDeviceDescriptor = z.infer<typeof CloudDeviceDescriptorSchema>;

export const CloudDeviceAuthPayloadSchema = z.strictObject({
  protocolVersion: z.literal(CLOUD_DEVICE_AUTH_PROTOCOL_VERSION),
  audience: z.literal(CLOUD_DEVICE_AUTH_AUDIENCE),
});
export type CloudDeviceAuthPayload = z.infer<typeof CloudDeviceAuthPayloadSchema>;

/** The signature covers the complete hello context; this schema is only the envelope. */
export const CloudDeviceAuthSchema = z.strictObject({
  protocolVersion: z.literal(CLOUD_DEVICE_AUTH_PROTOCOL_VERSION),
  device: CloudDeviceDescriptorSchema,
  signature: SignatureSchema,
});
export type CloudDeviceAuth = z.infer<typeof CloudDeviceAuthSchema>;

export const ClientHelloSchema = z.strictObject({
  ticketId: z.string().trim().min(3).max(160),
  deviceSessionId: z.string().trim().min(3).max(160),
  clientEphemeralPublicKey: PublicKeySchema,
  // Optional only so an old client can receive an explicit unsupported result.
  // A missing value never enables a legacy authenticated connection on the server.
  deviceAuth: CloudDeviceAuthSchema.optional(),
  // Set only by an explicit user retry after a terminal trust result. It lets
  // the Control Plane create a new request without turning background
  // reconnects into an approval-request loop.
  trustRetry: z.literal(true).optional(),
});
export type ClientHello = z.infer<typeof ClientHelloSchema>;

export const CloudDeviceAuthBindingsSchema = z.strictObject({
  protocolVersion: z.literal(CLOUD_DEVICE_AUTH_PROTOCOL_VERSION),
  audience: z.literal(CLOUD_DEVICE_AUTH_AUDIENCE),
  ticketId: IdSchema,
  accountId: IdSchema,
  deviceSessionId: IdSchema,
  controlPlaneId: IdSchema,
  bindingId: IdSchema,
  bindingRevision: z.number().int().positive(),
  targetPublicKeyFingerprint: Sha256DigestSchema,
  nonce: z.string().min(16).max(256),
  ownerAccountId: IdSchema.optional(),
  accessMode: z.enum(["owner", "shared"]).optional(),
  accessRoleId: IdSchema.optional(),
  shareGrantId: IdSchema.optional(),
  shareRevision: z.number().int().positive().optional(),
  clientProofPublicKey: PublicKeySchema,
  clientEphemeralPublicKey: PublicKeySchema,
  device: CloudDeviceDescriptorSchema,
  trustRetry: z.literal(true).optional(),
}).superRefine((value, context) => {
  if (!value.accessMode) {
    context.addIssue({ code: "custom", path: ["accessMode"], message: "device authentication requires accessMode" });
    return;
  }
  if (!value.ownerAccountId) context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "device authentication requires ownerAccountId" });
  if (!value.accessRoleId) context.addIssue({ code: "custom", path: ["accessRoleId"], message: "device authentication requires accessRoleId" });
  if (value.accessMode === "owner") {
    if (value.ownerAccountId !== value.accountId) context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "owner access requires the account to own the binding" });
    if (value.shareGrantId !== undefined || value.shareRevision !== undefined) context.addIssue({ code: "custom", message: "owner access cannot carry share authority" });
    return;
  }
  if (value.ownerAccountId === value.accountId) context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "shared access requires a different owner" });
  if (!value.shareGrantId) context.addIssue({ code: "custom", path: ["shareGrantId"], message: "shared access requires shareGrantId" });
  if (value.shareRevision === undefined) context.addIssue({ code: "custom", path: ["shareRevision"], message: "shared access requires shareRevision" });
});
export type CloudDeviceAuthBindings = z.infer<typeof CloudDeviceAuthBindingsSchema>;

export const CloudClientTrustStateSchema = z.enum([
  "pending",
  "rejected",
  "expired",
  "revoked",
  "trust-required",
]);
export type CloudClientTrustState = z.infer<typeof CloudClientTrustStateSchema>;

export const CloudClientTrustReasonSchema = z.enum([
  "first-seen",
  "role-changed",
  "share-role-changed",
  "authorization-stale",
  "unsupported-client",
  "admin-rejected",
  "request-expired",
  "device-revoked",
]);
export type CloudClientTrustReason = z.infer<typeof CloudClientTrustReasonSchema>;

const CloudClientTrustOutcomeBaseSchema = z.strictObject({
  protocolVersion: z.literal(CLOUD_DEVICE_AUTH_PROTOCOL_VERSION),
  audience: z.literal(CLOUD_DEVICE_TRUST_AUDIENCE),
  state: CloudClientTrustStateSchema,
  reason: CloudClientTrustReasonSchema.optional(),
  requestId: IdSchema.optional(),
  controlPlaneId: IdSchema,
  bindingId: IdSchema,
  ticketId: IdSchema,
  accountId: IdSchema,
  deviceSessionId: IdSchema,
  controlPlanePublicKey: PublicKeySchema,
  device: CloudDeviceDescriptorSchema,
  devicePublicKeyFingerprint: Sha256DigestSchema,
  comparisonCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/),
  issuedAt: DateTimeSchema,
  expiresAt: DateTimeSchema,
  signature: SignatureSchema,
});

type CloudClientTrustOutcomeValidationFields = Omit<z.infer<typeof CloudClientTrustOutcomeBaseSchema>, "signature">;

const validateCloudClientTrustOutcome = (value: CloudClientTrustOutcomeValidationFields, context: z.RefinementCtx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "trust outcome expiry must be after issuance" });
  }
  if (value.state === "pending" && (!value.requestId || !value.reason)) {
    context.addIssue({ code: "custom", path: ["requestId"], message: "pending trust outcomes require a request and reason" });
  }
  if (value.state === "trust-required" && value.reason !== "unsupported-client") {
    context.addIssue({ code: "custom", path: ["reason"], message: "trust-required currently only describes unsupported clients" });
  }
};

// Keep the unrefined object available for derived schemas: Zod 4 does not allow
// omitting fields from a schema that already has refinements.
const CloudClientTrustOutcomeUnsignedSchema = CloudClientTrustOutcomeBaseSchema
  .omit({ signature: true })
  .superRefine(validateCloudClientTrustOutcome);

export const CloudClientTrustOutcomeSchema = CloudClientTrustOutcomeBaseSchema.superRefine(validateCloudClientTrustOutcome);
export type CloudClientTrustOutcome = z.infer<typeof CloudClientTrustOutcomeSchema>;

/** Successful replies are only emitted after device authentication and an active pin. */
export const HandshakeResponseSchema = z.strictObject({
  protocolVersion: z.literal(CLOUD_DEVICE_AUTH_PROTOCOL_VERSION),
  audience: z.literal(CLOUD_CLIENT_HANDSHAKE_AUDIENCE),
  state: z.literal("accepted"),
  controlPlaneId: IdSchema,
  bindingId: IdSchema,
  ticketId: IdSchema,
  deviceSessionId: IdSchema,
  controlPlanePublicKey: PublicKeySchema,
  serverEphemeralPublicKey: PublicKeySchema,
  transcript: PublicKeySchema,
  signature: SignatureSchema,
});
export type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;

export const CloudClientHandshakeReplySchema = z.discriminatedUnion("state", [
  HandshakeResponseSchema,
  CloudClientTrustOutcomeSchema,
]);
export type CloudClientHandshakeReply = z.infer<typeof CloudClientHandshakeReplySchema>;

const RelayTranscriptCredentialSchema = z.union([AccessTicketSchema, RelaySessionTranscriptTicketSchema]);
export type CloudDeviceCredential = AccessTicket | RelaySessionTranscriptTicket;

export class CloudDeviceAuthError extends Error {
  readonly code: "CLOUD_DEVICE_AUTH_INVALID" | "CLOUD_DEVICE_AUTH_UNSUPPORTED_CLIENT";

  constructor(
    code: "CLOUD_DEVICE_AUTH_INVALID" | "CLOUD_DEVICE_AUTH_UNSUPPORTED_CLIENT",
    message: string,
  ) {
    super(message);
    this.name = "CloudDeviceAuthError";
    this.code = code;
  }
}

export function cloudDeviceAuthBindings(input: {
  ticket: unknown;
  grant: unknown;
  clientEphemeralPublicKey: unknown;
  device: unknown;
  trustRetry?: boolean;
}): CloudDeviceAuthBindings {
  const ticket = RelayTranscriptCredentialSchema.parse(input.ticket);
  const grant = RelaySessionGrantSchema.parse(input.grant);
  const clientEphemeralPublicKey = PublicKeySchema.parse(input.clientEphemeralPublicKey);
  const device = CloudDeviceDescriptorSchema.parse(input.device);
  assertCredentialMatchesGrant(ticket, grant);
  return CloudDeviceAuthBindingsSchema.parse({
    protocolVersion: CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
    audience: CLOUD_DEVICE_AUTH_AUDIENCE,
    ticketId: transcriptTicketId(ticket),
    accountId: ticket.accountId,
    deviceSessionId: ticket.deviceSessionId,
    controlPlaneId: ticket.controlPlaneId,
    bindingId: ticket.bindingId,
    bindingRevision: ticket.bindingRevision,
    targetPublicKeyFingerprint: ticket.targetPublicKeyFingerprint,
    nonce: ticket.nonce,
    ...(ticket.accessMode === undefined ? {} : {
      ownerAccountId: ticket.ownerAccountId,
      accessMode: ticket.accessMode,
      ...(ticket.accessRoleId === undefined ? {} : { accessRoleId: ticket.accessRoleId }),
      ...(ticket.shareGrantId === undefined ? {} : { shareGrantId: ticket.shareGrantId, shareRevision: ticket.shareRevision }),
    }),
    clientProofPublicKey: grant.clientProofPublicKey,
    clientEphemeralPublicKey,
    device,
    ...(input.trustRetry === true ? { trustRetry: true as const } : {}),
  });
}

/** The single canonical input signed by the device's installation key. */
export function cloudDeviceAuthSigningInput(input: {
  ticket: unknown;
  grant: unknown;
  clientEphemeralPublicKey: unknown;
  device: unknown;
  trustRetry?: boolean;
}): string {
  return `${CLOUD_DEVICE_AUTH_SIGNING_DOMAIN}\n${canonicalJson(cloudDeviceAuthBindings(input))}`;
}

/** Canonical transcript payload consumed by both Node and mobile hash implementations. */
export function cloudClientTranscriptPayload(input: {
  ticket: unknown;
  grant?: unknown;
  clientEphemeralPublicKey: unknown;
  serverEphemeralPublicKey: unknown;
}): Record<string, unknown> {
  const ticket = RelayTranscriptCredentialSchema.parse(input.ticket);
  const clientEphemeralPublicKey = PublicKeySchema.parse(input.clientEphemeralPublicKey);
  const serverEphemeralPublicKey = PublicKeySchema.parse(input.serverEphemeralPublicKey);
  const deviceBindings = input.grant === undefined ? undefined : cloudDeviceAuthBindings({
    ticket,
    grant: input.grant,
    clientEphemeralPublicKey,
    device: { name: "transcript", kind: "transcript", platform: "transcript" },
  });
  return {
    audience: ticket.audience,
    ticketId: transcriptTicketId(ticket),
    accountId: ticket.accountId,
    deviceSessionId: ticket.deviceSessionId,
    controlPlaneId: ticket.controlPlaneId,
    bindingId: ticket.bindingId,
    bindingRevision: ticket.bindingRevision,
    nonce: ticket.nonce,
    clientEphemeralPublicKey,
    serverEphemeralPublicKey,
    ...(ticket.accessMode === undefined ? {} : {
      ownerAccountId: ticket.ownerAccountId,
      accessMode: ticket.accessMode,
      ...(ticket.accessRoleId === undefined ? {} : { accessRoleId: ticket.accessRoleId }),
      ...(ticket.shareGrantId === undefined ? {} : { shareGrantId: ticket.shareGrantId, shareRevision: ticket.shareRevision }),
    }),
    ...(deviceBindings === undefined ? {} : { clientProofPublicKey: deviceBindings.clientProofPublicKey }),
  };
}

export function cloudClientTranscriptSigningInput(input: {
  ticket: unknown;
  grant?: unknown;
  clientEphemeralPublicKey: unknown;
  serverEphemeralPublicKey: unknown;
}): string {
  return canonicalJson(cloudClientTranscriptPayload(input));
}

/** Pure input used by each platform's SHA-256 implementation. */
export function cloudDeviceFingerprintInput(publicKey: unknown): Uint8Array {
  return new TextEncoder().encode(PublicKeySchema.parse(publicKey));
}

export function cloudDeviceComparisonCodeInput(bindingId: unknown, publicKey: unknown): Uint8Array {
  return new TextEncoder().encode(`${CLOUD_DEVICE_SAS_SIGNING_DOMAIN}\0${IdSchema.parse(bindingId)}\0${PublicKeySchema.parse(publicKey)}`);
}

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function formatCloudDeviceComparisonCode(digest: Uint8Array): string {
  if (digest.byteLength < 10) throw new CloudDeviceAuthError("CLOUD_DEVICE_AUTH_INVALID", "A comparison code requires at least ten digest bytes.");
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of digest.subarray(0, 10)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  return encoded.match(/.{1,4}/g)!.join("-");
}

export function cloudClientTrustOutcomeSigningInput(rawOutcome: unknown): string {
  if (!rawOutcome || typeof rawOutcome !== "object" || Array.isArray(rawOutcome)) {
    throw new CloudDeviceAuthError("CLOUD_DEVICE_AUTH_INVALID", "The trust outcome must be an object.");
  }
  const { signature: _signature, ...payload } = rawOutcome as Record<string, unknown>;
  const parsed = CloudClientTrustOutcomeUnsignedSchema.parse(payload);
  return `${CLOUD_DEVICE_TRUST_SIGNING_DOMAIN}\n${canonicalJson(parsed)}`;
}

export function parseCloudDeviceAuth(raw: unknown): CloudDeviceAuth {
  return CloudDeviceAuthSchema.parse(raw);
}

export function parseClientHello(raw: unknown): ClientHello {
  return ClientHelloSchema.parse(raw);
}

function assertCredentialMatchesGrant(ticket: CloudDeviceCredential, grant: RelaySessionGrant): void {
  if (transcriptTicketId(ticket) !== grant.sessionTranscriptTicket.transcriptTicketId
    || ticket.accountId !== grant.accountId
    || ticket.deviceSessionId !== grant.deviceSessionId
    || ticket.controlPlaneId !== grant.controlPlaneId
    || ticket.bindingId !== grant.bindingId
    || ticket.bindingRevision !== grant.bindingRevision
    || ticket.targetPublicKeyFingerprint !== grant.targetPublicKeyFingerprint
    || ticket.accessMode !== grant.accessMode
    || ticket.ownerAccountId !== grant.ownerAccountId
    || ticket.accessRoleId !== grant.accessRoleId
    || ticket.shareGrantId !== grant.shareGrantId
    || ticket.shareRevision !== grant.shareRevision) {
    throw new CloudDeviceAuthError("CLOUD_DEVICE_AUTH_INVALID", "Device authentication ticket does not match the grant authority.");
  }
  if ("ticketId" in ticket) {
    if (ticket.clientProofPublicKey === undefined) {
      throw new CloudDeviceAuthError("CLOUD_DEVICE_AUTH_UNSUPPORTED_CLIENT", "The access ticket does not bind a device proof key.");
    }
    if (ticket.clientProofPublicKey !== grant.clientProofPublicKey) {
      throw new CloudDeviceAuthError("CLOUD_DEVICE_AUTH_INVALID", "Device authentication ticket proof key does not match the grant.");
    }
  }
}

function transcriptTicketId(ticket: CloudDeviceCredential): string {
  return "ticketId" in ticket ? ticket.ticketId : ticket.transcriptTicketId;
}
