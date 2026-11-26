use crate::AiSession;
use controlled_instance_protocol::AI_SESSION_NEXT_INPUT_SUGGESTION_MAX_CHARS;
use serde_json::{json, Value};
use std::collections::HashMap;

pub const AI_SESSION_NEXT_INPUT_CONTEXT_MAX_BYTES: usize = 8 * 1024;
pub const AI_SESSION_NEXT_INPUT_RESPONSE_MAX_BYTES: usize = 64 * 1024;
pub const AI_SESSION_NEXT_INPUT_MIN_TURNS: usize = 1;
pub const AI_SESSION_NEXT_INPUT_WINDOW_STEP_TURNS: usize = 5;
pub const AI_SESSION_NEXT_INPUT_MAX_WINDOW_TURNS: usize = 10;
pub const AI_SESSION_NEXT_INPUT_SYSTEM_PROMPT: &str = concat!(
    "You predict the user's most likely next message in an ongoing coding session.\n",
    "Each user message contains one completed turn: \"User:\" is the real user request and \"Assistant:\" is the real assistant reply.\n",
    "Each assistant message contains a previous next-message prediction.\n",
    "This is a prediction-only task. Never call tools, run commands, or continue the assistant's work.\n",
    "Return only the JSON object required by the response schema. Do not explain or emit tool calls.\n",
    "Use the language of the most recent real user request. Keep the prediction specific, natural, and directly editable.\n",
    "Do not repeat the previous user request. Do not claim work has been completed."
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiSessionNextInputMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiSessionNextInputTurnSnapshot {
    pub id: String,
    pub user: String,
    pub assistant: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiSessionNextInputMessagePlan {
    pub messages: Vec<AiSessionNextInputMessage>,
    pub snapshots: HashMap<String, AiSessionNextInputTurnSnapshot>,
    pub window_turn_ids: Vec<String>,
    pub window_start: usize,
    pub completed_turn_count: usize,
}

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

/// The next-input window grows from one to ten completed turns. Once it
/// reaches ten, the next request drops the oldest five turns and starts growing
/// again. Keeping the start index on a five-turn cadence preserves an exact
/// append-only prefix between resets.
pub fn ai_session_next_input_window_start(completed_turn_count: usize) -> usize {
    if completed_turn_count <= AI_SESSION_NEXT_INPUT_MAX_WINDOW_TURNS {
        return 0;
    }
    (completed_turn_count - AI_SESSION_NEXT_INPUT_MAX_WINDOW_TURNS)
        .div_ceil(AI_SESSION_NEXT_INPUT_WINDOW_STEP_TURNS)
        * AI_SESSION_NEXT_INPUT_WINDOW_STEP_TURNS
}

pub fn build_ai_session_next_input_messages(
    turns: &[AiSessionNextInputTurnSnapshot],
    suggestions_by_turn_id: &HashMap<String, String>,
) -> Vec<AiSessionNextInputMessage> {
    let mut messages = vec![AiSessionNextInputMessage {
        role: "system".to_string(),
        content: AI_SESSION_NEXT_INPUT_SYSTEM_PROMPT.to_string(),
    }];
    for turn in turns {
        messages.push(AiSessionNextInputMessage {
            role: "user".to_string(),
            content: format!("User: {}\nAssistant: {}", turn.user, turn.assistant),
        });
        if let Some(suggestion) = suggestions_by_turn_id
            .get(&turn.id)
            .map(|value| compact_text(value))
            .filter(|value| !value.is_empty())
        {
            messages.push(AiSessionNextInputMessage {
                role: "assistant".to_string(),
                content: suggestion,
            });
        }
    }
    messages
}

/// Builds the complete messages request from the latest settled turn. Turn
/// snapshots are reused by id so later status projections cannot rewrite an
/// already-sent prefix. The caller decides whether a late result may be stored.
pub fn create_ai_session_next_input_message_plan(
    session: &AiSession,
    previous_snapshots: &HashMap<String, AiSessionNextInputTurnSnapshot>,
    suggestions_by_turn_id: &HashMap<String, String>,
) -> Option<AiSessionNextInputMessagePlan> {
    let completed = session
        .turns
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|turn| turn.get("status").and_then(Value::as_str) == Some("completed"))
        .collect::<Vec<_>>();
    let completed_turns = completed
        .iter()
        .filter_map(|turn| {
            let id = turn.get("id").and_then(Value::as_str)?.to_string();
            previous_snapshots.get(&id).cloned().or_else(|| {
                let user = turn_user_text(turn);
                let assistant = turn_assistant_text(turn);
                (!user.is_empty() && !assistant.is_empty()).then_some(
                    AiSessionNextInputTurnSnapshot {
                        id,
                        user,
                        assistant,
                    },
                )
            })
        })
        .collect::<Vec<_>>();
    if completed_turns.len() < AI_SESSION_NEXT_INPUT_MIN_TURNS {
        return None;
    }
    let latest_completed_id = completed
        .last()
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str);
    if latest_completed_id != completed_turns.last().map(|turn| turn.id.as_str()) {
        return None;
    }

    let window_start = ai_session_next_input_window_start(completed_turns.len());
    let window_turns = completed_turns[window_start..].to_vec();
    let snapshots = window_turns
        .iter()
        .cloned()
        .map(|turn| (turn.id.clone(), turn))
        .collect::<HashMap<_, _>>();
    Some(AiSessionNextInputMessagePlan {
        messages: build_ai_session_next_input_messages(&window_turns, suggestions_by_turn_id),
        window_turn_ids: window_turns.iter().map(|turn| turn.id.clone()).collect(),
        snapshots,
        window_start,
        completed_turn_count: completed_turns.len(),
    })
}

pub fn ai_session_next_input_messages_are_strict_prefix(
    expected: &[AiSessionNextInputMessage],
    current: &[AiSessionNextInputMessage],
) -> bool {
    expected.iter().enumerate().all(|(index, message)| {
        current.get(index).is_some_and(|candidate| {
            candidate.role == message.role && candidate.content == message.content
        })
    })
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
        "请基于最近的用户请求和助手回复，预测用户接下来最可能输入的一句话。这是纯预测任务，不要调用工具、执行命令或继续完成助手的工作。使用最近一条用户消息的语言，保持具体、自然、可直接编辑。"
    } else {
        "Predict the user's most likely next message from the recent request and assistant reply. This is a prediction-only task: do not call tools, run commands, or continue the assistant's work. Use the language of the latest user message. Keep it specific, natural, and directly editable."
    };
    let format = if chinese {
        "只返回 JSON：{\"suggestion\":\"单行建议\"}。不要调用工具，不要换行，不要 Markdown，不要解释，不要超过 160 个 Unicode 字符。"
    } else {
        "Return only JSON: {\"suggestion\":\"one line\"}. Do not call tools. No newlines, Markdown, or explanation. At most 160 Unicode characters."
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

    fn window_turn(index: usize) -> Value {
        json!({
            "id": format!("turn_{index}"),
            "status": "completed",
            "userPrompt": format!("问题 {index}"),
            "summary": format!("回答 {index}")
        })
    }

    fn window_turns(count: usize) -> Value {
        Value::Array((1..=count).map(window_turn).collect())
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

    #[test]
    fn message_window_starts_at_one_grows_to_ten_then_advances_by_five() {
        assert_eq!(ai_session_next_input_window_start(0), 0);
        assert_eq!(ai_session_next_input_window_start(1), 0);
        assert_eq!(ai_session_next_input_window_start(4), 0);
        assert_eq!(ai_session_next_input_window_start(5), 0);
        assert_eq!(ai_session_next_input_window_start(10), 0);
        assert_eq!(ai_session_next_input_window_start(11), 5);
        assert_eq!(ai_session_next_input_window_start(15), 5);
        assert_eq!(ai_session_next_input_window_start(16), 10);
        assert_eq!(ai_session_next_input_window_start(21), 15);

        let one = create_ai_session_next_input_message_plan(
            &session(window_turns(1)),
            &HashMap::new(),
            &HashMap::new(),
        )
        .expect("one-turn plan");
        assert_eq!(one.window_start, 0);
        assert_eq!(one.completed_turn_count, 1);
        assert_eq!(one.messages.len(), 2);

        let five = create_ai_session_next_input_message_plan(
            &session(window_turns(5)),
            &HashMap::new(),
            &HashMap::new(),
        )
        .expect("five-turn plan");
        assert_eq!(five.window_start, 0);
        assert_eq!(five.completed_turn_count, 5);
        assert_eq!(five.messages.len(), 6);

        let eleven = create_ai_session_next_input_message_plan(
            &session(window_turns(11)),
            &HashMap::new(),
            &HashMap::new(),
        )
        .expect("eleven-turn plan");
        assert_eq!(eleven.window_start, 5);
        assert_eq!(eleven.completed_turn_count, 11);
        assert_eq!(
            eleven.window_turn_ids,
            vec!["turn_6", "turn_7", "turn_8", "turn_9", "turn_10", "turn_11"]
        );
    }

    #[test]
    fn messages_use_fixed_system_prompt_and_plain_text_suggestion_history() {
        let mut suggestions = HashMap::new();
        suggestions.insert("turn_5".to_string(), "继续补齐测试".to_string());
        let plan = create_ai_session_next_input_message_plan(
            &session(window_turns(5)),
            &HashMap::new(),
            &suggestions,
        )
        .expect("plan");
        assert_eq!(plan.messages[0].role, "system");
        assert_eq!(
            plan.messages[0].content,
            AI_SESSION_NEXT_INPUT_SYSTEM_PROMPT
        );
        assert_eq!(plan.messages[1].role, "user");
        assert_eq!(plan.messages[1].content, "User: 问题 1\nAssistant: 回答 1");
        assert_eq!(plan.messages.last().unwrap().role, "assistant");
        assert_eq!(plan.messages.last().unwrap().content, "继续补齐测试");
        assert!(plan
            .messages
            .iter()
            .all(|message| !message.content.contains("{\"suggestion\"")));

        let english = session(json!([
            {
                "id": "turn_1",
                "status": "completed",
                "userPrompt": "Fix login",
                "summary": "Done"
            },
            window_turn(2),
            window_turn(3),
            window_turn(4),
            window_turn(5)
        ]));
        let english_plan =
            create_ai_session_next_input_message_plan(&english, &HashMap::new(), &HashMap::new())
                .expect("english plan");
        assert_eq!(
            english_plan.messages[0].content,
            AI_SESSION_NEXT_INPUT_SYSTEM_PROMPT
        );
    }

    #[test]
    fn consecutive_requests_inside_one_window_are_strict_prefixes() {
        let five = session(window_turns(5));
        let first =
            create_ai_session_next_input_message_plan(&five, &HashMap::new(), &HashMap::new())
                .expect("first plan");
        let mut suggestions = HashMap::new();
        suggestions.insert("turn_5".to_string(), "继续补齐测试".to_string());
        let six_turns = window_turns(6).as_array().unwrap().clone();
        let next = create_ai_session_next_input_message_plan(
            &session(Value::Array(six_turns)),
            &first.snapshots,
            &suggestions,
        )
        .expect("next plan");
        assert!(ai_session_next_input_messages_are_strict_prefix(
            &first.messages,
            &next.messages
        ));
        assert_eq!(next.messages[first.messages.len()].role, "assistant");
        assert_eq!(next.messages[first.messages.len()].content, "继续补齐测试");
        assert_eq!(next.messages.last().unwrap().role, "user");
    }

    #[test]
    fn frozen_turn_snapshots_prevent_later_status_mutation_from_rewriting_the_prefix() {
        let original = session(window_turns(5));
        let first =
            create_ai_session_next_input_message_plan(&original, &HashMap::new(), &HashMap::new())
                .expect("first plan");
        let mut changed_turns = window_turns(5).as_array().unwrap().clone();
        changed_turns[0]["summary"] = json!("被改写的回答");
        let changed = session(Value::Array(changed_turns));
        let next =
            create_ai_session_next_input_message_plan(&changed, &first.snapshots, &HashMap::new())
                .expect("next plan");
        assert_eq!(first.messages, next.messages);
    }
}
