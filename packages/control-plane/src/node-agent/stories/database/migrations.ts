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

export const nodeAgentMigrations = [migration("0001_story_domain", initialStoryDomain)] as const;
