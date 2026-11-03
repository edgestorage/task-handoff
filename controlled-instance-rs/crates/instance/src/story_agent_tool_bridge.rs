use crate::{
    agent_run_bindings::AgentRunMemberBindingStore,
    story_tools::{StoryToolError, StoryToolService},
};
use controlled_instance_ai_session::{AiSession, AiSessionRuntime};
use controlled_instance_protocol::AiSessionAgentToolName;
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
use uuid::Uuid;

static TOOL_DEFINITIONS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("story_agent_tool_definitions.json"))
        .expect("the MCP tool definitions are valid JSON")
});

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolInvocationInput {
    pub provider: String,
    pub provider_session_id: String,
    pub tool: AiSessionAgentToolName,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default, deserialize_with = "deserialize_present_option")]
    pub call_id: Option<String>,
}

impl AgentToolInvocationInput {
    pub fn validate(&self) -> Result<(), StoryToolError> {
        if self.provider != "opencode" {
            return Err(invalid_request("provider must be opencode."));
        }
        validate_provider_session_id(&self.provider_session_id)?;
        if let Some(call_id) = self.call_id.as_deref() {
            if call_id.trim().is_empty() || call_id.trim().chars().count() > 240 {
                return Err(invalid_request(
                    "callId must contain between 1 and 240 characters.",
                ));
            }
        }
        Ok(())
    }

    pub fn call_id(&self) -> Option<&str> {
        self.call_id.as_deref().map(str::trim)
    }
}

pub async fn invoke_for_provider_session(
    service: &StoryToolService,
    bindings: &AgentRunMemberBindingStore,
    sessions: &AiSessionRuntime,
    invocation: StoryToolInvocation<'_>,
) -> Result<Value, StoryToolError> {
    let StoryToolInvocation {
        provider,
        provider_session_id,
        tool,
        arguments,
        call_id,
    } = invocation;
    validate_provider_session_id(provider_session_id)?;
    if provider != "codex" && provider != "opencode" {
        return Err(invalid_request("provider must be codex or opencode."));
    }
    let session = sessions
        .get_by_provider_session_id(provider, provider_session_id)
        .ok_or_else(|| {
            StoryToolError::new(
                "AI_SESSION_NOT_FOUND",
                "AI Session was not found for the Story tool call.",
                404,
            )
        })?;
    invoke_for_session(
        service,
        bindings,
        &session,
        StoryToolInvocation {
            provider,
            provider_session_id,
            tool,
            arguments,
            call_id,
        },
    )
    .await
}

async fn invoke_for_session(
    service: &StoryToolService,
    bindings: &AgentRunMemberBindingStore,
    session: &AiSession,
    invocation: StoryToolInvocation<'_>,
) -> Result<Value, StoryToolError> {
    let StoryToolInvocation {
        provider,
        provider_session_id,
        tool,
        arguments,
        call_id,
    } = invocation;
    if tool == AiSessionAgentToolName::AgentRun {
        let request_id = invocation_request_id(provider, provider_session_id, call_id);
        let member = bindings
            .get_by_session(&session.id)
            .map(|binding| (binding.run_id, binding.member_id));
        service
            .invoke_agent_run(session, arguments, &request_id, member)
            .await
    } else {
        service.invoke_story_tool(session, tool, arguments).await
    }
}

pub struct StoryToolInvocation<'a> {
    pub provider: &'a str,
    pub provider_session_id: &'a str,
    pub tool: AiSessionAgentToolName,
    pub arguments: Value,
    pub call_id: Option<&'a str>,
}

pub fn invocation_request_id(
    provider: &str,
    provider_session_id: &str,
    call_id: Option<&str>,
) -> String {
    let identity = call_id
        .map(ToString::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let source = serde_json::to_vec(&json!([provider, provider_session_id, identity]))
        .expect("the MCP invocation identity is JSON serializable");
    format!("agent_tool_{}", hex::encode(Sha256::digest(source)))
}

pub fn required_thread_id_for(
    tool: AiSessionAgentToolName,
    meta: Option<&Value>,
) -> Result<&str, StoryToolError> {
    meta.and_then(Value::as_object)
        .and_then(|meta| meta.get("threadId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            let target = if tool == AiSessionAgentToolName::AgentRun {
                "Agent"
            } else {
                "Story"
            };
            StoryToolError::new(
                "AI_SESSION_IDENTITY_REQUIRED",
                format!("Codex did not provide a thread identity for the {target} tool call."),
                400,
            )
        })
}

pub fn optional_call_id(meta: Option<&Value>) -> Option<&str> {
    let meta = meta?.as_object()?;
    ["toolCallId", "callId"]
        .into_iter()
        .find_map(|key| meta.get(key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
}

pub fn tool_definitions() -> Vec<Value> {
    TOOL_DEFINITIONS.clone()
}

pub fn validate_tool_arguments(name: &str, arguments: &Value) -> Result<(), String> {
    let schema = tool_schema(name, "inputSchema")?;
    let validator = jsonschema::validator_for(schema).map_err(|error| error.to_string())?;
    validator
        .validate(arguments)
        .map_err(|error| error.to_string())
}

pub fn validate_tool_output(name: &str, output: &Value) -> Result<(), String> {
    let schema = tool_schema(name, "outputSchema")?;
    let validator = jsonschema::validator_for(schema).map_err(|error| error.to_string())?;
    validator
        .validate(output)
        .map_err(|error| error.to_string())
}

fn tool_schema<'a>(name: &str, key: &str) -> Result<&'a Value, String> {
    let definition = TOOL_DEFINITIONS
        .iter()
        .find(|definition| definition.get("name").and_then(Value::as_str) == Some(name))
        .ok_or_else(|| format!("Tool {name} not found"))?;
    definition
        .get(key)
        .ok_or_else(|| format!("Tool {name} has no {key}"))
}

fn validate_provider_session_id(value: &str) -> Result<(), StoryToolError> {
    if value.is_empty() || value.chars().count() > 240 {
        return Err(invalid_request(
            "providerSessionId must contain between 1 and 240 characters.",
        ));
    }
    Ok(())
}

fn invalid_request(message: &str) -> StoryToolError {
    StoryToolError::new("STORY_TOOL_FAILED", message, 400)
}

fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(serde::de::Error::custom("expected a value, not null"));
    }
    T::deserialize(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_id_matches_the_node_identity_contract() {
        assert_eq!(
            invocation_request_id("codex", "thread-1", Some("call-1")),
            format!(
                "agent_tool_{}",
                hex::encode(Sha256::digest(b"[\"codex\",\"thread-1\",\"call-1\"]"))
            )
        );
    }

    #[test]
    fn tool_catalog_covers_every_wire_name_without_session_identity_fields() {
        let definitions = tool_definitions();
        assert_eq!(definitions.len(), AiSessionAgentToolName::ALL.len());
        for definition in definitions {
            let properties = definition["inputSchema"]["properties"]
                .as_object()
                .expect("properties");
            assert_eq!(definition["execution"]["taskSupport"], "forbidden");
            assert!(definition["outputSchema"]["properties"].is_object());
            assert!(!properties.contains_key("storyId"));
            assert!(!properties.contains_key("providerSessionId"));
            assert!(
                !properties.contains_key("clientRequestId") || definition["name"] != "agent_run"
            );
        }
    }

    #[test]
    fn body_parser_rejects_cross_boundary_fields() {
        let error = serde_json::from_value::<AgentToolInvocationInput>(json!({
            "provider": "opencode",
            "providerSessionId": "session-1",
            "tool": "story_list_content",
            "arguments": {},
            "storyId": "story-1"
        }))
        .expect_err("unknown field must fail");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn read_only_annotations_match_the_node_catalog() {
        let read_only = tool_definitions()
            .into_iter()
            .filter(|tool| tool["annotations"]["readOnlyHint"] == true)
            .filter_map(|tool| tool["name"].as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        assert_eq!(
            read_only,
            vec![
                "story_list_content",
                "story_list_actions",
                "story_list_automations",
                "story_list_automation_runs",
                "story_list_ai_sessions",
                "story_get_ai_session",
                "story_get_ai_session_turn",
            ]
        );
    }
}
