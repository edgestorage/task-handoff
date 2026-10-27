import { z } from "zod";

export const CloudDeviceTrustSourceSchema = z.enum(["control-plane-device", "node-control-plane"]);
export const CloudDeviceTrustRequestStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export const CloudDeviceTrustPinStatusSchema = z.enum(["active", "revoked"]);
export const CloudDeviceTrustReasonSchema = z.enum(["first-seen", "role-changed", "share-role-changed"]);
export const CloudDeviceTrustAccessModeSchema = z.enum(["owner", "shared"]);

export const CloudDeviceTrustDeviceSchema = z.strictObject({
  name: z.string().min(1).max(160),
  kind: z.string().min(1).max(64),
  platform: z.string().min(1).max(64),
  version: z.string().min(1).max(80).optional(),
});

export const CloudDeviceTrustRoleOptionSchema = z.strictObject({
  roleId: z.string().min(1).max(160),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500).optional(),
  status: z.enum(["active", "archived"]),
  isAdmin: z.boolean(),
});

export const CloudDeviceTrustRequestSchema = z.strictObject({
  source: CloudDeviceTrustSourceSchema,
  requestId: z.string().min(1).max(160),
  status: CloudDeviceTrustRequestStatusSchema,
  reason: CloudDeviceTrustReasonSchema,
  device: CloudDeviceTrustDeviceSchema,
  fingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  comparisonCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/),
  bindingId: z.string().min(1).max(160),
  accountId: z.string().min(1).max(160),
  ownerAccountId: z.string().min(1).max(160),
  accessMode: CloudDeviceTrustAccessModeSchema,
  shareGrantId: z.string().min(1).max(160).optional(),
  cloudAccessRoleId: z.string().min(1).max(160),
  requestedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
  decidedRoleId: z.string().min(1).max(160).optional(),
  decisionReason: z.string().min(1).max(500).optional(),
  revision: z.number().int().positive(),
});

export const CloudDeviceTrustedDeviceSchema = z.strictObject({
  pinId: z.string().min(1).max(160),
  source: z.literal("control-plane-device"),
  status: CloudDeviceTrustPinStatusSchema,
  device: CloudDeviceTrustDeviceSchema,
  fingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  comparisonCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/),
  bindingId: z.string().min(1).max(160),
  accountId: z.string().min(1).max(160),
  ownerAccountId: z.string().min(1).max(160),
  accessMode: CloudDeviceTrustAccessModeSchema,
  shareGrantId: z.string().min(1).max(160).optional(),
  shareRevision: z.number().int().positive().optional(),
  cloudAccessRoleId: z.string().min(1).max(160),
  roleId: z.string().min(1).max(160),
  roleName: z.string().min(1).max(120).optional(),
  approvedAt: z.string().datetime(),
  approvedByActorType: z.enum(["user", "cloud-account", "system"]),
  approvedByActorId: z.string().min(1).max(240),
  lastSeenAt: z.string().datetime(),
  revokedAt: z.string().datetime().optional(),
  revokeReason: z.string().min(1).max(500).optional(),
  revision: z.number().int().positive(),
});

export const CloudDeviceTrustSnapshotSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  requests: z.array(CloudDeviceTrustRequestSchema),
  trustedDevices: z.array(CloudDeviceTrustedDeviceSchema),
  roles: z.array(CloudDeviceTrustRoleOptionSchema),
});

export const CloudDeviceTrustDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("approve"),
    expectedFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
    expectedRevision: z.number().int().positive(),
    reason: z.string().min(1).max(500).optional(),
  }),
  z.strictObject({
    decision: z.literal("reject"),
    expectedFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
    expectedRevision: z.number().int().positive(),
    reason: z.string().min(1).max(500).optional(),
  }),
]);

export const CloudDeviceTrustRevokeSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  reason: z.string().min(1).max(500).optional(),
});

export const CloudDeviceTrustChangedEventSchema = z.strictObject({
  bindingId: z.string().min(1).max(160),
  revision: z.number().int().positive(),
});

export type CloudDeviceTrustSource = z.infer<typeof CloudDeviceTrustSourceSchema>;
export type CloudDeviceTrustDevice = z.infer<typeof CloudDeviceTrustDeviceSchema>;
export type CloudDeviceTrustRoleOption = z.infer<typeof CloudDeviceTrustRoleOptionSchema>;
export type CloudDeviceTrustRequest = z.infer<typeof CloudDeviceTrustRequestSchema>;
export type CloudDeviceTrustedDevice = z.infer<typeof CloudDeviceTrustedDeviceSchema>;
export type CloudDeviceTrustSnapshot = z.infer<typeof CloudDeviceTrustSnapshotSchema>;
export type CloudDeviceTrustDecision = z.infer<typeof CloudDeviceTrustDecisionSchema>;
export type CloudDeviceTrustRevoke = z.infer<typeof CloudDeviceTrustRevokeSchema>;
export type CloudDeviceTrustChangedEvent = z.infer<typeof CloudDeviceTrustChangedEventSchema>;
