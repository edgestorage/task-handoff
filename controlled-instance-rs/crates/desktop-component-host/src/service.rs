//! Serializes child ownership, never session authority. No automatic installation
//! or capture occurs on construction, config reads or enabling the component.
use crate::{
    contract::{Command, Reply, SessionEvent},
    host::{CaptureMode, ComponentHost},
    settings::DesktopSettings,
};
use controlled_instance_protocol::RemoteDesktopCapabilities;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::{
    io::AsyncReadExt,
    process::Command as ProcessCommand,
    sync::{broadcast, Mutex},
    time::timeout,
};

const NATIVE_PERMISSION_OUTPUT_LIMIT: usize = 64 * 1024;
const NATIVE_PERMISSION_COMMAND_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);
#[derive(Clone)]
pub struct DesktopPackage {
    pub binary: PathBuf,
    /// Installed artifact provenance. Component compatibility is owned only by
    /// the IPC protocol handshake; this version is never a gate or update trigger.
    pub version: String,
}
#[derive(Clone)]
pub enum DesktopEvent {
    Session(Box<SessionEvent>),
    Changed,
    ResnapshotRequired,
}
type UpdateFuture = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;
type UpdateRequest = Arc<dyn Fn() -> UpdateFuture + Send + Sync>;
#[derive(Clone)]
pub struct DesktopService {
    pub settings: DesktopSettings,
    data_dir: PathBuf,
    disposed: Arc<AtomicBool>,
    protocol_update_requested: Arc<AtomicBool>,
    mode: CaptureMode,
    installed: Arc<dyn Fn() -> anyhow::Result<Option<DesktopPackage>> + Send + Sync>,
    can_start: Arc<dyn Fn() -> bool + Send + Sync>,
    host: Arc<Mutex<Option<ComponentHost>>>,
    events: broadcast::Sender<DesktopEvent>,
    projected: Arc<std::sync::RwLock<Option<(String, RemoteDesktopCapabilities)>>>,
    request_update: Option<UpdateRequest>,
}
impl DesktopService {
    pub fn new(
        data_dir: &Path,
        mode: CaptureMode,
        installed: impl Fn() -> anyhow::Result<Option<DesktopPackage>> + Send + Sync + 'static,
        can_start: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        let (events, _) = broadcast::channel(128);
        Self {
            disposed: Arc::new(AtomicBool::new(false)),
            protocol_update_requested: Arc::new(AtomicBool::new(false)),
            settings: DesktopSettings::new(data_dir),
            data_dir: data_dir.to_path_buf(),
            mode,
            installed: Arc::new(installed),
            can_start: Arc::new(can_start),
            host: Arc::new(Mutex::new(None)),
            events,
            projected: Arc::new(std::sync::RwLock::new(None)),
            request_update: None,
        }
    }
    pub fn with_update_request(
        mut self,
        request: impl Fn() -> UpdateFuture + Send + Sync + 'static,
    ) -> Self {
        self.request_update = Some(Arc::new(request));
        self
    }
    pub async fn reconcile(&self) -> RemoteDesktopCapabilities {
        self.refresh().await
    }
    pub fn status(&self) -> RemoteDesktopCapabilities {
        let closed = |reason: &str| {
            let mut capability = RemoteDesktopCapabilities::unavailable(reason);
            capability.runtime_kind = if matches!(self.mode, CaptureMode::Virtual) {
                "docker"
            } else {
                "local"
            }
            .into();
            capability.platform = match std::env::consts::OS {
                "macos" => "darwin",
                other => other,
            }
            .into();
            capability.desktop_source = if matches!(self.mode, CaptureMode::Virtual) {
                "instance-virtual-display"
            } else {
                "host-desktop"
            }
            .into();
            capability
        };
        match (self.installed)() {
            Ok(Some(_)) => {}
            Ok(None) => return closed("REMOTE_DESKTOP_NOT_INSTALLED"),
            Err(_) => return closed("REMOTE_DESKTOP_PACKAGE_INVALID"),
        }
        if !self.settings.enabled() {
            return closed("REMOTE_DESKTOP_DISABLED");
        }
        if self.disposed.load(Ordering::SeqCst) || !(self.can_start)() {
            return closed("REMOTE_DESKTOP_UPDATING");
        }
        self.projected
            .read()
            .unwrap()
            .as_ref()
            .map(|(_, capability)| capability.clone())
            .unwrap_or_else(|| closed("REMOTE_DESKTOP_NOT_PROBED"))
    }
    /// Event/explicit-call driven preflight. Never starts a missing/disabled package.
    pub async fn refresh(&self) -> RemoteDesktopCapabilities {
        let status = self.status();
        if status.reason.as_deref().is_some_and(|reason| {
            matches!(
                reason,
                "REMOTE_DESKTOP_NOT_INSTALLED"
                    | "REMOTE_DESKTOP_PACKAGE_INVALID"
                    | "REMOTE_DESKTOP_DISABLED"
                    | "REMOTE_DESKTOP_UPDATING"
            )
        }) {
            let _ = self.events.send(DesktopEvent::Changed);
            return status;
        }
        let probe = self.request_bound("preflight", Command::Probe, None).await;
        if probe.is_ok() {
            self.protocol_update_requested
                .store(false, Ordering::SeqCst);
        }
        let status = self.status();
        self.maybe_request_protocol_update(&status);
        let _ = self.events.send(DesktopEvent::Changed);
        status
    }
    fn maybe_request_protocol_update(&self, status: &RemoteDesktopCapabilities) {
        if status.reason.as_deref() != Some("REMOTE_DESKTOP_PROTOCOL_MISMATCH") {
            return;
        }
        let Some(request) = self.request_update.clone() else {
            return;
        };
        if self.protocol_update_requested.swap(true, Ordering::SeqCst) {
            return;
        }
        // The App queue stops this service before changing package files. Do not
        // turn a capability projection into a nested lifecycle await.
        tokio::spawn(async move { request().await });
    }
    /// Called by the App event producer without reading its locked manager.
    pub fn package_operation_changed(&self) {
        let _ = self.events.send(DesktopEvent::Changed);
    }
    pub fn subscribe(&self) -> broadcast::Receiver<DesktopEvent> {
        self.events.subscribe()
    }
    pub async fn set_enabled(&self, enabled: bool) -> anyhow::Result<()> {
        let mut host = self.host.lock().await;
        anyhow::ensure!(
            !self.disposed.load(Ordering::SeqCst) && (self.can_start)(),
            "REMOTE_DESKTOP_UPDATING"
        );
        self.settings.set(enabled)?;
        if !enabled {
            Self::stop(&mut host).await?;
        }
        if !enabled {
            *self.projected.write().unwrap() = None;
        }
        drop(host);
        if enabled {
            self.reconcile().await;
        }
        let _ = self.events.send(DesktopEvent::Changed);
        Ok(())
    }
    /// Native TCC state belongs to the installed component binary, not to the
    /// running streaming host. A missing package stays distinguishable from a
    /// permission command that fails inside an installed component.
    pub async fn permissions(&self) -> anyhow::Result<Value> {
        if !cfg!(target_os = "macos") {
            return Ok(json!({
                "platform": std::env::consts::OS,
                "supported": false,
                "screenCapture": "unknown",
                "inputControl": "unknown",
            }));
        }
        let probe = self
            .run_native_permission_command("--check-native-permissions")
            .await?;
        let screen_capture = probe
            .get("screenCaptureAllowed")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"))?;
        let input_control = probe
            .get("inputAllowed")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"))?;
        Ok(json!({
            "platform": "darwin",
            "supported": true,
            "screenCapture": if screen_capture { "granted" } else { "required" },
            "inputControl": if input_control { "granted" } else { "required" },
        }))
    }
    pub async fn request_permission(&self, kind: &str) -> anyhow::Result<Value> {
        anyhow::ensure!(
            cfg!(target_os = "macos"),
            "REMOTE_DESKTOP_PERMISSIONS_UNSUPPORTED"
        );
        let argument = match kind {
            "screen-capture" => "--request-screen-permission",
            "input-control" => "--request-input-permission",
            _ => anyhow::bail!("REMOTE_DESKTOP_INVALID_REQUEST"),
        };
        let probe = self.run_native_permission_command(argument).await?;
        let field = if kind == "screen-capture" {
            "screenCaptureAllowed"
        } else {
            "inputAllowed"
        };
        anyhow::ensure!(
            probe.get(field).and_then(Value::as_bool).is_some(),
            "REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"
        );
        self.permissions().await
    }
    async fn run_native_permission_command(&self, argument: &str) -> anyhow::Result<Value> {
        let package = (self.installed)()
            .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_PACKAGE_INVALID"))?
            .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_NOT_INSTALLED"))?;
        let mut command = ProcessCommand::new(&package.binary);
        command
            .arg(argument)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"))?;
        let execution = async {
            let mut stdout = stdout.take((NATIVE_PERMISSION_OUTPUT_LIMIT + 1) as u64);
            let mut output = Vec::new();
            let (status, read) = tokio::join!(child.wait(), stdout.read_to_end(&mut output));
            Ok::<_, std::io::Error>((status?, read?, output))
        };
        let (status, read, output) = timeout(NATIVE_PERMISSION_COMMAND_DEADLINE, execution)
            .await
            .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"))??;
        anyhow::ensure!(
            status.success()
                && read <= NATIVE_PERMISSION_OUTPUT_LIMIT
                && output.len() <= NATIVE_PERMISSION_OUTPUT_LIMIT,
            "REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"
        );
        serde_json::from_slice(&output)
            .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"))
    }
    pub async fn request(&self, request_id: &str, command: Command) -> anyhow::Result<Reply> {
        self.request_bound(request_id, command, None)
            .await
            .map(|(_, reply)| reply)
    }
    pub async fn request_bound(
        &self,
        request_id: &str,
        command: Command,
        expected_boot: Option<&str>,
    ) -> anyhow::Result<(String, Reply)> {
        let mut host = self.host.lock().await;
        if let Some(boot) = expected_boot {
            let child = host
                .as_ref()
                .filter(|child| !child.is_closed() && child.boot_id == boot)
                .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_COMPONENT_UNAVAILABLE"))?;
            return Ok((
                child.boot_id.clone(),
                child.request(request_id, command).await?,
            ));
        }
        let package =
            (self.installed)()?.ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_NOT_INSTALLED"))?;
        anyhow::ensure!(self.settings.enabled(), "REMOTE_DESKTOP_DISABLED");
        anyhow::ensure!(
            !self.disposed.load(Ordering::SeqCst) && (self.can_start)(),
            "REMOTE_DESKTOP_UPDATING"
        );
        if host.as_ref().is_none_or(ComponentHost::is_closed) {
            let child = match ComponentHost::spawn_with_state_dir(
                &package.binary,
                self.mode,
                &self.data_dir,
            )
            .await
            {
                Ok(child) => child,
                Err(error) => {
                    let reason = if error.to_string() == "REMOTE_DESKTOP_PROTOCOL_MISMATCH" {
                        "REMOTE_DESKTOP_PROTOCOL_MISMATCH"
                    } else {
                        "REMOTE_DESKTOP_COMPONENT_START_FAILED"
                    };
                    *self.projected.write().unwrap() = Some((
                        String::new(),
                        RemoteDesktopCapabilities::unavailable(reason),
                    ));
                    return Err(error);
                }
            };
            if !(self.can_start)() || !self.settings.enabled() {
                let _ = child.shutdown().await;
                anyhow::bail!("REMOTE_DESKTOP_UPDATING");
            }
            *self.projected.write().unwrap() =
                Some((child.boot_id.clone(), child.capability.clone()));
            let projected = self.projected.clone();
            let boot = child.boot_id.clone();
            let mut events = child.subscribe();
            let mut stopped = child.stopped();
            let publish = self.events.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = stopped.wait_for(|done| *done) => {
                            let mut projection=projected.write().unwrap();
                            if projection.as_ref().is_some_and(|(current,_)|*current==boot){*projection=Some((boot.clone(),RemoteDesktopCapabilities::unavailable("REMOTE_DESKTOP_COMPONENT_UNAVAILABLE")));}
                            drop(projection);let _ = publish.send(DesktopEvent::Changed); break;
                        }
                        event = events.recv() => match event {
                            Ok(event) => { let _ = publish.send(DesktopEvent::Session(Box::new(event))); }
                            // A missing event must close the downstream subscription;
                            // callers recover by HTTP snapshot, never fabricated state.
                            Err(broadcast::error::RecvError::Lagged(_)) => { let _ = publish.send(DesktopEvent::ResnapshotRequired); }
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }
            });
            *host = Some(child);
            let _ = self.events.send(DesktopEvent::Changed);
        }
        let child = host.as_ref().expect("started host");
        let reply = match child.request(request_id, command).await {
            Ok(reply) => reply,
            Err(error) => {
                *self.projected.write().unwrap() = Some((
                    child.boot_id.clone(),
                    RemoteDesktopCapabilities::unavailable("REMOTE_DESKTOP_COMPONENT_UNAVAILABLE"),
                ));
                let _ = self.events.send(DesktopEvent::Changed);
                return Err(error);
            }
        };
        if let Reply::Capability { capability } = &reply {
            *self.projected.write().unwrap() =
                Some((child.boot_id.clone(), capability.as_ref().clone()));
        }
        Ok((child.boot_id.clone(), reply))
    }
    /// Loopback fallback endpoint and process-scoped bearer. Returns unavailable
    /// when no component is running; callers must never start capture implicitly.
    pub async fn fallback_endpoint(&self) -> anyhow::Result<Option<(String, String)>> {
        let host = self.host.lock().await;
        Ok(host.as_ref().and_then(|host| {
            (!host.fallback_url.is_empty() && !host.fallback_token.is_empty())
                .then(|| (host.fallback_url.clone(), host.fallback_token.clone()))
        }))
    }
    pub async fn is_current_boot(&self, boot: &str) -> bool {
        self.host
            .lock()
            .await
            .as_ref()
            .is_some_and(|host| !host.is_closed() && host.boot_id == boot)
    }
    pub async fn before_package_change(&self) -> anyhow::Result<()> {
        let mut host = self.host.lock().await;
        Self::stop(&mut host).await?;
        *self.projected.write().unwrap() = None;
        let _ = self.events.send(DesktopEvent::Changed);
        Ok(())
    }
    pub async fn package_changed(&self, uninstall_succeeded: bool) -> anyhow::Result<()> {
        let _host = self.host.lock().await;
        self.protocol_update_requested
            .store(false, Ordering::SeqCst);
        if uninstall_succeeded {
            self.settings.clear()?;
        }
        let _ = self.events.send(DesktopEvent::Changed);
        Ok(())
    }
    pub async fn close(&self) -> anyhow::Result<()> {
        self.disposed.store(true, Ordering::SeqCst);
        let mut host = self.host.lock().await;
        Self::stop(&mut host).await?;
        *self.projected.write().unwrap() = None;
        let _ = self.events.send(DesktopEvent::Changed);
        Ok(())
    }
    async fn stop(host: &mut Option<ComponentHost>) -> anyhow::Result<()> {
        if let Some(child) = host.take() {
            let shutdown = if !child.is_closed() {
                child.shutdown().await
            } else {
                Ok(())
            };
            let mut stopped = child.stopped();
            tokio::time::timeout(
                std::time::Duration::from_secs(6),
                stopped.wait_for(|done| *done),
            )
            .await??;
            shutdown?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Owner;
    #[tokio::test]
    async fn package_metadata_version_never_requests_update_or_gates_use() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let present = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let installed = present.clone();
        let called = requests.clone();
        let service = DesktopService::new(
            dir.path(),
            CaptureMode::Local,
            move || {
                Ok(installed.load(Ordering::SeqCst).then(|| DesktopPackage {
                    binary: "/must-not-execute".into(),
                    version: "old".into(),
                }))
            },
            || true,
        )
        .with_update_request(move || {
            called.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {})
        });
        service.reconcile().await;
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        present.store(true, Ordering::SeqCst);
        assert_eq!(
            service.reconcile().await.reason.as_deref(),
            Some("REMOTE_DESKTOP_DISABLED")
        );
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        service.refresh().await;
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        service.reconcile().await;
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        service.settings.set(true).unwrap();
        assert_eq!(
            service.status().reason.as_deref(),
            Some("REMOTE_DESKTOP_NOT_PROBED")
        );
        assert!(service.host.lock().await.is_none());
        service.close().await.unwrap();
        service.reconcile().await;
        assert_eq!(requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn protocol_mismatch_requests_update_once_until_package_changes() {
        let dir = tempfile::tempdir().unwrap();
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let called = requests.clone();
        let service = DesktopService::new(dir.path(), CaptureMode::Local, || Ok(None), || true)
            .with_update_request(move || {
                called.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {})
            });
        let mismatch = RemoteDesktopCapabilities::unavailable("REMOTE_DESKTOP_PROTOCOL_MISMATCH");
        service.maybe_request_protocol_update(&mismatch);
        service.maybe_request_protocol_update(&mismatch);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        service.package_changed(false).await.unwrap();
        service.maybe_request_protocol_update(&mismatch);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn absence_disabled_uninstall_and_close_never_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let installed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let package_present = installed.clone();
        let service = DesktopService::new(
            dir.path(),
            CaptureMode::Local,
            move || {
                Ok(package_present
                    .load(std::sync::atomic::Ordering::SeqCst)
                    .then(|| DesktopPackage {
                        binary: "/must-not-be-executed".into(),
                        version: "1".into(),
                    }))
            },
            || true,
        );
        let command = || Command::ListSources {
            owner: Owner {
                actor_id: "actor".into(),
                device_session_id: "device".into(),
            },
        };
        assert_eq!(
            service
                .request("r", command())
                .await
                .err()
                .unwrap()
                .to_string(),
            "REMOTE_DESKTOP_NOT_INSTALLED"
        );
        installed.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            service
                .request("r", command())
                .await
                .err()
                .unwrap()
                .to_string(),
            "REMOTE_DESKTOP_DISABLED"
        );
        service.set_enabled(true).await.unwrap();
        service.package_changed(false).await.unwrap();
        assert!(service.settings.enabled());
        service.package_changed(true).await.unwrap();
        assert!(!service.settings.enabled());
        service.set_enabled(true).await.unwrap();
        service.close().await.unwrap();
        assert_eq!(
            service
                .request("r", command())
                .await
                .err()
                .unwrap()
                .to_string(),
            "REMOTE_DESKTOP_UPDATING"
        );
        assert!(service.set_enabled(true).await.is_err());
        assert!(service.host.lock().await.is_none());
    }
}
