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
use serde::de::DeserializeOwned;
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
        }
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
        if story_id.trim().is_empty()
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
        if let Some(agent_tools) = object
            .get("agentInvocation")
            .and_then(Value::as_object)
            .and_then(|grant| grant.get("enabledTools"))
            .and_then(Value::as_array)
        {
            for tool in agent_tools.iter().filter_map(Value::as_str) {
                if tool == "agent_run" && !enabled_tools.iter().any(|value| value == tool) {
                    enabled_tools.push(tool.to_string());
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

    pub fn invalidate_story_agent_tools(&self, input: &Value) -> Result<bool, StoryToolError> {
        let object = input.as_object().ok_or_else(|| {
            StoryToolError::new(
                "STORY_AGENT_TOOL_POLICY_INVALID",
                "Story agent tool invalidation must be an object.",
                400,
            )
        })?;
        if object
            .keys()
            .any(|key| key != "storyId" && key != "revision")
        {
            return Err(StoryToolError::new(
                "STORY_AGENT_TOOL_POLICY_INVALID",
                "Story agent tool invalidation contains unknown fields.",
                400,
            ));
        }
        let story_id = object
            .get("storyId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|story_id| !story_id.is_empty() && story_id.chars().count() <= 120)
            .ok_or_else(|| {
                StoryToolError::new(
                    "STORY_AGENT_TOOL_POLICY_INVALID",
                    "storyId is invalid.",
                    400,
                )
            })?;
        let revision = object
            .get("revision")
            .and_then(Value::as_str)
            .filter(|revision| is_policy_revision(revision))
            .ok_or_else(|| {
                StoryToolError::new(
                    "STORY_AGENT_TOOL_POLICY_INVALID",
                    "revision is invalid.",
                    400,
                )
            })?;
        let mut policies = self
            .policies
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if policies
            .get(story_id)
            .is_some_and(|policy| policy.revision == revision)
        {
            return Ok(false);
        }
        Ok(policies.remove(story_id).is_some())
    }

    pub async fn invoke_story_tool(
        &self,
        session: &AiSession,
        tool: AiSessionAgentToolName,
        arguments: Value,
    ) -> Result<Value, StoryToolError> {
        require_story(session)?;
        self.require_node_agent()?;
        match tool {
            AiSessionAgentToolName::StoryListContent => {
                let page = arguments.get("page").and_then(Value::as_u64).unwrap_or(1);
                let page_size = arguments
                    .get("pageSize")
                    .and_then(Value::as_u64)
                    .unwrap_or(20);
                serde_json::to_value(self.list(session, page, page_size).await?).map_err(|error| {
                    StoryToolError::new("STORY_TOOL_FAILED", error.to_string(), 500)
                })
            }
            AiSessionAgentToolName::StoryGetContent => {
                let input = parse_input(arguments)?;
                serde_json::to_value(self.get(session, input).await?).map_err(|error| {
                    StoryToolError::new("STORY_TOOL_FAILED", error.to_string(), 500)
                })
            }
            AiSessionAgentToolName::StorySetContent => {
                let input = parse_input(arguments)?;
                serde_json::to_value(self.set(session, input).await?).map_err(|error| {
                    StoryToolError::new("STORY_TOOL_FAILED", error.to_string(), 500)
                })
            }
            AiSessionAgentToolName::AgentRun => Err(StoryToolError::new(
                "AGENT_INVOCATION_IDENTITY_REQUIRED",
                "Agent invocation requires a provider-owned call identity.",
                400,
            )),
            _ => self
                .node_agent
                .invoke_story_agent_tool(&session.id, tool.as_str(), arguments)
                .await
                .map_err(Into::into),
        }
    }

    pub async fn invoke_agent_run(
        &self,
        session: &AiSession,
        arguments: Value,
        client_request_id: &str,
        member: Option<(String, String)>,
    ) -> Result<Value, StoryToolError> {
        self.require_node_agent()?;
        if client_request_id.trim().is_empty() || client_request_id.chars().count() > 160 {
            return Err(StoryToolError::new(
                "AGENT_INVOCATION_REQUEST_INVALID",
                "clientRequestId is invalid.",
                400,
            ));
        }
        if !arguments.is_object() {
            return Err(StoryToolError::new(
                "AGENT_INVOCATION_REQUEST_INVALID",
                "Agent invocation input must be an object.",
                400,
            ));
        }
        let request = json!({
            "clientRequestId": client_request_id,
            "input": arguments,
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
                "STORY_PAGE_INVALID",
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
        input: StoryContentGetInput,
    ) -> Result<StoryContentGetResult, StoryToolError> {
        require_story(session)?;
        self.require_node_agent()?;
        validate_get_input(&input)?;
        let destination = require_within_workspace(session, &input.destination_path, false)?;
        tokio::fs::create_dir_all(&destination)
            .await
            .map_err(path_io_error)?;
        let destination = tokio::fs::canonicalize(&destination)
            .await
            .map_err(path_io_error)?;
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
                        code: error.code,
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
            .map_err(path_io_error)?;
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
                file.write_all(&chunk).await.map_err(path_io_error)?;
            }
            file.flush().await.map_err(path_io_error)?;
            file.sync_all().await.map_err(path_io_error)?;
            drop(file);
            tokio::fs::rename(&temporary, &target)
                .await
                .map_err(path_io_error)
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
        input: StoryContentSetInput,
    ) -> Result<StoryContentSetResult, StoryToolError> {
        require_story(session)?;
        self.require_node_agent()?;
        validate_story_path_or_error(&input.story_path)?;
        let source = require_within_workspace(session, &input.source_path, true)?;
        let metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(path_io_error)?;
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
                "STORY_REVISION_INVALID",
                "expectedRevision must be a lowercase SHA-256 digest.",
                400,
            ));
        }
        let file = tokio::fs::File::open(&source)
            .await
            .map_err(path_io_error)?;
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

fn is_policy_revision(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_get_input(input: &StoryContentGetInput) -> Result<(), StoryToolError> {
    if input.story_paths.is_empty() || input.story_paths.len() > STORY_DEFAULT_MAX_BATCH_PATHS {
        return Err(StoryToolError::new(
            "STORY_CONTENT_GET_INVALID",
            "storyPaths must contain between 1 and 20 entries.",
            400,
        ));
    }
    for story_path in &input.story_paths {
        validate_story_path_or_error(story_path)?;
    }
    if input.destination_path.trim().is_empty() || input.destination_path.chars().count() > 4096 {
        return Err(StoryToolError::new(
            "STORY_CONTENT_GET_INVALID",
            "destinationPath must be between 1 and 4096 characters.",
            400,
        ));
    }
    Ok(())
}

fn validate_story_path_or_error(path: &str) -> Result<(), StoryToolError> {
    if validate_story_path(path) {
        return Ok(());
    }
    Err(StoryToolError::new(
        "STORY_PATH_INVALID",
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
    let root = std::fs::canonicalize(cwd).map_err(|error| {
        StoryToolError::new(
            "AI_SESSION_WORKSPACE_INVALID",
            format!("AI Session workspace is unavailable: {error}"),
            409,
        )
    })?;
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
            .map_err(path_io_error)?
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
    let canonical_base = std::fs::canonicalize(&existing).map_err(|error| {
        StoryToolError::new(
            "STORY_RUNTIME_PATH_OUTSIDE_WORKSPACE",
            format!("Story runtime path is unavailable: {error}"),
            403,
        )
    })?;
    let target = if must_exist {
        std::fs::canonicalize(&lexical).map_err(|error| {
            StoryToolError::new(
                "STORY_RUNTIME_PATH_NOT_FOUND",
                format!("Story runtime path does not exist: {error}"),
                404,
            )
        })?
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

fn path_io_error(error: std::io::Error) -> StoryToolError {
    StoryToolError::new("STORY_RUNTIME_PATH_INVALID", error.to_string(), 400)
}

async fn open_private_file(path: &Path) -> Result<tokio::fs::File, StoryToolError> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    options.open(path).await.map_err(path_io_error)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
