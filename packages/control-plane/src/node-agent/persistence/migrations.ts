import crypto from "node:crypto";

export type NodeAgentMigration = { id: string; checksum: string; sql: string };

function migration(id: string, sql: string): NodeAgentMigration {
  return { id, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
}

const initialStoryDomain = `
CREATE TABLE na_stories (
  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
  max_idle_ai_sessions INTEGER NOT NULL DEFAULT 5 CHECK(max_idle_ai_sessions BETWEEN 1 AND 50),
  next_document_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_document_sequence > 0)
);
CREATE INDEX na_stories_created_idx ON na_stories(created_at);
CREATE TABLE na_story_actions (
  story_id TEXT NOT NULL REFERENCES na_stories(id) ON DELETE CASCADE, id TEXT NOT NULL,
  title TEXT NOT NULL, prompt_template TEXT NOT NULL, target_instance_id TEXT,
  session_preset_json TEXT, display_order INTEGER NOT NULL,
  PRIMARY KEY(story_id, id)
);
CREATE INDEX na_story_actions_order_idx ON na_story_actions(story_id, display_order, id);
CREATE TABLE na_story_documents (
  story_id TEXT NOT NULL REFERENCES na_stories(id) ON DELETE CASCADE, story_path TEXT NOT NULL,
  title TEXT NOT NULL, indexed_sequence INTEGER NOT NULL CHECK(indexed_sequence > 0), display_order INTEGER NOT NULL,
  PRIMARY KEY(story_id, story_path)
);
CREATE UNIQUE INDEX na_story_documents_sequence_uq ON na_story_documents(story_id, indexed_sequence);
CREATE INDEX na_story_documents_page_idx ON na_story_documents(story_id, indexed_sequence, story_path);
CREATE INDEX na_story_documents_display_idx ON na_story_documents(story_id, display_order, story_path);
CREATE TABLE na_story_automations (
  id TEXT PRIMARY KEY NOT NULL, story_id TEXT NOT NULL, action_id TEXT NOT NULL,
  schedule_json TEXT NOT NULL, enabled INTEGER NOT NULL, policy_json TEXT NOT NULL,
  schedule_anchor_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CONSTRAINT na_story_automations_action_fk FOREIGN KEY(story_id, action_id)
    REFERENCES na_story_actions(story_id, id) ON DELETE RESTRICT
);
CREATE INDEX na_story_automations_story_idx ON na_story_automations(story_id);
CREATE INDEX na_story_automations_enabled_idx ON na_story_automations(enabled);
CREATE TABLE na_story_automation_runs (
  id TEXT PRIMARY KEY NOT NULL, automation_id TEXT NOT NULL REFERENCES na_story_automations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('manual','schedule')),
  status TEXT NOT NULL CHECK(status IN ('queued','dispatching','running','completed','failed','skipped')),
  scheduled_for TEXT NOT NULL, target_instance_id TEXT NOT NULL, ai_session_id TEXT, error_json TEXT,
  queued_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
  execution_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL, execution_input_json TEXT NOT NULL
);
CREATE UNIQUE INDEX na_story_automation_runs_execution_key_uq ON na_story_automation_runs(execution_key);
CREATE INDEX na_story_automation_runs_automation_time_idx ON na_story_automation_runs(automation_id, queued_at);
CREATE INDEX na_story_automation_runs_status_idx ON na_story_automation_runs(status, scheduled_for);
CREATE TABLE na_story_file_mutations (
  id TEXT PRIMARY KEY NOT NULL, story_id TEXT NOT NULL REFERENCES na_stories(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK(operation IN ('write','rename','delete')), story_path TEXT NOT NULL,
  next_story_path TEXT, title TEXT, temporary_name TEXT, backup_name TEXT,
  phase TEXT NOT NULL CHECK(phase IN ('receiving','prepared','files-staged','database-committed','cleanup')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX na_story_file_mutations_story_idx ON na_story_file_mutations(story_id, created_at);
CREATE TABLE na_story_deletion_intents (
  story_id TEXT PRIMARY KEY NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','files-staged','database-committed','cleanup')),
  trash_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

const p0StateDomains = `
CREATE TABLE na_node_identity (
  singleton_key INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK(singleton_key = 1),
  node_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE na_local_folders (
  id TEXT PRIMARY KEY NOT NULL, node_id TEXT NOT NULL REFERENCES na_node_identity(node_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  name TEXT NOT NULL, path TEXT NOT NULL, labels_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(node_id, path)
);
CREATE TABLE na_runtimes (
  id TEXT PRIMARY KEY NOT NULL, node_id TEXT NOT NULL REFERENCES na_node_identity(node_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('docker','kubernetes','local')),
  status TEXT NOT NULL CHECK(status IN ('unknown','online','offline','degraded')), access_strategy TEXT NOT NULL,
  capabilities_json TEXT NOT NULL, labels_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX na_runtimes_node_type_idx ON na_runtimes(node_id, type);
CREATE TABLE na_instances (
  id TEXT PRIMARY KEY NOT NULL, node_id TEXT NOT NULL REFERENCES na_node_identity(node_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  runtime_id TEXT NOT NULL REFERENCES na_runtimes(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  source_local_folder_id TEXT REFERENCES na_local_folders(id) ON DELETE SET NULL ON UPDATE CASCADE,
  name TEXT NOT NULL, status TEXT NOT NULL, state_revision INTEGER NOT NULL DEFAULT 0 CHECK(state_revision >= 0),
  process_incarnation_id TEXT, registration_credential TEXT, desired_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX na_instances_runtime_idx ON na_instances(runtime_id);
CREATE INDEX na_instances_status_idx ON na_instances(status, updated_at);
CREATE TABLE na_instance_observations (
  instance_id TEXT PRIMARY KEY NOT NULL REFERENCES na_instances(id) ON DELETE CASCADE ON UPDATE CASCADE,
  health TEXT NOT NULL, connection_status TEXT NOT NULL, ready INTEGER NOT NULL,
  observed_json TEXT NOT NULL, last_heartbeat_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX na_instance_observations_connection_idx ON na_instance_observations(connection_status, updated_at);
CREATE TABLE na_models (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, endpoint TEXT NOT NULL, key TEXT NOT NULL, model TEXT NOT NULL,
  app TEXT NOT NULL CHECK(app IN ('codex','claude','opencode')), enabled INTEGER NOT NULL,
  display_order INTEGER NOT NULL, model_names_json TEXT NOT NULL, protocols_json TEXT NOT NULL,
  labels_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX na_models_order_idx ON na_models(display_order, id);
CREATE TABLE na_instance_model_assignments (
  instance_id TEXT PRIMARY KEY NOT NULL REFERENCES na_instances(id) ON DELETE CASCADE ON UPDATE CASCADE,
  legacy_codex_model_id TEXT REFERENCES na_models(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  legacy_claude_model_id TEXT REFERENCES na_models(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  legacy_opencode_model_id TEXT REFERENCES na_models(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  updated_at TEXT NOT NULL
);
CREATE TABLE na_instance_model_entities (
  instance_id TEXT NOT NULL REFERENCES na_instance_model_assignments(instance_id) ON DELETE CASCADE ON UPDATE CASCADE,
  model_id TEXT NOT NULL REFERENCES na_models(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  display_order INTEGER NOT NULL, PRIMARY KEY(instance_id, model_id), UNIQUE(instance_id, display_order)
);
CREATE TABLE na_control_plane_pairings (
  key_id TEXT PRIMARY KEY NOT NULL, control_plane_id TEXT NOT NULL UNIQUE, name TEXT, secret TEXT NOT NULL,
  paired_at TEXT NOT NULL, revoked_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE na_control_plane_connections (
  id TEXT PRIMARY KEY NOT NULL,
  pairing_key_id TEXT NOT NULL REFERENCES na_control_plane_pairings(key_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  name TEXT, normalized_url TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE na_control_plane_connection_operations (
  id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','remote-accepted','committed','failed')),
  requested_json TEXT NOT NULL, pairing_key_id TEXT, connection_id TEXT, replaced_connections_json TEXT NOT NULL,
  error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX na_control_plane_connection_operations_phase_idx ON na_control_plane_connection_operations(phase, updated_at);
CREATE TABLE na_git_credential_payloads (
  credential_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0),
  public_json TEXT NOT NULL, secret_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE na_git_authorization_sets (
  instance_id TEXT PRIMARY KEY NOT NULL REFERENCES na_instances(id) ON DELETE CASCADE ON UPDATE CASCADE,
  generation INTEGER NOT NULL CHECK(generation >= 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE na_git_authorization_members (
  instance_id TEXT NOT NULL REFERENCES na_git_authorization_sets(instance_id) ON DELETE CASCADE ON UPDATE CASCADE,
  credential_id TEXT NOT NULL REFERENCES na_git_credential_payloads(credential_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  display_order INTEGER NOT NULL, PRIMARY KEY(instance_id, credential_id), UNIQUE(instance_id, display_order)
);
CREATE TABLE na_git_workspace_provisioning (
  instance_id TEXT PRIMARY KEY NOT NULL REFERENCES na_instances(id) ON DELETE CASCADE ON UPDATE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','consumed')), operation_id TEXT NOT NULL, input_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  CHECK((status = 'pending' AND input_json IS NOT NULL) OR (status = 'consumed' AND input_json IS NULL))
);
CREATE INDEX na_git_workspace_provisioning_expiry_idx ON na_git_workspace_provisioning(expires_at);
`;

const storyAgentToolPolicy = `
ALTER TABLE na_stories ADD COLUMN agent_tools_content INTEGER NOT NULL DEFAULT 1 CHECK(agent_tools_content IN (0, 1));
ALTER TABLE na_stories ADD COLUMN agent_tools_actions INTEGER NOT NULL DEFAULT 0 CHECK(agent_tools_actions IN (0, 1));
ALTER TABLE na_stories ADD COLUMN agent_tools_automations INTEGER NOT NULL DEFAULT 0 CHECK(agent_tools_automations IN (0, 1));
ALTER TABLE na_stories ADD COLUMN agent_tools_ai_sessions INTEGER NOT NULL DEFAULT 0 CHECK(agent_tools_ai_sessions IN (0, 1));
`;

// All Node Agent domains share this immutable migration sequence.
export const nodeAgentMigrations = [
  migration("0001_story_domain", initialStoryDomain),
  migration("0002_p0_state_domains", p0StateDomains),
  migration("0003_story_agent_tool_policy", storyAgentToolPolicy),
] as const;
