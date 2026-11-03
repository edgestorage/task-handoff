use crate::{AiSession, AiSessionControlProvider, ProviderAction, ProviderError, ProviderMessage};
use async_trait::async_trait;
use controlled_instance_core::local_ipc::{connect as connect_local_ipc, LocalIpcEndpoint};
use controlled_instance_protocol::{
    AiSessionAttachmentKind, AiSessionHierarchyCapabilities, AiSessionModelSelectionCapabilities,
    AiSessionProviderActions, AiSessionProviderCapability, AiSessionProviderTimelineCapabilities,
    AiSessionReasoningEffortCapabilities,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::broadcast,
    task::AbortHandle,
    time::timeout,
};

const CLAUDE_CONTROL_PROTOCOL: u8 = 1;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const CONTROL_RESPONSE_LIMIT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ClaudeControlError {
    #[error("Claude control socket request timed out.")]
    Timeout,
    #[error("Claude control socket connection failed: {0}")]
    Connection(String),
    #[error("Claude control socket returned malformed JSON: {0}")]
    MalformedResponse(String),
    #[error("Claude control socket returned an oversized response.")]
    ResponseTooLarge,
    #[error("Claude worker short id must be 8 lowercase hex characters: {0}")]
    InvalidShort(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDaemonJob {
    #[serde(default)]
    pub short: Option<String>,
    #[serde(default)]
    pub nonce: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub attempt: Option<u32>,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub tempo: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub intent: Option<String>,
    #[serde(default)]
    pub needs: Option<Value>,
    #[serde(default)]
    pub cli_version: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ClaudeControlClient {
    request_timeout: Duration,
}

impl ClaudeControlClient {
    pub fn new() -> Self {
        let request_timeout = env::var("TASK_HANDOFF_CLAUDE_CONTROL_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_TIMEOUT);
        Self { request_timeout }
    }

    pub fn with_timeout(request_timeout: Duration) -> Self {
        Self { request_timeout }
    }

    pub fn control_socket_path(&self) -> PathBuf {
        claude_control_socket_path_from_env()
    }

    pub async fn call(&self, request: Value) -> Result<Value, ClaudeControlError> {
        self.call_at(request, &self.control_socket_path()).await
    }

    pub async fn call_at(
        &self,
        request: Value,
        socket_path: &Path,
    ) -> Result<Value, ClaudeControlError> {
        let mut request = match request {
            Value::Object(object) => object,
            _ => {
                return Err(ClaudeControlError::MalformedResponse(
                    "request must be a JSON object".to_string(),
                ))
            }
        };
        request.insert("proto".to_string(), json!(CLAUDE_CONTROL_PROTOCOL));
        let payload = serde_json::to_vec(&Value::Object(request)).map_err(|error| {
            ClaudeControlError::MalformedResponse(format!("failed to encode request: {error}"))
        })?;

        timeout(self.request_timeout, async move {
            let endpoint = LocalIpcEndpoint::explicit(socket_path)
                .map_err(|error| ClaudeControlError::Connection(error.to_string()))?;
            let mut stream = connect_local_ipc(&endpoint)
                .await
                .map_err(|error| ClaudeControlError::Connection(error.to_string()))?;
            stream
                .write_all(&payload)
                .await
                .map_err(|error| ClaudeControlError::Connection(error.to_string()))?;
            stream
                .write_all(b"\n")
                .await
                .map_err(|error| ClaudeControlError::Connection(error.to_string()))?;
            stream
                .flush()
                .await
                .map_err(|error| ClaudeControlError::Connection(error.to_string()))?;
            let mut reader = BufReader::new(stream);
            let mut line = Vec::new();
            reader
                .read_until(b'\n', &mut line)
                .await
                .map_err(|error| ClaudeControlError::Connection(error.to_string()))?;
            if line.len() > CONTROL_RESPONSE_LIMIT_BYTES {
                return Err(ClaudeControlError::ResponseTooLarge);
            }
            let line = line.strip_suffix(b"\n").unwrap_or(&line);
            serde_json::from_slice(line).map_err(|error| {
                ClaudeControlError::MalformedResponse(format!(
                    "{error}: {}",
                    String::from_utf8_lossy(line)
                ))
            })
        })
        .await
        .map_err(|_| ClaudeControlError::Timeout)?
    }

    pub async fn list_jobs(&self) -> Result<Vec<ClaudeDaemonJob>, ClaudeControlError> {
        self.list_jobs_at(&self.control_socket_path()).await
    }

    pub async fn list_jobs_at(
        &self,
        socket_path: &Path,
    ) -> Result<Vec<ClaudeDaemonJob>, ClaudeControlError> {
        let response = self.call_at(json!({ "op": "list" }), socket_path).await?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(control_response_error(&response));
        }
        Ok(response
            .get("jobs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|job| serde_json::from_value(job.clone()).ok())
            .collect())
    }

    pub async fn has_job(
        &self,
        short: &str,
        socket_path: &Path,
    ) -> Result<bool, ClaudeControlError> {
        let response = self
            .call_at(json!({ "op": "has", "short": short }), socket_path)
            .await?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(control_response_error(&response));
        }
        Ok(response.get("present").and_then(Value::as_bool) == Some(true))
    }

    pub async fn reply(
        &self,
        short: &str,
        text: &str,
        socket_path: &Path,
    ) -> Result<Value, ClaudeControlError> {
        self.call_at(
            json!({ "op": "reply", "short": short, "text": text }),
            socket_path,
        )
        .await
    }

    pub async fn kill(
        &self,
        short: &str,
        signal: &str,
        socket_path: &Path,
    ) -> Result<Value, ClaudeControlError> {
        self.call_at(
            json!({ "op": "kill", "short": short, "signal": signal }),
            socket_path,
        )
        .await
    }

    pub async fn subscribe(
        &self,
        short: &str,
        socket_path: &Path,
        tail: Option<u64>,
    ) -> Result<ClaudeSubscription, ClaudeControlError> {
        let endpoint = LocalIpcEndpoint::explicit(socket_path)
            .map_err(|error| ClaudeControlError::Connection(error.to_string()))?;
        let mut stream = connect_local_ipc(&endpoint)
            .await
            .map_err(|error| ClaudeControlError::Connection(error.to_string()))?;
        let mut request = json!({
            "proto": CLAUDE_CONTROL_PROTOCOL,
            "op": "subscribe",
            "short": short,
        });
        if let Some(tail) = tail {
            request["tail"] = json!(tail);
        }
        stream
            .write_all(request.to_string().as_bytes())
            .await
            .map_err(|error| ClaudeControlError::Connection(error.to_string()))?;
        stream
            .write_all(b"\n")
            .await
            .map_err(|error| ClaudeControlError::Connection(error.to_string()))?;
        stream
            .flush()
            .await
            .map_err(|error| ClaudeControlError::Connection(error.to_string()))?;

        let (sender, messages) = broadcast::channel(128);
        let task = tokio::spawn(async move {
            let mut reader = BufReader::new(stream);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if line.len() > CONTROL_RESPONSE_LIMIT_BYTES {
                            break;
                        }
                        let line = line.strip_suffix(b"\n").unwrap_or(&line);
                        if line.iter().all(u8::is_ascii_whitespace) {
                            continue;
                        }
                        let message = serde_json::from_slice(line)
                            .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(line) }));
                        if sender.send(message).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok(ClaudeSubscription {
            messages,
            abort: task.abort_handle(),
        })
    }
}

pub struct ClaudeSubscription {
    pub messages: broadcast::Receiver<Value>,
    abort: AbortHandle,
}

impl ClaudeSubscription {
    pub fn stop(&self) {
        self.abort.abort();
    }

    pub fn abort_handle(&self) -> AbortHandle {
        self.abort.clone()
    }
}

impl Drop for ClaudeSubscription {
    fn drop(&mut self) {
        self.abort.abort();
    }
}

#[derive(Clone, Debug, Default)]
pub struct ClaudeControlSockProvider {
    client: ClaudeControlClient,
}

impl ClaudeControlSockProvider {
    pub fn new(client: ClaudeControlClient) -> Self {
        Self { client }
    }

    pub fn client(&self) -> &ClaudeControlClient {
        &self.client
    }
}

#[async_trait]
impl AiSessionControlProvider for ClaudeControlSockProvider {
    fn agent(&self) -> &str {
        "claude"
    }

    fn interrupt_preserves_turn(&self) -> bool {
        true
    }

    fn capability(&self) -> AiSessionProviderCapability {
        AiSessionProviderCapability {
            agent: "claude".to_string(),
            actions: AiSessionProviderActions {
                create: false,
                send: true,
                queue: true,
                steer: true,
                interrupt: true,
                archive: true,
                delete: false,
                fork: false,
                rename: false,
                approval_decisions: Vec::new(),
            },
            permission_modes: Vec::new(),
            timeline: AiSessionProviderTimelineCapabilities::default(),
            model_selection: Some(AiSessionModelSelectionCapabilities {
                stable_identity: true,
                ..Default::default()
            }),
            reasoning_effort: Some(AiSessionReasoningEffortCapabilities::default()),
            hierarchy: Some(AiSessionHierarchyCapabilities { subagents: false }),
        }
    }

    async fn start_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        let short = claude_short(session)?;
        let socket_path = claude_socket_for_session(session);
        let message = claude_message_text(&input)?;
        let response = self
            .client
            .reply(short, &message, &socket_path)
            .await
            .map_err(send_error)?;
        ensure_control_success(&response, "AI_SESSION_SEND_FAILED", "Claude reply failed")?;
        Ok(ProviderAction::simple("send"))
    }

    async fn steer_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        let short = claude_short(session)?;
        let socket_path = claude_socket_for_session(session);
        let message = claude_message_text(&input)?;
        let response = self
            .client
            .reply(short, &message, &socket_path)
            .await
            .map_err(send_error)?;
        ensure_control_success(
            &response,
            "AI_SESSION_SEND_FAILED",
            "Claude steering reply failed",
        )?;
        Ok(ProviderAction::simple("steer"))
    }

    async fn interrupt(&self, session: &AiSession) -> Result<ProviderAction, ProviderError> {
        let short = claude_short(session)?;
        let socket_path = claude_socket_for_session(session);
        let response = self
            .client
            .kill(short, "SIGTERM", &socket_path)
            .await
            .map_err(|error| {
                ProviderError::new("AI_SESSION_INTERRUPT_FAILED", error.to_string(), 400)
            })?;
        ensure_control_success(
            &response,
            "AI_SESSION_INTERRUPT_FAILED",
            "Claude interrupt failed",
        )?;
        Ok(ProviderAction::simple("interrupt"))
    }

    async fn resolve_approval(
        &self,
        _session: &AiSession,
        _decision: &str,
    ) -> Result<ProviderAction, ProviderError> {
        Err(ProviderError::new(
            "AI_SESSION_APPROVAL_UNSUPPORTED",
            "Claude daemon sessions do not expose structured approval control.",
            400,
        ))
    }

    async fn archive_session(&self, _provider_session_id: &str) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn unsubscribe_session(&self, _provider_session_id: &str) -> Result<(), ProviderError> {
        Ok(())
    }
}

pub fn claude_control_socket_path_from_env() -> PathBuf {
    controlled_instance_core::claude::control_socket_path_from_env()
}

pub fn claude_control_socket_path(
    environment: &std::collections::BTreeMap<String, String>,
) -> PathBuf {
    controlled_instance_core::claude::control_socket_path(environment)
}

fn claude_short(session: &AiSession) -> Result<&str, ProviderError> {
    let short = session
        .provider_meta
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|meta| meta.get("short"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ProviderError::new(
                "AI_SESSION_CLAUDE_SHORT_NOT_FOUND",
                "Claude session is not bound to a daemon worker.",
                400,
            )
        })?;
    Ok(short)
}

fn claude_socket_for_session(session: &AiSession) -> PathBuf {
    session
        .provider_meta
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|meta| meta.get("controlSock"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(claude_control_socket_path_from_env)
}

fn claude_message_text(input: &ProviderMessage) -> Result<String, ProviderError> {
    let mut image_count = 0usize;
    let mut file_count = 0usize;
    for attachment in &input.attachments {
        match attachment.meta.kind {
            AiSessionAttachmentKind::Image => image_count += 1,
            AiSessionAttachmentKind::File => file_count += 1,
        }
    }
    let mut image_index = 0usize;
    let mut file_index = 0usize;
    let mut paths = Vec::with_capacity(input.attachments.len());
    for attachment in &input.attachments {
        if attachment.path.as_os_str().is_empty() {
            return Err(ProviderError::new(
                "AI_SESSION_ATTACHMENT_CONTENT_MISSING",
                format!("Attachment content path is missing: {}", attachment.meta.id),
                400,
            ));
        }
        let metadata = std::fs::metadata(&attachment.path).map_err(|_| {
            ProviderError::new(
                "AI_SESSION_ATTACHMENT_CONTENT_MISSING",
                format!(
                    "Attachment content does not exist: {}",
                    attachment.path.display()
                ),
                400,
            )
        })?;
        if !metadata.is_file() {
            return Err(ProviderError::new(
                "AI_SESSION_ATTACHMENT_CONTENT_MISSING",
                format!(
                    "Attachment content is not a file: {}",
                    attachment.path.display()
                ),
                400,
            ));
        }
        let (label, index) = match attachment.meta.kind {
            AiSessionAttachmentKind::Image => {
                image_index += 1;
                ("图片", (image_count > 1).then_some(image_index))
            }
            AiSessionAttachmentKind::File => {
                file_index += 1;
                ("文件", (file_count > 1).then_some(file_index))
            }
        };
        paths.push(format!(
            "{label}{}路径：{}",
            index.map(|value| value.to_string()).unwrap_or_default(),
            attachment.path.display()
        ));
    }
    let mut message = input.message.clone();
    if !paths.is_empty() {
        if !message.is_empty() {
            message.push_str("\n\n");
        }
        message.push_str(&paths.join("\n"));
    }
    if !message.ends_with('\n') {
        message.push('\n');
    }
    Ok(message)
}

fn control_response_error(response: &Value) -> ClaudeControlError {
    let code = response
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let error = response
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or(code);
    ClaudeControlError::Connection(error.to_string())
}

fn ensure_control_success(response: &Value, code: &str, prefix: &str) -> Result<(), ProviderError> {
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    let response_code = response
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let message = response
        .get("error")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{prefix}: {response_code}"));
    Err(ProviderError::new(code, message, 400))
}

fn send_error(error: ClaudeControlError) -> ProviderError {
    ProviderError::new("AI_SESSION_SEND_FAILED", error.to_string(), 400)
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_core::local_ipc::bind as bind_local_ipc;
    use controlled_instance_protocol::{
        AiSessionMessageAttachmentMeta, AiSessionMessageAttachmentSourceType,
    };
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn session(short: &str, socket: &Path) -> AiSession {
        AiSession {
            id: "ses_0000000000001".to_string(),
            agent: "claude".to_string(),
            creation_source: "app-session".to_string(),
            app_session_id: Some("aps_0000000000001".to_string()),
            app_id: Some("claude".to_string()),
            provider_session_id: Some("provider-session".to_string()),
            lineage: None,
            provider_meta: Some(json!({
                "short": short,
                "controlSock": socket.display().to_string(),
            })),
            model_selection: None,
            reasoning_effort: None,
            story_id: None,
            app_binding_keys: None,
            actions: None,
            active_turn_id: None,
            title: None,
            cwd: Some("/workspace".to_string()),
            cwd_folder_id: None,
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
            started_at: String::new(),
            updated_at: String::new(),
            completed_at: None,
            error: None,
            counters: Default::default(),
            queue: Default::default(),
            unread: false,
        }
    }

    async fn fake_socket(
        root: &TempDir,
        responses: Vec<Value>,
    ) -> (PathBuf, tokio::task::JoinHandle<Vec<Value>>) {
        let path = root.path().join("control.sock");
        let endpoint = LocalIpcEndpoint::explicit(&path).expect("endpoint");
        endpoint.prepare().expect("prepare");
        let mut listener = bind_local_ipc(&endpoint).expect("bind");
        let handle = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let stream = listener.accept().await.expect("accept");
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                reader.read_line(&mut line).await.expect("read");
                requests.push(serde_json::from_str(line.trim()).expect("request json"));
                let mut stream = reader.into_inner();
                stream
                    .write_all(format!("{}\n", response).as_bytes())
                    .await
                    .expect("write");
            }
            requests
        });
        (path, handle)
    }

    #[test]
    fn socket_path_honors_override_and_default_layout() {
        let mut environment = BTreeMap::new();
        environment.insert(
            "CLAUDE_CONTROL_SOCK".to_string(),
            "/tmp/custom.sock".to_string(),
        );
        assert_eq!(
            claude_control_socket_path(&environment),
            PathBuf::from("/tmp/custom.sock")
        );

        environment.remove("CLAUDE_CONTROL_SOCK");
        environment.insert("HOME".to_string(), "/home/test".to_string());
        let path = claude_control_socket_path(&environment);
        assert!(path.starts_with(format!("/tmp/cc-daemon-{}", test_uid())));
        assert_eq!(
            path.file_name().and_then(|value| value.to_str()),
            Some("control.sock")
        );
        let hash = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .expect("hash");
        assert_eq!(hash.len(), 8);
        assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn list_jobs_sends_protocol_and_decodes_jobs() {
        let root = TempDir::new().expect("tempdir");
        let (socket, server) = fake_socket(
            &root,
            vec![json!({
                "ok": true,
                "jobs": [{ "short": "a1b2c3d4", "sessionId": "provider-session", "state": "working" }]
            })],
        )
        .await;
        let jobs = ClaudeControlClient::with_timeout(Duration::from_secs(1))
            .list_jobs_at(&socket)
            .await
            .expect("list");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].session_id.as_deref(), Some("provider-session"));
        let requests = server.await.expect("server");
        assert_eq!(requests[0]["proto"], 1);
        assert_eq!(requests[0]["op"], "list");
    }

    #[tokio::test]
    async fn provider_appends_attachment_paths_and_newline() {
        let root = TempDir::new().expect("tempdir");
        let attachment = root.path().join("image.png");
        std::fs::write(&attachment, b"png").expect("attachment");
        let (socket, server) = fake_socket(&root, vec![json!({ "ok": true })]).await;
        let session = session("a1b2c3d4", &socket);
        let message = ProviderMessage {
            message: "  describe this  ".to_string(),
            attachments: vec![crate::ProviderAttachment {
                meta: AiSessionMessageAttachmentMeta {
                    id: "att_0000000000001".to_string(),
                    kind: AiSessionAttachmentKind::Image,
                    name: "image.png".to_string(),
                    mime: "image/png".to_string(),
                    size: 3,
                    source_type: AiSessionMessageAttachmentSourceType::RuntimePath,
                },
                path: attachment.clone(),
                source: crate::ProviderAttachmentSource::RuntimePath,
                runtime_path: Some(attachment.clone()),
            }],
            references: Vec::new(),
            permission_mode: None,
            message_id: Some("msg_0000000000001".to_string()),
            user_message_attachments: Vec::new(),
            story_agent_tools: None,
        };
        let action = ClaudeControlSockProvider::new(ClaudeControlClient::with_timeout(
            Duration::from_secs(1),
        ))
        .start_message(&session, message)
        .await
        .expect("send");
        assert_eq!(action.action, "send");
        let requests = server.await.expect("server");
        assert_eq!(requests[0]["op"], "reply");
        assert_eq!(requests[0]["short"], "a1b2c3d4");
        assert_eq!(
            requests[0]["text"],
            format!("  describe this  \n\n图片路径：{}\n", attachment.display())
        );
    }

    #[tokio::test]
    async fn invalid_short_and_control_errors_are_structured() {
        let root = TempDir::new().expect("tempdir");
        let (socket, server) = fake_socket(
            &root,
            vec![json!({ "ok": false, "code": "ENOENT", "error": "missing worker" })],
        )
        .await;
        let valid_session = session("a1b2c3d4", &socket);
        let error = ClaudeControlSockProvider::new(ClaudeControlClient::with_timeout(
            Duration::from_secs(1),
        ))
        .start_message(
            &valid_session,
            ProviderMessage {
                message: "hello".to_string(),
                attachments: Vec::new(),
                references: Vec::new(),
                permission_mode: None,
                message_id: None,
                user_message_attachments: Vec::new(),
                story_agent_tools: None,
            },
        )
        .await
        .expect_err("control error");
        assert_eq!(error.code, "AI_SESSION_SEND_FAILED");
        assert_eq!(error.message, "missing worker");
        assert!(server.await.is_ok());

        let invalid = session("", &socket);
        let error = ClaudeControlSockProvider::new(ClaudeControlClient::with_timeout(
            Duration::from_secs(1),
        ))
        .start_message(
            &invalid,
            ProviderMessage {
                message: "hello".to_string(),
                attachments: Vec::new(),
                references: Vec::new(),
                permission_mode: None,
                message_id: None,
                user_message_attachments: Vec::new(),
                story_agent_tools: None,
            },
        )
        .await
        .expect_err("missing short");
        assert_eq!(error.code, "AI_SESSION_CLAUDE_SHORT_NOT_FOUND");
    }

    #[tokio::test]
    async fn subscribe_keeps_frames_that_arrive_in_one_read() {
        use tokio::io::AsyncWriteExt;

        let root = TempDir::new().expect("tempdir");
        let socket = root.path().join("control.sock");
        let endpoint = LocalIpcEndpoint::explicit(&socket).expect("endpoint");
        endpoint.prepare().expect("prepare");
        let mut listener = bind_local_ipc(&endpoint).expect("bind");
        let server = tokio::spawn(async move {
            let stream = listener.accept().await.expect("accept");
            let mut line = String::new();
            let mut reader = BufReader::new(stream);
            reader.read_line(&mut line).await.expect("request");
            let mut stream = reader.into_inner();
            stream
                .write_all(b"{\"type\":\"state\",\"state\":\"waiting\"}\n{\"type\":\"settled\",\"outcome\":\"done\"}\n")
                .await
                .expect("frames");
        });
        let client = ClaudeControlClient::with_timeout(Duration::from_secs(1));
        let mut subscription = client
            .subscribe("a1b2c3d4", &socket, Some(4096))
            .await
            .expect("subscribe");
        let first = subscription.messages.recv().await.expect("first");
        let second = subscription.messages.recv().await.expect("second");
        assert_eq!(first["state"], "waiting");
        assert_eq!(second["outcome"], "done");
        server.await.expect("server");
    }

    fn test_uid() -> u32 {
        #[cfg(unix)]
        {
            unsafe { libc::getuid() }
        }
        #[cfg(not(unix))]
        {
            0
        }
    }
}
