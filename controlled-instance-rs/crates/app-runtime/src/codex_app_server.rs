use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use controlled_instance_protocol::AppCatalogItem;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    process::{Child, Command},
    sync::broadcast,
};
use tokio_tungstenite::{
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};
use tracing::debug;

use crate::{command_invocation::CommandInvocation, AppRuntimeError};

pub const CODEX_APP_SERVER_READY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexAppServerTransport {
    Unix,
    WebSocket,
}

impl CodexAppServerTransport {
    pub fn metadata_value(self) -> &'static str {
        match self {
            Self::Unix => "unix",
            Self::WebSocket => "ws",
        }
    }

    pub fn inferred(platform: &str) -> Self {
        if platform == "windows" {
            Self::WebSocket
        } else {
            Self::Unix
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexAppServerUpstream {
    Unix {
        socket_path: PathBuf,
    },
    WebSocket {
        endpoint: String,
        token_file: Option<PathBuf>,
    },
}

impl CodexAppServerUpstream {
    pub fn transport(&self) -> CodexAppServerTransport {
        match self {
            Self::Unix { .. } => CodexAppServerTransport::Unix,
            Self::WebSocket { .. } => CodexAppServerTransport::WebSocket,
        }
    }

    pub fn endpoint(&self) -> String {
        match self {
            Self::Unix { socket_path } => format!("unix://{}", socket_path.display()),
            Self::WebSocket { endpoint, .. } => endpoint.clone(),
        }
    }

    pub fn socket_path(&self) -> Option<&Path> {
        match self {
            Self::Unix { socket_path } => Some(socket_path),
            Self::WebSocket { .. } => None,
        }
    }

    pub fn token_file(&self) -> Option<&Path> {
        match self {
            Self::Unix { .. } => None,
            Self::WebSocket { token_file, .. } => token_file.as_deref(),
        }
    }

    pub fn app_server_metadata(
        &self,
        pid: Option<u32>,
        command: &str,
        args: &[String],
        log_path: &Path,
        proxy: Option<(&str, u16)>,
        status: &str,
    ) -> Value {
        let mut value = serde_json::Map::from_iter([
            (
                "transport".to_string(),
                json!(self.transport().metadata_value()),
            ),
            ("endpoint".to_string(), json!(self.endpoint())),
            ("command".to_string(), json!(command)),
            ("args".to_string(), json!(args)),
            ("logPath".to_string(), json!(log_path.display().to_string())),
            ("status".to_string(), json!(status)),
        ]);
        if let Some(socket_path) = self.socket_path() {
            value.insert(
                "socketPath".to_string(),
                json!(socket_path.display().to_string()),
            );
        }
        if let Some(token_file) = self.token_file() {
            value.insert(
                "tokenFile".to_string(),
                json!(token_file.display().to_string()),
            );
        }
        if let Some(pid) = pid {
            value.insert("pid".to_string(), json!(pid));
        }
        if let Some((endpoint, port)) = proxy {
            value.insert("proxyEndpoint".to_string(), json!(endpoint));
            value.insert("proxyPort".to_string(), json!(port));
        }
        Value::Object(value)
    }
}

#[derive(Debug, Clone)]
pub struct CodexAppServerListenPlan {
    pub upstream: CodexAppServerUpstream,
    pub listen_args: Vec<String>,
    pub health_url: Option<String>,
}

pub fn configured_transport() -> CodexAppServerTransport {
    match std::env::var("TASK_HANDOFF_CODEX_APP_SERVER_TRANSPORT")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "unix" => CodexAppServerTransport::Unix,
        "ws" => CodexAppServerTransport::WebSocket,
        _ => CodexAppServerTransport::inferred(std::env::consts::OS),
    }
}

pub fn app_server_disabled() -> bool {
    matches!(
        std::env::var("TASK_HANDOFF_CODEX_APP_SERVER_DISABLED")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub fn story_mcp_args(environment: &std::collections::BTreeMap<String, String>) -> Vec<String> {
    let endpoint = environment
        .get("TASK_HANDOFF_AGENT_TOOLS_ENDPOINT")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let token = environment
        .get("TASK_HANDOFF_AGENT_TOOLS_TOKEN")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match (endpoint, token) {
        (Some(endpoint), Some(_)) => vec![
            "-c".to_string(),
            format!(
                "mcp_servers.task_handoff_story.url='{}/mcp'",
                endpoint.trim_end_matches('/')
            ),
            "-c".to_string(),
            "mcp_servers.task_handoff_story.bearer_token_env_var='TASK_HANDOFF_AGENT_TOOLS_TOKEN'"
                .to_string(),
        ],
        _ => Vec::new(),
    }
}

pub fn listen_plan(
    transport: CodexAppServerTransport,
    runtime_dir: &Path,
    allocate_port: impl FnOnce() -> Result<u16, AppRuntimeError>,
) -> Result<CodexAppServerListenPlan, AppRuntimeError> {
    std::fs::create_dir_all(runtime_dir)
        .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
    match transport {
        CodexAppServerTransport::Unix => {
            let socket_path = unix_socket_path(runtime_dir)?;
            if let Some(parent) = socket_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
            }
            let _ = std::fs::remove_file(&socket_path);
            let endpoint = format!("unix://{}", socket_path.display());
            Ok(CodexAppServerListenPlan {
                upstream: CodexAppServerUpstream::Unix { socket_path },
                listen_args: vec!["--listen".to_string(), endpoint],
                health_url: None,
            })
        }
        CodexAppServerTransport::WebSocket => {
            let port = allocate_port()?;
            let endpoint = format!("ws://127.0.0.1:{port}");
            let token_file = runtime_dir.join("app-server-token");
            let token = create_token();
            std::fs::write(&token_file, token.as_bytes())
                .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
            restrict_private_file(&token_file)?;
            Ok(CodexAppServerListenPlan {
                upstream: CodexAppServerUpstream::WebSocket {
                    endpoint: endpoint.clone(),
                    token_file: Some(token_file.clone()),
                },
                listen_args: vec![
                    "--listen".to_string(),
                    endpoint.clone(),
                    "--ws-auth".to_string(),
                    "capability-token".to_string(),
                    "--ws-token-file".to_string(),
                    token_file.display().to_string(),
                ],
                health_url: Some(format!("http://127.0.0.1:{port}/readyz")),
            })
        }
    }
}

fn unix_socket_path(runtime_dir: &Path) -> Result<PathBuf, AppRuntimeError> {
    use sha2::{Digest, Sha256};
    let key = runtime_dir.to_string_lossy();
    let hash = hex::encode(Sha256::digest(key.as_bytes()));
    let scope = format!("task-handoff-codex-{}", &hash[..16]);
    let root = std::env::var_os("TASK_HANDOFF_CODEX_APP_SERVER_SOCKET_DIR")
        .map(PathBuf::from)
        .map(|path| std::fs::canonicalize(&path).unwrap_or(path))
        .unwrap_or_else(controlled_instance_core::local_ipc::temporary_root);
    let path = root.join(scope).join("app-server.sock");
    let limit = if cfg!(target_os = "macos") { 103 } else { 107 };
    if path.as_os_str().as_encoded_bytes().len() > limit {
        return Err(AppRuntimeError::spawn(format!(
            "Codex app-server socket path exceeds the {limit}-byte limit: {}",
            path.display()
        )));
    }
    Ok(path)
}

fn create_token() -> String {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn restrict_private_file(_path: &Path) -> Result<(), AppRuntimeError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
    }
    Ok(())
}

pub fn remove_upstream_artifacts(upstream: &CodexAppServerUpstream) {
    if let Some(socket_path) = upstream.socket_path() {
        let _ = std::fs::remove_file(socket_path);
    }
    if let Some(token_file) = upstream.token_file() {
        let _ = std::fs::remove_file(token_file);
    }
}

pub async fn spawn_app_server(
    invocation: &CommandInvocation,
    cwd: &Path,
    env: &std::collections::BTreeMap<String, String>,
    log_path: &Path,
) -> Result<Child, AppRuntimeError> {
    let mut command = Command::new(&invocation.executable);
    command
        .args(&invocation.args)
        .current_dir(cwd)
        .envs(env)
        .envs(&invocation.env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            AppRuntimeError::missing_command(invocation.executable.display().to_string())
        } else {
            AppRuntimeError::spawn(format!("Codex app-server failed to start: {error}"))
        }
    })?;
    crate::log_retention::attach_child_logs(&mut child, log_path)
        .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
    Ok(child)
}

pub async fn wait_until_ready(
    child: &mut Child,
    plan: &CodexAppServerListenPlan,
) -> Result<(), AppRuntimeError> {
    let deadline = tokio::time::Instant::now() + CODEX_APP_SERVER_READY_TIMEOUT;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(AppRuntimeError::spawn(format!(
                "Codex app-server exited before becoming ready: {status}"
            )));
        }
        let ready = match &plan.upstream {
            CodexAppServerUpstream::Unix { socket_path } => socket_path.exists(),
            CodexAppServerUpstream::WebSocket { .. } => match plan.health_url.as_deref() {
                Some(health_url) => reqwest::get(health_url)
                    .await
                    .is_ok_and(|response| response.status().is_success()),
                None => false,
            },
        };
        if ready {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AppRuntimeError::spawn(
                "Codex app-server did not become ready within 15000ms.",
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

enum UpstreamSocket {
    #[cfg(unix)]
    Unix(WebSocketStream<tokio::net::UnixStream>),
    Tcp(WebSocketStream<MaybeTlsStream<TcpStream>>),
}

impl UpstreamSocket {
    async fn connect(upstream: &CodexAppServerUpstream) -> Result<Self, String> {
        match upstream {
            CodexAppServerUpstream::Unix { socket_path } => {
                #[cfg(unix)]
                {
                    let stream = tokio::net::UnixStream::connect(socket_path)
                        .await
                        .map_err(|error| error.to_string())?;
                    let (socket, _) = tokio_tungstenite::client_async("ws://localhost/rpc", stream)
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok(Self::Unix(socket))
                }
                #[cfg(not(unix))]
                {
                    let _ = socket_path;
                    Err(
                        "Unix Codex app-server transport is unavailable on this platform"
                            .to_string(),
                    )
                }
            }
            CodexAppServerUpstream::WebSocket {
                endpoint,
                token_file,
            } => {
                let token = token_file
                    .as_deref()
                    .map(std::fs::read_to_string)
                    .transpose()
                    .map_err(|error| format!("Codex app-server token file is unreadable: {error}"))?
                    .map(|token| token.trim().to_string())
                    .filter(|token| !token.is_empty());
                let mut request = format!("{}/rpc", endpoint.trim_end_matches('/'))
                    .to_string()
                    .into_client_request()
                    .map_err(|error| error.to_string())?;
                if let Some(token) = token {
                    request.headers_mut().insert(
                        "Authorization",
                        format!("Bearer {token}").parse().map_err(|error| {
                            format!("Codex app-server token is invalid: {error}")
                        })?,
                    );
                }
                let (socket, _) = tokio_tungstenite::connect_async(request)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(Self::Tcp(socket))
            }
        }
    }

    async fn send(&mut self, message: Message) -> Result<(), String> {
        match self {
            #[cfg(unix)]
            Self::Unix(socket) => socket
                .send(message)
                .await
                .map_err(|error| error.to_string()),
            Self::Tcp(socket) => socket
                .send(message)
                .await
                .map_err(|error| error.to_string()),
        }
    }

    async fn next(&mut self) -> Option<Result<Message, String>> {
        match self {
            #[cfg(unix)]
            Self::Unix(socket) => socket
                .next()
                .await
                .map(|result| result.map_err(|error| error.to_string())),
            Self::Tcp(socket) => socket
                .next()
                .await
                .map(|result| result.map_err(|error| error.to_string())),
        }
    }
}

#[derive(Debug, Clone)]
struct PendingBindingRequest {
    thread_id: Option<String>,
}

pub struct CodexSessionProxy {
    endpoint: String,
    port: u16,
    shutdown: broadcast::Sender<()>,
    task: tokio::task::JoinHandle<()>,
    stopped: Arc<AtomicBool>,
}

impl CodexSessionProxy {
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.shutdown.send(());
        self.task.abort();
    }
}

impl Drop for CodexSessionProxy {
    fn drop(&mut self) {
        self.stop();
    }
}

pub async fn start_session_proxy(
    upstream: CodexAppServerUpstream,
    port: u16,
    on_thread_bound: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<CodexSessionProxy, AppRuntimeError> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| AppRuntimeError::spawn(format!("Codex proxy bind failed: {error}")))?;
    let (shutdown, _) = broadcast::channel(8);
    let shutdown_for_task = shutdown.clone();
    let task = tokio::spawn(async move {
        loop {
            let mut shutdown = shutdown_for_task.subscribe();
            tokio::select! {
                _ = shutdown.recv() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break };
                    let upstream = upstream.clone();
                    let on_thread_bound = on_thread_bound.clone();
                    let mut connection_shutdown = shutdown_for_task.subscribe();
                    tokio::spawn(async move {
                        if let Err(error) = relay_connection(
                            stream,
                            upstream,
                            on_thread_bound,
                            &mut connection_shutdown,
                        ).await {
                            debug!(%error, "Codex app-server proxy connection closed");
                        }
                    });
                }
            }
        }
    });
    Ok(CodexSessionProxy {
        endpoint: format!("ws://127.0.0.1:{port}"),
        port,
        shutdown,
        task,
        stopped: Arc::new(AtomicBool::new(false)),
    })
}

async fn relay_connection(
    stream: TcpStream,
    upstream: CodexAppServerUpstream,
    on_thread_bound: Arc<dyn Fn(String) + Send + Sync>,
    shutdown: &mut broadcast::Receiver<()>,
) -> Result<(), String> {
    let client = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|error| format!("Codex proxy websocket accept failed: {error}"))?;
    let mut upstream = UpstreamSocket::connect(&upstream).await?;
    let mut client = client;
    let mut pending: HashMap<String, PendingBindingRequest> = HashMap::new();
    loop {
        tokio::select! {
            _ = shutdown.recv() => return Ok(()),
            message = client.next() => {
                let Some(message) = message else { return Ok(()) };
                let message = message.map_err(|error| error.to_string())?;
                match message {
                    Message::Text(text) => {
                        observe_client_message(&text, &mut pending, &on_thread_bound);
                        upstream.send(Message::Text(text)).await?;
                    }
                    Message::Binary(bytes) => upstream.send(Message::Binary(bytes)).await?,
                    Message::Ping(bytes) => upstream.send(Message::Ping(bytes)).await?,
                    Message::Pong(bytes) => upstream.send(Message::Pong(bytes)).await?,
                    Message::Close(frame) => {
                        let _ = upstream.send(Message::Close(frame)).await;
                        return Ok(());
                    }
                    Message::Frame(_) => {}
                }
            }
            message = upstream.next() => {
                let Some(message) = message else { return Ok(()) };
                let message = message?;
                match message {
                    Message::Text(text) => {
                        observe_server_message(&text, &mut pending, &on_thread_bound);
                        client.send(Message::Text(text)).await.map_err(|error| error.to_string())?;
                    }
                    Message::Binary(bytes) => client.send(Message::Binary(bytes)).await.map_err(|error| error.to_string())?,
                    Message::Ping(bytes) => client.send(Message::Ping(bytes)).await.map_err(|error| error.to_string())?,
                    Message::Pong(bytes) => client.send(Message::Pong(bytes)).await.map_err(|error| error.to_string())?,
                    Message::Close(frame) => {
                        let _ = client.send(Message::Close(frame)).await;
                        return Ok(());
                    }
                    Message::Frame(_) => {}
                }
            }
        }
    }
}

fn observe_client_message(
    raw: &str,
    pending: &mut HashMap<String, PendingBindingRequest>,
    on_thread_bound: &Arc<dyn Fn(String) + Send + Sync>,
) {
    let Some(message) = parse_rpc_message(raw) else {
        return;
    };
    let id = message.get("id").and_then(rpc_request_id);
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = message.get("params").unwrap_or(&Value::Null);
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    if let Some(id) = id.as_deref() {
        if matches!(method, "thread/start" | "thread/resume" | "thread/fork") {
            pending.insert(
                id.to_string(),
                PendingBindingRequest {
                    thread_id: thread_id.clone(),
                },
            );
            if let Some(thread_id) = thread_id {
                on_thread_bound(thread_id);
            }
            return;
        }
    }
    if matches!(
        method,
        "turn/start" | "turn/steer" | "turn/interrupt" | "thread/unsubscribe"
    ) {
        if let Some(thread_id) = thread_id {
            on_thread_bound(thread_id);
        }
    }
}

fn observe_server_message(
    raw: &str,
    pending: &mut HashMap<String, PendingBindingRequest>,
    on_thread_bound: &Arc<dyn Fn(String) + Send + Sync>,
) {
    let Some(message) = parse_rpc_message(raw) else {
        return;
    };
    let Some(id) = message.get("id").and_then(rpc_request_id) else {
        return;
    };
    let Some(request) = pending.remove(&id) else {
        return;
    };
    if message.get("error").is_some_and(|error| !error.is_null()) {
        return;
    }
    if let Some(thread_id) = message
        .get("result")
        .and_then(thread_id_from_result)
        .or(request.thread_id)
    {
        on_thread_bound(thread_id);
    }
}

fn parse_rpc_message(raw: &str) -> Option<Value> {
    serde_json::from_str::<Value>(raw.trim())
        .ok()
        .filter(Value::is_object)
}

fn rpc_request_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| value.as_u64().map(|value| value.to_string()))
}

fn thread_id_from_result(result: &Value) -> Option<String> {
    result
        .get("thread")
        .and_then(Value::as_object)
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            result
                .get("threadId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
}

pub fn codex_app_id(app: &AppCatalogItem) -> bool {
    app.id == "codex"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn story_mcp_args_match_node_literal_toml_shape() {
        let environment = std::collections::BTreeMap::from([
            (
                "TASK_HANDOFF_AGENT_TOOLS_ENDPOINT".to_string(),
                "http://127.0.0.1:7777/".to_string(),
            ),
            (
                "TASK_HANDOFF_AGENT_TOOLS_TOKEN".to_string(),
                "secret".to_string(),
            ),
        ]);
        assert_eq!(
            story_mcp_args(&environment),
            vec![
                "-c",
                "mcp_servers.task_handoff_story.url='http://127.0.0.1:7777/mcp'",
                "-c",
                "mcp_servers.task_handoff_story.bearer_token_env_var='TASK_HANDOFF_AGENT_TOOLS_TOKEN'",
            ]
        );
    }

    #[test]
    fn upstream_metadata_keeps_proxy_and_upstream_identity_distinct() {
        let upstream = CodexAppServerUpstream::Unix {
            socket_path: PathBuf::from("/tmp/codex/app-server.sock"),
        };
        let metadata = upstream.app_server_metadata(
            Some(42),
            "codex",
            &["app-server".to_string()],
            Path::new("/tmp/codex.log"),
            Some(("ws://127.0.0.1:9000", 9000)),
            "running",
        );
        assert_eq!(metadata["transport"], "unix");
        assert_eq!(metadata["socketPath"], "/tmp/codex/app-server.sock");
        assert_eq!(metadata["proxyEndpoint"], "ws://127.0.0.1:9000");
        assert!(metadata.get("tokenFile").is_none());
    }

    #[test]
    fn client_and_server_binding_observation_matches_node() {
        let bound = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let callback = {
            let bound = bound.clone();
            Arc::new(move |thread_id: String| {
                bound
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(thread_id);
            }) as Arc<dyn Fn(String) + Send + Sync>
        };
        let mut pending = HashMap::new();
        observe_client_message(
            r#"{"id":1,"method":"thread/resume","params":{"threadId":"thread-a"}}"#,
            &mut pending,
            &callback,
        );
        observe_server_message(
            r#"{"id":1,"result":{"thread":{"id":"thread-a"}}}"#,
            &mut pending,
            &callback,
        );
        observe_client_message(
            r#"{"id":"2","method":"turn/start","params":{"threadId":"thread-b"}}"#,
            &mut pending,
            &callback,
        );
        assert_eq!(
            *bound
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            vec!["thread-a", "thread-a", "thread-b"]
        );
    }

    #[test]
    fn websocket_token_request_uses_bearer_header() {
        let mut request = "ws://127.0.0.1:9000/rpc"
            .to_string()
            .into_client_request()
            .expect("request");
        request.headers_mut().insert(
            "Authorization",
            "Bearer test-token".parse().expect("header"),
        );
        assert_eq!(request.uri().path(), "/rpc");
        assert_eq!(
            request
                .headers()
                .get("Authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer test-token")
        );
    }

    #[test]
    fn listen_plan_uses_a_private_ws_token_file() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("tempdir");
        let plan = listen_plan(CodexAppServerTransport::WebSocket, root.path(), || Ok(9123))
            .expect("plan");
        let token_file = plan.upstream.token_file().expect("token file");
        assert!(token_file.exists());
        assert_eq!(
            std::fs::read_to_string(token_file).expect("token").len(),
            43
        );
        assert_eq!(plan.upstream.endpoint(), "ws://127.0.0.1:9123");
        assert_eq!(
            plan.health_url.as_deref(),
            Some("http://127.0.0.1:9123/readyz")
        );
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(token_file)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn listen_plan_propagates_port_allocation_errors() {
        let root = tempfile::tempdir().expect("tempdir");
        let error = listen_plan(CodexAppServerTransport::WebSocket, root.path(), || {
            Err(AppRuntimeError::ResourceExhausted(
                "No available allocation in range 8101-8199.".to_string(),
            ))
        })
        .expect_err("allocation error");

        assert_eq!(error.code(), "APP_RESOURCE_EXHAUSTED");
    }
}
