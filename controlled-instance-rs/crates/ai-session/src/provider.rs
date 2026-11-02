use crate::{
    AiSession, AiSessionAttachmentDraftStreams, AiSessionConversationAttachmentStore,
    AiSessionMessageAttachmentInput, AiSessionRuntime, AiSessionStoreError,
    RetainedAiSessionMessageAttachment, StageMessageAttachmentsInput,
    StagedAiSessionMessageAttachments,
};
use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};
use controlled_instance_protocol::{
    mint_entity_id, AiSessionAttachmentKind, AiSessionAttachmentScopeType, AiSessionCommandInput,
    AiSessionCommandResult, AiSessionConversationAttachment, AiSessionHistoryItem,
    AiSessionMentionCatalog, AiSessionMentionFileSearch, AiSessionMessageAttachmentMeta,
    AiSessionProviderCapability, AiSessionProviderTimelineCapabilities, AiSessionQueue,
    AiSessionTimeline, AiSessionTurnTimeline,
};
use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, RwLock},
};
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderError {
    pub code: String,
    pub message: String,
    pub status_code: u16,
}

impl ProviderError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, status_code: u16) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status_code,
        }
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new("AI_SESSION_CONTROL_UNSUPPORTED", message, 400)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("AI_SESSION_NOT_FOUND", message, 404)
    }

    pub fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, message, 409)
    }

    pub fn bad_gateway(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, message, 502)
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProviderError {}

impl From<AiSessionStoreError> for ProviderError {
    fn from(error: AiSessionStoreError) -> Self {
        match error {
            AiSessionStoreError::NotFound => Self::not_found("AI session not found."),
            AiSessionStoreError::TitleConflict => Self::conflict(
                "AI_SESSION_RENAME_CONFLICT",
                "The session title changed before the rename was applied.",
            ),
            AiSessionStoreError::QueueRevisionConflict { current_revision } => Self::conflict(
                "AI_SESSION_QUEUE_REVISION_CONFLICT",
                format!("AI session queue changed at revision {current_revision}."),
            ),
            AiSessionStoreError::QueueItemNotFound => Self::new(
                "AI_SESSION_QUEUE_ITEM_NOT_FOUND",
                "Queued message not found.",
                404,
            ),
            AiSessionStoreError::QueueItemNotEditable => Self::conflict(
                "AI_SESSION_QUEUE_ITEM_NOT_EDITABLE",
                "Only queued messages can be edited.",
            ),
            AiSessionStoreError::QueueOrderInvalid => Self::conflict(
                "AI_SESSION_QUEUE_ORDER_INVALID",
                "Queue order must contain every currently queued message exactly once.",
            ),
            AiSessionStoreError::InvalidId => {
                Self::new("AI_SESSION_INVALID_ID", "AI Session id is invalid.", 400)
            }
            other => Self::new("AI_SESSION_PERSISTENCE_FAILED", other.to_string(), 500),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AiSessionPermissionMode {
    Ask,
    AutoReview,
    FullAccess,
}

impl AiSessionPermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::AutoReview => "auto-review",
            Self::FullAccess => "full-access",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiSessionSendMode {
    Auto,
    Queue,
    Steer,
    Immediate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionModelSelection {
    pub model_entity_id: String,
    #[serde(default)]
    pub model_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_upstream_name: Option<String>,
}

impl AiSessionModelSelection {
    pub fn upstream_name(&self) -> &str {
        self.model_upstream_name
            .as_deref()
            .unwrap_or(self.model_name.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiSessionModelSelectionIntent {
    /// A selection already stored on a session. A removed model is reported as
    /// a stale session selection so callers can ask the user to choose again.
    Session,
    /// A fresh selection supplied by a control action. A missing target is
    /// distinct from a stale session selection.
    Target,
}

/// Resolves a wire model selection against the instance's authoritative private
/// catalog. Provider implementations only consume the normalized stable
/// identity; catalog ownership and error semantics stay outside the adapter.
pub trait AiSessionModelSelectionResolver: Send + Sync {
    fn resolve(
        &self,
        agent: &str,
        requested: Option<&AiSessionModelSelection>,
        intent: AiSessionModelSelectionIntent,
    ) -> Result<Option<AiSessionModelSelection>, ProviderError>;

    /// Project the model/provider reported by a provider's authoritative
    /// session snapshot into the instance's public catalog identity.
    ///
    /// A configured projector intentionally returns `None` when the observed
    /// model is not in the instance catalog. Callers must distinguish that
    /// case from "no projector configured" through
    /// [`Self::supports_observed_model_projection`].
    fn project_observed_model_selection(
        &self,
        _agent: &str,
        _model_provider: &str,
        _model: &str,
    ) -> Option<AiSessionModelSelection> {
        None
    }

    fn supports_observed_model_projection(&self, _agent: &str) -> bool {
        false
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionReference {
    pub kind: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionRuntimePathInput {
    #[serde(rename = "type")]
    pub runtime_path_type: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionAttachmentInput {
    pub id: String,
    #[serde(default)]
    pub kind: Option<AiSessionAttachmentKind>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    pub source: AiSessionAttachmentSourceInput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum AiSessionAttachmentSourceInput {
    Inline { encoding: String, data: String },
    RuntimePath { path: String },
    UploadRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionMessageInput {
    pub message: String,
    #[serde(default)]
    pub mode: Option<AiSessionSendMode>,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub attachments: Vec<AiSessionAttachmentInput>,
    #[serde(default)]
    pub references: Vec<AiSessionReference>,
    #[serde(default)]
    pub permission_mode: Option<AiSessionPermissionMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSessionCreateInput {
    pub agent: String,
    pub cwd: AiSessionRuntimePathInput,
    #[serde(default)]
    pub cwd_folder_id: Option<String>,
    #[serde(default)]
    pub git_selection: Option<Value>,
    #[serde(default)]
    pub workspace_selection: Option<Value>,
    #[serde(default)]
    pub model_selection: Option<AiSessionModelSelection>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub story_id: Option<String>,
    #[serde(flatten)]
    pub message: AiSessionMessageInput,
}

#[derive(Debug, Clone)]
pub struct ProviderCreateInput {
    pub cwd: PathBuf,
    pub runtime_workspace_roots: Vec<PathBuf>,
    pub permission_mode: Option<AiSessionPermissionMode>,
    pub model_selection: Option<AiSessionModelSelection>,
    pub reasoning_effort: Option<String>,
    pub story_agent_tools: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct ProviderCreateResult {
    pub provider_session_id: String,
    pub cwd: PathBuf,
    pub model_selection: Option<AiSessionModelSelection>,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderForkInput {
    pub through_turn_id: Option<String>,
    pub cwd: Option<PathBuf>,
    pub story_agent_tools: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct ProviderResumeResult {
    pub model_selection: Option<AiSessionModelSelection>,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderAttachment {
    pub meta: AiSessionMessageAttachmentMeta,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ProviderMessage {
    pub message: String,
    pub attachments: Vec<ProviderAttachment>,
    pub references: Vec<AiSessionReference>,
    pub permission_mode: Option<AiSessionPermissionMode>,
    pub message_id: Option<String>,
    pub user_message_attachments: Vec<AiSessionConversationAttachment>,
    pub story_agent_tools: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct ProviderAction {
    pub action: String,
    pub turn_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub decision: Option<String>,
    pub queue_id: Option<String>,
}

impl ProviderAction {
    pub fn simple(action: &str) -> Self {
        Self {
            action: action.to_string(),
            turn_id: None,
            provider_turn_id: None,
            decision: None,
            queue_id: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AiSessionActionResult {
    pub session: AiSession,
    pub provider: String,
    pub action: ProviderAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionCreateResult {
    pub disposition: String,
    pub ai_session_id: String,
    pub provider_session_id: String,
    pub creation_source: String,
}

#[derive(Debug, Clone, Default)]
pub struct AiSessionManagedCreateOptions {
    pub runtime_workspace_roots: Vec<PathBuf>,
    pub agent_tools: Option<Vec<String>>,
}

#[async_trait::async_trait]
pub trait AiSessionStoryAgentToolResolver: Send + Sync {
    async fn resolve(&self, story_id: &str) -> Vec<String>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionResumeResult {
    pub disposition: String,
    pub ai_session_id: String,
    pub provider_session_id: String,
    pub creation_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionForkResult {
    pub disposition: String,
    pub ai_session_id: String,
    pub provider_session_id: String,
    pub creation_source: String,
}

#[derive(Debug, Clone)]
pub enum ProviderEvent {
    ThreadSnapshot {
        provider_session_id: String,
        cwd: Option<String>,
        name: Option<String>,
        model: Option<String>,
        model_provider: Option<String>,
        reasoning_effort: Option<String>,
        status: String,
        phase: Option<String>,
    },
    TurnStarted {
        provider_session_id: String,
        turn_id: String,
        started_at: Option<String>,
    },
    TurnCompleted {
        provider_session_id: String,
        turn_id: Option<String>,
        status: Option<String>,
        error: Option<String>,
        completed_at: Option<String>,
    },
    SessionError {
        provider_session_id: String,
        error: String,
    },
    ContextCompaction {
        provider_session_id: String,
        turn_id: String,
        item_id: String,
        status: String,
        observed_at: Option<String>,
    },
    ThreadClosed {
        provider_session_id: String,
    },
    UserMessage {
        provider_session_id: String,
        turn_id: String,
        item_id: String,
        text: String,
        observed_at: Option<String>,
    },
    AgentMessageDelta {
        provider_session_id: String,
        turn_id: String,
        item_id: String,
        delta: String,
    },
    AgentMessageCompleted {
        provider_session_id: String,
        turn_id: String,
        item_id: String,
        text: String,
        observed_at: Option<String>,
    },
    TimelineItem {
        provider_session_id: String,
        item: controlled_instance_protocol::AiSessionTimelineItem,
    },
    TimelineItemDelta {
        provider_session_id: String,
        turn_id: String,
        item_id: String,
        field: String,
        delta: String,
    },
    ToolActivity {
        provider_session_id: String,
        turn_id: Option<String>,
        item: Value,
        running: bool,
        observed_at: Option<String>,
    },
    ApprovalRequested {
        provider_session_id: String,
        turn_id: Option<String>,
        summary: String,
        kind: String,
        item_id: Option<String>,
    },
    ApprovalResolved {
        provider_session_id: String,
        decision: String,
    },
    ConnectionChanged {
        connected: bool,
    },
}

#[async_trait]
pub trait AiSessionControlProvider: Send + Sync {
    fn agent(&self) -> &str;

    fn capability(&self) -> AiSessionProviderCapability;

    fn timeline_capabilities(&self) -> AiSessionProviderTimelineCapabilities {
        self.capability().timeline
    }

    /// Provider sessions that cannot be restored after archiving must be
    /// detached instead of archived when the user closes an AI Session.
    fn close_detaches_provider_session(&self) -> bool {
        false
    }

    fn interrupt_preserves_turn(&self) -> bool {
        false
    }

    fn subscribe_events(&self) -> Option<broadcast::Receiver<ProviderEvent>> {
        None
    }

    async fn create_session(
        &self,
        _input: ProviderCreateInput,
    ) -> Result<ProviderCreateResult, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} does not support direct AI session creation.",
            self.agent()
        )))
    }

    async fn start_message(
        &self,
        _session: &AiSession,
        _input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not support starting turns.",
            self.agent()
        )))
    }

    async fn steer_message(
        &self,
        _session: &AiSession,
        _input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not support turn steering.",
            self.agent()
        )))
    }

    async fn interrupt(&self, _session: &AiSession) -> Result<ProviderAction, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not support turn interruption.",
            self.agent()
        )))
    }

    async fn resolve_approval(
        &self,
        _session: &AiSession,
        _decision: &str,
    ) -> Result<ProviderAction, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not expose structured approval control.",
            self.agent()
        )))
    }

    async fn rename_session(
        &self,
        _session: &AiSession,
        _title: &str,
    ) -> Result<(), ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not support renaming.",
            self.agent()
        )))
    }

    async fn resume_session(
        &self,
        _session: &AiSession,
    ) -> Result<ProviderResumeResult, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not support resuming.",
            self.agent()
        )))
    }

    async fn fork_session(
        &self,
        _source: &AiSession,
        _input: ProviderForkInput,
    ) -> Result<ProviderCreateResult, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not support Fork.",
            self.agent()
        )))
    }

    async fn update_model_selection(
        &self,
        _session: &AiSession,
        _selection: &AiSessionModelSelection,
    ) -> Result<Option<AiSessionModelSelection>, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not support in-session model switching.",
            self.agent()
        )))
    }

    async fn update_reasoning_effort(
        &self,
        _session: &AiSession,
        _reasoning_effort: &str,
    ) -> Result<Option<String>, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not support in-session reasoning effort changes.",
            self.agent()
        )))
    }

    async fn archive_session(&self, _provider_session_id: &str) -> Result<(), ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not support archiving.",
            self.agent()
        )))
    }

    async fn delete_session(&self, _provider_session_id: &str) -> Result<(), ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not support deletion.",
            self.agent()
        )))
    }

    async fn unsubscribe_session(&self, _provider_session_id: &str) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn mention_catalog(
        &self,
        _session: &AiSession,
    ) -> Result<AiSessionMentionCatalog, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not expose mention candidates.",
            self.agent()
        )))
    }

    async fn search_mention_files(
        &self,
        _session: &AiSession,
        _query: &str,
    ) -> Result<AiSessionMentionFileSearch, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not expose file mention search.",
            self.agent()
        )))
    }

    async fn execute_command(
        &self,
        _session: &AiSession,
        _input: &AiSessionCommandInput,
    ) -> Result<AiSessionCommandResult, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not support commands.",
            self.agent()
        )))
    }

    async fn timeline(&self, _session: &AiSession) -> Result<AiSessionTimeline, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not expose Timeline reads.",
            self.agent()
        )))
    }

    async fn turn_timeline(
        &self,
        _session: &AiSession,
        _turn_id: &str,
    ) -> Result<AiSessionTurnTimeline, ProviderError> {
        Err(ProviderError::unsupported(format!(
            "{} sessions do not expose per-turn Timeline reads.",
            self.agent()
        )))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletedCreateOperation {
    client_request_id: String,
    fingerprint: String,
    result: AiSessionCreateResult,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateOperationStore {
    #[serde(default = "default_operation_version")]
    version: u8,
    #[serde(default)]
    completed: Vec<CompletedCreateOperation>,
}

fn default_operation_version() -> u8 {
    2
}

type SharedOperation<T> =
    futures_util::future::Shared<Pin<Box<dyn Future<Output = Result<T, ProviderError>> + Send>>>;

pub struct AiSessionController {
    runtime: Arc<AiSessionRuntime>,
    attachments: Arc<AiSessionConversationAttachmentStore>,
    attachment_streams: Arc<AiSessionAttachmentDraftStreams>,
    providers: RwLock<BTreeMap<String, Arc<dyn AiSessionControlProvider>>>,
    model_selection_resolver: RwLock<Option<Arc<dyn AiSessionModelSelectionResolver>>>,
    story_agent_tool_resolver: RwLock<Option<Arc<dyn AiSessionStoryAgentToolResolver>>>,
    changes: broadcast::Sender<()>,
    create_lock: Mutex<()>,
    completed_creates: Mutex<HashMap<String, CompletedCreateOperation>>,
    create_store_path: Option<PathBuf>,
    session_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    completed_sends: Mutex<HashMap<String, (String, AiSessionActionResult)>>,
    pending_sends: Mutex<HashMap<String, (String, SharedOperation<AiSessionActionResult>)>>,
    pending_settings: Mutex<HashSet<String>>,
    tool_activity: Mutex<HashMap<String, ToolActivityTracker>>,
}

#[derive(Default)]
struct ToolActivityTracker {
    seen_tool_ids: HashSet<String>,
    active_tools: Vec<(String, Value)>,
    context_compaction: Option<Value>,
}

#[derive(Debug, Clone)]
struct ToolActivityState {
    current_tool: Option<Value>,
    tool_calls_since_last_message: u64,
    new_tool_ids: u64,
    new_edits: u64,
}

impl ToolActivityTracker {
    fn started(&mut self, tool: Value) -> ToolActivityState {
        self.context_compaction = None;
        let Some(id) = tool
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToString::to_string)
        else {
            return self.snapshot(0, 0);
        };
        if self.seen_tool_ids.contains(&id) {
            return self.snapshot(0, 0);
        }
        self.seen_tool_ids.insert(id.clone());
        self.active_tools.retain(|(known, _)| known != &id);
        self.active_tools.push((id, tool.clone()));
        let edits = u64::from(
            tool.get("kind")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind == "fileChange"),
        );
        self.snapshot(1, edits)
    }

    fn completed(&mut self, tool: Value) -> ToolActivityState {
        let Some(id) = tool
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToString::to_string)
        else {
            return self.snapshot(0, 0);
        };
        let new_tool = self.seen_tool_ids.insert(id.clone());
        self.active_tools.retain(|(known, _)| known != &id);
        self.snapshot(u64::from(new_tool), 0)
    }

    fn compacting(
        &mut self,
        turn_id: &str,
        status: &str,
        observed_at: Option<&str>,
    ) -> ToolActivityState {
        let mut tool = Map::new();
        tool.insert(
            "id".to_string(),
            json!(format!("context_compaction:{turn_id}")),
        );
        tool.insert("kind".to_string(), json!("context-compaction"));
        tool.insert(
            "name".to_string(),
            json!(if status == "completed" {
                "Context compacted"
            } else {
                "Compacting context…"
            }),
        );
        if status == "running" {
            if let Some(observed_at) = observed_at {
                tool.insert("startedAt".to_string(), json!(observed_at));
            }
        }
        self.context_compaction = Some(Value::Object(tool));
        self.snapshot(0, 0)
    }

    fn reset_for_agent_message(&mut self) -> ToolActivityState {
        self.seen_tool_ids.clear();
        self.active_tools.clear();
        self.context_compaction = None;
        self.snapshot(0, 0)
    }

    fn clear_active_tools(&mut self) -> ToolActivityState {
        self.active_tools.clear();
        self.context_compaction = None;
        self.snapshot(0, 0)
    }

    fn snapshot(&self, new_tool_ids: u64, new_edits: u64) -> ToolActivityState {
        ToolActivityState {
            current_tool: self
                .context_compaction
                .clone()
                .or_else(|| self.active_tools.last().map(|(_, tool)| tool.clone())),
            tool_calls_since_last_message: self.seen_tool_ids.len() as u64,
            new_tool_ids,
            new_edits,
        }
    }
}

impl AiSessionController {
    pub fn new(
        runtime: Arc<AiSessionRuntime>,
        attachments: Arc<AiSessionConversationAttachmentStore>,
        attachment_streams: Arc<AiSessionAttachmentDraftStreams>,
        create_store_path: Option<PathBuf>,
    ) -> Arc<Self> {
        let (changes, _) = broadcast::channel(64);
        let controller = Arc::new(Self {
            runtime,
            attachments,
            attachment_streams,
            providers: RwLock::new(BTreeMap::new()),
            model_selection_resolver: RwLock::new(None),
            story_agent_tool_resolver: RwLock::new(None),
            changes,
            create_lock: Mutex::new(()),
            completed_creates: Mutex::new(HashMap::new()),
            create_store_path,
            session_locks: Mutex::new(HashMap::new()),
            completed_sends: Mutex::new(HashMap::new()),
            pending_sends: Mutex::new(HashMap::new()),
            pending_settings: Mutex::new(HashSet::new()),
            tool_activity: Mutex::new(HashMap::new()),
        });
        controller.restore_completed_creates();
        controller
    }

    pub fn runtime(&self) -> &Arc<AiSessionRuntime> {
        &self.runtime
    }

    pub fn attachments(&self) -> &Arc<AiSessionConversationAttachmentStore> {
        &self.attachments
    }

    pub fn set_model_selection_resolver(&self, resolver: Arc<dyn AiSessionModelSelectionResolver>) {
        *self
            .model_selection_resolver
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(resolver);
    }

    pub fn set_story_agent_tool_resolver(
        &self,
        resolver: Arc<dyn AiSessionStoryAgentToolResolver>,
    ) {
        *self
            .story_agent_tool_resolver
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(resolver);
    }

    async fn resolve_story_agent_tools(&self, story_id: Option<&str>) -> Option<Vec<String>> {
        let story_id = story_id?;
        let resolver = self
            .story_agent_tool_resolver
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()?;
        Some(resolver.resolve(story_id).await)
    }

    fn resolve_model_selection(
        &self,
        agent: &str,
        requested: Option<&AiSessionModelSelection>,
        intent: AiSessionModelSelectionIntent,
    ) -> Result<Option<AiSessionModelSelection>, ProviderError> {
        let resolver = self
            .model_selection_resolver
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        match resolver {
            Some(resolver) => resolver.resolve(agent, requested, intent),
            None => Ok(requested.cloned()),
        }
    }

    pub fn project_observed_model_selection(
        &self,
        agent: &str,
        model_provider: &str,
        model: &str,
    ) -> Option<Option<AiSessionModelSelection>> {
        let resolver = self
            .model_selection_resolver
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()?;
        resolver
            .supports_observed_model_projection(agent)
            .then(|| resolver.project_observed_model_selection(agent, model_provider, model))
    }

    pub fn attachment_streams(&self) -> &Arc<AiSessionAttachmentDraftStreams> {
        &self.attachment_streams
    }

    pub fn subscribe_changes(&self) -> broadcast::Receiver<()> {
        self.changes.subscribe()
    }

    fn notify_change(&self) {
        let _ = self.changes.send(());
    }

    pub fn register_provider(self: &Arc<Self>, provider: Arc<dyn AiSessionControlProvider>) {
        let agent = provider.agent().to_string();
        self.providers
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(agent.clone(), provider.clone());
        if let Some(mut events) = provider.subscribe_events() {
            let Ok(runtime) = tokio::runtime::Handle::try_current() else {
                tracing::warn!(
                    agent,
                    "AI session provider event loop requires a Tokio runtime"
                );
                return;
            };
            let controller = Arc::downgrade(self);
            let drain_runtime = runtime.clone();
            runtime.spawn(async move {
                while let Ok(event) = events.recv().await {
                    let Some(controller) = controller.upgrade() else {
                        break;
                    };
                    let completed_provider_session_id = match &event {
                        ProviderEvent::TurnCompleted {
                            provider_session_id,
                            ..
                        } => Some(provider_session_id.clone()),
                        _ => None,
                    };
                    if controller.apply_provider_event(event).await {
                        controller.notify_change();
                    }
                    if let Some(provider_session_id) = completed_provider_session_id {
                        if let Some(session) =
                            controller.runtime.list().into_iter().find(|session| {
                                session.agent == "codex"
                                    && session.provider_session_id.as_deref()
                                        == Some(provider_session_id.as_str())
                            })
                        {
                            let controller = controller.clone();
                            drain_runtime.spawn(async move {
                                controller.drain_queue(&session.id).await;
                            });
                        }
                    }
                }
            });
        }
    }

    pub fn provider(
        &self,
        agent: &str,
    ) -> Result<Arc<dyn AiSessionControlProvider>, ProviderError> {
        self.providers
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(agent)
            .cloned()
            .ok_or_else(|| {
                ProviderError::unsupported(format!(
                    "{agent} sessions do not support direct control yet."
                ))
            })
    }

    pub fn provider_capabilities(&self) -> Vec<AiSessionProviderCapability> {
        let mut capabilities = self
            .providers
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .map(|provider| provider.capability())
            .collect::<Vec<_>>();
        capabilities.sort_by_key(|provider| provider_order(&provider.agent));
        capabilities
    }

    pub fn timeline_capabilities(
        &self,
    ) -> controlled_instance_protocol::AiSessionTimelineCapabilities {
        let providers = self
            .providers
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut session_read_agents = Vec::new();
        let mut turn_read_agents = Vec::new();
        let mut live_item_agents = Vec::new();
        let mut ordered = providers.values().collect::<Vec<_>>();
        ordered.sort_by_key(|provider| provider_order(provider.agent()));
        for provider in ordered {
            let timeline = provider.timeline_capabilities();
            if timeline.session_read {
                session_read_agents.push(provider.agent().to_string());
            }
            if timeline.turn_read {
                turn_read_agents.push(provider.agent().to_string());
            }
            if timeline.live_items {
                live_item_agents.push(provider.agent().to_string());
            }
        }
        controlled_instance_protocol::AiSessionTimelineCapabilities {
            session_read_agents,
            turn_read_agents,
            live_item_agents,
        }
    }

    async fn lock_for_session(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.session_locks.lock().await;
        locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn create_session(
        self: &Arc<Self>,
        input: AiSessionCreateInput,
    ) -> Result<AiSessionCreateResult, ProviderError> {
        self.create_managed_session(input, AiSessionManagedCreateOptions::default())
            .await
    }

    pub async fn create_managed_session(
        self: &Arc<Self>,
        input: AiSessionCreateInput,
        mut options: AiSessionManagedCreateOptions,
    ) -> Result<AiSessionCreateResult, ProviderError> {
        let _guard = self.create_lock.lock().await;
        if input.message.message.trim().is_empty() {
            return Err(ProviderError::new(
                "AI_SESSION_MESSAGE_EMPTY",
                "Message is required.",
                400,
            ));
        }
        if input.cwd.runtime_path_type != "runtime-path" {
            return Err(ProviderError::new(
                "AI_SESSION_RUNTIME_PATH_INVALID",
                "AI session cwd must be a runtime-path.",
                400,
            ));
        }
        if options.agent_tools.is_none() {
            options.agent_tools = self
                .resolve_story_agent_tools(input.story_id.as_deref())
                .await;
        }
        let cwd = canonical_directory(&input.cwd.path)?;
        let runtime_workspace_roots = if options.runtime_workspace_roots.is_empty() {
            vec![cwd.clone()]
        } else {
            options
                .runtime_workspace_roots
                .iter()
                .map(|root| canonical_directory(&root.display().to_string()))
                .collect::<Result<Vec<_>, _>>()?
        };
        let fingerprint = create_fingerprint(&input, &options)?;
        if let Some(client_request_id) = input.message.client_request_id.as_deref() {
            if let Some(completed) = self.completed_creates.lock().await.get(client_request_id) {
                if completed.fingerprint != fingerprint {
                    return Err(ProviderError::conflict(
                        "AI_SESSION_CREATE_REQUEST_CONFLICT",
                        "The client request ID was already used with different session creation input.",
                    ));
                }
                return Ok(AiSessionCreateResult {
                    disposition: "already-created".to_string(),
                    ..completed.result.clone()
                });
            }
        }
        let provider = self.provider(&input.agent)?;
        let model_selection = self.resolve_model_selection(
            &input.agent,
            input.model_selection.as_ref(),
            AiSessionModelSelectionIntent::Target,
        )?;
        if input.model_selection.is_some() && model_selection.is_none() {
            return Err(ProviderError::new(
                "AI_SESSION_MODEL_SELECTION_UNAVAILABLE",
                "Model selection is unavailable.",
                409,
            ));
        }
        let created = provider
            .create_session(ProviderCreateInput {
                cwd: cwd.clone(),
                runtime_workspace_roots,
                permission_mode: input.message.permission_mode,
                model_selection: model_selection.clone(),
                reasoning_effort: input.reasoning_effort.clone(),
                story_agent_tools: options.agent_tools,
            })
            .await?;
        if created.provider_session_id.trim().is_empty() {
            return Err(ProviderError::bad_gateway(
                "AI_SESSION_CREATE_INVALID_RESPONSE",
                "Provider returned an invalid Direct AI session identity.",
            ));
        }
        let mut existing = self.runtime.list().into_iter().find(|session| {
            session.agent == input.agent
                && session.provider_session_id.as_deref()
                    == Some(created.provider_session_id.as_str())
        });
        if existing.is_none() {
            let id = mint_entity_id("ses");
            let started_at = now_iso();
            let session = AiSession {
                id,
                agent: input.agent.clone(),
                creation_source: "ai-session".to_string(),
                app_session_id: None,
                app_id: Some(if input.agent == "codex" {
                    "codex-app-server".to_string()
                } else {
                    input.agent.clone()
                }),
                provider_session_id: Some(created.provider_session_id.clone()),
                lineage: None,
                provider_meta: None,
                model_selection: serde_json::to_value(
                    created.model_selection.clone().or(model_selection),
                )
                .ok()
                .filter(|value| !value.is_null()),
                reasoning_effort: created
                    .reasoning_effort
                    .clone()
                    .or(input.reasoning_effort.clone()),
                story_id: input.story_id.clone(),
                app_binding_keys: None,
                actions: Some(default_provider_actions(None)),
                active_turn_id: None,
                title: None,
                cwd: Some(created.cwd.display().to_string()),
                cwd_folder_id: input.cwd_folder_id.clone(),
                user_prompt: None,
                turns: None,
                status: "idle".to_string(),
                phase: "unknown".to_string(),
                summary: None,
                last_message: None,
                last_message_item_id: None,
                current_tool: None,
                tool_calls_since_last_message: 0,
                sub_agents: Vec::new(),
                transcript_path: None,
                transcript_size: None,
                started_at,
                updated_at: now_iso(),
                completed_at: None,
                error: None,
                counters: Default::default(),
                queue: AiSessionQueue::default(),
                unread: false,
            };
            existing = Some(self.runtime.save(session)?);
        }
        let session = existing.expect("created session");
        let send_result = match self
            .send_prepared(
                &session,
                ProviderMessageInput::from_wire(&input.message),
                false,
            )
            .await
        {
            Ok(result) => result,
            Err(error) => {
                let _ = self.runtime.remove(&session.id);
                if provider
                    .delete_session(&created.provider_session_id)
                    .await
                    .is_err()
                {
                    let _ = provider.archive_session(&created.provider_session_id).await;
                }
                let _ = provider
                    .unsubscribe_session(&created.provider_session_id)
                    .await;
                return Err(error);
            }
        };
        let result = AiSessionCreateResult {
            disposition: "created".to_string(),
            ai_session_id: send_result.session.id.clone(),
            provider_session_id: created.provider_session_id.clone(),
            creation_source: "ai-session".to_string(),
        };
        if let Some(client_request_id) = input.message.client_request_id.clone() {
            let operation = CompletedCreateOperation {
                client_request_id: client_request_id.clone(),
                fingerprint,
                result: result.clone(),
            };
            self.completed_creates
                .lock()
                .await
                .insert(client_request_id, operation);
            self.persist_completed_creates();
        }
        self.notify_change();
        Ok(result)
    }

    pub async fn send_message(
        self: &Arc<Self>,
        session_id: &str,
        input: ProviderMessageInput,
    ) -> Result<AiSessionActionResult, ProviderError> {
        let session = self.require_session(session_id)?;
        let request_key = input.message.client_request_id.clone();
        let fingerprint = request_key
            .as_ref()
            .map(|_| send_fingerprint(session_id, &input.message));
        if let (Some(client_request_id), Some(fingerprint)) =
            (request_key.as_deref(), fingerprint.as_deref())
        {
            if let Some((known_fingerprint, result)) =
                self.completed_sends.lock().await.get(client_request_id)
            {
                if known_fingerprint != fingerprint {
                    return Err(ProviderError::conflict(
                        "AI_SESSION_SEND_REQUEST_CONFLICT",
                        "The clientRequestId was already used for a different message.",
                    ));
                }
                return Ok(result.clone());
            }
        }
        let session_lock = self.lock_for_session(session_id).await;
        let _guard = session_lock.lock().await;
        if let (Some(client_request_id), Some(fingerprint)) =
            (request_key.as_deref(), fingerprint.as_deref())
        {
            if let Some((known_fingerprint, result)) =
                self.completed_sends.lock().await.get(client_request_id)
            {
                if known_fingerprint != fingerprint {
                    return Err(ProviderError::conflict(
                        "AI_SESSION_SEND_REQUEST_CONFLICT",
                        "The clientRequestId was already used for a different message.",
                    ));
                }
                return Ok(result.clone());
            }
            if let Some((known_fingerprint, pending)) = self
                .pending_sends
                .lock()
                .await
                .get(client_request_id)
                .cloned()
            {
                if known_fingerprint != fingerprint {
                    return Err(ProviderError::conflict(
                        "AI_SESSION_SEND_REQUEST_CONFLICT",
                        "The clientRequestId was already used for a different message.",
                    ));
                }
                return pending.await;
            }
        }
        let controller = self.clone();
        let current_session = session.clone();
        let owned_input = input.clone();
        let operation = async move {
            controller
                .send_prepared(&current_session, owned_input, true)
                .await
        }
        .boxed()
        .shared();
        if let (Some(client_request_id), Some(fingerprint)) =
            (request_key.clone(), fingerprint.clone())
        {
            self.pending_sends.lock().await.insert(
                client_request_id.clone(),
                (fingerprint.clone(), operation.clone()),
            );
            let controller = self.clone();
            let completion_operation = operation.clone();
            let pending_id = client_request_id.clone();
            let pending_fingerprint = fingerprint.clone();
            tokio::spawn(async move {
                let result = completion_operation.await;
                if let Ok(result) = &result {
                    controller
                        .completed_sends
                        .lock()
                        .await
                        .insert(pending_id.clone(), (pending_fingerprint, result.clone()));
                }
                controller.pending_sends.lock().await.remove(&pending_id);
                controller.notify_change();
            });
        }
        let result = operation.await?;
        self.notify_change();
        Ok(result)
    }

    pub async fn resume_archived(
        &self,
        item: AiSessionHistoryItem,
        turns: Vec<Value>,
        model_selection: Option<AiSessionModelSelection>,
        model_selection_intent: AiSessionModelSelectionIntent,
        reasoning_effort: Option<String>,
    ) -> Result<AiSessionResumeResult, ProviderError> {
        if let Some(existing) = self.runtime.list().into_iter().find(|session| {
            session.id == item.id
                || (session.agent == item.agent
                    && session.provider_session_id.as_deref()
                        == Some(item.provider_session_id.as_str()))
        }) {
            return Ok(AiSessionResumeResult {
                disposition: "already-open".to_string(),
                ai_session_id: existing.id,
                provider_session_id: item.provider_session_id,
                creation_source: item.creation_source,
            });
        }
        let model_selection = match model_selection.as_ref() {
            Some(selection) => {
                self.resolve_model_selection(&item.agent, Some(selection), model_selection_intent)?
            }
            None => None,
        };
        let provider = self.provider(&item.agent)?;
        let started_at = now_iso();
        let session = AiSession {
            id: item.id.clone(),
            agent: item.agent.clone(),
            creation_source: item.creation_source.clone(),
            app_session_id: None,
            app_id: Some(if item.agent == "codex" {
                "codex-app-server".to_string()
            } else {
                item.agent.clone()
            }),
            provider_session_id: Some(item.provider_session_id.clone()),
            lineage: item.lineage.clone(),
            provider_meta: None,
            model_selection: model_selection
                .clone()
                .or_else(|| {
                    item.model_selection
                        .clone()
                        .and_then(|value| serde_json::from_value(value).ok())
                })
                .and_then(|value| serde_json::to_value(value).ok()),
            reasoning_effort: reasoning_effort.clone().or(item.reasoning_effort.clone()),
            story_id: item.story_id.clone(),
            app_binding_keys: None,
            actions: Some(default_provider_actions(None)),
            active_turn_id: None,
            title: item.title.clone(),
            cwd: Some(item.cwd.clone()),
            cwd_folder_id: item.cwd_folder_id.clone(),
            user_prompt: item.user_prompt.clone(),
            turns: (!turns.is_empty()).then_some(turns),
            status: "idle".to_string(),
            phase: "unknown".to_string(),
            summary: None,
            last_message: item.last_message.clone(),
            last_message_item_id: None,
            current_tool: None,
            tool_calls_since_last_message: 0,
            sub_agents: Vec::new(),
            transcript_path: None,
            transcript_size: None,
            started_at,
            updated_at: now_iso(),
            completed_at: None,
            error: None,
            counters: Default::default(),
            queue: AiSessionQueue::default(),
            unread: false,
        };
        let saved = self.runtime.save(session)?;
        let resumed = match provider.resume_session(&saved).await {
            Ok(result) => result,
            Err(error) => {
                let _ = self.runtime.remove(&saved.id);
                return Err(error);
            }
        };
        let updated = self.runtime.update(&saved.id, |session| {
            if let Some(selection) = resumed.model_selection {
                session.model_selection = serde_json::to_value(selection).ok();
            }
            if let Some(effort) = resumed.reasoning_effort {
                session.reasoning_effort = Some(effort);
            }
            session.status = "idle".to_string();
            session.phase = "unknown".to_string();
            session.actions = Some(default_provider_actions(None));
            Ok(true)
        })?;
        self.notify_change();
        Ok(AiSessionResumeResult {
            disposition: "resumed".to_string(),
            ai_session_id: updated.id,
            provider_session_id: updated
                .provider_session_id
                .unwrap_or(item.provider_session_id),
            creation_source: updated.creation_source,
        })
    }

    pub async fn fork_session(
        &self,
        source_session_id: &str,
        input: ProviderForkInput,
    ) -> Result<AiSessionForkResult, ProviderError> {
        let source = self.require_session(source_session_id)?;
        let provider = self.provider(&source.agent)?;
        let source_selection = source
            .model_selection
            .clone()
            .and_then(|value| serde_json::from_value::<AiSessionModelSelection>(value).ok());
        let resolved_source_selection = match source_selection.as_ref() {
            Some(selection) => self.resolve_model_selection(
                &source.agent,
                Some(selection),
                AiSessionModelSelectionIntent::Session,
            )?,
            None => None,
        };
        let mut resolved_source = source.clone();
        if let Some(selection) = resolved_source_selection {
            resolved_source.model_selection = serde_json::to_value(selection).ok();
        }
        let source = &resolved_source;
        if source
            .actions
            .as_ref()
            .and_then(|actions| actions.get("fork"))
            .and_then(Value::as_bool)
            == Some(false)
        {
            return Err(ProviderError::conflict(
                "AI_SESSION_FORK_UNSUPPORTED",
                "Fork source does not expose a verified provider capability.",
            ));
        }
        let provider_through_turn_id = if let Some(public_turn_id) =
            input.through_turn_id.as_deref()
        {
            if source.active_turn_id.as_deref() == Some(public_turn_id) && is_session_busy(source) {
                return Err(ProviderError::conflict(
                    "AI_SESSION_FORK_INVALID_TURN_STATE",
                    "An in-progress turn cannot be used as the Fork boundary.",
                ));
            }
            let turn = source
                .turns
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|turn| turn.get("id").and_then(Value::as_str) == Some(public_turn_id))
                .ok_or_else(|| {
                    ProviderError::new(
                        "AI_SESSION_FORK_TURN_NOT_FOUND",
                        "Fork turn was not found.",
                        404,
                    )
                })?;
            if matches!(
                turn.get("status").and_then(Value::as_str),
                Some("running" | "waiting")
            ) {
                return Err(ProviderError::conflict(
                    "AI_SESSION_FORK_INVALID_TURN_STATE",
                    "An in-progress turn cannot be used as the Fork boundary.",
                ));
            }
            Some(
                turn.get("providerTurnId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        ProviderError::new(
                            "AI_SESSION_FORK_TURN_NOT_FOUND",
                            "Fork turn has no provider identity.",
                            409,
                        )
                    })?
                    .to_string(),
            )
        } else {
            None
        };
        let story_agent_tools = match input.story_agent_tools {
            Some(tools) => Some(tools),
            None => {
                self.resolve_story_agent_tools(source.story_id.as_deref())
                    .await
            }
        };
        let provider_input = ProviderForkInput {
            through_turn_id: provider_through_turn_id.clone(),
            cwd: input.cwd,
            story_agent_tools,
        };
        let created = provider.fork_session(source, provider_input).await?;
        if created.provider_session_id == source.provider_session_id.as_deref().unwrap_or_default()
        {
            return Err(ProviderError::bad_gateway(
                "AI_SESSION_FORK_INVALID_RESPONSE",
                "Fork did not create an independent provider session.",
            ));
        }
        if let Some(existing) = self.runtime.list().into_iter().find(|session| {
            session.agent == source.agent
                && session.provider_session_id.as_deref()
                    == Some(created.provider_session_id.as_str())
        }) {
            return Ok(AiSessionForkResult {
                disposition: "already-created".to_string(),
                ai_session_id: existing.id,
                provider_session_id: created.provider_session_id,
                creation_source: "ai-session".to_string(),
            });
        }
        let id = mint_entity_id("ses");
        let session = AiSession {
            id: id.clone(),
            agent: source.agent.clone(),
            creation_source: "ai-session".to_string(),
            app_session_id: None,
            app_id: Some(if source.agent == "codex" {
                "codex-app-server".to_string()
            } else {
                source.agent.clone()
            }),
            provider_session_id: Some(created.provider_session_id.clone()),
            lineage: Some(json!({
                "kind": "fork",
                "parentProviderSessionId": source.provider_session_id,
                "throughTurnId": input.through_turn_id,
            })),
            provider_meta: None,
            model_selection: created
                .model_selection
                .or_else(|| {
                    source
                        .model_selection
                        .clone()
                        .and_then(|value| serde_json::from_value(value).ok())
                })
                .and_then(|selection| serde_json::to_value(selection).ok()),
            reasoning_effort: created
                .reasoning_effort
                .or_else(|| source.reasoning_effort.clone()),
            story_id: source.story_id.clone(),
            app_binding_keys: None,
            actions: Some(default_provider_actions(None)),
            active_turn_id: None,
            title: None,
            cwd: Some(created.cwd.display().to_string()),
            cwd_folder_id: source.cwd_folder_id.clone(),
            user_prompt: None,
            turns: None,
            status: "idle".to_string(),
            phase: "unknown".to_string(),
            summary: None,
            last_message: None,
            last_message_item_id: None,
            current_tool: None,
            tool_calls_since_last_message: 0,
            sub_agents: Vec::new(),
            transcript_path: None,
            transcript_size: None,
            started_at: now_iso(),
            updated_at: now_iso(),
            completed_at: None,
            error: None,
            counters: Default::default(),
            queue: AiSessionQueue::default(),
            unread: false,
        };
        self.runtime.save(session)?;
        self.notify_change();
        Ok(AiSessionForkResult {
            disposition: "created".to_string(),
            ai_session_id: id,
            provider_session_id: created.provider_session_id,
            creation_source: "ai-session".to_string(),
        })
    }

    pub async fn update_model_selection(
        &self,
        session_id: &str,
        selection: AiSessionModelSelection,
    ) -> Result<(), ProviderError> {
        let session = self.require_session(session_id)?;
        if session.creation_source != "ai-session" {
            return Err(ProviderError::conflict(
                "AI_SESSION_MODEL_SELECTION_UNSUPPORTED",
                "Only Direct AI Sessions support model switching.",
            ));
        }
        if is_session_busy(&session) {
            return Err(ProviderError::conflict(
                "AI_SESSION_MODEL_SELECTION_CONFLICT",
                "The model cannot be changed while a turn is active.",
            ));
        }
        let current = session
            .model_selection
            .clone()
            .and_then(|value| serde_json::from_value::<AiSessionModelSelection>(value).ok());
        if current.as_ref() == Some(&selection) {
            return Ok(());
        }
        let _ = self.provider(&session.agent)?;
        self.begin_pending_settings(&session.id).await?;
        let result = async {
            let changes_provider = current
                .as_ref()
                .is_none_or(|current| current.model_entity_id != selection.model_entity_id);
            if changes_provider
                && session.agent == "codex"
                && has_active_codex_descendants(&session, &self.runtime.list())
            {
                return Err(ProviderError::new(
                "AI_SESSION_PROVIDER_SWITCH_HAS_ACTIVE_DESCENDANTS",
                "Provider switching is unavailable for sessions with a live subagent hierarchy.",
                409,
            ));
            }
            let selection = self
                .resolve_model_selection(
                    &session.agent,
                    Some(&selection),
                    AiSessionModelSelectionIntent::Target,
                )?
                .ok_or_else(|| {
                    ProviderError::new(
                        "AI_SESSION_MODEL_SELECTION_UNAVAILABLE",
                        "Model selection is unavailable.",
                        409,
                    )
                })?;
            let provider = self.provider(&session.agent)?;
            let actual = provider
                .update_model_selection(&session, &selection)
                .await?
                .unwrap_or(selection);
            self.runtime.update(&session.id, |session| {
                session.model_selection = serde_json::to_value(actual).ok();
                Ok(true)
            })?;
            self.notify_change();
            Ok(())
        }
        .await;
        self.end_pending_settings(&session.id).await;
        result
    }

    pub async fn update_reasoning_effort(
        &self,
        session_id: &str,
        reasoning_effort: &str,
    ) -> Result<(), ProviderError> {
        let session = self.require_session(session_id)?;
        if session.creation_source != "ai-session" {
            return Err(ProviderError::conflict(
                "AI_SESSION_REASONING_EFFORT_UNSUPPORTED",
                "Only Direct AI Sessions support reasoning effort changes.",
            ));
        }
        if is_session_busy(&session) {
            return Err(ProviderError::conflict(
                "AI_SESSION_REASONING_EFFORT_CONFLICT",
                "Reasoning effort cannot be changed while a turn is active.",
            ));
        }
        if session.reasoning_effort.as_deref() == Some(reasoning_effort) {
            return Ok(());
        }
        let _ = self.provider(&session.agent)?;
        self.begin_pending_settings(&session.id).await?;
        let result = async {
            let provider = self.provider(&session.agent)?;
            let actual = provider
                .update_reasoning_effort(&session, reasoning_effort)
                .await?
                .unwrap_or_else(|| reasoning_effort.to_string());
            self.runtime.update(&session.id, |session| {
                session.reasoning_effort = Some(actual);
                Ok(true)
            })?;
            self.notify_change();
            Ok(())
        }
        .await;
        self.end_pending_settings(&session.id).await;
        result
    }

    async fn assert_no_pending_settings(&self, session_id: &str) -> Result<(), ProviderError> {
        if self.pending_settings.lock().await.contains(session_id) {
            return Err(ProviderError::conflict(
                "AI_SESSION_MODEL_SELECTION_CONFLICT",
                "A session setting change is already pending.",
            ));
        }
        Ok(())
    }

    async fn begin_pending_settings(&self, session_id: &str) -> Result<(), ProviderError> {
        let mut pending = self.pending_settings.lock().await;
        if !pending.insert(session_id.to_string()) {
            return Err(ProviderError::conflict(
                "AI_SESSION_MODEL_SELECTION_CONFLICT",
                "A session setting change is already pending.",
            ));
        }
        Ok(())
    }

    async fn end_pending_settings(&self, session_id: &str) {
        self.pending_settings.lock().await.remove(session_id);
    }

    async fn send_prepared(
        &self,
        session: &AiSession,
        mut input: ProviderMessageInput,
        allow_queue: bool,
    ) -> Result<AiSessionActionResult, ProviderError> {
        self.assert_no_pending_settings(&session.id).await?;
        let message = input.message.message.trim().to_string();
        if message.is_empty() {
            return Err(ProviderError::new(
                "AI_SESSION_MESSAGE_EMPTY",
                "Message is required.",
                400,
            ));
        }
        if !input.message.references.is_empty() && session.agent != "codex" {
            return Err(ProviderError::new(
                "AI_SESSION_REFERENCES_UNSUPPORTED",
                format!(
                    "{} sessions do not support Codex references.",
                    session.agent
                ),
                400,
            ));
        }
        input.message.message = message;
        let staged = self.stage_message(session, &input.message)?;
        if allow_queue {
            let mode = input.message.mode.unwrap_or(AiSessionSendMode::Auto);
            if mode == AiSessionSendMode::Queue
                || (mode == AiSessionSendMode::Auto && is_session_busy(session))
            {
                return self.enqueue(session, &input, &staged);
            }
            if mode == AiSessionSendMode::Steer {
                return self.steer(session, &input, &staged).await;
            }
            if is_session_busy(session) {
                return Err(ProviderError::conflict(
                    "AI_SESSION_BUSY",
                    "AI session is busy. Queue the message or steer it into the running turn.",
                ));
            }
        }
        self.start(session, &input, &staged).await
    }

    fn stage_message(
        &self,
        session: &AiSession,
        input: &AiSessionMessageInput,
    ) -> Result<StagedAiSessionMessageAttachments, ProviderError> {
        let message_id = format!("msg_{}", &Uuid::new_v4().simple().to_string()[..24]);
        let mut attachments = Vec::new();
        let mut draft_ids = Vec::new();
        for attachment in &input.attachments {
            match &attachment.source {
                AiSessionAttachmentSourceInput::Inline { encoding, data } => {
                    if encoding != "base64" {
                        return Err(ProviderError::new(
                            "AI_SESSION_ATTACHMENT_INVALID",
                            "Inline attachments must use base64 encoding.",
                            400,
                        ));
                    }
                    let bytes =
                        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data)
                            .map_err(|_| {
                                ProviderError::new(
                                    "AI_SESSION_ATTACHMENT_INVALID",
                                    "Inline attachment data is not valid base64.",
                                    400,
                                )
                            })?;
                    attachments.push(AiSessionMessageAttachmentInput::Inline {
                        id: attachment.id.clone(),
                        kind: attachment_required_kind(attachment)?,
                        name: attachment_required_name(attachment)?,
                        mime: attachment_required_mime(attachment)?,
                        size: attachment.size.unwrap_or(bytes.len() as u64),
                        data: bytes,
                    });
                }
                AiSessionAttachmentSourceInput::RuntimePath { path } => {
                    let size = attachment.size.ok_or_else(|| {
                        ProviderError::new(
                            "AI_SESSION_ATTACHMENT_INVALID",
                            "Runtime path attachments require a declared size.",
                            400,
                        )
                    })?;
                    attachments.push(AiSessionMessageAttachmentInput::RuntimePath {
                        id: attachment.id.clone(),
                        kind: attachment_required_kind(attachment)?,
                        name: attachment_required_name(attachment)?,
                        mime: attachment_required_mime(attachment)?,
                        size,
                        path: PathBuf::from(path),
                    })
                }
                AiSessionAttachmentSourceInput::UploadRef => draft_ids.push(attachment.id.clone()),
            }
        }
        let staged = self
            .attachments
            .stage_message(StageMessageAttachmentsInput {
                session_id: session.id.clone(),
                message_id: message_id.clone(),
                attachments,
                retained_attachment_ids: Vec::new(),
                runtime_path_root: session.cwd.as_deref().map(PathBuf::from),
                draft_scope_type: (!draft_ids.is_empty())
                    .then_some(AiSessionAttachmentScopeType::Session),
                draft_scope_id: (!draft_ids.is_empty()).then(|| session.id.clone()),
                draft_attachment_ids: draft_ids,
            })
            .map_err(|error| ProviderError::new(error.code, error.message, error.status_code))?;
        Ok(staged)
    }

    fn enqueue(
        &self,
        session: &AiSession,
        input: &ProviderMessageInput,
        staged: &StagedAiSessionMessageAttachments,
    ) -> Result<AiSessionActionResult, ProviderError> {
        let attachments = staged
            .attachments
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                ProviderError::new("AI_SESSION_PERSISTENCE_FAILED", error.to_string(), 500)
            })?;
        let references = input
            .message
            .references
            .iter()
            .map(|reference| {
                json!({
                    "kind": reference.kind,
                    "name": reference.name,
                    "path": reference.path,
                })
            })
            .collect();
        let queued = self
            .runtime
            .enqueue_message(
                &session.id,
                &input.message.message,
                attachments,
                references,
                input
                    .message
                    .permission_mode
                    .map(AiSessionPermissionMode::as_str),
                Some(&staged.message_id),
            )?
            .ok_or_else(|| {
                ProviderError::new("AI_SESSION_NOT_FOUND", "AI session not found.", 404)
            })?;
        Ok(AiSessionActionResult {
            session: queued.session,
            provider: session.agent.clone(),
            action: ProviderAction {
                action: "queue".to_string(),
                queue_id: Some(queued.queue_id),
                ..ProviderAction::simple("queue")
            },
        })
    }

    async fn start(
        &self,
        session: &AiSession,
        input: &ProviderMessageInput,
        staged: &StagedAiSessionMessageAttachments,
    ) -> Result<AiSessionActionResult, ProviderError> {
        let provider = self.provider(&session.agent)?;
        let requested_selection = session
            .model_selection
            .clone()
            .and_then(|value| serde_json::from_value::<AiSessionModelSelection>(value).ok());
        let resolved_selection = match requested_selection.as_ref() {
            Some(selection) => self.resolve_model_selection(
                &session.agent,
                Some(selection),
                AiSessionModelSelectionIntent::Session,
            )?,
            None => None,
        };
        let mut normalized_session = session.clone();
        if let Some(selection) = resolved_selection {
            normalized_session.model_selection = serde_json::to_value(selection).ok();
        }
        let session = &normalized_session;
        let message = provider_message(input, staged);
        let action = provider.start_message(session, message).await?;
        self.attachments.commit_message(
            &session.id,
            &staged.message_id,
            action.provider_turn_id.as_deref(),
        );
        let updated = self.apply_action_ack(
            session,
            &action,
            &input.message.message,
            &staged.message_id,
            &staged.attachments,
        )?;
        Ok(AiSessionActionResult {
            session: updated,
            provider: session.agent.clone(),
            action,
        })
    }

    async fn steer(
        &self,
        session: &AiSession,
        input: &ProviderMessageInput,
        staged: &StagedAiSessionMessageAttachments,
    ) -> Result<AiSessionActionResult, ProviderError> {
        if !is_session_busy(session) {
            return Err(ProviderError::conflict(
                "AI_SESSION_NOT_ACTIVE",
                "AI session is not active.",
            ));
        }
        let provider = self.provider(&session.agent)?;
        let message = provider_message(input, staged);
        let action = provider.steer_message(session, message).await?;
        self.attachments.commit_message(
            &session.id,
            &staged.message_id,
            action
                .provider_turn_id
                .as_deref()
                .or(session.active_turn_id.as_deref()),
        );
        let updated = self.apply_action_ack(
            session,
            &action,
            &input.message.message,
            &staged.message_id,
            &staged.attachments,
        )?;
        Ok(AiSessionActionResult {
            session: updated,
            provider: session.agent.clone(),
            action,
        })
    }

    pub async fn steer_queued_message(
        self: &Arc<Self>,
        session_id: &str,
        queue_id: &str,
    ) -> Result<AiSessionActionResult, ProviderError> {
        let session = self.require_session(session_id)?;
        let item = queued_item(&session, queue_id)?;
        let input = ProviderMessageInput::from_queue_item(&item)?;
        let staged = self.stage_queued_message(&session, &input)?;
        let result = self.steer(&session, &input, &staged).await?;
        let updated = self.runtime.remove_queue_item(&session.id, queue_id)?;
        Ok(AiSessionActionResult {
            session: updated,
            provider: result.provider,
            action: ProviderAction {
                action: "steer".to_string(),
                queue_id: Some(queue_id.to_string()),
                ..result.action
            },
        })
    }

    pub async fn send_next_queued_message(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<Option<AiSessionActionResult>, ProviderError> {
        let session = self.require_session(session_id)?;
        if is_session_busy(&session) || session.queue.paused.unwrap_or(false) {
            return Ok(None);
        }
        let Some(item) = self.runtime.next_queued_item(session_id) else {
            return Ok(None);
        };
        let queue_id = item.get("id").and_then(Value::as_str).ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_QUEUE_ITEM_NOT_FOUND",
                "Queued message not found.",
                404,
            )
        })?;
        self.runtime
            .set_queue_item_status(session_id, queue_id, "sending", None)?;
        let input = match ProviderMessageInput::from_queue_item(&item) {
            Ok(input) => input,
            Err(error) => {
                self.runtime.set_queue_item_status(
                    session_id,
                    queue_id,
                    "failed",
                    Some(&error.message),
                )?;
                return Err(error);
            }
        };
        let staged = match self.stage_queued_message(&session, &input) {
            Ok(staged) => staged,
            Err(error) => {
                self.runtime.set_queue_item_status(
                    session_id,
                    queue_id,
                    "failed",
                    Some(&error.message),
                )?;
                return Err(error);
            }
        };
        match self.start(&session, &input, &staged).await {
            Ok(result) => {
                let updated = self.runtime.remove_queue_item(session_id, queue_id)?;
                Ok(Some(AiSessionActionResult {
                    session: updated,
                    provider: result.provider,
                    action: ProviderAction {
                        queue_id: Some(queue_id.to_string()),
                        ..result.action
                    },
                }))
            }
            Err(error) => {
                self.runtime.set_queue_item_status(
                    session_id,
                    queue_id,
                    "failed",
                    Some(&error.message),
                )?;
                Err(error)
            }
        }
    }

    fn stage_queued_message(
        &self,
        session: &AiSession,
        input: &ProviderMessageInput,
    ) -> Result<StagedAiSessionMessageAttachments, ProviderError> {
        let message_id = format!("msg_{}", &Uuid::new_v4().simple().to_string()[..24]);
        let retained_attachment_ids = input
            .attachments
            .iter()
            .map(|attachment| attachment.meta.id.clone())
            .collect();
        self.attachments
            .stage_message(StageMessageAttachmentsInput {
                session_id: session.id.clone(),
                message_id,
                attachments: Vec::new(),
                retained_attachment_ids,
                runtime_path_root: session.cwd.as_deref().map(PathBuf::from),
                draft_scope_type: None,
                draft_scope_id: None,
                draft_attachment_ids: Vec::new(),
            })
            .map_err(|error| ProviderError::new(error.code, error.message, error.status_code))
    }

    pub async fn interrupt(
        &self,
        session_id: &str,
    ) -> Result<AiSessionActionResult, ProviderError> {
        let session = self.require_session(session_id)?;
        self.assert_no_pending_settings(&session.id).await?;
        if !is_session_busy(&session) {
            return Err(ProviderError::new(
                "AI_SESSION_NOT_ACTIVE",
                "AI session is not active.",
                400,
            ));
        }
        if session.queue.pending_count > 0 {
            let _ = self.runtime.set_queue_paused(&session.id, true);
        }
        let provider = self.provider(&session.agent)?;
        let action = provider.interrupt(&session).await?;
        let preserves_turn = provider.interrupt_preserves_turn();
        let updated = self.runtime.update(&session.id, |session| {
            let turn_id = session.active_turn_id.clone();
            if preserves_turn {
                session.status = "running".to_string();
                session.phase = "unknown".to_string();
                session.actions = Some(default_provider_actions(Some("running")));
                return Ok(true);
            }
            session.status = "idle".to_string();
            session.phase = "unknown".to_string();
            session.active_turn_id = None;
            if let (Some(turn_id), Some(turns)) = (turn_id, session.turns.as_mut()) {
                if let Some(turn) = find_turn_mut(turns, &turn_id) {
                    let object = turn.as_object_mut().expect("turn object");
                    object.insert("status".to_string(), json!("completed"));
                    object.insert("phase".to_string(), json!("unknown"));
                    object.insert("completedAt".to_string(), json!(now_iso()));
                    bump_turn_revision(object);
                }
            }
            session.actions = Some(default_provider_actions(None));
            Ok(true)
        })?;
        self.notify_change();
        Ok(AiSessionActionResult {
            session: updated,
            provider: session.agent,
            action,
        })
    }

    pub async fn resolve_approval(
        &self,
        session_id: &str,
        decision: &str,
    ) -> Result<AiSessionActionResult, ProviderError> {
        if !matches!(decision, "allow" | "deny" | "skip") {
            return Err(ProviderError::new(
                "AI_SESSION_CONTROL_INVALID",
                "Approval decision is invalid.",
                400,
            ));
        }
        let session = self.require_session(session_id)?;
        let provider = self.provider(&session.agent)?;
        let action = provider.resolve_approval(&session, decision).await?;
        let updated = self.runtime.update(&session.id, |session| {
            session.status = if decision == "skip" {
                "idle".to_string()
            } else {
                "running".to_string()
            };
            session.phase = if decision == "skip" {
                "unknown".to_string()
            } else {
                "thinking".to_string()
            };
            session.summary = None;
            session.actions = Some(default_provider_actions(Some(session.status.as_str())));
            Ok(true)
        })?;
        self.notify_change();
        Ok(AiSessionActionResult {
            session: updated,
            provider: session.agent,
            action,
        })
    }

    pub async fn rename(&self, session_id: &str, title: &str) -> Result<(), ProviderError> {
        let session = self.require_session(session_id)?;
        let provider = self.provider(&session.agent)?;
        provider.rename_session(&session, title).await?;
        self.runtime.rename(&session.id, title, None)?;
        self.notify_change();
        Ok(())
    }

    pub fn update_story(
        &self,
        session_id: &str,
        story_id: Option<String>,
    ) -> Result<AiSession, ProviderError> {
        let updated = self.runtime.update(session_id, |session| {
            session.story_id = story_id;
            Ok(true)
        })?;
        self.notify_change();
        Ok(updated)
    }

    pub async fn mention_catalog(
        &self,
        session_id: &str,
    ) -> Result<AiSessionMentionCatalog, ProviderError> {
        let session = self.require_session(session_id)?;
        self.provider(&session.agent)?
            .mention_catalog(&session)
            .await
    }

    pub async fn search_mention_files(
        &self,
        session_id: &str,
        query: &str,
    ) -> Result<AiSessionMentionFileSearch, ProviderError> {
        let session = self.require_session(session_id)?;
        self.provider(&session.agent)?
            .search_mention_files(&session, query)
            .await
    }

    pub async fn execute_command(
        &self,
        session_id: &str,
        input: &AiSessionCommandInput,
    ) -> Result<AiSessionCommandResult, ProviderError> {
        if input.command == controlled_instance_protocol::AiSessionCommandName::Rename {
            let title = input
                .argument
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    ProviderError::new(
                        "AI_SESSION_CONTROL_INVALID",
                        "Rename requires a thread name.",
                        400,
                    )
                })?;
            self.rename(session_id, title).await?;
            return Ok(AiSessionCommandResult {
                command: input.command,
                value: Some(title.to_string()),
                turn_id: None,
            });
        }
        let session = self.require_session(session_id)?;
        self.provider(&session.agent)?
            .execute_command(&session, input)
            .await
    }

    pub async fn archive(
        &self,
        session_id: &str,
        delete: bool,
    ) -> Result<Option<AiSession>, ProviderError> {
        let Some(session) = self.runtime.get(session_id) else {
            return Ok(None);
        };
        let provider = self.provider(&session.agent)?;
        if let (Some(provider_session_id), true) = (
            session.provider_session_id.as_deref(),
            is_session_busy(&session),
        ) {
            let _ = provider.interrupt(&session).await;
            let _ = provider_session_id;
        }
        if let Some(provider_session_id) = session.provider_session_id.as_deref() {
            if delete {
                provider.delete_session(provider_session_id).await?;
            } else if provider.close_detaches_provider_session() {
                // The provider has no restore operation for an archived session.
            } else {
                provider.archive_session(provider_session_id).await?;
            }
            let _ = provider.unsubscribe_session(provider_session_id).await;
        }
        let removed = self.runtime.remove(&session.id)?;
        self.notify_change();
        Ok(removed)
    }

    pub async fn timeline(&self, session_id: &str) -> Result<AiSessionTimeline, ProviderError> {
        let session = self.require_session(session_id)?;
        self.provider(&session.agent)?.timeline(&session).await
    }

    pub async fn turn_timeline(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<AiSessionTurnTimeline, ProviderError> {
        let session = self.require_session(session_id)?;
        self.provider(&session.agent)?
            .turn_timeline(&session, turn_id)
            .await
    }

    pub async fn drain_queue(self: &Arc<Self>, session_id: &str) {
        loop {
            match self.send_next_queued_message(session_id).await {
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => break,
            }
        }
    }

    fn require_session(&self, session_id: &str) -> Result<AiSession, ProviderError> {
        self.runtime
            .get(session_id)
            .ok_or_else(|| ProviderError::not_found("AI session not found."))
    }

    fn apply_action_ack(
        &self,
        session: &AiSession,
        action: &ProviderAction,
        message: &str,
        message_id: &str,
        user_attachments: &[AiSessionConversationAttachment],
    ) -> Result<AiSession, ProviderError> {
        let now = now_iso();
        let turn_id = action
            .provider_turn_id
            .clone()
            .or_else(|| action.turn_id.clone())
            .or_else(|| session.active_turn_id.clone());
        self.runtime
            .update(&session.id, |session| {
                session.status = "running".to_string();
                session.phase = "thinking".to_string();
                session.completed_at = None;
                session.error = None;
                session.user_prompt = Some(message.to_string());
                session.actions = Some(default_provider_actions(Some("running")));
                if let Some(turn_id) = turn_id.as_deref() {
                    session.active_turn_id = Some(turn_id.to_string());
                    let turns = session.turns.get_or_insert_with(Vec::new);
                    let turn = ensure_turn(turns, turn_id, &now);
                    let object = turn.as_object_mut().expect("turn object");
                    object.insert("userPrompt".to_string(), json!(message));
                    object.insert("status".to_string(), json!("running"));
                    object.insert("phase".to_string(), json!("thinking"));
                    object.insert("startedAt".to_string(), json!(now));
                    object.insert("updatedAt".to_string(), json!(now));
                    let user_messages = object
                        .entry("userMessages")
                        .or_insert_with(|| Value::Array(Vec::new()));
                    if let Some(values) = user_messages.as_array_mut() {
                        values.push(json!({
                            "id": message_id,
                            "text": message,
                            "attachments": user_attachments,
                        }));
                        if values.len() > 100 {
                            values.drain(0..values.len() - 100);
                        }
                    }
                    bump_turn_revision(object);
                }
                Ok(true)
            })
            .map_err(Into::into)
    }

    async fn apply_provider_event(&self, event: ProviderEvent) -> bool {
        let changed = match event {
            ProviderEvent::ThreadSnapshot {
                provider_session_id,
                cwd,
                name,
                model,
                model_provider,
                reasoning_effort,
                status,
                phase,
            } => self.update_by_provider_id(&provider_session_id, |session| {
                let observed_model = model
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .zip(
                        model_provider
                            .as_deref()
                            .filter(|value| !value.trim().is_empty()),
                    )
                    .and_then(|(model, model_provider)| {
                        self.project_observed_model_selection("codex", model_provider, model)
                    });
                if let Some(cwd) = cwd.as_deref().filter(|value| !value.trim().is_empty()) {
                    session.cwd = Some(cwd.to_string());
                }
                if let Some(name) = name.as_deref().filter(|value| !value.trim().is_empty()) {
                    session.title = Some(name.to_string());
                }
                if let Some(selection) = observed_model {
                    session.model_selection = selection
                        .as_ref()
                        .and_then(|selection| serde_json::to_value(selection).ok());
                }
                if let Some(effort) = reasoning_effort.as_deref() {
                    session.reasoning_effort = Some(effort.to_string());
                }
                apply_lifecycle(session, &status);
                if let Some(phase) = phase.as_deref().filter(|value| !value.trim().is_empty()) {
                    session.phase = phase.to_string();
                }
                true
            }),
            ProviderEvent::TurnStarted {
                provider_session_id,
                turn_id,
                started_at,
            } => self.update_by_provider_id(&provider_session_id, |session| {
                let timestamp = started_at.unwrap_or_else(now_iso);
                session.active_turn_id = Some(turn_id.clone());
                session.status = "running".to_string();
                session.phase = "thinking".to_string();
                session.actions = Some(default_provider_actions(Some("running")));
                let turns = session.turns.get_or_insert_with(Vec::new);
                let turn = ensure_turn(turns, &turn_id, &timestamp);
                let object = turn.as_object_mut().expect("turn object");
                object.insert("status".to_string(), json!("running"));
                object.insert("phase".to_string(), json!("thinking"));
                object.insert("startedAt".to_string(), json!(timestamp));
                object.insert("updatedAt".to_string(), json!(now_iso()));
                bump_turn_revision(object);
                true
            }),
            ProviderEvent::TurnCompleted {
                provider_session_id,
                turn_id,
                status,
                error,
                completed_at,
            } => {
                let _ = self
                    .tool_activity
                    .lock()
                    .await
                    .get_mut(&provider_session_id)
                    .map(ToolActivityTracker::clear_active_tools);
                self.update_by_provider_id(&provider_session_id, |session| {
                    let completed_at = completed_at.unwrap_or_else(now_iso);
                    let turn_id = turn_id.or_else(|| session.active_turn_id.clone());
                    let had_completed_turn = turn_id.as_deref().is_some_and(|turn_id| {
                        session
                            .turns
                            .as_mut()
                            .and_then(|turns| find_turn_mut(turns, turn_id))
                            .and_then(|turn| turn.get("completedAt"))
                            .is_some_and(|value| !value.is_null())
                    });
                    session.active_turn_id = None;
                    session.status = if status.as_deref() == Some("failed") {
                        "failed".to_string()
                    } else {
                        "idle".to_string()
                    };
                    session.phase = "unknown".to_string();
                    session.completed_at = Some(completed_at.clone());
                    session.error = error.clone();
                    session.current_tool = None;
                    session.actions = Some(default_provider_actions(None));
                    if !had_completed_turn {
                        session.summary = None;
                        session.last_message = None;
                    }
                    if session.status == "idle" {
                        session.unread = true;
                    }
                    if let (Some(turn_id), Some(turns)) = (turn_id, session.turns.as_mut()) {
                        if let Some(turn) = find_turn_mut(turns, &turn_id) {
                            let object = turn.as_object_mut().expect("turn object");
                            object.insert(
                                "status".to_string(),
                                json!(match status.as_deref() {
                                    Some("failed") => "failed",
                                    Some("interrupted") => "completed",
                                    _ => "completed",
                                }),
                            );
                            object.insert("phase".to_string(), json!("unknown"));
                            object.insert("completedAt".to_string(), json!(completed_at));
                            object.insert("updatedAt".to_string(), json!(now_iso()));
                            if let Some(error) = error {
                                object.insert("summary".to_string(), json!(error));
                            }
                            bump_turn_revision(object);
                        }
                    }
                    true
                })
            }
            ProviderEvent::SessionError {
                provider_session_id,
                error,
            } => self.update_by_provider_id(&provider_session_id, |session| {
                session.error = Some(error);
                true
            }),
            ProviderEvent::ContextCompaction {
                provider_session_id,
                turn_id,
                item_id,
                status,
                observed_at,
            } => {
                let timestamp = observed_at.clone().unwrap_or_else(now_iso);
                let tool_activity = self
                    .tool_activity
                    .lock()
                    .await
                    .entry(provider_session_id.clone())
                    .or_default()
                    .compacting(&turn_id, &status, observed_at.as_deref());
                self.update_by_provider_id(&provider_session_id, |session| {
                    session.current_tool = tool_activity.current_tool.clone();
                    let turns = session.turns.get_or_insert_with(Vec::new);
                    let turn = ensure_turn(turns, &turn_id, &timestamp);
                    let object = turn.as_object_mut().expect("turn object");
                    object.insert("providerTurnId".to_string(), json!(turn_id));
                    object.insert("source".to_string(), json!("realtime"));
                    let mut compaction = Map::new();
                    compaction.insert("id".to_string(), json!(item_id));
                    compaction.insert("status".to_string(), json!(status));
                    if status == "running" {
                        if let Some(observed_at) = observed_at.as_deref() {
                            compaction.insert("startedAt".to_string(), json!(observed_at));
                        }
                    } else if let Some(observed_at) = observed_at.as_deref() {
                        compaction.insert("completedAt".to_string(), json!(observed_at));
                    }
                    object.insert(
                        "contextCompactions".to_string(),
                        Value::Array(vec![Value::Object(compaction)]),
                    );
                    object.insert("updatedAt".to_string(), json!(timestamp));
                    bump_turn_revision(object);
                    true
                })
            }
            ProviderEvent::ThreadClosed {
                provider_session_id,
            } => {
                self.tool_activity.lock().await.remove(&provider_session_id);
                self.update_by_provider_id(&provider_session_id, |session| {
                    let timestamp = now_iso();
                    let active_turn_id = session.active_turn_id.take();
                    session.status = "idle".to_string();
                    session.phase = "unknown".to_string();
                    session.completed_at = Some(timestamp.clone());
                    session.error = None;
                    session.summary = Some("Codex thread closed.".to_string());
                    session.last_message = Some("Codex thread closed.".to_string());
                    session.current_tool = None;
                    session.actions = Some(default_provider_actions(None));
                    if let (Some(turn_id), Some(turns)) = (active_turn_id, session.turns.as_mut()) {
                        if let Some(turn) = find_turn_mut(turns, &turn_id) {
                            let object = turn.as_object_mut().expect("turn object");
                            object.insert("status".to_string(), json!("completed"));
                            object.insert("phase".to_string(), json!("unknown"));
                            object.insert("completedAt".to_string(), json!(timestamp));
                            object.insert("updatedAt".to_string(), json!(timestamp));
                            bump_turn_revision(object);
                        }
                    }
                    true
                })
            }
            ProviderEvent::UserMessage {
                provider_session_id,
                turn_id,
                item_id,
                text,
                observed_at,
            } => self.update_by_provider_id(&provider_session_id, |session| {
                let timestamp = observed_at.unwrap_or_else(now_iso);
                session.user_prompt = Some(text.clone());
                let turns = session.turns.get_or_insert_with(Vec::new);
                let turn = ensure_turn(turns, &turn_id, &timestamp);
                let object = turn.as_object_mut().expect("turn object");
                object.insert("userPrompt".to_string(), json!(text));
                let user_messages = object
                    .entry("userMessages")
                    .or_insert_with(|| Value::Array(Vec::new()));
                if let Some(values) = user_messages.as_array_mut() {
                    let exists = values.iter().any(|value| {
                        value.get("id").and_then(Value::as_str) == Some(item_id.as_str())
                    });
                    if !exists {
                        values.push(json!({
                            "id": item_id,
                            "text": text,
                            "attachments": [],
                        }));
                    }
                }
                bump_turn_revision(object);
                true
            }),
            ProviderEvent::AgentMessageDelta {
                provider_session_id: _,
                turn_id: _,
                item_id: _,
                delta: _,
            } => false,
            ProviderEvent::AgentMessageCompleted {
                provider_session_id,
                turn_id,
                item_id,
                text,
                observed_at,
            } => {
                let tool_activity = self
                    .tool_activity
                    .lock()
                    .await
                    .entry(provider_session_id.clone())
                    .or_default()
                    .reset_for_agent_message();
                self.update_by_provider_id(&provider_session_id, |session| {
                    let timestamp = observed_at.unwrap_or_else(now_iso);
                    session.last_message = Some(text.clone());
                    session.last_message_item_id = Some(item_id.clone());
                    session.tool_calls_since_last_message =
                        tool_activity.tool_calls_since_last_message;
                    session.current_tool = tool_activity.current_tool.clone();
                    session.phase = "responding".to_string();
                    let turns = session.turns.get_or_insert_with(Vec::new);
                    let turn = ensure_turn(turns, &turn_id, &timestamp);
                    let object = turn.as_object_mut().expect("turn object");
                    object.insert("lastMessage".to_string(), json!(text));
                    object.insert("lastMessageItemId".to_string(), json!(item_id));
                    object.insert("phase".to_string(), json!("responding"));
                    object.insert("updatedAt".to_string(), json!(timestamp));
                    bump_turn_revision(object);
                    true
                })
            }
            ProviderEvent::TimelineItem { .. } | ProviderEvent::TimelineItemDelta { .. } => false,
            ProviderEvent::ToolActivity {
                provider_session_id,
                turn_id,
                item,
                running,
                observed_at,
            } => {
                let tool_activity = {
                    let mut trackers = self.tool_activity.lock().await;
                    let tracker = trackers.entry(provider_session_id.clone()).or_default();
                    if running {
                        tracker.started(item.clone())
                    } else {
                        tracker.completed(item.clone())
                    }
                };
                self.update_by_provider_id(&provider_session_id, |session| {
                    let timestamp = observed_at.unwrap_or_else(now_iso);
                    session.current_tool = tool_activity.current_tool.clone();
                    session.tool_calls_since_last_message =
                        tool_activity.tool_calls_since_last_message;
                    session.counters.tool_calls = session
                        .counters
                        .tool_calls
                        .saturating_add(tool_activity.new_tool_ids);
                    session.counters.edits = session
                        .counters
                        .edits
                        .saturating_add(tool_activity.new_edits);
                    if running && tool_activity.new_tool_ids > 0 {
                        session.phase = if tool_activity.new_edits > 0 {
                            "editing".to_string()
                        } else {
                            "tool".to_string()
                        };
                    }
                    if let Some(turn_id) = turn_id {
                        let turns = session.turns.get_or_insert_with(Vec::new);
                        let turn = ensure_turn(turns, &turn_id, &timestamp);
                        let object = turn.as_object_mut().expect("turn object");
                        object.insert(
                            "summary".to_string(),
                            json!(item.get("name").and_then(Value::as_str).unwrap_or("Tool")),
                        );
                        object.insert("updatedAt".to_string(), json!(timestamp));
                        if running && tool_activity.new_tool_ids > 0 {
                            object.insert("phase".to_string(), json!("tool"));
                        }
                        bump_turn_revision(object);
                    }
                    true
                })
            }
            ProviderEvent::ApprovalRequested {
                provider_session_id,
                turn_id,
                summary,
                ..
            } => self.update_by_provider_id(&provider_session_id, |session| {
                if let Some(turn_id) = turn_id.as_deref() {
                    session.active_turn_id = Some(turn_id.to_string());
                }
                session.status = "waiting".to_string();
                session.phase = "approval".to_string();
                session.summary = Some(summary);
                session.actions = Some(default_provider_actions(Some("waiting")));
                session.counters.approvals = session.counters.approvals.saturating_add(1);
                true
            }),
            ProviderEvent::ApprovalResolved {
                provider_session_id,
                decision,
            } => self.update_by_provider_id(&provider_session_id, |session| {
                session.status = if decision == "skip" {
                    "idle".to_string()
                } else {
                    "running".to_string()
                };
                session.phase = if decision == "skip" {
                    "unknown".to_string()
                } else {
                    "thinking".to_string()
                };
                session.summary = None;
                session.actions = Some(default_provider_actions(Some(session.status.as_str())));
                true
            }),
            ProviderEvent::ConnectionChanged { connected } => {
                if !connected {
                    self.tool_activity.lock().await.clear();
                }
                false
            }
        };
        changed
    }

    fn update_by_provider_id<F>(&self, provider_session_id: &str, mutate: F) -> bool
    where
        F: FnOnce(&mut AiSession) -> bool,
    {
        let Some(session) =
            self.runtime.list().into_iter().find(|session| {
                session.provider_session_id.as_deref() == Some(provider_session_id)
            })
        else {
            return false;
        };
        self.runtime
            .update(&session.id, |session| Ok(mutate(session)))
            .is_ok()
    }

    fn restore_completed_creates(&self) {
        let Some(path) = self.create_store_path.as_deref() else {
            return;
        };
        let Ok(bytes) = std::fs::read(path) else {
            return;
        };
        let Ok(store) = serde_json::from_slice::<CreateOperationStore>(&bytes) else {
            tracing::warn!(path = %path.display(), "ignoring invalid AI session create operation store");
            return;
        };
        let mut completed = self
            .completed_creates
            .try_lock()
            .expect("controller construction");
        for operation in store.completed {
            completed.insert(operation.client_request_id.clone(), operation);
        }
    }

    fn persist_completed_creates(&self) {
        let Some(path) = self.create_store_path.as_deref() else {
            return;
        };
        let completed = self.completed_creates.try_lock();
        let Ok(completed) = completed else {
            return;
        };
        let store = CreateOperationStore {
            version: 2,
            completed: completed.values().cloned().collect(),
        };
        let Ok(bytes) = serde_json::to_vec_pretty(&store) else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(error) =
            controlled_instance_core::atomic::write_atomic(path, &bytes, Some(0o600))
        {
            tracing::warn!(path = %path.display(), %error, "failed to persist AI session create operations");
        }
    }
}

fn provider_order(agent: &str) -> usize {
    match agent {
        "codex" => 0,
        "claude" => 1,
        "opencode" => 2,
        _ => 3,
    }
}

#[derive(Debug, Clone)]
pub struct ProviderMessageInput {
    pub message: AiSessionMessageInput,
    pub attachments: Vec<ProviderAttachment>,
}

impl ProviderMessageInput {
    pub fn from_wire(message: &AiSessionMessageInput) -> Self {
        Self {
            message: message.clone(),
            attachments: Vec::new(),
        }
    }

    pub fn from_queue_item(item: &Value) -> Result<Self, ProviderError> {
        let message = item
            .get("message")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_QUEUE_ITEM_INVALID",
                    "Queued message is invalid.",
                    500,
                )
            })?
            .to_string();
        let attachments: Vec<ProviderAttachment> = item
            .get("attachments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|attachment| {
                Some(ProviderAttachment {
                    meta: serde_json::from_value(attachment.clone()).ok()?,
                    path: PathBuf::new(),
                })
            })
            .collect();
        let references = item
            .get("references")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        let permission_mode = item
            .get("permissionMode")
            .and_then(Value::as_str)
            .and_then(parse_permission_mode);
        Ok(Self {
            message: AiSessionMessageInput {
                message,
                mode: None,
                client_request_id: None,
                attachments: Vec::new(),
                references,
                permission_mode,
            },
            attachments,
        })
    }
}

fn provider_message(
    input: &ProviderMessageInput,
    staged: &StagedAiSessionMessageAttachments,
) -> ProviderMessage {
    ProviderMessage {
        message: input.message.message.clone(),
        attachments: staged
            .provider_attachments
            .iter()
            .map(provider_attachment)
            .collect(),
        references: input.message.references.clone(),
        permission_mode: input.message.permission_mode,
        message_id: Some(staged.message_id.clone()),
        user_message_attachments: staged.attachments.clone(),
        story_agent_tools: None,
    }
}

fn provider_attachment(attachment: &RetainedAiSessionMessageAttachment) -> ProviderAttachment {
    ProviderAttachment {
        meta: attachment.meta.clone(),
        path: attachment.retained_path.clone(),
    }
}

fn queued_item(session: &AiSession, queue_id: &str) -> Result<Value, ProviderError> {
    session
        .queue
        .items
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(queue_id))
        .cloned()
        .ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_QUEUE_ITEM_NOT_FOUND",
                "Queued message not found.",
                404,
            )
        })
}

fn canonical_directory(value: &str) -> Result<PathBuf, ProviderError> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(ProviderError::new(
            "AI_SESSION_RUNTIME_PATH_INVALID",
            "AI session cwd must be an absolute runtime path.",
            400,
        ));
    }
    let canonical = std::fs::canonicalize(&path).map_err(|_| {
        ProviderError::new(
            "AI_SESSION_RUNTIME_PATH_NOT_FOUND",
            format!("AI session cwd does not exist: {value}"),
            400,
        )
    })?;
    if !canonical.is_dir() {
        return Err(ProviderError::new(
            "AI_SESSION_RUNTIME_PATH_NOT_DIRECTORY",
            format!("AI session cwd is not a directory: {value}"),
            400,
        ));
    }
    Ok(canonical)
}

fn attachment_required_kind(
    attachment: &AiSessionAttachmentInput,
) -> Result<AiSessionAttachmentKind, ProviderError> {
    attachment.kind.ok_or_else(|| {
        ProviderError::new(
            "AI_SESSION_ATTACHMENT_INVALID",
            "Attachment kind is required.",
            400,
        )
    })
}

fn attachment_required_name(
    attachment: &AiSessionAttachmentInput,
) -> Result<String, ProviderError> {
    attachment.name.clone().ok_or_else(|| {
        ProviderError::new(
            "AI_SESSION_ATTACHMENT_INVALID",
            "Attachment name is required.",
            400,
        )
    })
}

fn attachment_required_mime(
    attachment: &AiSessionAttachmentInput,
) -> Result<String, ProviderError> {
    attachment.mime.clone().ok_or_else(|| {
        ProviderError::new(
            "AI_SESSION_ATTACHMENT_INVALID",
            "Attachment MIME type is required.",
            400,
        )
    })
}

fn is_session_busy(session: &AiSession) -> bool {
    matches!(session.status.as_str(), "running" | "waiting")
}

fn has_active_codex_descendants(session: &AiSession, sessions: &[AiSession]) -> bool {
    let provider_session_id = session.provider_session_id.as_deref();
    session
        .lineage
        .as_ref()
        .and_then(|lineage| lineage.get("kind"))
        .and_then(Value::as_str)
        == Some("subagent")
        || provider_session_id.is_some_and(|provider_session_id| {
            sessions.iter().any(|candidate| {
                candidate
                    .lineage
                    .as_ref()
                    .and_then(|lineage| lineage.get("kind"))
                    .and_then(Value::as_str)
                    == Some("subagent")
                    && candidate
                        .lineage
                        .as_ref()
                        .and_then(|lineage| lineage.get("parentProviderSessionId"))
                        .and_then(Value::as_str)
                        == Some(provider_session_id)
            })
        })
}

fn default_provider_actions(status: Option<&str>) -> Value {
    let active = status.is_some_and(|status| matches!(status, "running" | "waiting"));
    json!({
        "send": true,
        "interrupt": active,
        "approval": status == Some("waiting"),
        "fork": true,
        "rename": true,
        "openApp": false,
        "close": true,
    })
}

fn apply_lifecycle(session: &mut AiSession, status: &str) {
    match status {
        "idle" => {
            session.status = "idle".to_string();
            session.phase = "unknown".to_string();
            session.active_turn_id = None;
            session.actions = Some(default_provider_actions(None));
        }
        "running" | "waiting" | "failed" => {
            session.status = status.to_string();
            if status == "failed" {
                session.phase = "unknown".to_string();
            }
            session.actions = Some(default_provider_actions(Some(status)));
        }
        _ => {}
    }
}

fn ensure_turn<'a>(turns: &'a mut Vec<Value>, turn_id: &str, timestamp: &str) -> &'a mut Value {
    let index = turns.iter().position(|turn| {
        turn.get("id").and_then(Value::as_str) == Some(turn_id)
            || turn.get("providerTurnId").and_then(Value::as_str) == Some(turn_id)
    });
    let index = match index {
        Some(index) => index,
        None => {
            turns.push(json!({
                "id": turn_id,
                "providerTurnId": turn_id,
                "source": "realtime",
                "status": "running",
                "phase": "thinking",
                "revision": 0,
                "startedAt": timestamp,
                "updatedAt": timestamp,
            }));
            turns.len() - 1
        }
    };
    &mut turns[index]
}

fn find_turn_mut<'a>(turns: &'a mut [Value], turn_id: &str) -> Option<&'a mut Value> {
    turns.iter_mut().find(|turn| {
        turn.get("id").and_then(Value::as_str) == Some(turn_id)
            || turn.get("providerTurnId").and_then(Value::as_str) == Some(turn_id)
    })
}

fn bump_turn_revision(turn: &mut Map<String, Value>) {
    let revision = turn.get("revision").and_then(Value::as_u64).unwrap_or(0) + 1;
    turn.insert("revision".to_string(), json!(revision));
}

fn parse_permission_mode(value: &str) -> Option<AiSessionPermissionMode> {
    match value {
        "ask" => Some(AiSessionPermissionMode::Ask),
        "auto-review" => Some(AiSessionPermissionMode::AutoReview),
        "full-access" => Some(AiSessionPermissionMode::FullAccess),
        _ => None,
    }
}

fn create_fingerprint(
    input: &AiSessionCreateInput,
    options: &AiSessionManagedCreateOptions,
) -> Result<String, ProviderError> {
    let mut value = serde_json::to_value(input).map_err(|error| {
        ProviderError::new("AI_SESSION_CONTROL_INVALID", error.to_string(), 400)
    })?;
    if let Some(object) = value.as_object_mut() {
        object.remove("clientRequestId");
        if let Some(message) = object.get_mut("message").and_then(Value::as_object_mut) {
            message.remove("clientRequestId");
        }
        if !options.runtime_workspace_roots.is_empty() {
            object.insert(
                "runtimeWorkspaceRoots".to_string(),
                Value::Array(
                    options
                        .runtime_workspace_roots
                        .iter()
                        .map(|root| Value::String(root.display().to_string()))
                        .collect(),
                ),
            );
        }
        if let Some(tools) = &options.agent_tools {
            object.insert(
                "agentTools".to_string(),
                Value::Array(tools.iter().cloned().map(Value::String).collect()),
            );
        }
    }
    Ok(hex::encode(Sha256::digest(canonical_json_bytes(&value))))
}

fn send_fingerprint(session_id: &str, input: &AiSessionMessageInput) -> String {
    let value = json!({
        "sessionId": session_id,
        "message": input.message,
        "mode": input.mode,
        "permissionMode": input.permission_mode,
        "references": input.references,
        "attachments": input.attachments,
    });
    hex::encode(Sha256::digest(canonical_json_bytes(&value)))
}

fn canonical_json_bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(&canonical_value(value)).unwrap_or_default()
}

fn canonical_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_value).collect()),
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical_value(&object[key])))
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_protocol::{
        AiSessionCounters, AiSessionProviderActions, AiSessionProviderTimelineCapabilities,
        AiSessionQueue,
    };

    fn test_session() -> AiSession {
        AiSession {
            id: "ses_0000000000001".to_string(),
            agent: "codex".to_string(),
            creation_source: "ai-session".to_string(),
            app_session_id: None,
            app_id: None,
            provider_session_id: Some("thread-1".to_string()),
            lineage: None,
            provider_meta: None,
            model_selection: None,
            reasoning_effort: None,
            story_id: None,
            app_binding_keys: None,
            actions: None,
            active_turn_id: Some("turn-1".to_string()),
            title: None,
            cwd: Some("/workspace".to_string()),
            cwd_folder_id: None,
            user_prompt: None,
            turns: None,
            status: "running".to_string(),
            phase: "thinking".to_string(),
            summary: None,
            last_message: None,
            last_message_item_id: None,
            current_tool: None,
            tool_calls_since_last_message: 0,
            sub_agents: Vec::new(),
            transcript_path: None,
            transcript_size: None,
            started_at: "2026-11-02T00:00:00.000Z".to_string(),
            updated_at: "2026-11-02T00:00:00.000Z".to_string(),
            completed_at: None,
            error: None,
            counters: AiSessionCounters::default(),
            queue: AiSessionQueue::default(),
            unread: false,
        }
    }

    fn test_controller() -> (
        Arc<AiSessionRuntime>,
        Arc<AiSessionController>,
        tempfile::TempDir,
    ) {
        let runtime = Arc::new(AiSessionRuntime::new("test", None));
        runtime.save(test_session()).expect("save session");
        let directory = tempfile::tempdir().expect("temporary directory");
        let attachments = Arc::new(AiSessionConversationAttachmentStore::new(directory.path()));
        let controller = AiSessionController::new(
            runtime.clone(),
            attachments.clone(),
            Arc::new(attachments.draft_streams()),
            None,
        );
        (runtime, controller, directory)
    }

    struct PreserveInterruptProvider;

    #[async_trait]
    impl AiSessionControlProvider for PreserveInterruptProvider {
        fn agent(&self) -> &str {
            "claude"
        }

        fn capability(&self) -> AiSessionProviderCapability {
            AiSessionProviderCapability {
                agent: "claude".to_string(),
                actions: AiSessionProviderActions::default(),
                permission_modes: Vec::new(),
                timeline: AiSessionProviderTimelineCapabilities::default(),
                model_selection: None,
                reasoning_effort: None,
                hierarchy: None,
            }
        }

        fn interrupt_preserves_turn(&self) -> bool {
            true
        }

        async fn interrupt(&self, _session: &AiSession) -> Result<ProviderAction, ProviderError> {
            Ok(ProviderAction::simple("interrupt"))
        }
    }

    #[tokio::test]
    async fn interrupt_preserving_providers_wait_for_the_authoritative_completion_event() {
        let (runtime, controller, _directory) = test_controller();
        let mut session = test_session();
        session.agent = "claude".to_string();
        session.status = "running".to_string();
        session.phase = "responding".to_string();
        session.turns = Some(vec![json!({
            "id": "turn-1",
            "providerTurnId": "provider-turn-1",
            "status": "running",
            "phase": "responding",
        })]);
        runtime.save(session).expect("save claude session");
        controller.register_provider(Arc::new(PreserveInterruptProvider));

        let result = controller
            .interrupt("ses_0000000000001")
            .await
            .expect("interrupt");

        assert_eq!(result.session.status, "running");
        assert_eq!(result.session.phase, "unknown");
        assert_eq!(result.session.active_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(
            result.session.turns.as_ref().expect("turns")[0]["status"],
            "running"
        );
        assert_eq!(
            result.session.actions.as_ref().expect("actions")["interrupt"],
            true
        );
    }

    #[test]
    fn create_fingerprint_ignores_only_the_idempotency_key() {
        let mut input = AiSessionCreateInput {
            agent: "codex".to_string(),
            cwd: AiSessionRuntimePathInput {
                runtime_path_type: "runtime-path".to_string(),
                path: "/workspace".to_string(),
            },
            cwd_folder_id: None,
            git_selection: None,
            workspace_selection: None,
            model_selection: None,
            reasoning_effort: None,
            story_id: None,
            message: AiSessionMessageInput {
                message: "hello".to_string(),
                client_request_id: Some("one".to_string()),
                ..Default::default()
            },
        };
        let first = create_fingerprint(&input, &AiSessionManagedCreateOptions::default())
            .expect("fingerprint");
        input.message.client_request_id = Some("two".to_string());
        assert_eq!(
            first,
            create_fingerprint(&input, &AiSessionManagedCreateOptions::default())
                .expect("fingerprint")
        );
        input.message.message = "different".to_string();
        assert_ne!(
            first,
            create_fingerprint(&input, &AiSessionManagedCreateOptions::default())
                .expect("fingerprint")
        );
    }

    #[test]
    fn provider_capability_defaults_do_not_expose_unsupported_actions() {
        let actions = AiSessionProviderActions::default();
        assert!(!actions.create);
        let timeline = AiSessionProviderTimelineCapabilities::default();
        assert!(!timeline.live_items);
    }

    #[tokio::test]
    async fn message_deltas_stay_transient_until_the_completed_message_arrives() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let runtime = Arc::new(AiSessionRuntime::new("test", None));
        runtime.save(test_session()).expect("save session");
        let attachments = Arc::new(AiSessionConversationAttachmentStore::new(directory.path()));
        let controller = AiSessionController::new(
            runtime.clone(),
            attachments.clone(),
            Arc::new(attachments.draft_streams()),
            None,
        );

        let changed = controller
            .apply_provider_event(ProviderEvent::AgentMessageDelta {
                provider_session_id: "thread-1".to_string(),
                turn_id: "turn-1".to_string(),
                item_id: "item-1".to_string(),
                delta: "partial".to_string(),
            })
            .await;
        assert!(!changed);
        let session = runtime.get("ses_0000000000001").expect("session");
        assert_eq!(session.last_message, None);
        assert_eq!(session.last_message_item_id, None);

        let changed = controller
            .apply_provider_event(ProviderEvent::AgentMessageCompleted {
                provider_session_id: "thread-1".to_string(),
                turn_id: "turn-1".to_string(),
                item_id: "item-1".to_string(),
                text: "partial complete".to_string(),
                observed_at: None,
            })
            .await;
        assert!(changed);
        let session = runtime.get("ses_0000000000001").expect("session");
        assert_eq!(session.last_message.as_deref(), Some("partial complete"));
        assert_eq!(session.last_message_item_id.as_deref(), Some("item-1"));
    }

    #[tokio::test]
    async fn provider_snapshots_update_app_created_sessions_by_provider_identity() {
        let runtime = Arc::new(AiSessionRuntime::new("test", None));
        let mut session = test_session();
        session.creation_source = "app-session".to_string();
        session.app_session_id = Some("app_0000000000001".to_string());
        session.app_id = Some("codex".to_string());
        runtime.save(session).expect("save session");
        let directory = tempfile::tempdir().expect("temporary directory");
        let attachments = Arc::new(AiSessionConversationAttachmentStore::new(directory.path()));
        let controller = AiSessionController::new(
            runtime.clone(),
            attachments.clone(),
            Arc::new(attachments.draft_streams()),
            None,
        );

        let changed = controller
            .apply_provider_event(ProviderEvent::ThreadSnapshot {
                provider_session_id: "thread-1".to_string(),
                cwd: None,
                name: Some("Renamed in Codex".to_string()),
                model: None,
                model_provider: None,
                reasoning_effort: Some("high".to_string()),
                status: "idle".to_string(),
                phase: Some("unknown".to_string()),
            })
            .await;

        assert!(changed);
        let updated = runtime.get("ses_0000000000001").expect("session");
        assert_eq!(updated.creation_source, "app-session");
        assert_eq!(updated.title.as_deref(), Some("Renamed in Codex"));
        assert_eq!(updated.status, "idle");
        assert_eq!(updated.reasoning_effort.as_deref(), Some("high"));
    }

    struct TestObservedModelResolver;

    impl AiSessionModelSelectionResolver for TestObservedModelResolver {
        fn resolve(
            &self,
            _agent: &str,
            requested: Option<&AiSessionModelSelection>,
            _intent: AiSessionModelSelectionIntent,
        ) -> Result<Option<AiSessionModelSelection>, ProviderError> {
            Ok(requested.cloned())
        }

        fn supports_observed_model_projection(&self, agent: &str) -> bool {
            agent == "codex"
        }

        fn project_observed_model_selection(
            &self,
            _agent: &str,
            model_provider: &str,
            model: &str,
        ) -> Option<AiSessionModelSelection> {
            (model_provider == "task-handoff-model-primary").then(|| AiSessionModelSelection {
                model_entity_id: "model-primary".to_string(),
                model_name: "Primary Label".to_string(),
                model_upstream_name: Some(model.to_string()),
            })
        }
    }

    #[tokio::test]
    async fn provider_snapshots_project_observed_models_into_public_identity() {
        let runtime = Arc::new(AiSessionRuntime::new("test", None));
        let mut session = test_session();
        session.creation_source = "app-session".to_string();
        session.app_session_id = Some("app_0000000000001".to_string());
        runtime.save(session).expect("save session");
        let directory = tempfile::tempdir().expect("temporary directory");
        let attachments = Arc::new(AiSessionConversationAttachmentStore::new(directory.path()));
        let controller = AiSessionController::new(
            runtime.clone(),
            attachments.clone(),
            Arc::new(attachments.draft_streams()),
            None,
        );
        controller.set_model_selection_resolver(Arc::new(TestObservedModelResolver));

        let changed = controller
            .apply_provider_event(ProviderEvent::ThreadSnapshot {
                provider_session_id: "thread-1".to_string(),
                cwd: None,
                name: None,
                model: Some("upstream-primary".to_string()),
                model_provider: Some("task-handoff-model-primary".to_string()),
                reasoning_effort: None,
                status: "idle".to_string(),
                phase: None,
            })
            .await;

        assert!(changed);
        let updated = runtime.get("ses_0000000000001").expect("session");
        assert_eq!(
            updated.model_selection,
            Some(json!({
                "modelEntityId": "model-primary",
                "modelName": "Primary Label",
                "modelUpstreamName": "upstream-primary"
            }))
        );
    }

    #[tokio::test]
    async fn turn_completion_clears_stale_response_only_for_the_first_completion() {
        let (runtime, controller, _directory) = test_controller();
        runtime
            .update("ses_0000000000001", |session| {
                session.summary = Some("stale summary".to_string());
                session.last_message = Some("stale response".to_string());
                session.last_message_item_id = Some("message-1".to_string());
                session.turns = Some(vec![json!({
                    "id": "turn-1",
                    "providerTurnId": "turn-1",
                    "status": "running",
                    "phase": "thinking",
                    "revision": 1,
                    "startedAt": "2026-11-02T00:00:00.000Z",
                    "updatedAt": "2026-11-02T00:00:00.000Z"
                })]);
                Ok(true)
            })
            .expect("seed response");

        controller
            .apply_provider_event(ProviderEvent::TurnCompleted {
                provider_session_id: "thread-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                status: Some("completed".to_string()),
                error: None,
                completed_at: Some("2026-11-02T00:01:00.000Z".to_string()),
            })
            .await;
        let completed = runtime.get("ses_0000000000001").expect("completed session");
        assert_eq!(completed.summary, None);
        assert_eq!(completed.last_message, None);
        assert_eq!(completed.last_message_item_id.as_deref(), Some("message-1"));

        runtime
            .update("ses_0000000000001", |session| {
                session.summary = Some("kept summary".to_string());
                session.last_message = Some("kept response".to_string());
                Ok(true)
            })
            .expect("seed duplicate completion");
        controller
            .apply_provider_event(ProviderEvent::TurnCompleted {
                provider_session_id: "thread-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                status: Some("completed".to_string()),
                error: None,
                completed_at: Some("2026-11-02T00:02:00.000Z".to_string()),
            })
            .await;
        let duplicate = runtime
            .get("ses_0000000000001")
            .expect("duplicate completion session");
        assert_eq!(duplicate.summary.as_deref(), Some("kept summary"));
        assert_eq!(duplicate.last_message.as_deref(), Some("kept response"));
    }

    #[tokio::test]
    async fn parallel_tools_are_tracked_by_id_without_double_counting() {
        let (runtime, controller, _directory) = test_controller();
        let first = json!({
            "id": "tool-a",
            "kind": "commandExecution",
            "name": "Command A"
        });
        let second = json!({
            "id": "tool-b",
            "kind": "commandExecution",
            "name": "Command B"
        });
        for item in [first.clone(), second.clone(), first.clone()] {
            controller
                .apply_provider_event(ProviderEvent::ToolActivity {
                    provider_session_id: "thread-1".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    item,
                    running: true,
                    observed_at: None,
                })
                .await;
        }
        let running = runtime.get("ses_0000000000001").expect("running session");
        assert_eq!(
            running
                .current_tool
                .as_ref()
                .and_then(|tool| tool.get("id"))
                .and_then(Value::as_str),
            Some("tool-b")
        );
        assert_eq!(running.tool_calls_since_last_message, 2);
        assert_eq!(running.counters.tool_calls, 2);

        controller
            .apply_provider_event(ProviderEvent::ToolActivity {
                provider_session_id: "thread-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                item: first,
                running: false,
                observed_at: None,
            })
            .await;
        let after_first = runtime.get("ses_0000000000001").expect("first completed");
        assert_eq!(
            after_first
                .current_tool
                .as_ref()
                .and_then(|tool| tool.get("id"))
                .and_then(Value::as_str),
            Some("tool-b")
        );
        assert_eq!(after_first.tool_calls_since_last_message, 2);
        assert_eq!(after_first.counters.tool_calls, 2);

        controller
            .apply_provider_event(ProviderEvent::ToolActivity {
                provider_session_id: "thread-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                item: second,
                running: false,
                observed_at: None,
            })
            .await;
        let after_second = runtime.get("ses_0000000000001").expect("second completed");
        assert!(after_second.current_tool.is_none());
        assert_eq!(after_second.tool_calls_since_last_message, 2);
    }

    #[tokio::test]
    async fn agent_message_resets_and_thread_close_clears_tool_tracking() {
        let (runtime, controller, _directory) = test_controller();
        controller
            .apply_provider_event(ProviderEvent::ToolActivity {
                provider_session_id: "thread-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                item: json!({
                    "id": "tool-a",
                    "kind": "commandExecution",
                    "name": "Command A"
                }),
                running: true,
                observed_at: None,
            })
            .await;
        controller
            .apply_provider_event(ProviderEvent::AgentMessageCompleted {
                provider_session_id: "thread-1".to_string(),
                turn_id: "turn-1".to_string(),
                item_id: "message-1".to_string(),
                text: "Done".to_string(),
                observed_at: None,
            })
            .await;
        let responded = runtime.get("ses_0000000000001").expect("responded session");
        assert!(responded.current_tool.is_none());
        assert_eq!(responded.tool_calls_since_last_message, 0);

        controller
            .apply_provider_event(ProviderEvent::ToolActivity {
                provider_session_id: "thread-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                item: json!({
                    "id": "tool-b",
                    "kind": "commandExecution",
                    "name": "Command B"
                }),
                running: true,
                observed_at: None,
            })
            .await;
        controller
            .apply_provider_event(ProviderEvent::ThreadClosed {
                provider_session_id: "thread-1".to_string(),
            })
            .await;
        let closed = runtime.get("ses_0000000000001").expect("closed session");
        assert_eq!(closed.status, "idle");
        assert!(closed.current_tool.is_none());
        assert_eq!(closed.summary.as_deref(), Some("Codex thread closed."));
    }

    #[tokio::test]
    async fn session_error_and_context_compaction_match_realtime_semantics() {
        let (runtime, controller, _directory) = test_controller();
        controller
            .apply_provider_event(ProviderEvent::SessionError {
                provider_session_id: "thread-1".to_string(),
                error: "Realtime connection failed".to_string(),
            })
            .await;
        let failed = runtime.get("ses_0000000000001").expect("session error");
        assert_eq!(failed.status, "running");
        assert_eq!(failed.phase, "thinking");
        assert_eq!(failed.error.as_deref(), Some("Realtime connection failed"));

        controller
            .apply_provider_event(ProviderEvent::ContextCompaction {
                provider_session_id: "thread-1".to_string(),
                turn_id: "turn-1".to_string(),
                item_id: "context_compaction:turn-1".to_string(),
                status: "running".to_string(),
                observed_at: Some("2026-11-02T00:01:00.000Z".to_string()),
            })
            .await;
        let compacting = runtime.get("ses_0000000000001").expect("compacting turn");
        let compaction = compacting
            .turns
            .as_ref()
            .and_then(|turns| turns.first())
            .and_then(|turn| turn.get("contextCompactions"))
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .expect("running compaction");
        assert_eq!(
            compaction.get("status").and_then(Value::as_str),
            Some("running")
        );
        assert_eq!(
            compaction.get("startedAt").and_then(Value::as_str),
            Some("2026-11-02T00:01:00.000Z")
        );
        assert_eq!(
            compacting
                .current_tool
                .as_ref()
                .and_then(|tool| tool.get("name"))
                .and_then(Value::as_str),
            Some("Compacting context…")
        );

        controller
            .apply_provider_event(ProviderEvent::ContextCompaction {
                provider_session_id: "thread-1".to_string(),
                turn_id: "turn-1".to_string(),
                item_id: "context_compaction:turn-1".to_string(),
                status: "completed".to_string(),
                observed_at: Some("2026-11-02T00:02:00.000Z".to_string()),
            })
            .await;
        let compacted = runtime.get("ses_0000000000001").expect("compacted turn");
        let compactions = compacted
            .turns
            .as_ref()
            .and_then(|turns| turns.first())
            .and_then(|turn| turn.get("contextCompactions"))
            .and_then(Value::as_array)
            .expect("compaction list");
        assert_eq!(compactions.len(), 1);
        assert_eq!(
            compactions[0].get("status").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            compactions[0].get("completedAt").and_then(Value::as_str),
            Some("2026-11-02T00:02:00.000Z")
        );
        assert_eq!(
            compacted
                .current_tool
                .as_ref()
                .and_then(|tool| tool.get("name"))
                .and_then(Value::as_str),
            Some("Context compacted")
        );
    }
}
