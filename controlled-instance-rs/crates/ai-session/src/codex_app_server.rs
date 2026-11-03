use crate::{
    provider::default_provider_actions, AiSession, AiSessionControlProvider,
    AiSessionModelSelection, AiSessionPermissionMode, AiSessionTimelineStore, ProviderAction,
    ProviderAttachmentSource, ProviderCreateInput, ProviderCreateResult, ProviderError,
    ProviderEvent, ProviderForkInput, ProviderMessage, ProviderResumeResult,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use controlled_instance_protocol::{
    codex_model_provider_id, AiSessionAttachmentKind, AiSessionCommandInput, AiSessionCommandName,
    AiSessionCommandResult, AiSessionHierarchyCapabilities, AiSessionMentionCandidate,
    AiSessionMentionCatalog, AiSessionMentionDiagnostic, AiSessionMentionDiagnosticCategory,
    AiSessionMentionFileSearch, AiSessionMentionKind, AiSessionModelSelectionCapabilities,
    AiSessionProviderActions, AiSessionProviderCapability, AiSessionProviderTimelineCapabilities,
    AiSessionReasoningEffortCapabilities, AiSessionTimeline, AiSessionTimelineActivityStatus,
    AiSessionTimelineItem, AiSessionTurnTimeline, AI_SESSION_MAX_INLINE_FILE_BYTES,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, RwLock,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{broadcast, mpsc, oneshot, Mutex},
};

const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 15_000;
const DEFAULT_REASONING_EFFORT: &str = "medium";
const APPROVAL_METHODS: [&str; 3] = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
];
const FULL_HISTORY_FORK_MIN_VERSION: [u64; 3] = [0, 129, 0];
const THREAD_FORK_THROUGH_TURN_MIN_VERSION: [u64; 3] = [0, 143, 0];
const THREAD_SETTINGS_UPDATE_MIN_VERSION: [u64; 3] = [0, 133, 0];
const NATIVE_TIMELINE_MIN_VERSION: [u64; 3] = [0, 145, 0];
const STRUCTURED_TURN_TIMEOUT: Duration = Duration::from_secs(30);
const STRUCTURED_RESPONSE_MAX_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexSubAgentObservation {
    State,
    Activity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexSubAgentActivityOrigin {
    Snapshot,
    Realtime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexSubAgent {
    thread_id: String,
    path: Option<String>,
    status: String,
    activity: Option<String>,
    message: Option<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Default)]
struct CodexSubAgentObservationState {
    state_at: Option<String>,
    activity_at: Option<String>,
    activity_origin: Option<CodexSubAgentActivityOrigin>,
}

#[derive(Debug, Clone)]
struct CodexSubAgentUpdate {
    thread_id: String,
    path: Option<String>,
    status: String,
    activity: Option<String>,
    message: Option<String>,
    observation: CodexSubAgentObservation,
    observed_at: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct CodexSubAgentTracker {
    sub_agents: HashMap<String, CodexSubAgent>,
    observations: HashMap<String, CodexSubAgentObservationState>,
}

impl CodexSubAgentTracker {
    pub(crate) fn replace(&mut self, sub_agents: &[Value]) -> Vec<Value> {
        for sub_agent in sub_agents.iter().filter_map(codex_sub_agent_from_value) {
            let current = self.sub_agents.get(&sub_agent.thread_id).cloned();
            let observation = self
                .observations
                .get(&sub_agent.thread_id)
                .cloned()
                .unwrap_or_default();
            let preserve_newer_state = current.as_ref().is_some_and(|current| {
                codex_sub_agent_state_regression(&current.status, &sub_agent.status)
            });
            let preserve_realtime_activity =
                observation.activity_origin == Some(CodexSubAgentActivityOrigin::Realtime);
            let merged = if let Some(current) = current.as_ref() {
                CodexSubAgent {
                    thread_id: current.thread_id.clone(),
                    status: if preserve_newer_state {
                        current.status.clone()
                    } else {
                        sub_agent.status.clone()
                    },
                    message: if preserve_newer_state {
                        current.message.clone()
                    } else {
                        sub_agent.message.clone()
                    },
                    path: sub_agent.path.clone().or_else(|| current.path.clone()),
                    activity: if preserve_realtime_activity {
                        current.activity.clone()
                    } else {
                        sub_agent
                            .activity
                            .clone()
                            .or_else(|| current.activity.clone())
                    },
                    updated_at: current.updated_at.clone(),
                }
            } else {
                sub_agent.clone()
            };
            let changed = current.as_ref().is_none_or(|current| {
                current.path != merged.path
                    || current.status != merged.status
                    || current.activity != merged.activity
                    || current.message != merged.message
            });
            let stored = if changed {
                CodexSubAgent {
                    updated_at: max_codex_timestamp(
                        current.as_ref().map(|value| value.updated_at.as_str()),
                        &sub_agent.updated_at,
                    )
                    .unwrap_or_else(|| sub_agent.updated_at.clone()),
                    ..merged
                }
            } else {
                current.expect("current sub-agent")
            };
            self.sub_agents.insert(sub_agent.thread_id.clone(), stored);
            self.observations.insert(
                sub_agent.thread_id.clone(),
                CodexSubAgentObservationState {
                    state_at: if preserve_newer_state {
                        observation.state_at
                    } else {
                        max_codex_timestamp(observation.state_at.as_deref(), &sub_agent.updated_at)
                    },
                    activity_at: if sub_agent.activity.is_some() && !preserve_realtime_activity {
                        max_codex_timestamp(
                            observation.activity_at.as_deref(),
                            &sub_agent.updated_at,
                        )
                    } else {
                        observation.activity_at
                    },
                    activity_origin: if preserve_realtime_activity {
                        Some(CodexSubAgentActivityOrigin::Realtime)
                    } else if sub_agent.activity.is_some() {
                        Some(CodexSubAgentActivityOrigin::Snapshot)
                    } else {
                        observation.activity_origin
                    },
                },
            );
        }
        self.prune();
        self.current_snapshot()
    }

    pub(crate) fn apply(&mut self, updates: &[Value], updated_at: &str) -> Vec<Value> {
        for update in updates.iter().filter_map(codex_sub_agent_update_from_value) {
            let current = self.sub_agents.get(&update.thread_id).cloned();
            let observation = self
                .observations
                .get(&update.thread_id)
                .cloned()
                .unwrap_or_default();
            let observation_at = update
                .observed_at
                .clone()
                .unwrap_or_else(|| updated_at.to_string());
            let state_stale = update.observation == CodexSubAgentObservation::State
                && timestamp_before(&observation_at, observation.state_at.as_deref());
            let activity_stale = update.observation == CodexSubAgentObservation::Activity
                && timestamp_before(&observation_at, observation.activity_at.as_deref());
            let next = match update.observation {
                CodexSubAgentObservation::State => CodexSubAgent {
                    thread_id: update.thread_id.clone(),
                    path: current
                        .as_ref()
                        .and_then(|current| current.path.clone())
                        .or_else(|| update.path.clone()),
                    status: if state_stale {
                        current
                            .as_ref()
                            .map(|current| current.status.clone())
                            .unwrap_or_else(|| update.status.clone())
                    } else {
                        update.status.clone()
                    },
                    activity: current
                        .as_ref()
                        .and_then(|current| current.activity.clone()),
                    message: if state_stale {
                        current
                            .as_ref()
                            .and_then(|current| current.message.clone())
                            .or_else(|| update.message.clone())
                    } else {
                        update.message.clone()
                    },
                    updated_at: current
                        .as_ref()
                        .map(|current| current.updated_at.clone())
                        .unwrap_or_else(|| observation_at.clone()),
                },
                CodexSubAgentObservation::Activity => CodexSubAgent {
                    thread_id: update.thread_id.clone(),
                    path: if update.path.is_some()
                        && (!activity_stale
                            || current.as_ref().is_none_or(|value| value.path.is_none()))
                    {
                        update.path.clone()
                    } else {
                        current.as_ref().and_then(|current| current.path.clone())
                    },
                    status: if current.is_some() && observation.state_at.is_some() {
                        current
                            .as_ref()
                            .map(|current| current.status.clone())
                            .unwrap_or_else(|| update.status.clone())
                    } else if activity_stale {
                        current
                            .as_ref()
                            .map(|current| current.status.clone())
                            .unwrap_or_else(|| update.status.clone())
                    } else {
                        update.status.clone()
                    },
                    activity: if activity_stale {
                        current
                            .as_ref()
                            .and_then(|current| current.activity.clone())
                            .or_else(|| update.activity.clone())
                    } else {
                        update.activity.clone().or_else(|| {
                            current
                                .as_ref()
                                .and_then(|current| current.activity.clone())
                        })
                    },
                    message: current.as_ref().and_then(|current| current.message.clone()),
                    updated_at: current
                        .as_ref()
                        .map(|current| current.updated_at.clone())
                        .unwrap_or_else(|| observation_at.clone()),
                },
            };
            let changed = current.as_ref().is_none_or(|current| {
                current.path != next.path
                    || current.status != next.status
                    || current.activity != next.activity
                    || current.message != next.message
            });
            let stored = if changed {
                CodexSubAgent {
                    updated_at: max_codex_timestamp(
                        current.as_ref().map(|value| value.updated_at.as_str()),
                        &observation_at,
                    )
                    .unwrap_or_else(|| observation_at.clone()),
                    ..next
                }
            } else {
                current.expect("current sub-agent")
            };
            self.sub_agents.insert(update.thread_id.clone(), stored);
            self.observations.insert(
                update.thread_id.clone(),
                match update.observation {
                    CodexSubAgentObservation::State => CodexSubAgentObservationState {
                        state_at: if state_stale {
                            observation.state_at
                        } else {
                            Some(observation_at)
                        },
                        ..observation
                    },
                    CodexSubAgentObservation::Activity => CodexSubAgentObservationState {
                        activity_at: if activity_stale {
                            observation.activity_at
                        } else {
                            Some(observation_at)
                        },
                        activity_origin: if activity_stale {
                            observation.activity_origin
                        } else {
                            Some(CodexSubAgentActivityOrigin::Realtime)
                        },
                        ..observation
                    },
                },
            );
        }
        self.prune();
        self.current_snapshot()
    }

    pub(crate) fn contains(&self, thread_id: &str) -> bool {
        self.sub_agents.contains_key(thread_id)
    }

    fn current_snapshot(&self) -> Vec<Value> {
        let mut sub_agents = self.sub_agents.values().collect::<Vec<_>>();
        sub_agents.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        sub_agents
            .into_iter()
            .filter(|sub_agent| sub_agent.status != "completed")
            .map(codex_sub_agent_to_value)
            .collect()
    }

    fn prune(&mut self) {
        if self.sub_agents.len() <= 50 {
            return;
        }
        let mut retained = self.sub_agents.values().collect::<Vec<_>>();
        retained.sort_by(|left, right| {
            let active_order = usize::from(is_active_codex_sub_agent(&right.status))
                .cmp(&usize::from(is_active_codex_sub_agent(&left.status)));
            active_order
                .then_with(|| timestamp_cmp(&right.updated_at, &left.updated_at))
                .then_with(|| left.thread_id.cmp(&right.thread_id))
        });
        let retained_ids = retained
            .into_iter()
            .take(50)
            .map(|sub_agent| sub_agent.thread_id.clone())
            .collect::<HashSet<_>>();
        self.sub_agents
            .retain(|thread_id, _| retained_ids.contains(thread_id));
        self.observations
            .retain(|thread_id, _| retained_ids.contains(thread_id));
    }
}

fn is_active_codex_sub_agent(status: &str) -> bool {
    matches!(
        status,
        "pending-init" | "running" | "interrupted" | "errored"
    )
}

fn codex_sub_agent_state_regression(current: &str, incoming: &str) -> bool {
    fn rank(status: &str) -> u8 {
        match status {
            "pending-init" => 0,
            "running" => 1,
            "interrupted" => 2,
            "completed" | "errored" | "shutdown" | "not-found" => 3,
            _ => 0,
        }
    }
    rank(incoming) < rank(current)
}

fn timestamp_before(left: &str, right: Option<&str>) -> bool {
    right.is_some_and(|right| timestamp_value(left) < timestamp_value(right))
}

fn timestamp_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    timestamp_value(left).cmp(&timestamp_value(right))
}

fn timestamp_value(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .unwrap_or_default()
}

fn max_codex_timestamp(left: Option<&str>, right: &str) -> Option<String> {
    match left {
        Some(left) if timestamp_value(left) >= timestamp_value(right) => Some(left.to_string()),
        _ => Some(right.to_string()),
    }
}

fn codex_sub_agent_to_value(sub_agent: &CodexSubAgent) -> Value {
    let mut value = Map::new();
    value.insert("threadId".to_string(), json!(sub_agent.thread_id));
    if let Some(path) = sub_agent
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        value.insert("path".to_string(), json!(path));
    }
    value.insert("status".to_string(), json!(sub_agent.status));
    if let Some(activity) = sub_agent.activity.as_deref() {
        value.insert("activity".to_string(), json!(activity));
    }
    if let Some(message) = sub_agent
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        value.insert("message".to_string(), json!(message));
    }
    value.insert("updatedAt".to_string(), json!(sub_agent.updated_at));
    Value::Object(value)
}

fn codex_sub_agent_from_value(value: &Value) -> Option<CodexSubAgent> {
    let record = value.as_object()?;
    Some(CodexSubAgent {
        thread_id: string_value(record.get("threadId"))?.trim().to_string(),
        path: string_value(record.get("path")).map(|value| value.trim().to_string()),
        status: codex_sub_agent_status(record.get("status").and_then(Value::as_str))?.to_string(),
        activity: record
            .get("activity")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "started" | "interacted" | "interrupted"))
            .map(ToString::to_string),
        message: string_value(record.get("message")).map(|value| value.trim().to_string()),
        updated_at: string_value(record.get("updatedAt"))?.trim().to_string(),
    })
}

fn codex_sub_agent_update_from_value(value: &Value) -> Option<CodexSubAgentUpdate> {
    let record = value.as_object()?;
    Some(CodexSubAgentUpdate {
        thread_id: string_value(record.get("threadId"))?.trim().to_string(),
        path: string_value(record.get("path")).map(|value| value.trim().to_string()),
        status: codex_sub_agent_status(record.get("status").and_then(Value::as_str))?.to_string(),
        activity: record
            .get("activity")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "started" | "interacted" | "interrupted"))
            .map(ToString::to_string),
        message: string_value(record.get("message")).map(|value| value.trim().to_string()),
        observation: match record.get("observation").and_then(Value::as_str) {
            Some("state") => CodexSubAgentObservation::State,
            Some("activity") => CodexSubAgentObservation::Activity,
            _ => return None,
        },
        observed_at: string_value(record.get("observedAt")),
    })
}

fn string_value(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn codex_sub_agent_status(value: Option<&str>) -> Option<&str> {
    match value {
        Some("pendingInit") => Some("pending-init"),
        Some(
            value @ ("pending-init" | "running" | "interrupted" | "completed" | "errored"
            | "shutdown" | "not-found"),
        ) => Some(value),
        Some("notFound") => Some("not-found"),
        _ => None,
    }
}

fn codex_sub_agent_updates(item: &Value, observed_at: Option<&str>) -> Vec<Value> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    if item_type == "subAgentActivity" {
        let Some(thread_id) = string_value(item.get("agentThreadId")) else {
            return Vec::new();
        };
        let Some(activity) = item
            .get("kind")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "started" | "interacted" | "interrupted"))
        else {
            return Vec::new();
        };
        let mut update = json!({
            "threadId": thread_id,
            "status": match activity {
                "interrupted" => "interrupted",
                "started" => "pending-init",
                _ => "running",
            },
            "activity": activity,
            "observation": "activity",
        });
        if let Some(path) = string_value(item.get("agentPath")) {
            update["path"] = json!(path);
        }
        if let Some(observed_at) = observed_at {
            update["observedAt"] = json!(observed_at);
        }
        return vec![update];
    }
    if item_type != "collabAgentToolCall" {
        return Vec::new();
    }
    item.get("agentsStates")
        .and_then(Value::as_object)
        .map(|states| {
            states
                .iter()
                .filter_map(|(thread_id, state)| {
                    let thread_id = thread_id.trim();
                    if thread_id.is_empty() {
                        return None;
                    }
                    let status =
                        codex_sub_agent_status(state.get("status").and_then(Value::as_str))?;
                    let mut update = json!({
                        "threadId": thread_id,
                        "status": status,
                        "observation": "state",
                    });
                    if let Some(message) = string_value(state.get("message")) {
                        update["message"] = json!(message);
                    }
                    if let Some(observed_at) = observed_at {
                        update["observedAt"] = json!(observed_at);
                    }
                    Some(update)
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn rebuild_codex_sub_agents(turns: &Value, updated_at: &str) -> Vec<Value> {
    let mut tracker = CodexSubAgentTracker::default();
    for turn in turns.as_array().into_iter().flatten() {
        for item in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let updates = codex_sub_agent_updates(item, None);
            if !updates.is_empty() {
                tracker.apply(&updates, updated_at);
            }
        }
    }
    tracker.current_snapshot()
}

fn managed_model_environment_key(key: &str) -> bool {
    matches!(
        key,
        "CODEX_HOME"
            | "OPENAI_API_KEY"
            | "OPENAI_BASE_URL"
            | "TASK_HANDOFF_CODEX_BASE_URL"
            | "TASK_HANDOFF_CODEX_MODEL"
            | "ANTHROPIC_API_KEY"
            | "ANTHROPIC_BASE_URL"
            | "TASK_HANDOFF_CLAUDE_MODEL"
            | "TASK_HANDOFF_OPENCODE_CONFIG_CONTENT"
    ) || key.starts_with("TASK_HANDOFF_CODEX_PROVIDER_")
}

#[derive(Debug, Clone)]
pub struct CodexRpcError {
    pub message: String,
    pub code: Option<i64>,
    pub data: Option<Value>,
}

impl std::fmt::Display for CodexRpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CodexRpcError {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CodexThreadForkCapabilities {
    pub full_history: bool,
    pub through_turn: bool,
}

#[derive(Debug, Clone, Default)]
pub struct CodexThreadResumeOptions {
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub reasoning_effort: Option<String>,
    pub story_agent_tools: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct CodexThreadSettingsUpdate {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub model_provider: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CodexThreadSnapshot {
    pub provider_session_id: String,
    pub cwd: String,
    pub name: Option<String>,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub reasoning_effort: Option<String>,
    pub status: String,
    pub phase: String,
    pub turns: Value,
    pub sub_agents: Vec<Value>,
    pub paginated_history: bool,
    pub fork_supported: bool,
    pub lineage: Option<Value>,
    pub turns_authoritative: bool,
}

#[derive(Debug, Clone)]
struct CodexApprovalRequest {
    response_id: u64,
    provider_session_id: String,
    turn_id: Option<String>,
    item_id: Option<String>,
    summary: String,
    kind: String,
    params: Value,
}

#[derive(Debug, Clone)]
struct LiveThreadItem {
    turn_id: String,
    item: Value,
}

#[derive(Debug, Clone)]
struct PendingTurnError {
    turn_id: String,
    error: String,
}

#[derive(Debug, Clone)]
struct RetryWarning {
    turn_id: String,
    item_id: String,
    error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexAppServerTarget {
    Unix {
        socket_path: PathBuf,
    },
    WebSocket {
        endpoint: String,
        token_file: Option<PathBuf>,
    },
}

#[async_trait]
pub trait CodexAppServerTargetResolver: Send + Sync {
    async fn resolve_codex_app_server_target(
        &self,
    ) -> Result<Option<CodexAppServerTarget>, ProviderError>;

    async fn ensure_codex_app_server_target(
        &self,
    ) -> Result<Option<CodexAppServerTarget>, ProviderError> {
        self.resolve_codex_app_server_target().await
    }

    fn allows_private_codex_app_server(&self) -> bool {
        true
    }
}

#[derive(Debug)]
struct Connection {
    writer: mpsc::Sender<String>,
    child: Option<Arc<Mutex<Option<Child>>>>,
    shutdown: Option<oneshot::Sender<()>>,
}

struct ClientInner {
    command: String,
    launch_args: Vec<String>,
    launch_environment: RwLock<BTreeMap<String, String>>,
    external_target: RwLock<Option<CodexAppServerTarget>>,
    external_target_resolver: RwLock<Option<Arc<dyn CodexAppServerTargetResolver>>>,
    request_timeout: Duration,
    connection: Mutex<Option<Connection>>,
    connect_lock: Mutex<()>,
    pending: PendingRequests,
    next_id: AtomicU64,
    generation: AtomicU64,
    connected: AtomicBool,
    fork_method_available: AtomicBool,
    subagent_thread_list_available: AtomicBool,
    approvals: Mutex<Vec<CodexApprovalRequest>>,
    live_items: Mutex<HashMap<String, Vec<(String, LiveThreadItem)>>>,
    timeline_store: RwLock<Option<AiSessionTimelineStore>>,
    events: broadcast::Sender<ProviderEvent>,
    notifications: broadcast::Sender<Value>,
    version: Mutex<Option<String>>,
    capability_version: RwLock<Option<String>>,
    paginated_timeline_threads: Mutex<HashMap<String, bool>>,
    subscribed_threads: Mutex<HashSet<String>>,
    turn_errors: Mutex<HashMap<String, PendingTurnError>>,
    retry_warnings: Mutex<HashMap<String, RetryWarning>>,
    title_generation: std::sync::Mutex<CodexTitleGenerationState>,
}

#[derive(Default)]
struct CodexTitleGenerationState {
    armed: HashSet<String>,
    requests: HashMap<String, (u64, u64)>,
    next_request: u64,
}

impl CodexTitleGenerationState {
    fn begin(&mut self, thread_id: &str, connection_generation: u64) -> Option<(u64, u64)> {
        if !self.armed.remove(thread_id) {
            return None;
        }
        self.next_request += 1;
        let request = (connection_generation, self.next_request);
        self.requests.insert(thread_id.to_string(), request);
        Some(request)
    }

    fn cancel(&mut self, thread_id: &str) {
        self.armed.remove(thread_id);
        self.requests.remove(thread_id);
    }

    fn reset(&mut self) {
        self.armed.clear();
        self.requests.clear();
    }
}

type PendingRequest = oneshot::Sender<Result<Value, CodexRpcError>>;
type PendingRequests = Arc<Mutex<HashMap<u64, PendingRequest>>>;

#[derive(Clone)]
pub struct CodexAppServerClient {
    inner: Arc<ClientInner>,
}

impl CodexAppServerClient {
    pub fn new() -> Self {
        Self::with_command(
            std::env::var("TASK_HANDOFF_CODEX_APP_SERVER_COMMAND")
                .ok()
                .or_else(|| std::env::var("TASK_HANDOFF_CODEX_COMMAND").ok())
                .and_then(non_empty)
                .unwrap_or_else(|| "codex".to_string()),
        )
    }

    pub fn with_command(command: impl Into<String>) -> Self {
        let request_timeout = std::env::var("TASK_HANDOFF_CODEX_APP_SERVER_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS);
        let (events, _) = broadcast::channel(512);
        let (notifications, _) = broadcast::channel(512);
        Self {
            inner: Arc::new(ClientInner {
                command: command.into(),
                launch_args: Vec::new(),
                launch_environment: RwLock::new(BTreeMap::new()),
                external_target: RwLock::new(None),
                external_target_resolver: RwLock::new(None),
                request_timeout: Duration::from_millis(request_timeout),
                connection: Mutex::new(None),
                connect_lock: Mutex::new(()),
                pending: Arc::new(Mutex::new(HashMap::new())),
                next_id: AtomicU64::new(1),
                generation: AtomicU64::new(0),
                connected: AtomicBool::new(false),
                fork_method_available: AtomicBool::new(true),
                subagent_thread_list_available: AtomicBool::new(true),
                approvals: Mutex::new(Vec::new()),
                live_items: Mutex::new(HashMap::new()),
                timeline_store: RwLock::new(None),
                events,
                notifications,
                version: Mutex::new(None),
                capability_version: RwLock::new(None),
                paginated_timeline_threads: Mutex::new(HashMap::new()),
                subscribed_threads: Mutex::new(HashSet::new()),
                turn_errors: Mutex::new(HashMap::new()),
                retry_warnings: Mutex::new(HashMap::new()),
                title_generation: std::sync::Mutex::new(CodexTitleGenerationState::default()),
            }),
        }
    }

    pub fn with_story_agent_tool_bridge(mut self, endpoint: &str, token: &str) -> Self {
        let inner = Arc::get_mut(&mut self.inner)
            .expect("the Codex app-server client is not shared before launch configuration");
        inner.launch_args = vec![
            "-c".to_string(),
            format!("mcp_servers.task_handoff_story.url='{endpoint}'"),
            "-c".to_string(),
            "mcp_servers.task_handoff_story.bearer_token_env_var='TASK_HANDOFF_AGENT_TOOLS_TOKEN'"
                .to_string(),
        ];
        *inner
            .launch_environment
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = BTreeMap::from([
            (
                "TASK_HANDOFF_AGENT_TOOLS_ENDPOINT".to_string(),
                endpoint.trim_end_matches("/mcp").to_string(),
            ),
            (
                "TASK_HANDOFF_AGENT_TOOLS_TOKEN".to_string(),
                token.to_string(),
            ),
        ]);
        self
    }

    pub fn set_external_target_resolver(
        &self,
        resolver: Option<Arc<dyn CodexAppServerTargetResolver>>,
    ) {
        *self
            .inner
            .external_target_resolver
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = resolver;
    }

    async fn resolve_external_target(&self, ensure: bool) -> Result<bool, ProviderError> {
        let resolver = self
            .inner
            .external_target_resolver
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(resolver) = resolver else {
            return Ok(true);
        };
        let target = if ensure {
            resolver.ensure_codex_app_server_target().await?
        } else {
            resolver.resolve_codex_app_server_target().await?
        };
        if self.update_external_target(target) {
            self.disconnect().await;
        }
        Ok(resolver.allows_private_codex_app_server())
    }

    fn update_external_target(&self, target: Option<CodexAppServerTarget>) -> bool {
        let mut current = self
            .inner
            .external_target
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *current == target {
            false
        } else {
            *current = target;
            true
        }
    }

    /// Select an externally managed shared Codex app-server. `None` restores
    /// the private stdio app-server owned by this client.
    pub async fn configure_external_target(
        &self,
        target: Option<CodexAppServerTarget>,
    ) -> Result<(), ProviderError> {
        let _guard = self.inner.connect_lock.lock().await;
        if self.update_external_target(target) {
            self.connect_locked().await?;
        }
        Ok(())
    }

    /// Replace the managed model environment inherited by Codex. Story bridge
    /// variables are owned by this adapter and are retained across refreshes.
    pub fn replace_managed_environment(&self, environment: BTreeMap<String, String>) -> bool {
        let mut launch = self
            .inner
            .launch_environment
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let next = launch
            .iter()
            .filter(|(key, _)| !managed_model_environment_key(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .chain(environment)
            .collect::<BTreeMap<_, _>>();
        if *launch == next {
            return false;
        }
        *launch = next;
        true
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<ProviderEvent> {
        self.inner.events.subscribe()
    }

    fn subscribe_notifications(&self) -> broadcast::Receiver<Value> {
        self.inner.notifications.subscribe()
    }

    pub fn is_connected(&self) -> bool {
        self.inner.connected.load(Ordering::SeqCst)
    }

    pub fn capability_version(&self) -> Option<String> {
        self.inner
            .capability_version
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .or_else(|| {
                std::env::var("TASK_HANDOFF_CODEX_VERSION")
                    .ok()
                    .and_then(non_empty)
            })
    }

    pub fn supports_thread_settings_update(&self) -> bool {
        self.capability_version()
            .as_deref()
            .is_some_and(codex_thread_settings_update_supported)
    }

    /// Matches the Node adapter contract: provider reload is available when the
    /// client exposes the archive/unarchive/resume methods as a complete set.
    /// This client always implements all three, so the capability is stable
    /// before the first connection and does not depend on the artifact version.
    pub fn supports_provider_reload(&self) -> bool {
        true
    }

    pub fn supports_paginated_timeline(&self) -> bool {
        self.capability_version()
            .as_deref()
            .is_some_and(codex_paginated_timeline_supported)
    }

    fn set_timeline_store(&self, store: AiSessionTimelineStore) {
        *self
            .inner
            .timeline_store
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(store);
    }

    pub fn thread_fork_capabilities(&self) -> CodexThreadForkCapabilities {
        if !self.inner.fork_method_available.load(Ordering::SeqCst) {
            return CodexThreadForkCapabilities::default();
        }
        self.capability_version()
            .as_deref()
            .map(codex_thread_fork_capabilities)
            .unwrap_or_default()
    }

    pub fn warm_capability_version(&self) {
        if self.capability_version().is_some() {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let client = self.clone();
        runtime.spawn(async move {
            let _ = client.resolve_version().await;
        });
    }

    async fn timeline_uses_paginated_history(&self, provider_session_id: &str) -> bool {
        self.inner
            .paginated_timeline_threads
            .lock()
            .await
            .get(provider_session_id)
            .copied()
            .unwrap_or(false)
    }

    async fn record_timeline_history(&self, snapshot: &CodexThreadSnapshot) {
        self.inner.paginated_timeline_threads.lock().await.insert(
            snapshot.provider_session_id.clone(),
            snapshot.paginated_history,
        );
    }

    async fn ensure_connected(&self) -> Result<(), ProviderError> {
        let allows_private = self.resolve_external_target(false).await?;
        if self.is_connected() {
            return Ok(());
        }
        let _guard = self.inner.connect_lock.lock().await;
        if self.is_connected() {
            return Ok(());
        }
        if !allows_private
            && self
                .inner
                .external_target
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_none()
        {
            return Err(ProviderError::new(
                "AI_SESSION_PROVIDER_UNAVAILABLE",
                "Codex app-server is not running.",
                503,
            ));
        }
        self.connect_locked().await
    }

    pub async fn ensure_ready(&self) -> Result<(), ProviderError> {
        self.resolve_external_target(true).await?;
        self.ensure_connected().await
    }

    async fn prepare_discovery(&self) -> Result<bool, ProviderError> {
        let allows_private = self.resolve_external_target(false).await?;
        if !allows_private
            && self
                .inner
                .external_target
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_none()
        {
            return Ok(false);
        }
        self.ensure_connected().await?;
        Ok(true)
    }

    async fn connect_locked(&self) -> Result<(), ProviderError> {
        self.disconnect().await;
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.spawn_connection(generation).await?;
        match self.initialize_connection().await {
            Ok(()) => {
                self.inner
                    .fork_method_available
                    .store(true, Ordering::SeqCst);
                self.inner
                    .subagent_thread_list_available
                    .store(true, Ordering::SeqCst);
                self.inner.connected.store(true, Ordering::SeqCst);
                let _ = self
                    .inner
                    .events
                    .send(ProviderEvent::ConnectionChanged { connected: true });
                Ok(())
            }
            Err(error) => {
                self.disconnect().await;
                Err(error)
            }
        }
    }

    async fn spawn_connection(&self, generation: u64) -> Result<(), ProviderError> {
        let target = self
            .inner
            .external_target
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        match target {
            Some(CodexAppServerTarget::Unix { socket_path }) => {
                self.spawn_unix_connection(generation, socket_path).await
            }
            Some(CodexAppServerTarget::WebSocket {
                endpoint,
                token_file,
            }) => {
                self.spawn_websocket_connection(generation, endpoint, token_file)
                    .await
            }
            None => self.spawn_stdio_connection(generation).await,
        }
    }

    async fn spawn_stdio_connection(&self, generation: u64) -> Result<(), ProviderError> {
        let launch_environment = self
            .inner
            .launch_environment
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let mut child = Command::new(&self.inner.command)
            .args(&self.inner.launch_args)
            .args(["app-server", "--listen", "stdio://"])
            .envs(&launch_environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                ProviderError::new(
                    "AI_SESSION_PROVIDER_UNAVAILABLE",
                    format!(
                        "Codex app-server could not be started from {}: {error}",
                        self.inner.command
                    ),
                    503,
                )
            })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            ProviderError::bad_gateway(
                "AI_SESSION_PROVIDER_UNAVAILABLE",
                "Codex app-server stdin is unavailable.",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ProviderError::bad_gateway(
                "AI_SESSION_PROVIDER_UNAVAILABLE",
                "Codex app-server stdout is unavailable.",
            )
        })?;
        let child = Arc::new(Mutex::new(Some(child)));
        let (writer, mut writer_rx) = mpsc::channel::<String>(128);
        let writer_child = child.clone();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = writer_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
            let mut child = writer_child.lock().await;
            if let Some(child) = child.as_mut() {
                let _ = child.start_kill();
            }
        });
        *self.inner.connection.lock().await = Some(Connection {
            writer: writer.clone(),
            child: Some(child),
            shutdown: None,
        });
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                handle_line(&inner, generation, &writer, line).await;
            }
            connection_lost(&inner, generation).await;
        });
        Ok(())
    }

    #[cfg(unix)]
    async fn spawn_unix_connection(
        &self,
        generation: u64,
        socket_path: PathBuf,
    ) -> Result<(), ProviderError> {
        let stream = tokio::net::UnixStream::connect(&socket_path)
            .await
            .map_err(|error| {
                ProviderError::new(
                    "AI_SESSION_PROVIDER_UNAVAILABLE",
                    format!(
                        "Codex app-server Unix socket could not be connected at {}: {error}",
                        socket_path.display()
                    ),
                    503,
                )
            })?;
        let (socket, _) = tokio_tungstenite::client_async("ws://localhost/rpc", stream)
            .await
            .map_err(|error| {
                ProviderError::new(
                    "AI_SESSION_PROVIDER_UNAVAILABLE",
                    format!(
                        "Codex app-server Unix socket websocket handshake failed at {}: {error}",
                        socket_path.display()
                    ),
                    503,
                )
            })?;
        self.install_websocket_connection(generation, socket).await;
        Ok(())
    }

    #[cfg(not(unix))]
    async fn spawn_unix_connection(
        &self,
        _generation: u64,
        socket_path: PathBuf,
    ) -> Result<(), ProviderError> {
        Err(ProviderError::new(
            "AI_SESSION_PROVIDER_UNAVAILABLE",
            format!(
                "Codex app-server Unix sockets are not supported on this platform: {}",
                socket_path.display()
            ),
            503,
        ))
    }

    async fn spawn_websocket_connection(
        &self,
        generation: u64,
        endpoint: String,
        token_file: Option<PathBuf>,
    ) -> Result<(), ProviderError> {
        let token = match token_file {
            Some(token_file) => Some(tokio::fs::read_to_string(&token_file).await.map_err(
                |error| {
                    ProviderError::new(
                        "AI_SESSION_PROVIDER_UNAVAILABLE",
                        format!(
                            "Codex app-server token file is unreadable: {} ({error})",
                            token_file.display()
                        ),
                        503,
                    )
                },
            )?),
            None => None,
        };
        let request = build_websocket_request(&endpoint, token.as_deref())?;
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|error| {
                ProviderError::new(
                    "AI_SESSION_PROVIDER_UNAVAILABLE",
                    format!(
                        "Codex app-server websocket could not be connected at {endpoint}: {error}"
                    ),
                    503,
                )
            })?;
        self.install_websocket_connection(generation, socket).await;
        Ok(())
    }

    async fn install_websocket_connection<S>(&self, generation: u64, socket: S)
    where
        S: futures_util::Sink<
                tokio_tungstenite::tungstenite::Message,
                Error = tokio_tungstenite::tungstenite::Error,
            > + futures_util::Stream<
                Item = Result<
                    tokio_tungstenite::tungstenite::Message,
                    tokio_tungstenite::tungstenite::Error,
                >,
            > + Unpin
            + Send
            + 'static,
    {
        let (mut sink, mut stream) = socket.split();
        let (writer, mut writer_rx) = mpsc::channel::<String>(128);
        let (shutdown, mut shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    line = writer_rx.recv() => {
                        let Some(line) = line else {
                            break;
                        };
                        if sink
                            .send(tokio_tungstenite::tungstenite::Message::Text(line.into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            let _ = sink.close().await;
        });
        *self.inner.connection.lock().await = Some(Connection {
            writer: writer.clone(),
            child: None,
            shutdown: Some(shutdown),
        });
        let inner = self.inner.clone();
        tokio::spawn(async move {
            while let Some(message) = stream.next().await {
                match message {
                    Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                        handle_line(&inner, generation, &writer, text.as_str()).await;
                    }
                    Ok(tokio_tungstenite::tungstenite::Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            connection_lost(&inner, generation).await;
        });
    }

    async fn initialize_connection(&self) -> Result<(), ProviderError> {
        let version = self.resolve_version().await;
        let result = self
            .request_raw(
                "initialize",
                json!({
                    "clientInfo": { "name": "codex-tui", "version": version },
                    "capabilities": { "experimentalApi": true },
                }),
            )
            .await?;
        if let Some(user_agent) = result.get("userAgent").and_then(Value::as_str) {
            if !user_agent.trim().is_empty() {
                tracing::debug!(user_agent, "connected to Codex app-server");
                *self
                    .inner
                    .capability_version
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    Some(user_agent.to_string());
            }
        }
        self.notify_raw("initialized", json!({})).await
    }

    async fn resolve_version(&self) -> String {
        let mut version = self.inner.version.lock().await;
        if let Some(version) = version.as_deref() {
            return version.to_string();
        }
        let output = tokio::time::timeout(
            Duration::from_secs(5),
            Command::new(&self.inner.command).arg("--version").output(),
        )
        .await
        .ok()
        .and_then(Result::ok);
        let parsed = output
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|output| parse_codex_version(&output))
            .or_else(|| std::env::var("TASK_HANDOFF_CODEX_VERSION").ok())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
        {
            let mut capability_version = self
                .inner
                .capability_version
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if capability_version.is_none() {
                *capability_version = Some(parsed.clone());
            }
        }
        *version = Some(parsed.clone());
        parsed
    }

    async fn disconnect(&self) {
        self.inner.connected.store(false, Ordering::SeqCst);
        self.inner
            .title_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reset();
        self.inner.subscribed_threads.lock().await.clear();
        let connection = self.inner.connection.lock().await.take();
        if let Some(connection) = connection {
            if let Some(shutdown) = connection.shutdown {
                let _ = shutdown.send(());
            }
            if let Some(child) = connection.child {
                if let Some(child) = child.lock().await.as_mut() {
                    let _ = child.start_kill();
                }
            }
        }
        fail_pending(&self.inner.pending, "Codex app-server is not connected.").await;
        self.inner.approvals.lock().await.clear();
    }

    pub async fn stop(&self) {
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        self.disconnect().await;
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, ProviderError> {
        self.ensure_connected().await?;
        self.request_raw(method, params).await
    }

    async fn request_raw(&self, method: &str, params: Value) -> Result<Value, ProviderError> {
        let connection = self
            .inner
            .connection
            .lock()
            .await
            .as_ref()
            .map(|connection| connection.writer.clone())
            .ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_PROVIDER_UNAVAILABLE",
                    "Codex app-server is not connected.",
                    503,
                )
            })?;
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, tx);
        let message = json!({ "id": id, "method": method, "params": params }).to_string();
        if connection.send(message).await.is_err() {
            self.inner.pending.lock().await.remove(&id);
            return Err(ProviderError::new(
                "AI_SESSION_PROVIDER_UNAVAILABLE",
                "Codex app-server is not writable.",
                503,
            ));
        }
        match tokio::time::timeout(self.inner.request_timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(ProviderError::new(
                "AI_SESSION_RPC_FAILED",
                error.message,
                502,
            )),
            Ok(Err(_)) => Err(ProviderError::new(
                "AI_SESSION_PROVIDER_UNAVAILABLE",
                "Codex app-server closed the request.",
                503,
            )),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(ProviderError::new(
                    "AI_SESSION_RPC_TIMEOUT",
                    format!("Codex app-server request timed out: {method}"),
                    504,
                ))
            }
        }
    }

    async fn request_rpc(&self, method: &str, params: Value) -> Result<Value, CodexRpcError> {
        self.ensure_connected()
            .await
            .map_err(|error| CodexRpcError {
                message: error.message,
                code: None,
                data: None,
            })?;
        let connection = self
            .inner
            .connection
            .lock()
            .await
            .as_ref()
            .map(|connection| connection.writer.clone())
            .ok_or_else(|| CodexRpcError {
                message: "Codex app-server is not connected.".to_string(),
                code: None,
                data: None,
            })?;
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, tx);
        let message = json!({ "id": id, "method": method, "params": params }).to_string();
        if connection.send(message).await.is_err() {
            self.inner.pending.lock().await.remove(&id);
            return Err(CodexRpcError {
                message: "Codex app-server is not writable.".to_string(),
                code: None,
                data: None,
            });
        }
        match tokio::time::timeout(self.inner.request_timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err(CodexRpcError {
                message: "Codex app-server closed the request.".to_string(),
                code: None,
                data: None,
            }),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(CodexRpcError {
                    message: format!("Codex app-server request timed out: {method}"),
                    code: None,
                    data: None,
                })
            }
        }
    }

    async fn notify_raw(&self, method: &str, params: Value) -> Result<(), ProviderError> {
        let connection = self
            .inner
            .connection
            .lock()
            .await
            .as_ref()
            .map(|connection| connection.writer.clone())
            .ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_PROVIDER_UNAVAILABLE",
                    "Codex app-server is not connected.",
                    503,
                )
            })?;
        connection
            .send(json!({ "method": method, "params": params }).to_string())
            .await
            .map_err(|_| {
                ProviderError::new(
                    "AI_SESSION_PROVIDER_UNAVAILABLE",
                    "Codex app-server is not writable.",
                    503,
                )
            })
    }

    pub async fn start_thread(
        &self,
        input: &ProviderCreateInput,
    ) -> Result<CodexThreadSnapshot, ProviderError> {
        let model = input
            .model_selection
            .as_ref()
            .map(AiSessionModelSelection::upstream_name);
        let model_provider = input
            .model_selection
            .as_ref()
            .map(codex_model_provider_for_selection);
        let mut params = Map::new();
        params.insert("model".to_string(), json!(model));
        params.insert("modelProvider".to_string(), json!(model_provider));
        params.insert(
            "cwd".to_string(),
            Value::String(input.cwd.display().to_string()),
        );
        params.insert(
            "runtimeWorkspaceRoots".to_string(),
            json!(input
                .runtime_workspace_roots
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()),
        );
        apply_permissions(&mut params, input.permission_mode);
        params.insert("ephemeral".to_string(), Value::Bool(false));
        let story_agent_tools = input.story_agent_tools.clone().unwrap_or_default();
        let config = thread_config(
            input
                .reasoning_effort
                .as_deref()
                .or(Some(DEFAULT_REASONING_EFFORT)),
            Some(story_agent_tools.as_slice()),
        );
        if !config.is_empty() {
            params.insert("config".to_string(), Value::Object(config));
        }
        params.insert("sessionStartSource".to_string(), json!("startup"));
        params.insert("threadSource".to_string(), json!("user"));
        if self.supports_paginated_timeline() {
            params.insert("historyMode".to_string(), json!("paginated"));
        }
        let result = self.request("thread/start", Value::Object(params)).await?;
        let mut snapshot = thread_from_result(result, input.cwd.clone(), false)?;
        snapshot.fork_supported = self.thread_fork_capabilities().full_history;
        self.mark_thread_subscribed(&snapshot.provider_session_id)
            .await;
        self.record_timeline_history(&snapshot).await;
        Ok(snapshot)
    }

    pub async fn fork_thread(
        &self,
        provider_session_id: &str,
        last_turn_id: Option<&str>,
        cwd: Option<&Path>,
        input: &ProviderCreateInput,
    ) -> Result<CodexThreadSnapshot, ProviderError> {
        let capability = self.thread_fork_capabilities();
        if !capability.full_history || (last_turn_id.is_some() && !capability.through_turn) {
            return Err(ProviderError::new(
                "AI_SESSION_FORK_UNSUPPORTED",
                "Codex app-server does not support the requested thread/fork operation.",
                409,
            ));
        }
        let model = input
            .model_selection
            .as_ref()
            .map(AiSessionModelSelection::upstream_name);
        let model_provider = input
            .model_selection
            .as_ref()
            .map(codex_model_provider_for_selection);
        let mut params = Map::new();
        params.insert("threadId".to_string(), json!(provider_session_id));
        if let Some(last_turn_id) = last_turn_id {
            params.insert("lastTurnId".to_string(), json!(last_turn_id));
        }
        if let Some(cwd) = cwd {
            params.insert("cwd".to_string(), json!(cwd.display().to_string()));
        }
        params.insert("model".to_string(), json!(model));
        params.insert("modelProvider".to_string(), json!(model_provider));
        let story_agent_tools = input.story_agent_tools.clone().unwrap_or_default();
        let config = thread_config(
            input
                .reasoning_effort
                .as_deref()
                .or(Some(DEFAULT_REASONING_EFFORT)),
            Some(story_agent_tools.as_slice()),
        );
        if !config.is_empty() {
            params.insert("config".to_string(), Value::Object(config));
        }
        params.insert("ephemeral".to_string(), Value::Bool(false));
        let result = self
            .request_rpc("thread/fork", Value::Object(params))
            .await
            .map_err(|error| {
                if error.code == Some(-32601) {
                    self.inner
                        .fork_method_available
                        .store(false, Ordering::SeqCst);
                    ProviderError::new("AI_SESSION_FORK_UNSUPPORTED", error.message, 409)
                } else {
                    ProviderError::bad_gateway("AI_SESSION_RPC_FAILED", error.message)
                }
            })?;
        let mut snapshot = thread_from_result(
            result,
            cwd.map(Path::to_path_buf)
                .unwrap_or_else(|| input.cwd.clone()),
            false,
        )?;
        snapshot.fork_supported = capability.full_history;
        self.mark_thread_subscribed(&snapshot.provider_session_id)
            .await;
        self.record_timeline_history(&snapshot).await;
        Ok(snapshot)
    }

    pub async fn resume_thread(
        &self,
        provider_session_id: &str,
        options: CodexThreadResumeOptions,
    ) -> Result<CodexThreadSnapshot, ProviderError> {
        let _ = self
            .request(
                "thread/unarchive",
                json!({ "threadId": provider_session_id }),
            )
            .await;
        let mut params = Map::new();
        params.insert("threadId".to_string(), json!(provider_session_id));
        if let Some(model) = options.model {
            params.insert("model".to_string(), json!(model));
        }
        if let Some(model_provider) = options.model_provider {
            params.insert("modelProvider".to_string(), json!(model_provider));
        }
        let config = thread_config(
            options.reasoning_effort.as_deref(),
            options.story_agent_tools.as_deref(),
        );
        if !config.is_empty() {
            params.insert("config".to_string(), Value::Object(config));
        }
        let result = self.request("thread/resume", Value::Object(params)).await?;
        let mut snapshot = thread_from_result(result, PathBuf::new(), true)?;
        snapshot.fork_supported = self.thread_fork_capabilities().full_history;
        self.mark_thread_subscribed(&snapshot.provider_session_id)
            .await;
        self.record_timeline_history(&snapshot).await;
        Ok(snapshot)
    }

    pub async fn read_thread(
        &self,
        provider_session_id: &str,
    ) -> Result<CodexThreadSnapshot, ProviderError> {
        let result = self
            .request(
                "thread/read",
                json!({ "threadId": provider_session_id, "includeTurns": true }),
            )
            .await?;
        let mut snapshot = thread_from_result(result, PathBuf::new(), true)?;
        snapshot.fork_supported = self.thread_fork_capabilities().full_history;
        self.record_timeline_history(&snapshot).await;
        Ok(snapshot)
    }

    async fn list_loaded_thread_ids(&self) -> Result<Vec<String>, CodexRpcError> {
        let mut ids = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let result = self
                .request_rpc(
                    "thread/loaded/list",
                    json!({ "cursor": cursor, "limit": 100 }),
                )
                .await?;
            if let Some(items) = result.get("data").and_then(Value::as_array) {
                ids.extend(
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string),
                );
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(ids)
    }

    async fn list_threads(&self) -> Result<Vec<Value>, CodexRpcError> {
        let mut threads = Vec::new();
        let mut cursor: Option<String> = None;
        let source_kinds = [
            "cli",
            "vscode",
            "exec",
            "appServer",
            "subAgent",
            "subAgentReview",
            "subAgentCompact",
            "subAgentThreadSpawn",
            "subAgentOther",
            "unknown",
        ];
        let mut include_sources = self
            .inner
            .subagent_thread_list_available
            .load(Ordering::SeqCst);
        let mut pages = 0;
        while pages < 10 {
            let params = json!({
                "cursor": cursor,
                "limit": 100,
                "sortKey": Value::Null,
                "sortDirection": Value::Null,
                "modelProviders": Value::Null,
                "sourceKinds": if include_sources { json!(source_kinds) } else { json!([]) },
                "archived": false,
                "cwd": Value::Null,
                "useStateDbOnly": false,
                "searchTerm": Value::Null,
            });
            let result = match self.request_rpc("thread/list", params).await {
                Ok(result) => result,
                Err(error) if include_sources && error.code == Some(-32602) => {
                    self.inner
                        .subagent_thread_list_available
                        .store(false, Ordering::SeqCst);
                    include_sources = false;
                    cursor = None;
                    threads.clear();
                    pages = 0;
                    continue;
                }
                Err(error) => return Err(error),
            };
            pages += 1;
            if let Some(data) = result.get("data").and_then(Value::as_array) {
                threads.extend(data.iter().filter(|value| value.is_object()).cloned());
            } else if let Some(data) = result.get("threads").and_then(Value::as_array) {
                threads.extend(data.iter().filter(|value| value.is_object()).cloned());
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(threads)
    }

    pub async fn active_thread_exists(
        &self,
        provider_session_id: &str,
    ) -> Result<bool, ProviderError> {
        let threads = self.list_threads().await.map_err(|error| {
            ProviderError::new(
                "AI_SESSION_READ_FAILED",
                error.message,
                if error.code == Some(-32601) { 409 } else { 502 },
            )
        })?;
        Ok(threads
            .iter()
            .any(|thread| thread.get("id").and_then(Value::as_str) == Some(provider_session_id)))
    }

    /// Synchronizes the current app-server generation with the persisted app
    /// session thread bindings. The returned snapshots are authoritative reads
    /// for loaded threads and resumed reads for unloaded app-bound threads.
    pub async fn discover_thread_snapshots(
        &self,
        recoverable_thread_ids: &[String],
    ) -> Result<Vec<CodexThreadSnapshot>, ProviderError> {
        if !self.prepare_discovery().await? {
            return Ok(Vec::new());
        }
        let loaded_thread_ids = self.list_loaded_thread_ids().await.map_err(|error| {
            ProviderError::new(
                "AI_SESSION_DISCOVERY_FAILED",
                error.message,
                if error.code == Some(-32601) { 409 } else { 502 },
            )
        })?;
        {
            let loaded = loaded_thread_ids.iter().collect::<HashSet<_>>();
            self.inner
                .subscribed_threads
                .lock()
                .await
                .retain(|thread_id| loaded.contains(thread_id));
        }
        let (mut summaries, mut snapshots) = match self.list_threads().await {
            Ok(threads) => {
                project_thread_list_entries(threads, self.thread_fork_capabilities().full_history)
            }
            Err(_) => (HashMap::new(), Vec::new()),
        };

        let mut seen = HashSet::new();
        for thread_id in loaded_thread_ids {
            if !seen.insert(thread_id.clone()) {
                continue;
            }
            let mut snapshot = self
                .read_thread(&thread_id)
                .await
                .ok()
                .or_else(|| summaries.remove(&thread_id));
            if !self.is_thread_subscribed(&thread_id).await {
                if let Ok(resumed) = self
                    .resume_thread(&thread_id, CodexThreadResumeOptions::default())
                    .await
                {
                    snapshot = Some(resumed);
                }
            }
            let mut snapshot = snapshot.unwrap_or_else(|| empty_thread_snapshot(&thread_id));
            snapshot.fork_supported = self.thread_fork_capabilities().full_history;
            snapshots.push(snapshot);
        }
        for thread_id in recoverable_thread_ids {
            let thread_id = thread_id.trim();
            if thread_id.is_empty() || !seen.insert(thread_id.to_string()) {
                continue;
            }
            match self
                .resume_thread(thread_id, CodexThreadResumeOptions::default())
                .await
            {
                Ok(snapshot) => snapshots.push(snapshot),
                Err(error) => {
                    tracing::debug!(thread_id, %error, "Codex discovery could not resume thread");
                }
            }
        }
        Ok(snapshots)
    }

    async fn is_thread_subscribed(&self, provider_session_id: &str) -> bool {
        self.inner
            .subscribed_threads
            .lock()
            .await
            .contains(provider_session_id)
    }

    async fn mark_thread_subscribed(&self, provider_session_id: &str) {
        self.inner
            .subscribed_threads
            .lock()
            .await
            .insert(provider_session_id.to_string());
    }

    pub async fn ensure_thread_ready(
        &self,
        provider_session_id: &str,
        options: CodexThreadResumeOptions,
    ) -> Result<(), ProviderError> {
        match self.list_loaded_thread_ids().await {
            Ok(loaded) if loaded.iter().any(|id| id == provider_session_id) => Ok(()),
            Ok(_) => {
                self.resume_thread(provider_session_id, options).await?;
                Ok(())
            }
            Err(error) if error.code == Some(-32601) => {
                // Older app-server artifacts do not expose loaded-thread
                // discovery. Resuming is idempotent and keeps those versions
                // usable without weakening the current readiness contract.
                self.resume_thread(provider_session_id, options).await?;
                Ok(())
            }
            Err(error) => Err(ProviderError::new(
                "AI_SESSION_THREAD_READINESS_FAILED",
                error.message,
                502,
            )),
        }
    }

    pub async fn start_turn(
        &self,
        session: &AiSession,
        input: &ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        let provider_session_id = require_provider_session(session)?;
        let (_message, codex_inputs) = prepare_inputs(input)?;
        let mut params = Map::new();
        params.insert("threadId".to_string(), json!(provider_session_id));
        params.insert("input".to_string(), Value::Array(codex_inputs));
        apply_permissions(&mut params, input.permission_mode);
        let result = self.request("turn/start", Value::Object(params)).await?;
        let turn_id = turn_id_from_result(&result);
        Ok(ProviderAction {
            action: "send".to_string(),
            turn_id: turn_id.clone(),
            provider_turn_id: turn_id,
            decision: None,
            queue_id: None,
        })
    }

    pub async fn steer_turn(
        &self,
        session: &AiSession,
        input: &ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        let provider_session_id = require_provider_session(session)?;
        let expected_turn_id = session.active_turn_id.as_deref().ok_or_else(|| {
            ProviderError::conflict(
                "AI_SESSION_NO_ACTIVE_TURN",
                "AI session has no active turn to steer.",
            )
        })?;
        let (_, codex_inputs) = prepare_inputs(input)?;
        let result = match self
            .request(
                "turn/steer",
                json!({
                    "threadId": provider_session_id,
                    "expectedTurnId": expected_turn_id,
                    "input": codex_inputs.clone(),
                }),
            )
            .await
        {
            Ok(result) => result,
            Err(error) => {
                let Some(found_turn_id) = active_turn_mismatch_found_id(&error) else {
                    return Err(error);
                };
                self.request(
                    "turn/steer",
                    json!({
                        "threadId": provider_session_id,
                        "expectedTurnId": found_turn_id,
                        "input": codex_inputs,
                    }),
                )
                .await?
            }
        };
        let turn_id = result
            .get("turnId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| Some(expected_turn_id.to_string()));
        Ok(ProviderAction {
            action: "steer".to_string(),
            turn_id: turn_id.clone(),
            provider_turn_id: turn_id,
            decision: None,
            queue_id: None,
        })
    }

    pub async fn interrupt_turn(
        &self,
        session: &AiSession,
    ) -> Result<ProviderAction, ProviderError> {
        let provider_session_id = require_provider_session(session)?;
        let turn_id = session.active_turn_id.as_deref().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_NO_ACTIVE_TURN",
                "AI session has no active turn to interrupt.",
                400,
            )
        })?;
        match self
            .request(
                "turn/interrupt",
                json!({ "threadId": provider_session_id, "turnId": turn_id }),
            )
            .await
        {
            Ok(_) => Ok(ProviderAction {
                action: "interrupt".to_string(),
                turn_id: Some(turn_id.to_string()),
                provider_turn_id: Some(turn_id.to_string()),
                decision: None,
                queue_id: None,
            }),
            Err(error) => {
                if let Some(found_turn_id) = active_turn_mismatch_found_id(&error) {
                    self.request(
                        "turn/interrupt",
                        json!({ "threadId": provider_session_id, "turnId": found_turn_id }),
                    )
                    .await?;
                    return Ok(ProviderAction {
                        action: "interrupt".to_string(),
                        turn_id: Some(found_turn_id.clone()),
                        provider_turn_id: Some(found_turn_id),
                        decision: None,
                        queue_id: None,
                    });
                }
                if !is_no_active_turn_error(&error) {
                    return Err(error);
                }
                Ok(ProviderAction {
                    action: "interrupt".to_string(),
                    turn_id: Some(turn_id.to_string()),
                    provider_turn_id: Some(turn_id.to_string()),
                    decision: None,
                    queue_id: None,
                })
            }
        }
    }

    pub async fn resolve_approval(
        &self,
        session: &AiSession,
        decision: &str,
    ) -> Result<ProviderAction, ProviderError> {
        let provider_session_id = require_provider_session(session)?;
        let mut approval = self.latest_approval(provider_session_id).await;
        if approval.is_none() {
            self.ensure_thread_ready(provider_session_id, session_resume_options(session))
                .await?;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
            while approval.is_none() && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(10)).await;
                approval = self.latest_approval(provider_session_id).await;
            }
        }
        let approval = approval.ok_or_else(|| {
            ProviderError::conflict(
                "AI_SESSION_APPROVAL_NOT_ATTACHED",
                "Codex approval request is not attached to this control connection. The app-server did not replay a pending approval request for this session.",
            )
        })?;
        let result = approval_response(&approval, decision);
        self.send_response(approval.response_id, result).await?;
        self.inner
            .approvals
            .lock()
            .await
            .retain(|candidate| candidate.response_id != approval.response_id);
        let _ = self.inner.events.send(ProviderEvent::ApprovalResolved {
            provider_session_id: approval.provider_session_id.clone(),
            decision: decision.to_string(),
        });
        Ok(ProviderAction {
            action: "approval".to_string(),
            turn_id: approval.turn_id.clone(),
            provider_turn_id: approval.turn_id,
            decision: Some(decision.to_string()),
            queue_id: None,
        })
    }

    async fn latest_approval(&self, provider_session_id: &str) -> Option<CodexApprovalRequest> {
        let approvals = self.inner.approvals.lock().await;
        approvals
            .iter()
            .rfind(|approval| approval.provider_session_id == provider_session_id)
            .cloned()
    }

    async fn send_response(&self, id: u64, result: Value) -> Result<(), ProviderError> {
        let connection = self
            .inner
            .connection
            .lock()
            .await
            .as_ref()
            .map(|connection| connection.writer.clone())
            .ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_PROVIDER_UNAVAILABLE",
                    "Codex app-server is not connected.",
                    503,
                )
            })?;
        connection
            .send(json!({ "id": id, "result": result }).to_string())
            .await
            .map_err(|_| {
                ProviderError::new(
                    "AI_SESSION_PROVIDER_UNAVAILABLE",
                    "Codex app-server is not writable.",
                    503,
                )
            })
    }

    pub async fn set_thread_name(
        &self,
        provider_session_id: &str,
        name: &str,
    ) -> Result<(), ProviderError> {
        self.request(
            "thread/name/set",
            json!({ "threadId": provider_session_id, "name": name }),
        )
        .await?;
        Ok(())
    }

    pub async fn archive_thread(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.request("thread/archive", json!({ "threadId": provider_session_id }))
            .await?;
        Ok(())
    }

    pub async fn delete_thread(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.request("thread/delete", json!({ "threadId": provider_session_id }))
            .await?;
        Ok(())
    }

    pub async fn unsubscribe_thread(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.request(
            "thread/unsubscribe",
            json!({ "threadId": provider_session_id }),
        )
        .await?;
        Ok(())
    }

    pub async fn run_ephemeral_structured_turn(
        &self,
        cwd: &str,
        model: &str,
        model_provider: &str,
        prompt: &str,
        output_schema: Value,
        reasoning_effort: Option<&str>,
    ) -> Result<String, ProviderError> {
        self.ensure_ready().await?;
        let effective = self
            .request("config/read", json!({ "includeLayers": false, "cwd": cwd }))
            .await?;
        let mut config = temporary_thread_disabled_config();
        if let Some(servers) = effective
            .pointer("/config/mcp_servers")
            .and_then(Value::as_object)
        {
            for name in servers.keys() {
                if !name
                    .chars()
                    .all(|value| value.is_ascii_alphanumeric() || value == '_' || value == '-')
                {
                    return Err(ProviderError::bad_gateway(
                        "AI_SESSION_TITLE_GENERATION_FAILED",
                        "Codex MCP server name cannot be represented as a thread config path.",
                    ));
                }
                config.insert(format!("mcp_servers.{name}.enabled"), Value::Bool(false));
            }
        }
        let started = self
            .request(
                "thread/start",
                json!({
                    "model": model,
                    "modelProvider": model_provider,
                    "cwd": cwd,
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "runtimeWorkspaceRoots": [],
                    "ephemeral": true,
                    "threadSource": "system",
                    "environments": [],
                    "dynamicTools": [],
                    "selectedCapabilityRoots": [],
                    "config": Value::Object(config),
                }),
            )
            .await?;
        let thread = started
            .get("thread")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                ProviderError::bad_gateway(
                    "AI_SESSION_TITLE_GENERATION_FAILED",
                    "Codex temporary structured thread returned no identity.",
                )
            })?;
        let thread_id = thread
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToString::to_string)
            .ok_or_else(|| {
                ProviderError::bad_gateway(
                    "AI_SESSION_TITLE_GENERATION_FAILED",
                    "Codex temporary structured thread returned no identity.",
                )
            })?;
        if thread.get("ephemeral").and_then(Value::as_bool) != Some(true)
            || started.get("model").and_then(Value::as_str) != Some(model)
            || started.get("modelProvider").and_then(Value::as_str) != Some(model_provider)
            || started
                .get("sandbox")
                .and_then(|sandbox| sandbox.get("type"))
                .and_then(Value::as_str)
                != Some("readOnly")
        {
            let _ = self
                .request("thread/unsubscribe", json!({ "threadId": thread_id }))
                .await;
            return Err(ProviderError::bad_gateway(
                "AI_SESSION_TITLE_GENERATION_FAILED",
                "Codex temporary structured thread did not preserve its expected identity, model, or sandbox.",
            ));
        }
        let mut notifications = self.subscribe_notifications();
        let mut turn_params = serde_json::Map::new();
        turn_params.insert("threadId".to_string(), json!(thread_id));
        turn_params.insert(
            "input".to_string(),
            json!([{ "type": "text", "text": prompt, "text_elements": [] }]),
        );
        turn_params.insert("outputSchema".to_string(), output_schema);
        if let Some(effort) = reasoning_effort {
            turn_params.insert("effort".to_string(), json!(effort));
        }
        let turn = match self.request("turn/start", Value::Object(turn_params)).await {
            Ok(turn) => turn,
            Err(error) => {
                let _ = self
                    .request("thread/unsubscribe", json!({ "threadId": thread_id }))
                    .await;
                return Err(error);
            }
        };
        let Some(turn_id) = turn_id_from_result(&turn) else {
            let _ = self
                .request("thread/unsubscribe", json!({ "threadId": thread_id }))
                .await;
            return Err(ProviderError::bad_gateway(
                "AI_SESSION_TITLE_GENERATION_FAILED",
                "Codex temporary structured turn returned no turn identity.",
            ));
        };
        let outcome = tokio::time::timeout(STRUCTURED_TURN_TIMEOUT, async {
            let mut latest_response = None::<String>;
            loop {
                let Ok(notification) = notifications.recv().await else {
                    return Err(ProviderError::bad_gateway(
                        "AI_SESSION_TITLE_GENERATION_FAILED",
                        "Codex notification stream closed during temporary structured turn.",
                    ));
                };
                let method = notification
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let params = notification.get("params").unwrap_or(&Value::Null);
                if params.get("threadId").and_then(Value::as_str) != Some(thread_id.as_str()) {
                    continue;
                }
                if method == "item/completed"
                    && params.get("turnId").and_then(Value::as_str) == Some(turn_id.as_str())
                {
                    let Some(item) = params.get("item") else {
                        continue;
                    };
                    if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
                        continue;
                    }
                    let Some(text) = item.get("text").and_then(Value::as_str) else {
                        continue;
                    };
                    if text.len() > STRUCTURED_RESPONSE_MAX_BYTES {
                        return Err(ProviderError::bad_gateway(
                            "AI_SESSION_TITLE_GENERATION_FAILED",
                            "Codex temporary structured response is too large.",
                        ));
                    }
                    latest_response = Some(text.to_string());
                    continue;
                }
                if method != "turn/completed" {
                    continue;
                }
                let Some(completed_turn) = params.get("turn") else {
                    continue;
                };
                if completed_turn.get("id").and_then(Value::as_str) != Some(turn_id.as_str()) {
                    continue;
                }
                if completed_turn.get("status").and_then(Value::as_str) != Some("completed") {
                    return Err(ProviderError::bad_gateway(
                        "AI_SESSION_TITLE_GENERATION_FAILED",
                        "Codex temporary structured turn did not complete.",
                    ));
                }
                return latest_response.ok_or_else(|| {
                    ProviderError::bad_gateway(
                        "AI_SESSION_TITLE_GENERATION_FAILED",
                        "Codex temporary structured turn completed without a response.",
                    )
                });
            }
        })
        .await;
        let _ = self
            .request("thread/unsubscribe", json!({ "threadId": thread_id }))
            .await;
        let result = outcome.map_err(|_| {
            ProviderError::bad_gateway(
                "AI_SESSION_TITLE_GENERATION_FAILED",
                "Codex temporary structured turn timed out.",
            )
        })??;
        Ok(result)
    }

    pub async fn update_thread_settings(
        &self,
        provider_session_id: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<CodexThreadSettingsUpdate, ProviderError> {
        if !self.supports_thread_settings_update() {
            return Err(ProviderError::new(
                "AI_SESSION_THREAD_SETTINGS_UNSUPPORTED",
                "This Codex version does not support thread settings updates.",
                409,
            ));
        }
        if model.is_none() && effort.is_none() {
            return Err(ProviderError::new(
                "AI_SESSION_THREAD_SETTINGS_INVALID",
                "Codex thread settings update requires model or effort.",
                400,
            ));
        }
        let mut params = Map::new();
        params.insert("threadId".to_string(), json!(provider_session_id));
        if let Some(model) = model {
            params.insert("model".to_string(), json!(model));
        }
        if let Some(effort) = effort {
            params.insert("effort".to_string(), json!(effort));
        }
        let mut notifications = self.subscribe_notifications();
        self.request("thread/settings/update", Value::Object(params))
            .await?;
        let timeout = self.inner.request_timeout;
        let update = tokio::time::timeout(timeout, async {
            loop {
                let Ok(notification) = notifications.recv().await else {
                    return Err(ProviderError::bad_gateway(
                        "AI_SESSION_THREAD_SETTINGS_FAILED",
                        "Codex notification stream closed during thread settings update.",
                    ));
                };
                if notification.get("method").and_then(Value::as_str)
                    != Some("thread/settings/updated")
                {
                    continue;
                }
                let params = notification.get("params").unwrap_or(&Value::Null);
                if params.get("threadId").and_then(Value::as_str) != Some(provider_session_id) {
                    continue;
                }
                let settings = params.get("threadSettings").and_then(Value::as_object);
                if model.is_some_and(|model| {
                    settings
                        .and_then(|settings| settings.get("model"))
                        .and_then(Value::as_str)
                        != Some(model)
                }) {
                    continue;
                }
                if effort.is_some_and(|effort| {
                    settings
                        .and_then(|settings| settings.get("effort"))
                        .and_then(Value::as_str)
                        != Some(effort)
                }) {
                    continue;
                }
                return Ok(CodexThreadSettingsUpdate {
                    model: model.map(ToString::to_string),
                    effort: effort.map(ToString::to_string),
                    model_provider: settings
                        .and_then(|settings| settings.get("modelProvider"))
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                });
            }
        })
        .await
        .map_err(|_| {
            ProviderError::bad_gateway(
                "AI_SESSION_THREAD_SETTINGS_TIMEOUT",
                format!("Codex thread settings update timed out for {provider_session_id}."),
            )
        })??;
        Ok(update)
    }

    pub async fn list_thread_items(
        &self,
        provider_session_id: &str,
        turn_id: Option<&str>,
    ) -> Result<Vec<(String, Value)>, CodexRpcError> {
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let result = self
                .request_rpc(
                    "thread/items/list",
                    json!({
                        "threadId": provider_session_id,
                        "turnId": turn_id,
                        "cursor": cursor,
                        "limit": 1000,
                        "sortDirection": "asc",
                    }),
                )
                .await?;
            if let Some(data) = result.get("data").and_then(Value::as_array) {
                for entry in data {
                    let Some(turn_id) = entry.get("turnId").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(item) = entry.get("item").filter(|value| value.is_object()) else {
                        continue;
                    };
                    entries.push((turn_id.to_string(), item.clone()));
                }
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(entries)
    }

    async fn lists_skills(&self, cwd: &Path) -> Result<Value, CodexRpcError> {
        self.request_rpc(
            "skills/list",
            json!({
                "cwds": [cwd.display().to_string()],
                "forceReload": false,
            }),
        )
        .await
    }

    async fn lists_plugins(&self, cwd: &Path) -> Result<Value, CodexRpcError> {
        self.request_rpc(
            "plugin/list",
            json!({
                "cwds": [cwd.display().to_string()],
                "marketplaceKinds": Value::Null,
            }),
        )
        .await
    }

    async fn lists_apps(&self, provider_session_id: &str) -> Result<Value, CodexRpcError> {
        self.request_rpc(
            "app/list",
            json!({
                "cursor": Value::Null,
                "limit": 1000,
                "threadId": provider_session_id,
                "forceRefetch": false,
            }),
        )
        .await
    }

    async fn start_fuzzy_file_search(
        &self,
        request_id: &str,
        cwd: &Path,
    ) -> Result<Value, CodexRpcError> {
        self.request_rpc(
            "fuzzyFileSearch/sessionStart",
            json!({ "sessionId": request_id, "roots": [cwd.display().to_string()] }),
        )
        .await
    }

    async fn update_fuzzy_file_search(
        &self,
        request_id: &str,
        query: &str,
    ) -> Result<Value, CodexRpcError> {
        self.request_rpc(
            "fuzzyFileSearch/sessionUpdate",
            json!({ "sessionId": request_id, "query": query }),
        )
        .await
    }

    async fn stop_fuzzy_file_search(&self, request_id: &str) {
        let _ = self
            .request_rpc(
                "fuzzyFileSearch/sessionStop",
                json!({ "sessionId": request_id }),
            )
            .await;
    }

    async fn start_review(&self, provider_session_id: &str) -> Result<Value, CodexRpcError> {
        self.request_rpc(
            "review/start",
            json!({
                "threadId": provider_session_id,
                "target": { "type": "uncommittedChanges" },
            }),
        )
        .await
    }

    async fn set_thread_goal(
        &self,
        provider_session_id: &str,
        objective: &str,
    ) -> Result<Value, CodexRpcError> {
        self.request_rpc(
            "thread/goal/set",
            json!({ "threadId": provider_session_id, "objective": objective }),
        )
        .await
    }

    async fn get_thread_goal(&self, provider_session_id: &str) -> Result<Value, CodexRpcError> {
        self.request_rpc(
            "thread/goal/get",
            json!({ "threadId": provider_session_id }),
        )
        .await
    }

    async fn compact_thread(&self, provider_session_id: &str) -> Result<Value, CodexRpcError> {
        self.request_rpc(
            "thread/compact/start",
            json!({ "threadId": provider_session_id }),
        )
        .await
    }

    pub async fn live_items(&self, provider_session_id: &str) -> Vec<(String, Value)> {
        self.inner
            .live_items
            .lock()
            .await
            .get(provider_session_id)
            .map(|items| {
                items
                    .iter()
                    .map(|(_, entry)| (entry.turn_id.clone(), entry.item.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub async fn clear_live_items(&self, provider_session_id: &str) {
        self.inner
            .live_items
            .lock()
            .await
            .remove(provider_session_id);
    }
}

impl Default for CodexAppServerClient {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct CodexAppServerProvider {
    client: CodexAppServerClient,
    timeline_store: Option<AiSessionTimelineStore>,
}

impl CodexAppServerProvider {
    pub fn new(
        client: CodexAppServerClient,
        timeline_store: Option<AiSessionTimelineStore>,
    ) -> Self {
        if let Some(store) = timeline_store.as_ref() {
            client.set_timeline_store(store.clone());
        }
        Self {
            client,
            timeline_store,
        }
    }

    pub fn arm_title_generation(&self, provider_session_id: &str) {
        self.client
            .inner
            .title_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .armed
            .insert(provider_session_id.to_string());
    }

    pub fn take_armed_title_generation(&self, provider_session_id: &str) -> Option<(u64, u64)> {
        self.client
            .inner
            .title_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .begin(
                provider_session_id,
                self.client.inner.generation.load(Ordering::SeqCst),
            )
    }

    pub fn title_generation_is_current(
        &self,
        provider_session_id: &str,
        request: (u64, u64),
    ) -> bool {
        self.client.inner.connected.load(Ordering::SeqCst)
            && self.client.inner.generation.load(Ordering::SeqCst) == request.0
            && self
                .client
                .inner
                .title_generation
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .requests
                .get(provider_session_id)
                == Some(&request)
    }

    pub fn client(&self) -> &CodexAppServerClient {
        &self.client
    }

    pub async fn replace_managed_environment(&self, environment: BTreeMap<String, String>) -> bool {
        let changed = self.client.replace_managed_environment(environment);
        if changed {
            self.client.stop().await;
        }
        changed
    }

    pub async fn read_session(
        &self,
        provider_session_id: &str,
    ) -> Result<CodexThreadSnapshot, ProviderError> {
        self.client.ensure_ready().await?;
        let snapshot = self.client.read_thread(provider_session_id).await?;
        publish_thread_snapshot(&self.client, &snapshot);
        Ok(snapshot)
    }

    async fn ensure_session_thread_ready(&self, session: &AiSession) -> Result<(), ProviderError> {
        let provider_session_id = require_provider_session(session)?;
        self.client.ensure_ready().await?;
        self.client
            .ensure_thread_ready(provider_session_id, session_resume_options(session))
            .await
    }

    async fn resume_session_with_tools(
        &self,
        session: &AiSession,
        story_agent_tools: Option<Vec<String>>,
    ) -> Result<ProviderResumeResult, ProviderError> {
        let provider_session_id = require_provider_session(session)?;
        self.client.ensure_ready().await?;
        let requested = session
            .model_selection
            .clone()
            .and_then(|value| serde_json::from_value::<AiSessionModelSelection>(value).ok());
        let model = requested
            .as_ref()
            .map(AiSessionModelSelection::upstream_name);
        let model_provider = requested.as_ref().map(codex_model_provider_for_selection);
        let snapshot = self
            .client
            .resume_thread(
                provider_session_id,
                CodexThreadResumeOptions {
                    model: model.map(ToString::to_string),
                    model_provider: model_provider.clone(),
                    reasoning_effort: Some(
                        session
                            .reasoning_effort
                            .clone()
                            .unwrap_or_else(|| DEFAULT_REASONING_EFFORT.to_string()),
                    ),
                    story_agent_tools: Some(story_agent_tools.unwrap_or_default()),
                },
            )
            .await?;
        if let (Some(requested), Some(actual_model)) =
            (requested.as_ref(), snapshot.model.as_deref())
        {
            if requested.upstream_name() != actual_model {
                return Err(ProviderError::bad_gateway(
                    "AI_SESSION_MODEL_SELECTION_INVALID_RESPONSE",
                    "Codex resumed the thread with a different model.",
                ));
            }
        }
        if let (Some(expected_provider), Some(actual_provider)) = (
            model_provider.as_deref(),
            snapshot.model_provider.as_deref(),
        ) {
            if expected_provider != actual_provider {
                return Err(ProviderError::bad_gateway(
                    "AI_SESSION_MODEL_SELECTION_INVALID_RESPONSE",
                    "Codex resumed the thread with a different provider.",
                ));
            }
        }
        publish_thread_snapshot(&self.client, &snapshot);
        Ok(ProviderResumeResult {
            model_selection: requested,
            reasoning_effort: snapshot.reasoning_effort,
        })
    }

    async fn read_timeline(
        &self,
        session: &AiSession,
        provider_turn_id: Option<&str>,
        public_turn_id: Option<&str>,
    ) -> Result<AiSessionTimeline, ProviderError> {
        let provider_session_id = require_provider_session(session)?;
        self.client.ensure_ready().await?;
        let matches_turn = |turn_id: &str| {
            provider_turn_id
                .is_none_or(|expected| turn_id == expected || public_turn_id == Some(turn_id))
        };
        let uses_paginated_history = self
            .client
            .timeline_uses_paginated_history(provider_session_id)
            .await;
        let mut persisted = if uses_paginated_history {
            match self
                .client
                .list_thread_items(provider_session_id, provider_turn_id)
                .await
            {
                Ok(entries) => project_thread_item_entries(entries),
                Err(error) if error.code == Some(-32601) => {
                    return Err(ProviderError::new(
                        "AI_SESSION_TIMELINE_UNSUPPORTED",
                        "Codex native Timeline history became unavailable.",
                        409,
                    ));
                }
                Err(error) => {
                    return Err(ProviderError::new(
                        "AI_SESSION_TIMELINE_UNAVAILABLE",
                        error.message,
                        502,
                    ));
                }
            }
        } else {
            let snapshot = self.client.read_thread(provider_session_id).await?;
            project_thread_turns(&snapshot.turns)
        };
        persisted.retain(|item| matches_turn(item.turn_id()));
        if !uses_paginated_history {
            let store = self.timeline_store.as_ref().ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_TIMELINE_UNSUPPORTED",
                    "Codex adapter Timeline history is unavailable.",
                    409,
                )
            })?;
            let durable = store
                .items(provider_session_id)
                .into_iter()
                .filter(|item| matches_turn(item.turn_id()))
                .collect::<Vec<_>>();
            persisted = merge_codex_timeline_items(&persisted, &durable);
        }
        let live = self
            .client
            .live_items(provider_session_id)
            .await
            .into_iter()
            .filter(|(turn_id, _)| matches_turn(turn_id))
            .filter_map(|(turn_id, item)| project_thread_item_value(&turn_id, &item))
            .collect::<Vec<_>>();
        Ok(AiSessionTimeline {
            session_id: session.id.clone(),
            provider_session_id: provider_session_id.to_string(),
            items: merge_codex_timeline_items(&persisted, &live),
            generated_at: now_iso(),
        })
    }
}

#[async_trait]
impl AiSessionControlProvider for CodexAppServerProvider {
    fn agent(&self) -> &str {
        "codex"
    }

    fn session_actions(&self, status: Option<&str>) -> Value {
        let mut actions = default_provider_actions(status);
        if let Some(object) = actions.as_object_mut() {
            object.insert(
                "fork".to_string(),
                json!(self.client.thread_fork_capabilities().full_history),
            );
        }
        actions
    }

    fn timeline_capabilities(&self) -> AiSessionProviderTimelineCapabilities {
        let connected = self.client.is_connected();
        AiSessionProviderTimelineCapabilities {
            session_read: connected,
            turn_read: connected,
            live_items: true,
        }
    }

    fn capability(&self) -> AiSessionProviderCapability {
        self.client.warm_capability_version();
        let thread_settings = self.client.supports_thread_settings_update();
        let provider_reload = self.client.supports_provider_reload();
        AiSessionProviderCapability {
            agent: "codex".to_string(),
            actions: AiSessionProviderActions {
                create: true,
                send: true,
                queue: true,
                steer: true,
                interrupt: true,
                archive: true,
                delete: true,
                // Node advertises the action from the adapter contract; the
                // version-derived fork mode is enforced when the action runs.
                fork: true,
                rename: true,
                approval_decisions: vec![
                    "allow".to_string(),
                    "deny".to_string(),
                    "skip".to_string(),
                ],
            },
            permission_modes: vec![
                "ask".to_string(),
                "auto-review".to_string(),
                "full-access".to_string(),
            ],
            timeline: AiSessionProviderTimelineCapabilities {
                session_read: true,
                turn_read: true,
                live_items: true,
            },
            model_selection: Some(AiSessionModelSelectionCapabilities {
                select_model_at_create: true,
                select_provider_at_create: true,
                select_model_at_resume: provider_reload,
                select_provider_at_resume: provider_reload,
                switch_model_within_provider: thread_settings,
                switch_provider_during_session: provider_reload,
                stable_identity: true,
            }),
            reasoning_effort: Some(AiSessionReasoningEffortCapabilities {
                select_at_create: true,
                update_during_session: thread_settings,
            }),
            hierarchy: Some(AiSessionHierarchyCapabilities { subagents: true }),
        }
    }

    fn subscribe_events(&self) -> Option<broadcast::Receiver<ProviderEvent>> {
        Some(self.client.subscribe_events())
    }

    async fn create_session(
        &self,
        input: ProviderCreateInput,
    ) -> Result<ProviderCreateResult, ProviderError> {
        self.client.ensure_ready().await?;
        let snapshot = self.client.start_thread(&input).await?;
        verify_thread_selection(&snapshot, input.model_selection.as_ref())?;
        if snapshot.cwd.trim().is_empty() {
            return Err(ProviderError::bad_gateway(
                "AI_SESSION_CREATE_INVALID_RESPONSE",
                "Codex app-server returned a thread without a workspace.",
            ));
        }
        publish_thread_snapshot(&self.client, &snapshot);
        self.arm_title_generation(&snapshot.provider_session_id);
        Ok(ProviderCreateResult {
            provider_session_id: snapshot.provider_session_id,
            cwd: PathBuf::from(snapshot.cwd),
            model_selection: input.model_selection,
            reasoning_effort: snapshot
                .reasoning_effort
                .or(input.reasoning_effort)
                .or_else(|| Some(DEFAULT_REASONING_EFFORT.to_string())),
        })
    }

    async fn read_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.client.ensure_ready().await?;
        let snapshot = self.client.read_thread(provider_session_id).await?;
        publish_thread_snapshot(&self.client, &snapshot);
        Ok(())
    }

    async fn start_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        self.ensure_session_thread_ready(session).await?;
        self.client.start_turn(session, &input).await
    }

    async fn steer_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        self.ensure_session_thread_ready(session).await?;
        self.client.steer_turn(session, &input).await
    }

    async fn interrupt(&self, session: &AiSession) -> Result<ProviderAction, ProviderError> {
        self.ensure_session_thread_ready(session).await?;
        self.client.interrupt_turn(session).await
    }

    async fn resolve_approval(
        &self,
        session: &AiSession,
        decision: &str,
    ) -> Result<ProviderAction, ProviderError> {
        self.ensure_session_thread_ready(session).await?;
        self.client.resolve_approval(session, decision).await
    }

    async fn rename_session(&self, session: &AiSession, _title: &str) -> Result<(), ProviderError> {
        if let Some(thread_id) = session.provider_session_id.as_deref() {
            self.client
                .inner
                .title_generation
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .cancel(thread_id);
        }
        Ok(())
    }

    async fn resume_session(
        &self,
        session: &AiSession,
    ) -> Result<ProviderResumeResult, ProviderError> {
        self.resume_session_with_tools(session, None).await
    }

    async fn resume_session_with_story_tools(
        &self,
        session: &AiSession,
        story_agent_tools: Option<Vec<String>>,
    ) -> Result<ProviderResumeResult, ProviderError> {
        self.resume_session_with_tools(session, story_agent_tools)
            .await
    }

    async fn fork_session(
        &self,
        source: &AiSession,
        input: ProviderForkInput,
    ) -> Result<ProviderCreateResult, ProviderError> {
        self.client.ensure_ready().await?;
        let provider_session_id = require_provider_session(source)?;
        let create_input = ProviderCreateInput {
            cwd: input
                .cwd
                .clone()
                .or_else(|| source.cwd.clone().map(PathBuf::from))
                .ok_or_else(|| {
                    ProviderError::conflict(
                        "AI_SESSION_FORK_SOURCE_INVALID",
                        "Fork source has no working directory.",
                    )
                })?,
            runtime_workspace_roots: vec![],
            permission_mode: None,
            model_selection: source
                .model_selection
                .clone()
                .and_then(|value| serde_json::from_value(value).ok()),
            reasoning_effort: source.reasoning_effort.clone(),
            story_agent_tools: input.story_agent_tools,
        };
        let snapshot = self
            .client
            .fork_thread(
                provider_session_id,
                input.through_turn_id.as_deref(),
                input.cwd.as_deref(),
                &create_input,
            )
            .await?;
        verify_thread_selection(&snapshot, create_input.model_selection.as_ref())?;
        if snapshot.provider_session_id == provider_session_id || snapshot.cwd.trim().is_empty() {
            return Err(ProviderError::bad_gateway(
                "AI_SESSION_FORK_INVALID_RESPONSE",
                "Codex app-server returned an invalid Fork thread.",
            ));
        }
        publish_thread_snapshot(&self.client, &snapshot);
        self.arm_title_generation(&snapshot.provider_session_id);
        Ok(ProviderCreateResult {
            provider_session_id: snapshot.provider_session_id,
            cwd: PathBuf::from(snapshot.cwd),
            model_selection: create_input.model_selection,
            reasoning_effort: snapshot
                .reasoning_effort
                .or(create_input.reasoning_effort)
                .or_else(|| Some(DEFAULT_REASONING_EFFORT.to_string())),
        })
    }

    async fn update_model_selection(
        &self,
        session: &AiSession,
        selection: &AiSessionModelSelection,
    ) -> Result<Option<AiSessionModelSelection>, ProviderError> {
        self.client.ensure_ready().await?;
        let current = session
            .model_selection
            .clone()
            .and_then(|value| serde_json::from_value::<AiSessionModelSelection>(value).ok());
        let provider_session_id = require_provider_session(session)?;
        if current
            .as_ref()
            .is_none_or(|current| current.model_entity_id != selection.model_entity_id)
        {
            let previous = current.ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_MODEL_SELECTION_UNKNOWN",
                    "The current Codex provider is unknown.",
                    409,
                )
            })?;
            self.client.archive_thread(provider_session_id).await?;
            let requested_options = CodexThreadResumeOptions {
                model: Some(selection.upstream_name().to_string()),
                model_provider: Some(codex_model_provider_for_selection(selection)),
                reasoning_effort: Some(
                    session
                        .reasoning_effort
                        .clone()
                        .unwrap_or_else(|| DEFAULT_REASONING_EFFORT.to_string()),
                ),
                story_agent_tools: None,
            };
            let resumed = self
                .client
                .resume_thread(provider_session_id, requested_options)
                .await;
            match resumed.and_then(|snapshot| {
                verify_thread_selection(&snapshot, Some(selection))?;
                Ok(snapshot)
            }) {
                Ok(snapshot) => {
                    publish_thread_snapshot(&self.client, &snapshot);
                    return Ok(Some(selection.clone()));
                }
                Err(error) => {
                    let rollback = async {
                        self.client.archive_thread(provider_session_id).await?;
                        self.client
                            .resume_thread(
                                provider_session_id,
                                CodexThreadResumeOptions {
                                    model: Some(previous.upstream_name().to_string()),
                                    model_provider: Some(codex_model_provider_for_selection(
                                        &previous,
                                    )),
                                    reasoning_effort: Some(
                                        session.reasoning_effort.clone().unwrap_or_else(|| {
                                            DEFAULT_REASONING_EFFORT.to_string()
                                        }),
                                    ),
                                    story_agent_tools: None,
                                },
                            )
                            .await
                    };
                    if let Err(rollback_error) = rollback.await {
                        tracing::error!(
                            ai_session_id = %session.id,
                            provider_session_id,
                            %rollback_error,
                            "Codex provider switch rollback failed"
                        );
                    }
                    return Err(error);
                }
            }
        }
        if !self.client.supports_thread_settings_update() {
            return Err(ProviderError::new(
                "AI_SESSION_MODEL_SELECTION_UNSUPPORTED",
                "This Codex version does not support model switching.",
                409,
            ));
        }
        self.client
            .ensure_thread_ready(
                provider_session_id,
                CodexThreadResumeOptions {
                    model: Some(selection.upstream_name().to_string()),
                    model_provider: Some(codex_model_provider_for_selection(selection)),
                    reasoning_effort: Some(
                        session
                            .reasoning_effort
                            .clone()
                            .unwrap_or_else(|| DEFAULT_REASONING_EFFORT.to_string()),
                    ),
                    story_agent_tools: None,
                },
            )
            .await?;
        let updated = self
            .client
            .update_thread_settings(provider_session_id, Some(selection.upstream_name()), None)
            .await?;
        if updated.model.is_none() {
            return Err(ProviderError::bad_gateway(
                "AI_SESSION_MODEL_SELECTION_INVALID_RESPONSE",
                "Codex reported no model after updating thread settings.",
            ));
        }
        let expected_provider = codex_model_provider_for_selection(selection);
        if updated
            .model_provider
            .as_deref()
            .is_some_and(|provider| provider != expected_provider)
        {
            return Err(ProviderError::conflict(
                "AI_SESSION_PROVIDER_SWITCH_REQUIRES_NEW_SESSION",
                "Codex changed to an unexpected provider.",
            ));
        }
        Ok(Some(selection.clone()))
    }

    async fn update_reasoning_effort(
        &self,
        session: &AiSession,
        reasoning_effort: &str,
    ) -> Result<Option<String>, ProviderError> {
        self.client.ensure_ready().await?;
        if !self.client.supports_thread_settings_update() {
            return Err(ProviderError::new(
                "AI_SESSION_REASONING_EFFORT_UNSUPPORTED",
                "This Codex version does not support reasoning effort changes.",
                409,
            ));
        }
        let provider_session_id = require_provider_session(session)?;
        self.client
            .ensure_thread_ready(
                provider_session_id,
                CodexThreadResumeOptions {
                    reasoning_effort: Some(reasoning_effort.to_string()),
                    ..session_resume_options(session)
                },
            )
            .await?;
        let updated = self
            .client
            .update_thread_settings(provider_session_id, None, Some(reasoning_effort))
            .await?;
        if updated.effort.as_deref() != Some(reasoning_effort) {
            return Err(ProviderError::bad_gateway(
                "AI_SESSION_REASONING_EFFORT_INVALID_RESPONSE",
                "Codex reported an invalid reasoning effort.",
            ));
        }
        Ok(Some(reasoning_effort.to_string()))
    }

    async fn archive_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.client.ensure_ready().await?;
        self.client.archive_thread(provider_session_id).await
    }

    async fn delete_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.client.ensure_ready().await?;
        self.client.delete_thread(provider_session_id).await
    }

    async fn active_session_exists(
        &self,
        provider_session_id: &str,
    ) -> Result<Option<bool>, ProviderError> {
        self.client.ensure_ready().await?;
        self.client
            .active_thread_exists(provider_session_id)
            .await
            .map(Some)
    }

    async fn unsubscribe_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.client.ensure_ready().await?;
        self.client.unsubscribe_thread(provider_session_id).await
    }

    async fn mention_catalog(
        &self,
        session: &AiSession,
    ) -> Result<AiSessionMentionCatalog, ProviderError> {
        let (provider_session_id, cwd) = mention_context(session)?;
        self.client.ensure_ready().await?;
        let (skills, plugins, apps) = tokio::join!(
            self.client.lists_skills(&cwd),
            self.client.lists_plugins(&cwd),
            self.client.lists_apps(provider_session_id),
        );
        let mut candidates = Vec::new();
        let mut diagnostics = Vec::new();
        collect_mention_result(
            skills,
            AiSessionMentionDiagnosticCategory::Skills,
            &mut candidates,
            &mut diagnostics,
            normalize_skill_candidates,
        );
        collect_mention_result(
            plugins,
            AiSessionMentionDiagnosticCategory::Plugins,
            &mut candidates,
            &mut diagnostics,
            normalize_plugin_candidates,
        );
        collect_mention_result(
            apps,
            AiSessionMentionDiagnosticCategory::Apps,
            &mut candidates,
            &mut diagnostics,
            normalize_app_candidates,
        );
        dedupe_mentions(&mut candidates);
        candidates.truncate(1000);
        diagnostics.truncate(20);
        Ok(AiSessionMentionCatalog {
            session_id: session.id.clone(),
            provider_session_id: provider_session_id.to_string(),
            cwd: cwd.display().to_string(),
            candidates,
            diagnostics,
        })
    }

    async fn search_mention_files(
        &self,
        session: &AiSession,
        query: &str,
    ) -> Result<AiSessionMentionFileSearch, ProviderError> {
        let (_, cwd) = mention_context(session)?;
        self.client.ensure_ready().await?;
        let request_id = format!(
            "mention_{}",
            &uuid::Uuid::new_v4().simple().to_string()[..20]
        );
        let mut notifications = self.client.subscribe_notifications();
        self.client
            .start_fuzzy_file_search(&request_id, &cwd)
            .await
            .map_err(mention_rpc_error)?;
        self.client
            .update_fuzzy_file_search(&request_id, query)
            .await
            .map_err(mention_rpc_error)?;
        let mut candidates = Vec::new();
        let mut complete = false;
        let deadline = tokio::time::sleep(Duration::from_millis(1200));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                notification = notifications.recv() => {
                    let Ok(notification) = notification else {
                        break;
                    };
                    let method = notification.get("method").and_then(Value::as_str).unwrap_or_default();
                    let params = notification.get("params").unwrap_or(&Value::Null);
                    if params.get("sessionId").and_then(Value::as_str) != Some(request_id.as_str()) {
                        continue;
                    }
                    if method == "fuzzyFileSearch/sessionUpdated"
                        && params.get("query").and_then(Value::as_str) == Some(query)
                    {
                        if let Some(files) = params.get("files").and_then(Value::as_array) {
                            candidates = normalize_file_mention_candidates(files, &cwd);
                        }
                    }
                    if method == "fuzzyFileSearch/sessionCompleted" {
                        complete = true;
                        break;
                    }
                }
            }
        }
        self.client.stop_fuzzy_file_search(&request_id).await;
        Ok(AiSessionMentionFileSearch {
            session_id: session.id.clone(),
            cwd: cwd.display().to_string(),
            query: query.to_string(),
            request_id,
            candidates,
            complete,
        })
    }

    async fn execute_command(
        &self,
        session: &AiSession,
        input: &AiSessionCommandInput,
    ) -> Result<AiSessionCommandResult, ProviderError> {
        self.client.ensure_ready().await?;
        let provider_session_id = require_provider_session(session)?;
        if matches!(
            input.command,
            AiSessionCommandName::Review | AiSessionCommandName::Compact
        ) && matches!(session.status.as_str(), "running" | "waiting")
        {
            return Err(ProviderError::conflict(
                "AI_SESSION_BUSY",
                format!(
                    "{} is unavailable while the session is busy.",
                    input.command.as_str()
                ),
            ));
        }
        match input.command {
            AiSessionCommandName::Review => {
                let result = self
                    .client
                    .start_review(provider_session_id)
                    .await
                    .map_err(command_rpc_error)?;
                Ok(AiSessionCommandResult {
                    command: input.command,
                    value: None,
                    turn_id: turn_id_from_result(&result),
                })
            }
            AiSessionCommandName::Compact => {
                self.client
                    .compact_thread(provider_session_id)
                    .await
                    .map_err(command_rpc_error)?;
                Ok(AiSessionCommandResult {
                    command: input.command,
                    value: None,
                    turn_id: None,
                })
            }
            AiSessionCommandName::Goal => {
                if let Some(argument) = input.argument.as_deref() {
                    self.client
                        .set_thread_goal(provider_session_id, argument)
                        .await
                        .map_err(command_rpc_error)?;
                    return Ok(AiSessionCommandResult {
                        command: input.command,
                        value: Some(argument.to_string()),
                        turn_id: None,
                    });
                }
                let result = self
                    .client
                    .get_thread_goal(provider_session_id)
                    .await
                    .map_err(command_rpc_error)?;
                let objective = result
                    .get("goal")
                    .and_then(Value::as_object)
                    .and_then(|goal| goal.get("objective"))
                    .and_then(Value::as_str)
                    .unwrap_or("No active goal.");
                Ok(AiSessionCommandResult {
                    command: input.command,
                    value: Some(objective.to_string()),
                    turn_id: None,
                })
            }
            AiSessionCommandName::Rename => Err(ProviderError::unsupported(
                "Rename is handled by the AI Session controller.",
            )),
        }
    }

    async fn timeline(&self, session: &AiSession) -> Result<AiSessionTimeline, ProviderError> {
        self.read_timeline(session, None, None).await
    }

    async fn turn_timeline(
        &self,
        session: &AiSession,
        turn_id: &str,
    ) -> Result<AiSessionTurnTimeline, ProviderError> {
        let turn = session
            .turns
            .as_deref()
            .unwrap_or_default()
            .iter()
            .find(|turn| {
                turn.get("id").and_then(Value::as_str) == Some(turn_id)
                    || turn.get("providerTurnId").and_then(Value::as_str) == Some(turn_id)
            })
            .ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_TURN_NOT_FOUND",
                    "AI session Turn was not found.",
                    404,
                )
            })?;
        let canonical_turn_id = turn
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(turn_id);
        let provider_turn_id = turn
            .get("providerTurnId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(canonical_turn_id);
        let timeline = self
            .read_timeline(session, Some(provider_turn_id), Some(canonical_turn_id))
            .await?;
        Ok(AiSessionTurnTimeline {
            session_id: session.id.clone(),
            turn_id: canonical_turn_id.to_string(),
            items: timeline.items,
            generated_at: timeline.generated_at,
        })
    }
}

fn mention_context(session: &AiSession) -> Result<(&str, PathBuf), ProviderError> {
    if session.agent != "codex" {
        return Err(ProviderError::new(
            "AI_SESSION_MENTIONS_UNSUPPORTED",
            "Mentions are only supported for Codex sessions.",
            400,
        ));
    }
    let provider_session_id = session
        .provider_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_THREAD_NOT_FOUND",
                "AI session is not bound to a Codex thread.",
                409,
            )
        })?;
    let cwd = session
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_CWD_NOT_FOUND",
                "AI session has no accessible working directory.",
                409,
            )
        })?;
    Ok((provider_session_id, normalize_path_lexically(&cwd)))
}

fn mention_rpc_error(error: CodexRpcError) -> ProviderError {
    if error.code == Some(-32601) {
        ProviderError::new(
            "AI_SESSION_MENTIONS_UNSUPPORTED",
            format!(
                "Codex app-server does not support this mention operation: {}",
                error.message
            ),
            409,
        )
    } else {
        ProviderError::new("AI_SESSION_RPC_FAILED", error.message, 502)
    }
}

fn command_rpc_error(error: CodexRpcError) -> ProviderError {
    if error.code == Some(-32601) {
        ProviderError::new(
            "AI_SESSION_COMMAND_UNSUPPORTED",
            format!(
                "Codex app-server does not support this command: {}",
                error.message
            ),
            409,
        )
    } else {
        ProviderError::new("AI_SESSION_RPC_FAILED", error.message, 502)
    }
}

fn collect_mention_result(
    result: Result<Value, CodexRpcError>,
    category: AiSessionMentionDiagnosticCategory,
    candidates: &mut Vec<AiSessionMentionCandidate>,
    diagnostics: &mut Vec<AiSessionMentionDiagnostic>,
    normalize: fn(&Value) -> Vec<AiSessionMentionCandidate>,
) {
    match result {
        Ok(value) => candidates.extend(normalize(&value)),
        Err(error) => diagnostics.push(AiSessionMentionDiagnostic {
            category,
            code: "CATALOG_QUERY_FAILED".to_string(),
            message: error.message.chars().take(2000).collect(),
        }),
    }
}

fn normalize_skill_candidates(value: &Value) -> Vec<AiSessionMentionCandidate> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry
                .get("skills")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|skill| {
            if skill.get("enabled").and_then(Value::as_bool) != Some(true) {
                return None;
            }
            let name = non_empty_string(skill.get("name"))?;
            let path = non_empty_string(skill.get("path"))?;
            if !Path::new(&path).is_absolute() {
                return None;
            }
            let interface = skill.get("interface").unwrap_or(&Value::Null);
            Some(AiSessionMentionCandidate {
                kind: AiSessionMentionKind::Skill,
                name: non_empty_string(interface.get("displayName")).unwrap_or(name),
                description: non_empty_string(interface.get("shortDescription"))
                    .or_else(|| non_empty_string(skill.get("shortDescription")))
                    .or_else(|| non_empty_string(skill.get("description"))),
                path,
                icon: None,
            })
        })
        .collect()
}

fn normalize_plugin_candidates(value: &Value) -> Vec<AiSessionMentionCandidate> {
    value
        .get("marketplaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|marketplace| {
            marketplace
                .get("plugins")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|plugin| {
            if plugin.get("installed").and_then(Value::as_bool) != Some(true)
                || plugin.get("enabled").and_then(Value::as_bool) != Some(true)
                || plugin.get("availability").and_then(Value::as_str) == Some("DISABLED_BY_ADMIN")
            {
                return None;
            }
            let id = non_empty_string(plugin.get("id"))?;
            let name = non_empty_string(plugin.get("name"))?;
            let interface = plugin.get("interface").unwrap_or(&Value::Null);
            Some(AiSessionMentionCandidate {
                kind: AiSessionMentionKind::Plugin,
                name: non_empty_string(interface.get("displayName")).unwrap_or(name),
                description: non_empty_string(interface.get("shortDescription"))
                    .or_else(|| non_empty_string(plugin.get("description"))),
                path: format!("plugin://{id}"),
                icon: None,
            })
        })
        .collect()
}

fn normalize_app_candidates(value: &Value) -> Vec<AiSessionMentionCandidate> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|app| {
            if app.get("isAccessible").and_then(Value::as_bool) != Some(true)
                || app.get("isEnabled").and_then(Value::as_bool) != Some(true)
            {
                return None;
            }
            let id = non_empty_string(app.get("id"))?;
            let name = non_empty_string(app.get("name"))?;
            Some(AiSessionMentionCandidate {
                kind: AiSessionMentionKind::App,
                name,
                description: non_empty_string(app.get("description")),
                path: format!("app://{id}"),
                icon: non_empty_string(app.get("logoUrl")),
            })
        })
        .collect()
}

fn normalize_file_mention_candidates(
    values: &[Value],
    cwd: &Path,
) -> Vec<AiSessionMentionCandidate> {
    let cwd = normalize_path_lexically(cwd);
    values
        .iter()
        .filter_map(|file| {
            let path = file.get("path").and_then(Value::as_str)?.trim();
            if path.is_empty() {
                return None;
            }
            let absolute = if Path::new(path).is_absolute() {
                PathBuf::from(path)
            } else {
                cwd.join(path)
            };
            let absolute = normalize_path_lexically(&absolute);
            let relative = absolute.strip_prefix(&cwd).ok()?;
            if relative.as_os_str().is_empty() {
                return None;
            }
            let match_type = file
                .get("match_type")
                .or_else(|| file.get("matchType"))
                .and_then(Value::as_str)
                .unwrap_or("file")
                .to_ascii_lowercase();
            let kind = if match_type == "directory" {
                AiSessionMentionKind::Directory
            } else {
                AiSessionMentionKind::File
            };
            let name = non_empty_string(file.get("file_name"))
                .or_else(|| non_empty_string(file.get("fileName")))
                .or_else(|| {
                    relative
                        .file_name()
                        .map(|value| value.to_string_lossy().to_string())
                })?;
            Some(AiSessionMentionCandidate {
                kind,
                name,
                description: None,
                path: relative
                    .components()
                    .map(|component| component.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/"),
                icon: None,
            })
        })
        .take(200)
        .collect()
}

fn dedupe_mentions(candidates: &mut Vec<AiSessionMentionCandidate>) {
    let mut seen = std::collections::HashSet::new();
    candidates
        .retain(|candidate| seen.insert(format!("{}:{}", candidate.kind.as_str(), candidate.path)));
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn publish_thread_snapshot(client: &CodexAppServerClient, snapshot: &CodexThreadSnapshot) {
    let _ = client.inner.events.send(ProviderEvent::ThreadSnapshot {
        provider_session_id: snapshot.provider_session_id.clone(),
        cwd: non_empty(&snapshot.cwd),
        name: snapshot.name.clone(),
        model: snapshot.model.clone(),
        model_provider: snapshot.model_provider.clone(),
        model_selection: None,
        reasoning_effort: snapshot.reasoning_effort.clone(),
        status: snapshot.status.clone(),
        phase: Some(snapshot.phase.clone()),
    });
    let _ = client.inner.events.send(ProviderEvent::SubAgentSnapshot {
        provider_session_id: snapshot.provider_session_id.clone(),
        sub_agents: snapshot.sub_agents.clone(),
    });
}

fn project_thread_item_entries(entries: Vec<(String, Value)>) -> Vec<AiSessionTimelineItem> {
    entries
        .into_iter()
        .filter_map(|(turn_id, item)| project_thread_item_value(&turn_id, &item))
        .collect()
}

fn project_thread_turns(turns: &Value) -> Vec<AiSessionTimelineItem> {
    turns
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .flat_map(|(turn_index, turn)| {
            let turn_id = turn
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("turn_{turn_index}"));
            turn.get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
                .filter_map(move |(item_index, item)| {
                    let item_id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                        .unwrap_or_else(|| format!("{turn_id}:item_{item_index}"));
                    project_codex_timeline_item(&item_id, &turn_id, item)
                })
        })
        .collect()
}

fn project_thread_item_value(turn_id: &str, item: &Value) -> Option<AiSessionTimelineItem> {
    let item_id = item.get("id").and_then(Value::as_str)?;
    project_codex_timeline_item(item_id, turn_id, item)
}

fn project_codex_notification_timeline_item(
    item: &Value,
    turn_id: &str,
    running: bool,
) -> Option<AiSessionTimelineItem> {
    let mut item = item.clone();
    if item.get("status").and_then(Value::as_str).is_none() {
        item["status"] = json!(if running { "inProgress" } else { "completed" });
    }
    project_thread_item_value(turn_id, &item)
}

fn project_codex_timeline_item(
    id: &str,
    turn_id: &str,
    item: &Value,
) -> Option<AiSessionTimelineItem> {
    match item.get("type").and_then(Value::as_str).unwrap_or_default() {
        "userMessage" => {
            let text = text_from_user_message_item(item)?;
            if is_synthetic_user_transcript_text(&text) {
                None
            } else {
                Some(AiSessionTimelineItem::UserMessage {
                    id: id.to_string(),
                    turn_id: turn_id.to_string(),
                    text,
                    attachments: None,
                })
            }
        }
        "agentMessage" => item
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|text| AiSessionTimelineItem::AiMessage {
                id: id.to_string(),
                turn_id: turn_id.to_string(),
                text: text.to_string(),
            }),
        "reasoning" => None,
        activity_kind => Some(project_codex_timeline_activity(
            id,
            turn_id,
            activity_kind,
            item,
        )),
    }
}

fn project_codex_timeline_activity(
    id: &str,
    turn_id: &str,
    activity_kind: &str,
    item: &Value,
) -> AiSessionTimelineItem {
    let tool = codex_tool_descriptor(item, None);
    let title = tool
        .as_ref()
        .and_then(|tool| tool.get("name"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| activity_title(activity_kind));
    let mut summary = None;
    let mut input = None;
    let mut output = None;
    let mut paths = None;
    let mut exit_code = None;
    let duration_ms = item.get("durationMs").and_then(Value::as_u64);
    match activity_kind {
        "plan" => summary = string_field(item, "text"),
        "codexRetry" => summary = string_field(item, "message"),
        "hookPrompt" => summary = hook_prompt_text(item),
        "commandExecution" => {
            input = string_field(item, "command");
            output = string_field(item, "aggregatedOutput");
            exit_code = item.get("exitCode").and_then(Value::as_i64);
        }
        "fileChange" => {
            let changes = item
                .get("changes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut item_paths = Vec::new();
            for change in &changes {
                if let Some(path) = change.get("path").and_then(Value::as_str) {
                    if !path.is_empty() && !item_paths.iter().any(|known| known == path) {
                        item_paths.push(path.to_string());
                    }
                }
            }
            summary = (!item_paths.is_empty()).then(|| item_paths.join(", "));
            paths = (!item_paths.is_empty()).then_some(item_paths);
            output = safe_json(Some(&Value::Array(changes)));
        }
        "mcpToolCall" => {
            input = safe_json(item.get("arguments"));
            output = safe_json(
                item.get("error")
                    .filter(|value| js_truthy(value))
                    .or_else(|| item.get("result")),
            );
        }
        "dynamicToolCall" => {
            input = safe_json(item.get("arguments"));
            output = safe_json(item.get("contentItems"));
        }
        "collabAgentToolCall" => {
            input = string_field(item, "prompt");
            output = safe_json(item.get("agentsStates"));
        }
        "subAgentActivity" => {
            summary = [string_field(item, "kind"), string_field(item, "agentPath")]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ")
                .into_option();
        }
        "webSearch" => input = string_field(item, "query"),
        "imageView" => paths = string_field(item, "path").map(|path| vec![path]),
        "sleep" => {
            summary = duration_ms.map(|duration| format!("{duration} ms"));
        }
        "imageGeneration" => {
            input = string_field(item, "revisedPrompt");
            output = safe_json(item.get("result"));
        }
        "enteredReviewMode" | "exitedReviewMode" => summary = string_field(item, "review"),
        _ => {}
    }
    AiSessionTimelineItem::Activity {
        id: id.to_string(),
        turn_id: turn_id.to_string(),
        activity_kind: activity_kind.to_string(),
        title,
        status: if activity_kind == "contextCompaction" {
            Some(AiSessionTimelineActivityStatus::Completed)
        } else {
            timeline_activity_status(item.get("status"))
        },
        summary: bounded(summary, 4_000),
        input: bounded(input, 100_000),
        output: bounded(output, 1_000_000),
        paths: paths.map(|mut values| {
            values.truncate(500);
            values
        }),
        exit_code,
        duration_ms,
    }
}

fn merge_codex_timeline_items(
    snapshot: &[AiSessionTimelineItem],
    events: &[AiSessionTimelineItem],
) -> Vec<AiSessionTimelineItem> {
    if events.is_empty() {
        return snapshot.to_vec();
    }
    let mut event_by_id = HashMap::<String, usize>::new();
    let mut event_indexes_by_identity = HashMap::<String, Vec<usize>>::new();
    for (index, item) in events.iter().enumerate() {
        event_by_id.insert(item.id().to_string(), index);
        event_indexes_by_identity
            .entry(codex_timeline_semantic_identity(item))
            .or_default()
            .push(index);
    }
    let mut consumed = std::collections::HashSet::<usize>::new();
    let aligned = snapshot
        .iter()
        .map(|item| {
            if let Some(index) = event_by_id.get(item.id()).copied() {
                consumed.insert(index);
                return events[index].clone();
            }
            if let Some(index) = event_indexes_by_identity
                .get(&codex_timeline_semantic_identity(item))
                .and_then(|indexes| {
                    indexes
                        .iter()
                        .copied()
                        .find(|index| !consumed.contains(index))
                })
            {
                consumed.insert(index);
                events[index].clone()
            } else {
                item.clone()
            }
        })
        .collect::<Vec<_>>();
    merge_timeline_items(&aligned, events)
}

fn merge_timeline_items(
    snapshot: &[AiSessionTimelineItem],
    live_items: &[AiSessionTimelineItem],
) -> Vec<AiSessionTimelineItem> {
    if live_items.is_empty() {
        return snapshot.to_vec();
    }
    let mut live_by_id = Vec::<(String, AiSessionTimelineItem)>::new();
    for item in live_items {
        if let Some((_, current)) = live_by_id.iter_mut().find(|(id, _)| id == item.id()) {
            *current = item.clone();
        } else {
            live_by_id.push((item.id().to_string(), item.clone()));
        }
    }
    let snapshot_ids = snapshot
        .iter()
        .map(|item| item.id().to_string())
        .collect::<std::collections::HashSet<_>>();
    let mut insert_before = HashMap::<String, Vec<AiSessionTimelineItem>>::new();
    let mut pending = Vec::new();
    for (_, item) in &live_by_id {
        if !snapshot_ids.contains(item.id()) {
            pending.push(item.clone());
            continue;
        }
        if !pending.is_empty() {
            insert_before.insert(item.id().to_string(), std::mem::take(&mut pending));
        }
    }
    let mut merged = Vec::new();
    for item in snapshot {
        if let Some(items) = insert_before.remove(item.id()) {
            merged.extend(items);
        }
        merged.push(
            live_by_id
                .iter()
                .find(|(id, _)| id == item.id())
                .map(|(_, item)| item.clone())
                .unwrap_or_else(|| item.clone()),
        );
    }
    merged.extend(pending);
    merged
}

fn codex_timeline_semantic_identity(item: &AiSessionTimelineItem) -> String {
    match item {
        AiSessionTimelineItem::UserMessage { turn_id, text, .. } => {
            serde_json::to_string(&json!([turn_id, "user-message", text])).unwrap_or_default()
        }
        AiSessionTimelineItem::AiMessage { turn_id, text, .. } => {
            serde_json::to_string(&json!([turn_id, "ai-message", text])).unwrap_or_default()
        }
        AiSessionTimelineItem::Activity {
            turn_id,
            activity_kind,
            title,
            summary,
            input,
            output,
            paths,
            exit_code,
            ..
        } => serde_json::to_string(&json!([
            turn_id,
            "activity",
            activity_kind,
            title,
            summary,
            input,
            output,
            paths,
            exit_code,
        ]))
        .unwrap_or_default(),
    }
}

fn timeline_activity_status(value: Option<&Value>) -> Option<AiSessionTimelineActivityStatus> {
    match value.and_then(Value::as_str).unwrap_or_default() {
        "inProgress" => Some(AiSessionTimelineActivityStatus::Running),
        "failed" | "declined" => Some(AiSessionTimelineActivityStatus::Failed),
        "pending" => Some(AiSessionTimelineActivityStatus::Waiting),
        "completed" => Some(AiSessionTimelineActivityStatus::Completed),
        _ => None,
    }
}

fn is_synthetic_user_transcript_text(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "[request interrupted by user]" | "[user interrupted request]"
    )
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
}

fn hook_prompt_text(item: &Value) -> Option<String> {
    let text = item
        .get("fragments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|fragment| fragment.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    (!text.is_empty()).then_some(text)
}

fn safe_json(value: Option<&Value>) -> Option<String> {
    value
        .filter(|value| !value.is_null())
        .map(|value| serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()))
}

fn bounded(value: Option<String>, limit: usize) -> Option<String> {
    let value = value?;
    if controlled_instance_core::text::utf16_len(&value) <= limit {
        return Some(value);
    }
    let mut truncated =
        controlled_instance_core::text::truncate_utf16(&value, limit.saturating_sub(1));
    truncated.push('…');
    Some(truncated)
}

trait OptionStringExt {
    fn into_option(self) -> Option<String>;
}

impl OptionStringExt for String {
    fn into_option(self) -> Option<String> {
        (!self.is_empty()).then_some(self)
    }
}

async fn handle_line(
    inner: &Arc<ClientInner>,
    _generation: u64,
    writer: &mpsc::Sender<String>,
    line: &str,
) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let id = message.get("id").and_then(Value::as_u64);
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if method.is_empty() {
        let Some(id) = id else {
            return;
        };
        let Some(pending) = inner.pending.lock().await.remove(&id) else {
            return;
        };
        if let Some(error) = message.get("error").filter(|value| value.is_object()) {
            let _ = pending.send(Err(CodexRpcError {
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex app-server error.")
                    .to_string(),
                code: error.get("code").and_then(Value::as_i64),
                data: error.get("data").cloned(),
            }));
        } else {
            let _ = pending.send(Ok(message
                .get("result")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}))));
        }
        return;
    }
    let params = message
        .get("params")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(id) = id {
        if APPROVAL_METHODS.contains(&method) {
            if let Some(approval) = approval_from_request(id, method, &params) {
                inner.approvals.lock().await.push(approval.clone());
                let _ = inner.events.send(ProviderEvent::ApprovalRequested {
                    provider_session_id: approval.provider_session_id,
                    turn_id: approval.turn_id,
                    summary: approval.summary,
                    kind: approval.kind,
                    item_id: approval.item_id,
                });
                return;
            }
        }
        if method == "item/tool/call" {
            let _ = writer
                .send(
                    json!({
                        "id": id,
                        "result": {
                            "contentItems": [{ "type": "inputText", "text": "Dynamic tools are not available in this build." }],
                            "success": false
                        }
                    })
                    .to_string(),
                )
                .await;
            return;
        }
        let _ = writer
            .send(
                json!({
                    "id": id,
                    "error": { "code": -32601, "message": "Unsupported Codex app-server request." }
                })
                .to_string(),
            )
            .await;
        return;
    }
    let _ = inner.notifications.send(json!({
        "method": method,
        "params": params,
    }));
    record_live_item(inner, method, &params).await;
    emit_notification(inner, method, &params).await;
}

async fn record_live_item(inner: &Arc<ClientInner>, method: &str, params: &Value) {
    if !matches!(method, "item/started" | "item/completed") {
        return;
    }
    let Some(provider_session_id) = params.get("threadId").and_then(Value::as_str) else {
        return;
    };
    let Some(turn_id) = params.get("turnId").and_then(Value::as_str) else {
        return;
    };
    let Some(item) = params.get("item").filter(|value| value.is_object()) else {
        return;
    };
    let Some(item_id) = item.get("id").and_then(Value::as_str) else {
        return;
    };
    record_live_timeline_item(inner, provider_session_id, turn_id, item_id, item.clone()).await;
}

async fn record_live_timeline_item(
    inner: &Arc<ClientInner>,
    provider_session_id: &str,
    turn_id: &str,
    item_id: &str,
    item: Value,
) {
    let mut live = inner.live_items.lock().await;
    let thread = live.entry(provider_session_id.to_string()).or_default();
    let entry = LiveThreadItem {
        turn_id: turn_id.to_string(),
        item,
    };
    if let Some((_, current)) = thread.iter_mut().find(|(id, _)| id == item_id) {
        *current = entry;
    } else {
        thread.push((item_id.to_string(), entry));
    }
    while thread.len() > 1_000 {
        thread.remove(0);
    }
}

async fn emit_timeline_item(
    inner: &Arc<ClientInner>,
    provider_session_id: &str,
    item: AiSessionTimelineItem,
) {
    let uses_paginated_history = inner
        .paginated_timeline_threads
        .lock()
        .await
        .get(provider_session_id)
        .copied()
        .unwrap_or(false);
    if !uses_paginated_history {
        let store = inner
            .timeline_store
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(store) = store {
            if let Err(error) = store.upsert(provider_session_id, item.clone()) {
                tracing::warn!(
                    %error,
                    provider_session_id,
                    item_id = item.id(),
                    "failed to persist Codex Timeline item"
                );
            }
        }
    }
    let _ = inner.events.send(ProviderEvent::TimelineItem {
        provider_session_id: provider_session_id.to_string(),
        item,
    });
}

async fn clear_thread_approvals(inner: &Arc<ClientInner>, provider_session_id: &str) {
    inner
        .approvals
        .lock()
        .await
        .retain(|approval| approval.provider_session_id != provider_session_id);
}

async fn publish_retry_warning(
    inner: &Arc<ClientInner>,
    provider_session_id: &str,
    turn_id: &str,
    error: &str,
) {
    let item_id = format!("codex_retry:{turn_id}");
    let item = json!({
        "id": item_id,
        "type": "codexRetry",
        "status": "pending",
        "message": error,
    });
    inner.retry_warnings.lock().await.insert(
        provider_session_id.to_string(),
        RetryWarning {
            turn_id: turn_id.to_string(),
            item_id: item_id.clone(),
            error: error.to_string(),
        },
    );
    record_live_timeline_item(inner, provider_session_id, turn_id, &item_id, item).await;
    if let Some(item) = project_codex_timeline_item(
        &item_id,
        turn_id,
        &json!({
            "id": item_id,
            "type": "codexRetry",
            "status": "pending",
            "message": error,
        }),
    ) {
        emit_timeline_item(inner, provider_session_id, item).await;
    }
}

async fn clear_retry_warning(
    inner: &Arc<ClientInner>,
    provider_session_id: &str,
    turn_id: Option<&str>,
) {
    let warning = {
        let mut warnings = inner.retry_warnings.lock().await;
        let matches = warnings
            .get(provider_session_id)
            .is_some_and(|warning| turn_id.is_none_or(|turn_id| warning.turn_id == turn_id));
        matches
            .then(|| warnings.remove(provider_session_id))
            .flatten()
    };
    let Some(warning) = warning else {
        return;
    };
    let item = json!({
        "id": warning.item_id,
        "type": "codexRetry",
        "status": "completed",
        "message": warning.error,
    });
    record_live_timeline_item(
        inner,
        provider_session_id,
        &warning.turn_id,
        &warning.item_id,
        item.clone(),
    )
    .await;
    if let Some(item) = project_codex_timeline_item(&warning.item_id, &warning.turn_id, &item) {
        emit_timeline_item(inner, provider_session_id, item).await;
    }
}

async fn emit_notification(inner: &Arc<ClientInner>, method: &str, params: &Value) {
    let Some(provider_session_id) = params.get("threadId").and_then(Value::as_str) else {
        if method == "thread/started" {
            if let Some(thread) = params.get("thread") {
                if let Some(snapshot) = thread_snapshot(thread, PathBuf::new()) {
                    let _ = inner.events.send(ProviderEvent::ThreadSnapshot {
                        provider_session_id: snapshot.provider_session_id.clone(),
                        cwd: non_empty(snapshot.cwd),
                        name: snapshot.name,
                        model: snapshot.model,
                        model_provider: snapshot.model_provider,
                        model_selection: None,
                        reasoning_effort: snapshot.reasoning_effort,
                        status: snapshot.status,
                        phase: Some(snapshot.phase),
                    });
                    let _ = inner.events.send(ProviderEvent::SubAgentSnapshot {
                        provider_session_id: snapshot.provider_session_id,
                        sub_agents: snapshot.sub_agents,
                    });
                }
            }
        }
        return;
    };
    match method {
        "thread/status/changed" => {
            let (status, phase) =
                thread_lifecycle_from_status(params.get("status").unwrap_or(&Value::Null));
            if phase != "approval" {
                clear_thread_approvals(inner, provider_session_id).await;
            }
            let _ = inner.events.send(ProviderEvent::ThreadSnapshot {
                provider_session_id: provider_session_id.to_string(),
                cwd: None,
                name: None,
                model: None,
                model_provider: None,
                model_selection: None,
                reasoning_effort: None,
                status,
                phase: Some(phase),
            });
        }
        "thread/name/updated" => {}
        "thread/closed" => {
            clear_thread_approvals(inner, provider_session_id).await;
            inner
                .retry_warnings
                .lock()
                .await
                .remove(provider_session_id);
            inner.turn_errors.lock().await.remove(provider_session_id);
            inner.live_items.lock().await.remove(provider_session_id);
            let _ = inner.events.send(ProviderEvent::ThreadClosed {
                provider_session_id: provider_session_id.to_string(),
            });
        }
        "turn/started" => {
            clear_retry_warning(inner, provider_session_id, None).await;
            inner.turn_errors.lock().await.remove(provider_session_id);
            if let Some(turn_id) = params
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
            {
                let started_at = params
                    .get("turn")
                    .and_then(|turn| turn.get("startedAt"))
                    .and_then(iso_from_seconds);
                let _ = inner.events.send(ProviderEvent::TurnStarted {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    started_at,
                });
            }
        }
        "error" => {
            let Some(turn_id) = params.get("turnId").and_then(Value::as_str) else {
                return;
            };
            let Some(error) = params.get("error").and_then(codex_error_message) else {
                return;
            };
            if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
                publish_retry_warning(inner, provider_session_id, turn_id, &error).await;
            } else {
                inner.turn_errors.lock().await.insert(
                    provider_session_id.to_string(),
                    PendingTurnError {
                        turn_id: turn_id.to_string(),
                        error,
                    },
                );
            }
        }
        "turn/completed" => {
            let turn = params.get("turn").unwrap_or(&Value::Null);
            let turn_id = turn
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            clear_retry_warning(inner, provider_session_id, turn_id.as_deref()).await;
            let pending_error = inner.turn_errors.lock().await.remove(provider_session_id);
            let error = turn.get("error").and_then(codex_error_message).or_else(|| {
                pending_error
                    .filter(|pending| {
                        turn_id.is_none() || turn_id.as_deref() == Some(&pending.turn_id)
                    })
                    .map(|pending| pending.error)
            });
            clear_thread_approvals(inner, provider_session_id).await;
            let _ = inner.events.send(ProviderEvent::TurnCompleted {
                provider_session_id: provider_session_id.to_string(),
                turn_id,
                status: turn
                    .get("status")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                error: (turn.get("status").and_then(Value::as_str) == Some("failed"))
                    .then_some(error)
                    .flatten(),
                completed_at: turn.get("completedAt").and_then(iso_from_seconds),
            });
        }
        "thread/realtime/error" => {
            let Some(error) = params
                .get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                return;
            };
            let _ = inner.events.send(ProviderEvent::SessionError {
                provider_session_id: provider_session_id.to_string(),
                error: error.to_string(),
            });
        }
        "thread/compacted" => {
            let Some(turn_id) = params.get("turnId").and_then(Value::as_str) else {
                return;
            };
            clear_retry_warning(inner, provider_session_id, Some(turn_id)).await;
            let _ = inner.events.send(ProviderEvent::ContextCompaction {
                provider_session_id: provider_session_id.to_string(),
                turn_id: turn_id.to_string(),
                item_id: format!("context_compaction:{turn_id}"),
                status: "completed".to_string(),
                observed_at: None,
            });
        }
        "item/agentMessage/delta" => {
            if let (Some(turn_id), Some(item_id), Some(delta)) = (
                params.get("turnId").and_then(Value::as_str),
                params.get("itemId").and_then(Value::as_str),
                params.get("delta").and_then(Value::as_str),
            ) {
                clear_retry_warning(inner, provider_session_id, Some(turn_id)).await;
                let _ = inner.events.send(ProviderEvent::AgentMessageDelta {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    item_id: item_id.to_string(),
                    delta: delta.to_string(),
                });
            }
        }
        "item/started" | "item/completed" => {
            let running = method == "item/started";
            let Some(item) = params.get("item").filter(|value| value.is_object()) else {
                return;
            };
            let Some(turn_id) = params.get("turnId").and_then(Value::as_str) else {
                return;
            };
            let Some(item_id) = item.get("id").and_then(Value::as_str) else {
                return;
            };
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if item_type == "reasoning" {
                return;
            }
            let observed_at = params
                .get(if running {
                    "startedAtMs"
                } else {
                    "completedAtMs"
                })
                .and_then(iso_from_millis);
            let sub_agent_updates = codex_sub_agent_updates(item, observed_at.as_deref());
            if item_type == "contextCompaction" {
                clear_retry_warning(inner, provider_session_id, Some(turn_id)).await;
                if let Some(timeline_item) =
                    project_codex_notification_timeline_item(item, turn_id, running)
                {
                    emit_timeline_item(inner, provider_session_id, timeline_item).await;
                }
                let _ = inner.events.send(ProviderEvent::ContextCompaction {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    item_id: format!("context_compaction:{turn_id}"),
                    status: if running { "running" } else { "completed" }.to_string(),
                    observed_at,
                });
                return;
            }
            if item_type != "userMessage" {
                clear_retry_warning(inner, provider_session_id, Some(turn_id)).await;
            }
            if let Some(timeline_item) =
                project_codex_notification_timeline_item(item, turn_id, running)
            {
                emit_timeline_item(inner, provider_session_id, timeline_item).await;
            }
            if !sub_agent_updates.is_empty() {
                let _ = inner.events.send(ProviderEvent::SubAgentActivity {
                    provider_session_id: provider_session_id.to_string(),
                    updates: sub_agent_updates,
                });
            }
            if item_type == "userMessage" {
                if let Some(text) = text_from_user_message_item(item) {
                    let _ = inner.events.send(ProviderEvent::UserMessage {
                        provider_session_id: provider_session_id.to_string(),
                        turn_id: turn_id.to_string(),
                        item_id: item_id.to_string(),
                        text,
                        observed_at,
                        completed: !running,
                    });
                }
                return;
            }
            if item_type == "agentMessage" && !running {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    let _ = inner.events.send(ProviderEvent::AgentMessageCompleted {
                        provider_session_id: provider_session_id.to_string(),
                        turn_id: turn_id.to_string(),
                        item_id: item_id.to_string(),
                        text: text.to_string(),
                        observed_at,
                    });
                }
                return;
            }
            if codex_item_kind(item) != CodexItemKind::Tool {
                return;
            }
            if let Some(tool) = codex_tool_descriptor(item, observed_at.as_deref()) {
                let _ = inner.events.send(ProviderEvent::ToolActivity {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: Some(turn_id.to_string()),
                    item: tool,
                    running,
                    observed_at,
                });
            }
        }
        _ => {}
    }
}

async fn connection_lost(inner: &Arc<ClientInner>, generation: u64) {
    if inner.generation.load(Ordering::SeqCst) != generation {
        return;
    }
    inner.connected.store(false, Ordering::SeqCst);
    inner
        .title_generation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .reset();
    fail_pending(&inner.pending, "Codex app-server exited.").await;
    inner.approvals.lock().await.clear();
    inner.turn_errors.lock().await.clear();
    inner.retry_warnings.lock().await.clear();
    inner.live_items.lock().await.clear();
    let _ = inner
        .events
        .send(ProviderEvent::ConnectionChanged { connected: false });
}

async fn fail_pending(pending: &PendingRequests, message: &str) {
    let pending = std::mem::take(&mut *pending.lock().await);
    for (_, sender) in pending {
        let _ = sender.send(Err(CodexRpcError {
            message: message.to_string(),
            code: None,
            data: None,
        }));
    }
}

fn approval_from_request(id: u64, method: &str, params: &Value) -> Option<CodexApprovalRequest> {
    let provider_session_id = string_field(params, "threadId")?;
    let turn_id = string_field(params, "turnId");
    let item_id = string_field(params, "itemId");
    let reason = string_field(params, "reason");
    let (kind, summary) = if method == "item/commandExecution/requestApproval" {
        let command = string_field(params, "command");
        let summary = [reason, command.map(|command| format!("Command: {command}"))]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
        (
            "command",
            if summary.is_empty() {
                "Codex is requesting command approval.".to_string()
            } else {
                summary
            },
        )
    } else if method == "item/fileChange/requestApproval" {
        let grant_root = string_field(params, "grantRoot");
        (
            "file-change",
            reason
                .or_else(|| {
                    grant_root.map(|grant_root| format!("Approve file changes under {grant_root}"))
                })
                .unwrap_or_else(|| "Codex is requesting file change approval.".to_string()),
        )
    } else {
        (
            "permissions",
            reason.unwrap_or_else(|| "Codex is requesting additional permissions.".to_string()),
        )
    };
    Some(CodexApprovalRequest {
        response_id: id,
        provider_session_id,
        turn_id,
        item_id,
        summary,
        kind: kind.to_string(),
        params: params.clone(),
    })
}

fn approval_response(approval: &CodexApprovalRequest, decision: &str) -> Value {
    if approval.kind == "permissions" {
        if decision != "allow" {
            return json!({ "permissions": {}, "scope": "turn" });
        }
        let empty = json!({});
        let requested = approval
            .params
            .get("permissions")
            .filter(|value| value.is_object())
            .unwrap_or(&empty);
        let file_system = requested
            .get("fileSystem")
            .filter(|value| value.is_object())
            .unwrap_or(&empty);
        let mut permissions = Map::new();
        if requested.get("network").is_some_and(js_truthy) {
            permissions.insert("network".to_string(), requested["network"].clone());
        }
        let mut allowed_file_system = Map::new();
        for field in ["read", "write", "entries"] {
            if let Some(value) = file_system.get(field).filter(|value| value.is_array()) {
                allowed_file_system.insert(field.to_string(), value.clone());
            }
        }
        if file_system.get("globScanMaxDepth").is_some_and(js_truthy) {
            allowed_file_system.insert(
                "globScanMaxDepth".to_string(),
                file_system["globScanMaxDepth"].clone(),
            );
        }
        if !allowed_file_system.is_empty() {
            permissions.insert("fileSystem".to_string(), Value::Object(allowed_file_system));
        }
        return json!({ "permissions": permissions, "scope": "turn" });
    }
    json!({
        "decision": match decision {
            "allow" => "accept",
            "skip" => "cancel",
            _ => "decline",
        }
    })
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn thread_from_result(
    result: Value,
    fallback_cwd: PathBuf,
    allow_ephemeral: bool,
) -> Result<CodexThreadSnapshot, ProviderError> {
    let thread = result
        .get("thread")
        .filter(|value| value.is_object())
        .ok_or_else(|| {
            ProviderError::bad_gateway(
                "AI_SESSION_PROVIDER_INVALID_RESPONSE",
                "Codex app-server returned no thread identity.",
            )
        })?;
    let mut snapshot = thread_snapshot(thread, fallback_cwd).ok_or_else(|| {
        ProviderError::bad_gateway(
            "AI_SESSION_PROVIDER_INVALID_RESPONSE",
            "Codex app-server returned an invalid thread identity.",
        )
    })?;
    snapshot.turns_authoritative = true;
    if !allow_ephemeral && thread.get("ephemeral").and_then(Value::as_bool) == Some(true) {
        return Err(ProviderError::bad_gateway(
            "AI_SESSION_PROVIDER_INVALID_RESPONSE",
            "Codex app-server returned an ephemeral thread.",
        ));
    }
    snapshot.model = result
        .get("model")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or(snapshot.model);
    snapshot.model_provider = result
        .get("modelProvider")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or(snapshot.model_provider);
    snapshot.reasoning_effort = result
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or(snapshot.reasoning_effort);
    Ok(snapshot)
}

fn thread_snapshot(thread: &Value, fallback_cwd: PathBuf) -> Option<CodexThreadSnapshot> {
    let provider_session_id = thread.get("id").and_then(Value::as_str)?.trim().to_string();
    if provider_session_id.is_empty() {
        return None;
    }
    let cwd = thread
        .get("cwd")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            (!fallback_cwd.as_os_str().is_empty()).then(|| fallback_cwd.display().to_string())
        })
        .unwrap_or_default();
    let (status, phase) = thread_lifecycle_state(thread);
    let lineage = thread
        .get("parentThreadId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|parent| {
            json!({
                "kind": "subagent",
                "parentProviderSessionId": parent,
            })
        })
        .or_else(|| {
            thread
                .get("forkedFromId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|parent| {
                    json!({
                        "kind": "fork",
                        "parentProviderSessionId": parent,
                    })
                })
        });
    let turns = thread.get("turns").cloned().unwrap_or_else(|| json!([]));
    Some(CodexThreadSnapshot {
        provider_session_id,
        cwd,
        name: thread
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToString::to_string),
        model: thread
            .get("model")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        model_provider: thread
            .get("modelProvider")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        reasoning_effort: thread
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        status,
        phase,
        sub_agents: rebuild_codex_sub_agents(&turns, &now_iso()),
        turns,
        paginated_history: thread.get("historyMode").and_then(Value::as_str) == Some("paginated"),
        fork_supported: false,
        lineage,
        turns_authoritative: false,
    })
}

fn project_thread_list_entries(
    threads: Vec<Value>,
    fork_supported: bool,
) -> (
    HashMap<String, CodexThreadSnapshot>,
    Vec<CodexThreadSnapshot>,
) {
    let mut summaries = HashMap::new();
    let mut snapshots = Vec::new();
    for thread in threads {
        if thread.get("ephemeral").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if let Some(mut snapshot) = thread_snapshot(&thread, PathBuf::new()) {
            snapshot.fork_supported = fork_supported;
            summaries.insert(snapshot.provider_session_id.clone(), snapshot.clone());
            snapshots.push(snapshot);
        }
    }
    (summaries, snapshots)
}

fn empty_thread_snapshot(provider_session_id: &str) -> CodexThreadSnapshot {
    CodexThreadSnapshot {
        provider_session_id: provider_session_id.to_string(),
        cwd: String::new(),
        name: None,
        model: None,
        model_provider: None,
        reasoning_effort: None,
        status: "idle".to_string(),
        phase: "unknown".to_string(),
        turns: json!([]),
        sub_agents: Vec::new(),
        paginated_history: false,
        fork_supported: false,
        lineage: None,
        turns_authoritative: false,
    }
}

fn thread_lifecycle_state(thread: &Value) -> (String, String) {
    let status = thread.get("status").unwrap_or(&Value::Null);
    let (mut lifecycle, phase) = thread_lifecycle_from_status(status);
    if !matches!(lifecycle.as_str(), "running" | "waiting")
        && thread
            .get("turns")
            .and_then(Value::as_array)
            .and_then(|turns| turns.last())
            .and_then(|turn| turn.get("status"))
            .and_then(Value::as_str)
            == Some("failed")
    {
        lifecycle = "failed".to_string();
    }
    (lifecycle, phase)
}

fn thread_lifecycle_from_status(status: &Value) -> (String, String) {
    let status_type = status
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let flags = status
        .get("activeFlags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    match status_type {
        "active" if flags.contains("waitingOnApproval") => {
            ("waiting".to_string(), "approval".to_string())
        }
        "active" if flags.contains("waitingOnUserInput") => {
            ("waiting".to_string(), "thinking".to_string())
        }
        "active" => ("running".to_string(), "thinking".to_string()),
        "systemError" => ("failed".to_string(), "unknown".to_string()),
        _ => ("idle".to_string(), "unknown".to_string()),
    }
}

fn temporary_thread_disabled_config() -> serde_json::Map<String, Value> {
    [
        ("features.apps", false),
        ("features.code_mode", false),
        ("features.code_mode_only", false),
        ("features.context_management", false),
        ("features.current_time_reminder", false),
        ("features.deferred_executor", false),
        ("features.enable_fanout", false),
        ("features.goals", false),
        ("features.hooks", false),
        ("features.image_generation", false),
        ("features.memories", false),
        ("features.multi_agent", false),
        ("features.multi_agent_v2", false),
        ("features.plugins", false),
        ("features.request_permissions_tool", false),
        ("features.shell_snapshot", false),
        ("features.shell_tool", false),
        ("features.standalone_web_search", false),
        ("features.token_budget", false),
        ("features.tool_suggest", false),
        ("features.unified_exec", false),
        ("features.view_image", false),
        ("orchestrator.skills.enabled", false),
        ("skills.include_instructions", false),
        ("token_budget.use_history_notes_extension", false),
        ("tools.experimental_request_user_input.enabled", false),
        ("tools.update_plan.enabled", false),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), Value::Bool(value)))
    .chain(std::iter::once((
        "web_search".to_string(),
        Value::String("disabled".to_string()),
    )))
    .collect()
}

fn thread_config(
    reasoning_effort: Option<&str>,
    story_agent_tools: Option<&[String]>,
) -> Map<String, Value> {
    let mut config = Map::new();
    if let Some(reasoning_effort) = reasoning_effort {
        config.insert(
            "model_reasoning_effort".to_string(),
            json!(reasoning_effort),
        );
    }
    if let Some(tools) = story_agent_tools {
        config.insert(
            "mcp_servers.task_handoff_story.enabled".to_string(),
            json!(!tools.is_empty()),
        );
        if !tools.is_empty() {
            config.insert(
                "mcp_servers.task_handoff_story.enabled_tools".to_string(),
                json!(tools),
            );
        }
    }
    config
}

fn apply_permissions(
    params: &mut Map<String, Value>,
    permission_mode: Option<AiSessionPermissionMode>,
) {
    let (approval_policy, reviewer, permissions) = match permission_mode {
        Some(AiSessionPermissionMode::Ask) => ("on-request", "user", ":workspace"),
        Some(AiSessionPermissionMode::AutoReview) => ("on-request", "auto_review", ":workspace"),
        Some(AiSessionPermissionMode::FullAccess) => ("never", "user", ":danger-full-access"),
        None => return,
    };
    params.insert("approvalPolicy".to_string(), json!(approval_policy));
    params.insert("approvalsReviewer".to_string(), json!(reviewer));
    params.insert("permissions".to_string(), json!(permissions));
}

fn prepare_inputs(input: &ProviderMessage) -> Result<(String, Vec<Value>), ProviderError> {
    let mut message = input.message.trim().to_string();
    let mut inputs = vec![json!({
        "type": "text",
        "text": message,
        "text_elements": [],
    })];
    let mut file_paths = Vec::new();
    for attachment in &input.attachments {
        if attachment.meta.kind == AiSessionAttachmentKind::Image {
            let inline_image = if attachment.source == ProviderAttachmentSource::Inline {
                let data = std::fs::read(&attachment.path).map_err(|error| {
                    ProviderError::new(
                        "AI_SESSION_ATTACHMENT_CONTENT_MISSING",
                        format!("Inline attachment content is unavailable: {error}"),
                        400,
                    )
                })?;
                (data.len() as u64 <= AI_SESSION_MAX_INLINE_FILE_BYTES).then(|| {
                    format!(
                        "data:{};base64,{}",
                        attachment.meta.mime,
                        STANDARD.encode(data)
                    )
                })
            } else {
                None
            };
            inputs.push(match inline_image {
                Some(url) => json!({ "type": "image", "url": url }),
                None => json!({
                    "type": "localImage",
                    "path": attachment.path.display().to_string(),
                }),
            });
        } else {
            file_paths.push((attachment.meta.kind, attachment.path.display().to_string()));
        }
    }
    if !file_paths.is_empty() {
        let mut image_index = 0;
        let mut file_index = 0;
        let image_count = file_paths
            .iter()
            .filter(|(kind, _)| *kind == AiSessionAttachmentKind::Image)
            .count();
        let file_count = file_paths
            .iter()
            .filter(|(kind, _)| *kind == AiSessionAttachmentKind::File)
            .count();
        let lines = file_paths
            .iter()
            .map(|(kind, path)| {
                let (label, count, index) = if *kind == AiSessionAttachmentKind::Image {
                    image_index += 1;
                    ("图片", image_count, image_index)
                } else {
                    file_index += 1;
                    ("文件", file_count, file_index)
                };
                let suffix = if count > 1 {
                    index.to_string()
                } else {
                    String::new()
                };
                format!("{label}{suffix}路径：{path}")
            })
            .collect::<Vec<_>>();
        message = [message, lines.join("\n")]
            .into_iter()
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        if let Some(first) = inputs.first_mut() {
            if let Some(object) = first.as_object_mut() {
                object.insert("text".to_string(), json!(message));
            }
        }
    }
    for reference in &input.references {
        inputs.push(if reference.kind == "skill" {
            json!({ "type": "skill", "name": reference.name, "path": reference.path })
        } else {
            json!({ "type": "mention", "name": reference.name, "path": reference.path })
        });
    }
    Ok((message, inputs))
}

fn require_provider_session(session: &AiSession) -> Result<&str, ProviderError> {
    session
        .provider_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_THREAD_NOT_FOUND",
                "AI session is not bound to a Codex thread.",
                404,
            )
        })
}

fn turn_id_from_result(result: &Value) -> Option<String> {
    result
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
        .or_else(|| result.get("turnId").and_then(Value::as_str))
        .map(ToString::to_string)
}

fn is_no_active_turn_error(error: &ProviderError) -> bool {
    error
        .message
        .to_ascii_lowercase()
        .contains("no active turn")
}

fn active_turn_mismatch_found_id(error: &ProviderError) -> Option<String> {
    let lowercase = error.message.to_ascii_lowercase();
    if !lowercase.contains("expected active turn id") {
        return None;
    }
    let marker = "but found `";
    let start = lowercase.find(marker)? + marker.len();
    let rest = error.message.get(start..)?;
    let end = rest.find('`')?;
    (end > 0).then(|| rest[..end].to_string())
}

fn codex_error_message(error: &Value) -> Option<String> {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let details = error
        .get("additionalDetails")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let diagnostic = error
        .get("codexErrorInfo")
        .and_then(codex_error_info_message);
    let mut parts = Vec::new();
    for part in [message.trim(), details.trim()] {
        if !part.is_empty() && !parts.iter().any(|known| known == part) {
            parts.push(part.to_string());
        }
    }
    if let Some(diagnostic) = diagnostic.filter(|diagnostic| !parts.contains(diagnostic)) {
        parts.push(diagnostic);
    }
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

fn codex_error_info_message(value: &Value) -> Option<String> {
    if let Some(value) = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(format!("Codex error: {value}"));
    }
    let (code, details) = value.as_object()?.iter().next()?;
    if code.trim().is_empty() {
        return None;
    }
    let status = details
        .get("httpStatusCode")
        .and_then(Value::as_i64)
        .map(|status| format!(" (HTTP {status})"))
        .unwrap_or_default();
    Some(format!("Codex error: {code}{status}"))
}

fn text_from_user_message_item(item: &Value) -> Option<String> {
    let text = item
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|content| {
            (content.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| {
                    content
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim()
                })
                .filter(|value| !value.is_empty())
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    (!text.is_empty()).then_some(text)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexItemKind {
    Tool,
    NonTool,
    Unknown,
}

fn codex_item_kind(item: &Value) -> CodexItemKind {
    match item.get("type").and_then(Value::as_str).unwrap_or_default() {
        "commandExecution"
        | "fileChange"
        | "mcpToolCall"
        | "dynamicToolCall"
        | "collabAgentToolCall"
        | "webSearch"
        | "imageView"
        | "sleep"
        | "imageGeneration" => CodexItemKind::Tool,
        "userMessage" | "hookPrompt" | "agentMessage" | "plan" | "reasoning"
        | "subAgentActivity" | "enteredReviewMode" | "exitedReviewMode" | "contextCompaction" => {
            CodexItemKind::NonTool
        }
        _ => CodexItemKind::Unknown,
    }
}

fn codex_tool_descriptor(item: &Value, started_at: Option<&str>) -> Option<Value> {
    if codex_item_kind(item) != CodexItemKind::Tool {
        return None;
    }
    let item_type = item.get("type").and_then(Value::as_str)?;
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToString::to_string)?;
    let (name, input_preview) = match item_type {
        "commandExecution" => (
            "Command".to_string(),
            item.get("command")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        ),
        "fileChange" => {
            let paths = item
                .get("changes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|change| change.get("path").and_then(Value::as_str))
                .fold(Vec::new(), |mut paths, path| {
                    if !path.is_empty() && !paths.iter().any(|known| known == path) {
                        paths.push(path.to_string());
                    }
                    paths
                });
            (
                "File change".to_string(),
                Some(paths.join(", ")).filter(|value| !value.is_empty()),
            )
        }
        "mcpToolCall" => {
            let server = item
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("Tool");
            (
                if server.is_empty() {
                    tool.to_string()
                } else {
                    format!("{server} · {tool}")
                },
                compact_json(item.get("arguments")),
            )
        }
        "dynamicToolCall" => {
            let namespace = item
                .get("namespace")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("Tool");
            (
                if namespace.is_empty() {
                    tool.to_string()
                } else {
                    format!("{namespace} · {tool}")
                },
                compact_json(item.get("arguments")),
            )
        }
        "webSearch" => (
            "Web search".to_string(),
            item.get("query")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        ),
        "imageView" => (
            "View image".to_string(),
            item.get("path")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        ),
        "imageGeneration" => (
            "Image generation".to_string(),
            item.get("revisedPrompt")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        ),
        "sleep" => (
            "Sleep".to_string(),
            item.get("durationMs")
                .and_then(Value::as_u64)
                .map(|duration| format!("{duration} ms")),
        ),
        "collabAgentToolCall" => {
            let tool = item
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("collabAgentToolCall");
            let name = match tool {
                "spawnAgent" => "Spawn agent",
                "sendInput" => "Send agent input",
                "resumeAgent" => "Resume agent",
                "wait" => "Wait for agents",
                "closeAgent" => "Close agent",
                _ => tool,
            };
            (
                name.to_string(),
                item.get("prompt")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            )
        }
        _ => return None,
    };
    let mut tool = Map::new();
    tool.insert("id".to_string(), json!(id));
    tool.insert("kind".to_string(), json!(item_type));
    tool.insert("name".to_string(), json!(name));
    if let Some(input_preview) = input_preview {
        if let Some(input_preview) = compact_preview(&input_preview) {
            tool.insert("inputPreview".to_string(), json!(input_preview));
        }
    }
    if let Some(started_at) = started_at {
        tool.insert("startedAt".to_string(), json!(started_at));
    }
    Some(Value::Object(tool))
}

fn compact_json(value: Option<&Value>) -> Option<String> {
    value
        .filter(|value| !value.is_null())
        .map(|value| serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()))
}

fn activity_title(kind: &str) -> String {
    match kind {
        "reasoning" => "Reasoning",
        "plan" => "Plan",
        "hookPrompt" => "Hook prompt",
        "subAgentActivity" => "Sub-agent activity",
        "enteredReviewMode" => "Entered review mode",
        "exitedReviewMode" => "Exited review mode",
        "contextCompaction" => "Context compaction",
        "codexRetry" => "Codex retry",
        _ => kind,
    }
    .to_string()
}

fn parse_codex_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|token| {
        let candidate = token.trim_start_matches('v');
        let mut parts = candidate.split('.');
        let major = parts.next()?.parse::<u64>().ok()?;
        let minor = parts.next()?.parse::<u64>().ok()?;
        let patch = parts
            .next()?
            .split(['-', '+'])
            .next()?
            .parse::<u64>()
            .ok()?;
        Some(format!("{major}.{minor}.{patch}"))
    })
}

fn codex_model_provider_for_selection(selection: &AiSessionModelSelection) -> String {
    non_empty(&selection.model_entity_id)
        .map(|entity_id| codex_model_provider_id(&entity_id))
        .or_else(|| {
            std::env::var("TASK_HANDOFF_CODEX_MODEL_PROVIDER")
                .ok()
                .and_then(non_empty)
        })
        .unwrap_or_else(|| "openai".to_string())
}

fn session_resume_options(session: &AiSession) -> CodexThreadResumeOptions {
    let selection = session
        .model_selection
        .clone()
        .and_then(|value| serde_json::from_value::<AiSessionModelSelection>(value).ok());
    CodexThreadResumeOptions {
        model: selection
            .as_ref()
            .map(|selection| selection.upstream_name().to_string()),
        model_provider: selection.as_ref().map(codex_model_provider_for_selection),
        reasoning_effort: Some(
            session
                .reasoning_effort
                .clone()
                .unwrap_or_else(|| DEFAULT_REASONING_EFFORT.to_string()),
        ),
        story_agent_tools: None,
    }
}

fn verify_thread_selection(
    snapshot: &CodexThreadSnapshot,
    requested: Option<&AiSessionModelSelection>,
) -> Result<(), ProviderError> {
    let Some(requested) = requested else {
        return Ok(());
    };
    let (Some(actual_model), Some(actual_provider)) = (
        snapshot.model.as_deref(),
        snapshot.model_provider.as_deref(),
    ) else {
        return Err(ProviderError::bad_gateway(
            "AI_SESSION_MODEL_SELECTION_INVALID_RESPONSE",
            "Codex did not confirm the requested provider and model.",
        ));
    };
    let expected_provider = codex_model_provider_for_selection(requested);
    if requested.upstream_name() != actual_model || expected_provider != actual_provider {
        return Err(ProviderError::bad_gateway(
            "AI_SESSION_MODEL_SELECTION_INVALID_RESPONSE",
            "Codex acknowledged a different provider or model.",
        ));
    }
    Ok(())
}

fn codex_thread_settings_update_supported(version: &str) -> bool {
    parse_version_components(version)
        .is_some_and(|parsed| compare_versions(parsed.version, THREAD_SETTINGS_UPDATE_MIN_VERSION))
}

fn codex_thread_fork_capabilities(version: &str) -> CodexThreadForkCapabilities {
    let Some(parsed) = parse_version_components(version) else {
        return CodexThreadForkCapabilities::default();
    };
    CodexThreadForkCapabilities {
        full_history: compare_versions(parsed.version, FULL_HISTORY_FORK_MIN_VERSION),
        through_turn: compare_versions(parsed.version, THREAD_FORK_THROUGH_TURN_MIN_VERSION),
    }
}

fn codex_paginated_timeline_supported(version: &str) -> bool {
    let Some(parsed) = parse_version_components(version) else {
        return false;
    };
    if parsed.version != NATIVE_TIMELINE_MIN_VERSION {
        return compare_versions(parsed.version, NATIVE_TIMELINE_MIN_VERSION);
    }
    match parsed.prerelease {
        Some((channel, number)) if channel.eq_ignore_ascii_case("alpha") => number >= 18,
        _ => true,
    }
}

struct ParsedCodexVersion<'a> {
    version: [u64; 3],
    prerelease: Option<(&'a str, u64)>,
}

fn parse_version_components(input: &str) -> Option<ParsedCodexVersion<'_>> {
    let bytes = input.as_bytes();
    for (start, byte) in bytes.iter().enumerate() {
        if !byte.is_ascii_digit() {
            continue;
        }
        if start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'.') {
            continue;
        }
        let rest = &input[start..];
        let end = rest
            .find(|character: char| {
                !character.is_ascii_alphanumeric()
                    && character != '.'
                    && character != '-'
                    && character != '+'
            })
            .unwrap_or(rest.len());
        let candidate = &rest[..end];
        let core = candidate.split(['-', '+']).next().unwrap_or(candidate);
        let mut components = core.split('.');
        let major = components.next()?.parse::<u64>().ok()?;
        let minor = components.next()?.parse::<u64>().ok()?;
        let patch = components.next()?.parse::<u64>().ok()?;
        let prerelease = candidate
            .split_once('-')
            .map(|(_, prerelease)| prerelease)
            .and_then(|prerelease| {
                let mut parts = prerelease.split('.');
                let channel = parts.next()?;
                let number = parts.next()?.parse::<u64>().ok()?;
                Some((channel, number))
            });
        return Some(ParsedCodexVersion {
            version: [major, minor, patch],
            prerelease,
        });
    }
    None
}

fn compare_versions(version: [u64; 3], minimum: [u64; 3]) -> bool {
    version >= minimum
}

fn iso_from_seconds(value: &Value) -> Option<String> {
    let seconds = value.as_f64()?;
    DateTime::<Utc>::from_timestamp(
        seconds.trunc() as i64,
        ((seconds.fract()) * 1_000_000_000.0) as u32,
    )
    .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn iso_from_millis(value: &Value) -> Option<String> {
    let millis = value.as_i64()?;
    DateTime::<Utc>::from_timestamp_millis(millis)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn compact_preview(value: &str) -> Option<String> {
    let mut compacted = String::new();
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_whitespace() || character == '\u{feff}' {
            pending_space = !compacted.is_empty();
            continue;
        }
        if pending_space {
            compacted.push(' ');
            pending_space = false;
        }
        compacted.push(character);
    }
    if compacted.is_empty() {
        return None;
    }
    if controlled_instance_core::text::utf16_len(&compacted) <= 500 {
        return Some(compacted);
    }
    let mut truncated = controlled_instance_core::text::truncate_utf16(&compacted, 497);
    truncated.push_str("...");
    Some(truncated)
}

fn non_empty(value: impl AsRef<str>) -> Option<String> {
    let value = value.as_ref().trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn websocket_rpc_url(endpoint: &str) -> String {
    format!("{endpoint}/rpc")
}

fn build_websocket_request(
    endpoint: &str,
    token: Option<&str>,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, ProviderError> {
    use tokio_tungstenite::tungstenite::{
        client::IntoClientRequest,
        http::header::{HeaderValue, AUTHORIZATION},
    };

    let mut request = websocket_rpc_url(endpoint)
        .into_client_request()
        .map_err(|error| {
            ProviderError::new(
                "AI_SESSION_PROVIDER_UNAVAILABLE",
                format!("Codex app-server websocket endpoint is invalid: {endpoint} ({error})"),
                503,
            )
        })?;
    if let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) {
        let bearer = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|error| {
            ProviderError::new(
                "AI_SESSION_PROVIDER_UNAVAILABLE",
                format!("Codex app-server capability token is invalid: {error}"),
                503,
            )
        })?;
        request.headers_mut().insert(AUTHORIZATION, bearer);
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_protocol::{AiSessionCounters, AiSessionQueue};

    fn test_client() -> CodexAppServerClient {
        CodexAppServerClient::with_command("missing-codex-for-notification-tests")
    }

    async fn rpc_test_transport(client: &CodexAppServerClient) -> mpsc::Receiver<String> {
        let (writer, written) = mpsc::channel(4);
        *client.inner.connection.lock().await = Some(Connection {
            writer,
            child: None,
            shutdown: None,
        });
        client.inner.connected.store(true, Ordering::SeqCst);
        written
    }

    #[tokio::test]
    async fn unsupported_thread_sources_are_remembered_for_later_discovery() {
        let client = test_client();
        let mut written = rpc_test_transport(&client).await;
        let server = client.clone();
        let responder = tokio::spawn(async move {
            for index in 0..3 {
                let request: Value = serde_json::from_str(&written.recv().await.unwrap()).unwrap();
                assert_eq!(request["method"], "thread/list");
                assert_eq!(
                    request["params"]["sourceKinds"]
                        .as_array()
                        .unwrap()
                        .is_empty(),
                    index != 0
                );
                let response = if index == 0 {
                    Err(CodexRpcError {
                        code: Some(-32602),
                        message: "unsupported sources".into(),
                        data: None,
                    })
                } else {
                    Ok(json!({"data": []}))
                };
                server
                    .inner
                    .pending
                    .lock()
                    .await
                    .remove(&request["id"].as_u64().unwrap())
                    .unwrap()
                    .send(response)
                    .unwrap();
            }
        });
        assert!(client.list_threads().await.unwrap().is_empty());
        assert!(client.list_threads().await.unwrap().is_empty());
        responder.await.unwrap();
    }

    #[tokio::test]
    async fn unsupported_fork_disables_capability_and_further_requests() {
        let client = test_client();
        *client.inner.capability_version.write().unwrap() = Some("0.145.0".into());
        let mut written = rpc_test_transport(&client).await;
        let server = client.clone();
        let responder = tokio::spawn(async move {
            let request: Value = serde_json::from_str(&written.recv().await.unwrap()).unwrap();
            assert_eq!(request["method"], "thread/fork");
            server
                .inner
                .pending
                .lock()
                .await
                .remove(&request["id"].as_u64().unwrap())
                .unwrap()
                .send(Err(CodexRpcError {
                    code: Some(-32601),
                    message: "no fork".into(),
                    data: None,
                }))
                .unwrap();
        });
        let input = ProviderCreateInput {
            cwd: PathBuf::from("/tmp"),
            runtime_workspace_roots: Vec::new(),
            permission_mode: None,
            model_selection: None,
            reasoning_effort: None,
            story_agent_tools: None,
        };
        assert!(client.thread_fork_capabilities().full_history);
        for _ in 0..2 {
            let error = client
                .fork_thread("thread-1", None, None, &input)
                .await
                .unwrap_err();
            assert_eq!(error.code, "AI_SESSION_FORK_UNSUPPORTED");
        }
        assert!(!client.thread_fork_capabilities().full_history);
        responder.await.unwrap();
    }

    #[tokio::test]
    async fn title_generation_is_cancelled_by_manual_rename_and_disconnect() {
        let client = test_client();
        client.inner.connected.store(true, Ordering::SeqCst);
        let provider = CodexAppServerProvider::new(client.clone(), None);
        provider.arm_title_generation("thread-1");
        let request = provider.take_armed_title_generation("thread-1").unwrap();
        assert!(provider.title_generation_is_current("thread-1", request));
        provider.rename_session(&test_session(), "").await.unwrap();
        assert!(!provider.title_generation_is_current("thread-1", request));

        provider.arm_title_generation("thread-1");
        let newer = provider.take_armed_title_generation("thread-1").unwrap();
        assert_ne!(newer, request);
        provider.arm_title_generation("thread-2");
        connection_lost(&client.inner, 0).await;
        client.inner.connected.store(true, Ordering::SeqCst);
        assert!(!provider.title_generation_is_current("thread-1", newer));
        assert!(provider.take_armed_title_generation("thread-2").is_none());
    }

    fn test_approval(id: u64) -> CodexApprovalRequest {
        CodexApprovalRequest {
            response_id: id,
            provider_session_id: "thread-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("item-1".to_string()),
            summary: "Approve command".to_string(),
            kind: "command".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
            }),
        }
    }

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

    fn drain_events(events: &mut broadcast::Receiver<ProviderEvent>) -> Vec<ProviderEvent> {
        let mut drained = Vec::new();
        while let Ok(event) = events.try_recv() {
            drained.push(event);
        }
        drained
    }

    #[test]
    fn sub_agent_tracker_matches_node_updates_sorting_and_limit() {
        let activity = codex_sub_agent_updates(
            &json!({
                "type": "subAgentActivity",
                "agentThreadId": "sub-1",
                "agentPath": "researcher",
                "kind": "started"
            }),
            Some("2026-11-02T00:00:01.000Z"),
        );
        assert_eq!(activity[0]["status"], "pending-init");
        assert_eq!(activity[0]["activity"], "started");
        assert_eq!(activity[0]["path"], "researcher");

        let states = codex_sub_agent_updates(
            &json!({
                "type": "collabAgentToolCall",
                "agentsStates": {
                    "sub-2": { "status": "running", "message": "working" },
                    "sub-3": { "status": "notFound" }
                }
            }),
            Some("2026-11-02T00:00:02.000Z"),
        );
        assert_eq!(states.len(), 2);
        assert!(states.iter().any(|update| {
            update["threadId"] == "sub-2"
                && update["status"] == "running"
                && update["message"] == "working"
        }));

        let mut tracker = CodexSubAgentTracker::default();
        let snapshot = tracker.apply(&activity, "2026-11-02T00:00:01.000Z");
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0]["threadId"], "sub-1");
        assert_eq!(snapshot[0]["path"], "researcher");

        let snapshot = tracker.apply(&states, "2026-11-02T00:00:02.000Z");
        assert_eq!(snapshot.len(), 3);
        assert_eq!(snapshot[0]["threadId"], "sub-1");
        assert_eq!(snapshot[1]["threadId"], "sub-2");
        assert_eq!(snapshot[2]["threadId"], "sub-3");

        for index in 0..55 {
            let update = json!({
                "threadId": format!("bulk-{index:02}"),
                "status": "running",
                "observation": "state",
                "observedAt": "2026-11-01T00:00:00.000Z"
            });
            tracker.apply(&[update], "2026-11-01T00:00:00.000Z");
        }
        let snapshot = tracker.current_snapshot();
        assert_eq!(snapshot.len(), 50);
        assert!(snapshot.iter().any(|value| value["threadId"] == "sub-1"));
        assert!(!snapshot.iter().any(|value| value["threadId"] == "bulk-54"));

        let completed = json!({
            "threadId": "sub-1",
            "status": "completed",
            "observation": "state",
            "observedAt": "2026-11-02T00:00:04.000Z"
        });
        let snapshot = tracker.apply(&[completed], "2026-11-02T00:00:04.000Z");
        assert!(!snapshot.iter().any(|value| value["threadId"] == "sub-1"));
    }

    #[test]
    fn sub_agent_snapshots_rebuild_from_thread_turns() {
        let snapshot = thread_snapshot(
            &json!({
                "id": "thread-1",
                "cwd": "/workspace",
                "turns": [{
                    "id": "turn-1",
                    "items": [{
                        "type": "subAgentActivity",
                        "agentThreadId": "sub-1",
                        "agentPath": "researcher",
                        "kind": "interacted"
                    }]
                }]
            }),
            PathBuf::new(),
        )
        .expect("thread snapshot");
        assert_eq!(snapshot.sub_agents.len(), 1);
        assert_eq!(snapshot.sub_agents[0]["threadId"], "sub-1");
        assert_eq!(snapshot.sub_agents[0]["status"], "running");
        assert_eq!(snapshot.sub_agents[0]["path"], "researcher");
    }

    #[tokio::test]
    async fn live_timeline_items_keep_first_event_order() {
        let client = test_client();
        for item_id in ["item-z", "item-a", "item-m"] {
            record_live_timeline_item(
                &client.inner,
                "thread-1",
                "turn-1",
                item_id,
                json!({ "id": item_id, "type": "commandExecution", "status": "inProgress" }),
            )
            .await;
        }
        record_live_timeline_item(
            &client.inner,
            "thread-1",
            "turn-1",
            "item-z",
            json!({ "id": "item-z", "type": "commandExecution", "status": "completed" }),
        )
        .await;

        let ids = client
            .live_items("thread-1")
            .await
            .into_iter()
            .map(|(_, item)| item["id"].as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["item-z", "item-a", "item-m"]);
    }

    #[test]
    fn collab_tool_titles_match_node() {
        for (tool, expected) in [
            ("spawnAgent", "Spawn agent"),
            ("sendInput", "Send agent input"),
            ("resumeAgent", "Resume agent"),
            ("wait", "Wait for agents"),
            ("closeAgent", "Close agent"),
        ] {
            let descriptor = codex_tool_descriptor(
                &json!({
                    "id": "collab-1",
                    "type": "collabAgentToolCall",
                    "tool": tool
                }),
                None,
            )
            .expect("tool descriptor");
            assert_eq!(descriptor["name"], expected);
        }
    }

    #[test]
    fn codex_capabilities_follow_the_artifact_version_contract() {
        assert!(!codex_thread_settings_update_supported(
            "codex_cli_rs/0.132.9"
        ));
        assert!(codex_thread_settings_update_supported(
            "codex_cli_rs/0.133.0 linux"
        ));

        assert_eq!(
            codex_thread_fork_capabilities("codex_cli_rs/0.128.0"),
            CodexThreadForkCapabilities::default()
        );
        assert_eq!(
            codex_thread_fork_capabilities("codex_cli_rs/0.129.0"),
            CodexThreadForkCapabilities {
                full_history: true,
                through_turn: false,
            }
        );
        assert_eq!(
            codex_thread_fork_capabilities("codex_cli_rs/0.143.0"),
            CodexThreadForkCapabilities {
                full_history: true,
                through_turn: true,
            }
        );

        assert!(!codex_paginated_timeline_supported("codex_cli_rs/0.144.9"));
        assert!(!codex_paginated_timeline_supported(
            "codex_cli_rs/0.145.0-alpha.17"
        ));
        assert!(codex_paginated_timeline_supported(
            "codex_cli_rs/0.145.0-alpha.18"
        ));
        assert!(codex_paginated_timeline_supported("codex_cli_rs/0.145.0"));
        assert!(codex_paginated_timeline_supported(
            "codex_cli_rs/0.146.0-beta.1"
        ));
        assert!(!codex_paginated_timeline_supported("unknown"));
    }

    #[test]
    fn managed_provider_id_comes_from_the_model_entity_not_display_name() {
        let selection = AiSessionModelSelection {
            model_entity_id: "Model.Primary/One".to_string(),
            model_name: "Friendly Label".to_string(),
            model_upstream_name: Some("upstream-primary".to_string()),
        };
        assert_eq!(
            codex_model_provider_for_selection(&selection),
            "task-handoff-model-primary-one"
        );
    }

    #[test]
    fn created_threads_must_acknowledge_the_requested_provider_and_model() {
        let selection = AiSessionModelSelection {
            model_entity_id: "model-primary".to_string(),
            model_name: "Primary".to_string(),
            model_upstream_name: Some("upstream-primary".to_string()),
        };
        let mut snapshot = CodexThreadSnapshot {
            provider_session_id: "thread-1".to_string(),
            cwd: "/workspace".to_string(),
            name: None,
            model: Some("upstream-primary".to_string()),
            model_provider: Some("task-handoff-model-primary".to_string()),
            reasoning_effort: None,
            status: "idle".to_string(),
            phase: "unknown".to_string(),
            turns: Value::Array(Vec::new()),
            sub_agents: Vec::new(),
            paginated_history: false,
            fork_supported: false,
            lineage: None,
            turns_authoritative: false,
        };
        verify_thread_selection(&snapshot, Some(&selection)).expect("matching acknowledgement");

        snapshot.model_provider = Some("openai".to_string());
        let error = verify_thread_selection(&snapshot, Some(&selection))
            .expect_err("provider mismatch must fail");
        assert_eq!(error.code, "AI_SESSION_MODEL_SELECTION_INVALID_RESPONSE");
    }

    #[test]
    fn thread_snapshots_keep_the_server_history_mode() {
        let snapshot = thread_snapshot(
            &json!({
                "id": "thread-1",
                "cwd": "/workspace",
                "historyMode": "paginated",
                "turns": []
            }),
            PathBuf::new(),
        )
        .expect("snapshot");
        assert!(snapshot.paginated_history);

        let snapshot = thread_snapshot(
            &json!({ "id": "thread-2", "cwd": "/workspace", "turns": [] }),
            PathBuf::new(),
        )
        .expect("snapshot");
        assert!(!snapshot.paginated_history);
    }

    #[test]
    fn thread_list_entries_skip_ephemeral_and_keep_the_last_duplicate() {
        let (summaries, snapshots) = project_thread_list_entries(
            vec![
                json!({ "id": "thread-1", "cwd": "/workspace", "name": "first" }),
                json!({ "id": "thread-2", "cwd": "/workspace", "ephemeral": true }),
                json!({ "id": "thread-1", "cwd": "/workspace", "name": "second" }),
                json!({ "cwd": "/workspace" }),
            ],
            true,
        );
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].name.as_deref(), Some("first"));
        assert_eq!(snapshots[1].name.as_deref(), Some("second"));
        assert_eq!(
            summaries
                .get("thread-1")
                .and_then(|snapshot| snapshot.name.as_deref()),
            Some("second")
        );
        assert!(snapshots.iter().all(|snapshot| snapshot.fork_supported));
    }

    #[test]
    fn codex_live_item_notifications_project_to_timeline_items() {
        let running = project_codex_notification_timeline_item(
            &json!({
                "id": "command-1",
                "type": "commandExecution",
                "command": "printf hello"
            }),
            "turn-1",
            true,
        )
        .expect("running command timeline item");
        let AiSessionTimelineItem::Activity {
            activity_kind,
            status,
            input,
            ..
        } = running
        else {
            panic!("expected activity timeline item");
        };
        assert_eq!(activity_kind, "commandExecution");
        assert_eq!(status, Some(AiSessionTimelineActivityStatus::Running));
        assert_eq!(input.as_deref(), Some("printf hello"));

        let completed = project_codex_notification_timeline_item(
            &json!({
                "id": "message-1",
                "type": "agentMessage",
                "status": "completed",
                "text": "done"
            }),
            "turn-1",
            false,
        )
        .expect("completed message timeline item");
        assert!(matches!(
            completed,
            AiSessionTimelineItem::AiMessage { ref text, .. } if text == "done"
        ));
    }

    #[tokio::test]
    async fn codex_turn_errors_are_deferred_and_merged_at_completion() {
        let client = test_client();
        let mut events = client.inner.events.subscribe();
        emit_notification(
            &client.inner,
            "error",
            &json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "willRetry": false,
                "error": {
                    "message": "Provider rejected the request",
                    "codexErrorInfo": { "usageLimitExceeded": { "httpStatusCode": 429 } }
                }
            }),
        )
        .await;
        assert!(drain_events(&mut events).is_empty());

        emit_notification(
            &client.inner,
            "turn/completed",
            &json!({
                "threadId": "thread-1",
                "turn": { "id": "turn-1", "status": "failed", "completedAt": 1 }
            }),
        )
        .await;
        let events = drain_events(&mut events);
        assert!(events.iter().any(|event| matches!(
            event,
            ProviderEvent::TurnCompleted {
                turn_id: Some(turn_id),
                status: Some(status),
                error: Some(error),
                ..
            } if turn_id == "turn-1"
                && status == "failed"
                && error.contains("Provider rejected the request")
                && error.contains("Codex error: usageLimitExceeded (HTTP 429)")
        )));
        assert!(client.inner.turn_errors.lock().await.is_empty());
    }

    #[tokio::test]
    async fn codex_retry_errors_publish_waiting_then_complete_on_progress() {
        let client = test_client();
        let mut events = client.inner.events.subscribe();
        emit_notification(
            &client.inner,
            "error",
            &json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "willRetry": true,
                "error": { "message": "Temporary failure" }
            }),
        )
        .await;
        let retry = drain_events(&mut events);
        assert!(retry.iter().any(|event| matches!(
            event,
            ProviderEvent::TimelineItem {
                item: AiSessionTimelineItem::Activity {
                    id,
                    activity_kind,
                    status: Some(AiSessionTimelineActivityStatus::Waiting),
                    summary: Some(summary),
                    ..
                },
                ..
            } if id == "codex_retry:turn-1"
                && activity_kind == "codexRetry"
                && summary == "Temporary failure"
        )));

        emit_notification(
            &client.inner,
            "turn/started",
            &json!({
                "threadId": "thread-1",
                "turn": { "id": "turn-1", "startedAt": 1 }
            }),
        )
        .await;
        let recovered = drain_events(&mut events);
        assert!(recovered.iter().any(|event| matches!(
            event,
            ProviderEvent::TimelineItem {
                item: AiSessionTimelineItem::Activity {
                    id,
                    status: Some(AiSessionTimelineActivityStatus::Completed),
                    ..
                },
                ..
            } if id == "codex_retry:turn-1"
        )));
        assert!(recovered
            .iter()
            .any(|event| matches!(event, ProviderEvent::TurnStarted { turn_id, .. } if turn_id == "turn-1")));
    }

    #[tokio::test]
    async fn codex_realtime_error_only_projects_session_error() {
        let client = test_client();
        let mut events = client.inner.events.subscribe();
        emit_notification(
            &client.inner,
            "thread/realtime/error",
            &json!({ "threadId": "thread-1", "message": "Realtime disconnected" }),
        )
        .await;
        assert!(drain_events(&mut events).iter().any(|event| matches!(
            event,
            ProviderEvent::SessionError { error, .. } if error == "Realtime disconnected"
        )));
    }

    #[tokio::test]
    async fn codex_status_active_flags_project_waiting_phase() {
        let client = test_client();
        let mut events = client.inner.events.subscribe();
        emit_notification(
            &client.inner,
            "thread/status/changed",
            &json!({
                "threadId": "thread-1",
                "status": { "type": "active", "activeFlags": ["waitingOnApproval"] }
            }),
        )
        .await;
        assert!(drain_events(&mut events).iter().any(|event| matches!(
            event,
            ProviderEvent::ThreadSnapshot { status, phase: Some(phase), .. }
                if status == "waiting" && phase == "approval"
        )));

        emit_notification(
            &client.inner,
            "thread/status/changed",
            &json!({
                "threadId": "thread-1",
                "status": { "type": "active", "activeFlags": ["waitingOnUserInput"] }
            }),
        )
        .await;
        assert!(drain_events(&mut events).iter().any(|event| matches!(
            event,
            ProviderEvent::ThreadSnapshot { status, phase: Some(phase), .. }
                if status == "waiting" && phase == "thinking"
        )));
    }

    #[tokio::test]
    async fn codex_thread_compaction_and_name_updates_follow_node_events() {
        let client = test_client();
        let mut events = client.inner.events.subscribe();
        emit_notification(
            &client.inner,
            "thread/compacted",
            &json!({ "threadId": "thread-1", "turnId": "turn-1" }),
        )
        .await;
        assert!(drain_events(&mut events).iter().any(|event| matches!(
            event,
            ProviderEvent::ContextCompaction {
                turn_id,
                item_id,
                status,
                ..
            } if turn_id == "turn-1"
                && item_id == "context_compaction:turn-1"
                && status == "completed"
        )));

        emit_notification(
            &client.inner,
            "thread/name/updated",
            &json!({ "threadId": "thread-1", "threadName": "Ignored title" }),
        )
        .await;
        assert!(drain_events(&mut events).is_empty());
    }

    #[test]
    fn codex_item_classification_keeps_non_tools_out_of_tool_activity() {
        for item_type in [
            "userMessage",
            "hookPrompt",
            "agentMessage",
            "plan",
            "reasoning",
            "subAgentActivity",
            "enteredReviewMode",
            "exitedReviewMode",
            "contextCompaction",
        ] {
            let item = json!({ "id": "item-1", "type": item_type });
            assert_eq!(codex_item_kind(&item), CodexItemKind::NonTool);
            assert!(codex_tool_descriptor(&item, None).is_none());
        }
        for item_type in [
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "dynamicToolCall",
            "collabAgentToolCall",
            "webSearch",
            "imageView",
            "sleep",
            "imageGeneration",
        ] {
            let item = json!({ "id": "item-1", "type": item_type });
            assert_eq!(codex_item_kind(&item), CodexItemKind::Tool);
            assert!(codex_tool_descriptor(&item, None).is_some());
        }
        assert_eq!(
            codex_item_kind(&json!({ "id": "item-1", "type": "futureItem" })),
            CodexItemKind::Unknown
        );
    }

    #[test]
    fn permission_approval_allow_uses_node_whitelist() {
        let approval = CodexApprovalRequest {
            response_id: 7,
            provider_session_id: "thread-1".to_string(),
            turn_id: None,
            item_id: None,
            summary: "Permissions".to_string(),
            kind: "permissions".to_string(),
            params: json!({
                "permissions": {
                    "network": { "enabled": true },
                    "fileSystem": {
                        "read": ["/workspace"],
                        "write": "/not-an-array",
                        "entries": ["/workspace/src"],
                        "globScanMaxDepth": 4,
                        "unknown": true
                    },
                    "unknown": "drop"
                }
            }),
        };
        assert_eq!(
            approval_response(&approval, "allow"),
            json!({
                "permissions": {
                    "network": { "enabled": true },
                    "fileSystem": {
                        "read": ["/workspace"],
                        "entries": ["/workspace/src"],
                        "globScanMaxDepth": 4
                    }
                },
                "scope": "turn"
            })
        );
        assert_eq!(
            approval_response(&approval, "deny"),
            json!({ "permissions": {}, "scope": "turn" })
        );
    }

    #[tokio::test]
    async fn codex_approvals_clear_when_leaving_approval_or_closing_thread() {
        let client = test_client();
        let mut events = client.inner.events.subscribe();
        client.inner.approvals.lock().await.push(test_approval(1));
        emit_notification(
            &client.inner,
            "thread/status/changed",
            &json!({ "threadId": "thread-1", "status": { "type": "active" } }),
        )
        .await;
        assert!(client.inner.approvals.lock().await.is_empty());
        assert!(drain_events(&mut events).iter().any(|event| matches!(
            event,
            ProviderEvent::ThreadSnapshot { status, phase: Some(phase), .. }
                if status == "running" && phase == "thinking"
        )));

        client.inner.approvals.lock().await.push(test_approval(2));
        emit_notification(
            &client.inner,
            "thread/closed",
            &json!({ "threadId": "thread-1" }),
        )
        .await;
        assert!(client.inner.approvals.lock().await.is_empty());
        assert!(drain_events(&mut events)
            .iter()
            .any(|event| matches!(event, ProviderEvent::ThreadClosed { .. })));

        client.inner.approvals.lock().await.push(test_approval(3));
        emit_notification(
            &client.inner,
            "turn/completed",
            &json!({
                "threadId": "thread-1",
                "turn": { "id": "turn-1", "status": "completed", "completedAt": 1 }
            }),
        )
        .await;
        assert!(client.inner.approvals.lock().await.is_empty());
    }

    #[tokio::test]
    async fn approval_response_is_removed_only_after_the_write_succeeds() {
        let client = test_client();
        let session = test_session();
        client.inner.approvals.lock().await.push(test_approval(11));
        assert!(client.resolve_approval(&session, "allow").await.is_err());
        assert_eq!(client.inner.approvals.lock().await.len(), 1);

        let (writer, mut written) = mpsc::channel(4);
        *client.inner.connection.lock().await = Some(Connection {
            writer,
            child: None,
            shutdown: None,
        });
        client
            .resolve_approval(&session, "allow")
            .await
            .expect("approval response write");
        assert!(client.inner.approvals.lock().await.is_empty());
        let response: Value =
            serde_json::from_str(&written.recv().await.expect("written approval response"))
                .expect("approval response json");
        assert_eq!(response.get("id").and_then(Value::as_u64), Some(11));
        assert_eq!(
            response
                .get("result")
                .and_then(|result| result.get("decision"))
                .and_then(Value::as_str),
            Some("accept")
        );
    }

    #[test]
    fn codex_capability_advertises_timeline_reads_before_connection() {
        let provider = CodexAppServerProvider::new(
            CodexAppServerClient::with_command("missing-codex-for-capability-test"),
            None,
        );
        let capability = provider.capability();
        assert!(
            !capability
                .model_selection
                .as_ref()
                .expect("model selection capability")
                .switch_model_within_provider
        );
        assert!(capability.timeline.session_read);
        assert!(capability.timeline.turn_read);
        assert!(capability.timeline.live_items);
        let timeline = provider.timeline_capabilities();
        assert!(!timeline.session_read);
        assert!(!timeline.turn_read);
        assert!(timeline.live_items);
    }

    #[test]
    fn provider_reload_capability_matches_the_complete_client_method_set() {
        let client = CodexAppServerClient::with_command("missing-codex-for-capability-test");
        assert!(client.supports_provider_reload());
        let provider = CodexAppServerProvider::new(client, None);
        let capability = provider.capability();
        let model_selection = capability
            .model_selection
            .expect("model selection capability");
        assert!(model_selection.select_model_at_resume);
        assert!(model_selection.select_provider_at_resume);
        assert!(model_selection.switch_provider_during_session);
    }

    #[test]
    fn codex_story_tool_config_disables_mcp_when_the_tool_list_is_empty() {
        let empty = thread_config(None, Some(&[]));
        assert_eq!(empty["mcp_servers.task_handoff_story.enabled"], false);
        assert!(!empty.contains_key("mcp_servers.task_handoff_story.enabled_tools"));

        let omitted = thread_config(None, None);
        assert!(!omitted.contains_key("mcp_servers.task_handoff_story.enabled"));
        assert!(!omitted.contains_key("mcp_servers.task_handoff_story.enabled_tools"));
    }

    #[derive(Default)]
    struct DeferredTargetResolver {
        resolve_calls: std::sync::atomic::AtomicUsize,
        ensure_calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl CodexAppServerTargetResolver for DeferredTargetResolver {
        async fn resolve_codex_app_server_target(
            &self,
        ) -> Result<Option<CodexAppServerTarget>, ProviderError> {
            self.resolve_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(None)
        }

        async fn ensure_codex_app_server_target(
            &self,
        ) -> Result<Option<CodexAppServerTarget>, ProviderError> {
            self.ensure_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(None)
        }

        fn allows_private_codex_app_server(&self) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn discovery_reuses_an_existing_target_without_starting_codex() {
        let resolver = Arc::new(DeferredTargetResolver::default());
        let client = CodexAppServerClient::with_command("missing-codex-for-discovery-test");
        client.set_external_target_resolver(Some(resolver.clone()));

        let snapshots = client
            .discover_thread_snapshots(&[])
            .await
            .expect("discovery without a shared target");
        assert!(snapshots.is_empty());
        assert!(!client.is_connected());
        assert_eq!(
            resolver
                .resolve_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(
            resolver
                .ensure_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );

        let error = client
            .ensure_ready()
            .await
            .expect_err("control actions require the shared target");
        assert_eq!(error.code, "AI_SESSION_PROVIDER_UNAVAILABLE");
        assert_eq!(
            resolver
                .ensure_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[test]
    fn managed_model_environment_is_forwarded_without_dropping_story_bridge_vars() {
        let client = CodexAppServerClient::with_command("codex").with_story_agent_tool_bridge(
            "http://127.0.0.1:8080/api/internal/agent-tools/mcp",
            "story-token",
        );
        assert!(client.replace_managed_environment(BTreeMap::from([(
            "TASK_HANDOFF_CODEX_PROVIDER_TASK_HANDOFF_MODEL_API_KEY".to_string(),
            "provider-secret".to_string(),
        )])));
        {
            let environment = client
                .inner
                .launch_environment
                .read()
                .expect("launch environment");
            assert_eq!(
                environment
                    .get("TASK_HANDOFF_AGENT_TOOLS_TOKEN")
                    .map(String::as_str),
                Some("story-token")
            );
            assert_eq!(
                environment
                    .get("TASK_HANDOFF_CODEX_PROVIDER_TASK_HANDOFF_MODEL_API_KEY")
                    .map(String::as_str),
                Some("provider-secret")
            );
        }
        assert!(!client.replace_managed_environment(BTreeMap::from([(
            "TASK_HANDOFF_CODEX_PROVIDER_TASK_HANDOFF_MODEL_API_KEY".to_string(),
            "provider-secret".to_string(),
        )])));
        assert!(client.replace_managed_environment(BTreeMap::from([(
            "TASK_HANDOFF_CODEX_PROVIDER_TASK_HANDOFF_NEXT_API_KEY".to_string(),
            "next-secret".to_string(),
        )])));
        let environment = client
            .inner
            .launch_environment
            .read()
            .expect("launch environment");
        assert!(environment.contains_key("TASK_HANDOFF_AGENT_TOOLS_ENDPOINT"));
        assert!(!environment.contains_key("TASK_HANDOFF_CODEX_PROVIDER_TASK_HANDOFF_MODEL_API_KEY"));
        assert_eq!(
            environment
                .get("TASK_HANDOFF_CODEX_PROVIDER_TASK_HANDOFF_NEXT_API_KEY")
                .map(String::as_str),
            Some("next-secret")
        );
    }

    #[test]
    fn websocket_request_uses_rpc_path_and_bearer_token() {
        use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;

        let request = build_websocket_request("ws://127.0.0.1:4321", Some(" secret-token "))
            .expect("websocket request");
        assert_eq!(request.uri().path(), "/rpc");
        assert_eq!(
            request
                .headers()
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer secret-token")
        );

        let request = build_websocket_request("ws://127.0.0.1:4321", Some("  "))
            .expect("websocket request without token");
        assert!(!request.headers().contains_key(AUTHORIZATION));
    }

    async fn serve_fake_codex_websocket<S>(
        stream: S,
        mut accepted: Option<oneshot::Sender<()>>,
        closed: oneshot::Sender<()>,
    ) where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
    {
        let mut socket = tokio_tungstenite::accept_async(stream)
            .await
            .expect("fake Codex websocket handshake");
        while let Some(message) = socket.next().await {
            let message = match message {
                Ok(message) => message,
                Err(_) => break,
            };
            match message {
                tokio_tungstenite::tungstenite::Message::Text(text) => {
                    let Ok(message) = serde_json::from_str::<Value>(text.as_str()) else {
                        continue;
                    };
                    if message.get("method").and_then(Value::as_str) != Some("initialize") {
                        continue;
                    }
                    let id = message
                        .get("id")
                        .and_then(Value::as_u64)
                        .expect("initialize request id");
                    socket
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            json!({
                                "id": id,
                                "result": { "userAgent": "codex_cli_rs/0.145.0 test" }
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .expect("initialize response");
                    if let Some(accepted) = accepted.take() {
                        let _ = accepted.send(());
                    }
                }
                tokio_tungstenite::tungstenite::Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = closed.send(());
    }

    #[tokio::test]
    async fn external_websocket_target_changes_reconnect_and_stop_closes() {
        let listener_a = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listener A");
        let address_a = listener_a.local_addr().expect("listener A address");
        let (ready_a_tx, ready_a_rx) = oneshot::channel();
        let (closed_a_tx, closed_a_rx) = oneshot::channel();
        let server_a = tokio::spawn(async move {
            let (stream, _) = listener_a.accept().await.expect("accept A");
            serve_fake_codex_websocket(stream, Some(ready_a_tx), closed_a_tx).await;
        });

        let listener_b = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listener B");
        let address_b = listener_b.local_addr().expect("listener B address");
        let (ready_b_tx, ready_b_rx) = oneshot::channel();
        let (closed_b_tx, closed_b_rx) = oneshot::channel();
        let server_b = tokio::spawn(async move {
            let (stream, _) = listener_b.accept().await.expect("accept B");
            serve_fake_codex_websocket(stream, Some(ready_b_tx), closed_b_tx).await;
        });

        let client = CodexAppServerClient::with_command("missing-shared-codex-test-command");
        client
            .configure_external_target(Some(CodexAppServerTarget::WebSocket {
                endpoint: format!("ws://{address_a}"),
                token_file: None,
            }))
            .await
            .expect("connect target A");
        tokio::time::timeout(Duration::from_secs(3), ready_a_rx)
            .await
            .expect("target A initialize")
            .expect("target A ready");

        client
            .configure_external_target(Some(CodexAppServerTarget::WebSocket {
                endpoint: format!("ws://{address_b}"),
                token_file: None,
            }))
            .await
            .expect("connect target B");
        tokio::time::timeout(Duration::from_secs(3), ready_b_rx)
            .await
            .expect("target B initialize")
            .expect("target B ready");
        tokio::time::timeout(Duration::from_secs(3), closed_a_rx)
            .await
            .expect("target A closed after target change")
            .expect("target A close notification");

        client.stop().await;
        tokio::time::timeout(Duration::from_secs(3), closed_b_rx)
            .await
            .expect("target B closed after stop")
            .expect("target B close notification");
        server_a.await.expect("server A");
        server_b.await.expect("server B");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn external_unix_target_connects_without_cli_proxy() {
        let directory = tempfile::tempdir().expect("temporary socket directory");
        let socket_path = directory.path().join("app-server.sock");
        let listener = tokio::net::UnixListener::bind(&socket_path).expect("Unix listener");
        let (ready_tx, ready_rx) = oneshot::channel();
        let (closed_tx, closed_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept Unix socket");
            serve_fake_codex_websocket(stream, Some(ready_tx), closed_tx).await;
        });

        let client = CodexAppServerClient::with_command("missing-shared-codex-test-command");
        client
            .configure_external_target(Some(CodexAppServerTarget::Unix { socket_path }))
            .await
            .expect("connect Unix target");
        tokio::time::timeout(Duration::from_secs(3), ready_rx)
            .await
            .expect("Unix target initialize")
            .expect("Unix target ready");

        client.stop().await;
        tokio::time::timeout(Duration::from_secs(3), closed_rx)
            .await
            .expect("Unix target closed after stop")
            .expect("Unix target close notification");
        server.await.expect("Unix server");
    }
}
