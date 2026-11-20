//! Internal adapter snapshots are one authority transaction. They must not be
//! replayed as realtime starts, user messages or completions: doing so discards
//! accepted turns and assigns a new body revision to the same observation.
use crate::{AiSession, AiSessionModelSelection};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct ProviderSessionSnapshot {
    pub cwd: String,
    pub title: String,
    pub model_selection: Option<AiSessionModelSelection>,
    pub reasoning_effort: Option<String>,
    pub status: String,
    pub phase: String,
    pub turns: Vec<Value>,
    pub active_turn_id: Option<String>,
    pub user_prompt: Option<String>,
    pub last_message: Option<String>,
    pub last_message_item_id: Option<String>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub current_tool: Option<Value>,
    pub tool_calls_since_last_message: u64,
}

fn identity(left: &Value, right: &Value) -> bool {
    ["id", "providerTurnId"].iter().any(|key| {
        left[*key].as_str().is_some_and(|id| {
            right["id"].as_str() == Some(id) || right["providerTurnId"].as_str() == Some(id)
        })
    })
}
fn has_response(turn: &Value) -> bool {
    ["summary", "lastMessage"]
        .iter()
        .any(|key| turn[*key].as_str().is_some_and(|s| !s.is_empty()))
}
fn priority(turn: &Value) -> u64 {
    turn["sourcePriority"]
        .as_u64()
        .unwrap_or_else(|| match turn["source"].as_str() {
            Some("control") => 90,
            Some("realtime") => 80,
            Some("adapter-snapshot") => 60,
            Some("transcript-tail") => 50,
            Some("app-session") => 40,
            Some("process-scan") => 30,
            Some("transcript-scan") => 20,
            _ => 0,
        })
}
fn merge_turns(existing: &[Value], incoming: &[Value]) -> Vec<Value> {
    let mut turns = existing.to_vec();
    for next in incoming {
        if let Some(index) = turns.iter().position(|turn| identity(turn, next)) {
            let old = &turns[index];
            // Same source precedence as the Node owner. A first response may
            // enrich a control/realtime placeholder; older empty observations
            // cannot replace a realtime failure or accepted message.
            if priority(next) < priority(old) && (!has_response(next) || has_response(old)) {
                continue;
            }
            let revision = old["revision"]
                .as_u64()
                .unwrap_or(0)
                .max(next["revision"].as_u64().unwrap_or(0));
            let mut merged = old.clone();
            let same_body = [
                "status",
                "phase",
                "userPrompt",
                "summary",
                "lastMessage",
                "lastMessageItemId",
                "userMessages",
            ]
            .iter()
            .all(|key| next[*key].is_null() || old[*key] == next[*key]);
            let object = merged.as_object_mut().expect("normalized turn");
            for (key, value) in next.as_object().expect("adapter turn") {
                if value.is_null()
                    || key == "id"
                    || key == "revision"
                    || (same_body
                        && matches!(key.as_str(), "observedAt" | "updatedAt" | "completedAt"))
                {
                    continue;
                }
                if key == "userMessages" {
                    let mut messages = old["userMessages"].as_array().cloned().unwrap_or_default();
                    for message in value.as_array().into_iter().flatten() {
                        if let Some(index) =
                            messages.iter().position(|old| old["id"] == message["id"])
                        {
                            messages[index] = message.clone();
                        } else {
                            messages.push(message.clone());
                        }
                    }
                    if messages.len() > 100 {
                        messages.drain(0..messages.len() - 100);
                    }
                    object.insert(key.clone(), json!(messages));
                } else {
                    object.insert(key.clone(), value.clone());
                }
            }
            object.insert("revision".to_string(), json!(revision));
            turns[index] = merged;
        } else {
            turns.push(next.clone());
        }
    }
    if turns.len() > 50 {
        turns.drain(..turns.len() - 50);
    }
    turns
}

pub(crate) fn apply_snapshot(session: &mut AiSession, snapshot: ProviderSessionSnapshot) -> bool {
    let before = session.clone();
    if !snapshot.cwd.is_empty() {
        session.cwd = Some(snapshot.cwd);
    }
    if !snapshot.title.is_empty() {
        session.title = Some(snapshot.title);
    }
    if let Some(model) = snapshot.model_selection {
        session.model_selection = serde_json::to_value(model).ok();
    }
    if snapshot.reasoning_effort.is_some() {
        session.reasoning_effort = snapshot.reasoning_effort;
    }
    let previous = session.turns.as_deref().unwrap_or_default();
    let active = session
        .active_turn_id
        .as_ref()
        .and_then(|id| previous.iter().find(|turn| turn["id"] == *id));
    let incoming_active = session.active_turn_id.as_ref().and_then(|id| {
        snapshot
            .turns
            .iter()
            .find(|turn| turn["id"] == *id || turn["providerTurnId"] == *id)
    });
    // prompt_async returns before its durable transcript can be read. Retain
    // the accepted active turn until a snapshot actually contains its identity.
    let stale = active.is_some_and(|turn| {
        matches!(turn["status"].as_str(), Some("running" | "waiting")) && !has_response(turn)
    }) && incoming_active.is_none();
    if stale {
        return before != *session;
    }
    let ignore_response =
        active.is_some() && incoming_active.is_some_and(|turn| !has_response(turn));
    let mut turns = merge_turns(previous, &snapshot.turns);
    // Snapshot merge and top lifecycle use the same owner transition. A lower
    // priority body still observes a newer phase without erasing its messages.
    let latest = if let Some(active) = snapshot.active_turn_id.as_deref() {
        turns
            .iter_mut()
            .find(|turn| turn["id"] == active || turn["providerTurnId"] == active)
    } else {
        turns.last_mut()
    };
    if let Some(turn) = latest {
        let status = if snapshot.status == "idle" {
            "completed"
        } else {
            &snapshot.status
        };
        let prompt_changed = snapshot.active_turn_id.is_some()
            && snapshot
                .user_prompt
                .as_ref()
                .is_some_and(|prompt| turn["userPrompt"] != *prompt);
        // The top-level response and turn response share the snapshot rule:
        // while the active transcript has no response, pending-permission
        // descriptions cannot overwrite an already observed response summary.
        let summary = snapshot.summary.as_ref().filter(|_| !ignore_response);
        let summary_changed = summary.is_some_and(|summary| turn["summary"] != *summary);
        let terminal_without_clock =
            matches!(snapshot.status.as_str(), "idle" | "failed") && turn["completedAt"].is_null();
        let changed = turn["status"] != status
            || turn["phase"] != snapshot.phase
            || prompt_changed
            || summary_changed
            || terminal_without_clock;
        let observes_prompt = !has_response(turn)
            && turn["userPrompt"]
                .as_str()
                .is_some_and(|prompt| snapshot.user_prompt.as_deref() == Some(prompt));
        let object = turn.as_object_mut().expect("turn");
        if observes_prompt {
            object.insert("source".to_string(), json!("adapter-snapshot"));
        }
        if prompt_changed {
            object.insert("userPrompt".to_string(), json!(snapshot.user_prompt));
        }
        if let Some(summary) = summary {
            object.insert("summary".to_string(), json!(summary));
        }
        if terminal_without_clock {
            if let Some(clock) = object
                .get("observedAt")
                .or_else(|| object.get("updatedAt"))
                .cloned()
            {
                object.insert("completedAt".to_string(), clock);
            }
        }
        if changed {
            let revision = object.get("revision").and_then(Value::as_u64).unwrap_or(0) + 1;
            object.insert("status".to_string(), json!(status));
            object.insert("phase".to_string(), json!(snapshot.phase));
            object.insert("source".to_string(), json!("adapter-snapshot"));
            object.insert("revision".to_string(), json!(revision));
        }
    }
    let active_status = matches!(snapshot.status.as_str(), "running" | "waiting");
    session.unread = if active_status {
        false
    } else {
        session.unread || matches!(session.status.as_str(), "running" | "waiting")
    };
    session.status = snapshot.status;
    session.phase = snapshot.phase;
    session.active_turn_id = snapshot.active_turn_id;
    session.user_prompt = turns
        .iter()
        .rev()
        .find_map(|turn| turn["userPrompt"].as_str().map(ToString::to_string))
        .or(snapshot.user_prompt)
        .or_else(|| session.user_prompt.clone());
    if ignore_response {
        session.last_message = None;
        session.summary = None;
        session.last_message_item_id = None;
    } else {
        session.last_message = snapshot
            .last_message
            .or_else(|| session.last_message.clone());
        session.summary = snapshot.summary;
        session.last_message_item_id = snapshot
            .last_message_item_id
            .or_else(|| session.last_message_item_id.clone());
    }
    session.error = snapshot.error;
    session.current_tool = if active_status {
        snapshot.current_tool
    } else {
        None
    };
    session.tool_calls_since_last_message = snapshot.tool_calls_since_last_message;
    session.turns = Some(turns);
    before != *session
}
