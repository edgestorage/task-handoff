import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

type JsonObject = Record<string, unknown>;

export const nodeIdentity = sqliteTable("na_node_identity", {
  singletonKey: integer("singleton_key").primaryKey().default(1),
  nodeId: text("node_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("na_node_identity_singleton_check", sql`${table.singletonKey} = 1`),
  uniqueIndex("na_node_identity_node_uq").on(table.nodeId),
]);

export const localFolders = sqliteTable("na_local_folders", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull().references(() => nodeIdentity.nodeId, { onDelete: "restrict", onUpdate: "cascade" }),
  name: text("name").notNull(),
  path: text("path").notNull(),
  labels: text("labels_json", { mode: "json" }).$type<Record<string, string>>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("na_local_folders_node_path_uq").on(table.nodeId, table.path)]);

export const runtimes = sqliteTable("na_runtimes", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull().references(() => nodeIdentity.nodeId, { onDelete: "restrict", onUpdate: "cascade" }),
  name: text("name").notNull(),
  type: text("type", { enum: ["docker", "kubernetes", "local"] }).notNull(),
  status: text("status", { enum: ["unknown", "online", "offline", "degraded"] }).notNull(),
  accessStrategy: text("access_strategy").notNull(),
  capabilities: text("capabilities_json", { mode: "json" }).$type<JsonObject>().notNull(),
  labels: text("labels_json", { mode: "json" }).$type<Record<string, string>>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("na_runtimes_node_type_idx").on(table.nodeId, table.type)]);

export const instances = sqliteTable("na_instances", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull().references(() => nodeIdentity.nodeId, { onDelete: "restrict", onUpdate: "cascade" }),
  runtimeId: text("runtime_id").notNull().references(() => runtimes.id, { onDelete: "restrict", onUpdate: "cascade" }),
  sourceLocalFolderId: text("source_local_folder_id").references(() => localFolders.id, { onDelete: "set null", onUpdate: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull(),
  stateRevision: integer("state_revision").notNull().default(0),
  processIncarnationId: text("process_incarnation_id"),
  registrationCredential: text("registration_credential"),
  desired: text("desired_json", { mode: "json" }).$type<JsonObject>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("na_instances_state_revision_check", sql`${table.stateRevision} >= 0`),
  index("na_instances_runtime_idx").on(table.runtimeId),
  index("na_instances_status_idx").on(table.status, table.updatedAt),
]);

export const instanceObservations = sqliteTable("na_instance_observations", {
  instanceId: text("instance_id").primaryKey().references(() => instances.id, { onDelete: "cascade", onUpdate: "cascade" }),
  health: text("health").notNull(),
  connectionStatus: text("connection_status").notNull(),
  ready: integer("ready", { mode: "boolean" }).notNull(),
  observed: text("observed_json", { mode: "json" }).$type<JsonObject>().notNull(),
  lastHeartbeatAt: text("last_heartbeat_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("na_instance_observations_connection_idx").on(table.connectionStatus, table.updatedAt)]);

export const models = sqliteTable("na_models", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  endpoint: text("endpoint").notNull(),
  key: text("key").notNull(),
  model: text("model").notNull(),
  app: text("app", { enum: ["codex", "claude", "opencode"] }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  displayOrder: integer("display_order").notNull(),
  modelNames: text("model_names_json", { mode: "json" }).$type<unknown[]>().notNull(),
  protocols: text("protocols_json", { mode: "json" }).$type<string[]>().notNull(),
  labels: text("labels_json", { mode: "json" }).$type<Record<string, string>>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("na_models_order_idx").on(table.displayOrder, table.id)]);

export const modelAssignments = sqliteTable("na_instance_model_assignments", {
  instanceId: text("instance_id").primaryKey().references(() => instances.id, { onDelete: "cascade", onUpdate: "cascade" }),
  legacyCodexModelId: text("legacy_codex_model_id").references(() => models.id, { onDelete: "restrict", onUpdate: "cascade" }),
  legacyClaudeModelId: text("legacy_claude_model_id").references(() => models.id, { onDelete: "restrict", onUpdate: "cascade" }),
  legacyOpencodeModelId: text("legacy_opencode_model_id").references(() => models.id, { onDelete: "restrict", onUpdate: "cascade" }),
  updatedAt: text("updated_at").notNull(),
});

export const modelAssignmentEntities = sqliteTable("na_instance_model_entities", {
  instanceId: text("instance_id").notNull().references(() => modelAssignments.instanceId, { onDelete: "cascade", onUpdate: "cascade" }),
  modelId: text("model_id").notNull().references(() => models.id, { onDelete: "restrict", onUpdate: "cascade" }),
  displayOrder: integer("display_order").notNull(),
}, (table) => [
  primaryKey({ columns: [table.instanceId, table.modelId] }),
  uniqueIndex("na_instance_model_entities_order_uq").on(table.instanceId, table.displayOrder),
]);

export const controlPlanePairings = sqliteTable("na_control_plane_pairings", {
  keyId: text("key_id").primaryKey(),
  controlPlaneId: text("control_plane_id").notNull(),
  name: text("name"),
  secret: text("secret").notNull(),
  pairedAt: text("paired_at").notNull(),
  revokedAt: text("revoked_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("na_control_plane_pairings_control_plane_uq").on(table.controlPlaneId)]);

export const controlPlaneConnections = sqliteTable("na_control_plane_connections", {
  id: text("id").primaryKey(),
  pairingKeyId: text("pairing_key_id").notNull().references(() => controlPlanePairings.keyId, { onDelete: "restrict", onUpdate: "cascade" }),
  name: text("name"),
  normalizedUrl: text("normalized_url").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("na_control_plane_connections_url_uq").on(table.normalizedUrl)]);

export const controlPlaneConnectionOperations = sqliteTable("na_control_plane_connection_operations", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  phase: text("phase", { enum: ["prepared", "remote-accepted", "committed", "failed"] }).notNull(),
  requested: text("requested_json", { mode: "json" }).$type<JsonObject>().notNull(),
  pairingKeyId: text("pairing_key_id"),
  connectionId: text("connection_id"),
  replacedConnections: text("replaced_connections_json", { mode: "json" }).$type<JsonObject[]>().notNull(),
  error: text("error_json", { mode: "json" }).$type<JsonObject>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("na_control_plane_connection_operations_phase_idx").on(table.phase, table.updatedAt)]);

export const gitCredentialPayloads = sqliteTable("na_git_credential_payloads", {
  credentialId: text("credential_id").primaryKey(),
  revision: integer("revision").notNull(),
  publicData: text("public_json", { mode: "json" }).$type<JsonObject>().notNull(),
  secret: text("secret_json", { mode: "json" }).$type<JsonObject>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [check("na_git_credential_payloads_revision_check", sql`${table.revision} >= 0`)]);

export const gitAuthorizationSets = sqliteTable("na_git_authorization_sets", {
  instanceId: text("instance_id").primaryKey().references(() => instances.id, { onDelete: "cascade", onUpdate: "cascade" }),
  generation: integer("generation").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [check("na_git_authorization_sets_generation_check", sql`${table.generation} >= 0`)]);

export const gitAuthorizationMembers = sqliteTable("na_git_authorization_members", {
  instanceId: text("instance_id").notNull(),
  credentialId: text("credential_id").notNull().references(() => gitCredentialPayloads.credentialId, { onDelete: "restrict", onUpdate: "cascade" }),
  displayOrder: integer("display_order").notNull(),
}, (table) => [
  foreignKey({ columns: [table.instanceId], foreignColumns: [gitAuthorizationSets.instanceId], name: "na_git_authorization_members_set_fk" }).onDelete("cascade").onUpdate("cascade"),
  primaryKey({ columns: [table.instanceId, table.credentialId] }),
  uniqueIndex("na_git_authorization_members_order_uq").on(table.instanceId, table.displayOrder),
]);

export const gitWorkspaceProvisioning = sqliteTable("na_git_workspace_provisioning", {
  instanceId: text("instance_id").primaryKey().references(() => instances.id, { onDelete: "cascade", onUpdate: "cascade" }),
  status: text("status", { enum: ["pending", "consumed"] }).notNull(),
  operationId: text("operation_id").notNull(),
  input: text("input_json", { mode: "json" }).$type<JsonObject>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [
  check("na_git_workspace_provisioning_input_check", sql`(${table.status} = 'pending' AND ${table.input} IS NOT NULL) OR (${table.status} = 'consumed' AND ${table.input} IS NULL)`),
  index("na_git_workspace_provisioning_expiry_idx").on(table.expiresAt),
]);
