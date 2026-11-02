use crate::{
    agent_run_bindings::AgentRunMemberBindingStore,
    story_tools::{StoryToolError, StoryToolService},
};
use controlled_instance_ai_session::{AiSession, AiSessionRuntime};
use controlled_instance_protocol::AiSessionAgentToolName;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentToolInvocationInput {
    pub provider: String,
    pub provider_session_id: String,
    pub tool: AiSessionAgentToolName,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default)]
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

pub fn required_thread_id(meta: Option<&Value>) -> Result<&str, StoryToolError> {
    meta.and_then(Value::as_object)
        .and_then(|meta| meta.get("threadId"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            StoryToolError::new(
                "AI_SESSION_IDENTITY_REQUIRED",
                "Codex did not provide a thread identity for the Story tool call.",
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
    AiSessionAgentToolName::ALL
        .iter()
        .copied()
        .map(|tool| {
            let mut definition = Map::from_iter([
                ("name".to_string(), json!(tool.as_str())),
                ("description".to_string(), json!(description(tool))),
                ("inputSchema".to_string(), input_schema(tool)),
                ("outputSchema".to_string(), json!({"type": "object"})),
            ]);
            if is_read_only(tool) {
                definition.insert("annotations".to_string(), json!({"readOnlyHint": true}));
            }
            Value::Object(definition)
        })
        .collect()
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

fn description(tool: AiSessionAgentToolName) -> &'static str {
    match tool {
        AiSessionAgentToolName::StoryListContent => "List indexed documents in the current Story, ordered newest to oldest. Start with page 1 and continue with pagination.nextPage when present.",
        AiSessionAgentToolName::StoryGetContent => "Copy documents selected from story_list_content into the current AI Session workspace.",
        AiSessionAgentToolName::StorySetContent => "Create or replace one indexed Story document from a workspace file; use expectedRevision to prevent overwriting a newer version.",
        AiSessionAgentToolName::StoryListActions => "List preset Actions in the Story assigned to the current AI Session.",
        AiSessionAgentToolName::StoryRunAction => "Run one preset Story Action using its configured target instance and session preset.",
        AiSessionAgentToolName::StoryListAutomations => "List Automations and their effective status for the current Story.",
        AiSessionAgentToolName::StoryCreateAutomation => "Create a long-lived Automation using an existing preset Action in the current Story.",
        AiSessionAgentToolName::StoryUpdateAutomation => "Update or enable an Automation in the current Story with optimistic concurrency.",
        AiSessionAgentToolName::StoryDeleteAutomation => "Delete an Automation in the current Story with optimistic concurrency.",
        AiSessionAgentToolName::StoryRunAutomation => "Run an Automation in the current Story immediately.",
        AiSessionAgentToolName::StoryListAutomationRuns => "List recent runs for an Automation in the current Story.",
        AiSessionAgentToolName::StoryListAiSessions => "List other active root AI Sessions assigned to the current Story.",
        AiSessionAgentToolName::StoryGetAiSession => "Read compact session details and Turn summaries for another active root AI Session in the current Story.",
        AiSessionAgentToolName::StoryGetAiSessionTurn => "Read one Turn's conversation and tool items from another active root AI Session in the current Story.",
        AiSessionAgentToolName::StoryRequestDecision => "Ask the operator for a decision. Use this when progress depends on a human choice, missing context, or approval that cannot be derived from the workspace.",
        AiSessionAgentToolName::AgentRun => "Run an Agent authorized for this Story and wait for its bounded final result.",
    }
}

fn is_read_only(tool: AiSessionAgentToolName) -> bool {
    matches!(
        tool,
        AiSessionAgentToolName::StoryListContent
            | AiSessionAgentToolName::StoryListActions
            | AiSessionAgentToolName::StoryListAutomations
            | AiSessionAgentToolName::StoryListAutomationRuns
            | AiSessionAgentToolName::StoryListAiSessions
            | AiSessionAgentToolName::StoryGetAiSession
            | AiSessionAgentToolName::StoryGetAiSessionTurn
    )
}

fn input_schema(tool: AiSessionAgentToolName) -> Value {
    let page = || {
        json!({
            "page": {"type": "integer", "minimum": 1, "maximum": 500, "default": 1},
            "pageSize": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}
        })
    };
    let object = |properties: Value, required: &[&str]| {
        json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        })
    };
    match tool {
        AiSessionAgentToolName::StoryListContent
        | AiSessionAgentToolName::StoryListActions
        | AiSessionAgentToolName::StoryListAutomations
        | AiSessionAgentToolName::StoryListAiSessions => object(page(), &[]),
        AiSessionAgentToolName::StoryGetContent => object(
            json!({
                "storyPaths": {
                    "type": "array",
                    "items": story_path_schema(),
                    "minItems": 1,
                    "maxItems": 20
                },
                "destinationPath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }),
            &["storyPaths", "destinationPath"],
        ),
        AiSessionAgentToolName::StorySetContent => object(
            json!({
                "storyPath": story_path_schema(),
                "title": {"type": "string", "minLength": 1, "maxLength": 240},
                "sourcePath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "expectedRevision": revision_schema()
            }),
            &["storyPath", "sourcePath"],
        ),
        AiSessionAgentToolName::StoryRunAction => object(
            json!({
                "actionId": {"type": "string", "minLength": 1, "maxLength": 120},
                "clientRequestId": {"type": "string", "minLength": 1, "maxLength": 160}
            }),
            &["actionId", "clientRequestId"],
        ),
        AiSessionAgentToolName::StoryCreateAutomation => object(
            json!({
                "actionId": {"type": "string", "minLength": 1, "maxLength": 120},
                "schedule": schedule_schema(),
                "enabled": {"type": "boolean", "default": true},
                "policy": automation_policy_schema()
            }),
            &["actionId", "schedule"],
        ),
        AiSessionAgentToolName::StoryUpdateAutomation => object(
            json!({
                "automationId": {"type": "string", "minLength": 1, "maxLength": 120},
                "expectedUpdatedAt": {"type": "string", "format": "date-time"},
                "actionId": {"type": "string", "minLength": 1, "maxLength": 120},
                "schedule": schedule_schema(),
                "enabled": {"type": "boolean"},
                "policy": automation_policy_schema()
            }),
            &["automationId", "expectedUpdatedAt"],
        ),
        AiSessionAgentToolName::StoryDeleteAutomation => object(
            json!({
                "automationId": {"type": "string", "minLength": 1, "maxLength": 120},
                "expectedUpdatedAt": {"type": "string", "format": "date-time"}
            }),
            &["automationId", "expectedUpdatedAt"],
        ),
        AiSessionAgentToolName::StoryRunAutomation => object(
            json!({
                "automationId": {"type": "string", "minLength": 1, "maxLength": 120},
                "clientRequestId": {"type": "string", "minLength": 1, "maxLength": 160}
            }),
            &["automationId", "clientRequestId"],
        ),
        AiSessionAgentToolName::StoryListAutomationRuns => object(
            json!({
                "automationId": {"type": "string", "minLength": 1, "maxLength": 120},
                "page": {"type": "integer", "minimum": 1, "maximum": 500, "default": 1},
                "pageSize": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}
            }),
            &["automationId"],
        ),
        AiSessionAgentToolName::StoryGetAiSession => object(
            json!({
                "instanceId": {"type": "string", "minLength": 1, "maxLength": 120},
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 120},
                "page": {"type": "integer", "minimum": 1, "maximum": 500, "default": 1},
                "pageSize": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10}
            }),
            &["instanceId", "sessionId"],
        ),
        AiSessionAgentToolName::StoryGetAiSessionTurn => object(
            json!({
                "instanceId": {"type": "string", "minLength": 1, "maxLength": 120},
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 120},
                "turnId": {"type": "string", "minLength": 1, "maxLength": 240},
                "page": {"type": "integer", "minimum": 1, "maximum": 500, "default": 1},
                "pageSize": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
                "maxTextChars": {"type": "integer", "minimum": 256, "maximum": 32000, "default": 8000}
            }),
            &["instanceId", "sessionId", "turnId"],
        ),
        AiSessionAgentToolName::StoryRequestDecision => object(
            json!({
                "question": {"type": "string", "minLength": 1, "maxLength": 32000},
                "options": {
                    "type": "array",
                    "maxItems": 20,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "minLength": 1, "maxLength": 120},
                            "label": {"type": "string", "minLength": 1, "maxLength": 240},
                            "description": {"type": "string", "maxLength": 2000}
                        },
                        "required": ["id", "label"],
                        "additionalProperties": false
                    }
                },
                "allowFreeText": {"type": "boolean"},
                "context": {"type": "string", "maxLength": 8000}
            }),
            &["question"],
        ),
        AiSessionAgentToolName::AgentRun => object(
            json!({
                "agentId": {"type": "string", "minLength": 1, "maxLength": 120},
                "orchestrationId": {"type": "string", "minLength": 1, "maxLength": 120},
                "prompt": {"type": "string", "minLength": 1, "maxLength": 128000},
                "budget": {
                    "type": "object",
                    "properties": {
                        "maxMembers": {"type": "integer", "minimum": 1},
                        "maxDepth": {"type": "integer", "minimum": 0},
                        "maxConcurrency": {"type": "integer", "minimum": 1}
                    },
                    "required": ["maxMembers", "maxDepth", "maxConcurrency"],
                    "additionalProperties": false
                }
            }),
            &["agentId", "prompt"],
        ),
    }
}

fn story_path_schema() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": 1024,
        "pattern": "^(?!/)(?!.*\\\\).*(?:^|/)(?:(?!\\.{1,2}(?:/|$)).)*$"
    })
}

fn revision_schema() -> Value {
    json!({"type": "string", "pattern": "^[a-f0-9]{64}$"})
}

fn schedule_schema() -> Value {
    json!({
        "oneOf": [
            {
                "type": "object",
                "properties": {
                    "scheduleKind": {"const": "interval"},
                    "intervalMs": {"type": "integer", "minimum": 60000}
                },
                "required": ["scheduleKind", "intervalMs"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "scheduleKind": {"const": "daily"},
                    "timeOfDay": {"type": "string", "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"},
                    "timezone": {"type": "string", "minLength": 1, "maxLength": 120}
                },
                "required": ["scheduleKind", "timeOfDay", "timezone"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "scheduleKind": {"const": "weekly"},
                    "weekdays": {
                        "type": "array",
                        "items": {"type": "integer", "minimum": 0, "maximum": 6},
                        "minItems": 1,
                        "maxItems": 7,
                        "uniqueItems": true
                    },
                    "timeOfDay": {"type": "string", "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"},
                    "timezone": {"type": "string", "minLength": 1, "maxLength": 120}
                },
                "required": ["scheduleKind", "weekdays", "timeOfDay", "timezone"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "scheduleKind": {"const": "monthly"},
                    "dayOfMonth": {
                        "type": "integer",
                        "minimum": -3,
                        "maximum": 31,
                        "not": {"const": 0}
                    },
                    "timeOfDay": {"type": "string", "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"},
                    "timezone": {"type": "string", "minLength": 1, "maxLength": 120}
                },
                "required": ["scheduleKind", "dayOfMonth", "timeOfDay", "timezone"],
                "additionalProperties": false
            }
        ]
    })
}

fn automation_policy_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "cooldownMs": {"type": "integer", "minimum": 0, "maximum": 86400000},
            "maxConcurrentRuns": {"type": "integer", "minimum": 1, "maximum": 20, "default": 1},
            "whenBusy": {"type": "string", "enum": ["skip", "queue"], "default": "skip"}
        },
        "additionalProperties": false
    })
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
