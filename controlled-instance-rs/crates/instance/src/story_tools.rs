use crate::node_agent_client::{NodeAgentClient, NodeAgentClientError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use controlled_instance_ai_session::{AiSession, AiSessionStoryAgentToolResolver};
use controlled_instance_protocol::{
    validate_story_path, validate_story_revision, AiSessionAgentToolName,
    StoryAgentContentListResult, StoryContentGetInput, StoryContentGetResult, StoryContentSetInput,
    StoryContentSetResult, StoryContentTransferError, StoryContentTransferItem,
    AI_SESSION_AGENT_TOOL_NAMES, STORY_DEFAULT_MAX_BATCH_PATHS, STORY_DEFAULT_MAX_FILE_BYTES,
};
use rand::RngCore;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct StoryToolError {
    pub code: String,
    pub message: String,
    pub status_code: u16,
    fastify_default: bool,
}

impl StoryToolError {
    pub(crate) fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        status_code: u16,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status_code,
            fastify_default: false,
        }
    }

    fn fastify(code: impl Into<String>, message: impl Into<String>, status_code: u16) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status_code,
            fastify_default: true,
        }
    }

    pub fn uses_fastify_default(&self) -> bool {
        self.fastify_default
    }
}

impl From<NodeAgentClientError> for StoryToolError {
    fn from(error: NodeAgentClientError) -> Self {
        let status_code = match &error {
            NodeAgentClientError::Disabled => 409,
            _ => error.status().map(|status| status.as_u16()).unwrap_or(502),
        };
        let code = match &error {
            NodeAgentClientError::Response {
                code: Some(code), ..
            } => code.clone(),
            NodeAgentClientError::Disabled => "STORY_NODE_AGENT_REQUIRED".to_string(),
            _ => "STORY_CONTENT_TRANSFER_FAILED".to_string(),
        };
        Self::new(code, error.to_string(), status_code)
    }
}

#[derive(Clone)]
pub struct StoryToolService {
    node_agent: NodeAgentClient,
    endpoint: Arc<String>,
    token: Arc<String>,
    policies: Arc<Mutex<HashMap<String, StoryToolPolicy>>>,
}

#[derive(Debug, Clone)]
struct StoryToolPolicy {
    revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoryAgentPageInput {
    #[serde(default = "default_story_page")]
    page: u64,
    #[serde(default = "default_story_page_size")]
    page_size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentInvocationInput {
    agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    orchestration_id: Option<String>,
    prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    budget: Option<AgentInvocationBudget>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentInvocationBudget {
    max_members: u64,
    max_depth: u64,
    max_concurrency: u64,
}

const AGENT_RUN_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

impl AgentInvocationInput {
    fn parse(value: &Value) -> Result<Self, StoryToolError> {
        let mut input: Self = serde_json::from_value(value.clone())
            .map_err(|error| StoryToolError::new("STORY_TOOL_FAILED", error.to_string(), 400))?;
        input.agent_id = trim_js_whitespace(&input.agent_id).to_string();
        if !valid_stable_id(&input.agent_id, 120) {
            return Err(StoryToolError::new(
                "STORY_TOOL_FAILED",
                "agentId is invalid.",
                400,
            ));
        }
        if let Some(orchestration_id) = input.orchestration_id.take() {
            let normalized = trim_js_whitespace(&orchestration_id).to_string();
            if !valid_stable_id(&normalized, 160) {
                return Err(StoryToolError::new(
                    "STORY_TOOL_FAILED",
                    "orchestrationId is invalid.",
                    400,
                ));
            }
            input.orchestration_id = Some(normalized);
        }
        input.prompt = trim_js_whitespace(&input.prompt).to_string();
        if input.prompt.is_empty() || input.prompt.chars().count() > 128_000 {
            return Err(StoryToolError::new(
                "STORY_TOOL_FAILED",
                "prompt must be between 1 and 128000 characters.",
                400,
            ));
        }
        if let Some(budget) = input.budget.as_ref() {
            if budget.max_members == 0
                || budget.max_members > AGENT_RUN_MAX_SAFE_INTEGER
                || budget.max_depth > AGENT_RUN_MAX_SAFE_INTEGER
                || budget.max_concurrency == 0
                || budget.max_concurrency > AGENT_RUN_MAX_SAFE_INTEGER
            {
                return Err(StoryToolError::new(
                    "STORY_TOOL_FAILED",
                    "budget is invalid.",
                    400,
                ));
            }
        }
        Ok(input)
    }
}

fn valid_stable_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= max
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

const fn default_story_page() -> u64 {
    1
}

const fn default_story_page_size() -> u64 {
    20
}

impl StoryToolService {
    pub fn new(node_agent: NodeAgentClient, endpoint: String) -> Self {
        let mut token = [0_u8; 32];
        rand::rng().fill_bytes(&mut token);
        Self {
            node_agent,
            endpoint: Arc::new(endpoint),
            token: Arc::new(URL_SAFE_NO_PAD.encode(token)),
            policies: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn runtime_environment(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            (
                "TASK_HANDOFF_AGENT_TOOLS_ENDPOINT".to_string(),
                (*self.endpoint).clone(),
            ),
            (
                "TASK_HANDOFF_AGENT_TOOLS_TOKEN".to_string(),
                (*self.token).clone(),
            ),
        ])
    }

    pub fn mcp_endpoint(&self) -> String {
        format!("{}/mcp", self.endpoint.trim_end_matches('/'))
    }

    pub fn opencode_runtime_environment(
        &self,
        plugin_path: Option<&Path>,
    ) -> BTreeMap<String, String> {
        let mut environment = self.runtime_environment();
        if let Some(plugin_path) = plugin_path {
            environment.insert(
                "TASK_HANDOFF_OPENCODE_STORY_PLUGIN".to_string(),
                plugin_path.display().to_string(),
            );
        }
        environment
    }

    pub async fn resolve_story_agent_tools(&self, story_id: &str) -> Vec<String> {
        if trim_js_whitespace(story_id).is_empty()
            || story_id.chars().count() > 120
            || !self.node_agent.enabled()
        {
            return Vec::new();
        }
        let Ok(value) = self
            .node_agent
            .resolve_story_agent_tools_for_story(story_id)
            .await
        else {
            return Vec::new();
        };
        self.remember_policy(story_id, value)
    }

    pub async fn resolve_story_agent_tools_for_session(&self, session: &AiSession) -> Vec<String> {
        let Some(story_id) = session.story_id.as_deref() else {
            return Vec::new();
        };
        if !self.node_agent.enabled() {
            return Vec::new();
        }
        let Ok(value) = self
            .node_agent
            .resolve_story_agent_tools_for_session(&session.id)
            .await
        else {
            return Vec::new();
        };
        self.remember_policy(story_id, value)
    }

    fn remember_policy(&self, story_id: &str, value: Value) -> Vec<String> {
        let Some(object) = value.as_object() else {
            return Vec::new();
        };
        if object.get("storyId").and_then(Value::as_str) != Some(story_id) {
            return Vec::new();
        }
        let Some(revision) = object
            .get("revision")
            .and_then(Value::as_str)
            .filter(|revision| is_policy_revision(revision))
        else {
            return Vec::new();
        };
        // Node validates the full resolution policy before granting anything.
        // A missing or half-shaped policy fails closed instead of inheriting
        // tools from an older producer.
        let Some(policy) = object.get("policy").and_then(Value::as_object) else {
            return Vec::new();
        };
        if ["content", "actions", "automations", "aiSessions"]
            .iter()
            .any(|key| policy.get(*key).and_then(Value::as_bool).is_none())
            || policy
                .get("decisions")
                .is_some_and(|value| !value.is_boolean())
        {
            return Vec::new();
        }
        let enabled_tools = object
            .get("enabledTools")
            .and_then(Value::as_array)
            .map(|tools| {
                tools
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|tool| AI_SESSION_AGENT_TOOL_NAMES.contains(tool))
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut enabled_tools = enabled_tools;
        let grant = object.get("agentInvocation").and_then(Value::as_object);
        let has_allowed_targets = grant
            .and_then(|grant| grant.get("allowedTargets"))
            .and_then(Value::as_array)
            .is_some_and(|targets| !targets.is_empty());
        if has_allowed_targets {
            if let Some(agent_tools) = grant
                .and_then(|grant| grant.get("enabledTools"))
                .and_then(Value::as_array)
            {
                for tool in agent_tools.iter().filter_map(Value::as_str) {
                    if tool == "agent_run" && !enabled_tools.iter().any(|value| value == tool) {
                        enabled_tools.push(tool.to_string());
                    }
                }
            }
        }
        self.policies
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                story_id.to_string(),
                StoryToolPolicy {
                    revision: revision.to_string(),
                },
            );
        enabled_tools
    }

    pub fn clear_policies(&self) {
        self.policies
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    pub fn invalidate_story_agent_tools(
        &self,
        input: Option<&Value>,
    ) -> Result<bool, StoryToolError> {
        let (story_id, revision) =
            validate_story_agent_tool_invalidation_optional(input).map_err(|issues| {
                let message = serde_json::to_string_pretty(&issues)
                    .unwrap_or_else(|_| "Story agent tool invalidation is invalid.".to_string());
                StoryToolError::fastify("ZOD_ERROR", message, 500)
            })?;
        let mut policies = self
            .policies
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if policies
            .get(&story_id)
            .is_some_and(|policy| policy.revision == revision)
        {
            return Ok(false);
        }
        Ok(policies.remove(&story_id).is_some())
    }

    pub async fn invoke_story_tool(
        &self,
        session: &AiSession,
        tool: AiSessionAgentToolName,
        arguments: Value,
    ) -> Result<Value, StoryToolError> {
        if tool == AiSessionAgentToolName::AgentRun {
            return Err(StoryToolError::new(
                "AGENT_INVOCATION_IDENTITY_REQUIRED",
                "Agent invocation requires a provider-owned call identity.",
                400,
            ));
        }
        require_story(session)?;
        self.require_node_agent()?;
        match tool {
            AiSessionAgentToolName::StoryListContent => {
                let input: StoryAgentPageInput = parse_input(if arguments.is_null() {
                    json!({})
                } else {
                    arguments
                })?;
                serde_json::to_value(self.list(session, input.page, input.page_size).await?)
                    .map_err(|error| {
                        StoryToolError::new("STORY_TOOL_FAILED", error.to_string(), 500)
                    })
            }
            AiSessionAgentToolName::StoryGetContent => {
                serde_json::to_value(self.get(session, Some(arguments)).await?).map_err(|error| {
                    StoryToolError::new("STORY_TOOL_FAILED", error.to_string(), 500)
                })
            }
            AiSessionAgentToolName::StorySetContent => {
                serde_json::to_value(self.set(session, Some(arguments)).await?).map_err(|error| {
                    StoryToolError::new("STORY_TOOL_FAILED", error.to_string(), 500)
                })
            }
            AiSessionAgentToolName::AgentRun => Err(StoryToolError::new(
                "AGENT_INVOCATION_IDENTITY_REQUIRED",
                "Agent invocation requires a provider-owned call identity.",
                400,
            )),
            _ => {
                crate::story_agent_tool_bridge::validate_tool_arguments(tool.as_str(), &arguments)
                    .map_err(|message| StoryToolError::new("STORY_TOOL_FAILED", message, 400))?;
                let value = self
                    .node_agent
                    .invoke_story_agent_tool(&session.id, tool.as_str(), arguments)
                    .await
                    .map_err(StoryToolError::from)?;
                crate::story_agent_tool_bridge::validate_tool_output(tool.as_str(), &value)
                    .map_err(|message| StoryToolError::new("STORY_TOOL_FAILED", message, 400))?;
                Ok(value)
            }
        }
    }

    pub async fn invoke_agent_run(
        &self,
        session: &AiSession,
        arguments: Value,
        client_request_id: &str,
        member: Option<(String, String)>,
    ) -> Result<Value, StoryToolError> {
        let client_request_id = trim_js_whitespace(client_request_id);
        if client_request_id.is_empty() || client_request_id.chars().count() > 160 {
            return Err(StoryToolError::new(
                "AGENT_INVOCATION_REQUEST_INVALID",
                "clientRequestId is invalid.",
                400,
            ));
        }
        let input = AgentInvocationInput::parse(&arguments)?;
        let request = json!({
            "clientRequestId": client_request_id,
            "input": input,
        });
        match member {
            Some((run_id, member_id)) => self
                .node_agent
                .invoke_agent_run_for_member(&run_id, &member_id, &session.id, request)
                .await
                .map_err(Into::into),
            None => {
                require_story(session)?;
                self.node_agent
                    .invoke_agent_run(&session.id, request)
                    .await
                    .map_err(Into::into)
            }
        }
    }

    pub async fn list(
        &self,
        session: &AiSession,
        page: u64,
        page_size: u64,
    ) -> Result<StoryAgentContentListResult, StoryToolError> {
        require_story(session)?;
        self.require_node_agent()?;
        if !(1..=500).contains(&page) || !(1..=100).contains(&page_size) {
            return Err(StoryToolError::new(
                "STORY_TOOL_FAILED",
                "Story page and pageSize are outside the allowed range.",
                400,
            ));
        }
        self.node_agent
            .list_story_content(&session.id, page, page_size)
            .await
            .map_err(Into::into)
    }

    pub async fn get(
        &self,
        session: &AiSession,
        value: Option<Value>,
    ) -> Result<StoryContentGetResult, StoryToolError> {
        require_story(session)?;
        self.require_node_agent()?;
        let input = parse_get_input_value(value.as_ref())?;
        self.get_parsed(session, input).await
    }

    async fn get_parsed(
        &self,
        session: &AiSession,
        input: StoryContentGetInput,
    ) -> Result<StoryContentGetResult, StoryToolError> {
        let destination = require_within_workspace(session, &input.destination_path, false)?;
        tokio::fs::create_dir_all(&destination)
            .await
            .map_err(|error| raw_fs_error(error, "mkdir", &destination, None))?;
        let mut items = Vec::with_capacity(input.story_paths.len());
        for story_path in input.story_paths {
            let transfer = self
                .get_one(session, &destination, &story_path)
                .await
                .unwrap_or_else(|error| StoryContentTransferItem {
                    story_path,
                    path: None,
                    revision: None,
                    error: Some(StoryContentTransferError {
                        code: if error.code == "STORY_CONTENT_TRANSFER_FAILED" {
                            "STORY_CONTENT_GET_FAILED".to_string()
                        } else {
                            error.code
                        },
                        message: error.message.chars().take(2000).collect(),
                    }),
                });
            items.push(transfer);
        }
        Ok(StoryContentGetResult { items })
    }

    async fn get_one(
        &self,
        session: &AiSession,
        destination: &Path,
        story_path: &str,
    ) -> Result<StoryContentTransferItem, StoryToolError> {
        validate_story_path_or_error(story_path)?;
        let target = require_within_workspace(
            session,
            &destination.join(story_path).display().to_string(),
            false,
        )?;
        let parent = target.parent().ok_or_else(|| {
            StoryToolError::new(
                "STORY_RUNTIME_PATH_INVALID",
                "Story destination path has no parent directory.",
                400,
            )
        })?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| raw_fs_error(error, "mkdir", parent, None))?;
        let (mut response, revision) = self
            .node_agent
            .download_story_content(&session.id, story_path)
            .await?;
        let temporary = target.with_extension(format!(
            "{}.{}.tmp",
            target
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default(),
            Uuid::new_v4().simple()
        ));
        let mut file = open_private_file(&temporary).await?;
        let result = async {
            while let Some(chunk) = response.chunk().await.map_err(|error| {
                StoryToolError::new("STORY_CONTENT_DOWNLOAD_FAILED", error.to_string(), 502)
            })? {
                file.write_all(&chunk)
                    .await
                    .map_err(|error| raw_fs_error(error, "write", &temporary, None))?;
            }
            file.flush()
                .await
                .map_err(|error| raw_fs_error(error, "fsync", &temporary, None))?;
            file.sync_all()
                .await
                .map_err(|error| raw_fs_error(error, "fsync", &temporary, None))?;
            drop(file);
            tokio::fs::rename(&temporary, &target)
                .await
                .map_err(|error| raw_fs_error(error, "rename", &temporary, Some(&target)))
        }
        .await;
        if let Err(error) = result {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error);
        }
        Ok(StoryContentTransferItem {
            story_path: story_path.to_string(),
            path: Some(target.display().to_string()),
            revision: Some(revision),
            error: None,
        })
    }

    pub async fn set(
        &self,
        session: &AiSession,
        value: Option<Value>,
    ) -> Result<StoryContentSetResult, StoryToolError> {
        require_story(session)?;
        self.require_node_agent()?;
        let input = parse_set_input_value(value.as_ref())?;
        let source = require_within_workspace(session, &input.source_path, true)?;
        let metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|error| raw_fs_error(error, "lstat", &source, None))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(StoryToolError::new(
                "STORY_SOURCE_NOT_FILE",
                "Story source must be a regular file.",
                400,
            ));
        }
        if metadata.len() > STORY_DEFAULT_MAX_FILE_BYTES {
            return Err(StoryToolError::new(
                "STORY_FILE_TOO_LARGE",
                "Story source exceeds the node limit.",
                413,
            ));
        }
        if input
            .expected_revision
            .as_deref()
            .is_some_and(|revision| !validate_story_revision(revision))
        {
            return Err(StoryToolError::new(
                "STORY_TOOL_FAILED",
                "expectedRevision must be a lowercase SHA-256 digest.",
                400,
            ));
        }
        let file = tokio::fs::File::open(&source)
            .await
            .map_err(|error| raw_fs_error(error, "open", &source, None))?;
        self.node_agent
            .upload_story_content(
                &session.id,
                &input.story_path,
                input.title.as_deref(),
                input.expected_revision.as_deref(),
                file,
                metadata.len(),
            )
            .await
            .map_err(Into::into)
    }

    fn require_node_agent(&self) -> Result<(), StoryToolError> {
        if self.node_agent.enabled() {
            Ok(())
        } else {
            Err(StoryToolError::new(
                "STORY_NODE_AGENT_REQUIRED",
                "Story tools require a managed controlled instance.",
                409,
            ))
        }
    }
}

#[async_trait::async_trait]
impl AiSessionStoryAgentToolResolver for StoryToolService {
    async fn resolve(&self, story_id: &str) -> Vec<String> {
        self.resolve_story_agent_tools(story_id).await
    }
}

fn require_story(session: &AiSession) -> Result<(), StoryToolError> {
    if session.story_id.as_deref().is_none_or(str::is_empty) {
        return Err(StoryToolError::new(
            "STORY_CONTEXT_REQUIRED",
            "AI Session is not assigned to a Story.",
            409,
        ));
    }
    Ok(())
}

fn parse_input<T: DeserializeOwned>(value: Value) -> Result<T, StoryToolError> {
    serde_json::from_value(value).map_err(|error| {
        StoryToolError::new(
            "STORY_TOOL_FAILED",
            format!("Story tool input is invalid: {error}"),
            400,
        )
    })
}

#[cfg(test)]
fn parse_get_input(value: Value) -> Result<StoryContentGetInput, StoryToolError> {
    parse_get_input_value(Some(&value))
}

#[cfg(test)]
fn parse_set_input(value: Value) -> Result<StoryContentSetInput, StoryToolError> {
    parse_set_input_value(Some(&value))
}

fn parse_get_input_value(value: Option<&Value>) -> Result<StoryContentGetInput, StoryToolError> {
    let Some(object) = zod_object(value)? else {
        return Err(zod_input_error(Vec::new()));
    };
    let mut issues = Vec::new();
    let story_paths = match object.get("storyPaths") {
        Some(Value::Array(values)) => {
            if values.is_empty() {
                issues.push((
                    "storyPaths".to_string(),
                    "Too small: expected array to have >=1 items".to_string(),
                ));
            } else if values.len() > STORY_DEFAULT_MAX_BATCH_PATHS {
                issues.push((
                    "storyPaths".to_string(),
                    format!(
                        "Too big: expected array to have <={STORY_DEFAULT_MAX_BATCH_PATHS} items"
                    ),
                ));
            }
            values
                .iter()
                .enumerate()
                .filter_map(|(index, value)| {
                    zod_story_path(value, &format!("storyPaths.{index}"), &mut issues)
                })
                .collect()
        }
        Some(value) => {
            issues.push((
                "storyPaths".to_string(),
                format!(
                    "Invalid input: expected array, received {}",
                    js_received_type(value)
                ),
            ));
            Vec::new()
        }
        None => {
            issues.push((
                "storyPaths".to_string(),
                "Invalid input: expected array, received undefined".to_string(),
            ));
            Vec::new()
        }
    };
    let destination_path = zod_bounded_string(
        object.get("destinationPath"),
        "destinationPath",
        1,
        4096,
        &mut issues,
    )
    .unwrap_or_default();
    zod_unknown_keys(object, &["storyPaths", "destinationPath"], &mut issues);
    if !issues.is_empty() {
        return Err(zod_input_error(issues));
    }
    Ok(StoryContentGetInput {
        story_paths,
        destination_path,
    })
}

fn parse_set_input_value(value: Option<&Value>) -> Result<StoryContentSetInput, StoryToolError> {
    let Some(object) = zod_object(value)? else {
        return Err(zod_input_error(Vec::new()));
    };
    let mut issues = Vec::new();
    let story_path =
        zod_story_path_value(object.get("storyPath"), "storyPath", &mut issues).unwrap_or_default();
    let title = match object.get("title") {
        Some(value) => zod_bounded_string(Some(value), "title", 1, 240, &mut issues),
        None => None,
    };
    let source_path =
        zod_bounded_string(object.get("sourcePath"), "sourcePath", 1, 4096, &mut issues)
            .unwrap_or_default();
    let expected_revision = match object.get("expectedRevision") {
        Some(Value::String(revision)) => {
            if validate_story_revision(revision) {
                Some(revision.clone())
            } else {
                issues.push((
                    "expectedRevision".to_string(),
                    "Invalid string: must match pattern /^[a-f0-9]{64}$/".to_string(),
                ));
                None
            }
        }
        Some(value) => {
            issues.push((
                "expectedRevision".to_string(),
                format!(
                    "Invalid input: expected string, received {}",
                    js_received_type(value)
                ),
            ));
            None
        }
        None => None,
    };
    zod_unknown_keys(
        object,
        &["storyPath", "title", "sourcePath", "expectedRevision"],
        &mut issues,
    );
    if !issues.is_empty() {
        return Err(zod_input_error(issues));
    }
    Ok(StoryContentSetInput {
        story_path,
        title,
        source_path,
        expected_revision,
    })
}

fn zod_object(
    value: Option<&Value>,
) -> Result<Option<&serde_json::Map<String, Value>>, StoryToolError> {
    match value {
        Some(Value::Object(object)) => Ok(Some(object)),
        Some(value) => Err(zod_input_error(vec![(
            "body".to_string(),
            format!(
                "Invalid input: expected object, received {}",
                js_received_type(value)
            ),
        )])),
        None => Err(zod_input_error(vec![(
            "body".to_string(),
            "Invalid input: expected object, received undefined".to_string(),
        )])),
    }
}

fn zod_story_path(value: &Value, path: &str, issues: &mut Vec<(String, String)>) -> Option<String> {
    zod_story_path_value(Some(value), path, issues)
}

fn zod_story_path_value(
    value: Option<&Value>,
    path: &str,
    issues: &mut Vec<(String, String)>,
) -> Option<String> {
    let Some(value) = value else {
        issues.push((
            path.to_string(),
            "Invalid input: expected string, received undefined".to_string(),
        ));
        return None;
    };
    let Some(value) = value.as_str() else {
        issues.push((
            path.to_string(),
            format!(
                "Invalid input: expected string, received {}",
                js_received_type(value)
            ),
        ));
        return None;
    };
    let value = trim_js_whitespace(value);
    let length = value.chars().count();
    if length == 0 {
        issues.push((
            path.to_string(),
            "Too small: expected string to have >=1 characters".to_string(),
        ));
    } else if length > 1024 {
        issues.push((
            path.to_string(),
            "Too big: expected string to have <=1024 characters".to_string(),
        ));
    }
    if !validate_story_path(value) {
        issues.push((
            path.to_string(),
            "Story paths must be normalized relative POSIX paths.".to_string(),
        ));
    }
    Some(value.to_string())
}

fn zod_bounded_string(
    value: Option<&Value>,
    path: &str,
    minimum: usize,
    maximum: usize,
    issues: &mut Vec<(String, String)>,
) -> Option<String> {
    let Some(value) = value else {
        issues.push((
            path.to_string(),
            "Invalid input: expected string, received undefined".to_string(),
        ));
        return None;
    };
    let Some(value) = value.as_str() else {
        issues.push((
            path.to_string(),
            format!(
                "Invalid input: expected string, received {}",
                js_received_type(value)
            ),
        ));
        return None;
    };
    let value = trim_js_whitespace(value);
    let length = value.chars().count();
    if length < minimum {
        issues.push((
            path.to_string(),
            format!("Too small: expected string to have >={minimum} characters"),
        ));
    }
    if length > maximum {
        issues.push((
            path.to_string(),
            format!("Too big: expected string to have <={maximum} characters"),
        ));
    }
    Some(value.to_string())
}

fn zod_unknown_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    issues: &mut Vec<(String, String)>,
) {
    let unknown = object
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect::<Vec<_>>();
    if unknown.is_empty() {
        return;
    }
    issues.push((
        "body".to_string(),
        format!(
            "Unrecognized key{}: {}",
            if unknown.len() == 1 { "" } else { "s" },
            unknown.join(", ")
        ),
    ));
}

fn zod_input_error(issues: Vec<(String, String)>) -> StoryToolError {
    StoryToolError::new(
        "AI_SESSION_CONTROL_INVALID",
        issues
            .into_iter()
            .map(|(path, message)| format!("{path}: {message}"))
            .collect::<Vec<_>>()
            .join("; "),
        400,
    )
}

fn is_policy_revision(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum StoryAgentToolPolicyValidationIssue {
    InvalidType {
        expected: &'static str,
        code: &'static str,
        path: Vec<String>,
        message: String,
    },
    TooSmall {
        origin: &'static str,
        code: &'static str,
        minimum: usize,
        inclusive: bool,
        path: Vec<String>,
        message: String,
    },
    TooBig {
        origin: &'static str,
        code: &'static str,
        maximum: usize,
        inclusive: bool,
        path: Vec<String>,
        message: String,
    },
    InvalidFormat {
        origin: &'static str,
        code: &'static str,
        format: &'static str,
        pattern: &'static str,
        path: Vec<String>,
        message: String,
    },
    UnrecognizedKeys {
        code: &'static str,
        keys: Vec<String>,
        path: Vec<String>,
        message: String,
    },
}

#[cfg(test)]
fn validate_story_agent_tool_invalidation(
    input: &Value,
) -> Result<(String, String), Vec<StoryAgentToolPolicyValidationIssue>> {
    validate_story_agent_tool_invalidation_optional(Some(input))
}

fn validate_story_agent_tool_invalidation_optional(
    input: Option<&Value>,
) -> Result<(String, String), Vec<StoryAgentToolPolicyValidationIssue>> {
    let Some(object) = input.and_then(Value::as_object) else {
        return Err(vec![StoryAgentToolPolicyValidationIssue::InvalidType {
            expected: "object",
            code: "invalid_type",
            path: Vec::new(),
            message: format!(
                "Invalid input: expected object, received {}",
                js_value_type(input)
            ),
        }]);
    };
    let mut issues = Vec::new();
    let story_id = zod_trimmed_string(object.get("storyId"), "storyId", 1, 120, &mut issues);
    let revision = match object.get("revision") {
        Some(Value::String(value)) if is_policy_revision(value) => Some(value.clone()),
        Some(Value::String(_)) => {
            issues.push(StoryAgentToolPolicyValidationIssue::InvalidFormat {
                origin: "string",
                code: "invalid_format",
                format: "regex",
                pattern: "/^[a-f0-9]{64}$/",
                path: vec!["revision".to_string()],
                message: "Invalid string: must match pattern /^[a-f0-9]{64}$/".to_string(),
            });
            None
        }
        value => {
            issues.push(StoryAgentToolPolicyValidationIssue::InvalidType {
                expected: "string",
                code: "invalid_type",
                path: vec!["revision".to_string()],
                message: format!(
                    "Invalid input: expected string, received {}",
                    js_value_type(value)
                ),
            });
            None
        }
    };
    let unknown = object
        .keys()
        .filter(|key| !matches!(key.as_str(), "storyId" | "revision"))
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        let count = unknown.len();
        let listed = unknown
            .iter()
            .map(|key| format!("\"{key}\""))
            .collect::<Vec<_>>()
            .join(", ");
        issues.push(StoryAgentToolPolicyValidationIssue::UnrecognizedKeys {
            code: "unrecognized_keys",
            keys: unknown,
            path: Vec::new(),
            message: format!(
                "Unrecognized key{}: {listed}",
                if count == 1 { "" } else { "s" }
            ),
        });
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok((
        story_id.expect("validated story id"),
        revision.expect("validated revision"),
    ))
}

fn zod_trimmed_string(
    value: Option<&Value>,
    key: &str,
    minimum: usize,
    maximum: usize,
    issues: &mut Vec<StoryAgentToolPolicyValidationIssue>,
) -> Option<String> {
    let Some(value) = value.and_then(Value::as_str) else {
        issues.push(StoryAgentToolPolicyValidationIssue::InvalidType {
            expected: "string",
            code: "invalid_type",
            path: vec![key.to_string()],
            message: format!(
                "Invalid input: expected string, received {}",
                js_value_type(value)
            ),
        });
        return None;
    };
    let value = trim_js_whitespace(value);
    let length = value.chars().count();
    if length < minimum {
        issues.push(StoryAgentToolPolicyValidationIssue::TooSmall {
            origin: "string",
            code: "too_small",
            minimum,
            inclusive: true,
            path: vec![key.to_string()],
            message: format!("Too small: expected string to have >={minimum} characters"),
        });
        return None;
    }
    if length > maximum {
        issues.push(StoryAgentToolPolicyValidationIssue::TooBig {
            origin: "string",
            code: "too_big",
            maximum,
            inclusive: true,
            path: vec![key.to_string()],
            message: format!("Too big: expected string to have <={maximum} characters"),
        });
        return None;
    }
    Some(value.to_string())
}

fn js_value_type(value: Option<&Value>) -> &'static str {
    value.map_or("undefined", js_received_type)
}

fn js_received_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn trim_js_whitespace(value: &str) -> &str {
    value.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
}

fn validate_story_path_or_error(path: &str) -> Result<(), StoryToolError> {
    if validate_story_path(path) {
        return Ok(());
    }
    Err(StoryToolError::new(
        "STORY_TOOL_FAILED",
        "Story paths must be normalized relative POSIX paths.",
        400,
    ))
}

fn require_within_workspace(
    session: &AiSession,
    candidate: &str,
    must_exist: bool,
) -> Result<PathBuf, StoryToolError> {
    let cwd = session.cwd.as_deref().ok_or_else(|| {
        StoryToolError::new(
            "AI_SESSION_WORKSPACE_REQUIRED",
            "AI Session has no workspace.",
            409,
        )
    })?;
    let root = std::fs::canonicalize(cwd)
        .map_err(|error| raw_fs_error(error, "lstat", Path::new(cwd), None))?;
    if !root.is_dir() {
        return Err(StoryToolError::new(
            "AI_SESSION_WORKSPACE_INVALID",
            "AI Session workspace is not a directory.",
            409,
        ));
    }
    let candidate = Path::new(candidate);
    let lexical = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| raw_fs_error(error, "getcwd", Path::new(""), None))?
            .join(candidate)
    };
    let lexical = normalize_path(&lexical);
    let mut existing = lexical.clone();
    while !existing.exists() {
        let Some(parent) = existing.parent() else {
            break;
        };
        if parent == existing {
            break;
        }
        existing = parent.to_path_buf();
    }
    let canonical_base = std::fs::canonicalize(&existing)
        .map_err(|error| raw_fs_error(error, "lstat", &existing, None))?;
    let target = if must_exist {
        std::fs::canonicalize(&lexical)
            .map_err(|error| raw_fs_error(error, "lstat", &lexical, None))?
    } else {
        normalize_path(
            &canonical_base.join(
                lexical
                    .strip_prefix(&existing)
                    .unwrap_or_else(|_| Path::new("")),
            ),
        )
    };
    if target != root && !target.starts_with(&root) {
        return Err(StoryToolError::new(
            "STORY_RUNTIME_PATH_OUTSIDE_WORKSPACE",
            "Story runtime path is outside the AI Session workspace.",
            403,
        ));
    }
    if let Ok(metadata) = std::fs::symlink_metadata(&lexical) {
        if metadata.file_type().is_symlink() {
            return Err(StoryToolError::new(
                "STORY_RUNTIME_PATH_SYMLINK",
                "Story runtime path must not be a symbolic link.",
                403,
            ));
        }
    }
    Ok(target)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn raw_fs_error(
    error: std::io::Error,
    operation: &str,
    target: &Path,
    second_target: Option<&Path>,
) -> StoryToolError {
    let (code, description) = node_fs_error(&error);
    let target = match second_target {
        Some(second) => format!("'{}' -> '{}'", target.display(), second.display()),
        None => format!("'{}'", target.display()),
    };
    StoryToolError::fastify(
        code,
        format!("{code}: {description}, {operation} {target}"),
        500,
    )
}

fn node_fs_error(error: &std::io::Error) -> (&'static str, &'static str) {
    #[cfg(unix)]
    if let Some(errno) = error.raw_os_error() {
        let mapped = match errno {
            libc::EACCES => Some(("EACCES", "permission denied")),
            libc::EEXIST => Some(("EEXIST", "file already exists")),
            libc::EISDIR => Some(("EISDIR", "illegal operation on a directory")),
            libc::ELOOP => Some(("ELOOP", "too many symbolic links encountered")),
            libc::ENAMETOOLONG => Some(("ENAMETOOLONG", "name too long")),
            libc::ENOENT => Some(("ENOENT", "no such file or directory")),
            libc::ENOSPC => Some(("ENOSPC", "no space left on device")),
            libc::ENOTDIR => Some(("ENOTDIR", "not a directory")),
            libc::EPERM => Some(("EPERM", "operation not permitted")),
            libc::EROFS => Some(("EROFS", "read-only file system")),
            _ => None,
        };
        if let Some(mapped) = mapped {
            return mapped;
        }
    }
    match error.kind() {
        std::io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        std::io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        std::io::ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        std::io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        std::io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        std::io::ErrorKind::ReadOnlyFilesystem => ("EROFS", "read-only file system"),
        std::io::ErrorKind::StorageFull => ("ENOSPC", "no space left on device"),
        _ => ("EIO", "i/o error"),
    }
}

async fn open_private_file(path: &Path) -> Result<tokio::fs::File, StoryToolError> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    options
        .open(path)
        .await
        .map_err(|error| raw_fs_error(error, "open", path, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::ControlMode, node_agent_client::NodeAgentClientConfig};
    use std::time::Duration;

    fn session(cwd: PathBuf) -> AiSession {
        serde_json::from_value(serde_json::json!({
            "id": "ses_0000000000000",
            "agent": "codex",
            "cwd": cwd,
            "storyId": "story-1",
            "startedAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:00:00.000Z"
        }))
        .expect("session")
    }

    fn disabled_service() -> StoryToolService {
        StoryToolService::new(
            NodeAgentClient::new(NodeAgentClientConfig {
                control_mode: ControlMode::Controlled,
                node_agent_url: None,
                registration_token: None,
                instance_id: Some("ins_test".to_string()),
                project_id: None,
                node_id: None,
                runtime_id: None,
                image_id: None,
                image_tag: None,
                heartbeat_interval: Duration::from_secs(10),
            }),
            "http://127.0.0.1:1".to_string(),
        )
    }

    #[tokio::test]
    async fn agent_run_identity_error_precedes_story_and_node_agent_checks() {
        let root = tempfile::tempdir().expect("root");
        let mut state = session(root.path().to_path_buf());
        state.story_id = None;
        let error = disabled_service()
            .invoke_story_tool(&state, AiSessionAgentToolName::AgentRun, json!({}))
            .await
            .expect_err("agent_run must require a provider identity");
        assert_eq!(error.code, "AGENT_INVOCATION_IDENTITY_REQUIRED");
        assert_eq!(error.status_code, 400);
    }

    #[tokio::test]
    async fn agent_run_validation_precedes_node_agent_and_story_checks() {
        let root = tempfile::tempdir().expect("root");
        let mut state = session(root.path().to_path_buf());
        state.story_id = None;
        let service = disabled_service();

        let error = service
            .invoke_agent_run(
                &state,
                json!({ "agentId": "agent-1", "prompt": "work", "future": true }),
                "request-1",
                None,
            )
            .await
            .expect_err("invalid invocation input");
        assert_eq!(error.code, "STORY_TOOL_FAILED");
        assert_eq!(error.status_code, 400);

        let error = service
            .invoke_agent_run(
                &state,
                json!({ "agentId": "agent-1", "prompt": "work" }),
                "   ",
                None,
            )
            .await
            .expect_err("invalid client request id");
        assert_eq!(error.code, "AGENT_INVOCATION_REQUEST_INVALID");
        assert_eq!(error.status_code, 400);

        let error = service
            .invoke_agent_run(
                &state,
                json!({ "agentId": "agent-1", "prompt": "work" }),
                "request-2",
                None,
            )
            .await
            .expect_err("missing story");
        assert_eq!(error.code, "STORY_CONTEXT_REQUIRED");
        assert_eq!(error.status_code, 409);

        let mut story_state = state;
        story_state.story_id = Some("story-1".to_string());
        let error = service
            .invoke_agent_run(
                &story_state,
                json!({ "agentId": "agent-1", "prompt": "work" }),
                "request-3",
                None,
            )
            .await
            .expect_err("disabled node agent");
        assert_eq!(error.code, "STORY_NODE_AGENT_REQUIRED");
        assert_eq!(error.status_code, 409);
    }

    #[test]
    fn workspace_resolution_rejects_parent_traversal_and_symlinks() {
        let root = tempfile::tempdir().expect("root");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let state = session(workspace.clone());
        assert!(require_within_workspace(
            &state,
            &workspace.join("ok.md").display().to_string(),
            false
        )
        .is_ok());
        assert!(require_within_workspace(
            &state,
            &root.path().join("outside").display().to_string(),
            false
        )
        .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path(), workspace.join("link")).expect("symlink");
            assert!(require_within_workspace(
                &state,
                &workspace.join("link/out").display().to_string(),
                false
            )
            .is_err());
        }
    }

    #[test]
    fn story_agent_inputs_follow_the_node_schema_transforms() {
        let page: StoryAgentPageInput = parse_input(json!({})).expect("defaults");
        assert_eq!((page.page, page.page_size), (1, 20));
        assert!(parse_input::<StoryAgentPageInput>(json!({"cursor": "next"})).is_err());
        assert!(parse_input::<StoryAgentPageInput>(json!({"page": "2"})).is_err());
        assert!(parse_input::<StoryAgentPageInput>(json!({"page": null})).is_err());

        let get = parse_get_input(json!({
            "storyPaths": [" notes/one.md "],
            "destinationPath": " output "
        }))
        .expect("get input");
        assert_eq!(get.story_paths, vec!["notes/one.md"]);
        assert_eq!(get.destination_path, "output");

        let set = parse_set_input(json!({
            "storyPath": " notes/two.md ",
            "sourcePath": " draft.md ",
            "title": " Release notes "
        }))
        .expect("set input");
        assert_eq!(set.story_path, "notes/two.md");
        assert_eq!(set.source_path, "draft.md");
        assert_eq!(set.title.as_deref(), Some("Release notes"));
        assert!(parse_set_input(json!({
            "storyPath": "notes/two.md",
            "sourcePath": "draft.md",
            "title": null
        }))
        .is_err());
    }

    #[test]
    fn agent_run_inputs_are_normalized_before_the_node_agent_boundary() {
        let input = AgentInvocationInput::parse(&json!({
            "agentId": " agent-1 ",
            "orchestrationId": " default:agent-1 ",
            "prompt": "  do the work  ",
            "budget": {
                "maxMembers": 2,
                "maxDepth": 0,
                "maxConcurrency": 1
            }
        }))
        .expect("agent input");
        let serialized = serde_json::to_value(input).expect("serialized input");
        assert_eq!(serialized["agentId"], "agent-1");
        assert_eq!(serialized["orchestrationId"], "default:agent-1");
        assert_eq!(serialized["prompt"], "do the work");
        assert_eq!(serialized["budget"]["maxDepth"], 0);

        assert!(AgentInvocationInput::parse(&json!({
            "agentId": "agent-1",
            "prompt": "   "
        }))
        .is_err());
        assert!(AgentInvocationInput::parse(&json!({
            "agentId": "agent-1",
            "prompt": "work",
            "future": true
        }))
        .is_err());
        assert!(AgentInvocationInput::parse(&json!({
            "agentId": "agent-1",
            "prompt": "work",
            "budget": {"maxMembers": 0, "maxDepth": 0, "maxConcurrency": 1}
        }))
        .is_err());
    }

    #[test]
    fn missing_story_source_uses_the_node_enoent_error_shape() {
        let root = tempfile::tempdir().expect("root");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let state = session(workspace.clone());
        let missing = workspace.join("missing.md");
        let error = require_within_workspace(&state, &missing.display().to_string(), true)
            .expect_err("missing source");
        assert_eq!(error.code, "ENOENT");
        assert_eq!(error.status_code, 500);
        assert!(error.uses_fastify_default());
        assert_eq!(
            error.message,
            format!(
                "ENOENT: no such file or directory, lstat '{}'",
                missing.display()
            )
        );
    }

    #[test]
    fn missing_workspace_uses_the_node_realpath_error_shape() {
        let root = tempfile::tempdir().expect("root");
        let missing = root.path().join("missing-workspace");
        let error = require_within_workspace(
            &session(missing.clone()),
            &missing.join("file.md").display().to_string(),
            false,
        )
        .expect_err("missing workspace");
        assert_eq!(error.code, "ENOENT");
        assert_eq!(error.status_code, 500);
        assert!(error.uses_fastify_default());
        assert_eq!(
            error.message,
            format!(
                "ENOENT: no such file or directory, lstat '{}'",
                missing.display()
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn raw_fs_errors_use_the_node_sync_realpath_and_lstat_syscalls() {
        let root = tempfile::tempdir().expect("root");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let state = session(workspace.clone());
        let file = workspace.join("file");
        std::fs::write(&file, "value").expect("file");
        let not_a_directory = file.join("child");
        let error = require_within_workspace(&state, &not_a_directory.display().to_string(), true)
            .expect_err("ENOTDIR source");
        assert_eq!(error.code, "ENOTDIR");
        assert_eq!(error.status_code, 500);
        assert!(error.uses_fastify_default());
        assert_eq!(
            error.message,
            format!(
                "ENOTDIR: not a directory, lstat '{}'",
                not_a_directory.display()
            )
        );

        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let inaccessible = workspace.join("inaccessible");
        std::fs::create_dir_all(&inaccessible).expect("inaccessible directory");
        std::fs::set_permissions(
            &inaccessible,
            std::os::unix::fs::PermissionsExt::from_mode(0o000),
        )
        .expect("remove access");
        let denied = inaccessible.join("child");
        let error = require_within_workspace(&state, &denied.display().to_string(), true)
            .expect_err("EACCES source");
        std::fs::set_permissions(
            &inaccessible,
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .expect("restore access");
        assert_eq!(error.code, "EACCES");
        assert_eq!(error.status_code, 500);
        assert!(error.uses_fastify_default());
        assert_eq!(
            error.message,
            format!("EACCES: permission denied, lstat '{}'", denied.display())
        );
    }

    #[test]
    fn policy_invalidation_validation_matches_zod_issue_messages() {
        let issues =
            validate_story_agent_tool_invalidation(&json!({})).expect_err("missing fields");
        assert_eq!(
            serde_json::to_value(issues).expect("issues"),
            json!([
                {
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["storyId"],
                    "message": "Invalid input: expected string, received undefined"
                },
                {
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["revision"],
                    "message": "Invalid input: expected string, received undefined"
                }
            ])
        );

        let issues = validate_story_agent_tool_invalidation(&json!({
            "storyId": " story ",
            "revision": "x",
            "extra": true
        }))
        .expect_err("invalid revision and unknown field");
        assert_eq!(
            serde_json::to_value(issues).expect("issues"),
            json!([
                {
                    "origin": "string",
                    "code": "invalid_format",
                    "format": "regex",
                    "pattern": "/^[a-f0-9]{64}$/",
                    "path": ["revision"],
                    "message": "Invalid string: must match pattern /^[a-f0-9]{64}$/"
                },
                {
                    "code": "unrecognized_keys",
                    "keys": ["extra"],
                    "path": [],
                    "message": "Unrecognized key: \"extra\""
                }
            ])
        );

        let (story_id, revision) = validate_story_agent_tool_invalidation(&json!({
            "storyId": " \u{feff}story \u{feff} ",
            "revision": "a".repeat(64)
        }))
        .expect("valid invalidation");
        assert_eq!(story_id, "story");
        assert_eq!(revision, "a".repeat(64));
    }
}
