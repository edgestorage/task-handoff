use agent_client_protocol::{schema::ProtocolVersion, v1, Agent, ByteStreams, Client};
use std::{
    collections::BTreeMap, future::Future, io, path::Path, process::Stdio, sync::Mutex,
    time::Duration,
};
use tokio::{
    process::Command,
    sync::{oneshot, watch},
    task::JoinHandle,
    time::timeout,
};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use v1::schema::{
    AgentCapabilities, InitializeRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SessionNotification,
};

pub(crate) struct AcpConnection {
    pub(crate) agent: v1::ConnectionTo<Agent>,
    pub(crate) capabilities: AgentCapabilities,
    pub(crate) closed: watch::Receiver<()>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl AcpConnection {
    pub(crate) fn is_closed(&self) -> bool {
        self.closed.has_changed().is_err() || self.agent.is_incoming_closed()
    }

    pub(crate) async fn connect<Update, Permission, Response>(
        executable: &Path,
        args: &[String],
        cwd: &Path,
        env: &BTreeMap<String, String>,
        update: Update,
        permission: Permission,
    ) -> io::Result<Self>
    where
        Update: Fn(SessionNotification) + Send + Sync + 'static,
        Permission: Fn(RequestPermissionRequest) -> Response + Send + Sync + 'static,
        Response: Future<Output = Option<RequestPermissionResponse>> + Send,
    {
        let mut child = Command::new(executable)
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("Missing ACP stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Missing ACP stdout"))?;
        let transport = ByteStreams::new(stdin.compat_write(), stdout.compat());
        let (ready_tx, ready_rx) = oneshot::channel();
        let (stop, stopped) = oneshot::channel();
        let (alive, closed) = watch::channel(());
        let task = tokio::spawn(async move {
            let driver = Client
                .v1()
                .on_receive_notification(
                    async move |event: SessionNotification, _connection| {
                        update(event);
                        Ok(())
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .on_receive_request(
                    async move |request: RequestPermissionRequest, responder, connection| {
                        let response = tokio::select! {
                            response = permission(request) => response,
                            _ = connection.incoming_closed() => return Ok(()),
                        }
                        .unwrap_or_else(|| {
                            RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled)
                        });
                        responder.respond(response)
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_with(transport, async move |agent: v1::ConnectionTo<Agent>| {
                    let handshake = agent
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task()
                        .await;
                    let result = match handshake {
                        Ok(result) if result.protocol_version == ProtocolVersion::V1 => {
                            Ok((agent.clone(), result.agent_capabilities))
                        }
                        Ok(_) => Err(io::Error::other("Agent does not support ACP v1")),
                        Err(error) => Err(io::Error::other(error.to_string())),
                    };
                    let initialized = result.is_ok();
                    if ready_tx.send(result).is_ok() && initialized {
                        tokio::select! {
                            _ = stopped => {},
                            _ = agent.incoming_closed() => {},
                        }
                    }
                    Ok(())
                });
            tokio::select! {
                biased;
                _ = driver => {},
                _ = child.wait() => {},
            }
            drop(alive);
            let _ = child.kill().await;
        });
        match timeout(Duration::from_secs(15), ready_rx).await {
            Ok(Ok(Ok((agent, capabilities)))) => Ok(Self {
                agent,
                capabilities,
                closed,
                stop: Mutex::new(Some(stop)),
                task: Mutex::new(Some(task)),
            }),
            result => {
                task.abort();
                let _ = task.await;
                Err(match result {
                    Ok(Ok(Err(error))) => error,
                    Ok(Err(_)) => io::Error::other("ACP Agent disconnected during initialization"),
                    Err(_) => {
                        io::Error::new(io::ErrorKind::TimedOut, "ACP initialization timed out")
                    }
                    _ => unreachable!(),
                })
            }
        }
    }

    pub(crate) async fn close(&self) {
        if let Some(stop) = self
            .stop
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = stop.send(());
        }
        let task = self
            .task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let Some(mut task) = task else {
            return;
        };
        if timeout(Duration::from_secs(2), &mut task).await.is_err() {
            task.abort();
            let _ = task.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use v1::schema::{
        ContentBlock, NewSessionRequest, PromptRequest, SessionUpdate, StopReason, TextContent,
    };

    #[tokio::test]
    async fn acp_stdio_receives_ordered_updates_before_prompt_completion() {
        timeout(Duration::from_secs(10), async {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()
                .unwrap();
            let fixture = root.join("test/fixtures/fake-acp-agent.mjs");
            let updates = Arc::new(Mutex::new(Vec::new()));
            let observer = updates.clone();
            let connection = AcpConnection::connect(
                Path::new("node"),
                &[fixture.to_string_lossy().into_owned()],
                &root,
                &BTreeMap::from([("PATH".to_string(), std::env::var("PATH").unwrap())]),
                move |notification| {
                    if let SessionUpdate::AgentMessageChunk(chunk) = notification.update {
                        if let ContentBlock::Text(content) = chunk.content {
                            observer.lock().unwrap().push(content.text);
                        }
                    }
                },
                |_| async { None },
            )
            .await
            .unwrap();
            assert!(connection.capabilities.load_session);
            let session = connection
                .agent
                .send_request(NewSessionRequest::new(root))
                .block_task()
                .await
                .unwrap();
            assert_eq!(session.session_id.to_string(), "shared-acp-session");
            let result = connection
                .agent
                .send_request(PromptRequest::new(
                    session.session_id,
                    vec![ContentBlock::Text(TextContent::new("hello"))],
                ))
                .block_task()
                .await
                .unwrap();
            assert_eq!(result.stop_reason, StopReason::EndTurn);
            assert_eq!(*updates.lock().unwrap(), ["one", " two"]);
            connection.close().await;
        })
        .await
        .unwrap();
    }
}
