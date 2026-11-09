//! Owns only a child and IPC. The component owns all session state. Inherited
//! stdin independently supervises parent death, including partial IPC frames.
use crate::{contract::*, framing};
use controlled_instance_core::local_ipc::{self, LocalIpcEndpoint, LocalIpcStream};
use rand::RngCore;
use std::{path::Path, process::Stdio, time::Duration};
use subtle::ConstantTimeEq;
use tokio::{
    process::Command as Process,
    sync::{broadcast, mpsc, oneshot, watch},
};
const DEADLINE: Duration = Duration::from_secs(5);
struct Call {
    request: Request,
    result: oneshot::Sender<anyhow::Result<Reply>>,
}
#[derive(Clone, Copy)]
pub enum CaptureMode {
    Local,
    Virtual,
}
#[derive(Clone)]
pub struct ComponentHost {
    calls: mpsc::Sender<Call>,
    events: broadcast::Sender<SessionEvent>,
    stopped: watch::Receiver<bool>,
    pub boot_id: String,
    pub capability: ComponentCapability,
    pub fallback_url: String,
    pub fallback_token: String,
}
impl ComponentHost {
    pub async fn spawn(binary: &Path, mode: CaptureMode) -> anyhow::Result<Self> {
        Self::spawn_arguments_with_cursor(
            binary,
            &[match mode {
                CaptureMode::Local => "--native",
                CaptureMode::Virtual => "--virtual",
            }],
            false,
        )
        .await
    }
    /// Arguments are chosen inside the instance, never from an API input. Empty
    /// arguments run control-only mode for the shared adapter contract.
    pub async fn spawn_arguments(binary: &Path, arguments: &[&str]) -> anyhow::Result<Self> {
        Self::spawn_arguments_with_cursor(binary, arguments, true).await
    }
    async fn spawn_arguments_with_cursor(
        binary: &Path,
        arguments: &[&str],
        show_cursor: bool,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(!cfg!(windows), "REMOTE_DESKTOP_PLATFORM_UNSUPPORTED");
        anyhow::ensure!(binary.is_absolute(), "REMOTE_DESKTOP_PACKAGE_INVALID");
        let directory = tempfile::Builder::new()
            .prefix("th-desktop-host-")
            .tempdir_in(local_ipc::temporary_root())?;
        let nonce = secret();
        let endpoint =
            LocalIpcEndpoint::in_directory(directory.path(), "desktop", &nonce, "host.sock")?;
        endpoint.prepare()?;
        let mut listener = local_ipc::bind(&endpoint)?;
        let mut command = Process::new(binary);
        command.args(arguments).arg("--ipc").arg(endpoint.path());
        if !show_cursor {
            command.arg("--system-cursor");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let mut lifetime = child.stdin.take().expect("piped stdin");
        let connection = tokio::time::timeout(DEADLINE, async {
            let hello = Hello {
                protocol_version: IPC_VERSION.into(),
                nonce,
            };
            framing::write(&mut lifetime, &hello).await?;
            let mut stream = listener.accept().await?;
            let received: Hello = framing::read(&mut stream)
                .await?
                .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_IPC_CLOSED"))?;
            anyhow::ensure!(
                received.protocol_version == IPC_VERSION
                    && bool::from(received.nonce.as_bytes().ct_eq(hello.nonce.as_bytes())),
                "REMOTE_DESKTOP_IPC_AUTH_FAILED"
            );
            framing::write(&mut stream, &hello).await?;
            let welcome: Welcome = framing::read(&mut stream)
                .await?
                .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_IPC_CLOSED"))?;
            anyhow::ensure!(
                welcome.protocol_version == IPC_VERSION && !welcome.boot_id.is_empty(),
                "REMOTE_DESKTOP_IPC_INVALID"
            );
            anyhow::Ok((stream, welcome))
        })
        .await;
        let (stream, welcome) = match connection {
            Ok(Ok(connection)) => connection,
            _ => {
                drop(lifetime);
                let _ = child.kill().await;
                let _ = endpoint.cleanup();
                anyhow::bail!("REMOTE_DESKTOP_COMPONENT_START_FAILED");
            }
        };
        let (calls, rx) = mpsc::channel(32);
        let (events, _) = broadcast::channel(128);
        let (stopped_tx, stopped) = watch::channel(false);
        let host = Self {
            stopped,
            calls,
            events: events.clone(),
            boot_id: welcome.boot_id.clone(),
            capability: welcome.capability,
            fallback_url: welcome.fallback_url,
            fallback_token: welcome.fallback_token,
        };
        tokio::spawn(async move {
            let _ = serve(stream, rx, &events, &welcome.boot_id).await;
            drop(lifetime);
            if tokio::time::timeout(DEADLINE, child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
            let _ = endpoint.cleanup();
            drop(directory);
            let _ = stopped_tx.send(true);
        });
        Ok(host)
    }
    /// Lag means the consumer must obtain an authoritative snapshot again.
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }
    pub fn stopped(&self) -> watch::Receiver<bool> {
        self.stopped.clone()
    }
    pub fn is_closed(&self) -> bool {
        self.calls.is_closed()
    }
    pub async fn request(&self, request_id: &str, command: Command) -> anyhow::Result<Reply> {
        let (tx, rx) = oneshot::channel();
        self.calls
            .try_send(Call {
                request: Request {
                    request_id: request_id.into(),
                    boot_id: self.boot_id.clone(),
                    command,
                },
                result: tx,
            })
            .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_COMPONENT_UNAVAILABLE"))?;
        rx.await
            .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_COMPONENT_UNAVAILABLE"))?
    }
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        self.request(&secret(), Command::Shutdown).await?;
        let mut stopped = self.stopped.clone();
        tokio::time::timeout(
            DEADLINE + Duration::from_secs(1),
            stopped.wait_for(|done| *done),
        )
        .await??;
        Ok(())
    }
}
async fn serve(
    stream: LocalIpcStream,
    mut calls: mpsc::Receiver<Call>,
    events: &broadcast::Sender<SessionEvent>,
    boot_id: &str,
) -> anyhow::Result<()> {
    let (mut reader, mut writer) = tokio::io::split(stream);
    // Preserve partial reads across request/deadline select branches.
    let (packets_tx, mut packets) = mpsc::channel(128);
    let read_task = tokio::spawn(async move {
        while let Ok(Some(packet)) = framing::read::<Packet>(&mut reader).await {
            if packets_tx.send(packet).await.is_err() {
                break;
            }
        }
    });
    let result = async {
        let mut pending: Option<Call> = None;
        let mut deadline = tokio::time::Instant::now() + DEADLINE;
        loop { tokio::select! {
            // EOF follows all bytes already written by the component. Selecting
            // child.wait() here can discard a final shutdown response; reap only
            // after draining this private stream (the child cannot delegate it).
            _ = tokio::time::sleep_until(deadline), if pending.is_some() => anyhow::bail!("REMOTE_DESKTOP_IPC_TIMEOUT"),
            call = calls.recv(), if pending.is_none() => {
                let Some(call) = call else { return Ok(()); };
                tokio::time::timeout(DEADLINE, framing::write(&mut writer, &call.request)).await??;
                deadline = tokio::time::Instant::now() + DEADLINE;
                pending = Some(call);
            }
            packet = packets.recv() => match packet {
                Some(Packet::Event(event)) => {
                    anyhow::ensure!(event.boot_id == boot_id, "REMOTE_DESKTOP_IPC_INVALID"); let _ = events.send(event);
                }
                Some(Packet::Response(response)) => {
                    let call = pending.take().ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_IPC_INVALID"))?;
                    anyhow::ensure!(response.boot_id == boot_id && response.request_id == call.request.request_id, "REMOTE_DESKTOP_IPC_INVALID");
                    let shutdown = matches!(call.request.command, Command::Shutdown);
                    let _ = call.result.send(Ok(response.result));
                    if shutdown { return Ok(()); }
                }
                None => anyhow::bail!("REMOTE_DESKTOP_IPC_CLOSED"),
            }
        } }
    }.await;
    read_task.abort();
    let _ = read_task.await;
    result
}
fn secret() -> String {
    let mut bytes = [0; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
