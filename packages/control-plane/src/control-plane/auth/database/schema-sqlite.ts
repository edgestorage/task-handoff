import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const metadata = sqliteTable("cp_metadata", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});

export const users = sqliteTable("cp_users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  status: text("status", { enum: ["active", "disabled", "archived"] }).notNull(),
  lastLoginAt: text("last_login_at"),
  archivedAt: text("archived_at"),
  ...timestamps,
});

export const identities = sqliteTable("cp_login_identities", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["local-password", "oidc", "oauth"] }).notNull(),
  normalizedLoginName: text("normalized_login_name"),
  passwordHash: text("password_hash"),
  requiresPasswordChange: integer("requires_password_change", { mode: "boolean" }),
  providerId: text("provider_id"),
  subject: text("subject"),
  verifiedEmail: text("verified_email"),
  lastUsedAt: text("last_used_at"),
  ...timestamps,
}, (table) => [
  uniqueIndex("cp_login_identities_login_name_uq").on(table.normalizedLoginName),
  uniqueIndex("cp_login_identities_provider_subject_uq").on(table.providerId, table.subject),
  index("cp_login_identities_user_idx").on(table.userId),
]);

export const roles = sqliteTable("cp_roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  system: integer("system", { mode: "boolean" }).notNull(),
  status: text("status", { enum: ["active", "archived"] }).notNull(),
  permissionIds: text("permission_ids", { mode: "json" }).$type<string[]>().notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("cp_roles_active_name_uq").on(sql`lower(${table.name})`).where(sql`${table.status} = 'active'`),
]);

export const grants = sqliteTable("cp_user_access_grants", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  nodeScope: text("node_scope", { mode: "json" }).$type<{ kind: "all" } | { kind: "selected"; nodeIds: string[] }>().notNull(),
  instanceScope: text("instance_scope", { mode: "json" }).$type<{ kind: "inherit-node-scope" } | { kind: "selected"; instanceIds: string[] }>().notNull(),
  authorizationRevision: integer("authorization_revision").notNull(),
  ...timestamps,
});

export const userRoles = sqliteTable("cp_user_roles", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "restrict" }),
}, (table) => [
  primaryKey({ columns: [table.userId, table.roleId] }),
  index("cp_user_roles_role_idx").on(table.roleId),
]);

export const sessions = sqliteTable("cp_user_sessions", {
  id: text("id").primaryKey(),
  identityId: text("identity_id").notNull().references(() => identities.id, { onDelete: "cascade" }),
  authorizationRevision: integer("authorization_revision").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at"),
  clientType: text("client_type", { enum: ["web", "mobile"] }).notNull(),
  device: text("device", { mode: "json" }).$type<{ id: string; name: string; platform: "ios" | "android"; appVersion?: string }>(),
  ...timestamps,
}, (table) => [
  uniqueIndex("cp_user_sessions_token_hash_uq").on(table.tokenHash),
  index("cp_user_sessions_identity_idx").on(table.identityId),
  index("cp_user_sessions_expiry_idx").on(table.expiresAt),
]);

export const providers = sqliteTable("cp_identity_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["oidc", "github"] }).notNull(),
  status: text("status", { enum: ["enabled", "disabled"] }).notNull(),
  loginPolicy: text("login_policy", { enum: ["existing-only", "admin-approved-create"] }).notNull(),
  issuer: text("issuer"),
  clientId: text("client_id").notNull(),
  clientSecretCiphertext: text("client_secret_ciphertext").notNull(),
  callbackUrl: text("callback_url").notNull(),
  ...timestamps,
});

export const approvals = sqliteTable("cp_external_identity_approvals", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  verifiedEmail: text("verified_email"),
  displayName: text("display_name"),
  status: text("status", { enum: ["pending", "approved", "rejected", "expired"] }).notNull(),
  expiresAt: text("expires_at").notNull(),
  decidedAt: text("decided_at"),
  decidedByUserId: text("decided_by_user_id").references(() => users.id),
  ...timestamps,
}, (table) => [index("cp_external_identity_approvals_lookup_idx").on(table.providerId, table.subject, table.status)]);

export const audit = sqliteTable("cp_user_audit", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  actorUserId: text("actor_user_id"),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  details: text("details", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("cp_user_audit_created_idx").on(table.createdAt)]);

export const migrationLedger = sqliteTable("cp_migration_ledger", {
  id: text("id").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: text("applied_at").notNull(),
  details: text("details", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});
