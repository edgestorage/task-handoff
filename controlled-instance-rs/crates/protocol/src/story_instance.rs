use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::AgentRunModelSelection;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoryAutomationRuntimePath {
    #[serde(rename = "type")]
    pub runtime_path_type: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoryAutomationInstanceCreateInput {
    pub agent: String,
    pub cwd: StoryAutomationRuntimePath,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd_folder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_selection: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_selection: Option<Value>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    pub client_request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<AgentRunModelSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub story_id: String,
}

impl StoryAutomationInstanceCreateInput {
    pub fn validate(&self) -> Result<(), String> {
        if self.agent.trim().is_empty() || self.agent.trim().chars().count() > 80 {
            return Err("agent is invalid.".to_string());
        }
        if self.cwd.runtime_path_type != "runtime-path"
            || self.cwd.path.trim().is_empty()
            || self.cwd.path.chars().count() > 4096
            || !self.cwd.path.starts_with('/')
        {
            return Err("cwd must be an absolute runtime-path.".to_string());
        }
        if self.message.trim().is_empty() || self.message.chars().count() > 32_000 {
            return Err("message must be between 1 and 32000 characters.".to_string());
        }
        if self.client_request_id.trim().is_empty()
            || self.client_request_id.trim().chars().count() > 160
        {
            return Err("clientRequestId must be between 1 and 160 characters.".to_string());
        }
        if self.story_id.trim().is_empty() || self.story_id.trim().chars().count() > 120 {
            return Err("storyId is invalid.".to_string());
        }
        if self.git_selection.is_some() && self.workspace_selection.is_some() {
            return Err("gitSelection and workspaceSelection are mutually exclusive.".to_string());
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
        if let Some(selection) = &self.model_selection {
            if selection.model_entity_id.trim().is_empty()
                || selection.model_entity_id.chars().count() > 120
                || selection.model_name.trim().is_empty()
                || selection.model_name.chars().count() > 240
                || selection
                    .model_upstream_name
                    .as_deref()
                    .is_some_and(|value| {
                        value.trim().is_empty() || value.trim().chars().count() > 240
                    })
            {
                return Err("modelSelection is invalid.".to_string());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoryAutomationInstanceCreateResult {
    pub disposition: String,
    pub ai_session_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input() -> StoryAutomationInstanceCreateInput {
        serde_json::from_value(json!({
            "agent": "codex",
            "cwd": { "type": "runtime-path", "path": "/workspace" },
            "message": "Run this Story automation",
            "clientRequestId": "request-1",
            "storyId": "stry_1"
        }))
        .expect("input")
    }

    #[test]
    fn story_automation_workspace_selection_is_exclusive() {
        assert_eq!(input().validate(), Ok(()));
        let mut invalid = input();
        invalid.git_selection = Some(json!({ "mode": "current-folder", "branch": "main" }));
        invalid.workspace_selection = Some(json!({ "type": "current-folder", "branch": "main" }));
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn story_automation_uses_the_node_story_id_and_codepoint_limits() {
        let mut input = input();
        input.client_request_id = "😀".repeat(160);
        input.story_id = "😀".repeat(120);
        assert_eq!(input.validate(), Ok(()));
        input.story_id = "😀".repeat(121);
        assert!(input.validate().is_err());
    }

    #[test]
    fn story_automation_result_has_only_private_dispatch_identity() {
        assert_eq!(
            serde_json::to_value(StoryAutomationInstanceCreateResult {
                disposition: "created".to_string(),
                ai_session_id: "ses_1".to_string(),
            })
            .expect("result"),
            json!({ "disposition": "created", "aiSessionId": "ses_1" })
        );
    }
}
