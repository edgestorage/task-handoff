import { controlPlaneDatabaseMigration as migration } from "../../persistence/database/migrations.ts";
export type { ControlPlaneDatabaseMigration } from "../../persistence/database/migrations.ts";

const sqliteInitial = `
CREATE TABLE cp_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE cp_users (
  id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','disabled','archived')),
  last_login_at TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_login_identities (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES cp_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('local-password','oidc','oauth')), normalized_login_name TEXT, password_hash TEXT,
  requires_password_change INTEGER, provider_id TEXT, subject TEXT, verified_email TEXT, last_used_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_login_identities_login_name_uq ON cp_login_identities(normalized_login_name);
CREATE UNIQUE INDEX cp_login_identities_provider_subject_uq ON cp_login_identities(provider_id, subject);
CREATE INDEX cp_login_identities_user_idx ON cp_login_identities(user_id);
CREATE TABLE cp_roles (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, system INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','archived')), permission_ids TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_roles_active_name_uq ON cp_roles(lower(name)) WHERE status = 'active';
CREATE TABLE cp_user_access_grants (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES cp_users(id) ON DELETE CASCADE,
  node_scope TEXT NOT NULL,
  instance_scope TEXT NOT NULL, authorization_revision INTEGER NOT NULL CHECK(authorization_revision > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_user_roles (
  user_id TEXT NOT NULL REFERENCES cp_users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES cp_roles(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX cp_user_roles_role_idx ON cp_user_roles(role_id);
CREATE TABLE cp_user_sessions (
  id TEXT PRIMARY KEY NOT NULL, identity_id TEXT NOT NULL REFERENCES cp_login_identities(id) ON DELETE CASCADE,
  authorization_revision INTEGER NOT NULL,
  token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT, client_type TEXT NOT NULL CHECK(client_type IN ('web','mobile')),
  device TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_user_sessions_token_hash_uq ON cp_user_sessions(token_hash);
CREATE INDEX cp_user_sessions_identity_idx ON cp_user_sessions(identity_id);
CREATE INDEX cp_user_sessions_expiry_idx ON cp_user_sessions(expires_at);
CREATE TABLE cp_identity_providers (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('oidc','github')),
  status TEXT NOT NULL CHECK(status IN ('enabled','disabled')), login_policy TEXT NOT NULL,
  issuer TEXT, client_id TEXT NOT NULL, client_secret_ciphertext TEXT NOT NULL, callback_url TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_external_identity_approvals (
  id TEXT PRIMARY KEY NOT NULL, provider_id TEXT NOT NULL REFERENCES cp_identity_providers(id) ON DELETE CASCADE,
  subject TEXT NOT NULL, verified_email TEXT, display_name TEXT, status TEXT NOT NULL, expires_at TEXT NOT NULL,
  decided_at TEXT, decided_by_user_id TEXT REFERENCES cp_users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX cp_external_identity_approvals_lookup_idx ON cp_external_identity_approvals(provider_id, subject, status);
CREATE TABLE cp_user_audit (
  id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, actor_user_id TEXT, target_type TEXT NOT NULL,
  target_id TEXT, details TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX cp_user_audit_created_idx ON cp_user_audit(created_at);
`;

const postgresqlInitial = `
CREATE TABLE cp_metadata (key TEXT PRIMARY KEY NOT NULL, value JSONB NOT NULL);
CREATE TABLE cp_users (
  id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','disabled','archived')),
  last_login_at TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_login_identities (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES cp_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('local-password','oidc','oauth')), normalized_login_name TEXT, password_hash TEXT,
  requires_password_change BOOLEAN, provider_id TEXT, subject TEXT, verified_email TEXT, last_used_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_login_identities_login_name_uq ON cp_login_identities(normalized_login_name);
CREATE UNIQUE INDEX cp_login_identities_provider_subject_uq ON cp_login_identities(provider_id, subject);
CREATE INDEX cp_login_identities_user_idx ON cp_login_identities(user_id);
CREATE TABLE cp_roles (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT, system BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','archived')), permission_ids JSONB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_roles_active_name_uq ON cp_roles(lower(name)) WHERE status = 'active';
CREATE TABLE cp_user_access_grants (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES cp_users(id) ON DELETE CASCADE,
  node_scope JSONB NOT NULL,
  instance_scope JSONB NOT NULL, authorization_revision INTEGER NOT NULL CHECK(authorization_revision > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_user_roles (
  user_id TEXT NOT NULL REFERENCES cp_users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES cp_roles(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX cp_user_roles_role_idx ON cp_user_roles(role_id);
CREATE TABLE cp_user_sessions (
  id TEXT PRIMARY KEY NOT NULL, identity_id TEXT NOT NULL REFERENCES cp_login_identities(id) ON DELETE CASCADE,
  authorization_revision INTEGER NOT NULL,
  token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT, client_type TEXT NOT NULL CHECK(client_type IN ('web','mobile')),
  device JSONB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_user_sessions_token_hash_uq ON cp_user_sessions(token_hash);
CREATE INDEX cp_user_sessions_identity_idx ON cp_user_sessions(identity_id);
CREATE INDEX cp_user_sessions_expiry_idx ON cp_user_sessions(expires_at);
CREATE TABLE cp_identity_providers (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('oidc','github')),
  status TEXT NOT NULL CHECK(status IN ('enabled','disabled')), login_policy TEXT NOT NULL,
  issuer TEXT, client_id TEXT NOT NULL, client_secret_ciphertext TEXT NOT NULL, callback_url TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_external_identity_approvals (
  id TEXT PRIMARY KEY NOT NULL, provider_id TEXT NOT NULL REFERENCES cp_identity_providers(id) ON DELETE CASCADE,
  subject TEXT NOT NULL, verified_email TEXT, display_name TEXT, status TEXT NOT NULL, expires_at TEXT NOT NULL,
  decided_at TEXT, decided_by_user_id TEXT REFERENCES cp_users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX cp_external_identity_approvals_lookup_idx ON cp_external_identity_approvals(provider_id, subject, status);
CREATE TABLE cp_user_audit (
  id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, actor_user_id TEXT, target_type TEXT NOT NULL,
  target_id TEXT, details JSONB NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX cp_user_audit_created_idx ON cp_user_audit(created_at);
`;

const sqliteP0Persistence = `
CREATE TABLE cp_nodes (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, connection_mode TEXT NOT NULL,
  connection_path TEXT NOT NULL, connection_enabled INTEGER NOT NULL,
  auth_mode TEXT NOT NULL, auth_key_id TEXT, auth_secret_ciphertext TEXT, auth_paired_at TEXT, auth_pairing_status TEXT,
  endpoint TEXT, control_endpoint TEXT, container_endpoint TEXT, public_web_base TEXT, labels TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_node_pairing_revocations (
  id TEXT PRIMARY KEY NOT NULL, endpoint TEXT NOT NULL, node_id TEXT NOT NULL, key_id TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL, paired_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX cp_node_pairing_revocations_node_idx ON cp_node_pairing_revocations(node_id);
CREATE TABLE cp_models (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, endpoint TEXT NOT NULL, key_ciphertext TEXT NOT NULL,
  model TEXT NOT NULL, model_names TEXT NOT NULL, protocols TEXT NOT NULL, app TEXT NOT NULL,
  enabled INTEGER NOT NULL, display_order INTEGER NOT NULL, labels TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX cp_models_order_idx ON cp_models(display_order, name, id);
CREATE TABLE cp_chat_bridges (
  id TEXT PRIMARY KEY NOT NULL, channel TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL,
  credential_ciphertext TEXT, default_chat_id TEXT, allowed_user_ids TEXT NOT NULL, poll_interval_ms INTEGER NOT NULL,
  settings TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_chat_session_bindings (
  id TEXT PRIMARY KEY NOT NULL, route_scope TEXT NOT NULL, channel TEXT NOT NULL,
  bridge_id TEXT REFERENCES cp_chat_bridges(id) ON DELETE CASCADE, chat_session_id TEXT NOT NULL,
  user_id TEXT, active_project_id TEXT, active_instance_id TEXT, active_ai_session_id TEXT, last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_chat_session_bindings_route_uq ON cp_chat_session_bindings(channel, route_scope, chat_session_id);
CREATE INDEX cp_chat_session_bindings_bridge_idx ON cp_chat_session_bindings(bridge_id);
CREATE TABLE cp_git_credentials (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0), secret_ciphertext TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_git_credential_assignments (
  id TEXT PRIMARY KEY NOT NULL, instance_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES cp_git_credentials(id) ON DELETE RESTRICT,
  credential_revision INTEGER NOT NULL CHECK(credential_revision >= 0), assignment_revision INTEGER NOT NULL CHECK(assignment_revision >= 0),
  status TEXT NOT NULL, authorized_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_git_credential_assignments_identity_uq ON cp_git_credential_assignments(instance_id, credential_id);
CREATE INDEX cp_git_credential_assignments_credential_idx ON cp_git_credential_assignments(credential_id, status);
CREATE TABLE cp_git_provisioning_intents (
  id TEXT PRIMARY KEY NOT NULL, instance_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES cp_git_credentials(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL, input_digest TEXT NOT NULL, remote_url TEXT NOT NULL, ref TEXT NOT NULL, clone TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_git_provisioning_intents_operation_uq ON cp_git_provisioning_intents(instance_id, operation_id);
CREATE INDEX cp_git_provisioning_intents_credential_idx ON cp_git_provisioning_intents(credential_id);
CREATE TABLE cp_git_audit (
  id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, credential_id TEXT NOT NULL, instance_id TEXT,
  credential_revision INTEGER, assignment_revision INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX cp_git_audit_created_idx ON cp_git_audit(created_at);
`;

const postgresqlP0Persistence = `
CREATE TABLE cp_nodes (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, connection_mode TEXT NOT NULL,
  connection_path JSONB NOT NULL, connection_enabled BOOLEAN NOT NULL,
  auth_mode TEXT NOT NULL, auth_key_id TEXT, auth_secret_ciphertext TEXT, auth_paired_at TEXT, auth_pairing_status TEXT,
  endpoint TEXT, control_endpoint TEXT, container_endpoint TEXT, public_web_base TEXT, labels JSONB NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_node_pairing_revocations (
  id TEXT PRIMARY KEY NOT NULL, endpoint TEXT NOT NULL, node_id TEXT NOT NULL, key_id TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL, paired_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX cp_node_pairing_revocations_node_idx ON cp_node_pairing_revocations(node_id);
CREATE TABLE cp_models (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, endpoint TEXT NOT NULL, key_ciphertext TEXT NOT NULL,
  model TEXT NOT NULL, model_names JSONB NOT NULL, protocols JSONB NOT NULL, app TEXT NOT NULL,
  enabled BOOLEAN NOT NULL, display_order INTEGER NOT NULL, labels JSONB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX cp_models_order_idx ON cp_models(display_order, name, id);
CREATE TABLE cp_chat_bridges (
  id TEXT PRIMARY KEY NOT NULL, channel TEXT NOT NULL, name TEXT NOT NULL, enabled BOOLEAN NOT NULL,
  credential_ciphertext TEXT, default_chat_id TEXT, allowed_user_ids JSONB NOT NULL, poll_interval_ms INTEGER NOT NULL,
  settings JSONB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_chat_session_bindings (
  id TEXT PRIMARY KEY NOT NULL, route_scope TEXT NOT NULL, channel TEXT NOT NULL,
  bridge_id TEXT REFERENCES cp_chat_bridges(id) ON DELETE CASCADE, chat_session_id TEXT NOT NULL,
  user_id TEXT, active_project_id TEXT, active_instance_id TEXT, active_ai_session_id TEXT, last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_chat_session_bindings_route_uq ON cp_chat_session_bindings(channel, route_scope, chat_session_id);
CREATE INDEX cp_chat_session_bindings_bridge_idx ON cp_chat_session_bindings(bridge_id);
CREATE TABLE cp_git_credentials (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, scope JSONB NOT NULL, status TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0), secret_ciphertext TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cp_git_credential_assignments (
  id TEXT PRIMARY KEY NOT NULL, instance_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES cp_git_credentials(id) ON DELETE RESTRICT,
  credential_revision INTEGER NOT NULL CHECK(credential_revision >= 0), assignment_revision INTEGER NOT NULL CHECK(assignment_revision >= 0),
  status TEXT NOT NULL, authorized_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_git_credential_assignments_identity_uq ON cp_git_credential_assignments(instance_id, credential_id);
CREATE INDEX cp_git_credential_assignments_credential_idx ON cp_git_credential_assignments(credential_id, status);
CREATE TABLE cp_git_provisioning_intents (
  id TEXT PRIMARY KEY NOT NULL, instance_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES cp_git_credentials(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL, input_digest TEXT NOT NULL, remote_url TEXT NOT NULL, ref JSONB NOT NULL, clone JSONB NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cp_git_provisioning_intents_operation_uq ON cp_git_provisioning_intents(instance_id, operation_id);
CREATE INDEX cp_git_provisioning_intents_credential_idx ON cp_git_provisioning_intents(credential_id);
CREATE TABLE cp_git_audit (
  id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, credential_id TEXT NOT NULL, instance_id TEXT,
  credential_revision INTEGER, assignment_revision INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX cp_git_audit_created_idx ON cp_git_audit(created_at);
`;

export const sqliteMigrations = [
  migration("0001_user_access", sqliteInitial),
  migration("0002_p0_persistence", sqliteP0Persistence),
  migration("0003_p0_pairing_revoke_phase", "ALTER TABLE cp_node_pairing_revocations ADD COLUMN phase TEXT NOT NULL DEFAULT 'pending-compensation';"),
  migration("0004_p0_chat_credential_metadata", `ALTER TABLE cp_chat_bridges ADD COLUMN credential_metadata TEXT NOT NULL DEFAULT '{"tokenSet":false,"clientSecretSet":false,"appSecretSet":false}';`),
];
export const postgresqlMigrations = [
  migration("0001_user_access", postgresqlInitial),
  migration("0002_p0_persistence", postgresqlP0Persistence),
  migration("0003_p0_pairing_revoke_phase", "ALTER TABLE cp_node_pairing_revocations ADD COLUMN phase TEXT NOT NULL DEFAULT 'pending-compensation';"),
  migration("0004_p0_chat_credential_metadata", `ALTER TABLE cp_chat_bridges ADD COLUMN credential_metadata JSONB NOT NULL DEFAULT '{"tokenSet":false,"clientSecretSet":false,"appSecretSet":false}'::jsonb;`),
];
