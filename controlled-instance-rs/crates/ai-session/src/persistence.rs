use crate::AiSession;
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use controlled_instance_protocol::{AiSessionCounters, AiSessionQueue};
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};
use std::collections::HashMap;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

const TURN_FIELDS: &[&str] = &[
    "id",
    "providerTurnId",
    "source",
    "userPrompt",
    "userMessages",
    "status",
    "phase",
    "summary",
    "lastMessage",
    "lastMessageItemId",
    "contextCompactions",
    "revision",
    "sourcePriority",
    "snapshotVersion",
    "observedAt",
    "startedAt",
    "updatedAt",
    "completedAt",
];

pub(crate) fn decode_persisted_session(value: &Value) -> Option<AiSession> {
    decode_session(value)
}

pub(crate) fn sanitize_runtime_session(value: &Value) -> Option<AiSession> {
    decode_session(value)
}

fn decode_session(value: &Value) -> Option<AiSession> {
    let record = value.as_object()?;
    let id = required_text(record.get("id"), 120)?;
    let agent = required_text(record.get("agent"), 80)?;
    let started_at = required_timestamp(record.get("startedAt"))?;
    let updated_at = required_timestamp(record.get("updatedAt"))?;
    let status = normalize_lifecycle(record.get("status"));
    let phase = normalize_phase(record.get("phase"))?;
    let queue = normalize_queue(record.get("queue"))?;

    Some(AiSession {
        id,
        agent,
        creation_source: if record.get("creationSource").and_then(Value::as_str)
            == Some("ai-session")
        {
            "ai-session"
        } else {
            "app-session"
        }
        .to_string(),
        app_session_id: optional_text(record.get("appSessionId"), 120),
        app_id: optional_text(record.get("appId"), 120),
        provider_session_id: optional_text(record.get("providerSessionId"), 240),
        lineage: normalize_lineage(record.get("lineage")),
        provider_meta: record
            .get("providerMeta")
            .and_then(Value::as_object)
            .map(|value| Value::Object(value.clone())),
        model_selection: normalize_model_selection(record.get("modelSelection")),
        reasoning_effort: normalize_reasoning_effort(record.get("reasoningEffort")),
        story_id: normalize_story_id(record.get("storyId")),
        app_binding_keys: normalize_string_array(record.get("appBindingKeys"), 20, 240),
        actions: normalize_actions(record.get("actions")),
        active_turn_id: optional_text(record.get("activeTurnId"), 240),
        title: optional_text(record.get("title"), 240),
        cwd: optional_text(record.get("cwd"), 4096),
        cwd_folder_id: {
            let value = optional_text(record.get("cwdFolderId"), 120);
            if value.as_deref() == Some("") {
                return None;
            }
            value
        },
        user_prompt: optional_message_text(record.get("userPrompt")),
        turns: Some(normalize_turns(record.get("turns"))),
        status,
        phase,
        summary: optional_text(record.get("summary"), 1000),
        last_message: optional_message_text(record.get("lastMessage")),
        last_message_item_id: optional_text(record.get("lastMessageItemId"), 240),
        current_tool: normalize_tool(record.get("currentTool")),
        tool_calls_since_last_message: normalize_non_negative_integer(
            record.get("toolCallsSinceLastMessage"),
        ),
        sub_agents: normalize_sub_agents(record.get("subAgents")),
        transcript_path: optional_text(record.get("transcriptPath"), 4096),
        transcript_size: non_negative_integer(record.get("transcriptSize")),
        started_at,
        updated_at,
        completed_at: record
            .get("completedAt")
            .and_then(Value::as_str)
            .filter(|value| valid_datetime(value))
            .map(ToString::to_string),
        error: optional_text(record.get("error"), 4000),
        counters: normalize_counters(record.get("counters"))?,
        queue,
        unread: record.get("unread") == Some(&Value::Bool(true)),
    })
}

fn normalize_counters(value: Option<&Value>) -> Option<AiSessionCounters> {
    let record = value.and_then(Value::as_object);
    Some(AiSessionCounters {
        tool_calls: counter(record.and_then(|record| record.get("toolCalls")))?,
        edits: counter(record.and_then(|record| record.get("edits")))?,
        approvals: counter(record.and_then(|record| record.get("approvals")))?,
    })
}

fn counter(value: Option<&Value>) -> Option<u64> {
    let number = json_number(value).unwrap_or_default().max(0.0);
    if !number.is_finite() || number.fract() != 0.0 {
        return None;
    }
    Some(number.min(u64::MAX as f64) as u64)
}

fn normalize_queue(value: Option<&Value>) -> Option<AiSessionQueue> {
    let record = value.and_then(Value::as_object);
    let revision = normalize_non_negative_integer(record.and_then(|record| record.get("revision")));
    let paused = record
        .and_then(|record| record.get("paused"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut items = record
        .and_then(|record| record.get("items"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_queue_item)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    items.truncate(100);
    items.sort_by_key(queue_status_rank);
    let pending_count = items
        .iter()
        .filter(|item| {
            matches!(
                item.get("status").and_then(Value::as_str),
                Some("queued" | "sending")
            )
        })
        .count() as u64;
    Some(AiSessionQueue {
        revision,
        pending_count,
        paused: paused.then_some(true),
        items,
    })
}

fn normalize_queue_item(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    let id = required_text(record.get("id"), 120)?;
    let message = required_message_text(record.get("message"), 20_000)?;
    let created_at = required_timestamp(record.get("createdAt"))?;
    let updated_at = required_timestamp(record.get("updatedAt"))?;
    let mut item = Map::new();
    item.insert("id".to_string(), Value::String(id));
    if let Some(message_id) = record
        .get("messageId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| compact(value, 240))
    {
        item.insert("messageId".to_string(), Value::String(message_id));
    }
    item.insert("message".to_string(), Value::String(message));
    item.insert(
        "attachments".to_string(),
        Value::Array(normalize_attachment_metas(record.get("attachments"))),
    );
    item.insert(
        "references".to_string(),
        Value::Array(normalize_references(record.get("references"))),
    );
    if let Some(permission_mode) = record
        .get("permissionMode")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "ask" | "auto-review" | "full-access"))
    {
        item.insert(
            "permissionMode".to_string(),
            Value::String(permission_mode.to_string()),
        );
    }
    let status = match record.get("status").and_then(Value::as_str) {
        Some("sending") => "sending",
        Some("failed") => "failed",
        _ => "queued",
    };
    item.insert("status".to_string(), Value::String(status.to_string()));
    item.insert("createdAt".to_string(), Value::String(created_at));
    item.insert("updatedAt".to_string(), Value::String(updated_at));
    if let Some(error) = record
        .get("error")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| compact(value, 4000))
    {
        item.insert("error".to_string(), Value::String(error));
    }
    Some(Value::Object(item))
}

fn normalize_attachment_metas(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_attachment_meta)
                .take(6)
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_attachment_meta(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    let id = required_trimmed_text(record.get("id"), 120)?;
    let kind = record.get("kind").and_then(Value::as_str)?;
    if !matches!(kind, "image" | "file") {
        return None;
    }
    let name = required_trimmed_text(record.get("name"), 240)?;
    let mime = required_trimmed_text(record.get("mime"), 120)?;
    let size = json_safe_integer(record.get("size"))?;
    let source_type = if record.get("sourceType").and_then(Value::as_str) == Some("runtime-path") {
        "runtime-path"
    } else {
        "inline"
    };
    Some(serde_json::json!({
        "id": id,
        "kind": kind,
        "name": name,
        "mime": mime,
        "size": size,
        "sourceType": source_type,
    }))
}

fn normalize_references(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_reference)
                .take(20)
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_reference(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    if record
        .keys()
        .any(|key| !matches!(key.as_str(), "kind" | "name" | "path"))
    {
        return None;
    }
    let kind = record.get("kind").and_then(Value::as_str)?;
    let name = required_trimmed_text(record.get("name"), 240)?;
    let path = required_trimmed_text(record.get("path"), 4096)?;
    let valid = match kind {
        "skill" => path.starts_with('/'),
        "app" => path.strip_prefix("app://").is_some_and(|id| {
            !id.is_empty() && !id.contains('/') && !id.chars().any(char::is_whitespace)
        }),
        "plugin" => path.strip_prefix("plugin://").is_some_and(|id| {
            !id.is_empty() && !id.contains('/') && !id.chars().any(char::is_whitespace)
        }),
        _ => false,
    };
    valid.then(|| serde_json::json!({ "kind": kind, "name": name, "path": path }))
}

fn normalize_turns(value: Option<&Value>) -> Vec<Value> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut turns = Vec::new();
    for (index, value) in items.iter().enumerate() {
        let Some(record) = value.as_object() else {
            continue;
        };
        let id = match record.get("id") {
            Some(value) if json_truthy(value) => {
                let id = compact(&js_string(value), 240);
                if id.is_empty() {
                    continue;
                }
                id
            }
            None => legacy_turn_id(record, index),
            Some(_) => legacy_turn_id(record, index),
        };
        let Some(status) = normalize_turn_status(record.get("status")) else {
            continue;
        };
        let Some(phase) = normalize_turn_phase(record.get("phase")) else {
            continue;
        };
        let Some(source) = normalize_turn_source(record.get("source")) else {
            continue;
        };
        let Ok(user_messages) = normalize_user_messages(record.get("userMessages")) else {
            continue;
        };
        let context_compactions = normalize_context_compactions(record.get("contextCompactions"));
        let user_prompt = message_text_truthy(record.get("userPrompt"));
        let summary = compact_truthy(record.get("summary"), 1000);
        let last_message = message_text_truthy(record.get("lastMessage"));
        let Some(observed_at) = normalize_optional_turn_timestamp(record.get("observedAt"), true)
        else {
            continue;
        };
        let Some(started_at) = normalize_optional_turn_timestamp(record.get("startedAt"), false)
        else {
            continue;
        };
        let Some(updated_at) = normalize_optional_turn_timestamp(record.get("updatedAt"), false)
        else {
            continue;
        };
        let Some(completed_at) =
            normalize_optional_turn_timestamp(record.get("completedAt"), false)
        else {
            continue;
        };
        let meaningful = user_prompt
            .as_deref()
            .is_some_and(|value| !value.is_empty())
            || user_messages
                .as_ref()
                .is_some_and(|items| !items.is_empty())
            || summary.as_deref().is_some_and(|value| !value.is_empty())
            || last_message
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            || context_compactions
                .as_ref()
                .is_some_and(|items| !items.is_empty());
        if !meaningful {
            continue;
        }
        let mut turn = Map::new();
        turn.insert("id".to_string(), Value::String(id));
        if let Some(provider_turn_id) = compact_truthy(record.get("providerTurnId"), 240) {
            turn.insert(
                "providerTurnId".to_string(),
                Value::String(provider_turn_id),
            );
        }
        if let Some(source) = source {
            turn.insert("source".to_string(), Value::String(source.to_string()));
        }
        if let Some(user_prompt) = user_prompt {
            turn.insert("userPrompt".to_string(), Value::String(user_prompt));
        }
        if let Some(user_messages) = user_messages {
            turn.insert("userMessages".to_string(), Value::Array(user_messages));
        }
        turn.insert("status".to_string(), Value::String(status.to_string()));
        if let Some(phase) = phase {
            turn.insert("phase".to_string(), Value::String(phase.to_string()));
        }
        if let Some(summary) = summary {
            turn.insert("summary".to_string(), Value::String(summary));
        }
        if let Some(last_message) = last_message {
            turn.insert("lastMessage".to_string(), Value::String(last_message));
        }
        if let Some(last_message_item_id) = compact_truthy(record.get("lastMessageItemId"), 240) {
            turn.insert(
                "lastMessageItemId".to_string(),
                Value::String(last_message_item_id),
            );
        }
        if let Some(context_compactions) = context_compactions {
            turn.insert(
                "contextCompactions".to_string(),
                Value::Array(context_compactions),
            );
        }
        turn.insert(
            "revision".to_string(),
            normalize_turn_revision(record.get("revision")),
        );
        let Some(source_priority) = normalize_source_priority(record.get("sourcePriority")) else {
            continue;
        };
        if let Some(source_priority) = source_priority {
            turn.insert("sourcePriority".to_string(), source_priority);
        }
        let Some(snapshot_version) = normalize_snapshot_version(record.get("snapshotVersion"))
        else {
            continue;
        };
        if let Some(snapshot_version) = snapshot_version {
            turn.insert("snapshotVersion".to_string(), snapshot_version);
        }
        for (name, value) in [
            ("observedAt", observed_at),
            ("startedAt", started_at),
            ("updatedAt", updated_at),
            ("completedAt", completed_at),
        ] {
            if let Some(value) = value {
                turn.insert(name.to_string(), Value::String(value));
            }
        }
        turns.push(Value::Object(
            TURN_FIELDS
                .iter()
                .filter_map(|field| {
                    turn.get(*field)
                        .map(|value| ((*field).to_string(), value.clone()))
                })
                .collect(),
        ));
    }
    if turns.len() > 50 {
        turns.drain(0..turns.len() - 50);
    }
    turns
}

fn normalize_optional_turn_timestamp(
    value: Option<&Value>,
    null_is_absent: bool,
) -> Option<Option<String>> {
    match value {
        None => Some(None),
        Some(value) if null_is_absent && !json_truthy(value) => Some(None),
        Some(Value::String(value)) if valid_datetime(value) => Some(Some(value.clone())),
        Some(_) => None,
    }
}

fn normalize_context_compactions(value: Option<&Value>) -> Option<Vec<Value>> {
    let items = value.and_then(Value::as_array)?;
    let mut by_id: Vec<(String, Value)> = Vec::new();
    for item in items {
        let Some(record) = item.as_object() else {
            continue;
        };
        let Some(id) = required_text(record.get("id"), 240) else {
            continue;
        };
        let Some(status) = record
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| matches!(*status, "running" | "completed"))
        else {
            continue;
        };
        let started_at = normalize_iso_timestamp(record.get("startedAt"));
        let completed_at = normalize_iso_timestamp(record.get("completedAt"));
        if let Some((_, previous)) = by_id.iter_mut().find(|(known, _)| known == &id) {
            let previous_status = previous.get("status").and_then(Value::as_str);
            let status = if previous_status == Some("completed") || status == "completed" {
                "completed"
            } else {
                "running"
            };
            let started_at = started_at.or_else(|| {
                previous
                    .get("startedAt")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            });
            let completed_at = completed_at.or_else(|| {
                previous
                    .get("completedAt")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            });
            let mut value = Map::new();
            value.insert("id".to_string(), Value::String(id));
            value.insert("status".to_string(), Value::String(status.to_string()));
            if let Some(started_at) = started_at {
                value.insert("startedAt".to_string(), Value::String(started_at));
            }
            if let Some(completed_at) = completed_at {
                value.insert("completedAt".to_string(), Value::String(completed_at));
            }
            *previous = Value::Object(value);
        } else {
            let mut value = Map::new();
            value.insert("id".to_string(), Value::String(id.clone()));
            value.insert("status".to_string(), Value::String(status.to_string()));
            if let Some(started_at) = started_at {
                value.insert("startedAt".to_string(), Value::String(started_at));
            }
            if let Some(completed_at) = completed_at {
                value.insert("completedAt".to_string(), Value::String(completed_at));
            }
            by_id.push((id, Value::Object(value)));
        }
    }
    let mut values = by_id
        .into_iter()
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    if values.len() > 20 {
        values.drain(0..values.len() - 20);
    }
    (!values.is_empty()).then_some(values)
}

fn normalize_user_messages(value: Option<&Value>) -> Result<Option<Vec<Value>>, ()> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Ok(None);
    };
    let mut by_id: Vec<(String, Option<Value>)> = Vec::new();
    for item in items {
        let Some(record) = item.as_object() else {
            continue;
        };
        let Some(id_value) = record.get("id").and_then(Value::as_str) else {
            continue;
        };
        if id_value.is_empty() {
            continue;
        }
        let id = compact(id_value, 240);
        let Some(text) = record.get("text").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() {
            if !by_id.iter().any(|(known, _)| known.is_empty()) {
                by_id.push((String::new(), None));
            }
            continue;
        }
        let attachments = record
            .get("attachments")
            .and_then(Value::as_array)
            .map(|attachments| {
                attachments
                    .iter()
                    .filter_map(normalize_conversation_attachment)
                    .take(6)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let message = serde_json::json!({
            "id": id,
            "text": text.trim(),
            "attachments": attachments,
        });
        if let Some((_, existing)) = by_id.iter_mut().find(|(known, _)| known == &id) {
            let replace = existing.as_ref().is_none_or(|existing| {
                existing
                    .get("attachments")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or_default()
                    <= attachments.len()
            });
            if replace {
                *existing = Some(message);
            }
        } else {
            by_id.push((id, Some(message)));
        }
    }
    if by_id.len() > 100 {
        by_id.drain(0..by_id.len() - 100);
    }
    if by_id.iter().any(|(_, value)| value.is_none()) {
        return Err(());
    }
    let values = by_id
        .into_iter()
        .filter_map(|(_, value)| value)
        .collect::<Vec<_>>();
    Ok((!values.is_empty()).then_some(values))
}

fn normalize_conversation_attachment(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    let id = required_trimmed_text(record.get("id"), 120)?;
    let kind = record.get("kind").and_then(Value::as_str)?;
    if !matches!(kind, "image" | "file") {
        return None;
    }
    let name = required_trimmed_text(record.get("name"), 240)?;
    let mime = required_trimmed_text(record.get("mime"), 120)?;
    let size = json_safe_integer(record.get("size"))?;
    let content_state = match record.get("contentState") {
        None => "available",
        Some(Value::String(value))
            if matches!(value.as_str(), "available" | "expired" | "missing") =>
        {
            value
        }
        Some(_) => return None,
    };
    Some(serde_json::json!({
        "id": id,
        "kind": kind,
        "name": name,
        "mime": mime,
        "size": size,
        "contentState": content_state,
    }))
}

fn normalize_tool(value: Option<&Value>) -> Option<Value> {
    let record = value.and_then(Value::as_object)?;
    let name = required_text(record.get("name"), 120)?;
    let mut tool = Map::new();
    if let Some(id) = record
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| compact(value, 240))
    {
        tool.insert("id".to_string(), Value::String(id));
    }
    if let Some(kind) = record
        .get("kind")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| compact(value, 80))
    {
        tool.insert("kind".to_string(), Value::String(kind));
    }
    tool.insert("name".to_string(), Value::String(name));
    if let Some(input_preview) = record
        .get("inputPreview")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| compact(value, 500))
    {
        tool.insert("inputPreview".to_string(), Value::String(input_preview));
    }
    if let Some(started_at) = record
        .get("startedAt")
        .and_then(Value::as_str)
        .filter(|value| valid_datetime(value))
    {
        tool.insert(
            "startedAt".to_string(),
            Value::String(started_at.to_string()),
        );
    }
    Some(Value::Object(tool))
}

fn normalize_sub_agents(value: Option<&Value>) -> Vec<Value> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut by_thread: HashMap<String, Value> = HashMap::new();
    for item in items {
        let Some(record) = item.as_object() else {
            continue;
        };
        let Some(thread_id) = required_trimmed_text(record.get("threadId"), 240) else {
            continue;
        };
        let Some(status) = record
            .get("status")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "pending-init"
                        | "running"
                        | "interrupted"
                        | "completed"
                        | "errored"
                        | "shutdown"
                        | "not-found"
                )
            })
        else {
            continue;
        };
        if status == "completed" {
            continue;
        }
        let Some(updated_at) = record
            .get("updatedAt")
            .and_then(Value::as_str)
            .filter(|value| valid_datetime(value))
        else {
            continue;
        };
        let activity = match record.get("activity").and_then(Value::as_str) {
            None => None,
            Some(value @ ("started" | "interacted" | "interrupted")) => Some(value),
            Some(_) => continue,
        };
        let path = optional_trimmed_text(record.get("path"), 4096);
        let message = optional_trimmed_text(record.get("message"), 1000);
        let mut agent = Map::new();
        agent.insert("threadId".to_string(), Value::String(thread_id.clone()));
        if let Some(path) = path {
            agent.insert("path".to_string(), Value::String(path));
        }
        agent.insert("status".to_string(), Value::String(status.to_string()));
        if let Some(activity) = activity {
            agent.insert("activity".to_string(), Value::String(activity.to_string()));
        }
        if let Some(message) = message {
            agent.insert("message".to_string(), Value::String(message));
        }
        agent.insert(
            "updatedAt".to_string(),
            Value::String(updated_at.to_string()),
        );
        let candidate = Value::Object(agent);
        let replace = by_thread
            .get(&thread_id)
            .and_then(|previous| previous.get("updatedAt").and_then(Value::as_str))
            .is_none_or(|previous| timestamp_millis(updated_at) >= timestamp_millis(previous));
        if replace {
            by_thread.insert(thread_id, candidate);
        }
    }
    let mut values = by_thread.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| {
        let left_updated = left
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let right_updated = right
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        timestamp_millis(right_updated)
            .cmp(&timestamp_millis(left_updated))
            .then_with(|| {
                left.get("threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .cmp(
                        right
                            .get("threadId")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    )
            })
    });
    values.truncate(50);
    values
}

fn normalize_lineage(value: Option<&Value>) -> Option<Value> {
    let record = value.and_then(Value::as_object)?;
    let parent = required_trimmed_text(record.get("parentProviderSessionId"), 240)?;
    match record.get("kind").and_then(Value::as_str) {
        Some("fork") => {
            let mut lineage = Map::new();
            lineage.insert("kind".to_string(), Value::String("fork".to_string()));
            lineage.insert("parentProviderSessionId".to_string(), Value::String(parent));
            if let Some(Value::String(through_turn_id)) = record.get("throughTurnId") {
                let through_turn_id = through_turn_id.trim();
                if through_turn_id.is_empty() || through_turn_id.chars().count() > 240 {
                    return None;
                }
                lineage.insert(
                    "throughTurnId".to_string(),
                    Value::String(through_turn_id.to_string()),
                );
            }
            Some(Value::Object(lineage))
        }
        Some("subagent") => Some(serde_json::json!({
            "kind": "subagent",
            "parentProviderSessionId": parent,
        })),
        _ => None,
    }
}

fn normalize_model_selection(value: Option<&Value>) -> Option<Value> {
    let record = value.and_then(Value::as_object)?;
    if record.keys().any(|key| {
        !matches!(
            key.as_str(),
            "modelEntityId" | "modelName" | "modelUpstreamName"
        )
    }) {
        return None;
    }
    let model_entity_id = required_trimmed_text(record.get("modelEntityId"), 120)?;
    let model_name = required_trimmed_text(record.get("modelName"), 240)?;
    let mut selection = Map::new();
    selection.insert("modelEntityId".to_string(), Value::String(model_entity_id));
    selection.insert("modelName".to_string(), Value::String(model_name));
    match record.get("modelUpstreamName") {
        None => {}
        Some(Value::String(model_upstream_name)) => {
            let model_upstream_name = model_upstream_name.trim();
            if model_upstream_name.is_empty() || model_upstream_name.chars().count() > 240 {
                return None;
            }
            selection.insert(
                "modelUpstreamName".to_string(),
                Value::String(model_upstream_name.to_string()),
            );
        }
        Some(_) => return None,
    }
    Some(Value::Object(selection))
}

fn normalize_reasoning_effort(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| {
            matches!(
                *value,
                "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
            )
        })
        .map(ToString::to_string)
}

fn normalize_actions(value: Option<&Value>) -> Option<Value> {
    let record = value.and_then(Value::as_object);
    let mut actions = Map::new();
    for name in [
        "send",
        "interrupt",
        "approval",
        "fork",
        "rename",
        "openApp",
        "close",
    ] {
        if let Some(value) = record
            .and_then(|record| record.get(name))
            .and_then(Value::as_bool)
        {
            actions.insert(name.to_string(), Value::Bool(value));
        }
    }
    (!actions.is_empty()).then_some(Value::Object(actions))
}

fn normalize_string_array(
    value: Option<&Value>,
    max_items: usize,
    max_length: usize,
) -> Option<Vec<String>> {
    let items = value.and_then(Value::as_array)?;
    let mut seen = std::collections::HashSet::new();
    let mut values = items
        .iter()
        .map(|value| compact(&js_compact_string(value), max_length))
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.clone()))
        .take(max_items)
        .collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        values.shrink_to_fit();
        Some(values)
    }
}

fn normalize_lifecycle(value: Option<&Value>) -> String {
    let normalized = match value {
        Some(value) if json_truthy(value) => js_string(value).trim().to_lowercase(),
        _ => String::new(),
    };
    match normalized.as_str() {
        "waiting" => "waiting",
        "failed" => "failed",
        "idle" | "completed" | "stale" | "stopped" | "exited" => "idle",
        _ => "running",
    }
    .to_string()
}

fn normalize_phase(value: Option<&Value>) -> Option<String> {
    match value {
        None => Some("unknown".to_string()),
        Some(Value::String(value)) if is_phase(value) => Some(value.clone()),
        Some(Value::String(_)) => Some("unknown".to_string()),
        Some(value) if is_phase(&js_string(value)) => None,
        Some(_) => Some("unknown".to_string()),
    }
}

fn is_phase(value: &str) -> bool {
    matches!(
        value,
        "thinking" | "tool" | "editing" | "approval" | "responding" | "unknown"
    )
}

fn is_source(value: &str) -> bool {
    matches!(
        value,
        "control"
            | "realtime"
            | "adapter-snapshot"
            | "transcript-tail"
            | "transcript-scan"
            | "process-scan"
            | "app-session"
    )
}

fn required_text(value: Option<&Value>, max: usize) -> Option<String> {
    let value = value?.as_str()?;
    let value = compact(value, max);
    (!value.is_empty()).then_some(value)
}

fn required_trimmed_text(value: Option<&Value>, max: usize) -> Option<String> {
    let value = value?.as_str()?.trim();
    (!value.is_empty() && value.chars().count() <= max).then(|| value.to_string())
}

fn optional_text(value: Option<&Value>, max: usize) -> Option<String> {
    match value {
        Some(Value::String(value)) if !value.is_empty() => Some(compact(value, max)),
        _ => None,
    }
}

fn optional_trimmed_text(value: Option<&Value>, max: usize) -> Option<String> {
    value.and_then(Value::as_str).and_then(|value| {
        let value = value.trim();
        (value.chars().count() <= max).then(|| value.to_string())
    })
}

fn compact_truthy(value: Option<&Value>, max: usize) -> Option<String> {
    let value = value?;
    json_truthy(value).then(|| compact(&js_string(value), max))
}

fn message_text_truthy(value: Option<&Value>) -> Option<String> {
    let value = value?;
    json_truthy(value).then(|| js_string(value).trim().to_string())
}

fn optional_message_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if !json_truthy(value) {
        return None;
    }
    Some(js_string(value).trim().to_string())
}

fn required_message_text(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty() && text.chars().count() <= max).then(|| text.to_string())
}

fn required_timestamp(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| valid_datetime(value))
        .map(ToString::to_string)
}

fn valid_datetime(value: &str) -> bool {
    let Some(date_time) = value.strip_suffix('Z') else {
        return false;
    };
    let Some((date, time)) = date_time.split_once('T') else {
        return false;
    };
    if date.len() != 10
        || date.as_bytes().get(4) != Some(&b'-')
        || date.as_bytes().get(7) != Some(&b'-')
        || !date[..4].bytes().all(|value| value.is_ascii_digit())
        || !date[5..7].bytes().all(|value| value.is_ascii_digit())
        || !date[8..10].bytes().all(|value| value.is_ascii_digit())
    {
        return false;
    }
    let year = date[..4].parse::<u32>().unwrap_or_default();
    let month = date[5..7].parse::<u32>().unwrap_or_default();
    let day = date[8..10].parse::<u32>().unwrap_or_default();
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100)) => {
            29
        }
        2 => 28,
        _ => return false,
    };
    if day == 0 || day > days {
        return false;
    }
    let clock = match time.split_once('.') {
        Some((clock, fraction))
            if !fraction.is_empty() && fraction.bytes().all(|value| value.is_ascii_digit()) =>
        {
            clock
        }
        Some(_) => return false,
        None => time,
    };
    if clock.len() != 8 {
        return false;
    }
    if clock.as_bytes().get(2) != Some(&b':') || clock.as_bytes().get(5) != Some(&b':') {
        return false;
    }
    if !clock[..2].bytes().all(|value| value.is_ascii_digit())
        || !clock[3..5].bytes().all(|value| value.is_ascii_digit())
        || !clock[6..8].bytes().all(|value| value.is_ascii_digit())
    {
        return false;
    }
    let hour = clock[..2].parse::<u32>().unwrap_or_default();
    let minute = clock[3..5].parse::<u32>().unwrap_or_default();
    let second = clock[6..8].parse::<u32>().unwrap_or_default();
    hour <= 23 && minute <= 59 && second <= 59
}

fn timestamp_millis(value: &str) -> i64 {
    normalize_datetime_for_chrono(value)
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or_default()
}

fn normalize_iso_timestamp(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .and_then(parse_js_date)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn parse_js_date(value: &str) -> Option<DateTime<Utc>> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(normalized) = normalize_datetime_for_chrono(value) {
        if let Ok(value) = DateTime::parse_from_rfc3339(&normalized) {
            return Some(value.with_timezone(&Utc));
        }
    }
    if let Ok(value) = DateTime::parse_from_rfc2822(value) {
        return Some(value.with_timezone(&Utc));
    }
    let normalized = value
        .strip_suffix('z')
        .map(|value| format!("{value}Z"))
        .unwrap_or_else(|| value.to_string());
    if let Some((date, time)) = normalized.split_once(' ') {
        let candidate = format!("{date}T{time}");
        if let Ok(value) = DateTime::parse_from_rfc3339(&candidate) {
            return Some(value.with_timezone(&Utc));
        }
    }
    if let Ok(value) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(Utc.from_utc_datetime(&value.and_hms_opt(0, 0, 0)?));
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f%:z",
        "%Y-%m-%dT%H:%M:%S%.f%z",
        "%Y-%m-%d %H:%M:%S%.f%:z",
        "%Y-%m-%d %H:%M:%S%.f%z",
        "%Y/%m/%d %H:%M:%S%.fZ",
        "%Y/%m/%dT%H:%M:%S%.fZ",
    ] {
        if let Ok(value) = DateTime::parse_from_str(&normalized, format) {
            return Some(value.with_timezone(&Utc));
        }
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(value) = NaiveDateTime::parse_from_str(value, format) {
            return Local
                .from_local_datetime(&value)
                .earliest()
                .map(|value| value.with_timezone(&Utc));
        }
    }
    for format in ["%Y/%m/%d %H:%M:%S%.f", "%Y/%m/%dT%H:%M:%S%.f"] {
        if let Ok(value) = NaiveDateTime::parse_from_str(value, format) {
            return Local
                .from_local_datetime(&value)
                .earliest()
                .map(|value| value.with_timezone(&Utc));
        }
    }
    None
}

fn normalize_datetime_for_chrono(value: &str) -> Option<String> {
    if valid_datetime(value) {
        let date_time = value.strip_suffix('Z')?;
        let (date, time) = date_time.split_once('T')?;
        let time = match time.split_once('.') {
            Some((clock, fraction)) => {
                let fraction = &fraction[..fraction.len().min(9)];
                format!("{clock}.{fraction}")
            }
            None => time.to_string(),
        };
        return Some(format!("{date}T{time}Z"));
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.to_rfc3339())
}

fn normalize_non_negative_integer(value: Option<&Value>) -> u64 {
    let number = json_number(value).unwrap_or_default();
    if !number.is_finite()
        || number.fract() != 0.0
        || !(0.0..18_446_744_073_709_551_616.0).contains(&number)
    {
        return 0;
    }
    number as u64
}

fn normalize_turn_status(value: Option<&Value>) -> Option<&str> {
    match value {
        None => Some("completed"),
        Some(value) if !json_truthy(value) => Some("completed"),
        Some(Value::String(value))
            if matches!(
                value.as_str(),
                "queued" | "running" | "waiting" | "completed" | "failed"
            ) =>
        {
            Some(value)
        }
        Some(_) => None,
    }
}

fn normalize_turn_phase(value: Option<&Value>) -> Option<Option<&str>> {
    match value {
        None => Some(None),
        Some(Value::String(value)) if is_phase(value) => Some(Some(value)),
        Some(_) => None,
    }
}

fn normalize_turn_source(value: Option<&Value>) -> Option<Option<&str>> {
    match value {
        None => Some(None),
        Some(value) if !json_truthy(value) => Some(None),
        Some(Value::String(value)) if is_source(value) => Some(Some(value)),
        Some(_) => None,
    }
}

fn normalize_turn_revision(value: Option<&Value>) -> Value {
    let number = json_number(value).unwrap_or_default().max(0.0);
    if number.is_finite() && number.fract() == 0.0 && number <= u64::MAX as f64 {
        return safe_integer_value(number);
    }
    serde_json::Number::from_f64(number)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn normalize_source_priority(value: Option<&Value>) -> Option<Option<Value>> {
    let Some(Value::Number(value)) = value else {
        return Some(None);
    };
    let Some(number) = value.as_f64().filter(|value| value.fract() == 0.0) else {
        return Some(None);
    };
    if !(0.0..=100.0).contains(&number) {
        return None;
    }
    Some(Some(safe_integer_value(number)))
}

fn normalize_snapshot_version(value: Option<&Value>) -> Option<Option<Value>> {
    let Some(Value::Number(value)) = value else {
        return Some(None);
    };
    if !value
        .as_f64()
        .is_some_and(|value| value.is_finite() && value.fract() == 0.0)
    {
        return Some(None);
    }
    Some(Some(Value::Number(value.clone())))
}

fn safe_integer_value(number: f64) -> Value {
    Value::from(number as u64)
}

fn normalize_story_id(value: Option<&Value>) -> Option<String> {
    required_trimmed_text(value, 120)
}

fn json_safe_integer(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&number))
        .then_some(number as u64)
}

fn non_negative_integer(value: Option<&Value>) -> Option<u64> {
    value?.as_u64()
}

fn json_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::Number(value) => value.as_f64(),
        Value::String(value) => {
            let value = value.trim();
            if value.is_empty() {
                Some(0.0)
            } else {
                value.parse::<f64>().ok()
            }
        }
        Value::Array(values) if values.is_empty() => Some(0.0),
        Value::Array(values) if values.len() == 1 => json_number(values.first()),
        _ => None,
    }
}

fn json_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => js_number_string(value.as_f64().unwrap_or_default()),
        Value::String(value) => value.clone(),
        Value::Array(values) => js_array_string(values),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn js_compact_string(value: &Value) -> String {
    if value.is_null() {
        String::new()
    } else {
        js_string(value)
    }
}

fn js_array_string(values: &[Value]) -> String {
    values
        .iter()
        .map(|value| match value {
            Value::Null => String::new(),
            Value::Array(values) => js_array_string(values),
            _ => js_string(value),
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn js_number_string(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    value.to_string()
}

fn queue_status_rank(item: &Value) -> u8 {
    match item.get("status").and_then(Value::as_str) {
        Some("sending") => 0,
        Some("queued") => 1,
        _ => 2,
    }
}

fn compact(value: &str, max: usize) -> String {
    crate::compact_text(value, max)
}

fn legacy_turn_id(record: &Map<String, Value>, index: usize) -> String {
    let seed = ["userPrompt", "updatedAt", "lastMessage", "summary"]
        .iter()
        .filter_map(|field| record.get(*field))
        .find(|value| json_truthy(value))
        .map(js_string)
        .unwrap_or_default();
    format!("turn_legacy_{index}_{}", stable_turn_part(&seed))
}

fn stable_turn_part(value: &str) -> String {
    let text = compact(value, 120);
    let mut slug = String::new();
    let mut pending_separator = false;
    for character in text.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-') {
            if pending_separator && !slug.is_empty() {
                slug.push('_');
            }
            pending_separator = false;
            slug.push(character);
        } else {
            pending_separator = true;
        }
    }
    let hash = hex::encode(Sha1::digest(text.as_bytes()));
    let hash = &hash[..10];
    if slug.is_empty() {
        hash.to_string()
    } else {
        format!("{slug}_{hash}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decoder_projects_known_fields_and_normalizes_nested_records() {
        let value: Value = serde_json::from_str(r#"{
            "id": " ses_0000000000001 ",
            "agent": "codex",
            "creationSource": "ai-session",
            "providerSessionId": " thread-1 ",
            "lineage": {
                "kind": "fork",
                "parentProviderSessionId": "parent",
                "throughTurnId": "turn-parent",
                "future": true
            },
            "modelSelection": {
                "modelEntityId": "mdl_1",
                "modelName": "Model",
                "modelUpstreamName": "upstream",
                "future": true
            },
            "reasoningEffort": "high",
            "storyId": "story-1",
            "appBindingKeys": ["app:one", "app:one", " ", "claude-short:abc"],
            "actions": { "send": true, "interrupt": false, "future": true },
            "title": "Title",
            "cwd": "/workspace",
            "userPrompt": "  Prompt  ",
            "turns": [
                {
                    "id": "turn-1",
                    "providerTurnId": "provider-turn",
                    "source": "realtime",
                    "userPrompt": "Prompt",
                    "userMessages": [
                        {
                            "id": "msg-1",
                            "text": "Hello",
                            "attachments": [{ "id": "att-1", "kind": "file", "name": "a.txt", "mime": "text/plain", "size": 3, "future": true }],
                            "future": true
                        }
                    ],
                    "status": "completed",
                    "phase": "responding",
                    "summary": "Summary",
                    "lastMessage": "Answer",
                    "lastMessageItemId": "item-1",
                    "contextCompactions": [{ "id": "compact-1", "status": "completed", "startedAt": "2026-11-02T00:00:00Z", "future": true }],
                    "revision": 2,
                    "sourcePriority": 80,
                    "snapshotVersion": 4,
                    "observedAt": "2026-11-02T00:01:00.000Z",
                    "startedAt": "2026-11-02T00:00:00.000Z",
                    "updatedAt": "2026-11-02T00:01:00.000Z",
                    "future": true
                },
                { "id": "empty-turn", "status": "completed" }
            ],
            "status": "completed",
            "phase": "approval",
            "currentTool": { "id": "tool-1", "name": "shell", "inputPreview": "ls", "startedAt": "2026-11-02T00:00:00.000Z", "future": true },
            "toolCallsSinceLastMessage": "2",
            "subAgents": [
                { "threadId": "sub-1", "status": "running", "activity": "started", "path": "sub", "message": "working", "updatedAt": "2026-11-02T00:00:00.000Z", "future": true },
                { "threadId": "sub-2", "status": "completed", "updatedAt": "2026-11-02T00:00:00.000Z" }
            ],
            "transcriptPath": "/tmp/transcript.jsonl",
            "transcriptSize": 12,
            "startedAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:01:00.000Z",
            "completedAt": "2026-11-02T00:02:00.000Z",
            "error": " error ",
            "counters": { "toolCalls": 1, "edits": 2, "approvals": 3, "future": 1 },
            "queue": {
                "revision": 3,
                "pendingCount": 9,
                "paused": true,
                "items": [
                    {
                        "id": "queue-1",
                        "message": "queued",
                        "attachments": [{ "id": "att-1", "kind": "image", "name": "a.png", "mime": "image/png", "size": 4, "sourceType": "inline", "future": true }],
                        "references": [{ "kind": "skill", "name": "Skill", "path": "/skills/a" }],
                        "permissionMode": "auto-review",
                        "status": "sending",
                        "createdAt": "2026-11-02T00:00:00.000Z",
                        "updatedAt": "2026-11-02T00:01:00.000Z",
                        "future": true
                    }
                ],
                "future": true
            },
            "unread": true,
            "future": true
        }"#).expect("fixture json");

        let session = decode_persisted_session(&value).expect("decoded session");
        assert_eq!(session.id, "ses_0000000000001");
        assert_eq!(session.provider_session_id.as_deref(), Some("thread-1"));
        assert_eq!(session.status, "idle");
        assert_eq!(session.phase, "approval");
        assert_eq!(session.user_prompt.as_deref(), Some("Prompt"));
        assert_eq!(session.error.as_deref(), Some("error"));
        assert_eq!(session.tool_calls_since_last_message, 2);
        assert!(serde_json::to_value(&session)
            .expect("json")
            .get("future")
            .is_none());
        let turns = session.turns.as_ref().expect("turns");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["id"], "turn-1");
        assert_eq!(turns[0].get("future"), None);
        assert_eq!(turns[0]["userMessages"][0]["attachments"][0]["id"], "att-1");
        assert_eq!(
            turns[0]["contextCompactions"][0]["startedAt"],
            "2026-11-02T00:00:00.000Z"
        );
        assert_eq!(session.current_tool.as_ref().unwrap()["name"], "shell");
        assert_eq!(session.sub_agents.len(), 1);
        assert_eq!(session.queue.revision, 3);
        assert_eq!(session.queue.pending_count, 1);
        assert_eq!(session.queue.paused, Some(true));
        assert_eq!(session.queue.items[0]["references"][0]["kind"], "skill");
        assert_eq!(
            session.app_binding_keys.as_deref(),
            Some(["app:one".to_string(), "claude-short:abc".to_string()].as_slice())
        );
    }

    #[test]
    fn decoder_rejects_records_without_required_identity() {
        assert!(decode_persisted_session(&json!({ "id": "", "agent": "codex", "startedAt": "2026-11-02T00:00:00Z", "updatedAt": "2026-11-02T00:00:00Z" })).is_none());
        assert!(decode_persisted_session(&json!({ "id": "ses_1", "agent": "codex", "startedAt": "not-a-time", "updatedAt": "2026-11-02T00:00:00Z" })).is_none());
    }

    #[test]
    fn decoder_schema_limits_count_unicode_code_points_like_zod() {
        let accepted = "😀".repeat(240);
        assert!(normalize_lineage(Some(&json!({
            "kind": "fork",
            "parentProviderSessionId": "parent",
            "throughTurnId": accepted.clone(),
        })))
        .is_some());
        assert!(normalize_model_selection(Some(&json!({
            "modelEntityId": "model-1",
            "modelName": "Model",
            "modelUpstreamName": accepted,
        })))
        .is_some());

        let rejected = "😀".repeat(241);
        assert!(normalize_lineage(Some(&json!({
            "kind": "fork",
            "parentProviderSessionId": "parent",
            "throughTurnId": rejected.clone(),
        })))
        .is_none());
        assert!(normalize_model_selection(Some(&json!({
            "modelEntityId": "model-1",
            "modelName": "Model",
            "modelUpstreamName": rejected,
        })))
        .is_none());
    }

    fn minimal_session() -> Value {
        json!({
            "id": "ses_1",
            "agent": "codex",
            "startedAt": "2026-11-02T00:00:00Z",
            "updatedAt": "2026-11-02T00:00:00Z"
        })
    }

    #[test]
    fn decoder_matches_node_empty_timestamps_and_turn_defaults() {
        let empty = decode_persisted_session(&minimal_session()).expect("empty session");
        assert_eq!(empty.turns, Some(Vec::new()));

        let mut offset = minimal_session();
        offset["startedAt"] = json!("2026-11-02T08:00:00+08:00");
        assert!(decode_persisted_session(&offset).is_none());

        let mut fractional = minimal_session();
        fractional["startedAt"] = json!("2026-11-02T00:00:00.1234567890Z");
        assert!(decode_persisted_session(&fractional).is_some());

        let mut session = minimal_session();
        session["userPrompt"] = json!(" ");
        session["turns"] = json!([{
            "id": "turn-defaults",
            "userPrompt": " ",
            "lastMessage": "answer",
            "status": ""
        }]);
        let session = decode_persisted_session(&session).expect("defaulted turn");
        assert_eq!(session.user_prompt.as_deref(), Some(""));
        assert_eq!(session.turns.as_ref().unwrap()[0]["status"], "completed");
        assert_eq!(session.turns.as_ref().unwrap()[0]["userPrompt"], "");

        let mut revision = minimal_session();
        revision["turns"] = json!([{ "id": "fractional", "userPrompt": "x", "revision": 1.5 }]);
        assert_eq!(
            decode_persisted_session(&revision)
                .expect("session")
                .turns
                .unwrap()[0]["revision"],
            1.5
        );

        let mut snapshot = minimal_session();
        snapshot["turns"] = json!([{ "id": "snapshot", "userPrompt": "x", "snapshotVersion": -1 }]);
        assert_eq!(
            decode_persisted_session(&snapshot)
                .expect("session")
                .turns
                .unwrap()[0]["snapshotVersion"],
            -1
        );

        let mut priority = minimal_session();
        priority["turns"] = json!([{ "id": "priority", "userPrompt": "x", "sourcePriority": 101 }]);
        assert!(decode_persisted_session(&priority)
            .expect("session")
            .turns
            .unwrap()
            .is_empty());
    }

    #[test]
    fn decoder_keeps_non_safe_counters_and_normalizes_date_parse_timestamps() {
        let mut session = minimal_session();
        session["counters"] = json!({
            "toolCalls": 9_007_199_254_740_992u64,
            "edits": "3",
            "approvals": -1
        });
        let decoded = decode_persisted_session(&session).expect("large counters");
        assert_eq!(decoded.counters.tool_calls, 9_007_199_254_740_992);
        assert_eq!(decoded.counters.edits, 3);
        assert_eq!(decoded.counters.approvals, 0);

        let mut session = minimal_session();
        session["turns"] = json!([{
            "id": "turn-1",
            "userPrompt": "hello",
            "status": "completed",
            "contextCompactions": [{
                "id": "compact-1",
                "status": "completed",
                "startedAt": "2026-11-02 08:00:00+08:00",
                "completedAt": "2026-11-02"
            }]
        }]);
        let decoded = decode_persisted_session(&session).expect("date parse timestamps");
        let compaction = &decoded.turns.as_ref().expect("turns")[0]["contextCompactions"][0];
        assert_eq!(compaction["startedAt"], "2026-11-02T00:00:00.000Z");
        assert_eq!(compaction["completedAt"], "2026-11-02T00:00:00.000Z");
    }

    #[test]
    fn decoder_matches_node_nested_strictness_and_trim_semantics() {
        let mut session = minimal_session();
        session["modelSelection"] = json!({
            "modelEntityId": "mdl_1",
            "modelName": " Model ",
            "future": true
        });
        session["subAgents"] = json!([{
            "threadId": " sub-1 ",
            "path": " a   b ",
            "status": "running",
            "updatedAt": "2026-11-02T00:00:00Z"
        }]);
        session["queue"] = json!({
            "revision": 1,
            "items": [{
                "id": "queue-1",
                "messageId": "   ",
                "message": "queued",
                "createdAt": "2026-11-02T00:00:00Z",
                "updatedAt": "2026-11-02T00:00:00Z",
                "references": [
                    { "kind": "skill", "name": "Skill", "path": "/a  b", "future": true },
                    { "kind": "skill", "name": " Skill ", "path": "/a  b" }
                ]
            }]
        });

        let session = decode_persisted_session(&session).expect("session");
        assert!(session.model_selection.is_none());
        assert_eq!(session.sub_agents[0]["threadId"], "sub-1");
        assert_eq!(session.sub_agents[0]["path"], "a   b");
        assert!(session.queue.items[0].get("messageId").is_none());
        assert_eq!(
            session.queue.items[0]["references"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(session.queue.items[0]["references"][0]["name"], "Skill");
        assert_eq!(session.queue.items[0]["references"][0]["path"], "/a  b");

        let mut invalid_cwd = minimal_session();
        invalid_cwd["cwdFolderId"] = json!(" ");
        assert!(decode_persisted_session(&invalid_cwd).is_none());
    }

    #[test]
    fn decoder_matches_node_javascript_coercion_edges() {
        let mut session = minimal_session();
        session["status"] = json!(["WAITING"]);
        session["phase"] = json!("thinking");
        session["toolCallsSinceLastMessage"] = json!(1.5);
        session["modelSelection"] = json!({
            "modelEntityId": "mdl_1",
            "modelName": "Model",
            "modelUpstreamName": null
        });
        session["appBindingKeys"] = json!([null, ["a", null], 1]);
        session["queue"] = json!({ "revision": 1.5, "items": [] });
        let session = decode_persisted_session(&session).expect("session");
        assert_eq!(session.status, "waiting");
        assert_eq!(session.phase, "thinking");
        assert_eq!(session.tool_calls_since_last_message, 0);
        assert!(session.model_selection.is_none());
        assert_eq!(
            session.app_binding_keys.as_deref(),
            Some(["a,".to_string(), "1".to_string()].as_slice())
        );
        assert_eq!(session.queue.revision, 0);

        let mut invalid_phase = minimal_session();
        invalid_phase["phase"] = json!(["thinking"]);
        assert!(decode_persisted_session(&invalid_phase).is_none());

        let mut queue_error = minimal_session();
        queue_error["queue"] = json!({
            "revision": 1,
            "items": [{
                "id": "queue-1",
                "message": "queued",
                "createdAt": "2026-11-02T00:00:00Z",
                "updatedAt": "2026-11-02T00:00:00Z",
                "error": { "future": true }
            }]
        });
        assert!(decode_persisted_session(&queue_error)
            .expect("queue")
            .queue
            .items[0]
            .get("error")
            .is_none());

        let mut legacy = minimal_session();
        legacy["turns"] = json!([{
            "userPrompt": { "future": true },
            "revision": [1]
        }]);
        let turns = decode_persisted_session(&legacy)
            .expect("legacy turn")
            .turns
            .expect("turns");
        assert_eq!(
            turns[0]["id"],
            format!("turn_legacy_0_{}", stable_turn_part("[object Object]"))
        );
        assert_eq!(turns[0]["userPrompt"], "[object Object]");
        assert_eq!(turns[0]["revision"], 1);

        for turn in [
            json!({ "id": "   ", "userPrompt": "x" }),
            json!({ "id": [], "userPrompt": "x" }),
            json!({
                "id": "invalid-message",
                "userPrompt": "x",
                "userMessages": [{ "id": "   ", "text": "message" }]
            }),
        ] {
            let mut session = minimal_session();
            session["turns"] = json!([turn]);
            assert!(decode_persisted_session(&session)
                .expect("session")
                .turns
                .unwrap()
                .is_empty());
        }

        let mut empty_message_id = minimal_session();
        empty_message_id["turns"] = json!([{
            "id": "kept",
            "userPrompt": "x",
            "userMessages": [
                { "id": "", "text": "ignored" },
                { "id": "message", "text": "kept" }
            ]
        }]);
        let turns = decode_persisted_session(&empty_message_id)
            .expect("session")
            .turns
            .expect("turns");
        assert_eq!(turns[0]["userMessages"].as_array().unwrap().len(), 1);
        assert_eq!(turns[0]["userMessages"][0]["id"], "message");

        let mut messages = vec![json!({ "id": "   ", "text": "drop me" })];
        messages.extend((0..100).map(
            |index| json!({ "id": format!("message-{index}"), "text": format!("message {index}") }),
        ));
        let mut bounded_messages = minimal_session();
        bounded_messages["turns"] = json!([{
            "id": "bounded",
            "userPrompt": "x",
            "userMessages": messages
        }]);
        let turns = decode_persisted_session(&bounded_messages)
            .expect("session")
            .turns
            .expect("turns");
        assert_eq!(turns[0]["userMessages"].as_array().unwrap().len(), 100);
        assert_eq!(turns[0]["userMessages"][0]["id"], "message-0");
    }

    #[test]
    fn runtime_sanitizer_drops_empty_turns_before_persisting() {
        let mut session = minimal_session();
        session["turns"] = json!([
            { "id": "empty", "status": "running", "phase": "thinking" },
            { "id": "kept", "userPrompt": "hello" }
        ]);
        let session = sanitize_runtime_session(&session).expect("session");
        let turns = session.turns.expect("turns");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["id"], "kept");
    }

    #[test]
    fn runtime_sanitizer_drops_whitespace_turn_ids_but_keeps_falsy_legacy_ids() {
        let mut session = minimal_session();
        session["turns"] = json!([
            { "id": "   ", "userPrompt": "invalid current id" },
            { "id": false, "userPrompt": "legacy id" },
            { "id": "", "userPrompt": "empty legacy id" }
        ]);
        let session = sanitize_runtime_session(&session).expect("session");
        let turns = session.turns.expect("turns");
        assert_eq!(turns.len(), 2);
        assert!(turns.iter().all(|turn| turn["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("turn_legacy_"))));
        assert_eq!(turns[0]["userPrompt"], "legacy id");
        assert_eq!(turns[1]["userPrompt"], "empty legacy id");
    }
}
