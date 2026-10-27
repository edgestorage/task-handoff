import { z } from "zod";

const IdSchema = z.string().trim().min(3).max(160).regex(/^[a-z][a-z0-9_-]*$/);
const TimestampSchema = z.string().datetime();
const PublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const DeviceTokenSchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9._-]*$/);

export const CloudDeviceAccessModeSchema = z.enum(["owner", "shared"]);
export const CloudDeviceTrustReasonSchema = z.enum(["first-seen", "role-changed", "share-role-changed"]);
export type CloudDeviceTrustReason = z.infer<typeof CloudDeviceTrustReasonSchema>;
export const CloudDeviceTrustRequestStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export const CloudDeviceTrustPinStatusSchema = z.enum(["active", "revoked"]);
export const CloudDeviceTrustActorTypeSchema = z.enum(["user", "cloud-account", "system"]);
export const CloudDeviceTrustAuditActionSchema = z.enum([
  "request-created",
  "request-refreshed",
  "request-approved",
  "request-rejected",
  "request-expired",
  "pin-revision-converged",
  "pin-revoked",
]);

const DeviceMetadataSchema = z.strictObject({
  reportedName: z.string().trim().min(1).max(160),
  clientKind: DeviceTokenSchema,
  clientPlatform: DeviceTokenSchema,
  clientVersion: z.string().trim().min(1).max(80).optional(),
});

const AccessContextShape = {
  bindingId: IdSchema,
  accountId: IdSchema,
  ownerAccountId: IdSchema,
  accessMode: CloudDeviceAccessModeSchema,
  shareGrantId: IdSchema.optional(),
  shareRevision: z.number().int().positive().optional(),
  cloudAccessRoleId: IdSchema,
  devicePublicKey: PublicKeySchema,
} as const;

const CloudDevicePinRecordFieldsSchema = z.strictObject({
  id: IdSchema,
  ...AccessContextShape,
  ...DeviceMetadataSchema.shape,
  roleId: IdSchema,
  status: CloudDeviceTrustPinStatusSchema,
  label: z.string().trim().min(1).max(160).optional(),
  approvedByActorType: CloudDeviceTrustActorTypeSchema,
  approvedByActorId: z.string().trim().min(1).max(240),
  approvedAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  revokedAt: TimestampSchema.optional(),
  revokeReason: z.string().trim().min(1).max(500).optional(),
  authorizationRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const CloudDevicePinRecordSchema = CloudDevicePinRecordFieldsSchema.superRefine((value, context) => validateAccessContext(value, context));
export type CloudDevicePinRecord = z.infer<typeof CloudDevicePinRecordSchema>;

const CloudDeviceTrustRequestRecordFieldsSchema = z.strictObject({
  id: IdSchema,
  ...AccessContextShape,
  ...DeviceMetadataSchema.shape,
  status: CloudDeviceTrustRequestStatusSchema,
  reason: CloudDeviceTrustReasonSchema,
  requestedAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  expiresAt: TimestampSchema,
  decidedAt: TimestampSchema.optional(),
  decidedByActorType: CloudDeviceTrustActorTypeSchema.optional(),
  decidedByActorId: z.string().trim().min(1).max(240).optional(),
  decidedRoleId: IdSchema.optional(),
  decisionReason: z.string().trim().min(1).max(500).optional(),
  approvedPinId: IdSchema.optional(),
  revision: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const CloudDeviceTrustRequestRecordSchema = CloudDeviceTrustRequestRecordFieldsSchema.superRefine((value, context) => {
  validateAccessContext(value, context);
  if (value.shareGrantId && value.shareRevision === undefined) context.addIssue({ code: "custom", path: ["shareRevision"], message: "shared requests require shareRevision" });
  if (!value.shareGrantId && value.shareRevision !== undefined) context.addIssue({ code: "custom", path: ["shareGrantId"], message: "shareRevision requires shareGrantId" });
  if (Date.parse(value.expiresAt) <= Date.parse(value.requestedAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "request expiry must be after first appearance" });
  if (value.status === "pending" && value.decidedAt) context.addIssue({ code: "custom", path: ["decidedAt"], message: "pending requests cannot have a decision" });
  if (value.status !== "pending" && !value.decidedAt) context.addIssue({ code: "custom", path: ["decidedAt"], message: "decided requests require a decision timestamp" });
  if (value.status === "approved" && !value.approvedPinId) context.addIssue({ code: "custom", path: ["approvedPinId"], message: "approved requests require an active pin" });
});
export type CloudDeviceTrustRequestRecord = z.infer<typeof CloudDeviceTrustRequestRecordSchema>;

const CloudDeviceTrustAuditRecordFieldsSchema = z.strictObject({
  id: IdSchema,
  action: CloudDeviceTrustAuditActionSchema,
  bindingId: IdSchema,
  requestId: IdSchema.optional(),
  pinId: IdSchema.optional(),
  accountId: IdSchema,
  devicePublicKey: PublicKeySchema,
  deviceFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  actorType: CloudDeviceTrustActorTypeSchema,
  actorId: z.string().trim().min(1).max(240),
  actorRoleId: IdSchema.optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  details: z.record(z.string(), z.unknown()).default({}),
  createdAt: TimestampSchema,
});
export type CloudDeviceTrustAuditRecord = z.infer<typeof CloudDeviceTrustAuditRecordSchema>;
export const CloudDeviceTrustAuditRecordSchema = CloudDeviceTrustAuditRecordFieldsSchema;

const CLOUD_DEVICE_PIN_RECORD_KEYS = new Set(Object.keys(CloudDevicePinRecordFieldsSchema.shape));
const CLOUD_DEVICE_TRUST_REQUEST_RECORD_KEYS = new Set(Object.keys(CloudDeviceTrustRequestRecordFieldsSchema.shape));
const CLOUD_DEVICE_TRUST_AUDIT_RECORD_KEYS = new Set(Object.keys(CloudDeviceTrustAuditRecordFieldsSchema.shape));

export function parseStoredCloudDevicePinRecord(row: Record<string, unknown>): CloudDevicePinRecord {
  return CloudDevicePinRecordSchema.parse(knownRecordFields(row, CLOUD_DEVICE_PIN_RECORD_KEYS));
}

export function parseStoredCloudDeviceTrustRequestRecord(row: Record<string, unknown>): CloudDeviceTrustRequestRecord {
  return CloudDeviceTrustRequestRecordSchema.parse(knownRecordFields(row, CLOUD_DEVICE_TRUST_REQUEST_RECORD_KEYS));
}

export function parseStoredCloudDeviceTrustAuditRecord(row: Record<string, unknown>): CloudDeviceTrustAuditRecord {
  return CloudDeviceTrustAuditRecordSchema.parse(knownRecordFields(row, CLOUD_DEVICE_TRUST_AUDIT_RECORD_KEYS));
}

function knownRecordFields(row: Record<string, unknown>, keys: ReadonlySet<string>) {
  return Object.fromEntries(Object.entries(row).filter(([key, value]) => value !== null && keys.has(key)));
}

function validateAccessContext(value: {
  accountId: string;
  ownerAccountId: string;
  accessMode: "owner" | "shared";
  shareGrantId?: string;
  shareRevision?: number;
}, context: z.RefinementCtx) {
  if (value.accessMode === "owner") {
    if (value.ownerAccountId !== value.accountId) context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "owner pin requires the account to own the binding" });
    if (value.shareGrantId !== undefined || value.shareRevision !== undefined) context.addIssue({ code: "custom", message: "owner pins cannot carry share authority" });
  } else {
    if (value.ownerAccountId === value.accountId) context.addIssue({ code: "custom", path: ["ownerAccountId"], message: "shared pin requires a different owner" });
    if (!value.shareGrantId) context.addIssue({ code: "custom", path: ["shareGrantId"], message: "shared pin requires shareGrantId" });
  }
}
