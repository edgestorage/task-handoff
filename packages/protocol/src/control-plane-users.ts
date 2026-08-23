import { z } from "zod";

export const CONTROL_PLANE_PERMISSION_IDS = [
  "users:read", "users:manage",
  "roles:read", "roles:manage",
  "identity-providers:read", "identity-providers:manage",
  "nodes:read", "nodes:manage",
  "projects:read", "projects:manage",
  "runtimes:read", "runtimes:manage",
  "templates:read", "templates:manage",
  "instances:read", "instances:manage", "instances:interactive",
  "app-sessions:read", "app-sessions:manage", "app-sessions:interactive",
  "ai-sessions:read", "ai-sessions:manage", "ai-sessions:interactive",
  "triggers:read", "triggers:manage",
  "repositories:read", "repositories:manage",
  "attachments:read", "attachments:manage",
  "images:read", "images:manage",
  "models:read", "models:manage",
  "settings:read", "settings:manage",
  "secrets:manage",
  "chat-bridges:read", "chat-bridges:manage",
  "public-directory:read",
] as const;

export const ControlPlanePermissionIdSchema = z.enum(CONTROL_PLANE_PERMISSION_IDS);
export const ControlPlaneUserStatusSchema = z.enum(["active", "disabled", "archived"]);
export const ControlPlaneLoginIdentityKindSchema = z.enum(["local-password", "oidc", "oauth"]);
export const ControlPlaneRoleStatusSchema = z.enum(["active", "archived"]);
export const ControlPlaneIdentityProviderKindSchema = z.enum(["oidc", "github"]);
export const ControlPlaneIdentityProviderStatusSchema = z.enum(["enabled", "disabled"]);
export const ControlPlaneExternalIdentityLoginPolicySchema = z.enum(["existing-only", "admin-approved-create"]);

export const ControlPlaneUserNodeScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({
    kind: z.literal("selected"),
    nodeIds: z.array(z.string().trim().min(1)).max(10_000),
  }).strict(),
]);

export const ControlPlanePermissionDescriptorSchema = z.object({
  id: ControlPlanePermissionIdSchema,
  resource: z.string().trim().min(1).max(80),
  action: z.string().trim().min(1).max(80),
  nodeScoped: z.boolean(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(500).optional(),
}).strict();

const GLOBAL_PERMISSION_RESOURCES = new Set(["users", "roles", "identity-providers", "settings", "secrets", "chat-bridges", "public-directory"]);
export const CONTROL_PLANE_PERMISSION_CATALOG = CONTROL_PLANE_PERMISSION_IDS.map((id) => {
  const [resource, action] = id.split(":") as [string, string];
  return ControlPlanePermissionDescriptorSchema.parse({
    id,
    resource,
    action,
    nodeScoped: !GLOBAL_PERMISSION_RESOURCES.has(resource),
    name: id,
  });
});

export const ControlPlaneUserSummarySchema = z.object({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1).max(160),
  primaryUsername: z.string().trim().min(1).max(80).optional(),
  status: ControlPlaneUserStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().optional(),
}).strict();

export const ControlPlaneLoginIdentitySummarySchema = z.object({
  id: z.string().trim().min(1),
  userId: z.string().trim().min(1),
  kind: ControlPlaneLoginIdentityKindSchema,
  providerId: z.string().trim().min(1).optional(),
  loginName: z.string().trim().min(1).max(160).optional(),
  subject: z.string().trim().min(1).max(500).optional(),
  verifiedEmail: z.string().email().optional(),
  requiresPasswordChange: z.boolean().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
}).strict().superRefine((identity, context) => {
  if (identity.kind === "local-password" && !identity.loginName) {
    context.addIssue({ code: "custom", path: ["loginName"], message: "Local password identities require loginName." });
  }
  if (identity.kind !== "local-password" && (!identity.providerId || !identity.subject)) {
    context.addIssue({ code: "custom", path: ["providerId"], message: "External identities require providerId and subject." });
  }
});

export const ControlPlaneUserSessionSummarySchema = z.object({
  id: z.string().trim().min(1),
  userId: z.string().trim().min(1),
  identityId: z.string().trim().min(1),
  clientType: z.enum(["web", "mobile"]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
  current: z.boolean().optional(),
}).strict();

export const ControlPlaneRoleSummarySchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  system: z.boolean(),
  status: ControlPlaneRoleStatusSchema,
  permissionIds: z.array(ControlPlanePermissionIdSchema).max(CONTROL_PLANE_PERMISSION_IDS.length),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const ControlPlaneUserAccessGrantSchema = z.object({
  userId: z.string().trim().min(1),
  roleIds: z.array(z.string().trim().min(1)).min(1).max(100),
  nodeScope: ControlPlaneUserNodeScopeSchema,
  authorizationRevision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
}).strict();

export const ControlPlaneUserDetailSchema = ControlPlaneUserSummarySchema.extend({
  identities: z.array(ControlPlaneLoginIdentitySummarySchema),
  accessGrant: ControlPlaneUserAccessGrantSchema,
}).strict();

export const ControlPlaneCurrentAuthorizationSchema = z.object({
  userId: z.string().trim().min(1),
  identityId: z.string().trim().min(1),
  roleIds: z.array(z.string().trim().min(1)).min(1).max(100),
  permissionIds: z.array(ControlPlanePermissionIdSchema).max(CONTROL_PLANE_PERMISSION_IDS.length),
  nodeScope: ControlPlaneUserNodeScopeSchema,
  authorizationRevision: z.number().int().positive(),
}).strict();

export const ControlPlaneIdentityProviderSummarySchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120),
  kind: ControlPlaneIdentityProviderKindSchema,
  status: ControlPlaneIdentityProviderStatusSchema,
  loginPolicy: ControlPlaneExternalIdentityLoginPolicySchema,
  issuer: z.string().url().optional(),
  clientId: z.string().trim().min(1).max(500),
  callbackUrl: z.string().url(),
  clientSecretConfigured: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((provider, context) => {
  if (provider.kind === "oidc" && !provider.issuer) {
    context.addIssue({ code: "custom", path: ["issuer"], message: "OIDC providers require issuer." });
  }
});

export const ControlPlaneAccessManagementCapabilitySchema = z.object({
  userManagement: z.object({
    users: z.literal(true),
    identities: z.literal(true),
    sessions: z.literal(true),
  }).strict(),
  authentication: z.object({
    externalIdentity: z.object({
      oidc: z.boolean(),
      oauthAdapters: z.array(ControlPlaneIdentityProviderKindSchema).max(20),
    }).strict().optional(),
  }).strict(),
  authorization: z.object({
    customRoles: z.boolean(),
    nodeScopes: z.literal(true),
    authorizationRevisions: z.literal(true),
  }).strict(),
}).strict();

export type ControlPlanePermissionId = z.infer<typeof ControlPlanePermissionIdSchema>;
export type ControlPlaneUserNodeScope = z.infer<typeof ControlPlaneUserNodeScopeSchema>;
export type ControlPlanePermissionDescriptor = z.infer<typeof ControlPlanePermissionDescriptorSchema>;
export type ControlPlaneUserSummary = z.infer<typeof ControlPlaneUserSummarySchema>;
export type ControlPlaneUserDetail = z.infer<typeof ControlPlaneUserDetailSchema>;
export type ControlPlaneLoginIdentitySummary = z.infer<typeof ControlPlaneLoginIdentitySummarySchema>;
export type ControlPlaneUserSessionSummary = z.infer<typeof ControlPlaneUserSessionSummarySchema>;
export type ControlPlaneRoleSummary = z.infer<typeof ControlPlaneRoleSummarySchema>;
export type ControlPlaneUserAccessGrant = z.infer<typeof ControlPlaneUserAccessGrantSchema>;
export type ControlPlaneCurrentAuthorization = z.infer<typeof ControlPlaneCurrentAuthorizationSchema>;
export type ControlPlaneIdentityProviderSummary = z.infer<typeof ControlPlaneIdentityProviderSummarySchema>;
export type ControlPlaneAccessManagementCapability = z.infer<typeof ControlPlaneAccessManagementCapabilitySchema>;
