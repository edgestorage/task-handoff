import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const metadata = pgTable("cp_metadata", {
  key: text("key").primaryKey(), value: jsonb("value").notNull(),
});
export const users = pgTable("cp_users", {
  id: text("id").primaryKey(), displayName: text("display_name").notNull(), status: text("status").notNull(),
  lastLoginAt: text("last_login_at"), archivedAt: text("archived_at"), ...timestamps,
});
export const identities = pgTable("cp_login_identities", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), normalizedLoginName: text("normalized_login_name"), passwordHash: text("password_hash"),
  requiresPasswordChange: boolean("requires_password_change"), providerId: text("provider_id"), subject: text("subject"),
  verifiedEmail: text("verified_email"), lastUsedAt: text("last_used_at"), ...timestamps,
}, (table) => [uniqueIndex("cp_login_identities_login_name_uq").on(table.normalizedLoginName), uniqueIndex("cp_login_identities_provider_subject_uq").on(table.providerId, table.subject), index("cp_login_identities_user_idx").on(table.userId)]);
export const roles = pgTable("cp_roles", {
  id: text("id").primaryKey(), name: text("name").notNull(), description: text("description"), system: boolean("system").notNull(),
  status: text("status").notNull(), permissionIds: jsonb("permission_ids").$type<string[]>().notNull(), ...timestamps,
}, (table) => [
  uniqueIndex("cp_roles_active_name_uq").on(sql`lower(${table.name})`).where(sql`${table.status} = 'active'`),
]);
export const grants = pgTable("cp_user_access_grants", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  nodeScope: jsonb("node_scope").$type<{ kind: "all" } | { kind: "selected"; nodeIds: string[] }>().notNull(),
  instanceScope: jsonb("instance_scope").$type<{ kind: "inherit-node-scope" } | { kind: "selected"; instanceIds: string[] }>().notNull(),
  authorizationRevision: integer("authorization_revision").notNull(), ...timestamps,
});
export const userRoles = pgTable("cp_user_roles", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "restrict" }),
}, (table) => [primaryKey({ columns: [table.userId, table.roleId] }), index("cp_user_roles_role_idx").on(table.roleId)]);
export const sessions = pgTable("cp_user_sessions", {
  id: text("id").primaryKey(),
  identityId: text("identity_id").notNull().references(() => identities.id, { onDelete: "cascade" }), authorizationRevision: integer("authorization_revision").notNull(),
  tokenHash: text("token_hash").notNull(), expiresAt: text("expires_at").notNull(), lastSeenAt: text("last_seen_at"), clientType: text("client_type").notNull(),
  device: jsonb("device").$type<{ id: string; name: string; platform: "ios" | "android"; appVersion?: string }>(),
  clientInfo: jsonb("client_info").$type<{ name: string; platform: "darwin" | "linux" | "win32"; version?: string }>(), ...timestamps,
}, (table) => [uniqueIndex("cp_user_sessions_token_hash_uq").on(table.tokenHash), index("cp_user_sessions_identity_idx").on(table.identityId), index("cp_user_sessions_expiry_idx").on(table.expiresAt)]);
export const providers = pgTable("cp_identity_providers", {
  id: text("id").primaryKey(), name: text("name").notNull(), kind: text("kind").notNull(), status: text("status").notNull(),
  loginPolicy: text("login_policy").notNull(), issuer: text("issuer"), clientId: text("client_id").notNull(),
  clientSecretCiphertext: text("client_secret_ciphertext").notNull(), callbackUrl: text("callback_url").notNull(), ...timestamps,
});
export const approvals = pgTable("cp_external_identity_approvals", {
  id: text("id").primaryKey(), providerId: text("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }), subject: text("subject").notNull(),
  verifiedEmail: text("verified_email"), displayName: text("display_name"), status: text("status").notNull(), expiresAt: text("expires_at").notNull(),
  decidedAt: text("decided_at"), decidedByUserId: text("decided_by_user_id").references(() => users.id), ...timestamps,
}, (table) => [index("cp_external_identity_approvals_lookup_idx").on(table.providerId, table.subject, table.status)]);
export const audit = pgTable("cp_user_audit", {
  id: text("id").primaryKey(), action: text("action").notNull(), actorUserId: text("actor_user_id"), targetType: text("target_type").notNull(),
  targetId: text("target_id"), details: jsonb("details").$type<Record<string, unknown>>().notNull(), createdAt: text("created_at").notNull(),
}, (table) => [index("cp_user_audit_created_idx").on(table.createdAt)]);
export const migrationLedger = pgTable("cp_migration_ledger", {
  id: text("id").primaryKey(), checksum: text("checksum").notNull(), appliedAt: text("applied_at").notNull(), details: jsonb("details").$type<Record<string, unknown>>().notNull(),
});

export const nodes = pgTable("cp_nodes", {
  id: text("id").primaryKey(), name: text("name").notNull(), connectionMode: text("connection_mode").notNull(),
  connectionPath: jsonb("connection_path").notNull(), connectionEnabled: boolean("connection_enabled").notNull(),
  authMode: text("auth_mode").notNull(), authKeyId: text("auth_key_id"), authSecretCiphertext: text("auth_secret_ciphertext"),
  authPairedAt: text("auth_paired_at"), authPairingStatus: text("auth_pairing_status"), endpoint: text("endpoint"),
  controlEndpoint: text("control_endpoint"), containerEndpoint: text("container_endpoint"), publicWebBase: text("public_web_base"),
  labels: jsonb("labels").$type<Record<string, string>>().notNull(), ...timestamps,
});
export const pairingRevocations = pgTable("cp_node_pairing_revocations", {
  id: text("id").primaryKey(), endpoint: text("endpoint").notNull(), nodeId: text("node_id").notNull(), keyId: text("key_id").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(), pairedAt: text("paired_at").notNull(),
  phase: text("phase").notNull().default("pending-compensation"), ...timestamps,
}, (table) => [index("cp_node_pairing_revocations_node_idx").on(table.nodeId)]);
export const models = pgTable("cp_models", {
  id: text("id").primaryKey(), name: text("name").notNull(), endpoint: text("endpoint").notNull(), keyCiphertext: text("key_ciphertext").notNull(),
  model: text("model").notNull(), modelNames: jsonb("model_names").$type<Array<{ name: string; upstreamName?: string; order: number }>>().notNull(),
  mappings: jsonb("mappings").$type<Array<{ name: string; upstreamName: string; order: number }>>().notNull(),
  protocols: jsonb("protocols").$type<string[]>().notNull(), app: text("app").notNull(), enabled: boolean("enabled").notNull(),
  order: integer("display_order").notNull(), labels: jsonb("labels").$type<Record<string, string>>().notNull(), ...timestamps,
}, (table) => [index("cp_models_order_idx").on(table.order, table.name, table.id)]);
export const chatBridges = pgTable("cp_chat_bridges", {
  id: text("id").primaryKey(), channel: text("channel").notNull(), name: text("name").notNull(), enabled: boolean("enabled").notNull(),
  credentialCiphertext: text("credential_ciphertext"),
  credentialMetadata: jsonb("credential_metadata").$type<{ tokenSet: boolean; clientSecretSet: boolean; appSecretSet: boolean }>().notNull().default({ tokenSet: false, clientSecretSet: false, appSecretSet: false }),
  defaultChatId: text("default_chat_id"),
  allowedUserIds: jsonb("allowed_user_ids").$type<string[]>().notNull(), pollIntervalMs: integer("poll_interval_ms").notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(), ...timestamps,
});
export const chatSessions = pgTable("cp_chat_session_bindings", {
  id: text("id").primaryKey(), routeScope: text("route_scope").notNull(), channel: text("channel").notNull(),
  bridgeId: text("bridge_id").references(() => chatBridges.id, { onDelete: "cascade" }), chatSessionId: text("chat_session_id").notNull(),
  userId: text("user_id"), activeProjectId: text("active_project_id"), activeInstanceId: text("active_instance_id"),
  activeAiSessionId: text("active_ai_session_id"), lastUsedAt: text("last_used_at").notNull(), ...timestamps,
}, (table) => [uniqueIndex("cp_chat_session_bindings_route_uq").on(table.channel, table.routeScope, table.chatSessionId), index("cp_chat_session_bindings_bridge_idx").on(table.bridgeId)]);
export const gitCredentials = pgTable("cp_git_credentials", {
  id: text("id").primaryKey(), name: text("name").notNull(), kind: text("kind").notNull(), scope: jsonb("scope").notNull(),
  status: text("status").notNull(), revision: integer("revision").notNull(), secretCiphertext: text("secret_ciphertext").notNull(), ...timestamps,
});
export const gitAssignments = pgTable("cp_git_credential_assignments", {
  id: text("id").primaryKey(), instanceId: text("instance_id").notNull(),
  credentialId: text("credential_id").notNull().references(() => gitCredentials.id, { onDelete: "restrict" }),
  credentialRevision: integer("credential_revision").notNull(), assignmentRevision: integer("assignment_revision").notNull(),
  status: text("status").notNull(), authorizedAt: text("authorized_at").notNull(), ...timestamps,
}, (table) => [uniqueIndex("cp_git_credential_assignments_identity_uq").on(table.instanceId, table.credentialId), index("cp_git_credential_assignments_credential_idx").on(table.credentialId, table.status)]);
export const gitProvisioningIntents = pgTable("cp_git_provisioning_intents", {
  id: text("id").primaryKey(), instanceId: text("instance_id").notNull(),
  credentialId: text("credential_id").notNull().references(() => gitCredentials.id, { onDelete: "restrict" }),
  operationId: text("operation_id").notNull(), inputDigest: text("input_digest").notNull(), remoteUrl: text("remote_url").notNull(),
  ref: jsonb("ref").notNull(), clone: jsonb("clone").notNull(), ...timestamps,
}, (table) => [uniqueIndex("cp_git_provisioning_intents_operation_uq").on(table.instanceId, table.operationId), index("cp_git_provisioning_intents_credential_idx").on(table.credentialId)]);
export const gitAudit = pgTable("cp_git_audit", {
  id: text("id").primaryKey(), action: text("action").notNull(), credentialId: text("credential_id").notNull(), instanceId: text("instance_id"),
  credentialRevision: integer("credential_revision"), assignmentRevision: integer("assignment_revision"), ...timestamps,
}, (table) => [index("cp_git_audit_created_idx").on(table.createdAt)]);

export const cloudDevicePins = pgTable("cp_cloud_device_pins", {
  id: text("id").primaryKey(), bindingId: text("binding_id").notNull(), accountId: text("account_id").notNull(),
  ownerAccountId: text("owner_account_id").notNull(), accessMode: text("access_mode").notNull(),
  shareGrantId: text("share_grant_id"), shareRevision: integer("share_revision"), cloudAccessRoleId: text("cloud_access_role_id").notNull(),
  devicePublicKey: text("device_public_key").notNull(), reportedName: text("reported_name").notNull(), clientKind: text("client_kind").notNull(),
  clientPlatform: text("client_platform").notNull(), clientVersion: text("client_version"), roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "restrict" }),
  status: text("status").notNull(), label: text("label"), approvedByActorType: text("approved_by_actor_type").notNull(),
  approvedByActorId: text("approved_by_actor_id").notNull(), approvedAt: text("approved_at").notNull(), lastSeenAt: text("last_seen_at").notNull(),
  revokedAt: text("revoked_at"), revokeReason: text("revoke_reason"), authorizationRevision: bigint("authorization_revision", { mode: "number" }).notNull(),
  revision: integer("revision").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("cp_cloud_device_pins_active_context_uq").on(
    table.bindingId, table.accountId, table.ownerAccountId, table.accessMode,
    sql`coalesce(${table.shareGrantId}, '')`, table.cloudAccessRoleId, table.devicePublicKey,
  ).where(sql`${table.status} = 'active'`),
  index("cp_cloud_device_pins_binding_idx").on(table.bindingId, table.status),
  index("cp_cloud_device_pins_device_idx").on(table.devicePublicKey),
]);

export const cloudDeviceTrustRequests = pgTable("cp_cloud_device_trust_requests", {
  id: text("id").primaryKey(), bindingId: text("binding_id").notNull(), accountId: text("account_id").notNull(),
  ownerAccountId: text("owner_account_id").notNull(), accessMode: text("access_mode").notNull(),
  shareGrantId: text("share_grant_id"), shareRevision: integer("share_revision"), cloudAccessRoleId: text("cloud_access_role_id").notNull(),
  devicePublicKey: text("device_public_key").notNull(), reportedName: text("reported_name").notNull(), clientKind: text("client_kind").notNull(),
  clientPlatform: text("client_platform").notNull(), clientVersion: text("client_version"), status: text("status").notNull(), reason: text("reason").notNull(),
  requestedAt: text("requested_at").notNull(), lastSeenAt: text("last_seen_at").notNull(), expiresAt: text("expires_at").notNull(),
  decidedAt: text("decided_at"), decidedByActorType: text("decided_by_actor_type"), decidedByActorId: text("decided_by_actor_id"),
  decidedRoleId: text("decided_role_id").references(() => roles.id, { onDelete: "restrict" }), decisionReason: text("decision_reason"),
  approvedPinId: text("approved_pin_id").references(() => cloudDevicePins.id, { onDelete: "set null" }), revision: integer("revision").notNull(), ...timestamps,
}, (table) => [
  uniqueIndex("cp_cloud_device_trust_requests_pending_context_uq").on(
    table.bindingId, table.accountId, table.ownerAccountId, table.accessMode,
    sql`coalesce(${table.shareGrantId}, '')`, table.cloudAccessRoleId, table.devicePublicKey,
  ).where(sql`${table.status} = 'pending'`),
  index("cp_cloud_device_trust_requests_pending_idx").on(table.bindingId, table.status, table.expiresAt),
  index("cp_cloud_device_trust_requests_device_idx").on(table.devicePublicKey),
]);

export const cloudDeviceTrustAudit = pgTable("cp_cloud_device_trust_audit", {
  id: text("id").primaryKey(), action: text("action").notNull(), bindingId: text("binding_id").notNull(),
  requestId: text("request_id"), pinId: text("pin_id"), accountId: text("account_id").notNull(),
  devicePublicKey: text("device_public_key").notNull(), deviceFingerprint: text("device_fingerprint").notNull(),
  actorType: text("actor_type").notNull(), actorId: text("actor_id").notNull(), actorRoleId: text("actor_role_id"),
  reason: text("reason"), details: jsonb("details").$type<Record<string, unknown>>().notNull(), createdAt: text("created_at").notNull(),
}, (table) => [
  index("cp_cloud_device_trust_audit_created_idx").on(table.createdAt),
  index("cp_cloud_device_trust_audit_binding_idx").on(table.bindingId, table.createdAt),
]);

export const cloudDeviceTrustRevisions = pgTable("cp_cloud_device_trust_revisions", {
  bindingId: text("binding_id").primaryKey(),
  revision: bigint("revision", { mode: "number" }).notNull(),
});
