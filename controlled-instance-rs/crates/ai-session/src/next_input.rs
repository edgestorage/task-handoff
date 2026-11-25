use crate::AiSession;
use controlled_instance_protocol::AI_SESSION_NEXT_INPUT_SUGGESTION_MAX_CHARS;
use serde_json::{json, Value};

pub const AI_SESSION_NEXT_INPUT_CONTEXT_MAX_BYTES: usize = 8 * 1024;
pub const AI_SESSION_NEXT_INPUT_RESPONSE_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AiSessionNextInputSuggestionReasoningEffort {
    FollowSession,
    #[default]
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl AiSessionNextInputSuggestionReasoningEffort {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "session" => Some(Self::FollowSession),
            "none" => Some(Self::None),
            "minimal" => Some(Self::Minimal),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "xhigh" => Some(Self::Xhigh),
            "max" => Some(Self::Max),
            "ultra" => Some(Self::Ultra),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::FollowSession => "session",
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }

    pub fn resolve(self, session_effort: Option<&str>) -> Option<String> {
        match self {
            Self::FollowSession => session_effort.map(str::to_string),
            value => Some(value.as_str().to_string()),
        }
    }
}

#[derive(Debug, Clone)]
struct ContextTurn {
    user: String,
    assistant: String,
}

fn compact_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn turn_user_text(turn: &Value) -> String {
    let latest_message = turn
        .get("userMessages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .filter_map(|message| message.get("text").and_then(Value::as_str))
        .map(compact_text)
        .find(|text| !text.is_empty());
    latest_message.unwrap_or_else(|| {
        turn.get("userPrompt")
            .and_then(Value::as_str)
            .map(compact_text)
            .unwrap_or_default()
    })
}

fn turn_assistant_text(turn: &Value) -> String {
    turn.get("lastMessage")
        .and_then(Value::as_str)
        .or_else(|| turn.get("summary").and_then(Value::as_str))
        .map(compact_text)
        .unwrap_or_default()
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    let mut result = String::new();
    let mut used = 0;
    for character in value.chars() {
        let bytes = character.len_utf8();
        if used + bytes > max_bytes {
            break;
        }
        result.push(character);
        used += bytes;
    }
    result
}

pub fn ai_session_next_input_context(session: &AiSession, max_bytes: usize) -> Vec<Value> {
    let mut completed = session
        .turns
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|turn| turn.get("status").and_then(Value::as_str) == Some("completed"))
        .filter_map(|turn| {
            let user = turn_user_text(turn);
            let assistant = turn_assistant_text(turn);
            (!user.is_empty() && !assistant.is_empty()).then_some(ContextTurn { user, assistant })
        })
        .collect::<Vec<_>>();
    if completed.len() > 2 {
        completed.drain(0..completed.len() - 2);
    }
    let mut remaining = max_bytes;
    let mut chosen = Vec::new();
    for turn in completed.into_iter().rev() {
        if remaining == 0 {
            break;
        }
        let block = format!("User: {}\nAssistant: {}", turn.user, turn.assistant);
        if block.len() <= remaining {
            remaining = remaining.saturating_sub(block.len() + 2);
            chosen.insert(0, turn);
            continue;
        }
        let clipped = truncate_utf8(&block, remaining.saturating_sub(2));
        if let Some(separator) = clipped.find("\nAssistant:") {
            let user = clipped["User: ".len()..separator].to_string();
            let assistant = clipped[separator + "\nAssistant: ".len()..].to_string();
            if !user.trim().is_empty() && !assistant.trim().is_empty() {
                chosen.insert(0, ContextTurn { user, assistant });
            }
        }
        break;
    }
    chosen
        .into_iter()
        .map(|turn| json!({ "user": turn.user, "assistant": turn.assistant }))
        .collect()
}

pub fn ai_session_next_input_prompt(session: &AiSession) -> String {
    let context = ai_session_next_input_context(session, AI_SESSION_NEXT_INPUT_CONTEXT_MAX_BYTES);
    let latest_user = context
        .iter()
        .rev()
        .filter_map(|turn| turn.get("user").and_then(Value::as_str))
        .next()
        .unwrap_or_default();
    let chinese = latest_user.chars().any(|character| {
        ('\u{3400}'..='\u{9fff}').contains(&character)
            || ('\u{f900}'..='\u{faff}').contains(&character)
    });
    let instruction = if chinese {
        "请基于最近的用户请求和助手回复，预测用户接下来最可能输入的一句话。使用最近一条用户消息的语言，保持具体、自然、可直接编辑。"
    } else {
        "Predict the user's most likely next message from the recent request and assistant reply. Use the language of the latest user message. Keep it specific, natural, and directly editable."
    };
    let format = if chinese {
        "只返回 JSON：{\"suggestion\":\"单行建议\"}。不要换行，不要 Markdown，不要解释，不要超过 160 个 Unicode 字符。"
    } else {
        "Return only JSON: {\"suggestion\":\"one line\"}. No newlines, Markdown, or explanation. At most 160 Unicode characters."
    };
    let blocks = context
        .iter()
        .filter_map(|turn| {
            Some(format!(
                "User: {}\nAssistant: {}",
                turn.get("user")?.as_str()?,
                turn.get("assistant")?.as_str()?
            ))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "{instruction}\n{format}\nDo not repeat the previous user message. Do not claim work has been done.\n\n{blocks}"
    )
    .trim()
    .to_string()
}

pub fn ai_session_next_input_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["suggestion"],
        "properties": {
            "suggestion": {
                "type": "string",
                "description": "A concise single-line next user message in the same language as the latest user message."
            }
        }
    })
}

pub fn parse_ai_session_next_input_suggestion(raw: &str) -> Option<String> {
    let bounded = truncate_utf8(raw, AI_SESSION_NEXT_INPUT_RESPONSE_MAX_BYTES);
    let parsed = serde_json::from_str::<Value>(&bounded).ok()?;
    let mut text = parsed
        .as_object()?
        .get("suggestion")?
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let wrapping = [('"', '"'), ('\'', '\''), ('“', '”'), ('‘', '’')]
        .into_iter()
        .find(|(start, end)| text.starts_with(*start) && text.ends_with(*end));
    if let Some((start, end)) = wrapping {
        text = text[start.len_utf8()..text.len() - end.len_utf8()]
            .trim()
            .to_string();
    }
    let text = text
        .chars()
        .take(AI_SESSION_NEXT_INPUT_SUGGESTION_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(turns: Value) -> AiSession {
        serde_json::from_value(json!({
            "id": "ses_0000000000000",
            "agent": "codex",
            "creationSource": "ai-session",
            "status": "idle",
            "phase": "unknown",
            "startedAt": "2026-11-25T00:00:00.000Z",
            "updatedAt": "2026-11-25T00:01:00.000Z",
            "turns": turns
        }))
        .expect("session")
    }

    #[test]
    fn context_uses_only_the_latest_two_completed_turns_and_bounds_utf8() {
        let session = session(json!([
            { "id": "turn_1", "status": "completed", "userPrompt": "old", "summary": "old reply" },
            { "id": "turn_2", "status": "failed", "userPrompt": "failed", "summary": "failed reply" },
            { "id": "turn_3", "status": "completed", "userPrompt": "最近的问题", "summary": "最近的回答" },
            { "id": "turn_4", "status": "completed", "userPrompt": "最新问题", "summary": "最新回答" }
        ]));
        let context = ai_session_next_input_context(&session, 60);
        assert_eq!(context.len(), 1);
        assert!(context[0]["user"].as_str().unwrap().contains("最新问题"));
        assert!(ai_session_next_input_prompt(&session).contains("只返回 JSON"));
    }

    #[test]
    fn parser_matches_node_normalization() {
        assert_eq!(
            parse_ai_session_next_input_suggestion(r#"{"suggestion":"  \"继续修复测试。\"  "}"#)
                .as_deref(),
            Some("继续修复测试。")
        );
        assert_eq!(
            parse_ai_session_next_input_suggestion(r#"{"suggestion":"   "}"#),
            None
        );
        assert_eq!(parse_ai_session_next_input_suggestion("not json"), None);
        let long = format!(r#"{{"suggestion":"{}"}}"#, "a".repeat(200));
        assert_eq!(
            parse_ai_session_next_input_suggestion(&long)
                .unwrap()
                .chars()
                .count(),
            160
        );
    }
}
