use crate::{AiSessionModelSelection, ProviderError};
use async_trait::async_trait;
use serde_json::{json, Value};

pub const AI_SESSION_TITLE_MAX_CHARS: usize = 36;
pub const AI_SESSION_TITLE_PROMPT_MAX_BYTES: usize = 960;

#[derive(Debug, Clone)]
pub struct AiSessionTitleInput {
    pub prompt: String,
    pub output_schema: Value,
    pub model_selection: AiSessionModelSelection,
    pub reasoning_effort: Option<String>,
}

#[async_trait]
pub trait AiSessionTitleGenerator: Send + Sync {
    async fn generate_title(&self, input: AiSessionTitleInput) -> Result<String, ProviderError>;
}

pub fn ai_session_title_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": AI_SESSION_TITLE_MAX_CHARS,
            }
        },
        "required": ["title"],
        "additionalProperties": false,
    })
}

pub fn ai_session_title_prompt(user_prompt: &str) -> String {
    let instructions = format!(
        "Generate a concise, single-line task title of at most {AI_SESSION_TITLE_MAX_CHARS} characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request."
    );
    let prefix = format!("{instructions}\n\nUser prompt:\n");
    let remaining = AI_SESSION_TITLE_PROMPT_MAX_BYTES.saturating_sub(prefix.len());
    format!("{prefix}{}", truncate_utf8(user_prompt.trim(), remaining))
}

pub fn parse_ai_session_title(response: &str) -> Option<String> {
    if !response.trim_start().starts_with('{') {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(response).ok()?;
    let object = parsed.as_object()?;
    if object.len() != 1 {
        return None;
    }
    let title = object.get("title")?.as_str()?;
    let normalized = title
        .trim()
        .trim_matches(|character| {
            matches!(
                character,
                '"' | '\'' | '`' | '\u{201c}' | '\u{201d}' | '\u{2018}' | '\u{2019}'
            )
        })
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(['.', '?', '!'])
        .trim()
        .to_string();
    if normalized.is_empty() {
        return None;
    }
    Some(
        normalized
            .chars()
            .take(AI_SESSION_TITLE_MAX_CHARS)
            .collect(),
    )
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    let mut result = String::new();
    let mut bytes = 0;
    for character in value.chars() {
        let length = character.len_utf8();
        if bytes + length > max_bytes {
            break;
        }
        result.push(character);
        bytes += length;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_prompt_respects_utf8_byte_budget() {
        let prompt = ai_session_title_prompt(&"迁移".repeat(600));
        assert!(prompt.len() <= AI_SESSION_TITLE_PROMPT_MAX_BYTES);
        assert!(prompt.ends_with('移'));
    }

    #[test]
    fn title_parser_matches_node_normalization() {
        assert_eq!(
            parse_ai_session_title(r#"{"title":"  \"Fix migration.\"  "}"#).as_deref(),
            Some("Fix migration")
        );
        assert_eq!(
            parse_ai_session_title(r#"{"title":"One","extra":true}"#),
            None
        );
        assert_eq!(parse_ai_session_title(r#"["not","object"]"#), None);
    }
}
