import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const metadata = pgTable("control_plane_metadata", {
  key: text("key").primaryKey(), value: jsonb("value").notNull(),
});
export const users = pgTable("control_plane_users", {
  id: text("id").primaryKey(), displayName: text("display_name").notNull(), status: text("status").notNull(),
  lastLoginAt: text("last_login_at"), archivedAt: text("archived_at"), ...timestamps,
});
export const identities = pgTable("control_plane_login_identities", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), normalizedLoginName: text("normalized_login_name"), passwordHash: text("password_hash"),
  requiresPasswordChange: boolean("requires_password_change"), providerId: text("provider_id"), subject: text("subject"),
  verifiedEmail: text("verified_email"), lastUsedAt: text("last_used_at"), ...timestamps,
}, (table) => [uniqueIndex("cp_identity_login_name_uq").on(table.normalizedLoginName), uniqueIndex("cp_identity_provider_subject_uq").on(table.providerId, table.subject), index("cp_identity_user_idx").on(table.userId)]);
export const roles = pgTable("control_plane_roles", {
  id: text("id").primaryKey(), name: text("name").notNull(), description: text("description"), system: boolean("system").notNull(),
  status: text("status").notNull(), permissionIds: jsonb("permission_ids").$type<string[]>().notNull(), ...timestamps,
}, (table) => [uniqueIndex("cp_role_active_name_uq").on(table.name, table.status)]);
export const grants = pgTable("control_plane_user_access_grants", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleIds: jsonb("role_ids").$type<string[]>().notNull(), nodeScope: jsonb("node_scope").$type<{ kind: "all" } | { kind: "selected"; nodeIds: string[] }>().notNull(),
  authorizationRevision: integer("authorization_revision").notNull(), ...timestamps,
}, (table) => [uniqueIndex("cp_grant_user_uq").on(table.userId)]);
export const sessions = pgTable("control_plane_user_sessions", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  identityId: text("identity_id").notNull().references(() => identities.id, { onDelete: "cascade" }), authorizationRevision: integer("authorization_revision").notNull(),
  tokenHash: text("token_hash").notNull(), expiresAt: text("expires_at").notNull(), lastSeenAt: text("last_seen_at"), clientType: text("client_type").notNull(),
  device: jsonb("device").$type<{ id: string; name: string; platform: "ios" | "android"; appVersion?: string }>(), ...timestamps,
}, (table) => [uniqueIndex("cp_session_token_hash_uq").on(table.tokenHash), index("cp_session_user_idx").on(table.userId), index("cp_session_expiry_idx").on(table.expiresAt)]);
export const providers = pgTable("control_plane_identity_providers", {
  id: text("id").primaryKey(), name: text("name").notNull(), kind: text("kind").notNull(), status: text("status").notNull(),
  loginPolicy: text("login_policy").notNull(), issuer: text("issuer"), clientId: text("client_id").notNull(),
  clientSecretCiphertext: text("client_secret_ciphertext").notNull(), callbackUrl: text("callback_url").notNull(), ...timestamps,
});
export const approvals = pgTable("control_plane_external_identity_approvals", {
  id: text("id").primaryKey(), providerId: text("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }), subject: text("subject").notNull(),
  verifiedEmail: text("verified_email"), displayName: text("display_name"), status: text("status").notNull(), expiresAt: text("expires_at").notNull(),
  decidedAt: text("decided_at"), decidedByUserId: text("decided_by_user_id").references(() => users.id), ...timestamps,
}, (table) => [index("cp_approval_lookup_idx").on(table.providerId, table.subject, table.status)]);
export const audit = pgTable("control_plane_user_audit", {
  id: text("id").primaryKey(), action: text("action").notNull(), actorUserId: text("actor_user_id"), targetType: text("target_type").notNull(),
  targetId: text("target_id"), details: jsonb("details").$type<Record<string, unknown>>().notNull(), createdAt: text("created_at").notNull(),
}, (table) => [index("cp_audit_created_idx").on(table.createdAt)]);
export const migrationLedger = pgTable("control_plane_migration_ledger", {
  id: text("id").primaryKey(), checksum: text("checksum").notNull(), appliedAt: text("applied_at").notNull(), details: jsonb("details").$type<Record<string, unknown>>().notNull(),
});
