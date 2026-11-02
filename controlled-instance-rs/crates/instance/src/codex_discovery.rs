use chrono::{DateTime, SecondsFormat, Utc};
use controlled_instance_ai_session::{AiSession, AiSessionModelSelection, CodexThreadSnapshot};
use controlled_instance_protocol::{mint_entity_id, AiSessionQueue, AppSession};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub(crate) struct CodexAppThreadBinding {
    pub app_session_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
}

pub(crate) fn app_thread_bindings(
    sessions: &[AppSession],
) -> (HashMap<String, CodexAppThreadBinding>, Vec<String>) {
    let mut bindings = HashMap::new();
    let mut recoverable = Vec::new();
    for session in sessions {
        if session.app_id != "codex" || session.status != "running" {
            continue;
        }
        let Some(ai) = session.ai.as_ref().and_then(Value::as_object) else {
            continue;
        };
        let active = ai
            .get("activeThreadId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let thread_ids = ai
            .get("threadIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let binding = CodexAppThreadBinding {
            app_session_id: session.id.clone(),
            title: Some(session.title.trim())
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
            cwd: Some(session.workspace.cwd.trim())
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
        };
        for thread_id in active.into_iter().chain(thread_ids) {
            bindings
                .entry(thread_id.to_string())
                .or_insert_with(|| binding.clone());
            if !recoverable.iter().any(|known| known == thread_id) {
                recoverable.push(thread_id.to_string());
            }
        }
    }
    (bindings, recoverable)
}

pub(crate) fn project_new_codex_session(
    snapshot: &CodexThreadSnapshot,
    binding: &CodexAppThreadBinding,
    model_selection: Option<AiSessionModelSelection>,
) -> AiSession {
    let summary = ThreadSummary::from_snapshot(snapshot);
    let started_at = summary
        .turns
        .first()
        .and_then(|turn| turn.get("startedAt"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(now_iso);
    let updated_at = summary
        .turns
        .last()
        .and_then(|turn| turn.get("updatedAt").or_else(|| turn.get("completedAt")))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(now_iso);
    let completed_at = (snapshot.status != "running" && snapshot.status != "waiting")
        .then(|| {
            summary
                .turns
                .last()
                .and_then(|turn| turn.get("completedAt"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .flatten();
    AiSession {
        id: mint_entity_id("ses"),
        agent: "codex".to_string(),
        creation_source: "app-session".to_string(),
        app_session_id: Some(binding.app_session_id.clone()),
        app_id: Some("codex".to_string()),
        provider_session_id: Some(snapshot.provider_session_id.clone()),
        lineage: snapshot.lineage.clone(),
        provider_meta: None,
        model_selection: model_selection.and_then(|selection| serde_json::to_value(selection).ok()),
        reasoning_effort: valid_reasoning_effort(snapshot.reasoning_effort.as_deref()),
        story_id: None,
        app_binding_keys: Some(vec![format!("app:{}", binding.app_session_id)]),
        actions: Some(codex_actions(&snapshot.status, &snapshot.phase)),
        active_turn_id: summary.active_turn_id.clone(),
        title: binding.title.clone().or_else(|| snapshot.name.clone()),
        cwd: Some(snapshot.cwd.trim())
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .or_else(|| binding.cwd.clone()),
        cwd_folder_id: None,
        user_prompt: summary.user_prompt.clone(),
        turns: snapshot.turns_authoritative.then(|| summary.turns.clone()),
        status: snapshot.status.clone(),
        phase: snapshot.phase.clone(),
        summary: summary.summary.clone(),
        last_message: summary.last_message.clone(),
        last_message_item_id: summary.last_message_item_id.clone(),
        current_tool: None,
        tool_calls_since_last_message: 0,
        sub_agents: Vec::new(),
        transcript_path: None,
        transcript_size: None,
        started_at,
        updated_at,
        completed_at,
        error: summary.error.clone(),
        counters: Default::default(),
        queue: AiSessionQueue::default(),
        unread: false,
    }
}

pub(crate) fn merge_codex_session(
    session: &mut AiSession,
    snapshot: &CodexThreadSnapshot,
    binding: Option<&CodexAppThreadBinding>,
    model_selection: Option<AiSessionModelSelection>,
) -> bool {
    let summary = ThreadSummary::from_snapshot(snapshot);
    let mut changed = false;
    if let Some(binding) = binding {
        let binding_keys = vec![format!("app:{}", binding.app_session_id)];
        if session.app_session_id.as_deref() != Some(binding.app_session_id.as_str()) {
            session.app_session_id = Some(binding.app_session_id.clone());
            changed = true;
        }
        if session.app_id.as_deref() != Some("codex") {
            session.app_id = Some("codex".to_string());
            changed = true;
        }
        if session.app_binding_keys.as_ref() != Some(&binding_keys) {
            session.app_binding_keys = Some(binding_keys);
            changed = true;
        }
    }
    if !snapshot.cwd.trim().is_empty() && session.cwd.as_deref() != Some(snapshot.cwd.as_str()) {
        session.cwd = Some(snapshot.cwd.clone());
        changed = true;
    }
    if let Some(name) = snapshot.name.as_deref().filter(|value| !value.is_empty()) {
        if session.title.as_deref() != Some(name) {
            session.title = Some(name.to_string());
            changed = true;
        }
    }
    if snapshot
        .model
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        && snapshot
            .model_provider
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    {
        let next = model_selection
            .as_ref()
            .and_then(|selection| serde_json::to_value(selection).ok());
        if session.model_selection != next {
            session.model_selection = next;
            changed = true;
        }
    }
    let next_effort = valid_reasoning_effort(snapshot.reasoning_effort.as_deref());
    if next_effort.is_some() && session.reasoning_effort != next_effort {
        session.reasoning_effort = next_effort;
        changed = true;
    }
    if session.status != snapshot.status {
        session.status = snapshot.status.clone();
        changed = true;
    }
    if session.phase != snapshot.phase {
        session.phase = snapshot.phase.clone();
        changed = true;
    }
    let actions = codex_actions(&snapshot.status, &snapshot.phase);
    if session.actions.as_ref() != Some(&actions) {
        session.actions = Some(actions);
        changed = true;
    }
    if snapshot.turns_authoritative {
        if session.active_turn_id != summary.active_turn_id {
            session.active_turn_id = summary.active_turn_id.clone();
            changed = true;
        }
        if session.user_prompt != summary.user_prompt {
            session.user_prompt = summary.user_prompt.clone();
            changed = true;
        }
        if session.turns.as_ref() != Some(&summary.turns) {
            session.turns = Some(summary.turns.clone());
            changed = true;
        }
        if session.summary != summary.summary {
            session.summary = summary.summary.clone();
            changed = true;
        }
        if session.last_message != summary.last_message {
            session.last_message = summary.last_message.clone();
            changed = true;
        }
        if session.last_message_item_id != summary.last_message_item_id {
            session.last_message_item_id = summary.last_message_item_id.clone();
            changed = true;
        }
        if session.error != summary.error {
            session.error = summary.error.clone();
            changed = true;
        }
        if snapshot.status != "running" && snapshot.status != "waiting" {
            let completed_at = summary
                .turns
                .last()
                .and_then(|turn| turn.get("completedAt"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if session.completed_at != completed_at {
                session.completed_at = completed_at;
                changed = true;
            }
        }
    }
    changed
}

pub(crate) fn recoverable_session_threads(sessions: &[AiSession]) -> Vec<String> {
    sessions
        .iter()
        .filter(|session| {
            session.agent == "codex"
                && session
                    .provider_session_id
                    .as_deref()
                    .is_some_and(|id| !id.trim().is_empty())
                && session
                    .actions
                    .as_ref()
                    .and_then(Value::as_object)
                    .and_then(|actions| actions.get("send"))
                    .and_then(Value::as_bool)
                    != Some(false)
                && session
                    .actions
                    .as_ref()
                    .and_then(Value::as_object)
                    .and_then(|actions| actions.get("close"))
                    .and_then(Value::as_bool)
                    != Some(false)
        })
        .filter_map(|session| session.provider_session_id.clone())
        .collect()
}

#[derive(Default)]
struct ThreadSummary {
    active_turn_id: Option<String>,
    user_prompt: Option<String>,
    turns: Vec<Value>,
    summary: Option<String>,
    last_message: Option<String>,
    last_message_item_id: Option<String>,
    error: Option<String>,
}

impl ThreadSummary {
    fn from_snapshot(snapshot: &CodexThreadSnapshot) -> Self {
        let turns = snapshot.turns.as_array().cloned().unwrap_or_default();
        let mut summary = Self::default();
        for (index, turn) in turns.iter().enumerate() {
            let Some(record) = turn.as_object() else {
                continue;
            };
            let turn_id = record
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("turn_{index}"));
            let provider_status = record
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            let started_at = iso_timestamp(record.get("startedAt"));
            let completed_at = iso_timestamp(record.get("completedAt")).or_else(|| {
                completed_at_from_duration(started_at.as_deref(), record.get("durationMs"))
            });
            let mut history = Map::new();
            history.insert("id".to_string(), json!(turn_id));
            history.insert(
                "status".to_string(),
                json!(match provider_status {
                    "inProgress" => "running",
                    "failed" => "failed",
                    _ => "completed",
                }),
            );
            history.insert("revision".to_string(), json!(0));
            if let Some(started_at) = started_at.as_ref() {
                history.insert("startedAt".to_string(), json!(started_at));
                history.insert(
                    "updatedAt".to_string(),
                    json!(completed_at.as_deref().unwrap_or(started_at)),
                );
            }
            if let Some(completed_at) = completed_at.as_ref() {
                history.insert("completedAt".to_string(), json!(completed_at));
            }
            let turn_error = (provider_status == "failed")
                .then(|| codex_error_message(record.get("error")))
                .flatten();
            if index + 1 == turns.len() {
                summary.error = turn_error;
            }
            if provider_status == "inProgress" {
                summary.active_turn_id = Some(turn_id.clone());
            }
            let items = record
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut compactions = Vec::new();
            for item in items {
                let Some(item) = item.as_object() else {
                    continue;
                };
                match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "userMessage" => {
                        if let Some(text) = user_message_text(item)
                            .filter(|text| !is_synthetic_user_transcript_text(text))
                        {
                            summary.user_prompt = Some(text.clone());
                            history.insert("userPrompt".to_string(), json!(text));
                        }
                    }
                    "agentMessage" => {
                        if let Some(text) = item
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|text| !text.is_empty())
                        {
                            let item_id = item
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|id| !id.is_empty())
                                .map(ToString::to_string);
                            summary.last_message = Some(text.to_string());
                            summary.last_message_item_id = item_id.clone();
                            history.insert("lastMessage".to_string(), json!(text));
                            if let Some(item_id) = item_id {
                                history.insert("lastMessageItemId".to_string(), json!(item_id));
                            }
                            history.insert("summary".to_string(), json!(compact(text, 1000)));
                        }
                    }
                    "contextCompaction"
                        if item
                            .get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| !id.trim().is_empty()) =>
                    {
                        compactions.push(json!({
                            "id": format!("context_compaction:{turn_id}"),
                            "status": "completed",
                        }));
                    }
                    _ => {}
                }
            }
            if !compactions.is_empty() {
                history.insert("contextCompactions".to_string(), Value::Array(compactions));
            }
            if history.contains_key("userPrompt")
                || history.contains_key("lastMessage")
                || history.contains_key("summary")
                || history.contains_key("contextCompactions")
            {
                summary.turns.push(Value::Object(history));
            }
        }
        summary.summary = summary
            .last_message
            .as_deref()
            .map(|text| compact(text, 1000));
        summary
    }
}

fn codex_actions(status: &str, phase: &str) -> Value {
    json!({
        "send": true,
        "interrupt": matches!(status, "running" | "waiting"),
        "approval": status == "waiting" && phase == "approval",
        "fork": true,
        "rename": true,
    })
}

fn valid_reasoning_effort(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| matches!(*value, "low" | "medium" | "high" | "xhigh"))
        .map(ToString::to_string)
}

fn user_message_text(item: &Map<String, Value>) -> Option<String> {
    let text = item
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|value| value.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|value| value.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    (!text.is_empty()).then_some(text)
}

fn is_synthetic_user_transcript_text(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "[request interrupted by user]" | "[user interrupted request]"
    )
}

fn codex_error_message(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(message) => {
            Some(message.trim().to_string()).filter(|value| !value.is_empty())
        }
        Value::Object(object) => object
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string),
        _ => None,
    }
}

fn iso_timestamp(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(text) {
            return Some(
                parsed
                    .with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Millis, true),
            );
        }
        return timestamp_from_seconds(text.parse::<f64>().ok()?);
    }
    timestamp_from_seconds(value.as_f64()?)
}

fn timestamp_from_seconds(seconds: f64) -> Option<String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    DateTime::from_timestamp_millis((seconds * 1000.0).round() as i64)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn completed_at_from_duration(
    started_at: Option<&str>,
    duration_ms: Option<&Value>,
) -> Option<String> {
    let started_at = DateTime::parse_from_rfc3339(started_at?).ok()?;
    let duration_ms = duration_ms?.as_f64()?;
    if !duration_ms.is_finite() || duration_ms < 0.0 {
        return None;
    }
    Some(
        (started_at + chrono::Duration::milliseconds(duration_ms.round() as i64))
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    )
}

fn compact(value: &str, max: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let length = text.encode_utf16().count();
    if length <= max {
        return text;
    }
    let keep = max.saturating_sub(3);
    let mut units = 0;
    let mut truncated = String::new();
    for character in text.chars() {
        let width = character.len_utf16();
        if units + width > keep {
            break;
        }
        units += width;
        truncated.push(character);
    }
    truncated.push_str("...");
    truncated
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> CodexThreadSnapshot {
        CodexThreadSnapshot {
            provider_session_id: "thread-1".to_string(),
            cwd: "/workspace".to_string(),
            name: Some("Codex".to_string()),
            model: None,
            model_provider: None,
            reasoning_effort: Some("high".to_string()),
            status: "running".to_string(),
            phase: "thinking".to_string(),
            turns: json!([{
                "id": "turn-1",
                "status": "inProgress",
                "startedAt": 1_700_000_000,
                "items": [
                    { "type": "userMessage", "content": [{ "type": "text", "text": "Fix it" }] },
                    { "type": "agentMessage", "id": "item-1", "text": "Working on it" }
                ]
            }]),
            paginated_history: false,
            lineage: None,
            turns_authoritative: true,
        }
    }

    #[test]
    fn app_thread_projects_into_a_bound_ai_session() {
        let binding = CodexAppThreadBinding {
            app_session_id: "app_0000000000001".to_string(),
            title: Some("Codex TUI".to_string()),
            cwd: Some("/workspace".to_string()),
        };
        let session = project_new_codex_session(&snapshot(), &binding, None);
        assert_eq!(session.creation_source, "app-session");
        assert_eq!(
            session.app_session_id.as_deref(),
            Some(binding.app_session_id.as_str())
        );
        assert_eq!(session.provider_session_id.as_deref(), Some("thread-1"));
        assert_eq!(session.title.as_deref(), Some("Codex TUI"));
        assert_eq!(session.active_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(session.user_prompt.as_deref(), Some("Fix it"));
        assert_eq!(session.last_message.as_deref(), Some("Working on it"));
        assert_eq!(
            session.app_binding_keys.as_deref(),
            Some(["app:app_0000000000001".to_string()].as_slice())
        );
    }

    #[test]
    fn bindings_and_recovery_are_derived_from_running_app_sessions() {
        let mut session = AppSession {
            id: "app_0000000000001".to_string(),
            app_id: "codex".to_string(),
            title: "Codex".to_string(),
            kind: "tty".to_string(),
            status: "running".to_string(),
            created_at: now_iso(),
            updated_at: now_iso(),
            workspace: controlled_instance_protocol::AppSessionWorkspace {
                cwd: "/workspace".to_string(),
            },
            launch: None,
            tty: None,
            display: None,
            vnc: None,
            web: None,
            automation: None,
            process: None,
            ai: Some(json!({ "activeThreadId": "thread-1", "threadIds": ["thread-2"] })),
            paths: controlled_instance_protocol::AppSessionPaths {
                session_dir: "/tmp/app".to_string(),
                log_dir: "/tmp/log".to_string(),
            },
            bindings: Vec::new(),
            extra: Default::default(),
        };
        let (bindings, recoverable) = app_thread_bindings(std::slice::from_ref(&session));
        assert_eq!(bindings["thread-1"].app_session_id, session.id);
        assert!(bindings.contains_key("thread-2"));
        assert_eq!(recoverable, vec!["thread-1", "thread-2"]);

        session.status = "stopped".to_string();
        let (bindings, recoverable) = app_thread_bindings(&[session]);
        assert!(bindings.is_empty());
        assert!(recoverable.is_empty());
    }

    #[test]
    fn merge_preserves_direct_session_creation_source() {
        let binding = CodexAppThreadBinding {
            app_session_id: "app_0000000000001".to_string(),
            title: None,
            cwd: None,
        };
        let mut session = project_new_codex_session(&snapshot(), &binding, None);
        session.creation_source = "ai-session".to_string();
        session.app_session_id = None;
        session.app_id = None;
        session.app_binding_keys = None;
        assert!(merge_codex_session(
            &mut session,
            &snapshot(),
            Some(&binding),
            None,
        ));
        assert_eq!(session.creation_source, "ai-session");
        assert_eq!(
            session.app_session_id.as_deref(),
            Some(binding.app_session_id.as_str())
        );
    }

    #[test]
    fn summary_compacts_by_utf16_code_units() {
        let compacted = compact(&"a".repeat(2_000), 1000);
        assert_eq!(compacted.encode_utf16().count(), 1000);
        assert!(compacted.ends_with("..."));

        let compacted = compact(&"😀".repeat(600), 1000);
        assert!(compacted.encode_utf16().count() <= 1000);
        assert!(compacted.ends_with("..."));
    }
}
