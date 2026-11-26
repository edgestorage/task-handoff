use serde::{Deserialize, Serialize};

pub const STORY_CONTEXT_RESOLVE_PROTOCOL_VERSION: &str = "2026-11-26";
pub const STORY_CONTEXT_CLOSED_SESSIONS_PROTOCOL_VERSION: &str = "2026-11-26";
pub const STORY_CONTEXT_SESSION_CANDIDATE_LIMIT: usize = 200;
pub const STORY_CONTEXT_SESSION_TITLE_MAX_LENGTH: usize = 240;
pub const STORY_CONTEXT_SESSION_USER_PROMPT_MAX_LENGTH: usize = 600;
pub const STORY_CONTEXT_SESSION_LAST_RESPONSE_MAX_LENGTH: usize = 800;
pub const STORY_CONTEXT_RENDERED_MAX_LENGTH: usize = 24_000;

fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StoryContextPurpose {
    SessionCreate,
    AgentRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoryContextCaller {
    pub instance_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoryContextResolveInput {
    pub story_id: String,
    pub purpose: StoryContextPurpose,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<StoryContextCaller>,
    #[serde(default)]
    pub exclude_session_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryContextDiagnostic {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryContextResolution {
    pub protocol_version: String,
    pub story_id: String,
    pub node_id: String,
    pub purpose: StoryContextPurpose,
    pub revision: u64,
    pub rendered_context: String,
    #[serde(default)]
    pub diagnostics: Vec<StoryContextDiagnostic>,
    #[serde(default)]
    pub omitted_project_count: u64,
    #[serde(default)]
    pub omitted_session_count: u64,
    #[serde(default)]
    pub session_candidate_window_omitted_count: u64,
}

impl StoryContextResolution {
    pub fn validate(&self) -> Result<(), String> {
        if self.protocol_version != STORY_CONTEXT_RESOLVE_PROTOCOL_VERSION {
            return Err("Story context protocol version is incompatible.".to_string());
        }
        if self.story_id.trim().is_empty() || self.node_id.trim().is_empty() {
            return Err("Story context identity is invalid.".to_string());
        }
        if utf16_len(&self.rendered_context) > STORY_CONTEXT_RENDERED_MAX_LENGTH {
            return Err("Story context exceeds the rendered text budget.".to_string());
        }
        Ok(())
    }
}

fn default_closed_session_limit() -> usize {
    STORY_CONTEXT_SESSION_CANDIDATE_LIMIT
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoryContextClosedSessionRequest {
    pub story_id: String,
    #[serde(default)]
    pub exclude_session_ids: Vec<String>,
    #[serde(default = "default_closed_session_limit")]
    pub limit: usize,
}

impl StoryContextClosedSessionRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.story_id.trim().is_empty() || self.story_id.chars().count() > 120 {
            return Err("storyId is invalid.".to_string());
        }
        if self.exclude_session_ids.len() > STORY_CONTEXT_SESSION_CANDIDATE_LIMIT
            || self
                .exclude_session_ids
                .iter()
                .any(|id| id.trim().is_empty() || id.chars().count() > 120)
        {
            return Err("excludeSessionIds is invalid.".to_string());
        }
        if !(1..=STORY_CONTEXT_SESSION_CANDIDATE_LIMIT).contains(&self.limit) {
            return Err(format!(
                "limit must be between 1 and {STORY_CONTEXT_SESSION_CANDIDATE_LIMIT}."
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoryContextSessionSummary {
    pub instance_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_response: Option<String>,
    pub last_activity_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryContextClosedSessionDiagnostic {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryContextClosedSessionResult {
    pub protocol_version: String,
    pub story_id: String,
    pub sessions: Vec<StoryContextSessionSummary>,
    #[serde(default)]
    pub omitted_count: u64,
    #[serde(default)]
    pub diagnostics: Vec<StoryContextClosedSessionDiagnostic>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn closed_session_request_defaults_and_strict_validation_match_protocol() {
        let parsed: StoryContextClosedSessionRequest = serde_json::from_value(json!({
            "storyId": "story_1"
        }))
        .expect("defaulted request");
        assert!(parsed.exclude_session_ids.is_empty());
        assert_eq!(parsed.limit, STORY_CONTEXT_SESSION_CANDIDATE_LIMIT);
        assert!(parsed.validate().is_ok());
        assert!(
            serde_json::from_value::<StoryContextClosedSessionRequest>(json!({
                "storyId": "story_1",
                "future": true
            }))
            .is_err()
        );
        let invalid = StoryContextClosedSessionRequest {
            story_id: "story_1".to_string(),
            exclude_session_ids: vec![],
            limit: STORY_CONTEXT_SESSION_CANDIDATE_LIMIT + 1,
        };
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn resolution_consumer_ignores_unknown_fields_but_rejects_corrupt_required_fields() {
        let value = json!({
            "protocolVersion": STORY_CONTEXT_RESOLVE_PROTOCOL_VERSION,
            "storyId": "story_1",
            "nodeId": "node_1",
            "purpose": "session-create",
            "revision": 2,
            "renderedContext": "context",
            "diagnostics": [],
            "omittedProjectCount": 0,
            "omittedSessionCount": 0,
            "sessionCandidateWindowOmittedCount": 0,
            "future": true
        });
        let parsed: StoryContextResolution =
            serde_json::from_value(value).expect("consumer sanitize");
        assert!(parsed.validate().is_ok());
        assert!(serde_json::from_value::<StoryContextResolution>(json!({
            "protocolVersion": STORY_CONTEXT_RESOLVE_PROTOCOL_VERSION,
            "storyId": "story_1"
        }))
        .is_err());
    }
}
