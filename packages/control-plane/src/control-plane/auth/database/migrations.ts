import crypto from "node:crypto";

export type ControlPlaneDatabaseMigration = { id: string; checksum: string; sql: string };

function migration(id: string, sql: string): ControlPlaneDatabaseMigration {
  return { id, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
}

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

export const sqliteMigrations = [
  migration("0001_user_access", sqliteInitial),
];
export const postgresqlMigrations = [
  migration("0001_user_access", postgresqlInitial),
];
