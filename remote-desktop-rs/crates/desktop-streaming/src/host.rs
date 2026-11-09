//! Test-only child host. Reuses the existing cross-platform local IPC transport.
use crate::{contract::*, framing, session::secret};
use controlled_instance_core::local_ipc::{self, LocalIpcEndpoint, LocalIpcStream};
use std::{path::Path, process::Stdio, time::Duration};
use subtle::ConstantTimeEq;
use tokio::process::{Child, Command as Process};

pub struct TestHost {
    pub child: Child,
    pub stream: LocalIpcStream,
    pub welcome: Welcome,
    pub latest_event: Option<SessionEvent>,
    endpoint: LocalIpcEndpoint,
    pub(crate) _directory: tempfile::TempDir,
    // Keep stdin open: its EOF independently supervises parent death, even if a
    // host IPC frame is incomplete or the socket is inherited by another process.
    pub(crate) _lifetime: Option<tokio::process::ChildStdin>,
    #[cfg(target_os = "windows")]
    _job: crate::platform::windows_job::Job,
}
impl TestHost {
    pub async fn spawn(binary: &Path) -> anyhow::Result<Self> {
        Self::spawn_mode(binary, crate::capture::Mode::Control).await
    }
    pub async fn spawn_synthetic(binary: &Path) -> anyhow::Result<Self> {
        Self::spawn_mode(binary, crate::capture::Mode::Synthetic).await
    }
    pub async fn spawn_mode(binary: &Path, mode: crate::capture::Mode) -> anyhow::Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix("th-desktop-")
            .tempdir_in(local_ipc::temporary_root())?;
        let endpoint =
            LocalIpcEndpoint::in_directory(directory.path(), "desktop", &secret(), "host.sock")?;
        endpoint.prepare()?;
        let mut listener = local_ipc::bind(&endpoint)?;
        let nonce = secret();
        let mut process = Process::new(binary);
        #[cfg(target_os = "windows")]
        let job = crate::platform::windows_job::Job::new(true)?;
        match mode {
            crate::capture::Mode::Synthetic => {
                process.arg("--synthetic");
            }
            crate::capture::Mode::Local => {
                process.arg("--native");
            }
            crate::capture::Mode::Virtual => {
                process.arg("--virtual");
            }
            crate::capture::Mode::Control => {}
        }
        let mut child = process
            .arg("--ipc")
            .arg(endpoint.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        #[cfg(target_os = "windows")]
        job.assign(&mut child).await?;
        let mut lifetime = child.stdin.take().expect("piped stdin");
        framing::write(
            &mut lifetime,
            &Hello {
                protocol_version: IPC_VERSION.into(),
                nonce: nonce.clone(),
            },
        )
        .await?;
        let mut stream = tokio::time::timeout(Duration::from_secs(5), listener.accept()).await??;
        let hello: Hello = tokio::time::timeout(Duration::from_secs(5), framing::read(&mut stream))
            .await??
            .ok_or_else(|| anyhow::anyhow!("component closed handshake"))?;
        anyhow::ensure!(
            hello.protocol_version == IPC_VERSION
                && bool::from(hello.nonce.as_bytes().ct_eq(nonce.as_bytes())),
            "component authentication failed"
        );
        framing::write(
            &mut stream,
            &Hello {
                protocol_version: IPC_VERSION.into(),
                nonce,
            },
        )
        .await?;
        let welcome = tokio::time::timeout(Duration::from_secs(5), framing::read(&mut stream))
            .await??
            .ok_or_else(|| anyhow::anyhow!("component closed handshake"))?;
        Ok(Self {
            child,
            stream,
            welcome,
            latest_event: None,
            endpoint,
            _directory: directory,
            _lifetime: Some(lifetime),
            #[cfg(target_os = "windows")]
            _job: job,
        })
    }
    pub async fn request(&mut self, request_id: &str, command: Command) -> anyhow::Result<Reply> {
        framing::write(
            &mut self.stream,
            &Request {
                request_id: request_id.into(),
                boot_id: self.welcome.boot_id.clone(),
                command,
            },
        )
        .await?;
        loop {
            let packet: Packet =
                tokio::time::timeout(Duration::from_secs(5), framing::read(&mut self.stream))
                    .await??
                    .ok_or_else(|| anyhow::anyhow!("component closed IPC"))?;
            match packet {
                Packet::Event(event) => {
                    anyhow::ensure!(event.boot_id == self.welcome.boot_id, "event boot mismatch");
                    self.latest_event = Some(event);
                }
                Packet::Response(response) => {
                    anyhow::ensure!(
                        response.request_id == request_id
                            && response.boot_id == self.welcome.boot_id,
                        "response correlation mismatch"
                    );
                    return Ok(response.result);
                }
            }
        }
    }
    pub fn close_parent_lifetime(&mut self) {
        self._lifetime.take();
    }
    pub async fn shutdown(mut self) -> anyhow::Result<()> {
        let _ = self.request("shutdown", Command::Shutdown).await?;
        tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await??;
        self.endpoint.cleanup()?;
        Ok(())
    }
}

pub async fn serve(stream: LocalIpcStream) -> anyhow::Result<()> {
    crate::service::serve(stream, false).await
}
