use serde::{Deserialize, Serialize};

pub const AGENT_RUN_MAX_RESULT_CHARACTERS: usize = 128_000;

fn is_absolute_runtime_path(path: &str) -> bool {
    path.starts_with('/')
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunRuntimePath {
    #[serde(rename = "type")]
    pub runtime_path_type: String,
    pub path: String,
}

impl AgentRunRuntimePath {
    pub fn validate(&self) -> bool {
        self.runtime_path_type == "runtime-path"
            && !self.path.trim().is_empty()
            && self.path.len() <= 4096
            && is_absolute_runtime_path(&self.path)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunWritableRoots {
    pub workspace: AgentRunRuntimePath,
    pub shared: AgentRunRuntimePath,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunModelSelection {
    pub model_entity_id: String,
    pub model_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_upstream_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunMemberInstanceCreateInput {
    pub run_id: String,
    pub member_id: String,
    pub client_request_id: String,
    pub provider_id: String,
    pub cwd: AgentRunRuntimePath,
    pub writable_roots: AgentRunWritableRoots,
    pub prompt: String,
    pub appended_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<AgentRunModelSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub enabled_tools: Vec<String>,
}

impl AgentRunMemberInstanceCreateInput {
    pub fn validate(&self) -> Result<(), String> {
        for (field, value) in [("runId", &self.run_id), ("memberId", &self.member_id)] {
            if value.is_empty()
                || value.len() > 120
                || !value
                    .bytes()
                    .next()
                    .is_some_and(|byte| byte.is_ascii_alphanumeric())
                || !value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
                })
            {
                return Err(format!("{field} is invalid."));
            }
        }
        if self.client_request_id.trim().is_empty() || self.client_request_id.len() > 160 {
            return Err("clientRequestId must be between 1 and 160 characters.".to_string());
        }
        if !self.cwd.validate()
            || !self.writable_roots.workspace.validate()
            || !self.writable_roots.shared.validate()
        {
            return Err("Agent Run runtime paths must be absolute POSIX paths.".to_string());
        }
        if self.cwd.path != self.writable_roots.workspace.path {
            return Err("The workspace writable root must be the member cwd.".to_string());
        }
        if self.writable_roots.workspace.path == self.writable_roots.shared.path {
            return Err("Workspace and shared roots must be distinct.".to_string());
        }
        let prompt = self.prompt.trim();
        if prompt.is_empty() || prompt.chars().count() > 128_000 {
            return Err("prompt must be between 1 and 128000 characters.".to_string());
        }
        if self.appended_prompt.chars().count() > 32_000 {
            return Err("appendedPrompt must be at most 32000 characters.".to_string());
        }
        if self.enabled_tools.len() > 100
            || self
                .enabled_tools
                .iter()
                .any(|tool| !crate::AI_SESSION_AGENT_TOOL_NAMES.contains(&tool.as_str()))
        {
            return Err("enabledTools contains an unsupported Agent tool.".to_string());
        }
        if let Some(selection) = &self.model_selection {
            if selection.model_entity_id.trim().is_empty()
                || selection.model_entity_id.len() > 120
                || selection.model_name.trim().is_empty()
                || selection.model_name.len() > 240
                || selection
                    .model_upstream_name
                    .as_deref()
                    .is_some_and(|value| value.trim().is_empty() || value.len() > 240)
            {
                return Err("modelSelection is invalid.".to_string());
            }
        }
        if self
            .permission_mode
            .as_deref()
            .is_some_and(|mode| !matches!(mode, "ask" | "auto-review" | "full-access"))
        {
            return Err("permissionMode is invalid.".to_string());
        }
        if self.reasoning_effort.as_deref().is_some_and(|effort| {
            !matches!(
                effort,
                "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
            )
        }) {
            return Err("reasoningEffort is invalid.".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunMemberInstanceCreateResult {
    pub disposition: String,
    pub ai_session_id: String,
    pub provider_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunResult {
    pub text: String,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default = "default_result_source")]
    pub source: String,
}

fn default_result_source() -> String {
    "provider-final-message".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunMemberInstanceStatus {
    pub run_id: String,
    pub member_id: String,
    pub ai_session_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<AgentRunResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AgentRunError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunMemberInstanceCloseResult {
    pub run_id: String,
    pub member_id: String,
    pub ai_session_id: String,
    pub closed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunInstanceProbeState {
    pub ordinary_ai_session_ids: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_input() -> AgentRunMemberInstanceCreateInput {
        serde_json::from_value(json!({
            "runId": "run_1",
            "memberId": "member_1",
            "clientRequestId": "request-1",
            "providerId": "codex",
            "cwd": { "type": "runtime-path", "path": "/workspace" },
            "writableRoots": {
                "workspace": { "type": "runtime-path", "path": "/workspace" },
                "shared": { "type": "runtime-path", "path": "/shared" }
            },
            "prompt": "Do the work",
            "appendedPrompt": "",
            "enabledTools": ["agent_run"]
        }))
        .expect("input")
    }

    #[test]
    fn agent_run_input_enforces_runtime_root_invariants() {
        let input = valid_input();
        assert_eq!(input.validate(), Ok(()));
        let mut invalid = input.clone();
        invalid.writable_roots.workspace.path = "/other".to_string();
        assert!(invalid.validate().is_err());
        let mut invalid = input;
        invalid.writable_roots.shared.path = "/workspace".to_string();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn agent_run_status_uses_the_private_wire_shape() {
        let status = AgentRunMemberInstanceStatus {
            run_id: "run_1".to_string(),
            member_id: "member_1".to_string(),
            ai_session_id: "ses_1".to_string(),
            status: "completed".to_string(),
            result: Some(AgentRunResult {
                text: "done".to_string(),
                truncated: false,
                source: default_result_source(),
            }),
            error: None,
        };
        assert_eq!(
            serde_json::to_value(status).expect("status"),
            json!({
                "runId": "run_1",
                "memberId": "member_1",
                "aiSessionId": "ses_1",
                "status": "completed",
                "result": {
                    "text": "done",
                    "truncated": false,
                    "source": "provider-final-message"
                }
            })
        );
    }
}
