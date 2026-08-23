import { z } from "zod";
import {
  ControlPlaneExternalIdentityLoginPolicySchema,
  ControlPlaneIdentityProviderKindSchema,
  ControlPlaneIdentityProviderStatusSchema,
  ControlPlaneLoginIdentityKindSchema,
  ControlPlanePermissionIdSchema,
  ControlPlaneRoleStatusSchema,
  ControlPlaneUserNodeScopeSchema,
  ControlPlaneUserStatusSchema,
} from "@task-handoff/protocol/control-plane-access";

const StoredRecordSchema = z.object({
  id: z.string().trim().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const UserAccountRecordSchema = StoredRecordSchema.extend({
  displayName: z.string().trim().min(1).max(160),
  status: ControlPlaneUserStatusSchema,
  lastLoginAt: z.string().datetime().optional(),
  archivedAt: z.string().datetime().optional(),
}).strict().superRefine((user, context) => {
  if (user.status === "archived" && !user.archivedAt) {
    context.addIssue({ code: "custom", path: ["archivedAt"], message: "Archived users require archivedAt." });
  }
  if (user.status !== "archived" && user.archivedAt) {
    context.addIssue({ code: "custom", path: ["archivedAt"], message: "Only archived users can have archivedAt." });
  }
});

export const LoginIdentityRecordSchema = StoredRecordSchema.extend({
  userId: z.string().trim().min(1),
  kind: ControlPlaneLoginIdentityKindSchema,
  normalizedLoginName: z.string().trim().min(1).max(160).optional(),
  passwordHash: z.string().trim().min(1).optional(),
  requiresPasswordChange: z.boolean().optional(),
  providerId: z.string().trim().min(1).optional(),
  subject: z.string().trim().min(1).max(500).optional(),
  verifiedEmail: z.string().email().optional(),
  lastUsedAt: z.string().datetime().optional(),
}).strict().superRefine((identity, context) => {
  if (identity.kind === "local-password") {
    if (!identity.normalizedLoginName) context.addIssue({ code: "custom", path: ["normalizedLoginName"], message: "Local identity requires normalizedLoginName." });
    if (!identity.passwordHash) context.addIssue({ code: "custom", path: ["passwordHash"], message: "Local identity requires passwordHash." });
    if (identity.providerId || identity.subject) context.addIssue({ code: "custom", path: ["providerId"], message: "Local identity cannot reference a provider." });
  } else {
    if (!identity.providerId || !identity.subject) context.addIssue({ code: "custom", path: ["providerId"], message: "External identity requires providerId and subject." });
    if (identity.passwordHash || identity.normalizedLoginName) context.addIssue({ code: "custom", path: ["passwordHash"], message: "External identity cannot contain local credentials." });
  }
});

export const RoleDefinitionRecordSchema = StoredRecordSchema.extend({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  system: z.boolean(),
  status: ControlPlaneRoleStatusSchema,
  permissionIds: z.array(ControlPlanePermissionIdSchema),
}).strict();

export const UserAccessGrantRecordSchema = StoredRecordSchema.extend({
  userId: z.string().trim().min(1),
  roleIds: z.array(z.string().trim().min(1)).min(1).max(100),
  nodeScope: ControlPlaneUserNodeScopeSchema,
  authorizationRevision: z.number().int().positive(),
}).strict();

export const UserSessionRecordSchema = StoredRecordSchema.extend({
  userId: z.string().trim().min(1),
  identityId: z.string().trim().min(1),
  authorizationRevision: z.number().int().positive(),
  tokenHash: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
  clientType: z.enum(["web", "mobile"]),
  device: z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    platform: z.enum(["ios", "android"]),
    appVersion: z.string().trim().min(1).optional(),
  }).strict().optional(),
}).strict().refine((session) => session.clientType !== "mobile" || Boolean(session.device), {
  path: ["device"],
  message: "Mobile sessions require device metadata.",
});

export const IdentityProviderRecordSchema = StoredRecordSchema.extend({
  name: z.string().trim().min(1).max(120),
  kind: ControlPlaneIdentityProviderKindSchema,
  status: ControlPlaneIdentityProviderStatusSchema,
  loginPolicy: ControlPlaneExternalIdentityLoginPolicySchema,
  issuer: z.string().url().optional(),
  clientId: z.string().trim().min(1).max(500),
  clientSecretCiphertext: z.string().trim().min(1),
  callbackUrl: z.string().url(),
}).strict().superRefine((provider, context) => {
  if (provider.kind === "oidc" && !provider.issuer) {
    context.addIssue({ code: "custom", path: ["issuer"], message: "OIDC provider requires issuer." });
  }
});

export const ExternalIdentityApprovalRecordSchema = StoredRecordSchema.extend({
  providerId: z.string().trim().min(1),
  subject: z.string().trim().min(1).max(500),
  verifiedEmail: z.string().email().optional(),
  displayName: z.string().trim().min(1).max(160).optional(),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  expiresAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
  decidedByUserId: z.string().trim().min(1).optional(),
}).strict();

export const UserAuditRecordSchema = z.object({
  id: z.string().trim().min(1),
  action: z.string().trim().min(1).max(160),
  actorUserId: z.string().trim().min(1).optional(),
  targetType: z.string().trim().min(1).max(120),
  targetId: z.string().trim().min(1).optional(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
}).strict();

export type UserAccountRecord = z.infer<typeof UserAccountRecordSchema>;
export type LoginIdentityRecord = z.infer<typeof LoginIdentityRecordSchema>;
export type RoleDefinitionRecord = z.infer<typeof RoleDefinitionRecordSchema>;
export type UserAccessGrantRecord = z.infer<typeof UserAccessGrantRecordSchema>;
export type UserSessionRecord = z.infer<typeof UserSessionRecordSchema>;
export type IdentityProviderRecord = z.infer<typeof IdentityProviderRecordSchema>;
export type ExternalIdentityApprovalRecord = z.infer<typeof ExternalIdentityApprovalRecordSchema>;
export type UserAuditRecord = z.infer<typeof UserAuditRecordSchema>;
