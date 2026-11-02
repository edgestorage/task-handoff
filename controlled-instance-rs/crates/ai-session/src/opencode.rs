use crate::{
    ai_session_title_output_schema, ai_session_title_prompt, parse_ai_session_title, AiSession,
    AiSessionControlProvider, AiSessionModelSelection, AiSessionPermissionMode,
    AiSessionTitleGenerator, AiSessionTitleInput, ProviderAction, ProviderCreateInput,
    ProviderCreateResult, ProviderError, ProviderEvent, ProviderForkInput, ProviderMessage,
    ProviderResumeResult,
};
use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use controlled_instance_protocol::{
    AiSessionAttachmentKind, AiSessionConversationAttachment, AiSessionHierarchyCapabilities,
    AiSessionModelSelectionCapabilities, AiSessionProviderActions, AiSessionProviderCapability,
    AiSessionProviderTimelineCapabilities, AiSessionReasoningEffortCapabilities, AiSessionTimeline,
    AiSessionTimelineActivityStatus, AiSessionTimelineItem, AiSessionTurnTimeline,
    AI_SESSION_AGENT_TOOL_NAMES,
};
use futures_util::StreamExt;
use reqwest::{Client, Method, StatusCode, Url};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock, Weak,
    },
    time::Duration,
};
use tokio::{
    sync::{broadcast, mpsc},
    task::JoinHandle,
};

const OPENCODE_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const OPENCODE_RECONCILE_DELAY: Duration = Duration::from_millis(25);
const OPENCODE_RECONNECT_BASE: Duration = Duration::from_millis(250);
const OPENCODE_RECONNECT_MAX: Duration = Duration::from_secs(10);
const OPENCODE_MAX_PART_DELTA_BYTES: usize = 1_000_000;
const OPENCODE_MAX_PENDING_PART_DELTAS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeConnection {
    pub endpoint: String,
    pub headers: BTreeMap<String, String>,
}

pub trait OpenCodeModelSelectionProjector: Send + Sync {
    fn project_model_selection(
        &self,
        provider_id: &str,
        model_id: &str,
    ) -> Option<AiSessionModelSelection>;
}

#[async_trait]
pub trait OpenCodeConnectionProvider: Send + Sync {
    async fn connection(&self) -> Result<OpenCodeConnection, ProviderError>;

    fn workspace_roots(&self) -> Vec<PathBuf>;
}

#[derive(Clone)]
pub struct OpenCodeClient {
    connections: Arc<dyn OpenCodeConnectionProvider>,
    http: Client,
}

impl OpenCodeClient {
    pub fn new(connections: Arc<dyn OpenCodeConnectionProvider>) -> Self {
        Self {
            connections,
            http: Client::builder()
                .timeout(OPENCODE_REQUEST_TIMEOUT)
                .build()
                .expect("OpenCode HTTP client"),
        }
    }

    async fn health(&self) -> Result<Value, ProviderError> {
        self.request(Method::GET, "/global/health", None, &[], None)
            .await
    }

    async fn get_session(&self, session_id: &str, directory: &str) -> Result<Value, ProviderError> {
        self.request(
            Method::GET,
            &format!("/session/{}", encode_path(session_id)),
            Some(directory),
            &[],
            None,
        )
        .await
    }

    async fn status(&self, directory: &str) -> Result<Value, ProviderError> {
        self.request(Method::GET, "/session/status", Some(directory), &[], None)
            .await
    }

    async fn messages(
        &self,
        session_id: &str,
        directory: &str,
    ) -> Result<Vec<Value>, ProviderError> {
        let value = self
            .request(
                Method::GET,
                &format!("/session/{}/message", encode_path(session_id)),
                Some(directory),
                &[("limit".to_string(), "1000".to_string())],
                None,
            )
            .await?;
        Ok(value.as_array().cloned().unwrap_or_default())
    }

    async fn permissions(&self, directory: &str) -> Result<Vec<Value>, ProviderError> {
        let value = self
            .request(Method::GET, "/permission", Some(directory), &[], None)
            .await?;
        Ok(value.as_array().cloned().unwrap_or_default())
    }

    async fn list_global_sessions(
        &self,
        cursor: Option<&str>,
    ) -> Result<(Vec<Value>, Option<String>), ProviderError> {
        let mut query = vec![
            ("archived".to_string(), "false".to_string()),
            ("limit".to_string(), "100".to_string()),
        ];
        if let Some(cursor) = cursor {
            query.push(("cursor".to_string(), cursor.to_string()));
        }
        let (value, next_cursor) = self
            .request_page(Method::GET, "/experimental/session", None, &query, None)
            .await?;
        let sessions = value
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| value.as_array())
            .cloned()
            .unwrap_or_default();
        let next_cursor = next_cursor.or_else(|| {
            value
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        });
        Ok((sessions, next_cursor))
    }

    async fn create_session(
        &self,
        directory: &str,
        model: Option<&OpenCodeModelRef>,
        permission: Option<Vec<Value>>,
    ) -> Result<Value, ProviderError> {
        let mut body = Map::new();
        if let Some(model) = model {
            body.insert("model".to_string(), model.model_body());
        }
        if let Some(permission) = permission {
            body.insert("permission".to_string(), Value::Array(permission));
        }
        self.request(
            Method::POST,
            "/session",
            Some(directory),
            &[],
            Some(Value::Object(body)),
        )
        .await
    }

    async fn update_session(
        &self,
        session_id: &str,
        directory: &str,
        body: Value,
    ) -> Result<Value, ProviderError> {
        self.request(
            Method::PATCH,
            &format!("/session/{}", encode_path(session_id)),
            Some(directory),
            &[],
            Some(body),
        )
        .await
    }

    async fn archive_session(
        &self,
        session_id: &str,
        directory: &str,
    ) -> Result<Value, ProviderError> {
        self.update_session(
            session_id,
            directory,
            json!({ "time": { "archived": Utc::now().timestamp_millis() } }),
        )
        .await
    }

    async fn rename_session(
        &self,
        session_id: &str,
        directory: &str,
        title: &str,
    ) -> Result<Value, ProviderError> {
        self.update_session(session_id, directory, json!({ "title": title }))
            .await
    }

    async fn delete_session(
        &self,
        session_id: &str,
        directory: &str,
    ) -> Result<Value, ProviderError> {
        self.request(
            Method::DELETE,
            &format!("/session/{}", encode_path(session_id)),
            Some(directory),
            &[],
            None,
        )
        .await
    }

    async fn fork_session(
        &self,
        session_id: &str,
        directory: &str,
        message_id: Option<&str>,
    ) -> Result<Value, ProviderError> {
        self.request(
            Method::POST,
            &format!("/session/{}/fork", encode_path(session_id)),
            Some(directory),
            &[],
            Some(message_id.map_or_else(|| json!({}), |id| json!({ "messageID": id }))),
        )
        .await
    }

    async fn abort(&self, session_id: &str, directory: &str) -> Result<Value, ProviderError> {
        self.request(
            Method::POST,
            &format!("/session/{}/abort", encode_path(session_id)),
            Some(directory),
            &[],
            Some(json!({})),
        )
        .await
    }

    async fn prompt_async(
        &self,
        session_id: &str,
        directory: &str,
        message_id: &str,
        parts: Vec<Value>,
        model: Option<&OpenCodeModelRef>,
    ) -> Result<(), ProviderError> {
        let mut body = Map::new();
        body.insert("messageID".to_string(), json!(message_id));
        body.insert("parts".to_string(), Value::Array(parts));
        if let Some(model) = model {
            let mut model_body = Map::new();
            model_body.insert("providerID".to_string(), json!(model.provider_id));
            model_body.insert("modelID".to_string(), json!(model.model_id));
            if let Some(variant) = model.variant.as_deref() {
                model_body.insert("variant".to_string(), json!(variant));
            }
            body.insert("model".to_string(), Value::Object(model_body));
        }
        self.request(
            Method::POST,
            &format!("/session/{}/prompt_async", encode_path(session_id)),
            Some(directory),
            &[],
            Some(Value::Object(body)),
        )
        .await
        .map(|_| ())
    }

    async fn reply_permission(
        &self,
        request_id: &str,
        directory: &str,
        reply: &str,
    ) -> Result<Value, ProviderError> {
        self.request(
            Method::POST,
            &format!("/permission/{}/reply", encode_path(request_id)),
            Some(directory),
            &[],
            Some(json!({ "reply": reply })),
        )
        .await
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        directory: Option<&str>,
        query: &[(String, String)],
        body: Option<Value>,
    ) -> Result<Value, ProviderError> {
        self.request_page(method, path, directory, query, body)
            .await
            .map(|(data, _)| data)
    }

    async fn request_page(
        &self,
        method: Method,
        path: &str,
        directory: Option<&str>,
        query: &[(String, String)],
        body: Option<Value>,
    ) -> Result<(Value, Option<String>), ProviderError> {
        let connection = self.connections.connection().await?;
        let mut url = Url::parse(&format!(
            "{}{}",
            connection.endpoint.trim_end_matches('/'),
            path
        ))
        .map_err(|error| {
            ProviderError::bad_gateway("OPENCODE_SERVER_UNAVAILABLE", error.to_string())
        })?;
        if let Some(directory) = directory {
            url.query_pairs_mut().append_pair("directory", directory);
        }
        for (name, value) in query {
            url.query_pairs_mut().append_pair(name, value);
        }
        let mut request = self
            .http
            .request(method.clone(), url)
            .header("accept", "application/json");
        for (name, value) in &connection.headers {
            request = request.header(name, value);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            ProviderError::new(
                "OPENCODE_SERVER_UNAVAILABLE",
                format!("OpenCode request failed: {error}"),
                503,
            )
        })?;
        let status = response.status();
        let next_cursor = response
            .headers()
            .get("x-next-cursor")
            .and_then(|value| value.to_str().ok())
            .map(ToString::to_string);
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(http_error(method.as_str(), path, status, &text));
        }
        if text.trim().is_empty() {
            return Ok((Value::Null, next_cursor));
        }
        serde_json::from_str::<Value>(&text)
            .map(|value| (value, next_cursor))
            .map_err(|error| {
                ProviderError::bad_gateway(
                    "OPENCODE_INVALID_RESPONSE",
                    format!("OpenCode returned malformed JSON for {path}: {error}"),
                )
            })
    }
}

fn http_error(method: &str, path: &str, status: StatusCode, text: &str) -> ProviderError {
    let message = bounded(text.trim(), 4000).unwrap_or_else(|| {
        format!(
            "OpenCode returned HTTP {} for {method} {path}.",
            status.as_u16()
        )
    });
    if status == StatusCode::NOT_FOUND {
        ProviderError::new("AI_SESSION_NOT_FOUND", message, 404)
    } else if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        ProviderError::new("OPENCODE_SERVER_UNAUTHORIZED", message, 503)
    } else {
        ProviderError::new("OPENCODE_HTTP_ERROR", message, 502)
    }
}

#[derive(Debug, Clone)]
struct OpenCodeModelRef {
    provider_id: String,
    model_id: String,
    variant: Option<String>,
}

impl OpenCodeModelRef {
    fn model_body(&self) -> Value {
        let mut body = Map::new();
        body.insert("id".to_string(), json!(self.model_id));
        body.insert("providerID".to_string(), json!(self.provider_id));
        if let Some(variant) = self.variant.as_deref() {
            body.insert("variant".to_string(), json!(variant));
        }
        Value::Object(body)
    }
}

#[derive(Debug, Clone, Default)]
struct PendingSettings {
    model_selection: Option<AiSessionModelSelection>,
    reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct OpenCodeProjection {
    title: String,
    cwd: String,
    lifecycle: String,
    phase: String,
    active_turn_id: Option<String>,
    last_turn_id: Option<String>,
    last_message: Option<String>,
    last_message_item_id: Option<String>,
    error: Option<String>,
    summary: Option<String>,
    model_selection: Option<AiSessionModelSelection>,
    reasoning_effort: Option<String>,
    pending_permission_id: Option<String>,
    parent_provider_session_id: Option<String>,
    timeline: Vec<AiSessionTimelineItem>,
    part_turns: HashMap<String, (String, String, String)>,
    message_turns: HashMap<String, String>,
    assistant_message_ids: HashSet<String>,
    tool_activity_ids: HashSet<String>,
}

#[derive(Debug, Clone)]
struct PendingPartDelta {
    part_id: String,
    message_id: String,
    chunks: Vec<String>,
    size: usize,
}

#[derive(Debug, Clone)]
struct RetryActivity {
    turn_id: String,
    message: String,
    completed: bool,
}

#[derive(Debug, Default)]
struct OpenCodeAuxState {
    pending_part_deltas: HashMap<String, Vec<PendingPartDelta>>,
    retry_activities: HashMap<String, Vec<RetryActivity>>,
    terminal_errors: HashMap<String, String>,
    armed_title_sessions: HashSet<String>,
    attempted_title_sessions: HashSet<String>,
    title_generations: HashMap<String, u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ReconcileState {
    lifecycle: String,
    active_turn_id: Option<String>,
    user_turn_id: Option<String>,
    permission_id: Option<String>,
    last_message_item_id: Option<String>,
    last_message: Option<String>,
    activities: HashMap<String, String>,
}

pub struct OpenCodeSessionProvider {
    client: OpenCodeClient,
    events: broadcast::Sender<ProviderEvent>,
    directories: RwLock<HashMap<String, String>>,
    projections: RwLock<HashMap<String, OpenCodeProjection>>,
    pending_settings: RwLock<HashMap<String, PendingSettings>>,
    reconcile_states: RwLock<HashMap<String, ReconcileState>>,
    aux: RwLock<OpenCodeAuxState>,
    model_selection_projector: RwLock<Option<Arc<dyn OpenCodeModelSelectionProjector>>>,
    title_generator: RwLock<Option<Arc<dyn AiSessionTitleGenerator>>>,
    reconcile_tx: mpsc::UnboundedSender<(String, String)>,
    closed: AtomicBool,
    event_source_started: AtomicBool,
    event_source: std::sync::Mutex<Option<JoinHandle<()>>>,
    self_ref: std::sync::Mutex<Weak<Self>>,
}

impl OpenCodeSessionProvider {
    pub fn new(connections: Arc<dyn OpenCodeConnectionProvider>) -> Arc<Self> {
        let (events, _) = broadcast::channel(1024);
        let (reconcile_tx, reconcile_rx) = mpsc::unbounded_channel();
        let provider = Arc::new(Self {
            client: OpenCodeClient::new(connections),
            events,
            directories: RwLock::new(HashMap::new()),
            projections: RwLock::new(HashMap::new()),
            pending_settings: RwLock::new(HashMap::new()),
            reconcile_states: RwLock::new(HashMap::new()),
            aux: RwLock::new(OpenCodeAuxState::default()),
            model_selection_projector: RwLock::new(None),
            title_generator: RwLock::new(None),
            reconcile_tx,
            closed: AtomicBool::new(false),
            event_source_started: AtomicBool::new(false),
            event_source: std::sync::Mutex::new(None),
            self_ref: std::sync::Mutex::new(Weak::new()),
        });
        *provider
            .self_ref
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::downgrade(&provider);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let worker = provider.clone();
            runtime.spawn(async move { worker.reconcile_loop(reconcile_rx).await });
        }
        provider
    }

    pub fn set_model_selection_projector(
        &self,
        projector: Arc<dyn OpenCodeModelSelectionProjector>,
    ) {
        *self
            .model_selection_projector
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(projector);
    }

    pub fn set_title_generator(&self, generator: Arc<dyn AiSessionTitleGenerator>) {
        *self
            .title_generator
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(generator);
    }

    async fn ensure_ready(&self) -> Result<(), ProviderError> {
        self.client.health().await?;
        self.start_event_stream();
        Ok(())
    }

    fn start_event_stream(&self) {
        if self.closed.load(Ordering::SeqCst)
            || self.event_source_started.swap(true, Ordering::SeqCst)
        {
            return;
        }
        let provider = self
            .self_ref
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .upgrade();
        if let (Some(provider), Ok(runtime)) = (provider, tokio::runtime::Handle::try_current()) {
            let task = runtime.spawn(async move { provider.event_loop().await });
            *self
                .event_source
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(task);
        } else {
            self.event_source_started.store(false, Ordering::SeqCst);
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(task) = self
            .event_source
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            task.abort();
        }
    }

    async fn event_loop(self: Arc<Self>) {
        let mut attempt = 0_u32;
        while !self.closed.load(Ordering::SeqCst) {
            match self.consume_events().await {
                Ok(()) => attempt = 0,
                Err(error) => {
                    tracing::debug!(%error, "OpenCode event stream disconnected");
                }
            }
            let _ = self
                .events
                .send(ProviderEvent::ConnectionChanged { connected: false });
            if self.closed.load(Ordering::SeqCst) {
                break;
            }
            let delay = OPENCODE_RECONNECT_BASE
                .saturating_mul(1_u32 << attempt.min(6))
                .min(OPENCODE_RECONNECT_MAX);
            attempt = attempt.saturating_add(1);
            tokio::time::sleep(delay).await;
        }
    }

    async fn consume_events(self: &Arc<Self>) -> Result<(), ProviderError> {
        let connection = self.client.connections.connection().await?;
        let mut request = self
            .client
            .http
            .get(format!(
                "{}/global/event",
                connection.endpoint.trim_end_matches('/')
            ))
            .header("accept", "text/event-stream");
        for (name, value) in &connection.headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|error| {
            ProviderError::new(
                "OPENCODE_SERVER_UNAVAILABLE",
                format!("OpenCode event stream failed: {error}"),
                503,
            )
        })?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(http_error("GET", "/global/event", status, &text));
        }
        let _ = self
            .events
            .send(ProviderEvent::ConnectionChanged { connected: true });
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                ProviderError::new("OPENCODE_EVENT_STREAM_CLOSED", error.to_string(), 503)
            })?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(frame) = next_sse_frame(&mut buffer) {
                let data = frame
                    .lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .map(str::trim_start)
                    .collect::<Vec<_>>()
                    .join("\n");
                if data.is_empty() {
                    continue;
                }
                if let Ok(event) = serde_json::from_str::<Value>(&data) {
                    self.handle_global_event(event).await;
                }
            }
        }
        Err(ProviderError::new(
            "OPENCODE_EVENT_STREAM_CLOSED",
            "OpenCode event stream ended.",
            503,
        ))
    }

    async fn handle_global_event(self: &Arc<Self>, event: Value) {
        let payload = event.get("payload").unwrap_or(&Value::Null);
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type == "server.connected" {
            let provider = self.clone();
            tokio::spawn(async move {
                if let Err(error) = provider.refresh_all().await {
                    tracing::debug!(%error, "OpenCode discovery failed");
                }
            });
            return;
        }
        if event_type == "sync" {
            return;
        }
        let properties = payload
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let info = properties
            .get("info")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let part = properties
            .get("part")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let Some(session_id) = compact_field(&properties, "sessionID")
            .or_else(|| compact_field(&info, "sessionID"))
            .or_else(|| compact_field(&part, "sessionID"))
            .or_else(|| {
                event_type
                    .starts_with("session.")
                    .then(|| compact_field(&info, "id"))
                    .flatten()
            })
        else {
            return;
        };
        if event_type == "session.deleted" {
            self.forget(&session_id);
            return;
        }
        if event_type == "session.updated"
            && info
                .get("time")
                .and_then(|time| time.get("archived"))
                .is_some_and(|value| !value.is_null())
        {
            self.forget(&session_id);
            return;
        }
        if event_type == "session.updated" {
            if let Some(title) = info.get("title").and_then(Value::as_str) {
                if !is_default_opencode_session_title(title) {
                    self.cancel_title_generation(&session_id);
                }
            }
        }
        let directory = event
            .get("directory")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .or_else(|| {
                self.directories
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .get(&session_id)
                    .cloned()
            });
        if let Some(directory) = directory.as_deref() {
            if !within_roots(directory, &self.client.connections.workspace_roots()) {
                return;
            }
            self.directories
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(session_id.clone(), directory.to_string());
        }
        if event_type == "message.part.delta" && !self.publish_part_delta(&session_id, &properties)
        {
            self.buffer_pending_part_delta(&session_id, &properties);
        }
        if event_type == "message.updated" {
            self.observe_message(&session_id, &info);
        }
        if event_type == "message.part.updated" {
            self.observe_part(&session_id, &part);
        }
        if event_type == "session.status" {
            let status = properties
                .get("status")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            match status.get("type").and_then(Value::as_str) {
                Some("retry") => {
                    let message = status
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("OpenCode is retrying the request.");
                    if let Some(projection) = self.projection_for_provider(&session_id) {
                        if let Some(turn_id) = projection
                            .active_turn_id
                            .clone()
                            .or_else(|| projection.last_turn_id.clone())
                        {
                            self.record_retry_activity(&session_id, &turn_id, message);
                            self.aux
                                .write()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .terminal_errors
                                .remove(&session_id);
                            let _ = self.events.send(ProviderEvent::TimelineItem {
                                provider_session_id: session_id.clone(),
                                item: retry_activity(&turn_id, message, false),
                            });
                            self.publish_projection_snapshot(&session_id, "running", "thinking");
                        }
                    }
                }
                Some("busy") | Some("idle") => {
                    if let Some(item) = self.complete_retry_activity(&session_id) {
                        let _ = self.events.send(ProviderEvent::TimelineItem {
                            provider_session_id: session_id.clone(),
                            item,
                        });
                    }
                }
                _ => {}
            }
        }
        if event_type == "session.error" {
            if let Some(error) = properties.get("error").and_then(opencode_error_text) {
                self.aux
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .terminal_errors
                    .insert(session_id.clone(), error.clone());
                if let Some(item) = self.complete_retry_activity(&session_id) {
                    let _ = self.events.send(ProviderEvent::TimelineItem {
                        provider_session_id: session_id.clone(),
                        item,
                    });
                }
                if let Some(session) = self.projection_for_provider(&session_id) {
                    let turn_id = session.active_turn_id.clone();
                    let _ = self.events.send(ProviderEvent::TurnCompleted {
                        provider_session_id: session_id.clone(),
                        turn_id,
                        status: Some("failed".to_string()),
                        error: Some(error),
                        completed_at: Some(now_iso()),
                    });
                }
            }
        }
        if let Some(directory) = directory {
            let _ = self.reconcile_tx.send((session_id, directory));
        }
    }

    fn publish_part_delta(
        &self,
        provider_session_id: &str,
        properties: &Map<String, Value>,
    ) -> bool {
        let Some(part_id) = compact_field(properties, "partID") else {
            return false;
        };
        let Some(message_id) = compact_field(properties, "messageID") else {
            return false;
        };
        let Some(delta) = properties
            .get("delta")
            .and_then(Value::as_str)
            .filter(|value| {
                !value.is_empty() && properties.get("field").and_then(Value::as_str) == Some("text")
            })
            .map(|value| {
                value
                    .chars()
                    .take(OPENCODE_MAX_PART_DELTA_BYTES)
                    .collect::<String>()
            })
        else {
            return false;
        };
        let projection = self
            .projections
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(provider_session_id)
            .cloned();
        let Some(projection) = projection else {
            return false;
        };
        let Some((turn_id, part_message_id, part_type)) = projection.part_turns.get(&part_id)
        else {
            return false;
        };
        if part_message_id != &message_id || !projection.assistant_message_ids.contains(&message_id)
        {
            return false;
        }
        match part_type.as_str() {
            "text" => {
                let _ = self.events.send(ProviderEvent::AgentMessageDelta {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: turn_id.clone(),
                    item_id: part_id,
                    delta,
                });
                true
            }
            "reasoning" => {
                let _ = self.events.send(ProviderEvent::TimelineItemDelta {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: turn_id.clone(),
                    item_id: part_id,
                    field: "output".to_string(),
                    delta,
                });
                true
            }
            _ => false,
        }
    }

    fn buffer_pending_part_delta(
        &self,
        provider_session_id: &str,
        properties: &Map<String, Value>,
    ) {
        let Some(part_id) = compact_field(properties, "partID") else {
            return;
        };
        let Some(message_id) = compact_field(properties, "messageID") else {
            return;
        };
        let Some(delta) = properties
            .get("delta")
            .and_then(Value::as_str)
            .filter(|value| {
                !value.is_empty() && properties.get("field").and_then(Value::as_str) == Some("text")
            })
        else {
            return;
        };
        let is_assistant = self
            .projections
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(provider_session_id)
            .is_some_and(|projection| projection.assistant_message_ids.contains(&message_id));
        if !is_assistant {
            return;
        }
        let mut aux = self
            .aux
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let pending = aux
            .pending_part_deltas
            .entry(provider_session_id.to_string())
            .or_default();
        if let Some(previous) = pending
            .iter_mut()
            .find(|previous| previous.part_id == part_id)
        {
            if previous.message_id != message_id {
                return;
            }
            let remaining = OPENCODE_MAX_PART_DELTA_BYTES.saturating_sub(previous.size);
            let chunk = delta.chars().take(remaining).collect::<String>();
            previous.size = previous.size.saturating_add(chunk.len());
            if !chunk.is_empty() {
                previous.chunks.push(chunk);
            }
        } else {
            let chunk = delta
                .chars()
                .take(OPENCODE_MAX_PART_DELTA_BYTES)
                .collect::<String>();
            pending.push(PendingPartDelta {
                part_id,
                message_id,
                size: chunk.len(),
                chunks: (!chunk.is_empty()).then_some(chunk).into_iter().collect(),
            });
        }
        while pending.len() > OPENCODE_MAX_PENDING_PART_DELTAS {
            pending.remove(0);
        }
    }

    fn emit_part_delta(
        &self,
        provider_session_id: &str,
        turn_id: &str,
        item_id: &str,
        part_type: &str,
        delta: &str,
    ) {
        if delta.is_empty() {
            return;
        }
        match part_type {
            "text" => {
                let _ = self.events.send(ProviderEvent::AgentMessageDelta {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    item_id: item_id.to_string(),
                    delta: delta.to_string(),
                });
            }
            "reasoning" => {
                let _ = self.events.send(ProviderEvent::TimelineItemDelta {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    item_id: item_id.to_string(),
                    field: "output".to_string(),
                    delta: delta.to_string(),
                });
            }
            _ => {}
        }
    }

    fn observe_message(&self, provider_session_id: &str, info: &Map<String, Value>) {
        let Some(message_id) = compact_field(info, "id") else {
            return;
        };
        let role = info.get("role").and_then(Value::as_str);
        if role == Some("user") {
            self.aux
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .terminal_errors
                .remove(provider_session_id);
        }
        let turn_id = if role == Some("user") {
            Some(message_id.clone())
        } else if role == Some("assistant") {
            compact_field(info, "parentID").and_then(|parent_id| {
                self.projections
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .get(provider_session_id)
                    .and_then(|projection| projection.message_turns.get(&parent_id).cloned())
            })
        } else {
            None
        };
        let Some(turn_id) = turn_id else {
            return;
        };
        if let Some(projection) = self
            .projections
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(provider_session_id)
        {
            projection.message_turns.insert(message_id.clone(), turn_id);
            if role == Some("assistant") {
                projection.assistant_message_ids.insert(message_id);
            }
        }
    }

    fn observe_part(&self, provider_session_id: &str, part: &Map<String, Value>) {
        let Some(part_id) = compact_field(part, "id") else {
            return;
        };
        let Some(message_id) = compact_field(part, "messageID") else {
            return;
        };
        let Some(part_type) = compact_field(part, "type") else {
            return;
        };
        let turn_id = {
            let mut projections = self
                .projections
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(projection) = projections.get_mut(provider_session_id) else {
                return;
            };
            if !projection.assistant_message_ids.contains(&message_id) {
                return;
            }
            let turn_id = projection
                .part_turns
                .get(&part_id)
                .map(|(turn_id, _, _)| turn_id.clone())
                .or_else(|| projection.message_turns.get(&message_id).cloned());
            if let Some(turn_id) = turn_id.as_ref() {
                projection.part_turns.insert(
                    part_id.clone(),
                    (turn_id.clone(), message_id.clone(), part_type.clone()),
                );
            }
            turn_id
        };
        let Some(turn_id) = turn_id else {
            return;
        };
        let pending = self
            .aux
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pending_part_deltas
            .get_mut(provider_session_id)
            .and_then(|pending| {
                pending
                    .iter()
                    .position(|item| item.part_id == part_id)
                    .map(|index| pending.remove(index))
            });
        let has_text = part
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty());
        if let Some(pending) = pending.as_ref().filter(|_| !has_text) {
            if part_type == "text" {
                for chunk in &pending.chunks {
                    self.emit_part_delta(provider_session_id, &turn_id, &part_id, "text", chunk);
                }
            }
        }
        let value = Value::Object(part.clone());
        if part_type == "text" {
            if let Some(text) = part
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                let _ = self.events.send(ProviderEvent::AgentMessageCompleted {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: turn_id.clone(),
                    item_id: part_id.clone(),
                    text: text.to_string(),
                    observed_at: Some(now_iso()),
                });
                if let Some(state) = self
                    .reconcile_states
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .get_mut(provider_session_id)
                {
                    state.last_message_item_id = Some(part_id.clone());
                    state.last_message = Some(text.to_string());
                }
            }
        }
        let item = project_part(&value, &turn_id);
        if let Some(item) = item.as_ref() {
            let _ = self.events.send(ProviderEvent::TimelineItem {
                provider_session_id: provider_session_id.to_string(),
                item: item.clone(),
            });
        }
        if part_type != "text" {
            if let Some(pending) = pending.as_ref().filter(|_| !has_text) {
                if part_type == "reasoning" {
                    for chunk in &pending.chunks {
                        self.emit_part_delta(
                            provider_session_id,
                            &turn_id,
                            &part_id,
                            "reasoning",
                            chunk,
                        );
                    }
                }
            }
        }
        let Some(item) = item.as_ref() else {
            return;
        };
        if part_type != "tool" {
            return;
        }
        let AiSessionTimelineItem::Activity {
            id,
            title,
            status,
            input,
            summary,
            paths,
            ..
        } = item
        else {
            return;
        };
        let running = status.is_none_or(|status| {
            matches!(
                status,
                AiSessionTimelineActivityStatus::Running | AiSessionTimelineActivityStatus::Waiting
            )
        });
        let _ = self.events.send(ProviderEvent::ToolActivity {
            provider_session_id: provider_session_id.to_string(),
            turn_id: Some(turn_id),
            item: json!({
                "id": id,
                "kind": activity_kind(item),
                "name": title,
                "inputPreview": input.as_deref().or(summary.as_deref()),
                "paths": paths,
            }),
            running,
            observed_at: Some(now_iso()),
        });
        let status = if running { "running" } else { "completed" };
        if let Some(state) = self
            .reconcile_states
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(provider_session_id)
        {
            state.activities.insert(id.clone(), status.to_string());
        }
    }

    async fn reconcile_loop(
        self: Arc<Self>,
        mut receiver: mpsc::UnboundedReceiver<(String, String)>,
    ) {
        while let Some((session_id, directory)) = receiver.recv().await {
            tokio::time::sleep(OPENCODE_RECONCILE_DELAY).await;
            let mut requests = HashMap::from([(session_id, directory)]);
            while let Ok((session_id, directory)) = receiver.try_recv() {
                requests.insert(session_id, directory);
            }
            for (session_id, directory) in requests {
                if let Err(error) = self.reconcile_and_emit(&session_id, &directory).await {
                    tracing::debug!(provider_session_id = %session_id, %error, "OpenCode reconcile failed");
                }
            }
        }
    }

    async fn refresh_all(self: &Arc<Self>) -> Result<(), ProviderError> {
        self.ensure_ready().await?;
        let roots = self.client.connections.workspace_roots();
        let mut cursor = None;
        loop {
            let (sessions, next) = self.client.list_global_sessions(cursor.as_deref()).await?;
            for session in sessions {
                let Some(id) = session.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let Some(directory) = session.get("directory").and_then(Value::as_str) else {
                    continue;
                };
                let archived = session
                    .get("time")
                    .and_then(|time| time.get("archived"))
                    .is_some_and(|value| !value.is_null());
                if archived || !within_roots(directory, &roots) {
                    continue;
                }
                self.directories
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(id.to_string(), directory.to_string());
                let _ = self.reconcile_and_emit(id, directory).await;
            }
            cursor = next;
            if cursor.is_none() {
                break;
            }
        }
        Ok(())
    }

    async fn reconcile_and_emit(
        &self,
        provider_session_id: &str,
        directory: &str,
    ) -> Result<(), ProviderError> {
        let projection = self
            .refresh_projection(provider_session_id, directory)
            .await?;
        let previous = self
            .reconcile_states
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(provider_session_id)
            .cloned()
            .unwrap_or_default();
        let mut current = ReconcileState {
            lifecycle: projection.lifecycle.clone(),
            active_turn_id: if projection.lifecycle == "running"
                || projection.lifecycle == "waiting"
            {
                previous
                    .active_turn_id
                    .clone()
                    .or_else(|| projection.active_turn_id.clone())
            } else {
                None
            },
            user_turn_id: projection.last_turn_id.clone(),
            permission_id: projection.pending_permission_id.clone(),
            last_message_item_id: projection.last_message_item_id.clone(),
            last_message: projection.last_message.clone(),
            activities: HashMap::new(),
        };
        let _ = self.events.send(ProviderEvent::ThreadSnapshot {
            provider_session_id: provider_session_id.to_string(),
            cwd: Some(projection.cwd.clone()),
            name: (!projection.title.trim().is_empty()).then(|| projection.title.clone()),
            model: projection
                .model_selection
                .as_ref()
                .map(|selection| selection.upstream_name().to_string()),
            model_provider: projection
                .model_selection
                .as_ref()
                .map(opencode_provider_id),
            reasoning_effort: projection.reasoning_effort.clone(),
            status: projection.lifecycle.clone(),
            phase: Some(projection.phase.clone()),
        });
        if projection.parent_provider_session_id.is_none() {
            if let Some(prompt) = projection.timeline.iter().find_map(|item| match item {
                AiSessionTimelineItem::UserMessage { text, .. } if !text.trim().is_empty() => {
                    Some(text.trim().to_string())
                }
                _ => None,
            }) {
                self.maybe_generate_title(
                    provider_session_id,
                    directory,
                    &prompt,
                    &projection.title,
                );
            }
        }
        if previous.user_turn_id != current.user_turn_id {
            if let Some(turn_id) = current.user_turn_id.as_deref() {
                if let Some((item_id, text)) =
                    projection.timeline.iter().find_map(|item| match item {
                        AiSessionTimelineItem::UserMessage {
                            id,
                            turn_id: item_turn_id,
                            text,
                            ..
                        } if item_turn_id == turn_id => Some((id.clone(), text.clone())),
                        _ => None,
                    })
                {
                    let _ = self.events.send(ProviderEvent::UserMessage {
                        provider_session_id: provider_session_id.to_string(),
                        turn_id: turn_id.to_string(),
                        item_id,
                        text,
                        observed_at: Some(now_iso()),
                    });
                }
            }
        }
        let active = projection.lifecycle == "running" || projection.lifecycle == "waiting";
        let was_active = previous.lifecycle == "running" || previous.lifecycle == "waiting";
        if active && !was_active {
            if let Some(turn_id) = current.active_turn_id.as_deref() {
                let _ = self.events.send(ProviderEvent::TurnStarted {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    started_at: Some(now_iso()),
                });
            }
        }
        if active {
            if let Some(permission_id) = projection.pending_permission_id.as_deref() {
                if previous.permission_id.as_deref() != Some(permission_id) {
                    let summary = projection
                        .summary
                        .clone()
                        .unwrap_or_else(|| "OpenCode is requesting permission.".to_string());
                    let _ = self.events.send(ProviderEvent::ApprovalRequested {
                        provider_session_id: provider_session_id.to_string(),
                        turn_id: current.active_turn_id.clone(),
                        summary,
                        kind: "permission".to_string(),
                        item_id: Some(permission_id.to_string()),
                    });
                }
            }
        } else if was_active {
            let _ = self.events.send(ProviderEvent::TurnCompleted {
                provider_session_id: provider_session_id.to_string(),
                turn_id: previous
                    .active_turn_id
                    .clone()
                    .or_else(|| projection.last_turn_id.clone()),
                status: Some(if projection.lifecycle == "failed" {
                    "failed".to_string()
                } else {
                    "completed".to_string()
                }),
                error: projection.error.clone(),
                completed_at: Some(now_iso()),
            });
        }
        if projection.last_message_item_id != previous.last_message_item_id
            && projection.last_message != previous.last_message
        {
            if let (Some(item_id), Some(text), Some(turn_id)) = (
                projection.last_message_item_id.as_deref(),
                projection.last_message.as_deref(),
                projection.last_turn_id.as_deref(),
            ) {
                let _ = self.events.send(ProviderEvent::AgentMessageCompleted {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    item_id: item_id.to_string(),
                    text: text.to_string(),
                    observed_at: Some(now_iso()),
                });
            }
        }
        for item in &projection.timeline {
            let AiSessionTimelineItem::Activity {
                id,
                turn_id,
                title,
                status,
                input,
                summary,
                paths,
                ..
            } = item
            else {
                continue;
            };
            if !projection.tool_activity_ids.contains(id) {
                continue;
            }
            let status = status
                .map(|status| match status {
                    AiSessionTimelineActivityStatus::Running => "running",
                    AiSessionTimelineActivityStatus::Completed => "completed",
                    AiSessionTimelineActivityStatus::Failed => "failed",
                    AiSessionTimelineActivityStatus::Waiting => "waiting",
                })
                .unwrap_or("running");
            current.activities.insert(id.clone(), status.to_string());
            let previous_status = previous.activities.get(id).map(String::as_str);
            if matches!(status, "running" | "waiting") && previous_status != Some(status) {
                let _ = self.events.send(ProviderEvent::ToolActivity {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: Some(turn_id.clone()),
                    item: json!({
                        "id": id,
                        "kind": activity_kind(item),
                        "name": title,
                        "inputPreview": input.as_deref().or(summary.as_deref()),
                        "paths": paths,
                    }),
                    running: true,
                    observed_at: Some(now_iso()),
                });
            } else if previous_status.is_some_and(|status| matches!(status, "running" | "waiting"))
                && matches!(status, "completed" | "failed")
            {
                let _ = self.events.send(ProviderEvent::ToolActivity {
                    provider_session_id: provider_session_id.to_string(),
                    turn_id: Some(turn_id.clone()),
                    item: json!({ "id": id, "kind": activity_kind(item), "name": title }),
                    running: false,
                    observed_at: Some(now_iso()),
                });
            }
        }
        self.reconcile_states
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(provider_session_id.to_string(), current);
        Ok(())
    }

    async fn refresh_projection(
        &self,
        provider_session_id: &str,
        directory: &str,
    ) -> Result<OpenCodeProjection, ProviderError> {
        let (session, statuses, messages, permissions) = tokio::try_join!(
            self.client.get_session(provider_session_id, directory),
            self.client.status(directory),
            self.client.messages(provider_session_id, directory),
            self.client.permissions(directory),
        )?;
        let session_directory = session
            .get("directory")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(directory);
        self.directories
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                provider_session_id.to_string(),
                session_directory.to_string(),
            );
        let status = statuses
            .get(provider_session_id)
            .cloned()
            .unwrap_or_else(|| json!({ "type": "idle" }));
        let pending = self
            .pending_settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(provider_session_id)
            .cloned();
        let (retry_activities, terminal_error) = {
            let aux = self
                .aux
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (
                aux.retry_activities
                    .get(provider_session_id)
                    .cloned()
                    .unwrap_or_default(),
                aux.terminal_errors.get(provider_session_id).cloned(),
            )
        };
        let projector = self
            .model_selection_projector
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let mut projection = project_session(OpenCodeProjectionInput {
            session: &session,
            status: &status,
            messages: &messages,
            permissions: &permissions,
            pending_selection: pending
                .as_ref()
                .and_then(|settings| settings.model_selection.as_ref()),
            retry_activities: &retry_activities,
            terminal_error: terminal_error.as_deref(),
            model_selection_projector: projector.as_deref(),
        });
        if let Some(pending) = pending {
            let observed = projection.model_selection.as_ref();
            let same_selection = observed.is_some_and(|observed| {
                pending
                    .model_selection
                    .as_ref()
                    .is_some_and(|selection| same_model_selection(observed, selection))
            });
            if same_selection && projection.reasoning_effort == pending.reasoning_effort {
                self.pending_settings
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(provider_session_id);
            } else {
                projection.model_selection = pending.model_selection;
                if pending.reasoning_effort.is_some() {
                    projection.reasoning_effort = pending.reasoning_effort;
                }
            }
        }
        self.projections
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(provider_session_id.to_string(), projection.clone());
        Ok(projection)
    }

    fn projection_for_provider(&self, provider_session_id: &str) -> Option<OpenCodeProjection> {
        self.projections
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(provider_session_id)
            .cloned()
    }

    fn publish_projection_snapshot(&self, provider_session_id: &str, status: &str, phase: &str) {
        let Some(projection) = self.projection_for_provider(provider_session_id) else {
            return;
        };
        let _ = self.events.send(ProviderEvent::ThreadSnapshot {
            provider_session_id: provider_session_id.to_string(),
            cwd: Some(projection.cwd),
            name: (!projection.title.trim().is_empty()).then_some(projection.title),
            model: projection
                .model_selection
                .as_ref()
                .map(|selection| selection.upstream_name().to_string()),
            model_provider: projection
                .model_selection
                .as_ref()
                .map(opencode_provider_id),
            reasoning_effort: projection.reasoning_effort,
            status: status.to_string(),
            phase: Some(phase.to_string()),
        });
    }

    fn arm_title_generation(&self, provider_session_id: &str) {
        let mut aux = self
            .aux
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if aux.attempted_title_sessions.contains(provider_session_id) {
            return;
        }
        aux.armed_title_sessions
            .insert(provider_session_id.to_string());
        aux.title_generations
            .entry(provider_session_id.to_string())
            .or_insert(0);
    }

    fn cancel_title_generation(&self, provider_session_id: &str) {
        let mut aux = self
            .aux
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        aux.armed_title_sessions.remove(provider_session_id);
        aux.attempted_title_sessions
            .insert(provider_session_id.to_string());
        *aux.title_generations
            .entry(provider_session_id.to_string())
            .or_insert(0) += 1;
    }

    fn maybe_generate_title(
        &self,
        provider_session_id: &str,
        directory: &str,
        user_prompt: &str,
        current_title: &str,
    ) {
        if !is_default_opencode_session_title(current_title) {
            return;
        }
        let Some(generator) = self
            .title_generator
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        else {
            return;
        };
        let Some(projection) = self.projection_for_provider(provider_session_id) else {
            return;
        };
        let Some(model_selection) = projection.model_selection else {
            tracing::debug!(
                provider_session_id,
                "OpenCode title generation skipped because no model is resolved"
            );
            return;
        };
        let (generation, prompt) = {
            let mut aux = self
                .aux
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !aux.armed_title_sessions.remove(provider_session_id)
                || aux.attempted_title_sessions.contains(provider_session_id)
            {
                return;
            }
            aux.attempted_title_sessions
                .insert(provider_session_id.to_string());
            (
                *aux.title_generations.get(provider_session_id).unwrap_or(&0),
                ai_session_title_prompt(user_prompt),
            )
        };
        let Some(provider) = self
            .self_ref
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .upgrade()
        else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let directory = directory.to_string();
        let provider_session_id = provider_session_id.to_string();
        runtime.spawn(async move {
            let result = provider
                .generate_title(
                    &provider_session_id,
                    &directory,
                    generation,
                    prompt,
                    model_selection,
                    projection.reasoning_effort,
                    generator,
                )
                .await;
            if let Err(error) = result {
                tracing::debug!(
                    provider_session_id = %provider_session_id,
                    %error,
                    "OpenCode title generation failed"
                );
            }
        });
    }

    #[allow(clippy::too_many_arguments)]
    async fn generate_title(
        &self,
        provider_session_id: &str,
        directory: &str,
        generation: u64,
        prompt: String,
        model_selection: AiSessionModelSelection,
        reasoning_effort: Option<String>,
        generator: Arc<dyn AiSessionTitleGenerator>,
    ) -> Result<(), ProviderError> {
        let current = self
            .client
            .get_session(provider_session_id, directory)
            .await?;
        if current.get("parentID").and_then(Value::as_str).is_some()
            || current
                .get("title")
                .and_then(Value::as_str)
                .is_some_and(|title| !is_default_opencode_session_title(title))
        {
            return Ok(());
        }
        let response = generator
            .generate_title(AiSessionTitleInput {
                prompt,
                output_schema: ai_session_title_output_schema(),
                model_selection,
                reasoning_effort,
            })
            .await?;
        let Some(title) = parse_ai_session_title(&response) else {
            return Err(ProviderError::bad_gateway(
                "OPENCODE_SESSION_TITLE_INVALID",
                "OpenCode title model returned an invalid structured title.",
            ));
        };
        if !self.is_title_generation_current(provider_session_id, generation) {
            return Ok(());
        }
        let latest = self
            .client
            .get_session(provider_session_id, directory)
            .await?;
        if !self.is_title_generation_current(provider_session_id, generation)
            || latest
                .get("title")
                .and_then(Value::as_str)
                .is_none_or(|title| !is_default_opencode_session_title(title))
        {
            return Ok(());
        }
        self.client
            .rename_session(provider_session_id, directory, &title)
            .await?;
        self.reconcile_and_emit(provider_session_id, directory)
            .await
    }

    fn is_title_generation_current(&self, provider_session_id: &str, generation: u64) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        let aux = self
            .aux
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        aux.title_generations.get(provider_session_id) == Some(&generation)
            && self
                .projections
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key(provider_session_id)
    }

    fn record_retry_activity(&self, provider_session_id: &str, turn_id: &str, message: &str) {
        let mut aux = self
            .aux
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let activities = aux
            .retry_activities
            .entry(provider_session_id.to_string())
            .or_default();
        if let Some(activity) = activities
            .iter_mut()
            .find(|activity| activity.turn_id == turn_id)
        {
            activity.message = message.to_string();
            activity.completed = false;
        } else {
            activities.push(RetryActivity {
                turn_id: turn_id.to_string(),
                message: message.to_string(),
                completed: false,
            });
        }
        if activities.len() > 32 {
            activities.remove(0);
        }
    }

    fn complete_retry_activity(&self, provider_session_id: &str) -> Option<AiSessionTimelineItem> {
        let mut aux = self
            .aux
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let activities = aux.retry_activities.get_mut(provider_session_id)?;
        let retry = activities
            .iter_mut()
            .rev()
            .find(|activity| !activity.completed)?;
        retry.completed = true;
        Some(retry_activity(&retry.turn_id, &retry.message, true))
    }

    async fn resolve_directory(&self, provider_session_id: &str) -> Result<String, ProviderError> {
        if let Some(directory) = self
            .directories
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(provider_session_id)
            .cloned()
        {
            return Ok(directory);
        }
        let mut cursor = None;
        loop {
            let (sessions, next) = self.client.list_global_sessions(cursor.as_deref()).await?;
            if let Some(session) = sessions.into_iter().find(|session| {
                session.get("id").and_then(Value::as_str) == Some(provider_session_id)
            }) {
                if let Some(directory) = session.get("directory").and_then(Value::as_str) {
                    self.directories
                        .write()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .insert(provider_session_id.to_string(), directory.to_string());
                    return Ok(directory.to_string());
                }
            }
            cursor = next;
            if cursor.is_none() {
                break;
            }
        }
        Err(ProviderError::new(
            "AI_SESSION_NOT_FOUND",
            format!("OpenCode session {provider_session_id} was not found."),
            404,
        ))
    }

    fn model_ref(
        &self,
        selection: &AiSessionModelSelection,
        effort: Option<&str>,
    ) -> OpenCodeModelRef {
        OpenCodeModelRef {
            provider_id: opencode_provider_id(selection),
            model_id: selection.upstream_name().to_string(),
            variant: effort.map(ToString::to_string),
        }
    }

    async fn prompt_parts(
        &self,
        session: &AiSession,
        input: &ProviderMessage,
    ) -> Result<Vec<Value>, ProviderError> {
        let cwd = session.cwd.as_deref().map(PathBuf::from).ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_SEND_INVALID",
                "OpenCode session cwd is missing.",
                409,
            )
        })?;
        let mut parts = vec![];
        let mut path_references = Vec::<(AiSessionAttachmentKind, PathBuf)>::new();
        for attachment in &input.attachments {
            let mime = attachment.meta.mime.as_str();
            if !(mime.starts_with("audio/")
                || mime.starts_with("image/")
                || mime.starts_with("text/")
                || mime == "application/pdf")
            {
                path_references.push((attachment.meta.kind, attachment.path.clone()));
                continue;
            }
            let path = attachment.path.canonicalize().map_err(|_| {
                ProviderError::new(
                    "AI_SESSION_ATTACHMENT_PATH_INVALID",
                    "OpenCode attachment path is unavailable.",
                    400,
                )
            })?;
            if !within_roots(&path.display().to_string(), std::slice::from_ref(&cwd)) {
                return Err(ProviderError::new(
                    "AI_SESSION_ATTACHMENT_PATH_INVALID",
                    "OpenCode runtime-path attachments must remain inside the session workspace.",
                    400,
                ));
            }
            let url = Url::from_file_path(&path).map_err(|_| {
                ProviderError::new(
                    "AI_SESSION_ATTACHMENT_PATH_INVALID",
                    "OpenCode attachment path is invalid.",
                    400,
                )
            })?;
            parts.push(json!({
                "type": "file",
                "mime": mime,
                "filename": attachment.meta.name,
                "url": url.to_string()
            }));
        }
        let image_count = path_references
            .iter()
            .filter(|(kind, _)| *kind == AiSessionAttachmentKind::Image)
            .count();
        let file_count = path_references.len() - image_count;
        let mut image_index = 0;
        let mut file_index = 0;
        let lines = path_references
            .into_iter()
            .map(|(kind, path)| {
                let (label, count, index) = match kind {
                    AiSessionAttachmentKind::Image => {
                        image_index += 1;
                        ("图片", image_count, image_index)
                    }
                    AiSessionAttachmentKind::File => {
                        file_index += 1;
                        ("文件", file_count, file_index)
                    }
                };
                format!(
                    "{label}{}路径：{}",
                    if count > 1 {
                        index.to_string()
                    } else {
                        String::new()
                    },
                    path.display()
                )
            })
            .collect::<Vec<_>>();
        let text = [input.message.trim().to_string(), lines.join("\n")]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        parts.insert(0, json!({ "type": "text", "text": text }));
        Ok(parts)
    }

    async fn submit_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<String, ProviderError> {
        let provider_session_id = session.provider_session_id.as_deref().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_SEND_INVALID",
                "OpenCode session identity is missing.",
                409,
            )
        })?;
        let directory = session.cwd.clone().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_SEND_INVALID",
                "OpenCode session cwd is missing.",
                409,
            )
        })?;
        let message_id = input.message_id.clone().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_SEND_INVALID",
                "OpenCode message identity is required.",
                409,
            )
        })?;
        let parts = self.prompt_parts(session, &input).await?;
        if input.permission_mode.is_some() || input.story_agent_tools.is_some() {
            let current = self
                .client
                .get_session(provider_session_id, &directory)
                .await?;
            let current_permission = current
                .get("permission")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(rules) = permission_rules(
                input.permission_mode,
                input.story_agent_tools.as_deref(),
                &current_permission,
            ) {
                self.client
                    .update_session(
                        provider_session_id,
                        &directory,
                        json!({ "permission": rules }),
                    )
                    .await?;
            }
        }
        let selection = session
            .model_selection
            .clone()
            .and_then(|value| serde_json::from_value::<AiSessionModelSelection>(value).ok());
        let effort = session.reasoning_effort.as_deref();
        let model = selection
            .as_ref()
            .map(|selection| self.model_ref(selection, effort));
        self.client
            .prompt_async(
                provider_session_id,
                &directory,
                &message_id,
                parts,
                model.as_ref(),
            )
            .await?;
        let _ = self
            .reconcile_tx
            .send((provider_session_id.to_string(), directory.to_string()));
        Ok(message_id)
    }

    fn mark_submitted_turn(&self, provider_session_id: &str, message_id: &str, start: bool) {
        let mut states = self
            .reconcile_states
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = states.entry(provider_session_id.to_string()).or_default();
        state.lifecycle = "running".to_string();
        state.user_turn_id = Some(message_id.to_string());
        if start {
            state.active_turn_id = Some(message_id.to_string());
        }
    }
}

#[async_trait]
impl AiSessionControlProvider for OpenCodeSessionProvider {
    fn agent(&self) -> &str {
        "opencode"
    }

    fn capability(&self) -> AiSessionProviderCapability {
        AiSessionProviderCapability {
            agent: "opencode".to_string(),
            actions: AiSessionProviderActions {
                create: true,
                send: true,
                queue: true,
                steer: true,
                interrupt: true,
                archive: true,
                delete: true,
                fork: true,
                rename: true,
                approval_decisions: vec!["allow".to_string(), "deny".to_string()],
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
                select_model_at_resume: false,
                select_provider_at_resume: false,
                switch_model_within_provider: true,
                switch_provider_during_session: true,
                stable_identity: true,
            }),
            reasoning_effort: Some(AiSessionReasoningEffortCapabilities {
                select_at_create: true,
                update_during_session: true,
            }),
            hierarchy: Some(AiSessionHierarchyCapabilities { subagents: true }),
        }
    }

    fn close_detaches_provider_session(&self) -> bool {
        true
    }

    fn subscribe_events(&self) -> Option<broadcast::Receiver<ProviderEvent>> {
        Some(self.events.subscribe())
    }

    async fn create_session(
        &self,
        input: ProviderCreateInput,
    ) -> Result<ProviderCreateResult, ProviderError> {
        self.ensure_ready().await?;
        let model = input
            .model_selection
            .as_ref()
            .map(|selection| self.model_ref(selection, input.reasoning_effort.as_deref()));
        let permission = permission_rules(
            input.permission_mode,
            input.story_agent_tools.as_deref(),
            &[],
        );
        let created = self
            .client
            .create_session(&input.cwd.display().to_string(), model.as_ref(), permission)
            .await?;
        let provider_session_id = created
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ProviderError::bad_gateway(
                    "OPENCODE_CREATE_INVALID_RESPONSE",
                    "OpenCode returned no session identity.",
                )
            })?
            .to_string();
        let directory = created
            .get("directory")
            .and_then(Value::as_str)
            .unwrap_or_else(|| input.cwd.to_str().unwrap_or_default())
            .to_string();
        self.arm_title_generation(&provider_session_id);
        let _ = self
            .reconcile_and_emit(&provider_session_id, &directory)
            .await;
        Ok(ProviderCreateResult {
            provider_session_id,
            cwd: PathBuf::from(directory),
            model_selection: input.model_selection,
            reasoning_effort: input.reasoning_effort,
        })
    }

    async fn start_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        let message_id = self.submit_message(session, input).await?;
        if let Some(provider_session_id) = session.provider_session_id.as_deref() {
            self.mark_submitted_turn(provider_session_id, &message_id, true);
        }
        Ok(ProviderAction {
            action: "send".to_string(),
            turn_id: Some(message_id.clone()),
            provider_turn_id: Some(message_id),
            decision: None,
            queue_id: None,
        })
    }

    async fn steer_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        let message_id = self.submit_message(session, input).await?;
        if let Some(provider_session_id) = session.provider_session_id.as_deref() {
            self.mark_submitted_turn(provider_session_id, &message_id, false);
        }
        Ok(ProviderAction {
            action: "steer".to_string(),
            turn_id: session.active_turn_id.clone(),
            provider_turn_id: session.active_turn_id.clone(),
            decision: None,
            queue_id: None,
        })
    }

    async fn interrupt(&self, session: &AiSession) -> Result<ProviderAction, ProviderError> {
        let provider_session_id = session.provider_session_id.as_deref().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_NOT_FOUND",
                "OpenCode session identity is missing.",
                404,
            )
        })?;
        let directory = self.resolve_directory(provider_session_id).await?;
        self.client.abort(provider_session_id, &directory).await?;
        Ok(ProviderAction::simple("interrupt"))
    }

    async fn resolve_approval(
        &self,
        session: &AiSession,
        decision: &str,
    ) -> Result<ProviderAction, ProviderError> {
        if decision == "skip" {
            return Err(ProviderError::new(
                "AI_SESSION_APPROVAL_UNSUPPORTED",
                "OpenCode has no equivalent for skipping a permission request.",
                409,
            ));
        }
        let provider_session_id = session.provider_session_id.as_deref().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_NOT_FOUND",
                "OpenCode session identity is missing.",
                404,
            )
        })?;
        let directory = self.resolve_directory(provider_session_id).await?;
        let projection = self
            .refresh_projection(provider_session_id, &directory)
            .await?;
        let permission_id = projection.pending_permission_id.ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_APPROVAL_NOT_FOUND",
                "No pending OpenCode permission request was found.",
                404,
            )
        })?;
        self.client
            .reply_permission(
                &permission_id,
                &directory,
                if decision == "allow" {
                    "once"
                } else {
                    "reject"
                },
            )
            .await?;
        let _ = self.events.send(ProviderEvent::ApprovalResolved {
            provider_session_id: provider_session_id.to_string(),
            decision: decision.to_string(),
        });
        if let Some(state) = self
            .reconcile_states
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(provider_session_id)
        {
            state.lifecycle = "running".to_string();
            state.permission_id = Some(permission_id);
        }
        let _ = self
            .reconcile_and_emit(provider_session_id, &directory)
            .await;
        Ok(ProviderAction {
            action: "approval".to_string(),
            turn_id: projection.active_turn_id,
            provider_turn_id: None,
            decision: Some(decision.to_string()),
            queue_id: None,
        })
    }

    async fn rename_session(&self, session: &AiSession, title: &str) -> Result<(), ProviderError> {
        let provider_session_id = session.provider_session_id.as_deref().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_RENAME_UNSUPPORTED",
                "OpenCode session identity is incomplete.",
                409,
            )
        })?;
        let directory = self.resolve_directory(provider_session_id).await?;
        let updated = self
            .client
            .rename_session(provider_session_id, &directory, title)
            .await?;
        if updated.get("title").and_then(Value::as_str) != Some(title) {
            return Err(ProviderError::bad_gateway(
                "AI_SESSION_RENAME_NOT_CONFIRMED",
                "OpenCode did not confirm the requested session title.",
            ));
        }
        let _ = self
            .reconcile_and_emit(provider_session_id, &directory)
            .await;
        Ok(())
    }

    async fn resume_session(
        &self,
        session: &AiSession,
    ) -> Result<ProviderResumeResult, ProviderError> {
        let provider_session_id = session.provider_session_id.as_deref().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_RESUME_UNAVAILABLE",
                "OpenCode session has no provider identity.",
                409,
            )
        })?;
        self.ensure_ready().await?;
        let directory = self.resolve_directory(provider_session_id).await?;
        let current = self
            .client
            .get_session(provider_session_id, &directory)
            .await?;
        if current
            .get("time")
            .and_then(|value| value.get("archived"))
            .is_some_and(|value| !value.is_null())
        {
            return Err(ProviderError::new(
                "AI_SESSION_RESUME_UNAVAILABLE",
                "OpenCode cannot restore an archived session.",
                409,
            ));
        }
        let projection = self
            .refresh_projection(provider_session_id, &directory)
            .await?;
        if projection.parent_provider_session_id.is_none()
            && is_default_opencode_session_title(&projection.title)
        {
            self.arm_title_generation(provider_session_id);
            if let Some(prompt) = projection.timeline.iter().find_map(|item| match item {
                AiSessionTimelineItem::UserMessage { text, .. } if !text.trim().is_empty() => {
                    Some(text.trim().to_string())
                }
                _ => None,
            }) {
                self.maybe_generate_title(
                    provider_session_id,
                    &directory,
                    &prompt,
                    &projection.title,
                );
            }
        }
        Ok(ProviderResumeResult {
            model_selection: projection.model_selection,
            reasoning_effort: projection.reasoning_effort,
        })
    }

    async fn fork_session(
        &self,
        source: &AiSession,
        input: ProviderForkInput,
    ) -> Result<ProviderCreateResult, ProviderError> {
        let provider_session_id = source.provider_session_id.as_deref().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_FORK_UNSUPPORTED",
                "OpenCode session has no provider identity.",
                409,
            )
        })?;
        let directory = match input.cwd.as_ref() {
            Some(path) => path.display().to_string(),
            None => match source.cwd.clone() {
                Some(path) => path,
                None => self.resolve_directory(provider_session_id).await?,
            },
        };
        let messages = self
            .client
            .messages(provider_session_id, &directory)
            .await?;
        let message_id = input
            .through_turn_id
            .as_deref()
            .and_then(|turn_id| next_user_message_id(&messages, turn_id));
        if input.through_turn_id.is_some() && message_id.is_none() {
            return Err(ProviderError::new(
                "AI_SESSION_FORK_TURN_NOT_FOUND",
                "OpenCode Fork boundary was not found.",
                404,
            ));
        }
        let forked = self
            .client
            .fork_session(provider_session_id, &directory, message_id.as_deref())
            .await?;
        let forked_id = forked
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProviderError::bad_gateway(
                    "OPENCODE_FORK_INVALID_RESPONSE",
                    "OpenCode returned no Fork session identity.",
                )
            })?
            .to_string();
        let forked_directory = forked
            .get("directory")
            .and_then(Value::as_str)
            .unwrap_or(&directory)
            .to_string();
        self.arm_title_generation(&forked_id);
        let _ = self.reconcile_and_emit(&forked_id, &forked_directory).await;
        Ok(ProviderCreateResult {
            provider_session_id: forked_id,
            cwd: PathBuf::from(forked_directory),
            model_selection: source
                .model_selection
                .clone()
                .and_then(|value| serde_json::from_value(value).ok()),
            reasoning_effort: source.reasoning_effort.clone(),
        })
    }

    async fn update_model_selection(
        &self,
        session: &AiSession,
        selection: &AiSessionModelSelection,
    ) -> Result<Option<AiSessionModelSelection>, ProviderError> {
        if matches!(session.status.as_str(), "running" | "waiting") {
            return Err(ProviderError::conflict(
                "AI_SESSION_MODEL_SELECTION_CONFLICT",
                "Model cannot be changed while a turn is active.",
            ));
        }
        let provider_session_id = session.provider_session_id.as_deref().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_NOT_FOUND",
                "OpenCode session identity is missing.",
                404,
            )
        })?;
        self.pending_settings
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(provider_session_id.to_string())
            .or_default()
            .model_selection = Some(selection.clone());
        Ok(Some(selection.clone()))
    }

    async fn update_reasoning_effort(
        &self,
        session: &AiSession,
        reasoning_effort: &str,
    ) -> Result<Option<String>, ProviderError> {
        if matches!(session.status.as_str(), "running" | "waiting") {
            return Err(ProviderError::conflict(
                "AI_SESSION_REASONING_EFFORT_CONFLICT",
                "Reasoning effort cannot be changed while a turn is active.",
            ));
        }
        let provider_session_id = session.provider_session_id.as_deref().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_NOT_FOUND",
                "OpenCode session identity is missing.",
                404,
            )
        })?;
        let selection = self
            .pending_settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(provider_session_id)
            .and_then(|settings| settings.model_selection.clone())
            .or_else(|| {
                session
                    .model_selection
                    .clone()
                    .and_then(|value| serde_json::from_value(value).ok())
            })
            .ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_REASONING_EFFORT_UNKNOWN",
                    "The current OpenCode model is unknown.",
                    409,
                )
            })?;
        if !is_reasoning_effort(reasoning_effort) {
            return Err(ProviderError::new(
                "AI_SESSION_REASONING_EFFORT_UNSUPPORTED",
                "OpenCode reasoning variant is unavailable.",
                409,
            ));
        }
        self.pending_settings
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(provider_session_id.to_string())
            .or_insert_with(|| PendingSettings {
                model_selection: Some(selection),
                reasoning_effort: None,
            })
            .reasoning_effort = Some(reasoning_effort.to_string());
        Ok(Some(reasoning_effort.to_string()))
    }

    async fn archive_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        let directory = self.resolve_directory(provider_session_id).await?;
        self.client
            .archive_session(provider_session_id, &directory)
            .await?;
        self.forget(provider_session_id);
        Ok(())
    }

    async fn delete_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        let directory = self.resolve_directory(provider_session_id).await?;
        self.client
            .delete_session(provider_session_id, &directory)
            .await?;
        self.forget(provider_session_id);
        Ok(())
    }

    async fn unsubscribe_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.forget(provider_session_id);
        Ok(())
    }

    async fn timeline(&self, session: &AiSession) -> Result<AiSessionTimeline, ProviderError> {
        let provider_session_id = session.provider_session_id.as_deref().ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_NOT_FOUND",
                "OpenCode session identity is missing.",
                404,
            )
        })?;
        let directory = self.resolve_directory(provider_session_id).await?;
        let projection = self
            .refresh_projection(provider_session_id, &directory)
            .await?;
        Ok(AiSessionTimeline {
            session_id: session.id.clone(),
            provider_session_id: provider_session_id.to_string(),
            items: projection.timeline,
            generated_at: now_iso(),
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
            turn_id: turn_id.to_string(),
            items: timeline
                .items
                .into_iter()
                .filter(|item| item.turn_id() == turn_id)
                .collect(),
            generated_at: timeline.generated_at,
        })
    }
}

impl OpenCodeSessionProvider {
    fn forget(&self, provider_session_id: &str) {
        self.directories
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(provider_session_id);
        self.projections
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(provider_session_id);
        self.pending_settings
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(provider_session_id);
        self.reconcile_states
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(provider_session_id);
        let mut aux = self
            .aux
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        aux.pending_part_deltas.remove(provider_session_id);
        aux.retry_activities.remove(provider_session_id);
        aux.terminal_errors.remove(provider_session_id);
        aux.armed_title_sessions.remove(provider_session_id);
        aux.attempted_title_sessions.remove(provider_session_id);
        *aux.title_generations
            .entry(provider_session_id.to_string())
            .or_insert(0) += 1;
    }
}

struct OpenCodeProjectionInput<'a> {
    session: &'a Value,
    status: &'a Value,
    messages: &'a [Value],
    permissions: &'a [Value],
    pending_selection: Option<&'a AiSessionModelSelection>,
    retry_activities: &'a [RetryActivity],
    terminal_error: Option<&'a str>,
    model_selection_projector: Option<&'a dyn OpenCodeModelSelectionProjector>,
}

fn project_session(input: OpenCodeProjectionInput<'_>) -> OpenCodeProjection {
    let OpenCodeProjectionInput {
        session,
        status,
        messages,
        permissions,
        pending_selection,
        retry_activities,
        terminal_error,
        model_selection_projector,
    } = input;
    let session_id = session
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut messages = messages.to_vec();
    messages.sort_by(|left, right| {
        message_created(left)
            .partial_cmp(&message_created(right))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let pending_permission = permissions
        .iter()
        .filter(|permission| {
            permission.get("sessionID").and_then(Value::as_str) == Some(session_id.as_str())
        })
        .next_back()
        .cloned();
    let users = messages
        .iter()
        .filter(|message| message_role(message) == Some("user"))
        .collect::<Vec<_>>();
    let latest_user_id = users
        .last()
        .and_then(|message| message_id(message))
        .map(ToString::to_string);
    let status_type = status.get("type").and_then(Value::as_str).unwrap_or("idle");
    let active = status_type != "idle";
    let mut timeline = Vec::new();
    let mut part_turns = HashMap::new();
    let mut message_turns = HashMap::new();
    let mut assistant_message_ids = HashSet::new();
    let mut tool_activity_ids = HashSet::new();
    let mut last_turn_id = None;
    let mut last_message = None;
    let mut last_message_item_id = None;
    let latest_assistant_error = messages
        .iter()
        .rev()
        .find(|message| message_role(message) == Some("assistant"))
        .and_then(|message| message.get("info"))
        .and_then(|info| info.get("error"))
        .and_then(opencode_error_text);
    let error = terminal_error
        .map(ToString::to_string)
        .or(latest_assistant_error);
    for user in &users {
        let Some(turn_id) = message_id(user) else {
            continue;
        };
        message_turns.insert(turn_id.to_string(), turn_id.to_string());
        for part in message_parts(user) {
            if let Some(part_id) = part.get("id").and_then(Value::as_str) {
                part_turns.insert(
                    part_id.to_string(),
                    (
                        turn_id.to_string(),
                        turn_id.to_string(),
                        part_type(part).unwrap_or_default().to_string(),
                    ),
                );
            }
        }
        let assistants = messages
            .iter()
            .filter(|message| {
                message_role(message) == Some("assistant")
                    && message
                        .get("info")
                        .and_then(|info| info.get("parentID"))
                        .and_then(Value::as_str)
                        == Some(turn_id)
            })
            .collect::<Vec<_>>();
        let user_parts = message_parts(user);
        let text = user_parts
            .iter()
            .filter(|part| is_visible_text_part(part))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
        let attachments = conversation_attachments(user_parts);
        timeline.push(AiSessionTimelineItem::UserMessage {
            id: turn_id.to_string(),
            turn_id: turn_id.to_string(),
            text,
            attachments: (!attachments.is_empty()).then_some(attachments),
        });
        for assistant in &assistants {
            let Some(message_id) = message_id(assistant) else {
                continue;
            };
            message_turns.insert(message_id.to_string(), turn_id.to_string());
            assistant_message_ids.insert(message_id.to_string());
            for part in message_parts(assistant) {
                if let Some(part_id) = part.get("id").and_then(Value::as_str) {
                    part_turns.insert(
                        part_id.to_string(),
                        (
                            turn_id.to_string(),
                            message_id.to_string(),
                            part_type(part).unwrap_or_default().to_string(),
                        ),
                    );
                    if part_type(part) == Some("tool") {
                        tool_activity_ids.insert(part_id.to_string());
                    }
                }
                if let Some(item) = project_part(part, turn_id) {
                    timeline.push(item);
                }
            }
            if let Some(part) = message_parts(assistant)
                .iter()
                .rev()
                .find(|part| is_visible_text_part(part))
            {
                if let Some(value) = part.get("text").and_then(Value::as_str) {
                    if !value.trim().is_empty() {
                        last_message = Some(value.trim().to_string());
                        last_message_item_id = part
                            .get("id")
                            .and_then(Value::as_str)
                            .map(ToString::to_string);
                    }
                }
            }
        }
        last_turn_id = Some(turn_id.to_string());
    }
    let mut projected_retries = retry_activities.to_vec();
    if status_type == "retry" {
        if let (Some(turn_id), Some(message)) = (
            last_turn_id.as_deref(),
            status.get("message").and_then(Value::as_str),
        ) {
            if !projected_retries
                .iter()
                .any(|retry| retry.turn_id == turn_id)
            {
                projected_retries.push(RetryActivity {
                    turn_id: turn_id.to_string(),
                    message: message.to_string(),
                    completed: false,
                });
            }
        }
    }
    for retry in &projected_retries {
        timeline.push(retry_activity(
            &retry.turn_id,
            &retry.message,
            retry.completed,
        ));
    }
    let waiting = pending_permission.is_some()
        && active
        && latest_user_id.as_deref() == last_turn_id.as_deref();
    let lifecycle = if waiting {
        "waiting"
    } else if error.is_some() {
        "failed"
    } else if active {
        "running"
    } else {
        "idle"
    };
    let phase = if waiting {
        "approval"
    } else if status_type == "retry" {
        "thinking"
    } else if active {
        active_phase(&messages)
    } else {
        "unknown"
    };
    let actual_model = latest_user_model(&messages).or_else(|| {
        session.get("model").and_then(|model| {
            Some((
                model.get("providerID").and_then(Value::as_str)?.to_string(),
                model.get("id").and_then(Value::as_str)?.to_string(),
                model
                    .get("variant")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            ))
        })
    });
    let model_selection = actual_model
        .as_ref()
        .and_then(|(provider_id, model_id, _)| {
            model_selection_projector
                .and_then(|projector| projector.project_model_selection(provider_id, model_id))
                .or_else(|| project_model_selection(provider_id, model_id, pending_selection))
        })
        .or_else(|| pending_selection.cloned());
    let reasoning_effort = actual_model
        .as_ref()
        .and_then(|(_, _, variant)| variant.as_deref())
        .filter(|value| is_reasoning_effort(value))
        .map(ToString::to_string);
    let permission_summary = pending_permission.as_ref().map(permission_summary);
    OpenCodeProjection {
        title: session
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("OpenCode")
            .to_string(),
        cwd: session
            .get("directory")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        lifecycle: lifecycle.to_string(),
        phase: phase.to_string(),
        active_turn_id: (lifecycle == "running" || lifecycle == "waiting")
            .then(|| last_turn_id.clone())
            .flatten(),
        last_turn_id,
        last_message,
        last_message_item_id,
        error,
        summary: permission_summary,
        model_selection,
        reasoning_effort,
        pending_permission_id: pending_permission
            .as_ref()
            .and_then(|permission| permission.get("id"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        parent_provider_session_id: session
            .get("parentID")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        timeline,
        part_turns,
        message_turns,
        assistant_message_ids,
        tool_activity_ids,
    }
}

fn activity_kind(item: &AiSessionTimelineItem) -> &str {
    match item {
        AiSessionTimelineItem::Activity { activity_kind, .. } => activity_kind,
        _ => "dynamicToolCall",
    }
}

fn project_part(part: &Value, turn_id: &str) -> Option<AiSessionTimelineItem> {
    let id = part.get("id").and_then(Value::as_str)?.to_string();
    match part_type(part)? {
        "text" => {
            let text = part.get("text").and_then(Value::as_str)?.trim();
            (!text.is_empty()).then(|| AiSessionTimelineItem::AiMessage {
                id,
                turn_id: turn_id.to_string(),
                text: text.to_string(),
            })
        }
        "reasoning" => Some(activity(
            id,
            turn_id,
            "reasoning",
            "Reasoning",
            Some(
                if part.get("time").and_then(|time| time.get("end")).is_some() {
                    AiSessionTimelineActivityStatus::Completed
                } else {
                    AiSessionTimelineActivityStatus::Running
                },
            ),
            None,
            part.get("text")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            None,
            None,
            None,
        )),
        "file" => {
            let filename = part
                .get("filename")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let image = part
                .get("mime")
                .and_then(Value::as_str)
                .is_some_and(|mime| mime.starts_with("image/"));
            Some(activity(
                id,
                turn_id,
                if image { "imageView" } else { "fileRead" },
                if image { "View image" } else { "Read file" },
                Some(AiSessionTimelineActivityStatus::Completed),
                filename.clone(),
                None,
                filename.clone(),
                filename.map(|path| vec![path]),
                None,
            ))
        }
        "tool" => Some(project_tool(
            &id,
            turn_id,
            part.get("tool").and_then(Value::as_str).unwrap_or("Tool"),
            part.get("state").and_then(Value::as_object),
        )),
        "compaction" => Some(activity(
            id,
            turn_id,
            "contextCompaction",
            "Context compaction",
            Some(AiSessionTimelineActivityStatus::Completed),
            None,
            None,
            None,
            None,
            None,
        )),
        "retry" => Some(activity(
            id,
            turn_id,
            "retry",
            "Retry",
            Some(AiSessionTimelineActivityStatus::Waiting),
            opencode_error_text(part.get("error").unwrap_or(&Value::Null)),
            None,
            None,
            None,
            None,
        )),
        _ => None,
    }
}

fn project_tool(
    id: &str,
    turn_id: &str,
    tool: &str,
    state: Option<&Map<String, Value>>,
) -> AiSessionTimelineItem {
    let state = state.cloned().unwrap_or_default();
    let input = state
        .get("input")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let metadata = state
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let tool_name = tool.to_ascii_lowercase();
    let fallback_title = string_field(&state, "title").unwrap_or_else(|| tool.to_string());
    let (kind, title, summary, input, _input_preview, paths, exit_code) = match tool_name.as_str() {
        "bash" | "shell" => (
            "commandExecution",
            "Command",
            None,
            string_field(&input, "command").or_else(|| string_field(&input, "cmd")),
            string_field(&input, "command").or_else(|| string_field(&input, "cmd")),
            None,
            metadata.get("exit").and_then(Value::as_i64),
        ),
        "edit" | "write" => {
            let path = string_field(&input, "filePath")
                .or_else(|| string_field(&input, "filepath"))
                .or_else(|| string_field(&metadata, "filepath"));
            (
                "fileChange",
                if tool_name == "write" {
                    "Write file"
                } else {
                    "Edit file"
                },
                path.clone(),
                string_field(&metadata, "diff")
                    .or_else(|| safe_json(&Value::Object(input.clone()))),
                path.clone(),
                path.map(|path| vec![path]),
                None,
            )
        }
        "apply_patch" | "patch" => {
            let files = metadata
                .get("files")
                .and_then(Value::as_array)
                .map(|files| {
                    files
                        .iter()
                        .filter_map(Value::as_object)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let mut paths = files
                .iter()
                .filter_map(|file| {
                    string_field(file, "movePath")
                        .or_else(|| string_field(file, "filePath"))
                        .or_else(|| string_field(file, "relativePath"))
                })
                .collect::<Vec<_>>();
            paths.dedup();
            let summary = if paths.is_empty() {
                fallback_title.clone()
            } else {
                paths.join(", ")
            };
            (
                "fileChange",
                "File changes",
                Some(summary.clone()),
                if files.is_empty() {
                    string_field(&input, "patchText")
                        .or_else(|| safe_json(&Value::Object(input.clone())))
                } else {
                    safe_json(&Value::Array(
                        files
                            .iter()
                            .map(|file| Value::Object((*file).clone()))
                            .collect(),
                    ))
                },
                Some(summary),
                (!paths.is_empty()).then_some(paths),
                None,
            )
        }
        "task" => {
            let description = string_field(&input, "description").unwrap_or(fallback_title);
            let agent = string_field(&input, "subagent_type");
            let summary = [
                Some(description.clone()),
                agent.map(|agent| format!("@{agent}")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
            (
                "collabAgentToolCall",
                "Sub-agent task",
                Some(summary),
                string_field(&input, "prompt").or_else(|| safe_json(&Value::Object(input.clone()))),
                Some(description),
                None,
                None,
            )
        }
        "websearch" => {
            let query = string_field(&input, "query");
            (
                "webSearch",
                "Web search",
                query.clone().or(Some(fallback_title)),
                query
                    .clone()
                    .or_else(|| safe_json(&Value::Object(input.clone()))),
                query,
                None,
                None,
            )
        }
        "read" => {
            let path =
                string_field(&input, "filePath").or_else(|| string_field(&input, "filepath"));
            let image = state
                .get("attachments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object)
                .any(|attachment| {
                    string_field(attachment, "mime").is_some_and(|mime| mime.starts_with("image/"))
                });
            (
                if image { "imageView" } else { "fileRead" },
                if image { "View image" } else { "Read file" },
                path.clone().or(Some(fallback_title)),
                safe_json(&Value::Object(input.clone())),
                path.clone(),
                path.map(|path| vec![path]),
                None,
            )
        }
        "glob" | "grep" => {
            let pattern = string_field(&input, "pattern");
            let path = string_field(&input, "path");
            let summary = [pattern.clone(), path.clone()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
            (
                "fileSearch",
                if tool_name == "glob" {
                    "Find files"
                } else {
                    "Search files"
                },
                (!summary.is_empty())
                    .then_some(summary)
                    .or(Some(fallback_title)),
                safe_json(&Value::Object(input.clone())),
                pattern.clone().or(path.clone()),
                path.map(|path| vec![path]),
                None,
            )
        }
        "webfetch" => {
            let url = string_field(&input, "url");
            (
                "webFetch",
                "Fetch URL",
                url.clone().or(Some(fallback_title)),
                url.clone(),
                url,
                None,
                None,
            )
        }
        "todowrite" => {
            let count = input
                .get("todos")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or_default();
            let summary = if count == 0 {
                fallback_title
            } else {
                format!("{count} task{}", if count == 1 { "" } else { "s" })
            };
            (
                "todoUpdate",
                "Update tasks",
                Some(summary.clone()),
                safe_json(&Value::Object(input.clone())),
                Some(summary),
                None,
                None,
            )
        }
        "question" => {
            let count = input
                .get("questions")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or_default();
            let summary = if count == 0 {
                fallback_title
            } else {
                format!("{count} question{}", if count == 1 { "" } else { "s" })
            };
            (
                "userQuestion",
                "Ask user",
                Some(summary.clone()),
                safe_json(&Value::Object(input.clone())),
                Some(summary),
                None,
                None,
            )
        }
        "skill" => {
            let name = string_field(&input, "name");
            (
                "skillLoad",
                "Load skill",
                name.clone().or(Some(fallback_title)),
                safe_json(&Value::Object(input.clone())),
                name,
                None,
                None,
            )
        }
        "plan_exit" => (
            "exitedPlanMode",
            "Exit plan mode",
            (fallback_title != tool).then_some(fallback_title),
            safe_json(&Value::Object(input.clone())),
            None,
            None,
            None,
        ),
        _ => (
            "dynamicToolCall",
            tool,
            (fallback_title != tool).then_some(fallback_title),
            safe_json(&Value::Object(input.clone())),
            safe_json(&Value::Object(input)),
            None,
            None,
        ),
    };
    let failed_exit = kind == "commandExecution" && exit_code.is_some_and(|exit| exit != 0);
    let status = match (state.get("status").and_then(Value::as_str), failed_exit) {
        (Some("completed"), true) | (Some("error"), _) => AiSessionTimelineActivityStatus::Failed,
        (Some("completed"), false) => AiSessionTimelineActivityStatus::Completed,
        (Some("pending"), _) => AiSessionTimelineActivityStatus::Waiting,
        _ => AiSessionTimelineActivityStatus::Running,
    };
    let duration_ms = state
        .get("time")
        .and_then(Value::as_object)
        .and_then(|time| {
            let start = time.get("start")?.as_f64()?;
            let end = time.get("end")?.as_f64()?;
            Some((end - start).max(0.0) as u64)
        });
    AiSessionTimelineItem::Activity {
        id: id.to_string(),
        turn_id: turn_id.to_string(),
        activity_kind: kind.to_string(),
        title: title.to_string(),
        status: Some(status),
        summary,
        input,
        output: state
            .get("output")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| {
                state
                    .get("error")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .or_else(|| {
                metadata
                    .get("output")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            }),
        paths,
        exit_code,
        duration_ms,
    }
}

#[allow(clippy::too_many_arguments)]
fn activity(
    id: String,
    turn_id: &str,
    kind: &str,
    title: &str,
    status: Option<AiSessionTimelineActivityStatus>,
    summary: Option<String>,
    output: Option<String>,
    input: Option<String>,
    paths: Option<Vec<String>>,
    exit_code: Option<i64>,
) -> AiSessionTimelineItem {
    AiSessionTimelineItem::Activity {
        id,
        turn_id: turn_id.to_string(),
        activity_kind: kind.to_string(),
        title: title.to_string(),
        status,
        summary,
        input,
        output,
        paths,
        exit_code,
        duration_ms: None,
    }
}

fn retry_activity(turn_id: &str, message: &str, completed: bool) -> AiSessionTimelineItem {
    activity(
        format!("opencode_retry:{turn_id}"),
        turn_id,
        "retry",
        "Retry",
        Some(if completed {
            AiSessionTimelineActivityStatus::Completed
        } else {
            AiSessionTimelineActivityStatus::Waiting
        }),
        Some(bounded(message, 4000).unwrap_or_default()),
        None,
        None,
        None,
        None,
    )
}

fn permission_rules(
    mode: Option<AiSessionPermissionMode>,
    enabled_tools: Option<&[String]>,
    current: &[Value],
) -> Option<Vec<Value>> {
    if mode.is_none() && enabled_tools.is_none() {
        return None;
    }
    let mut rules = match mode {
        Some(AiSessionPermissionMode::FullAccess) => {
            vec![json!({ "permission": "*", "pattern": "*", "action": "allow" })]
        }
        Some(AiSessionPermissionMode::AutoReview) => vec![
            json!({ "permission": "*", "pattern": "*", "action": "ask" }),
            json!({ "permission": "read", "pattern": "*", "action": "allow" }),
            json!({ "permission": "grep", "pattern": "*", "action": "allow" }),
            json!({ "permission": "glob", "pattern": "*", "action": "allow" }),
        ],
        Some(AiSessionPermissionMode::Ask) => {
            vec![json!({ "permission": "*", "pattern": "*", "action": "ask" })]
        }
        None => current
            .iter()
            .filter(|rule| {
                !rule
                    .get("permission")
                    .and_then(Value::as_str)
                    .is_some_and(|name| AI_SESSION_AGENT_TOOL_NAMES.contains(&name))
            })
            .cloned()
            .collect(),
    };
    if let Some(enabled_tools) = enabled_tools {
        let enabled = enabled_tools
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        rules.extend(AI_SESSION_AGENT_TOOL_NAMES.iter().map(|permission| {
            json!({
                "permission": permission,
                "pattern": "*",
                "action": if enabled.contains(permission) { "allow" } else { "deny" }
            })
        }));
    }
    Some(rules)
}

fn project_model_selection(
    provider_id: &str,
    model_id: &str,
    existing: Option<&AiSessionModelSelection>,
) -> Option<AiSessionModelSelection> {
    let entity_id = provider_id
        .strip_prefix("task-handoff-")
        .unwrap_or(provider_id);
    if let Some(existing) = existing {
        if existing.model_entity_id == entity_id {
            let mut selection = existing.clone();
            selection.model_upstream_name = Some(model_id.to_string());
            return Some(selection);
        }
    }
    Some(AiSessionModelSelection {
        model_entity_id: entity_id.to_string(),
        model_name: model_id.to_string(),
        model_upstream_name: Some(model_id.to_string()),
    })
}

fn same_model_selection(left: &AiSessionModelSelection, right: &AiSessionModelSelection) -> bool {
    left.model_entity_id == right.model_entity_id
        && (left.upstream_name() == right.upstream_name() || left.model_name == right.model_name)
}

fn opencode_provider_id(selection: &AiSessionModelSelection) -> String {
    format!("task-handoff-{}", selection.model_entity_id)
}

fn next_user_message_id(messages: &[Value], through_turn_id: &str) -> Option<String> {
    let mut messages = messages.to_vec();
    messages.sort_by(|left, right| {
        message_created(left)
            .partial_cmp(&message_created(right))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let index = messages.iter().position(|message| {
        message_role(message) == Some("user") && message_id(message) == Some(through_turn_id)
    })?;
    messages[index + 1..]
        .iter()
        .find(|message| message_role(message) == Some("user"))
        .and_then(message_id)
        .map(ToString::to_string)
}

fn conversation_attachments(parts: &[Value]) -> Vec<AiSessionConversationAttachment> {
    parts
        .iter()
        .filter(|part| part_type(part) == Some("file"))
        .filter_map(|part| {
            let mime = part
                .get("mime")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            Some(AiSessionConversationAttachment {
                id: part.get("id")?.as_str()?.to_string(),
                kind: if mime.starts_with("image/") {
                    AiSessionAttachmentKind::Image
                } else {
                    AiSessionAttachmentKind::File
                },
                name: part
                    .get("filename")
                    .and_then(Value::as_str)
                    .unwrap_or("attachment")
                    .to_string(),
                mime: mime.to_string(),
                size: 0,
                content_state:
                    controlled_instance_protocol::AiSessionAttachmentContentState::Available,
            })
        })
        .collect()
}

fn latest_user_model(messages: &[Value]) -> Option<(String, String, Option<String>)> {
    messages
        .iter()
        .rev()
        .find(|message| message_role(message) == Some("user"))
        .and_then(|message| message.get("info"))
        .and_then(|info| info.get("model"))
        .and_then(Value::as_object)
        .and_then(|model| {
            Some((
                model.get("providerID")?.as_str()?.to_string(),
                model.get("modelID")?.as_str()?.to_string(),
                model
                    .get("variant")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            ))
        })
}

fn permission_summary(permission: &Value) -> String {
    let action = permission
        .get("action")
        .or_else(|| permission.get("permission"))
        .and_then(Value::as_str)
        .unwrap_or("permission");
    let resources = permission
        .get("resources")
        .or_else(|| permission.get("patterns"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    if resources.is_empty() {
        action.to_string()
    } else {
        format!("{action}: {resources}")
    }
}

fn opencode_error_text(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }
    if let Some(value) = value.as_str() {
        return bounded(value, 4000);
    }
    let name = value.get("name").and_then(Value::as_str);
    if name == Some("MessageAbortedError") {
        return None;
    }
    value
        .get("data")
        .and_then(|data| data.get("message"))
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .map(|message| bounded(message, 4000).unwrap_or_default())
        .or_else(|| bounded(&value.to_string(), 4000))
}

fn message_role(message: &Value) -> Option<&str> {
    message
        .get("info")
        .and_then(|info| info.get("role"))
        .and_then(Value::as_str)
}

fn message_id(message: &Value) -> Option<&str> {
    message
        .get("info")
        .and_then(|info| info.get("id"))
        .and_then(Value::as_str)
}

fn message_created(message: &Value) -> f64 {
    message
        .get("info")
        .and_then(|info| info.get("time"))
        .and_then(|time| time.get("created"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn message_parts(message: &Value) -> &[Value] {
    message
        .get("parts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn part_type(part: &Value) -> Option<&str> {
    part.get("type").and_then(Value::as_str)
}

fn is_visible_text_part(part: &Value) -> bool {
    part_type(part) == Some("text")
        && part.get("synthetic").and_then(Value::as_bool) != Some(true)
        && part.get("ignored").and_then(Value::as_bool) != Some(true)
}

fn active_phase(messages: &[Value]) -> &'static str {
    let assistant_parts = messages
        .iter()
        .filter(|message| message_role(message) == Some("assistant"))
        .flat_map(message_parts)
        .collect::<Vec<_>>();
    if assistant_parts.iter().any(|part| {
        part_type(part) == Some("tool")
            && part
                .get("state")
                .and_then(|state| state.get("status"))
                .and_then(Value::as_str)
                .is_some_and(|status| matches!(status, "pending" | "running"))
    }) {
        "tool"
    } else if assistant_parts.last().and_then(|part| part_type(part)) == Some("reasoning") {
        "thinking"
    } else {
        "responding"
    }
}

fn string_field(value: &Map<String, Value>, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn safe_json(value: &Value) -> Option<String> {
    (!value.is_null()).then(|| value.to_string())
}

fn compact_field(value: &Map<String, Value>, key: &str) -> Option<String> {
    string_field(value, key)
}

fn within_roots(directory: &str, roots: &[PathBuf]) -> bool {
    let Ok(directory) = Path::new(directory).canonicalize() else {
        return false;
    };
    roots.iter().any(|root| {
        root.canonicalize()
            .map(|root| directory == root || directory.starts_with(root))
            .unwrap_or(false)
    })
}

fn next_sse_frame(buffer: &mut String) -> Option<String> {
    let lf = buffer.find("\n\n");
    let crlf = buffer.find("\r\n\r\n");
    let (index, length) = match (lf, crlf) {
        (Some(lf), Some(crlf)) if crlf < lf => (crlf, 4),
        (Some(lf), _) => (lf, 2),
        (None, Some(crlf)) => (crlf, 4),
        (None, None) => return None,
    };
    let frame = buffer[..index].to_string();
    buffer.drain(..index + length);
    Some(frame)
}

fn is_reasoning_effort(value: &str) -> bool {
    matches!(
        value,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
}

fn is_default_opencode_session_title(title: &str) -> bool {
    title
        .strip_prefix("New session - ")
        .is_some_and(|timestamp| {
            timestamp.len() == 24
                && timestamp.ends_with('Z')
                && DateTime::parse_from_rfc3339(timestamp).is_ok()
        })
}

fn encode_path(value: &str) -> String {
    let mut url = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            url.push(byte as char);
        } else {
            url.push_str(&format!("%{byte:02X}"));
        }
    }
    url
}

fn bounded(value: &str, limit: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.chars().count() <= limit {
        return Some(value.to_string());
    }
    Some(
        value
            .chars()
            .take(limit.saturating_sub(1))
            .collect::<String>()
            + "…",
    )
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[allow(dead_code)]
fn iso_from_millis(value: f64) -> String {
    DateTime::from_timestamp_millis(value as i64)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(now_iso)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::to_bytes,
        extract::State,
        response::{IntoResponse, Response},
        routing::any,
        Json, Router,
    };
    use std::sync::Mutex as StdMutex;

    #[derive(Clone)]
    struct FakeOpenCode {
        session: Value,
        status: Value,
        messages: Value,
        permissions: Value,
        requests: Arc<StdMutex<Vec<CapturedRequest>>>,
        response: Value,
    }

    #[derive(Debug, Clone)]
    struct CapturedRequest {
        method: String,
        path: String,
        query: Option<String>,
        body: Value,
    }

    struct TestConnection {
        endpoint: String,
        roots: Vec<PathBuf>,
    }

    #[async_trait]
    impl OpenCodeConnectionProvider for TestConnection {
        async fn connection(&self) -> Result<OpenCodeConnection, ProviderError> {
            Ok(OpenCodeConnection {
                endpoint: self.endpoint.clone(),
                headers: BTreeMap::new(),
            })
        }

        fn workspace_roots(&self) -> Vec<PathBuf> {
            self.roots.clone()
        }
    }

    async fn fake_opencode(
        State(state): State<FakeOpenCode>,
        request: axum::extract::Request,
    ) -> Response {
        let method = request.method().to_string();
        let path = request.uri().path().to_string();
        let query = request.uri().query().map(ToString::to_string);
        let bytes = to_bytes(request.into_body(), usize::MAX)
            .await
            .unwrap_or_default();
        let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        state
            .requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(CapturedRequest {
                method: method.clone(),
                path: path.clone(),
                query,
                body,
            });
        let value = match (method.as_str(), path.as_str()) {
            ("GET", "/global/health") => json!({ "healthy": true, "version": "1.0.0-test" }),
            ("GET", "/session/s1") => state.session.clone(),
            ("GET", "/session/status") => state.status.clone(),
            ("GET", "/session/s1/message") => state.messages.clone(),
            ("GET", "/permission") => state.permissions.clone(),
            ("POST", "/session")
            | ("PATCH", "/session/s1")
            | ("POST", "/session/s1/prompt_async")
            | ("POST", "/session/s1/abort")
            | ("POST", "/permission/p1/reply") => state.response.clone(),
            ("GET", "/global/event") => {
                return (
                    [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                    "data: {\"payload\":{\"type\":\"sync\",\"properties\":{}}}\n\n",
                )
                    .into_response()
            }
            _ => return (StatusCode::NOT_FOUND, path).into_response(),
        };
        Json(value).into_response()
    }

    async fn start_fake(state: FakeOpenCode) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("listener address");
        let app = Router::new().fallback(any(fake_opencode)).with_state(state);
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("fake OpenCode server");
        });
        format!("http://{address}")
    }

    fn fixture() -> FakeOpenCode {
        FakeOpenCode {
            session: json!({
                "id": "s1",
                "directory": "/tmp/workspace",
                "title": "OpenCode fixture",
                "model": {
                    "id": "gpt-upstream",
                    "providerID": "task-handoff-model_entity_1",
                    "variant": "high"
                },
                "time": { "created": 1, "updated": 10 }
            }),
            status: json!({ "s1": { "type": "busy" } }),
            messages: json!([
                {
                    "info": {
                        "id": "u1",
                        "sessionID": "s1",
                        "role": "user",
                        "time": { "created": 1 },
                        "model": {
                            "providerID": "task-handoff-model_entity_1",
                            "modelID": "gpt-upstream",
                            "variant": "high"
                        }
                    },
                    "parts": [{ "id": "user-text", "sessionID": "s1", "messageID": "u1", "type": "text", "text": "hello" }]
                },
                {
                    "info": {
                        "id": "a1",
                        "sessionID": "s1",
                        "role": "assistant",
                        "parentID": "u1",
                        "time": { "created": 2 }
                    },
                    "parts": [
                        {
                            "id": "tool-1",
                            "sessionID": "s1",
                            "messageID": "a1",
                            "type": "tool",
                            "tool": "bash",
                            "state": {
                                "status": "running",
                                "input": { "command": "echo hello" },
                                "time": { "start": 3 }
                            }
                        },
                        {
                            "id": "assistant-text",
                            "sessionID": "s1",
                            "messageID": "a1",
                            "type": "text",
                            "text": "working"
                        }
                    ]
                }
            ]),
            permissions: json!([
                {
                    "id": "p1",
                    "sessionID": "s1",
                    "action": "bash",
                    "resources": ["echo hello"]
                }
            ]),
            requests: Arc::new(StdMutex::new(Vec::new())),
            response: json!({ "id": "s1", "directory": "/tmp/workspace", "title": "OpenCode fixture", "time": { "created": 1, "updated": 10 } }),
        }
    }

    #[test]
    fn projection_matches_open_code_wire_semantics() {
        let fixture = fixture();
        let projection = project_session(OpenCodeProjectionInput {
            session: &fixture.session,
            status: &fixture.status["s1"],
            messages: fixture.messages.as_array().expect("messages"),
            permissions: fixture.permissions.as_array().expect("permissions"),
            pending_selection: None,
            retry_activities: &[],
            terminal_error: None,
            model_selection_projector: None,
        });
        assert_eq!(projection.lifecycle, "waiting");
        assert_eq!(projection.phase, "approval");
        assert_eq!(projection.active_turn_id.as_deref(), Some("u1"));
        assert_eq!(projection.last_message.as_deref(), Some("working"));
        assert_eq!(
            projection.last_message_item_id.as_deref(),
            Some("assistant-text")
        );
        assert_eq!(
            projection
                .model_selection
                .as_ref()
                .map(|selection| selection.model_entity_id.as_str()),
            Some("model_entity_1")
        );
        assert_eq!(projection.reasoning_effort.as_deref(), Some("high"));
        assert!(projection.timeline.iter().any(|item| matches!(
            item,
            AiSessionTimelineItem::Activity {
                id,
                activity_kind,
                status: Some(AiSessionTimelineActivityStatus::Running),
                ..
            } if id == "tool-1" && activity_kind == "commandExecution"
        )));
        assert_eq!(
            projection.tool_activity_ids,
            HashSet::from(["tool-1".into()])
        );
    }

    #[tokio::test]
    async fn repeated_reconcile_does_not_repeat_lifecycle_events() {
        let fixture = fixture();
        let endpoint = start_fake(fixture.clone()).await;
        let provider = OpenCodeSessionProvider::new(Arc::new(TestConnection {
            endpoint,
            roots: vec![PathBuf::from("/tmp")],
        }));
        let mut events = provider.subscribe_events().expect("events");
        provider
            .reconcile_and_emit("s1", "/tmp/workspace")
            .await
            .expect("first reconcile");
        provider
            .reconcile_and_emit("s1", "/tmp/workspace")
            .await
            .expect("second reconcile");
        let mut approvals = 0;
        let mut user_messages = 0;
        let mut turn_started = 0;
        while let Ok(event) = events.try_recv() {
            match event {
                ProviderEvent::ApprovalRequested { .. } => approvals += 1,
                ProviderEvent::UserMessage { .. } => user_messages += 1,
                ProviderEvent::TurnStarted { .. } => turn_started += 1,
                _ => {}
            }
        }
        assert_eq!(approvals, 1);
        assert_eq!(user_messages, 1);
        assert_eq!(turn_started, 1);
        provider.close();
    }

    #[tokio::test]
    async fn client_wire_body_keeps_catalog_identity_and_variant() {
        let fixture = fixture();
        let endpoint = start_fake(fixture.clone()).await;
        let client = OpenCodeClient::new(Arc::new(TestConnection {
            endpoint,
            roots: vec![PathBuf::from("/tmp")],
        }));
        let model = OpenCodeModelRef {
            provider_id: "task-handoff-model_entity_1".to_string(),
            model_id: "gpt-upstream".to_string(),
            variant: Some("high".to_string()),
        };
        client
            .create_session(
                "/tmp/workspace",
                Some(&model),
                permission_rules(None, Some(&["story_request_decision".to_string()]), &[]),
            )
            .await
            .expect("create");
        client
            .prompt_async(
                "s1",
                "/tmp/workspace",
                "m1",
                vec![json!({ "type": "text", "text": "hello" })],
                Some(&model),
            )
            .await
            .expect("prompt");
        let requests = fixture
            .requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let create = requests
            .iter()
            .find(|request| request.method == "POST" && request.path == "/session")
            .expect("create request");
        assert_eq!(
            create.body["model"]["providerID"],
            "task-handoff-model_entity_1"
        );
        assert_eq!(create.body["model"]["id"], "gpt-upstream");
        assert_eq!(create.body["model"]["variant"], "high");
        let rules = create.body["permission"]
            .as_array()
            .expect("permission rules");
        assert!(rules.iter().any(|rule| {
            rule["permission"] == "story_request_decision" && rule["action"] == "allow"
        }));
        assert!(rules
            .iter()
            .any(|rule| { rule["permission"] == "story_get_content" && rule["action"] == "deny" }));
        let prompt = requests
            .iter()
            .find(|request| request.method == "POST" && request.path == "/session/s1/prompt_async")
            .expect("prompt request");
        assert_eq!(prompt.body["messageID"], "m1");
        assert_eq!(
            prompt.body["model"]["providerID"],
            "task-handoff-model_entity_1"
        );
        assert_eq!(prompt.body["model"]["modelID"], "gpt-upstream");
        assert_eq!(prompt.body["model"]["variant"], "high");
        assert!(prompt
            .query
            .as_deref()
            .is_some_and(|query| query.contains("directory=%2Ftmp%2Fworkspace")));
    }

    #[test]
    fn sse_parser_handles_lf_and_crlf_frames() {
        let mut buffer = "data: one\n\ndata: two\r\n\r\npartial".to_string();
        assert_eq!(next_sse_frame(&mut buffer).as_deref(), Some("data: one"));
        assert_eq!(next_sse_frame(&mut buffer).as_deref(), Some("data: two"));
        assert_eq!(buffer, "partial");
    }

    #[test]
    fn default_title_detection_matches_opencode_timestamps() {
        assert!(is_default_opencode_session_title(
            "New session - 2026-11-02T00:00:00.000Z"
        ));
        assert!(!is_default_opencode_session_title("Manual title"));
        assert!(!is_default_opencode_session_title(
            "New session - 2026-11-02T00:00:00Z"
        ));
    }

    fn live_provider(
        projection: OpenCodeProjection,
    ) -> (
        Arc<OpenCodeSessionProvider>,
        broadcast::Receiver<ProviderEvent>,
    ) {
        let (events, _) = broadcast::channel(64);
        let (reconcile_tx, _reconcile_rx) = mpsc::unbounded_channel();
        let provider = Arc::new(OpenCodeSessionProvider {
            client: OpenCodeClient::new(Arc::new(TestConnection {
                endpoint: "http://127.0.0.1:1".to_string(),
                roots: vec![PathBuf::from("/tmp")],
            })),
            events,
            directories: RwLock::new(HashMap::from([("s1".to_string(), "/tmp".to_string())])),
            projections: RwLock::new(HashMap::from([("s1".to_string(), projection)])),
            pending_settings: RwLock::new(HashMap::new()),
            reconcile_states: RwLock::new(HashMap::new()),
            aux: RwLock::new(OpenCodeAuxState::default()),
            model_selection_projector: RwLock::new(None),
            title_generator: RwLock::new(None),
            reconcile_tx,
            closed: AtomicBool::new(false),
            event_source_started: AtomicBool::new(false),
            event_source: std::sync::Mutex::new(None),
            self_ref: std::sync::Mutex::new(Weak::new()),
        });
        *provider
            .self_ref
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::downgrade(&provider);
        let events = provider.events.subscribe();
        (provider, events)
    }

    fn running_projection() -> OpenCodeProjection {
        OpenCodeProjection {
            title: "OpenCode".to_string(),
            cwd: "/tmp".to_string(),
            lifecycle: "running".to_string(),
            phase: "responding".to_string(),
            active_turn_id: Some("u1".to_string()),
            last_turn_id: Some("u1".to_string()),
            message_turns: HashMap::from([
                ("u1".to_string(), "u1".to_string()),
                ("a1".to_string(), "u1".to_string()),
            ]),
            assistant_message_ids: HashSet::from(["a1".to_string()]),
            ..Default::default()
        }
    }

    fn live_event(event_type: &str, properties: Value) -> Value {
        json!({
            "directory": "/tmp",
            "payload": { "type": event_type, "properties": properties }
        })
    }

    fn drain_events(receiver: &mut broadcast::Receiver<ProviderEvent>) -> Vec<ProviderEvent> {
        let mut events = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            events.push(event);
        }
        events
    }

    #[tokio::test]
    async fn retry_status_publishes_waiting_then_completed_activity() {
        let (provider, mut events) = live_provider(running_projection());
        provider
            .handle_global_event(live_event(
                "session.status",
                json!({
                    "sessionID": "s1",
                    "status": { "type": "retry", "message": "Provider is busy" }
                }),
            ))
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
                }, ..
            } if id == "opencode_retry:u1" && activity_kind == "retry" && summary == "Provider is busy"
        )));
        assert!(retry.iter().any(|event| matches!(
            event,
            ProviderEvent::ThreadSnapshot { status, phase: Some(phase), .. }
                if status == "running" && phase == "thinking"
        )));

        provider
            .handle_global_event(live_event(
                "session.status",
                json!({ "sessionID": "s1", "status": { "type": "busy" } }),
            ))
            .await;
        let completed = drain_events(&mut events);
        assert!(completed.iter().any(|event| matches!(
            event,
            ProviderEvent::TimelineItem {
                item: AiSessionTimelineItem::Activity {
                    id,
                    status: Some(AiSessionTimelineActivityStatus::Completed),
                    ..
                }, ..
            } if id == "opencode_retry:u1"
        )));
    }

    #[tokio::test]
    async fn terminal_error_survives_busy_reconcile_until_a_new_user_message() {
        let (provider, mut events) = live_provider(running_projection());
        provider
            .handle_global_event(live_event(
                "session.error",
                json!({
                    "sessionID": "s1",
                    "error": {
                        "name": "APIError",
                        "data": { "message": "Provider failed", "isRetryable": false }
                    }
                }),
            ))
            .await;
        assert!(drain_events(&mut events).iter().any(|event| matches!(
            event,
            ProviderEvent::TurnCompleted { status: Some(status), error: Some(error), .. }
                if status == "failed" && error == "Provider failed"
        )));

        let session = json!({ "id": "s1", "directory": "/tmp", "title": "OpenCode" });
        let messages = json!([{
            "info": { "id": "u1", "sessionID": "s1", "role": "user", "time": { "created": 1 } },
            "parts": [{ "id": "user-text", "messageID": "u1", "type": "text", "text": "Run it" }]
        }]);
        for status in [json!({ "type": "busy" }), json!({ "type": "idle" })] {
            let projection = project_session(OpenCodeProjectionInput {
                session: &session,
                status: &status,
                messages: messages.as_array().expect("messages"),
                permissions: &[],
                pending_selection: None,
                retry_activities: &[],
                terminal_error: Some("Provider failed"),
                model_selection_projector: None,
            });
            assert_eq!(projection.lifecycle, "failed");
            assert_eq!(projection.error.as_deref(), Some("Provider failed"));
        }

        provider
            .handle_global_event(live_event(
                "message.updated",
                json!({
                    "sessionID": "s1",
                    "info": { "id": "u2", "sessionID": "s1", "role": "user" }
                }),
            ))
            .await;
        assert!(!provider
            .aux
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .terminal_errors
            .contains_key("s1"));
    }

    #[tokio::test]
    async fn pending_text_delta_is_replayed_before_part_identity_arrives() {
        let (provider, mut events) = live_provider(running_projection());
        provider
            .handle_global_event(live_event(
                "message.part.delta",
                json!({
                    "sessionID": "s1",
                    "messageID": "a1",
                    "partID": "p1",
                    "field": "text",
                    "delta": "first chunk"
                }),
            ))
            .await;
        assert!(drain_events(&mut events).is_empty());

        provider
            .handle_global_event(live_event(
                "message.part.updated",
                json!({
                    "sessionID": "s1",
                    "part": {
                        "id": "p1",
                        "sessionID": "s1",
                        "messageID": "a1",
                        "type": "text",
                        "text": ""
                    }
                }),
            ))
            .await;
        let replayed = drain_events(&mut events);
        assert!(replayed.iter().any(|event| matches!(
            event,
            ProviderEvent::AgentMessageDelta { turn_id, item_id, delta, .. }
                if turn_id == "u1" && item_id == "p1" && delta == "first chunk"
        )));
    }

    #[tokio::test]
    async fn reasoning_part_delta_uses_timeline_output_channel() {
        let mut projection = running_projection();
        projection.part_turns.insert(
            "r1".to_string(),
            ("u1".to_string(), "a1".to_string(), "reasoning".to_string()),
        );
        let (provider, mut events) = live_provider(projection);
        provider
            .handle_global_event(live_event(
                "message.part.delta",
                json!({
                    "sessionID": "s1",
                    "messageID": "a1",
                    "partID": "r1",
                    "field": "text",
                    "delta": "thinking"
                }),
            ))
            .await;
        assert!(drain_events(&mut events).iter().any(|event| matches!(
            event,
            ProviderEvent::TimelineItemDelta { turn_id, item_id, field, delta, .. }
                if turn_id == "u1" && item_id == "r1" && field == "output" && delta == "thinking"
        )));
    }

    #[tokio::test]
    async fn manual_rename_cancels_a_pending_title_generation() {
        let (provider, _events) = live_provider(running_projection());
        {
            let mut aux = provider
                .aux
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            aux.armed_title_sessions.insert("s1".to_string());
            aux.title_generations.insert("s1".to_string(), 4);
        }
        provider
            .handle_global_event(live_event(
                "session.updated",
                json!({
                    "sessionID": "s1",
                    "info": {
                        "id": "s1",
                        "sessionID": "s1",
                        "title": "Manual title"
                    }
                }),
            ))
            .await;
        let aux = provider
            .aux
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!aux.armed_title_sessions.contains("s1"));
        assert!(aux.attempted_title_sessions.contains("s1"));
        assert_eq!(aux.title_generations.get("s1"), Some(&5));
    }
}
