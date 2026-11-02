use controlled_instance_core::reconnect::StandardReconnectBackoff;
use controlled_instance_protocol::{
    GitCredentialHttpsResolveResponse, GitCredentialSshAgentResponse,
    GitCredentialSshPrepareResponse, InstanceStatusSnapshot, StoryAgentContentListResult,
    StoryAgentPagination, StoryContentPageResult, StoryContentSetResult,
    AI_SESSION_RENAME_PROTOCOL_VERSION, APP_PROFILES_PROTOCOL_VERSION,
    NODE_AGENT_PROTOCOL_VERSION_HEADER,
};
use reqwest::{Method, StatusCode};
use serde_json::{json, Map, Value};
use std::{
    sync::{Mutex, RwLock},
    time::Duration,
};
use thiserror::Error;
use tokio::{
    io::AsyncReadExt,
    sync::{watch, Mutex as AsyncMutex, Notify},
    task::JoinHandle,
};
use tracing::{info, warn};
use url::Url;
use uuid::Uuid;

use crate::config::{ControlMode, InstanceConfig};

const NODE_AGENT_REQUEST_HEADER_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct NodeAgentClientConfig {
    pub control_mode: ControlMode,
    pub node_agent_url: Option<String>,
    pub registration_token: Option<String>,
    pub instance_id: Option<String>,
    pub project_id: Option<String>,
    pub node_id: Option<String>,
    pub runtime_id: Option<String>,
    pub image_id: Option<String>,
    pub image_tag: Option<String>,
    pub heartbeat_interval: Duration,
}

impl NodeAgentClientConfig {
    pub fn from_instance_config(config: &InstanceConfig) -> Self {
        Self {
            control_mode: config.control_mode,
            node_agent_url: config.node_agent_url.clone(),
            registration_token: config.registration_token.clone(),
            instance_id: config.configured_instance_id.clone(),
            project_id: config.project_id.clone(),
            node_id: config.node_id.clone(),
            runtime_id: config.runtime_id.clone(),
            image_id: config.image_id.clone(),
            image_tag: config.image_tag.clone(),
            heartbeat_interval: config.heartbeat_interval,
        }
    }
}

#[derive(Debug, Error)]
pub enum NodeAgentClientError {
    #[error("Node agent registration is not enabled.")]
    Disabled,
    #[error("Instance id is required for controlled mode registration.")]
    MissingInstanceId,
    #[error("Node agent URL must be an HTTP(S) origin.")]
    InvalidNodeAgentUrl,
    #[error("Node agent response header timed out.")]
    HeaderTimeout,
    #[error("Node agent request failed: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("Node agent response was not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    InvalidManagedGitResponse(&'static str),
    #[error("Node agent request failed with HTTP {status}: {message}")]
    Response {
        status: StatusCode,
        code: Option<String>,
        message: String,
    },
}

impl NodeAgentClientError {
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            Self::Response { status, .. } => Some(*status),
            _ => None,
        }
    }
}

async fn response_data(response: reqwest::Response) -> Result<Value, NodeAgentClientError> {
    let payload: Value = response.json().await?;
    Ok(payload.get("data").cloned().unwrap_or(Value::Null))
}

#[derive(Debug, Clone)]
struct ConnectionState {
    node_agent_url: Option<String>,
    registered_instance_id: Option<String>,
    node_agent_protocol_version: Option<String>,
    revision: u64,
}

struct NodeAgentClientInner {
    config: NodeAgentClientConfig,
    http: reqwest::Client,
    process_incarnation_id: String,
    connection: RwLock<ConnectionState>,
    operation: AsyncMutex<()>,
    wake: Notify,
    task: Mutex<Option<JoinHandle<()>>>,
    stop: Mutex<Option<watch::Sender<bool>>>,
}

#[derive(Clone)]
pub struct NodeAgentClient {
    inner: std::sync::Arc<NodeAgentClientInner>,
}

impl NodeAgentClient {
    pub fn new(config: NodeAgentClientConfig) -> Self {
        let node_agent_url = config
            .node_agent_url
            .as_deref()
            .and_then(|url| normalize_node_agent_url(url).ok());
        Self {
            inner: std::sync::Arc::new(NodeAgentClientInner {
                config,
                http: reqwest::Client::builder()
                    .user_agent(concat!(
                        "task-handoff-controlled-instance/",
                        env!("CARGO_PKG_VERSION")
                    ))
                    .build()
                    .expect("the Node agent HTTP client configuration is valid"),
                process_incarnation_id: Uuid::new_v4().to_string(),
                connection: RwLock::new(ConnectionState {
                    node_agent_url,
                    registered_instance_id: None,
                    node_agent_protocol_version: None,
                    revision: 0,
                }),
                operation: AsyncMutex::new(()),
                wake: Notify::new(),
                task: Mutex::new(None),
                stop: Mutex::new(None),
            }),
        }
    }

    pub fn from_instance_config(config: &InstanceConfig) -> Self {
        Self::new(NodeAgentClientConfig::from_instance_config(config))
    }

    pub fn enabled(&self) -> bool {
        let state = self
            .inner
            .connection
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.inner.config.control_mode == ControlMode::Controlled
            && self.inner.config.instance_id.is_some()
            && self.inner.config.registration_token.is_some()
            && state.node_agent_url.is_some()
    }

    pub fn process_incarnation_id(&self) -> &str {
        &self.inner.process_incarnation_id
    }

    pub fn node_agent_url(&self) -> Option<String> {
        self.inner
            .connection
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .node_agent_url
            .clone()
    }

    pub fn registered_instance_id(&self) -> Option<String> {
        self.inner
            .connection
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .registered_instance_id
            .clone()
    }

    pub fn node_agent_protocol_version(&self) -> Option<String> {
        self.inner
            .connection
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .node_agent_protocol_version
            .clone()
    }

    pub fn connection_revision(&self) -> u64 {
        self.inner
            .connection
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .revision
    }

    pub fn update_node_agent_url(
        &self,
        node_agent_url: &str,
    ) -> Result<String, NodeAgentClientError> {
        let normalized = normalize_node_agent_url(node_agent_url)?;
        let mut state = self
            .inner
            .connection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.node_agent_url.as_deref() == Some(normalized.as_str()) {
            return Ok(normalized);
        }
        state.node_agent_url = Some(normalized.clone());
        state.registered_instance_id = None;
        state.node_agent_protocol_version = None;
        state.revision = state.revision.wrapping_add(1);
        drop(state);
        self.inner.wake.notify_one();
        Ok(normalized)
    }

    pub fn start<F>(&self, snapshot_provider: F)
    where
        F: Fn() -> InstanceStatusSnapshot + Send + Sync + 'static,
    {
        if !self.enabled() {
            return;
        }
        let mut task = self
            .inner
            .task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if task.is_some() {
            return;
        }
        let (stop_tx, stop_rx) = watch::channel(false);
        *self
            .inner
            .stop
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(stop_tx);
        let client = self.clone();
        *task = Some(tokio::spawn(async move {
            run_registration_loop(client, snapshot_provider, stop_rx).await;
        }));
    }

    pub async fn stop(&self) {
        if let Some(stop) = self
            .inner
            .stop
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = stop.send(true);
        }
        let task = self
            .inner
            .task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    pub async fn register(
        &self,
        snapshot: &InstanceStatusSnapshot,
    ) -> Result<(), NodeAgentClientError> {
        let _operation = self.inner.operation.lock().await;
        self.register_once(snapshot).await.map(|_| ())
    }

    pub async fn heartbeat(
        &self,
        snapshot: &InstanceStatusSnapshot,
    ) -> Result<(), NodeAgentClientError> {
        let _operation = self.inner.operation.lock().await;
        self.heartbeat_once(snapshot).await
    }

    pub async fn resolve_git_https(
        &self,
        remote_url: &str,
    ) -> Result<GitCredentialHttpsResolveResponse, NodeAgentClientError> {
        let instance_id = self.required_instance_id()?;
        self.require_enabled()?;
        let response = self
            .request(
                Method::POST,
                &format!(
                    "node-agent/instances/{}/git-credentials/https",
                    encode_path(&instance_id)
                ),
                Some(json!({ "remoteUrl": remote_url })),
            )
            .await?;
        let response: GitCredentialHttpsResolveResponse =
            serde_json::from_value(response_data(response).await?)?;
        if !response.validate() {
            return Err(NodeAgentClientError::InvalidManagedGitResponse(
                "Node agent returned an invalid HTTPS Git credential response.",
            ));
        }
        Ok(response)
    }

    pub async fn prepare_git_ssh(
        &self,
        remote_url: &str,
    ) -> Result<GitCredentialSshPrepareResponse, NodeAgentClientError> {
        let instance_id = self.required_instance_id()?;
        self.require_enabled()?;
        let response = self
            .request(
                Method::POST,
                &format!(
                    "node-agent/instances/{}/git-credentials/ssh/prepare",
                    encode_path(&instance_id)
                ),
                Some(json!({ "remoteUrl": remote_url })),
            )
            .await?;
        let response: GitCredentialSshPrepareResponse =
            serde_json::from_value(response_data(response).await?)?;
        if !response.validate() {
            return Err(NodeAgentClientError::InvalidManagedGitResponse(
                "Node agent returned an invalid SSH Git credential response.",
            ));
        }
        Ok(response)
    }

    pub async fn exchange_git_ssh_agent(
        &self,
        invocation_id: &str,
        frame: &str,
    ) -> Result<GitCredentialSshAgentResponse, NodeAgentClientError> {
        let instance_id = self.required_instance_id()?;
        self.require_enabled()?;
        let response = self
            .request(
                Method::POST,
                &format!(
                    "node-agent/instances/{}/git-credentials/ssh/agent",
                    encode_path(&instance_id)
                ),
                Some(json!({ "invocationId": invocation_id, "frame": frame })),
            )
            .await?;
        let response: GitCredentialSshAgentResponse =
            serde_json::from_value(response_data(response).await?)?;
        if !response.validate() {
            return Err(NodeAgentClientError::InvalidManagedGitResponse(
                "Node agent returned an invalid SSH agent response.",
            ));
        }
        Ok(response)
    }

    pub async fn release_git_ssh(&self, invocation_id: &str) -> Result<(), NodeAgentClientError> {
        let instance_id = self.required_instance_id()?;
        self.require_enabled()?;
        self.request(
            Method::DELETE,
            &format!(
                "node-agent/instances/{}/git-credentials/ssh/{}",
                encode_path(&instance_id),
                encode_path(invocation_id)
            ),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn list_story_content(
        &self,
        session_id: &str,
        page: u64,
        page_size: u64,
    ) -> Result<StoryAgentContentListResult, NodeAgentClientError> {
        let instance_id = self.required_instance_id()?;
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("page", &page.to_string())
            .append_pair("pageSize", &page_size.to_string())
            .finish();
        let response = self
            .request(
                Method::GET,
                &format!(
                    "node-agent/instances/{}/ai-sessions/{}/story-content?{query}",
                    encode_path(&instance_id),
                    encode_path(session_id)
                ),
                None,
            )
            .await?;
        let payload: Value = response.json().await?;
        let page: StoryContentPageResult =
            serde_json::from_value(payload.get("data").cloned().unwrap_or_default())?;
        Ok(StoryAgentContentListResult {
            documents: page.documents,
            pagination: StoryAgentPagination {
                total_items: page.pagination.total_items,
                next_page: (page.pagination.page < 500
                    && page.pagination.page * page.pagination.page_size
                        < page.pagination.total_items)
                    .then_some(page.pagination.page + 1),
            },
        })
    }

    pub async fn resolve_story_agent_tools_for_story(
        &self,
        story_id: &str,
    ) -> Result<Value, NodeAgentClientError> {
        let instance_id = self.required_instance_id()?;
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("storyId", story_id)
            .finish();
        let response = self
            .request(
                Method::GET,
                &format!(
                    "node-agent/instances/{}/story-agent-tools?{query}",
                    encode_path(&instance_id)
                ),
                None,
            )
            .await?;
        response_data(response).await
    }

    pub async fn resolve_story_agent_tools_for_session(
        &self,
        session_id: &str,
    ) -> Result<Value, NodeAgentClientError> {
        let instance_id = self.required_instance_id()?;
        let response = self
            .request(
                Method::GET,
                &format!(
                    "node-agent/instances/{}/ai-sessions/{}/story-agent-tools",
                    encode_path(&instance_id),
                    encode_path(session_id)
                ),
                None,
            )
            .await?;
        response_data(response).await
    }

    pub async fn invoke_story_agent_tool(
        &self,
        session_id: &str,
        tool: &str,
        input: Value,
    ) -> Result<Value, NodeAgentClientError> {
        let instance_id = self.required_instance_id()?;
        let response = self
            .request(
                Method::POST,
                &format!(
                    "node-agent/instances/{}/ai-sessions/{}/story-agent-tools/{}",
                    encode_path(&instance_id),
                    encode_path(session_id),
                    encode_path(tool)
                ),
                Some(json!({ "input": input })),
            )
            .await?;
        response_data(response).await
    }

    pub async fn invoke_agent_run(
        &self,
        session_id: &str,
        request: Value,
    ) -> Result<Value, NodeAgentClientError> {
        let instance_id = self.required_instance_id()?;
        let response = self
            .request(
                Method::POST,
                &format!(
                    "node-agent/instances/{}/ai-sessions/{}/agent-runs",
                    encode_path(&instance_id),
                    encode_path(session_id)
                ),
                Some(request),
            )
            .await?;
        response_data(response).await
    }

    pub async fn invoke_agent_run_for_member(
        &self,
        run_id: &str,
        member_id: &str,
        session_id: &str,
        request: Value,
    ) -> Result<Value, NodeAgentClientError> {
        let response = self
            .request(
                Method::POST,
                &format!(
                    "node-agent/agent-runs/{}/members/{}/ai-sessions/{}/agent-runs",
                    encode_path(run_id),
                    encode_path(member_id),
                    encode_path(session_id)
                ),
                Some(request),
            )
            .await?;
        response_data(response).await
    }

    pub async fn download_story_content(
        &self,
        session_id: &str,
        story_path: &str,
    ) -> Result<(reqwest::Response, String), NodeAgentClientError> {
        let instance_id = self.required_instance_id()?;
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("storyPath", story_path)
            .finish();
        let response = self
            .request(
                Method::GET,
                &format!(
                    "node-agent/instances/{}/ai-sessions/{}/story-content/file?{query}",
                    encode_path(&instance_id),
                    encode_path(session_id)
                ),
                None,
            )
            .await?;
        let revision = response
            .headers()
            .get("x-story-revision")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if !controlled_instance_protocol::validate_story_revision(&revision) {
            return Err(NodeAgentClientError::Response {
                status: StatusCode::BAD_GATEWAY,
                code: Some("STORY_CONTENT_REVISION_INVALID".to_string()),
                message: "Node agent returned an invalid Story content revision.".to_string(),
            });
        }
        Ok((response, revision))
    }

    pub async fn upload_story_content(
        &self,
        session_id: &str,
        story_path: &str,
        title: Option<&str>,
        expected_revision: Option<&str>,
        file: tokio::fs::File,
        size: u64,
    ) -> Result<StoryContentSetResult, NodeAgentClientError> {
        let instance_id = self.required_instance_id()?;
        let query = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("storyPath", story_path);
            if let Some(title) = title {
                query.append_pair("title", title);
            }
            if let Some(expected_revision) = expected_revision {
                query.append_pair("expectedRevision", expected_revision);
            }
            query.finish()
        };
        let path = format!(
            "node-agent/instances/{}/ai-sessions/{}/story-content/file?{}",
            encode_path(&instance_id),
            encode_path(session_id),
            query
        );
        let base_url = self
            .node_agent_url()
            .ok_or(NodeAgentClientError::Disabled)?
            .trim_end_matches('/')
            .to_string();
        let token = self
            .inner
            .config
            .registration_token
            .as_deref()
            .ok_or(NodeAgentClientError::Disabled)?;
        let stream = futures_util::stream::try_unfold(file, |mut file| async move {
            let mut buffer = vec![0_u8; 64 * 1024];
            let read = file.read(&mut buffer).await?;
            if read == 0 {
                return Ok::<_, std::io::Error>(None);
            }
            buffer.truncate(read);
            Ok(Some((buffer, file)))
        });
        let response = self
            .send_request(
                self.inner
                    .http
                    .put(format!("{base_url}/api/{path}"))
                    .bearer_auth(token)
                    .header("content-type", "application/octet-stream")
                    .header("content-length", size)
                    .body(reqwest::Body::wrap_stream(stream)),
            )
            .await?;
        let payload: Value = response.json().await?;
        serde_json::from_value(payload.get("data").cloned().unwrap_or_default())
            .map_err(NodeAgentClientError::Json)
    }

    async fn run_cycle<F>(&self, snapshot_provider: &F) -> Result<(), NodeAgentClientError>
    where
        F: Fn() -> InstanceStatusSnapshot,
    {
        let _operation = self.inner.operation.lock().await;
        if !self.enabled() {
            return Err(NodeAgentClientError::Disabled);
        }
        let revision = self.connection_revision();
        let snapshot = snapshot_provider();
        if self.registered_instance_id().is_none() {
            let applied = self.register_once(&snapshot).await?;
            if !applied || revision != self.connection_revision() {
                return Ok(());
            }
        }
        self.heartbeat_once(&snapshot_provider()).await
    }

    async fn register_once(
        &self,
        snapshot: &InstanceStatusSnapshot,
    ) -> Result<bool, NodeAgentClientError> {
        self.require_enabled()?;
        let revision = self.connection_revision();
        let instance_id = self.required_instance_id()?;
        let body = project_register_for_node_agent_protocol(
            register_payload(
                snapshot,
                &self.inner.config,
                &self.inner.process_incarnation_id,
            )?,
            self.node_agent_protocol_version().as_deref(),
        );
        let response = self
            .request(
                Method::POST,
                &format!(
                    "node-agent/instances/{}/register",
                    encode_path(&instance_id)
                ),
                Some(body),
            )
            .await?;
        let protocol_version = response
            .headers()
            .get(NODE_AGENT_PROTOCOL_VERSION_HEADER)
            .and_then(|value| value.to_str().ok())
            .filter(|value| is_protocol_version(value))
            .map(ToString::to_string);
        let payload: Value = response.json().await?;
        let response_id = payload
            .get("data")
            .and_then(|data| data.get("id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(&instance_id)
            .to_string();
        let mut state = self
            .inner
            .connection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.node_agent_protocol_version = protocol_version;
        if state.revision != revision {
            return Ok(false);
        }
        state.registered_instance_id = Some(response_id);
        Ok(true)
    }

    async fn heartbeat_once(
        &self,
        snapshot: &InstanceStatusSnapshot,
    ) -> Result<(), NodeAgentClientError> {
        self.require_enabled()?;
        let instance_id = self
            .registered_instance_id()
            .or_else(|| self.inner.config.instance_id.clone())
            .ok_or(NodeAgentClientError::MissingInstanceId)?;
        let body = project_heartbeat_for_node_agent_protocol(
            heartbeat_payload(snapshot, &self.inner.process_incarnation_id)?,
            self.node_agent_protocol_version().as_deref(),
        );
        match self
            .request(
                Method::POST,
                &format!(
                    "node-agent/instances/{}/heartbeat",
                    encode_path(&instance_id)
                ),
                Some(body),
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(error) => {
                if error.status() == Some(StatusCode::NOT_FOUND) {
                    self.inner
                        .connection
                        .write()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .registered_instance_id = None;
                }
                Err(error)
            }
        }
    }

    fn require_enabled(&self) -> Result<(), NodeAgentClientError> {
        if self.enabled() {
            Ok(())
        } else {
            Err(NodeAgentClientError::Disabled)
        }
    }

    fn required_instance_id(&self) -> Result<String, NodeAgentClientError> {
        self.inner
            .config
            .instance_id
            .clone()
            .ok_or(NodeAgentClientError::MissingInstanceId)
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<reqwest::Response, NodeAgentClientError> {
        let base_url = self
            .node_agent_url()
            .ok_or(NodeAgentClientError::Disabled)?
            .trim_end_matches('/')
            .to_string();
        let token = self
            .inner
            .config
            .registration_token
            .as_deref()
            .ok_or(NodeAgentClientError::Disabled)?;
        let mut request = self
            .inner
            .http
            .request(method, format!("{base_url}/api/{path}"))
            .bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        self.send_request(request).await
    }

    async fn send_request(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, NodeAgentClientError> {
        let response = tokio::time::timeout(NODE_AGENT_REQUEST_HEADER_TIMEOUT, request.send())
            .await
            .map_err(|_| NodeAgentClientError::HeaderTimeout)??;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
        let code = payload
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let message = payload
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("Node agent request failed with HTTP {status}"));
        Err(NodeAgentClientError::Response {
            status,
            code,
            message,
        })
    }
}

async fn run_registration_loop<F>(
    client: NodeAgentClient,
    snapshot_provider: F,
    mut stop: watch::Receiver<bool>,
) where
    F: Fn() -> InstanceStatusSnapshot + Send + Sync + 'static,
{
    let mut backoff = StandardReconnectBackoff::new();
    loop {
        if *stop.borrow() {
            break;
        }
        let revision = client.connection_revision();
        let result = client.run_cycle(&snapshot_provider).await;
        let delay = match result {
            Ok(()) => {
                backoff.reset();
                client.inner.config.heartbeat_interval
            }
            Err(NodeAgentClientError::Disabled) => break,
            Err(error) => {
                warn!(error = %error, "node agent registration sync failed");
                backoff.next_delay()
            }
        };
        let delay = if revision == client.connection_revision() {
            delay
        } else {
            Duration::ZERO
        };
        tokio::select! {
            _ = tokio::time::sleep(delay) => {},
            _ = client.inner.wake.notified() => {},
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
        }
    }
    info!("node agent registration client stopped");
}

fn register_payload(
    snapshot: &InstanceStatusSnapshot,
    config: &NodeAgentClientConfig,
    process_incarnation_id: &str,
) -> Result<Value, serde_json::Error> {
    let mut payload = Map::new();
    insert_optional(&mut payload, "instanceId", config.instance_id.clone());
    insert_optional(&mut payload, "projectId", config.project_id.clone());
    insert_optional(&mut payload, "nodeId", config.node_id.clone());
    insert_optional(&mut payload, "runtimeId", config.runtime_id.clone());
    if let Some(image_id) = config.image_id.clone() {
        let mut image = Map::from_iter([("imageId".to_string(), Value::String(image_id))]);
        if let Some(tag) = config.image_tag.clone() {
            image.insert("tag".to_string(), Value::String(tag));
        }
        payload.insert("imageSelection".to_string(), Value::Object(image));
    }
    payload.insert(
        "instanceVersion".to_string(),
        Value::String(snapshot.instance_version.clone()),
    );
    payload.insert(
        "protocolVersion".to_string(),
        Value::String(snapshot.protocol_version.clone()),
    );
    payload.insert("build".to_string(), serde_json::to_value(&snapshot.build)?);
    payload.insert(
        "controlMode".to_string(),
        Value::String("controlled".to_string()),
    );
    payload.insert(
        "capabilities".to_string(),
        serde_json::to_value(&snapshot.capabilities)?,
    );
    payload.insert(
        "appInventory".to_string(),
        serde_json::to_value(&snapshot.app_inventory)?,
    );
    payload.insert(
        "workspace".to_string(),
        serde_json::to_value(&snapshot.workspace)?,
    );
    payload.insert(
        "processIncarnationId".to_string(),
        Value::String(process_incarnation_id.to_string()),
    );
    Ok(Value::Object(payload))
}

fn heartbeat_payload(
    snapshot: &InstanceStatusSnapshot,
    process_incarnation_id: &str,
) -> Result<Value, serde_json::Error> {
    Ok(json!({
        "status": snapshot.status,
        "health": snapshot.health,
        "protocolVersion": snapshot.protocol_version,
        "build": snapshot.build,
        "capabilities": snapshot.capabilities,
        "appInventory": snapshot.app_inventory,
        "apps": snapshot.apps,
        "aiSessions": snapshot.ai_sessions,
        "workspace": snapshot.workspace,
        "processIncarnationId": process_incarnation_id,
    }))
}

fn insert_optional(payload: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        payload.insert(key.to_string(), Value::String(value));
    }
}

fn project_register_for_node_agent_protocol(mut payload: Value, version: Option<&str>) -> Value {
    project_app_inventory_for_node_agent_protocol(&mut payload, version);
    payload
}

fn project_heartbeat_for_node_agent_protocol(mut payload: Value, version: Option<&str>) -> Value {
    project_app_inventory_for_node_agent_protocol(&mut payload, version);
    if version.is_some_and(|version| version < AI_SESSION_RENAME_PROTOCOL_VERSION) {
        if let Some(sessions) = payload
            .get_mut("aiSessions")
            .and_then(|value| value.get_mut("sessions"))
            .and_then(Value::as_array_mut)
        {
            for session in sessions {
                if let Some(actions) = session.get_mut("actions").and_then(Value::as_object_mut) {
                    actions.remove("rename");
                }
            }
        }
    }
    payload
}

fn project_app_inventory_for_node_agent_protocol(payload: &mut Value, version: Option<&str>) {
    if version.is_none_or(|version| version >= APP_PROFILES_PROTOCOL_VERSION) {
        return;
    }
    if let Some(items) = payload
        .get_mut("appInventory")
        .and_then(|value| value.get_mut("items"))
        .and_then(Value::as_array_mut)
    {
        for item in items {
            if let Some(capabilities) = item.get_mut("capabilities").and_then(Value::as_object_mut)
            {
                capabilities.remove("supportsProfiles");
            }
        }
    }
}

fn normalize_node_agent_url(input: &str) -> Result<String, NodeAgentClientError> {
    let parsed = Url::parse(input.trim()).map_err(|_| NodeAgentClientError::InvalidNodeAgentUrl)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(NodeAgentClientError::InvalidNodeAgentUrl);
    }
    Ok(parsed.origin().ascii_serialization())
}

fn encode_path(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn is_protocol_version(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value.bytes().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RuntimeKind;
    use axum::{
        extract::{Path, State},
        http::{HeaderMap, HeaderValue},
        response::IntoResponse,
        routing::post,
        Json, Router,
    };
    use controlled_instance_core::paths::StoragePaths;
    use controlled_instance_protocol::{AiSessionsSnapshot, AppInventorySnapshot, BuildInfo};
    use std::{
        net::SocketAddr,
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };

    fn config(url: String) -> NodeAgentClientConfig {
        NodeAgentClientConfig {
            control_mode: ControlMode::Controlled,
            node_agent_url: Some(url),
            registration_token: Some("registration-secret".to_string()),
            instance_id: Some("ins_0000000000000".to_string()),
            project_id: Some("prj_0000000000000".to_string()),
            node_id: None,
            runtime_id: None,
            image_id: None,
            image_tag: None,
            heartbeat_interval: Duration::from_millis(10),
        }
    }

    fn snapshot() -> InstanceStatusSnapshot {
        InstanceStatusSnapshot {
            status: "running".to_string(),
            health: "ok".to_string(),
            instance_version: "0.0.46".to_string(),
            protocol_version: controlled_instance_protocol::CONTROL_PLANE_PROTOCOL_VERSION
                .to_string(),
            build: BuildInfo::for_controlled_instance("0.0.46"),
            control_mode: "controlled".to_string(),
            capabilities: Default::default(),
            app_inventory: AppInventorySnapshot::default(),
            apps: Default::default(),
            ai_sessions: AiSessionsSnapshot {
                running_count: 0,
                waiting_count: 0,
                stale_count: 0,
                sessions: Vec::new(),
                updated_at: "2026-11-02T00:00:00.000Z".to_string(),
            },
            triggers: None,
            workspace: controlled_instance_protocol::WorkspaceStatus {
                mode: "local-bind".to_string(),
                status: "ready".to_string(),
                path: "/workspace".to_string(),
                exists: true,
                git: Default::default(),
                storage: controlled_instance_protocol::WorkspaceStorageStatus {
                    data_dir: "/data".to_string(),
                    log_dir: "/logs".to_string(),
                },
            },
            target: json!({ "status": "unknown" }),
        }
    }

    #[test]
    fn node_agent_urls_are_normalized_to_origins() {
        assert_eq!(
            normalize_node_agent_url("HTTP://127.0.0.1:9000/").expect("origin"),
            "http://127.0.0.1:9000"
        );
        assert!(normalize_node_agent_url("https://node.example/api").is_err());
        assert!(normalize_node_agent_url("ftp://node.example").is_err());
        assert!(normalize_node_agent_url("http://user@node.example").is_err());
    }

    #[test]
    fn registration_payload_omits_unknown_optional_fields() {
        let value = register_payload(&snapshot(), &config("http://127.0.0.1:9000".into()), "uuid")
            .expect("payload");
        assert_eq!(value["instanceId"], "ins_0000000000000");
        assert_eq!(value["projectId"], "prj_0000000000000");
        assert!(value.get("nodeId").is_none());
        assert!(value.get("registrationToken").is_none());
        assert_eq!(value["processIncarnationId"], "uuid");
    }

    #[test]
    fn older_node_agent_protocols_receive_projected_payloads() {
        let register = json!({
            "appInventory": { "items": [{ "capabilities": { "supportsProfiles": true, "automation": true } }] }
        });
        let projected = project_register_for_node_agent_protocol(register, Some("2026-09-30"));
        assert!(projected["appInventory"]["items"][0]["capabilities"]
            .get("supportsProfiles")
            .is_none());
        assert_eq!(
            projected["appInventory"]["items"][0]["capabilities"]["automation"],
            true
        );
        let heartbeat = json!({
            "appInventory": { "items": [] },
            "aiSessions": { "sessions": [{ "actions": { "rename": true, "send": true } }] }
        });
        let projected = project_heartbeat_for_node_agent_protocol(heartbeat, Some("2026-09-01"));
        assert!(projected["aiSessions"]["sessions"][0]["actions"]
            .get("rename")
            .is_none());
        assert_eq!(
            projected["aiSessions"]["sessions"][0]["actions"]["send"],
            true
        );
    }

    #[test]
    fn test_helpers_compile_with_the_instance_config_boundary() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let paths = StoragePaths {
            config_path: PathBuf::from("/tmp/config.json"),
            data_dir: temporary.path().join("data"),
            app_catalog_dir: temporary.path().join("catalog"),
            app_sessions_dir: temporary.path().join("app-sessions"),
            triggers_dir: temporary.path().join("triggers"),
            runtime_dir: temporary.path().join("runtime"),
            events_dir: temporary.path().join("events"),
            artifact_dir: temporary.path().join("artifacts"),
            log_dir: temporary.path().join("logs"),
            web_token_path: temporary.path().join("web-token"),
        };
        let instance = InstanceConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            static_dir: temporary.path().join("ui"),
            instance_id: "ins_0000000000000".to_string(),
            configured_instance_id: Some("ins_0000000000000".to_string()),
            instance_name: "test".to_string(),
            package_version: "0.0.46".to_string(),
            control_mode: ControlMode::Controlled,
            runtime_kind: RuntimeKind::Docker,
            workspace_path: temporary.path().join("workspace"),
            registration_token: Some("secret".to_string()),
            node_agent_url: Some("http://127.0.0.1:9000/".to_string()),
            project_id: None,
            node_id: None,
            runtime_id: None,
            image_id: None,
            image_tag: None,
            heartbeat_interval: Duration::from_secs(10),
            storage_paths: paths,
            build_info: BuildInfo::for_controlled_instance("0.0.46"),
        };
        let client = NodeAgentClient::from_instance_config(&instance);
        assert!(client.enabled());
        assert_eq!(
            client.node_agent_url().as_deref(),
            Some("http://127.0.0.1:9000")
        );
    }

    #[derive(Debug, Clone)]
    struct ObservedRequest {
        path: String,
        authorization: Option<String>,
        body: Value,
    }

    #[derive(Clone)]
    struct MockState {
        requests: Arc<Mutex<Vec<ObservedRequest>>>,
        heartbeat_not_found: Arc<AtomicBool>,
    }

    async fn register(
        State(state): State<MockState>,
        Path(instance_id): Path<String>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> impl axum::response::IntoResponse {
        state
            .requests
            .lock()
            .expect("requests")
            .push(ObservedRequest {
                path: format!("/api/node-agent/instances/{instance_id}/register"),
                authorization: headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .map(ToString::to_string),
                body,
            });
        (
            StatusCode::CREATED,
            [(
                NODE_AGENT_PROTOCOL_VERSION_HEADER,
                HeaderValue::from_static("2026-10-02"),
            )],
            Json(json!({ "data": { "id": instance_id } })),
        )
    }

    async fn heartbeat(
        State(state): State<MockState>,
        Path(instance_id): Path<String>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> impl axum::response::IntoResponse {
        state
            .requests
            .lock()
            .expect("requests")
            .push(ObservedRequest {
                path: format!("/api/node-agent/instances/{instance_id}/heartbeat"),
                authorization: headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .map(ToString::to_string),
                body,
            });
        if state.heartbeat_not_found.swap(false, Ordering::SeqCst) {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": { "code": "INSTANCE_NOT_FOUND", "message": "missing" } })),
            )
                .into_response();
        }
        Json(json!({ "data": { "id": instance_id } })).into_response()
    }

    async fn start_mock_node_agent() -> (SocketAddr, MockState, JoinHandle<()>) {
        let state = MockState {
            requests: Arc::new(Mutex::new(Vec::new())),
            heartbeat_not_found: Arc::new(AtomicBool::new(false)),
        };
        let app = Router::new()
            .route("/api/node-agent/instances/{id}/register", post(register))
            .route("/api/node-agent/instances/{id}/heartbeat", post(heartbeat))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("mock server");
        });
        (address, state, server)
    }

    #[tokio::test]
    async fn registers_and_heartbeats_with_the_registration_bearer_token() {
        let (address, mock, server) = start_mock_node_agent().await;
        let client = NodeAgentClient::new(config(format!("http://{address}")));
        client.register(&snapshot()).await.expect("register");
        client.heartbeat(&snapshot()).await.expect("heartbeat");

        assert_eq!(
            client.registered_instance_id().as_deref(),
            Some("ins_0000000000000")
        );
        assert_eq!(
            client.node_agent_protocol_version().as_deref(),
            Some("2026-10-02")
        );
        let requests = mock.requests.lock().expect("requests").clone();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].authorization.as_deref(),
            Some("Bearer registration-secret")
        );
        assert_eq!(requests[0].body["protocolVersion"], "2026-10-02");
        assert_eq!(requests[0].body["appInventory"]["items"], json!([]));
        assert!(requests[1].path.ends_with("/heartbeat"));
        assert_eq!(requests[1].body["status"], "running");
        server.abort();
    }

    #[tokio::test]
    async fn a_heartbeat_404_forces_registration_on_the_next_cycle() {
        let (address, mock, server) = start_mock_node_agent().await;
        let client = NodeAgentClient::new(config(format!("http://{address}")));
        client.register(&snapshot()).await.expect("register");
        mock.heartbeat_not_found.store(true, Ordering::SeqCst);
        let error = client
            .heartbeat(&snapshot())
            .await
            .expect_err("heartbeat should fail");
        assert_eq!(error.status(), Some(StatusCode::NOT_FOUND));
        assert!(client.registered_instance_id().is_none());
        server.abort();
    }
}
