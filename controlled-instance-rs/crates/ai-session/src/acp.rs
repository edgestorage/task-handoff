use crate::acp_model::{
    acp_model_value, acp_permission_mode_for_id, acp_permission_mode_id, acp_permission_modes,
    normalize_acp_session_configuration, normalize_acp_session_modes, AcpSessionConfiguration,
    AcpSessionModes,
};
use crate::acp_timeline::AcpToolSnapshot;
use crate::provider::{
    AiSessionControlProvider, AiSessionModelSelection, ProviderAction, ProviderApprovalObserver,
    ProviderApprovalUpdate, ProviderCreateInput, ProviderCreateResult, ProviderError,
    ProviderEvent, ProviderMessage, ProviderResumeResult,
};
use crate::{
    acp_connection::AcpConnection, AiSession, AiSessionPermissionMode, AiSessionTimelineStore,
};
use agent_client_protocol::v1::schema::{
    CancelNotification, ContentBlock, ImageContent, PermissionOptionKind, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse, ResourceLink,
    SelectedPermissionOutcome, SessionConfigOption, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionModeRequest, StopReason, SystemPrompt, TextContent,
    ToolCallUpdate,
};
use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use controlled_instance_core::fs_permissions::restrict_path;
use controlled_instance_protocol::{
    AiSessionAttachmentKind, AiSessionConversationAttachment, AiSessionModelSelectionCapabilities,
    AiSessionProviderActions, AiSessionProviderCapability, AiSessionProviderTimelineCapabilities,
    AiSessionReasoningEffortCapabilities, AiSessionTimeline, AiSessionTimelineItem,
    AiSessionTurnTimeline,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{broadcast, oneshot, watch};
use url::Url;

pub struct AcpLaunch {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cleanup_dir: Option<PathBuf>,
    pub session_home: Option<AcpSessionHome>,
}

/// Agent-owned state that must outlive the temporary per-process home. The
/// Agent can only be addressed by its ACP session ID after session/new, so the
/// snapshot is keyed by that ID when the process closes.
#[derive(Debug, Clone)]
pub struct AcpSessionHome {
    pub source: PathBuf,
    pub durable_root: PathBuf,
}

impl AcpSessionHome {
    fn snapshot_path(&self, provider_session_id: &str) -> PathBuf {
        use sha2::{Digest, Sha256};
        let key = Sha256::digest(provider_session_id.as_bytes());
        self.durable_root.join(
            key.iter()
                .take(16)
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        )
    }

    pub fn restore(&self, provider_session_id: &str) -> io::Result<()> {
        let snapshot = self.snapshot_path(provider_session_id);
        if !snapshot.is_dir() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.source)?;
        restrict_path(&self.source, 0o700)?;
        copy_directory(&snapshot, &self.source)
    }

    pub fn persist(&self, provider_session_id: &str) -> io::Result<()> {
        if !self.source.is_dir() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.durable_root)?;
        restrict_path(&self.durable_root, 0o700)?;
        let target = self.snapshot_path(provider_session_id);
        let staging = self.durable_root.join(format!(
            ".tmp-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&staging);
        copy_directory(&self.source, &staging)?;
        restrict_path(&staging, 0o700)?;
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&staging, &target)?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct AcpLaunchInput {
    pub cwd: PathBuf,
    pub provider_session_id: Option<String>,
    pub model_selection: Option<AiSessionModelSelection>,
    pub reasoning_effort: Option<String>,
}

struct PendingApproval {
    id: String,
    request: RequestPermissionRequest,
    response: oneshot::Sender<RequestPermissionResponse>,
}

struct Turn {
    id: String,
    text: String,
    segment: String,
    item_id: String,
    sequence: usize,
    tools: HashMap<String, AcpToolSnapshot>,
    prompt: String,
    attachments: Vec<AiSessionConversationAttachment>,
    approval: Option<PendingApproval>,
    start: Option<oneshot::Sender<bool>>,
    done: watch::Receiver<Option<bool>>,
    cancelling: bool,
}

#[derive(Default)]
struct SessionState {
    id: Option<SessionId>,
    turn: Option<Turn>,
    starting: bool,
    retired: bool,
    replay: Option<(SessionId, AcpReplay)>,
    configuration: AcpSessionConfiguration,
    modes: Option<AcpSessionModes>,
    permission_mode: Option<AiSessionPermissionMode>,
    model_selection: Option<AiSessionModelSelection>,
    reasoning_effort: Option<String>,
}

struct SessionBinding {
    state: Arc<Mutex<SessionState>>,
    connection: Arc<AcpConnection>,
    cleanup_dir: Arc<Mutex<Option<PathBuf>>>,
    session_home: Option<AcpSessionHome>,
}

struct OpenedSession {
    id: String,
    model_selection: Option<AiSessionModelSelection>,
    reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "session/new", response = RawSessionResponse)]
struct RawNewSessionRequest {
    cwd: PathBuf,
    #[serde(default)]
    mcp_servers: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    system_prompt: Option<SystemPrompt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "session/load", response = RawSessionOptionsResponse)]
struct RawLoadSessionRequest {
    session_id: String,
    cwd: PathBuf,
    #[serde(default)]
    mcp_servers: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    system_prompt: Option<SystemPrompt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "session/options", response = RawSessionOptionsResponse)]
struct RawSessionOptionsRequest {
    session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[serde(rename_all = "camelCase")]
#[request(method = "session/set_model", response = RawSetModelResponse)]
struct RawSetModelRequest {
    session_id: String,
    model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
struct RawSessionResponse {
    session_id: SessionId,
    #[serde(default)]
    config_options: Option<Vec<SessionConfigOption>>,
    #[serde(default)]
    models: Option<Value>,
    #[serde(default)]
    modes: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
struct RawSessionOptionsResponse {
    #[serde(default)]
    config_options: Option<Vec<SessionConfigOption>>,
    #[serde(default)]
    models: Option<Value>,
    #[serde(default)]
    modes: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
struct RawSetModelResponse {}

pub struct AcpSessionProvider {
    agent: String,
    launch: Box<dyn Fn(AcpLaunchInput) -> Result<AcpLaunch, ProviderError> + Send + Sync>,
    sessions: Mutex<HashMap<String, SessionBinding>>,
    events: broadcast::Sender<ProviderEvent>,
    timeline: AiSessionTimelineStore,
    lifecycle: tokio::sync::Mutex<()>,
    load_session: AtomicBool,
    image_prompt: AtomicBool,
    instructions: Mutex<HashMap<String, String>>,
    instruction_snapshot_path: Mutex<Option<PathBuf>>,
}

impl AcpSessionProvider {
    pub fn new(
        agent: impl Into<String>,
        launch: impl Fn(AcpLaunchInput) -> Result<AcpLaunch, ProviderError> + Send + Sync + 'static,
        timeline: AiSessionTimelineStore,
        load_session: bool,
    ) -> Self {
        Self {
            agent: agent.into(),
            launch: Box::new(launch),
            sessions: Mutex::new(HashMap::new()),
            events: broadcast::channel(1024).0,
            timeline,
            lifecycle: tokio::sync::Mutex::new(()),
            load_session: AtomicBool::new(load_session),
            image_prompt: AtomicBool::new(false),
            instructions: Mutex::new(HashMap::new()),
            instruction_snapshot_path: Mutex::new(None),
        }
    }

    pub fn set_story_instruction_snapshot_path(&self, path: PathBuf) {
        *self.instruction_snapshot_path.lock().unwrap() = Some(path.clone());
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            return;
        };
        if value.get("version").and_then(Value::as_u64) != Some(1) {
            return;
        }
        let Some(sessions) = value.get("sessions").and_then(Value::as_object) else {
            return;
        };
        let mut instructions = self.instructions.lock().unwrap();
        for (id, instruction) in sessions {
            if let Some(instruction) = instruction.as_str().filter(|text| !text.is_empty()) {
                instructions.insert(id.clone(), instruction.to_string());
            }
        }
    }

    fn remember_instruction(&self, provider_session_id: &str, instruction: Option<&str>) {
        let Some(instruction) = instruction.filter(|text| !text.is_empty()) else {
            return;
        };
        {
            let mut instructions = self.instructions.lock().unwrap();
            if instructions.get(provider_session_id).map(String::as_str) == Some(instruction) {
                return;
            }
            instructions.insert(provider_session_id.to_string(), instruction.to_string());
        }
        let path = self.instruction_snapshot_path.lock().unwrap().clone();
        let Some(path) = path else {
            return;
        };
        let instructions = self.instructions.lock().unwrap();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        let payload = json!({
            "version": 1,
            "sessions": instructions.iter().collect::<BTreeMap<_, _>>(),
        });
        if std::fs::write(&temporary, payload.to_string()).is_ok() {
            let _ = std::fs::rename(&temporary, &path);
        }
    }

    pub async fn close(&self) {
        let _lifecycle = self.lifecycle.lock().await;
        let ids = self
            .sessions
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        futures_util::future::join_all(ids.iter().map(|id| self.unsubscribe_session(id))).await;
    }

    async fn open_session(
        &self,
        cwd: PathBuf,
        load: Option<&str>,
        permission_mode: Option<AiSessionPermissionMode>,
        model_selection: Option<AiSessionModelSelection>,
        reasoning_effort: Option<String>,
        appended_prompt: Option<String>,
    ) -> Result<OpenedSession, ProviderError> {
        let _lifecycle = self.lifecycle.lock().await;
        if let Some(id) = load {
            if let Some(binding) = self
                .sessions
                .lock()
                .unwrap()
                .get(id)
                .filter(|binding| !binding.connection.is_closed())
            {
                let state = binding.state.lock().unwrap();
                return Ok(OpenedSession {
                    id: id.into(),
                    model_selection: state.model_selection.clone(),
                    reasoning_effort: state.reasoning_effort.clone(),
                });
            }
            self.unsubscribe_session(id).await?;
        }
        let launch = (self.launch)(AcpLaunchInput {
            cwd: cwd.clone(),
            provider_session_id: load.map(ToString::to_string),
            model_selection: model_selection.clone(),
            reasoning_effort: reasoning_effort.clone(),
        })?;
        let cleanup_path = launch.cleanup_dir.clone();
        let cleanup_dir = Arc::new(Mutex::new(cleanup_path));
        let session_home = launch.session_home.clone();
        let state = Arc::new(Mutex::new(SessionState {
            replay: load.map(|id| (SessionId::from(id.to_owned()), AcpReplay::default())),
            ..Default::default()
        }));
        let update_state = state.clone();
        let permission_state = state.clone();
        let update_events = self.events.clone();
        let update_agent = self.agent.clone();
        let timeline = self.timeline.clone();
        let permission_events = self.events.clone();
        let connection = match AcpConnection::connect(
            &launch.executable,
            &launch.args,
            &cwd,
            &launch.env,
            move |notification| {
                update(
                    &update_state,
                    &update_events,
                    &timeline,
                    &update_agent,
                    notification,
                )
            },
            move |request| {
                let reply = request_permission(&permission_state, &permission_events, request);
                async move { reply?.await.ok() }
            },
        )
        .await
        {
            Ok(connection) => Arc::new(connection),
            Err(error) => {
                cleanup_launch_dir(&cleanup_dir).await;
                return Err(unavailable(error));
            }
        };
        self.load_session
            .store(connection.capabilities.load_session, Ordering::Relaxed);
        self.image_prompt.store(
            connection.capabilities.prompt_capabilities.image,
            Ordering::Relaxed,
        );
        enum Opened {
            New(RawSessionResponse),
            Load(RawSessionOptionsResponse),
        }
        let system_prompt_supported = connection
            .capabilities
            .session_capabilities
            .system_prompt
            .as_ref()
            .is_some();
        if appended_prompt.is_some() && !system_prompt_supported {
            connection.close().await;
            cleanup_launch_dir(&cleanup_dir).await;
            return Err(ProviderError::new(
                "AI_SESSION_STORY_CONTEXT_UNSUPPORTED",
                format!(
                    "{} does not advertise ACP sessionCapabilities.systemPrompt.",
                    self.agent
                ),
                409,
            ));
        }
        let system_prompt = appended_prompt
            .as_deref()
            .filter(|_| system_prompt_supported)
            .map(|text| SystemPrompt::new(vec![ContentBlock::Text(TextContent::new(text))]));
        let opened = tokio::time::timeout(Duration::from_secs(15), async {
            if let Some(id) = load {
                if !connection.capabilities.load_session {
                    return Err(unavailable("The Agent does not support ACP session/load."));
                }
                connection
                    .agent
                    .send_request(RawLoadSessionRequest {
                        session_id: id.to_string(),
                        cwd: cwd.clone(),
                        mcp_servers: Vec::new(),
                        system_prompt: system_prompt.clone(),
                    })
                    .block_task()
                    .await
                    .map(Opened::Load)
                    .map_err(unavailable)
            } else {
                connection
                    .agent
                    .send_request(RawNewSessionRequest {
                        cwd: cwd.clone(),
                        mcp_servers: Vec::new(),
                        system_prompt: system_prompt.clone(),
                    })
                    .block_task()
                    .await
                    .map(Opened::New)
                    .map_err(unavailable)
            }
        })
        .await
        .map_err(unavailable)
        .and_then(|result| result);
        let opened = match opened {
            Ok(opened) => opened,
            Err(error) => {
                connection.close().await;
                cleanup_launch_dir(&cleanup_dir).await;
                return Err(error);
            }
        };
        let (session_id, mut configuration, mut modes) = match opened {
            Opened::New(response) => {
                let configuration = normalize_session_response(&response);
                let modes = normalize_acp_session_modes(response.modes.as_ref());
                (response.session_id, configuration, modes)
            }
            Opened::Load(response) => (
                SessionId::from(
                    load.expect("session/load response requires a requested session")
                        .to_string(),
                ),
                normalize_acp_session_configuration(&json!({
                    "configOptions": response.config_options,
                    "models": response.models,
                })),
                normalize_acp_session_modes(response.modes.as_ref()),
            ),
        };
        let id = session_id.to_string();
        if id.is_empty() || id.trim() != id || id.chars().count() > 240 {
            connection.close().await;
            cleanup_launch_dir(&cleanup_dir).await;
            return Err(unavailable("Agent returned an invalid session ID"));
        }
        if self.sessions.lock().unwrap().contains_key(&id) {
            connection.close().await;
            cleanup_launch_dir(&cleanup_dir).await;
            return Err(unavailable("Agent returned an already active session ID"));
        }
        self.remember_instruction(&id, appended_prompt.as_deref());
        if configuration.options.is_empty() && configuration.legacy_models.is_none() {
            configuration = read_session_configuration(&connection, &session_id).await;
        }
        let mut applied_mode = None;
        if let Some(mode) = permission_mode {
            if let Err(error) =
                apply_permission_mode(&connection, &session_id, &mut modes, &self.agent, mode).await
            {
                connection.close().await;
                cleanup_launch_dir(&cleanup_dir).await;
                return Err(error);
            }
            applied_mode = Some(mode);
        }
        let mut applied_model = None;
        let mut applied_effort = None;
        if let Some(selection) = model_selection.as_ref() {
            if let Err(error) = apply_model_selection(
                &connection,
                &session_id,
                &mut configuration,
                &self.agent,
                selection,
            )
            .await
            {
                connection.close().await;
                cleanup_launch_dir(&cleanup_dir).await;
                return Err(error);
            }
            applied_model = Some(selection.clone());
        }
        if let Some(effort) = reasoning_effort.as_ref() {
            if let Err(error) =
                apply_reasoning_effort(&connection, &session_id, &mut configuration, effort).await
            {
                connection.close().await;
                cleanup_launch_dir(&cleanup_dir).await;
                return Err(error);
            }
            applied_effort = Some(effort.clone());
        }
        let replay = state.lock().unwrap().replay.take();
        if let Some((_, replay)) = replay {
            if let Err(error) = replay.reconcile(&self.timeline, &id) {
                connection.close().await;
                cleanup_launch_dir(&cleanup_dir).await;
                return Err(unavailable(error));
            }
        }
        {
            let mut state = state.lock().unwrap();
            state.id = Some(session_id);
            state.configuration = configuration;
            state.modes = modes;
            state.permission_mode = applied_mode;
            state.model_selection = applied_model.clone();
            state.reasoning_effort = applied_effort.clone();
        }
        let mut closed = connection.closed.clone();
        let events = self.events.clone();
        let provider_session_id = id.clone();
        let closing_state = state.clone();
        let closing_cleanup = cleanup_dir.clone();
        let closing_home = session_home.clone();
        tokio::spawn(async move {
            let _ = closed.changed().await;
            let done = closing_state
                .lock()
                .unwrap()
                .turn
                .as_ref()
                .map(|turn| turn.done.clone());
            if let Some(mut done) = done {
                let _ = done.wait_for(Option::is_some).await;
            }
            let _ = events.send(ProviderEvent::ProviderSessionLifecycle {
                provider_session_id: provider_session_id.clone(),
                disposition: "disconnected".into(),
            });
            if let Some(home) = closing_home.as_ref() {
                let _ = home.persist(&provider_session_id);
            }
            cleanup_launch_dir(&closing_cleanup).await;
        });
        self.sessions.lock().unwrap().insert(
            id.clone(),
            SessionBinding {
                state,
                connection,
                cleanup_dir,
                session_home,
            },
        );
        Ok(OpenedSession {
            id,
            model_selection: applied_model,
            reasoning_effort: applied_effort,
        })
    }
}

fn normalize_session_response(response: &RawSessionResponse) -> AcpSessionConfiguration {
    normalize_acp_session_configuration(&json!({
        "configOptions": response.config_options,
        "models": response.models,
    }))
}

fn normalize_config_options(options: Vec<SessionConfigOption>) -> AcpSessionConfiguration {
    normalize_acp_session_configuration(&json!({ "configOptions": options }))
}

async fn read_session_configuration(
    connection: &AcpConnection,
    session_id: &SessionId,
) -> AcpSessionConfiguration {
    match connection
        .agent
        .send_request(RawSessionOptionsRequest {
            session_id: session_id.to_string(),
        })
        .block_task()
        .await
    {
        Ok(response) => normalize_acp_session_configuration(&json!({
            "configOptions": response.config_options,
            "models": response.models,
        })),
        Err(_) => AcpSessionConfiguration::default(),
    }
}

async fn apply_model_selection(
    connection: &AcpConnection,
    session_id: &SessionId,
    configuration: &mut AcpSessionConfiguration,
    agent: &str,
    selection: &AiSessionModelSelection,
) -> Result<(), ProviderError> {
    let value = acp_model_value(agent, selection);
    if !configuration.model_value_selectable(&value) {
        return Err(ProviderError::new(
            "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
            "The selected model is not available in this ACP Agent session.",
            409,
        ));
    }
    if configuration.legacy_models.is_some() {
        connection
            .agent
            .send_request(RawSetModelRequest {
                session_id: session_id.to_string(),
                model_id: value.clone(),
            })
            .block_task()
            .await
            .map_err(|error| {
                ProviderError::new(
                    "AI_SESSION_MODEL_SELECTION_UNAVAILABLE",
                    format!("{agent}: {error}"),
                    409,
                )
            })?;
        if let Some(legacy) = configuration.legacy_models.as_mut() {
            legacy.current_model_id = value;
        }
        return Ok(());
    }
    let option = configuration.model_option().cloned().ok_or_else(|| {
        ProviderError::new(
            "AI_SESSION_MODEL_SELECTION_UNAVAILABLE",
            format!("{agent}: The Agent did not advertise a model configuration option."),
            409,
        )
    })?;
    let response = connection
        .agent
        .send_request(SetSessionConfigOptionRequest::new(
            session_id.clone(),
            option.id,
            value.as_str(),
        ))
        .block_task()
        .await
        .map_err(|error| {
            ProviderError::new(
                "AI_SESSION_MODEL_SELECTION_UNAVAILABLE",
                format!("{agent}: {error}"),
                409,
            )
        })?;
    *configuration = normalize_config_options(response.config_options);
    Ok(())
}

async fn apply_permission_mode(
    connection: &AcpConnection,
    session_id: &SessionId,
    modes: &mut Option<AcpSessionModes>,
    agent: &str,
    mode: AiSessionPermissionMode,
) -> Result<(), ProviderError> {
    let target = acp_permission_mode_id(agent, mode).ok_or_else(|| {
        ProviderError::new(
            "AI_SESSION_PERMISSION_MODE_UNAVAILABLE",
            format!("{agent} does not support TaskHandoff permission modes."),
            409,
        )
    })?;
    let modes = modes.as_mut().ok_or_else(|| {
        ProviderError::new(
            "AI_SESSION_PERMISSION_MODE_UNAVAILABLE",
            format!("{agent} does not advertise ACP session modes."),
            409,
        )
    })?;
    if !modes
        .available_modes
        .iter()
        .any(|candidate| candidate.id == target)
    {
        return Err(ProviderError::new(
            "AI_SESSION_PERMISSION_MODE_UNAVAILABLE",
            format!("{agent} does not offer the {mode:?} permission mode."),
            409,
        ));
    }
    if modes.current_mode_id == target {
        return Ok(());
    }
    connection
        .agent
        .send_request(SetSessionModeRequest::new(
            session_id.clone(),
            target.to_string(),
        ))
        .block_task()
        .await
        .map_err(|error| {
            ProviderError::new(
                "AI_SESSION_PERMISSION_MODE_UNAVAILABLE",
                format!("{agent}: {error}"),
                409,
            )
        })?;
    modes.current_mode_id = target.to_string();
    Ok(())
}

async fn apply_reasoning_effort(
    connection: &AcpConnection,
    session_id: &SessionId,
    configuration: &mut AcpSessionConfiguration,
    effort: &str,
) -> Result<(), ProviderError> {
    let value = configuration
        .reasoning_effort_value(effort)
        .ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_REASONING_EFFORT_UNAVAILABLE",
                "The ACP Agent does not offer that reasoning effort.",
                409,
            )
        })?;
    let option = configuration.reasoning_option().cloned().ok_or_else(|| {
        ProviderError::new(
            "AI_SESSION_REASONING_EFFORT_UNAVAILABLE",
            "The ACP Agent does not expose reasoning effort.",
            409,
        )
    })?;
    let response = connection
        .agent
        .send_request(SetSessionConfigOptionRequest::new(
            session_id.clone(),
            option.id,
            value.as_str(),
        ))
        .block_task()
        .await
        .map_err(|error| {
            ProviderError::new(
                "AI_SESSION_REASONING_EFFORT_UNAVAILABLE",
                error.to_string(),
                409,
            )
        })?;
    *configuration = normalize_config_options(response.config_options);
    Ok(())
}

async fn cleanup_launch_dir(directory: &Arc<Mutex<Option<PathBuf>>>) {
    let path = directory
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(path) = path {
        let _ = tokio::fs::remove_dir_all(path).await;
    }
}

fn prepare_prompt_content(
    input: &ProviderMessage,
    image_supported: bool,
) -> Result<Vec<ContentBlock>, ProviderError> {
    let mut content = Vec::new();
    let mut path_references: Vec<(AiSessionAttachmentKind, String)> = Vec::new();
    let text = input.message.trim();
    if !text.is_empty() {
        content.push(ContentBlock::Text(TextContent::new(text)));
    }
    for attachment in &input.attachments {
        let uri = Url::from_file_path(&attachment.path)
            .map_err(|_| {
                ProviderError::new(
                    "AI_SESSION_ATTACHMENT_INVALID_PATH",
                    format!(
                        "Attachment path cannot be represented as a file URI: {}",
                        attachment.path.display()
                    ),
                    400,
                )
            })?
            .to_string();
        if attachment.meta.kind == AiSessionAttachmentKind::Image && image_supported {
            let data = std::fs::read(&attachment.path).map_err(|error| {
                ProviderError::new(
                    "AI_SESSION_ATTACHMENT_CONTENT_MISSING",
                    format!("Attachment content is unavailable: {error}"),
                    400,
                )
            })?;
            content.push(ContentBlock::Image(
                ImageContent::new(STANDARD.encode(data), attachment.meta.mime.clone()).uri(uri),
            ));
            continue;
        }
        content.push(ContentBlock::ResourceLink(
            ResourceLink::new(attachment.meta.name.clone(), uri)
                .mime_type(attachment.meta.mime.clone())
                .size(attachment.meta.size as i64),
        ));
        path_references.push((attachment.meta.kind, attachment.path.display().to_string()));
    }
    if !path_references.is_empty() {
        let image_count = path_references
            .iter()
            .filter(|(kind, _)| *kind == AiSessionAttachmentKind::Image)
            .count();
        let file_count = path_references
            .iter()
            .filter(|(kind, _)| *kind == AiSessionAttachmentKind::File)
            .count();
        let (mut image_index, mut file_index) = (0, 0);
        let lines = path_references
            .iter()
            .map(|(kind, path)| {
                let (label, count, index) = if *kind == AiSessionAttachmentKind::Image {
                    image_index += 1;
                    ("图片", image_count, image_index)
                } else {
                    file_index += 1;
                    ("文件", file_count, file_index)
                };
                format!(
                    "{label}{}路径：{path}",
                    if count > 1 {
                        index.to_string()
                    } else {
                        String::new()
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let prompt_text = [text, lines.as_str()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        match content.first_mut() {
            Some(ContentBlock::Text(value)) => value.text = prompt_text,
            _ => content.insert(0, ContentBlock::Text(TextContent::new(prompt_text))),
        }
    }
    if content.is_empty() {
        return Err(ProviderError::new(
            "AI_SESSION_MESSAGE_EMPTY",
            "A message, attachment, or reference is required.",
            400,
        ));
    }
    Ok(content)
}

fn copy_directory(source: &Path, target: &Path) -> io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &destination)?;
        }
    }
    Ok(())
}

#[async_trait]
impl AiSessionControlProvider for AcpSessionProvider {
    fn agent(&self) -> &str {
        &self.agent
    }

    fn capability(&self) -> AiSessionProviderCapability {
        AiSessionProviderCapability {
            agent: self.agent.clone(),
            actions: AiSessionProviderActions {
                create: true,
                send: true,
                queue: true,
                interrupt: true,
                rename: true,
                approval_decisions: vec!["allow".into(), "deny".into()],
                history_resume: Some(self.load_session.load(Ordering::Relaxed)),
                ..Default::default()
            },
            permission_modes: acp_permission_modes(&self.agent),
            timeline: AiSessionProviderTimelineCapabilities {
                session_read: true,
                turn_read: true,
                live_items: true,
            },
            model_selection: Some(AiSessionModelSelectionCapabilities {
                select_model_at_create: true,
                select_provider_at_create: true,
                select_model_at_resume: true,
                select_provider_at_resume: true,
                switch_model_within_provider: true,
                switch_provider_during_session: self.agent != "gemini",
                stable_identity: true,
            }),
            reasoning_effort: Some(AiSessionReasoningEffortCapabilities {
                select_at_create: self.agent != "gemini",
                update_during_session: self.agent != "gemini",
            }),
            hierarchy: None,
        }
    }

    async fn rename_session(
        &self,
        _session: &AiSession,
        _title: &str,
    ) -> Result<(), ProviderError> {
        // Rename is an adapter-local display label. ACP has no portable
        // session-title method, and the runtime commits the new title after
        // this provider acknowledgement.
        Ok(())
    }

    fn close_detaches_provider_session(&self) -> bool {
        true
    }

    fn session_actions_for(&self, session: &AiSession, status: Option<&str>) -> serde_json::Value {
        let sessions = self.sessions.lock().unwrap();
        let binding = session
            .provider_session_id
            .as_deref()
            .and_then(|id| sessions.get(id));
        let connected = binding.is_some_and(|binding| !binding.connection.is_closed());
        let state = binding
            .filter(|_| connected)
            .map(|binding| binding.state.lock().unwrap());
        let approval = state
            .as_ref()
            .and_then(|state| state.turn.as_ref())
            .and_then(|turn| turn.approval.as_ref());
        let mut actions = serde_json::json!({
            "send": connected,
            "interrupt": connected && status.is_some_and(|status| matches!(status, "running" | "waiting")),
            "approval": approval.is_some(), "close": true, "openApp": false, "rename": true, "fork": false,
        });
        if let Some(approval) = approval {
            let decisions = [
                (PermissionOptionKind::AllowOnce, "allow"),
                (PermissionOptionKind::RejectOnce, "deny"),
            ]
            .into_iter()
            .filter_map(|(kind, decision)| {
                approval
                    .request
                    .options
                    .iter()
                    .any(|option| option.kind == kind)
                    .then_some(decision)
            })
            .collect::<Vec<_>>();
            actions["approvalRequest"] =
                serde_json::json!({ "id": approval.id, "decisions": decisions });
        }
        actions
    }

    fn interrupt_preserves_turn(&self) -> bool {
        true
    }

    fn subscribe_events(&self) -> Option<broadcast::Receiver<ProviderEvent>> {
        Some(self.events.subscribe())
    }

    async fn create_session(
        &self,
        input: ProviderCreateInput,
    ) -> Result<ProviderCreateResult, ProviderError> {
        let opened = self
            .open_session(
                input.cwd.clone(),
                None,
                input.permission_mode,
                input.model_selection,
                input.reasoning_effort,
                input.appended_prompt,
            )
            .await?;
        Ok(ProviderCreateResult {
            provider_session_id: opened.id,
            cwd: input.cwd,
            model_selection: opened.model_selection,
            reasoning_effort: opened.reasoning_effort,
        })
    }

    async fn resume_session(
        &self,
        session: &AiSession,
    ) -> Result<ProviderResumeResult, ProviderError> {
        let remote_id = session
            .provider_session_id
            .as_deref()
            .ok_or_else(disconnected)?;
        let cwd = session
            .cwd
            .as_ref()
            .filter(|cwd| !cwd.is_empty())
            .ok_or_else(disconnected)?;
        let model_selection = session
            .model_selection
            .clone()
            .and_then(|value| serde_json::from_value(value).ok());
        let appended_prompt = self.instructions.lock().unwrap().get(remote_id).cloned();
        let opened = self
            .open_session(
                PathBuf::from(cwd),
                Some(remote_id),
                None,
                model_selection,
                session.reasoning_effort.clone(),
                appended_prompt,
            )
            .await?;
        Ok(ProviderResumeResult {
            model_selection: opened.model_selection,
            reasoning_effort: opened.reasoning_effort,
        })
    }

    async fn start_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        let prompt = prepare_prompt_content(&input, self.image_prompt.load(Ordering::Relaxed))?;
        let permission_mode = input.permission_mode;
        let remote_id = session
            .provider_session_id
            .as_deref()
            .ok_or_else(disconnected)?;
        let (state, connection, session_id) = {
            let sessions = self.sessions.lock().unwrap();
            let binding = sessions.get(remote_id).ok_or_else(disconnected)?;
            if binding.connection.is_closed() {
                return Err(disconnected());
            }
            let mut state = binding.state.lock().unwrap();
            if state.turn.is_some() || state.starting {
                return Err(ProviderError::conflict(
                    "AI_SESSION_TURN_IN_PROGRESS",
                    "A turn is already in progress.",
                ));
            }
            let session_id = state.id.clone().ok_or_else(disconnected)?;
            state.starting = true;
            (
                binding.state.clone(),
                binding.connection.clone(),
                session_id,
            )
        };
        if let Some(mode) = permission_mode {
            let (mut modes, current) = {
                let state = state.lock().unwrap();
                (state.modes.clone(), state.permission_mode)
            };
            if current != Some(mode) {
                if let Err(error) =
                    apply_permission_mode(&connection, &session_id, &mut modes, &self.agent, mode)
                        .await
                {
                    state.lock().unwrap().starting = false;
                    return Err(error);
                }
                let mut state = state.lock().unwrap();
                if state.retired {
                    state.starting = false;
                    return Err(disconnected());
                }
                state.modes = modes;
                state.permission_mode = Some(mode);
            }
        }
        let turn_id = input
            .message_id
            .unwrap_or_else(|| format!("msg_{}", uuid::Uuid::new_v4()));
        let (done, completed) = watch::channel(None);
        let (start, accepted) = oneshot::channel();
        let mut state_guard = state.lock().unwrap();
        if state_guard.turn.is_some() || state_guard.retired {
            state_guard.starting = false;
            return Err(if state_guard.retired {
                disconnected()
            } else {
                ProviderError::conflict(
                    "AI_SESSION_TURN_IN_PROGRESS",
                    "A turn is already in progress.",
                )
            });
        }
        state_guard.turn = Some(Turn {
            id: turn_id.clone(),
            text: String::new(),
            segment: String::new(),
            item_id: item_id(&turn_id, "assistant", 0),
            sequence: 0,
            tools: HashMap::new(),
            prompt: input.message.clone(),
            attachments: input.user_message_attachments.clone(),
            approval: None,
            start: Some(start),
            done: completed,
            cancelling: false,
        });
        state_guard.starting = false;
        drop(state_guard);
        let agent = connection.agent.clone();
        let mut closed = connection.closed.clone();
        let remote_id = remote_id.to_string();
        let events = self.events.clone();
        let timeline = self.timeline.clone();
        tokio::spawn(async move {
            if accepted.await != Ok(true) {
                state.lock().unwrap().turn.take();
                return;
            }
            let response = agent
                .send_request(PromptRequest::new(session_id, prompt))
                .block_task();
            let result = tokio::select! {
                biased;
                result = response => result.map_err(|error| error.to_string()),
                _ = closed.changed() => Err("The ACP Agent disconnected.".into()),
            };
            let mut state = state.lock().unwrap();
            let Some(mut turn) = state.turn.take() else {
                return;
            };
            cancel_approval(&mut turn);
            if state.retired {
                return;
            }
            finish_segment(&timeline, &events, &remote_id, &mut turn);
            let received_outcome = result.is_ok();
            let (status, error) = match result {
                Ok(result) if result.stop_reason == StopReason::Refusal => {
                    ("failed", Some("The ACP Agent refused the prompt.".into()))
                }
                Ok(result) if result.stop_reason == StopReason::Cancelled => ("interrupted", None),
                Ok(_) => ("completed", None),
                Err(error) => ("failed", Some(error.chars().take(4000).collect())),
            };
            if !turn.text.is_empty() {
                let _ = events.send(ProviderEvent::AgentMessageCompleted {
                    provider_session_id: remote_id.clone(),
                    turn_id: turn.id.clone(),
                    item_id: turn.item_id.clone(),
                    text: turn.text,
                    observed_at: None,
                });
            }
            let _ = events.send(ProviderEvent::TurnCompleted {
                provider_session_id: remote_id,
                turn_id: Some(turn.id),
                status: Some(status.into()),
                error,
                completed_at: None,
            });
            let _ = done.send(Some(received_outcome));
        });
        Ok(ProviderAction {
            turn_id: Some(turn_id.clone()),
            provider_turn_id: Some(turn_id),
            ..ProviderAction::simple("send")
        })
    }

    fn message_acknowledged(&self, session: &AiSession, action: &ProviderAction, accepted: bool) {
        let Some(remote_id) = session.provider_session_id.as_deref() else {
            return;
        };
        let sessions = self.sessions.lock().unwrap();
        let Some(binding) = sessions.get(remote_id) else {
            return;
        };
        let mut state = binding.state.lock().unwrap();
        if let Some(turn) = state
            .turn
            .as_mut()
            .filter(|turn| action.turn_id.as_ref() == Some(&turn.id))
        {
            if accepted {
                publish_item(
                    &self.timeline,
                    &self.events,
                    remote_id,
                    AiSessionTimelineItem::UserMessage {
                        id: turn.id.clone(),
                        turn_id: turn.id.clone(),
                        text: turn.prompt.clone(),
                        attachments: (!turn.attachments.is_empty())
                            .then(|| turn.attachments.clone()),
                    },
                );
            }
            if let Some(start) = turn.start.take() {
                let _ = start.send(accepted);
            }
        }
    }

    async fn interrupt(&self, session: &AiSession) -> Result<ProviderAction, ProviderError> {
        let remote_id = session
            .provider_session_id
            .as_deref()
            .ok_or_else(disconnected)?;
        let (turn_id, mut done) = {
            let sessions = self.sessions.lock().unwrap();
            let binding = sessions.get(remote_id).ok_or_else(disconnected)?;
            let mut state = binding.state.lock().unwrap();
            let session_id = state.id.clone().ok_or_else(disconnected)?;
            let Some(turn) = state.turn.as_mut() else {
                return Ok(ProviderAction::simple("interrupt"));
            };
            if !turn.cancelling {
                turn.cancelling = true;
                cancel_approval(turn);
                binding
                    .connection
                    .agent
                    .send_notification(CancelNotification::new(session_id))
                    .map_err(unavailable)?;
            }
            (turn.id.clone(), turn.done.clone())
        };
        let outcome = tokio::time::timeout(Duration::from_secs(10), async {
            done.wait_for(Option::is_some)
                .await
                .ok()
                .and_then(|value| *value)
        })
        .await;
        match outcome {
            Ok(Some(true)) => {}
            Ok(_) => {
                return Err(unavailable(
                    "The ACP prompt ended without a confirmed outcome.",
                ))
            }
            Err(_) => {
                if let Some(binding) = self.sessions.lock().unwrap().get(remote_id) {
                    let mut state = binding.state.lock().unwrap();
                    if state.turn.as_ref().is_some_and(|turn| turn.id == turn_id) {
                        let mut turn = state.turn.take().unwrap();
                        cancel_approval(&mut turn);
                        finish_segment(&self.timeline, &self.events, remote_id, &mut turn);
                        state.retired = true;
                        let _ = self.events.send(ProviderEvent::TurnCompleted {
                            provider_session_id: remote_id.into(),
                            turn_id: Some(turn_id.clone()),
                            status: Some("failed".into()),
                            error: Some("The ACP Agent did not confirm cancellation.".into()),
                            completed_at: None,
                        });
                    }
                }
                self.unsubscribe_session(remote_id).await?;
                return Err(ProviderError::new(
                    "AI_SESSION_CANCEL_TIMEOUT",
                    "The ACP Agent did not confirm cancellation.",
                    504,
                ));
            }
        }
        Ok(ProviderAction {
            turn_id: Some(turn_id.clone()),
            provider_turn_id: Some(turn_id),
            ..ProviderAction::simple("interrupt")
        })
    }

    async fn resolve_approval_with_request(
        &self,
        session: &AiSession,
        decision: &str,
        approval_request_id: Option<&str>,
        observe: &ProviderApprovalObserver<'_>,
    ) -> Result<ProviderAction, ProviderError> {
        let remote_id = session
            .provider_session_id
            .as_deref()
            .ok_or_else(disconnected)?;
        let choice = match decision {
            "allow" => PermissionOptionKind::AllowOnce,
            "deny" => PermissionOptionKind::RejectOnce,
            _ => return Err(unsupported_approval()),
        };
        let (approval, option_id) = {
            let sessions = self.sessions.lock().unwrap();
            let binding = sessions.get(remote_id).ok_or_else(disconnected)?;
            let mut state = binding.state.lock().unwrap();
            let turn = state.turn.as_mut().ok_or_else(missing_approval)?;
            let approval = turn.approval.as_ref().ok_or_else(missing_approval)?;
            if approval_request_id != Some(approval.id.as_str()) {
                return Err(ProviderError::conflict(
                    "AI_SESSION_APPROVAL_STALE",
                    "The approval is no longer current.",
                ));
            }
            let option_id = approval
                .request
                .options
                .iter()
                .find(|option| option.kind == choice)
                .map(|option| option.option_id.clone())
                .ok_or_else(unsupported_approval)?;
            (turn.approval.take().unwrap(), option_id)
        };
        observe(ProviderApprovalUpdate::Resolved).await?;
        approval
            .response
            .send(RequestPermissionResponse::new(
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id)),
            ))
            .map_err(|_| missing_approval())?;
        Ok(ProviderAction {
            decision: Some(decision.into()),
            ..ProviderAction::simple("approval")
        })
    }

    async fn update_model_selection(
        &self,
        session: &AiSession,
        selection: &AiSessionModelSelection,
    ) -> Result<Option<AiSessionModelSelection>, ProviderError> {
        let remote_id = session
            .provider_session_id
            .as_deref()
            .ok_or_else(disconnected)?;
        let (session_id, mut configuration) = {
            let sessions = self.sessions.lock().unwrap();
            let binding = sessions.get(remote_id).ok_or_else(disconnected)?;
            let state = binding.state.lock().unwrap();
            if state.turn.is_some() {
                return Err(ProviderError::conflict(
                    "AI_SESSION_MODEL_SELECTION_CONFLICT",
                    "The model cannot be changed while a turn is active.",
                ));
            }
            if self.agent == "gemini"
                && state
                    .model_selection
                    .as_ref()
                    .is_some_and(|previous| previous.model_entity_id != selection.model_entity_id)
            {
                return Err(ProviderError::new(
                    "AI_SESSION_MODEL_SELECTION_UNSUPPORTED",
                    "Gemini requires a new session to change the configured model provider.",
                    409,
                ));
            }
            (
                state.id.clone().ok_or_else(disconnected)?,
                state.configuration.clone(),
            )
        };
        let binding = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .get(remote_id)
                .ok_or_else(disconnected)?
                .connection
                .clone()
        };
        apply_model_selection(
            &binding,
            &session_id,
            &mut configuration,
            &self.agent,
            selection,
        )
        .await?;
        if let Some(binding) = self.sessions.lock().unwrap().get(remote_id) {
            let mut state = binding.state.lock().unwrap();
            state.configuration = configuration;
            state.model_selection = Some(selection.clone());
        }
        Ok(Some(selection.clone()))
    }

    async fn update_reasoning_effort(
        &self,
        session: &AiSession,
        reasoning_effort: &str,
    ) -> Result<Option<String>, ProviderError> {
        let remote_id = session
            .provider_session_id
            .as_deref()
            .ok_or_else(disconnected)?;
        let (session_id, mut configuration) = {
            let sessions = self.sessions.lock().unwrap();
            let binding = sessions.get(remote_id).ok_or_else(disconnected)?;
            let state = binding.state.lock().unwrap();
            if state.turn.is_some() {
                return Err(ProviderError::conflict(
                    "AI_SESSION_REASONING_EFFORT_CONFLICT",
                    "Reasoning effort cannot be changed while a turn is active.",
                ));
            }
            (
                state.id.clone().ok_or_else(disconnected)?,
                state.configuration.clone(),
            )
        };
        let binding = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .get(remote_id)
                .ok_or_else(disconnected)?
                .connection
                .clone()
        };
        apply_reasoning_effort(&binding, &session_id, &mut configuration, reasoning_effort).await?;
        if let Some(binding) = self.sessions.lock().unwrap().get(remote_id) {
            let mut state = binding.state.lock().unwrap();
            state.configuration = configuration;
            state.reasoning_effort = Some(reasoning_effort.to_string());
        }
        Ok(Some(reasoning_effort.to_string()))
    }

    async fn unsubscribe_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        let binding = {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(binding) = sessions.get(provider_session_id) {
                let mut state = binding.state.lock().unwrap();
                state.retired = true;
                if let Some(turn) = state.turn.as_mut() {
                    cancel_approval(turn);
                    turn.start.take();
                }
            }
            sessions.remove(provider_session_id)
        };
        if let Some(binding) = binding {
            binding.connection.close().await;
            if let Some(home) = binding.session_home.as_ref() {
                let _ = home.persist(provider_session_id);
            }
            cleanup_launch_dir(&binding.cleanup_dir).await;
        }
        Ok(())
    }

    async fn timeline(&self, session: &AiSession) -> Result<AiSessionTimeline, ProviderError> {
        let provider_session_id = session
            .provider_session_id
            .clone()
            .ok_or_else(disconnected)?;
        Ok(AiSessionTimeline {
            session_id: session.id.clone(),
            items: self.timeline.items(&provider_session_id),
            provider_session_id,
            generated_at: crate::now_iso(),
        })
    }

    async fn turn_timeline(
        &self,
        session: &AiSession,
        turn_id: &str,
    ) -> Result<AiSessionTurnTimeline, ProviderError> {
        let timeline = self.timeline(session).await?;
        Ok(AiSessionTurnTimeline {
            session_id: timeline.session_id,
            turn_id: turn_id.into(),
            generated_at: timeline.generated_at,
            items: timeline
                .items
                .into_iter()
                .filter(|item| item.turn_id() == turn_id)
                .collect(),
        })
    }
}

fn update(
    state: &Mutex<SessionState>,
    events: &broadcast::Sender<ProviderEvent>,
    timeline: &AiSessionTimelineStore,
    agent: &str,
    notification: SessionNotification,
) {
    let mut state = state.lock().unwrap();
    if let Some((id, replay)) = state.replay.as_mut() {
        if *id == notification.session_id {
            replay.update(notification.update);
        }
        return;
    }
    if state.retired || state.id.as_ref() != Some(&notification.session_id) {
        return;
    }
    if let SessionUpdate::ConfigOptionUpdate(update) = &notification.update {
        let legacy_models = state.configuration.legacy_models.clone();
        state.configuration = normalize_acp_session_configuration(&json!({
            "configOptions": update.config_options,
        }));
        state.configuration.legacy_models = legacy_models;
        return;
    }
    if let SessionUpdate::CurrentModeUpdate(update) = &notification.update {
        if let Some(modes) = state.modes.as_mut() {
            modes.current_mode_id = update.current_mode_id.to_string();
        }
        state.permission_mode =
            acp_permission_mode_for_id(agent, update.current_mode_id.0.as_ref());
        return;
    }
    let Some(turn) = state.turn.as_mut() else {
        return;
    };
    let remote_id = notification.session_id.to_string();
    match notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            if let ContentBlock::Text(content) = chunk.content {
                if turn.segment.is_empty() && !turn.text.is_empty() {
                    turn.sequence += 1;
                    turn.item_id = item_id(&turn.id, "assistant", turn.sequence);
                }
                turn.text.push_str(&content.text);
                turn.segment.push_str(&content.text);
                let _ = events.send(ProviderEvent::AgentMessageDelta {
                    provider_session_id: remote_id,
                    turn_id: turn.id.clone(),
                    item_id: turn.item_id.clone(),
                    delta: content.text,
                });
            }
        }
        SessionUpdate::ToolCall(call) => {
            project_tool(timeline, events, &remote_id, turn, call.into())
        }
        SessionUpdate::ToolCallUpdate(update) => {
            project_tool(timeline, events, &remote_id, turn, update)
        }
        _ => {}
    }
}

fn item_id(turn_id: &str, kind: &str, sequence: usize) -> String {
    format!(
        "{}:{kind}:{sequence}",
        turn_id.chars().take(210).collect::<String>()
    )
}

#[derive(Default)]
struct AcpReplay {
    turns: Vec<ReplayTurn>,
    size: usize,
    invalid: bool,
}

#[derive(Default)]
struct ReplayTurn {
    user: String,
    assistant: String,
    responding: bool,
    has_tools: bool,
}

impl AcpReplay {
    fn update(&mut self, update: SessionUpdate) {
        if self.invalid {
            return;
        }
        let user = matches!(&update, SessionUpdate::UserMessageChunk(_));
        let chunk = match update {
            SessionUpdate::UserMessageChunk(chunk) | SessionUpdate::AgentMessageChunk(chunk) => {
                chunk
            }
            SessionUpdate::ToolCall(_) | SessionUpdate::ToolCallUpdate(_) => {
                if let Some(turn) = self.turns.last_mut() {
                    turn.responding = true;
                    turn.has_tools = true;
                }
                return;
            }
            _ => return,
        };
        let ContentBlock::Text(text) = chunk.content else {
            self.invalid = true;
            return;
        };
        self.size += text.text.encode_utf16().count();
        if self.size > 4_000_000 {
            self.invalid = true;
            return;
        }
        if user {
            if self.turns.last().is_none_or(|turn| turn.responding) {
                self.turns.push(ReplayTurn::default());
            }
            self.turns.last_mut().unwrap().user.push_str(&text.text);
        } else if let Some(turn) = self.turns.last_mut() {
            turn.assistant.push_str(&text.text);
            turn.responding = true;
        } else {
            self.invalid = true;
        }
    }

    fn reconcile(self, store: &AiSessionTimelineStore, id: &str) -> std::io::Result<()> {
        if self.invalid || self.turns.is_empty() {
            return Ok(());
        }
        let items = store.items(id);
        let users = items
            .iter()
            .filter_map(|item| match item {
                AiSessionTimelineItem::UserMessage { text, .. } => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>();
        if users.len() != self.turns.len()
            || users
                .iter()
                .zip(&self.turns)
                .any(|(text, turn)| **text != turn.user)
        {
            return Ok(());
        }
        let occupied = items
            .iter()
            .filter(|item| !matches!(item, AiSessionTimelineItem::UserMessage { .. }))
            .map(|item| item.turn_id().to_owned())
            .collect::<std::collections::HashSet<_>>();
        let mut replay = self.turns.into_iter();
        let mut reconciled = Vec::new();
        let mut changed = false;
        for item in items {
            let restored = if let AiSessionTimelineItem::UserMessage { turn_id, .. } = &item {
                let turn = replay.next().unwrap();
                if !turn.has_tools && !turn.assistant.is_empty() && !occupied.contains(turn_id) {
                    Some(AiSessionTimelineItem::AiMessage {
                        id: item_id(turn_id, "assistant", 0),
                        turn_id: turn_id.clone(),
                        text: turn.assistant,
                    })
                } else {
                    None
                }
            } else {
                None
            };
            reconciled.push(item);
            if let Some(restored) = restored {
                changed = true;
                reconciled.push(restored);
            }
        }
        if changed {
            store.replace_items(id, reconciled)?;
        }
        Ok(())
    }
}

fn publish_item(
    timeline: &AiSessionTimelineStore,
    events: &broadcast::Sender<ProviderEvent>,
    remote_id: &str,
    item: AiSessionTimelineItem,
) {
    if let Err(error) = timeline.upsert(remote_id, item.clone()) {
        tracing::warn!(%error, "Could not persist ACP Timeline item");
    }
    let _ = events.send(ProviderEvent::TimelineItem {
        provider_session_id: remote_id.into(),
        item,
    });
}

fn finish_segment(
    timeline: &AiSessionTimelineStore,
    events: &broadcast::Sender<ProviderEvent>,
    remote_id: &str,
    turn: &mut Turn,
) {
    if turn.segment.is_empty() {
        return;
    }
    publish_item(
        timeline,
        events,
        remote_id,
        AiSessionTimelineItem::AiMessage {
            id: turn.item_id.clone(),
            turn_id: turn.id.clone(),
            text: std::mem::take(&mut turn.segment),
        },
    );
}

fn project_tool(
    timeline: &AiSessionTimelineStore,
    events: &broadcast::Sender<ProviderEvent>,
    remote_id: &str,
    turn: &mut Turn,
    update: ToolCallUpdate,
) {
    finish_segment(timeline, events, remote_id, turn);
    let key = update.tool_call_id.to_string();
    let mut snapshot = turn.tools.remove(&key).unwrap_or_else(|| {
        turn.sequence += 1;
        AcpToolSnapshot::new(item_id(&turn.id, "tool", turn.sequence), turn.id.clone())
    });
    snapshot.apply(update);
    let item = snapshot.activity();
    turn.tools.insert(key, snapshot);
    publish_item(timeline, events, remote_id, item);
}

fn request_permission(
    state: &Mutex<SessionState>,
    events: &broadcast::Sender<ProviderEvent>,
    request: RequestPermissionRequest,
) -> Option<oneshot::Receiver<RequestPermissionResponse>> {
    let mut state = state.lock().unwrap();
    if state.retired || state.id.as_ref() != Some(&request.session_id) {
        return None;
    }
    let turn = state.turn.as_mut()?;
    if turn.cancelling
        || turn.approval.is_some()
        || !request.options.iter().any(|option| {
            matches!(
                option.kind,
                PermissionOptionKind::AllowOnce | PermissionOptionKind::RejectOnce
            )
        })
    {
        return None;
    }
    let (response, receive) = oneshot::channel();
    let event = ProviderEvent::ApprovalRequested {
        provider_session_id: request.session_id.to_string(),
        turn_id: Some(turn.id.clone()),
        summary: request
            .tool_call
            .fields
            .title
            .as_deref()
            .unwrap_or("ACP permission request")
            .chars()
            .take(1000)
            .collect(),
        kind: "permission".into(),
        item_id: None,
    };
    turn.approval = Some(PendingApproval {
        id: uuid::Uuid::new_v4().to_string(),
        request,
        response,
    });
    let _ = events.send(event);
    Some(receive)
}

fn cancel_approval(turn: &mut Turn) {
    if let Some(approval) = turn.approval.take() {
        let _ = approval.response.send(RequestPermissionResponse::new(
            RequestPermissionOutcome::Cancelled,
        ));
    }
}

fn unavailable(error: impl std::fmt::Display) -> ProviderError {
    ProviderError::new("AI_SESSION_PROVIDER_UNAVAILABLE", error.to_string(), 409)
}

fn disconnected() -> ProviderError {
    unavailable("The ACP session is not connected.")
}

fn missing_approval() -> ProviderError {
    ProviderError::new(
        "AI_SESSION_APPROVAL_NOT_FOUND",
        "No ACP approval is pending.",
        404,
    )
}

fn unsupported_approval() -> ProviderError {
    ProviderError::new(
        "AI_SESSION_APPROVAL_UNSUPPORTED",
        "The Agent did not offer that decision.",
        409,
    )
}

#[cfg(test)]
mod story_prompt_tests {
    use super::*;
    use crate::{ProviderCreateInput, ProviderMessage};

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap()
            .join("test/fixtures/fake-acp-story-agent.mjs")
    }

    fn parity() -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap()
            .join("test/fixtures/story-context-provider-parity.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn provider(
        root: &Path,
        capture: &Path,
        env: BTreeMap<String, String>,
        snapshot: bool,
    ) -> AcpSessionProvider {
        let fixture = fixture();
        let capture = capture.to_path_buf();
        let provider = AcpSessionProvider::new(
            "gemini",
            move |_input| {
                Ok(AcpLaunch {
                    executable: PathBuf::from("node"),
                    args: vec![fixture.to_string_lossy().into_owned()],
                    env: env
                        .clone()
                        .into_iter()
                        .chain(BTreeMap::from([
                            ("PATH".to_string(), std::env::var("PATH").unwrap()),
                            (
                                "FAKE_ACP_CAPTURE".to_string(),
                                capture.to_string_lossy().into_owned(),
                            ),
                        ]))
                        .collect(),
                    cleanup_dir: None,
                    session_home: None,
                })
            },
            AiSessionTimelineStore::from_directory(root.join("timeline")),
            true,
        );
        if snapshot {
            provider.set_story_instruction_snapshot_path(root.join("story-instructions.json"));
        }
        provider
    }

    fn captured(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn create_input(cwd: &Path, appended_prompt: Option<&str>) -> ProviderCreateInput {
        ProviderCreateInput {
            cwd: cwd.to_path_buf(),
            runtime_workspace_roots: Vec::new(),
            permission_mode: None,
            model_selection: None,
            reasoning_effort: None,
            story_agent_tools: None,
            appended_prompt: appended_prompt.map(ToString::to_string),
        }
    }

    fn session(provider_session_id: String, cwd: &Path) -> AiSession {
        AiSession {
            id: "ses_0000000000001".to_string(),
            agent: "gemini".to_string(),
            creation_source: "ai-session".to_string(),
            app_session_id: None,
            app_id: None,
            provider_session_id: Some(provider_session_id),
            lineage: None,
            provider_meta: None,
            model_selection: None,
            reasoning_effort: None,
            story_id: None,
            app_binding_keys: None,
            actions: None,
            active_turn_id: Some("turn-1".to_string()),
            title: None,
            cwd: Some(cwd.to_string_lossy().into_owned()),
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
            goal: None,
            transcript_path: None,
            transcript_size: None,
            started_at: "2026-11-02T00:00:00.000Z".to_string(),
            updated_at: "2026-11-02T00:00:00.000Z".to_string(),
            completed_at: None,
            error: None,
            counters: Default::default(),
            queue: Default::default(),
            next_input_suggestion: None,
            unread: false,
        }
    }

    #[tokio::test]
    async fn acp_creates_sessions_with_a_capability_gated_system_prompt() {
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("capture.jsonl");
        let provider = provider(root.path(), &capture, BTreeMap::new(), true);
        let parity = parity();
        let appended_prompt = parity["appendedPrompt"].as_str().unwrap();
        let created = provider
            .create_session(create_input(root.path(), Some(appended_prompt)))
            .await
            .unwrap();
        let requests = captured(&capture);
        assert_eq!(
            requests[0]["params"]["systemPrompt"],
            json!({
                "mode": "append",
                "content": [{ "type": "text", "text": appended_prompt }],
            })
        );
        assert!(
            !requests
                .iter()
                .any(|request| request["method"] == "session/prompt"),
            "context must never be sent as a user prompt"
        );
        let session = session(created.provider_session_id, root.path());
        let mut events = provider.subscribe_events().unwrap();
        let action = provider
            .start_message(
                &session,
                ProviderMessage {
                    message: parity["userMessage"].as_str().unwrap().into(),
                    attachments: Vec::new(),
                    references: Vec::new(),
                    permission_mode: None,
                    message_id: None,
                    user_message_attachments: Vec::new(),
                    story_agent_tools: None,
                },
            )
            .await
            .unwrap();
        provider.message_acknowledged(&session, &action, true);
        while let Ok(event) = events.recv().await {
            if matches!(event, ProviderEvent::TurnCompleted { .. }) {
                break;
            }
        }
        let prompt = captured(&capture)
            .into_iter()
            .find(|request| request["method"] == "session/prompt")
            .unwrap();
        assert_eq!(
            prompt["params"]["prompt"],
            json!([{ "type": "text", "text": parity["userMessage"] }])
        );
    }

    #[tokio::test]
    async fn acp_omits_the_system_prompt_without_story_instructions() {
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("capture.jsonl");
        let provider = provider(root.path(), &capture, BTreeMap::new(), true);
        provider
            .create_session(create_input(root.path(), None))
            .await
            .unwrap();
        assert!(captured(&capture)[0]["params"]
            .get("systemPrompt")
            .is_none());
    }

    #[tokio::test]
    async fn acp_rejects_story_instructions_without_the_agent_capability() {
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("capture.jsonl");
        let provider = provider(
            root.path(),
            &capture,
            BTreeMap::from([("FAKE_ACP_SYSTEM_PROMPT".to_string(), "absent".to_string())]),
            true,
        );
        let error = provider
            .create_session(create_input(root.path(), Some("Story rules")))
            .await
            .unwrap_err();
        assert_eq!(error.code, "AI_SESSION_STORY_CONTEXT_UNSUPPORTED");
        assert!(captured(&capture).is_empty());
    }

    #[tokio::test]
    async fn acp_maps_an_agent_append_rejection_to_the_provider_error() {
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("capture.jsonl");
        let provider = provider(
            root.path(),
            &capture,
            BTreeMap::from([("FAKE_ACP_REJECT_PROMPT".to_string(), "1".to_string())]),
            true,
        );
        let error = provider
            .create_session(create_input(root.path(), Some("Story rules")))
            .await
            .unwrap_err();
        assert_eq!(error.code, "AI_SESSION_PROVIDER_UNAVAILABLE");
    }

    #[tokio::test]
    async fn acp_restores_the_durable_story_instruction_snapshot_on_load() {
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("capture.jsonl");
        let created = {
            let provider = provider(root.path(), &capture, BTreeMap::new(), true);
            provider
                .create_session(create_input(root.path(), Some("Story rules")))
                .await
                .unwrap()
        };
        let provider = provider(root.path(), &capture, BTreeMap::new(), true);
        provider
            .resume_session(&session(created.provider_session_id, root.path()))
            .await
            .unwrap();
        let load = captured(&capture)
            .into_iter()
            .find(|request| request["method"] == "session/load")
            .expect("session/load request");
        assert_eq!(
            load["params"]["systemPrompt"],
            json!({
                "mode": "append",
                "content": [{ "type": "text", "text": "Story rules" }],
            })
        );
    }

    #[tokio::test]
    async fn acp_rejects_restoring_a_story_snapshot_without_the_agent_capability() {
        let root = tempfile::tempdir().unwrap();
        let capture = root.path().join("capture.jsonl");
        let created = {
            let provider = provider(root.path(), &capture, BTreeMap::new(), true);
            provider
                .create_session(create_input(root.path(), Some("Story rules")))
                .await
                .unwrap()
        };
        let provider = provider(
            root.path(),
            &capture,
            BTreeMap::from([("FAKE_ACP_SYSTEM_PROMPT".to_string(), "absent".to_string())]),
            true,
        );
        let error = provider
            .resume_session(&session(created.provider_session_id, root.path()))
            .await
            .unwrap_err();
        assert_eq!(error.code, "AI_SESSION_STORY_CONTEXT_UNSUPPORTED");
    }
}
