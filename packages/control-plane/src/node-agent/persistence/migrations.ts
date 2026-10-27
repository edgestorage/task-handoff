import crypto from "node:crypto";

export type NodeAgentMigration = {
  id: string;
  checksum: string;
  sql: string;
  /**
   * 表重建型迁移需要在整个连接上关闭 `foreign_keys`（SQLite 在事务内不接受该 pragma，
   * 且 `ON DELETE RESTRICT` 不能被 defer）。置位后 runner 会提交当前事务、关闭 FK、单独事务执行。
   */
  foreignKeysOff?: boolean;
};

function migration(id: string, sql: string, options: { foreignKeysOff?: boolean } = {}): NodeAgentMigration {
  return { id, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex"), ...(options.foreignKeysOff ? { foreignKeysOff: true } : {}) };
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

const agentDefinitionDomain = `
CREATE TABLE na_agent_definitions (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  appended_prompt TEXT NOT NULL DEFAULT '', target_instance_id TEXT NOT NULL, cwd_folder_id TEXT NOT NULL,
  provider_id TEXT NOT NULL, model_entity_id TEXT, model_name TEXT, reasoning_effort TEXT, permission_mode TEXT,
  execution_policy_json TEXT NOT NULL, revision TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX na_agent_definitions_target_instance_idx ON na_agent_definitions(target_instance_id);
CREATE INDEX na_agent_definitions_updated_idx ON na_agent_definitions(updated_at);
CREATE TABLE na_agent_callable_relations (
  agent_id TEXT NOT NULL, callable_agent_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, callable_agent_id),
  FOREIGN KEY (agent_id) REFERENCES na_agent_definitions(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX na_agent_callable_relations_target_idx ON na_agent_callable_relations(callable_agent_id);
`;

const agentRunDomain = `
CREATE TABLE na_agent_runs (
  run_id TEXT PRIMARY KEY NOT NULL, client_request_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  status TEXT NOT NULL CHECK(status IN ('queued','preparing','running','finalizing','completed','failed','cancelled')),
  provenance_json TEXT NOT NULL, root_member_id TEXT NOT NULL, budget_json TEXT NOT NULL,
  result_json TEXT, error_json TEXT, cleanup_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX na_agent_runs_status_updated_idx ON na_agent_runs(status, updated_at);
CREATE TABLE na_agent_run_members (
  member_id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  parent_member_id TEXT, instance_id TEXT NOT NULL, ai_session_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('root','callee')), depth INTEGER NOT NULL CHECK(depth >= 0),
  status TEXT NOT NULL CHECK(status IN ('queued','preparing','running','finalizing','completed','failed','cancelled')),
  execution_snapshot_json TEXT NOT NULL, result_json TEXT, error_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  FOREIGN KEY (run_id) REFERENCES na_agent_runs(run_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (parent_member_id) REFERENCES na_agent_run_members(member_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX na_agent_run_members_run_idx ON na_agent_run_members(run_id, created_at, member_id);
CREATE INDEX na_agent_run_members_parent_idx ON na_agent_run_members(parent_member_id);
CREATE TABLE na_agent_run_timeline (
  run_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0), timestamp TEXT NOT NULL,
  kind TEXT NOT NULL, member_id TEXT, data_json TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence),
  FOREIGN KEY (run_id) REFERENCES na_agent_runs(run_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (member_id) REFERENCES na_agent_run_members(member_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
`;

const storyAgentEntryAuthorization = `
CREATE TABLE na_story_agent_entries (
  story_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (story_id, agent_id),
  FOREIGN KEY (story_id) REFERENCES na_stories(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX na_story_agent_entries_agent_idx ON na_story_agent_entries(agent_id);
`;

const agentRunResultDelivery = `
ALTER TABLE na_agent_runs ADD COLUMN result_delivery_json TEXT;
`;

const agentRunResourceOwnership = `
CREATE UNIQUE INDEX na_agent_run_members_run_member_uq ON na_agent_run_members(run_id, member_id);
CREATE TABLE na_agent_run_shared_spaces (
  run_id TEXT PRIMARY KEY NOT NULL, runtime_id TEXT NOT NULL, generation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preparing','active','retained','expiring','delete-retrying','expired','manual-intervention')),
  quota_bytes INTEGER NOT NULL CHECK(quota_bytes > 0), usage_bytes INTEGER NOT NULL DEFAULT 0 CHECK(usage_bytes >= 0),
  expires_at TEXT, diagnostics_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES na_agent_runs(run_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (runtime_id) REFERENCES na_runtimes(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX na_agent_run_shared_spaces_runtime_expiry_idx ON na_agent_run_shared_spaces(runtime_id, expires_at);
CREATE TABLE na_agent_run_resources (
  resource_id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, member_id TEXT, instance_id TEXT, runtime_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('provider-thread','overlay-mount','overlay-run-directory','shared-space-directory','helper-container','sandbox-container')),
  generation_id TEXT NOT NULL, backend_identity TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('preparing','ready','deleting','delete-retrying','deleted','manual-intervention')),
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_attempts >= 0), metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES na_agent_runs(run_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (run_id, member_id) REFERENCES na_agent_run_members(run_id, member_id) ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE (run_id, kind, backend_identity)
);
CREATE INDEX na_agent_run_resources_run_phase_idx ON na_agent_run_resources(run_id, phase);
`;

const agentRunInput = `
ALTER TABLE na_agent_runs ADD COLUMN input_json TEXT;
`;

const agentRunMemberInput = `
ALTER TABLE na_agent_run_members ADD COLUMN input_json TEXT;
`;

const agentRunMemberRequestIdentity = `
ALTER TABLE na_agent_run_members ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX na_agent_run_members_request_uq ON na_agent_run_members(run_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
`;

/**
 * 编排域：拓扑从 AgentDefinition 迁移到 AgentOrchestration。
 * 每个既有 Agent 回填一张默认编排（id = `default:<agentId>`），图 = 既有 callable 可达闭包，
 * 入口保持为该 Agent 自身，因此迁移前后「运行该 Agent」的行为一致；revision 由仓储在读取时按内容补算。
 * Story 入口明细补上 orchestration_id（缺省指向该 Agent 的默认编排），Run 记录补上 orchestration_id。
 */
const agentOrchestrationDomain = `
CREATE TABLE na_agent_orchestrations (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
  revision TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE na_agent_orchestration_agents (
  orchestration_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (orchestration_id, agent_id),
  FOREIGN KEY (orchestration_id) REFERENCES na_agent_orchestrations(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX na_agent_orchestration_agents_agent_idx ON na_agent_orchestration_agents(agent_id);
CREATE TABLE na_agent_orchestration_edges (
  orchestration_id TEXT NOT NULL, from_agent_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (orchestration_id, from_agent_id, to_agent_id),
  FOREIGN KEY (orchestration_id) REFERENCES na_agent_orchestrations(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX na_agent_orchestration_edges_from_idx ON na_agent_orchestration_edges(from_agent_id);

INSERT INTO na_agent_orchestrations (id, name, revision, created_at, updated_at)
  SELECT 'default:' || id, name, '', updated_at, updated_at FROM na_agent_definitions;
WITH RECURSIVE reach(origin, node) AS (
  SELECT id, id FROM na_agent_definitions
  UNION
  SELECT reach.origin, relation.callable_agent_id
    FROM reach JOIN na_agent_callable_relations relation ON relation.agent_id = reach.node
)
INSERT INTO na_agent_orchestration_agents (orchestration_id, agent_id, created_at)
  SELECT DISTINCT 'default:' || origin, node, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM reach;
WITH RECURSIVE reach(origin, node) AS (
  SELECT id, id FROM na_agent_definitions
  UNION
  SELECT reach.origin, relation.callable_agent_id
    FROM reach JOIN na_agent_callable_relations relation ON relation.agent_id = reach.node
)
INSERT OR IGNORE INTO na_agent_orchestration_edges (orchestration_id, from_agent_id, to_agent_id, created_at)
  SELECT DISTINCT 'default:' || reach.origin, relation.agent_id, relation.callable_agent_id, strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM reach JOIN na_agent_callable_relations relation ON relation.agent_id = reach.node;
DROP TABLE na_agent_callable_relations;

CREATE TABLE na_story_agent_entries_v2 (
  story_id TEXT NOT NULL, agent_id TEXT NOT NULL, orchestration_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (story_id, agent_id, orchestration_id),
  FOREIGN KEY (story_id) REFERENCES na_stories(id) ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO na_story_agent_entries_v2 (story_id, agent_id, orchestration_id, created_at)
  SELECT story_id, agent_id, 'default:' || agent_id, created_at FROM na_story_agent_entries;
DROP TABLE na_story_agent_entries;
ALTER TABLE na_story_agent_entries_v2 RENAME TO na_story_agent_entries;
CREATE INDEX na_story_agent_entries_agent_idx ON na_story_agent_entries(agent_id);

ALTER TABLE na_agent_runs ADD COLUMN orchestration_id TEXT;
UPDATE na_agent_runs SET orchestration_id = (
  SELECT 'default:' || agent_id FROM na_agent_run_members WHERE member_id = na_agent_runs.root_member_id
) WHERE orchestration_id IS NULL;
`;

// Relay-only request name mappings ({ name, upstreamName, order } per row).
// Existing rows read back an empty list; the field needs a stable model entity
// identity only on write, which every node at this migration already has.
const modelRequestMappings = `
ALTER TABLE na_models ADD COLUMN mappings_json TEXT NOT NULL DEFAULT '[]';
`;

// Stable model identity for agent definitions: the display label may be renamed
// at any time, so the upstream name is stored alongside it.
const agentDefinitionModelIdentity = `
ALTER TABLE na_agent_definitions ADD COLUMN model_upstream_name TEXT;
`;

const storyDecisionDomain = `
ALTER TABLE na_stories ADD COLUMN agent_tools_decisions INTEGER NOT NULL DEFAULT 0 CHECK(agent_tools_decisions IN (0, 1));
CREATE TABLE na_story_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  story_id TEXT NOT NULL REFERENCES na_stories(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  allow_free_text INTEGER NOT NULL DEFAULT 1 CHECK(allow_free_text IN (0, 1)),
  context TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','decided','cancelled','expired')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  response TEXT,
  selected_option_id TEXT,
  decided_turn_id TEXT,
  expired_reason_json TEXT,
  -- node-agent 私有续接账本：仅用于旧实例不支持发送幂等键时的显式重试判定，不进入公共决策模型或 UI。
  resume_state TEXT CHECK(resume_state IS NULL OR resume_state = 'resuming'),
  resume_attempted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE UNIQUE INDEX na_story_decisions_session_turn_uq ON na_story_decisions(story_id, session_id, turn_id)
  WHERE turn_id IS NOT NULL;
CREATE INDEX na_story_decisions_story_idx ON na_story_decisions(story_id, created_at);
CREATE INDEX na_story_decisions_session_idx ON na_story_decisions(session_id, status);
`;

// `wsl` runtime（add-wsl-runtime）：na_runtimes.type 的 CHECK 需要扩展，SQLite 不支持修改 CHECK，
// 只能重建表。`na_instances.runtime_id` 以 ON DELETE RESTRICT 引用它，因此重建必须在 FK 关闭的
// 独立事务里进行（DROP/RENAME 在 FK 开启时无法执行，RESTRICT 也不能被 defer）。
const runtimeTypeWsl = `
CREATE TABLE na_runtimes_wsl (
  id TEXT PRIMARY KEY NOT NULL, node_id TEXT NOT NULL REFERENCES na_node_identity(node_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('docker','kubernetes','local','wsl')),
  status TEXT NOT NULL CHECK(status IN ('unknown','online','offline','degraded')), access_strategy TEXT NOT NULL,
  capabilities_json TEXT NOT NULL, labels_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO na_runtimes_wsl (id, node_id, name, type, status, access_strategy, capabilities_json, labels_json, created_at, updated_at)
  SELECT id, node_id, name, type, status, access_strategy, capabilities_json, labels_json, created_at, updated_at FROM na_runtimes;
DROP TABLE na_runtimes;
ALTER TABLE na_runtimes_wsl RENAME TO na_runtimes;
CREATE INDEX na_runtimes_node_type_idx ON na_runtimes(node_id, type);
`;

// add-cloud-platform-node-agent-relay：账号级节点绑定与 relay 通道的本地持久化。
// 凭据、relay 私钥与云信任锚都只落在节点本地；云端只保存 hash 与公钥指纹。
const cloudRelayBinding = `
CREATE TABLE na_cloud_relay_bindings (
  singleton_key INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK(singleton_key = 1),
  status TEXT NOT NULL CHECK(status IN ('active','rebind-required')),
  node_handle TEXT NOT NULL, account_id TEXT NOT NULL,
  cloud_origin TEXT NOT NULL, service_origin TEXT NOT NULL,
  credential TEXT NOT NULL, credential_expires_at TEXT NOT NULL,
  signing_kid TEXT, signing_public_key TEXT,
  relay_public_key TEXT NOT NULL, relay_private_key TEXT NOT NULL,
  paired_control_planes_json TEXT NOT NULL DEFAULT '[]',
  last_error_json TEXT, bound_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

// add-device-trust-approval-center Stage B: node-agent is the local authority
// for Control Plane pins. Existing cloud bindings and relay pairings are never
// imported as approvals; the first claim after upgrade must form a pending.
const cloudControlPlaneTrust = `
CREATE TABLE na_cloud_control_plane_pins (
  id TEXT PRIMARY KEY NOT NULL,
  node_id TEXT NOT NULL,
  node_handle TEXT NOT NULL,
  control_plane_id TEXT NOT NULL,
  control_plane_public_key TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
  access_account_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK(access_mode IN ('owner','shared')),
  share_grant_id TEXT,
  share_role TEXT,
  share_revision INTEGER CHECK(share_revision IS NULL OR share_revision >= 1),
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  approved_by_actor_type TEXT NOT NULL CHECK(approved_by_actor_type IN ('local','control-plane','system')),
  approved_by_actor_id TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  authorization_revision INTEGER NOT NULL CHECK(authorization_revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((access_mode = 'owner' AND share_grant_id IS NULL AND share_role IS NULL AND share_revision IS NULL)
    OR (access_mode = 'shared' AND share_grant_id IS NOT NULL AND share_role IS NOT NULL AND share_revision IS NOT NULL))
);
CREATE UNIQUE INDEX na_cloud_control_plane_pins_active_uq ON na_cloud_control_plane_pins(
  node_id, node_handle, control_plane_id, control_plane_public_key, binding_id,
  access_account_id, owner_account_id, access_mode,
  COALESCE(share_grant_id, ''), COALESCE(share_role, '')
) WHERE status = 'active';
CREATE INDEX na_cloud_control_plane_pins_scope_idx ON na_cloud_control_plane_pins(node_id, status, updated_at);
CREATE INDEX na_cloud_control_plane_pins_control_plane_idx ON na_cloud_control_plane_pins(control_plane_id, status, updated_at);

CREATE TABLE na_cloud_control_plane_trust_requests (
  id TEXT PRIMARY KEY NOT NULL,
  node_id TEXT NOT NULL,
  node_handle TEXT NOT NULL,
  control_plane_id TEXT NOT NULL,
  control_plane_public_key TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
  access_account_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK(access_mode IN ('owner','shared')),
  share_grant_id TEXT,
  share_role TEXT,
  share_revision INTEGER CHECK(share_revision IS NULL OR share_revision >= 1),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired')),
  requested_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by_actor_type TEXT CHECK(decided_by_actor_type IS NULL OR decided_by_actor_type IN ('local','control-plane','system')),
  decided_by_actor_id TEXT,
  decision_reason TEXT,
  pin_id TEXT REFERENCES na_cloud_control_plane_pins(id) ON DELETE SET NULL ON UPDATE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((access_mode = 'owner' AND share_grant_id IS NULL AND share_role IS NULL AND share_revision IS NULL)
    OR (access_mode = 'shared' AND share_grant_id IS NOT NULL AND share_role IS NOT NULL AND share_revision IS NOT NULL))
);
CREATE UNIQUE INDEX na_cloud_control_plane_trust_requests_pending_uq ON na_cloud_control_plane_trust_requests(
  node_id, node_handle, control_plane_id, control_plane_public_key, binding_id,
  access_account_id, owner_account_id, access_mode,
  COALESCE(share_grant_id, ''), COALESCE(share_role, '')
) WHERE status = 'pending';
CREATE INDEX na_cloud_control_plane_trust_requests_scope_idx ON na_cloud_control_plane_trust_requests(node_id, status, expires_at);
CREATE INDEX na_cloud_control_plane_trust_requests_control_plane_idx ON na_cloud_control_plane_trust_requests(control_plane_id, status, updated_at);

CREATE TABLE na_cloud_control_plane_trust_audit (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('approve','reject','revoke','expire','retry','share-revision-update')),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('local','control-plane','system')),
  actor_id TEXT NOT NULL,
  connection_type TEXT,
  request_id TEXT,
  pin_id TEXT,
  control_plane_id TEXT NOT NULL,
  control_plane_public_key_fingerprint TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK(access_mode IN ('owner','shared')),
  share_role TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX na_cloud_control_plane_trust_audit_control_plane_idx ON na_cloud_control_plane_trust_audit(control_plane_id, created_at);
CREATE INDEX na_cloud_control_plane_trust_audit_request_idx ON na_cloud_control_plane_trust_audit(request_id, created_at);
CREATE INDEX na_cloud_control_plane_trust_audit_pin_idx ON na_cloud_control_plane_trust_audit(pin_id, created_at);
`;

// All Node Agent domains share this immutable migration sequence.
export const nodeAgentMigrations = [
  migration("0001_story_domain", initialStoryDomain),
  migration("0002_p0_state_domains", p0StateDomains),
  migration("0003_story_agent_tool_policy", storyAgentToolPolicy),
  migration("0004_agent_definition_domain", agentDefinitionDomain),
  migration("0005_agent_run_domain", agentRunDomain),
  migration("0006_story_agent_entry_authorization", storyAgentEntryAuthorization),
  migration("0007_agent_run_result_delivery", agentRunResultDelivery),
  migration("0008_agent_run_resource_ownership", agentRunResourceOwnership),
  // Compatibility for v0.0.32: existing rows remain readable without a frozen input.
  migration("0009_agent_run_input", agentRunInput),
  migration("0010_agent_run_member_input", agentRunMemberInput),
  migration("0011_agent_run_member_request_identity", agentRunMemberRequestIdentity),
  migration("0012_agent_orchestration_domain", agentOrchestrationDomain),
  migration("0013_model_request_mappings", modelRequestMappings),
  migration("0014_story_decision_domain", storyDecisionDomain),
  migration("0015_agent_definition_model_identity", agentDefinitionModelIdentity),
  migration("0016_runtime_type_wsl", runtimeTypeWsl, { foreignKeysOff: true }),
  migration("0017_cloud_relay_binding", cloudRelayBinding),
  migration("0018_cloud_control_plane_trust", cloudControlPlaneTrust),
] as const;
