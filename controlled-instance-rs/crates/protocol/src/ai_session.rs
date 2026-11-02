use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const AI_SESSION_SNAPSHOT_LIMIT: usize = 150;
pub const AI_SESSION_HISTORY_DEFAULT_LIMIT: usize = 50;
pub const AI_SESSION_HISTORY_MAX_LIMIT: usize = 500;
pub const AI_SESSION_HISTORY_MAX_ITEMS: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionCounters {
    pub tool_calls: u64,
    pub edits: u64,
    pub approvals: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionQueue {
    pub revision: u64,
    pub pending_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    pub items: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionSummary {
    pub id: String,
    pub agent: String,
    #[serde(default = "default_creation_source")]
    pub creation_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lineage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_meta: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub story_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_binding_keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd_folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_turn_ref: Option<AiSessionLatestTurnRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_user_message_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<Value>>,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_phase")]
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_tool: Option<Value>,
    #[serde(default)]
    pub tool_calls_since_last_message: u64,
    #[serde(default)]
    pub sub_agents: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_agent_count: Option<u64>,
    pub started_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub queue: AiSessionQueue,
    #[serde(default)]
    pub unread: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionLatestTurnRef {
    pub id: String,
    pub body_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionsSnapshot {
    pub running_count: u64,
    pub waiting_count: u64,
    pub stale_count: u64,
    pub sessions: Vec<AiSessionSummary>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionsState {
    pub stream_id: String,
    pub revision: u64,
    pub last_event_at: String,
    pub snapshot: AiSessionsSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionHistoryItem {
    pub id: String,
    pub agent: String,
    pub creation_source: String,
    pub provider_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub story_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd_folder_id: Option<String>,
    pub last_active_at: String,
    pub archived_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionHistoryIndex {
    #[serde(default = "default_history_schema_version")]
    pub schema_version: u8,
    #[serde(default)]
    pub items: Vec<AiSessionHistoryItem>,
}

impl Default for AiSessionHistoryIndex {
    fn default() -> Self {
        Self {
            schema_version: 1,
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionHistoryList {
    pub items: Vec<AiSessionHistoryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionHistoryDetail {
    pub item: AiSessionHistoryItem,
    pub turns: Vec<Value>,
}

fn has_subagent_lineage(lineage: Option<&Value>) -> bool {
    lineage
        .and_then(|lineage| lineage.get("kind"))
        .and_then(Value::as_str)
        == Some("subagent")
}

pub fn project_ai_sessions_snapshot_for_consumer(
    mut snapshot: AiSessionsSnapshot,
    subagents: bool,
) -> AiSessionsSnapshot {
    if !subagents {
        for session in &mut snapshot.sessions {
            if has_subagent_lineage(session.lineage.as_ref()) {
                session.lineage = None;
            }
        }
    }
    snapshot
}

pub fn project_ai_session_history_item_for_consumer(
    mut item: AiSessionHistoryItem,
    subagents: bool,
) -> AiSessionHistoryItem {
    if !subagents && has_subagent_lineage(item.lineage.as_ref()) {
        item.lineage = None;
    }
    item
}

fn project_ai_session_summary_value(summary: &mut Value, subagents: bool) {
    if subagents {
        return;
    }
    let Some(object) = summary.as_object_mut() else {
        return;
    };
    if has_subagent_lineage(object.get("lineage")) {
        object.remove("lineage");
    }
}

pub fn project_ai_session_stream_event_payload_for_consumer(
    event_type: &str,
    payload: &mut Value,
    subagents: bool,
) {
    if subagents || event_type == "ai-session.removed" {
        return;
    }
    match event_type {
        "ai-session.snapshot" => {
            if let Some(sessions) = payload
                .get_mut("snapshot")
                .and_then(|snapshot| snapshot.get_mut("sessions"))
                .and_then(Value::as_array_mut)
            {
                for session in sessions {
                    project_ai_session_summary_value(session, subagents);
                }
            }
        }
        "ai-session.patch" => {
            if let Some(upserted) = payload.get_mut("upserted").and_then(Value::as_array_mut) {
                for session in upserted {
                    project_ai_session_summary_value(session, subagents);
                }
            }
        }
        _ => {}
    }
}

pub fn project_ai_session_delta_for_consumer(delta: &mut Value, subagents: bool) {
    if subagents {
        return;
    }
    let Some(events) = delta.get_mut("events").and_then(Value::as_array_mut) else {
        return;
    };
    for event in events {
        let Some(event_type) = event
            .get("type")
            .and_then(Value::as_str)
            .map(ToString::to_string)
        else {
            continue;
        };
        if let Some(payload) = event.get_mut("payload") {
            project_ai_session_stream_event_payload_for_consumer(&event_type, payload, subagents);
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum AiSessionMentionKind {
    Plugin,
    Skill,
    File,
    Directory,
    App,
}

impl AiSessionMentionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plugin => "plugin",
            Self::Skill => "skill",
            Self::File => "file",
            Self::Directory => "directory",
            Self::App => "app",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionMentionCandidate {
    pub kind: AiSessionMentionKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum AiSessionMentionDiagnosticCategory {
    Skills,
    Plugins,
    Apps,
    Files,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionMentionDiagnostic {
    pub category: AiSessionMentionDiagnosticCategory,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionMentionCatalog {
    pub session_id: String,
    pub provider_session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub candidates: Vec<AiSessionMentionCandidate>,
    #[serde(default)]
    pub diagnostics: Vec<AiSessionMentionDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionMentionFileSearchInput {
    #[serde(default)]
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionMentionFileSearch {
    pub session_id: String,
    pub cwd: String,
    pub query: String,
    pub request_id: String,
    #[serde(default)]
    pub candidates: Vec<AiSessionMentionCandidate>,
    #[serde(default)]
    pub complete: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiSessionCommandName {
    Review,
    Rename,
    Goal,
    Compact,
}

impl AiSessionCommandName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Review => "review",
            Self::Rename => "rename",
            Self::Goal => "goal",
            Self::Compact => "compact",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionCommandInput {
    pub command: AiSessionCommandName,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_string_reject_null"
    )]
    pub argument: Option<String>,
}

fn deserialize_optional_string_reject_null<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct OptionalStringVisitor;

    impl<'de> serde::de::Visitor<'de> for OptionalStringVisitor {
        type Value = Option<String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a string")
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(Some(value.to_string()))
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(Some(value))
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Err(E::invalid_type(serde::de::Unexpected::Unit, &"a string"))
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            self.visit_none()
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            String::deserialize(deserializer).map(Some)
        }
    }

    deserializer.deserialize_option(OptionalStringVisitor)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionCommandResult {
    pub command: AiSessionCommandName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

fn default_creation_source() -> String {
    "app-session".to_string()
}

fn default_status() -> String {
    "running".to_string()
}

fn default_phase() -> String {
    "unknown".to_string()
}

fn default_history_schema_version() -> u8 {
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_uses_camel_case_and_the_existing_defaults() {
        let summary = AiSessionSummary {
            id: "ses_0000000000000".to_string(),
            agent: "codex".to_string(),
            creation_source: default_creation_source(),
            app_session_id: None,
            app_id: None,
            provider_session_id: Some("thread".to_string()),
            lineage: None,
            provider_meta: None,
            model_selection: None,
            reasoning_effort: None,
            story_id: None,
            app_binding_keys: None,
            actions: None,
            active_turn_id: None,
            title: Some("Test".to_string()),
            cwd: Some("/workspace".to_string()),
            cwd_folder_id: None,
            user_prompt: None,
            detail_revision: Some("detail".to_string()),
            turns_revision: Some("turns".to_string()),
            latest_turn_ref: None,
            turn_count: Some(0),
            last_user_message_at: None,
            turns: None,
            status: default_status(),
            phase: default_phase(),
            summary: None,
            last_message: None,
            last_message_item_id: None,
            current_tool: None,
            tool_calls_since_last_message: 0,
            sub_agents: Vec::new(),
            sub_agent_count: Some(0),
            started_at: "2026-11-02T00:00:00.000Z".to_string(),
            updated_at: "2026-11-02T00:00:00.000Z".to_string(),
            error: None,
            queue: AiSessionQueue::default(),
            unread: false,
        };
        let value = serde_json::to_value(summary).expect("summary serializes");
        assert_eq!(value["creationSource"], "app-session");
        assert_eq!(value["queue"]["pendingCount"], 0);
        assert!(value.get("appSessionId").is_none());
        assert!(value.get("completedAt").is_none());
        assert!(value.get("counters").is_none());
    }

    #[test]
    fn mention_and_command_models_keep_the_node_wire_shape() {
        let catalog: AiSessionMentionCatalog = serde_json::from_value(serde_json::json!({
            "sessionId": "ses_0000000000000",
            "providerSessionId": "thread",
            "cwd": "/workspace",
            "candidates": [{
                "kind": "file",
                "name": "main.rs",
                "path": "src/main.rs"
            }],
            "diagnostics": [{
                "category": "files",
                "code": "CATALOG_QUERY_FAILED",
                "message": "failed"
            }]
        }))
        .expect("catalog");
        assert_eq!(catalog.candidates[0].kind, AiSessionMentionKind::File);
        let command = serde_json::to_value(AiSessionCommandInput {
            command: AiSessionCommandName::Compact,
            argument: None,
        })
        .expect("command");
        assert_eq!(command, serde_json::json!({ "command": "compact" }));
    }

    fn summary_value(id: &str, lineage: Option<Value>) -> Value {
        serde_json::json!({
            "id": id,
            "agent": "codex",
            "lineage": lineage,
            "startedAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:00:00.000Z"
        })
    }

    #[test]
    fn hierarchy_projection_flattens_only_subagent_lineage_for_legacy_consumers() {
        let subagent = Some(serde_json::json!({
            "kind": "subagent",
            "parentProviderSessionId": "thread-root"
        }));
        let fork = Some(serde_json::json!({
            "kind": "fork",
            "parentProviderSessionId": "thread-root"
        }));
        let snapshot = AiSessionsSnapshot {
            running_count: 2,
            waiting_count: 0,
            stale_count: 0,
            sessions: vec![
                serde_json::from_value(summary_value("ses_child", subagent.clone()))
                    .expect("child summary"),
                serde_json::from_value(summary_value("ses_fork", fork.clone()))
                    .expect("fork summary"),
            ],
            updated_at: "2026-11-02T00:00:00.000Z".to_string(),
        };
        let flat = project_ai_sessions_snapshot_for_consumer(snapshot.clone(), false);
        assert!(flat.sessions[0].lineage.is_none());
        assert_eq!(flat.sessions[1].lineage, fork);
        let nested = project_ai_sessions_snapshot_for_consumer(snapshot, true);
        assert_eq!(nested.sessions[0].lineage, subagent);

        let history: AiSessionHistoryItem = serde_json::from_value(serde_json::json!({
            "id": "ses_child",
            "agent": "codex",
            "creationSource": "ai-session",
            "providerSessionId": "thread-child",
            "lineage": subagent,
            "cwd": "/workspace",
            "lastActiveAt": "2026-11-02T00:00:00.000Z",
            "archivedAt": "2026-11-02T00:01:00.000Z"
        }))
        .expect("history item");
        assert!(project_ai_session_history_item_for_consumer(history, false)
            .lineage
            .is_none());
    }

    #[test]
    fn stream_and_delta_projection_keeps_connections_flat_by_default() {
        let subagent = Some(serde_json::json!({
            "kind": "subagent",
            "parentProviderSessionId": "thread-root"
        }));
        let mut snapshot_payload = serde_json::json!({
            "meta": { "revision": 2 },
            "snapshot": {
                "runningCount": 1,
                "waitingCount": 0,
                "staleCount": 0,
                "sessions": [summary_value("ses_child", subagent.clone())],
                "updatedAt": "2026-11-02T00:00:00.000Z"
            }
        });
        project_ai_session_stream_event_payload_for_consumer(
            "ai-session.snapshot",
            &mut snapshot_payload,
            false,
        );
        assert!(snapshot_payload["snapshot"]["sessions"][0]
            .get("lineage")
            .is_none());

        let mut delta = serde_json::json!({
            "streamId": "stream",
            "instanceId": "instance",
            "sinceRevision": 1,
            "latestRevision": 3,
            "earliestRetainedRevision": 1,
            "syncRequired": false,
            "events": [{
                "type": "ai-session.patch",
                "payload": {
                    "meta": { "revision": 3 },
                    "upserted": [summary_value("ses_child_2", subagent)],
                    "removed": []
                }
            }]
        });
        project_ai_session_delta_for_consumer(&mut delta, false);
        assert!(delta["events"][0]["payload"]["upserted"][0]
            .get("lineage")
            .is_none());
    }
}
