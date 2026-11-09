//! Serializes child ownership, never session authority. No automatic installation
//! or capture occurs on construction, config reads or enabling the component.
use crate::{
    contract::{Command, Reply, SessionEvent},
    host::{CaptureMode, ComponentHost},
    settings::DesktopSettings,
};
use controlled_instance_protocol::RemoteDesktopCapabilities;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{broadcast, Mutex};
#[derive(Clone)]
pub struct DesktopPackage {
    pub binary: PathBuf,
    pub version: String,
}
#[derive(Clone)]
pub enum DesktopEvent {
    Session(SessionEvent),
    Changed,
    ResnapshotRequired,
}
type UpdateFuture = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;
type UpdateRequest = Arc<dyn Fn() -> UpdateFuture + Send + Sync>;
#[derive(Clone)]
pub struct DesktopService {
    pub settings: DesktopSettings,
    disposed: Arc<std::sync::atomic::AtomicBool>,
    version: String,
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
        version: String,
        mode: CaptureMode,
        installed: impl Fn() -> anyhow::Result<Option<DesktopPackage>> + Send + Sync + 'static,
        can_start: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        let (events, _) = broadcast::channel(128);
        Self {
            disposed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            settings: DesktopSettings::new(data_dir),
            version,
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
        if !self.disposed.load(std::sync::atomic::Ordering::SeqCst)
            && (self.can_start)()
            && (self.installed)()
                .ok()
                .flatten()
                .is_some_and(|package| package.version != self.version)
        {
            if let Some(request) = &self.request_update {
                request().await;
            }
        }
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
        let package = match (self.installed)() {
            Ok(Some(package)) => package,
            Ok(None) => return closed("REMOTE_DESKTOP_NOT_INSTALLED"),
            Err(_) => return closed("REMOTE_DESKTOP_PACKAGE_INVALID"),
        };
        if !self.settings.enabled() {
            return closed("REMOTE_DESKTOP_DISABLED");
        }
        if self.disposed.load(std::sync::atomic::Ordering::SeqCst) || !(self.can_start)() {
            return closed("REMOTE_DESKTOP_UPDATING");
        }
        if package.version != self.version {
            return closed("REMOTE_DESKTOP_VERSION_MISMATCH");
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
                    | "REMOTE_DESKTOP_VERSION_MISMATCH"
            )
        }) {
            let _ = self.events.send(DesktopEvent::Changed);
            return status;
        }
        let _ = self.request_bound("preflight", Command::Probe, None).await;
        let _ = self.events.send(DesktopEvent::Changed);
        self.status()
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
            !self.disposed.load(std::sync::atomic::Ordering::SeqCst) && (self.can_start)(),
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
            !self.disposed.load(std::sync::atomic::Ordering::SeqCst) && (self.can_start)(),
            "REMOTE_DESKTOP_UPDATING"
        );
        anyhow::ensure!(
            package.version == self.version,
            "REMOTE_DESKTOP_VERSION_MISMATCH"
        );
        if host.as_ref().is_none_or(ComponentHost::is_closed) {
            let child = match ComponentHost::spawn(&package.binary, self.mode).await {
                Ok(child) => child,
                Err(error) => {
                    *self.projected.write().unwrap() = Some((
                        String::new(),
                        RemoteDesktopCapabilities::unavailable(
                            "REMOTE_DESKTOP_COMPONENT_START_FAILED",
                        ),
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
                            Ok(event) => { let _ = publish.send(DesktopEvent::Session(event)); }
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
        if uninstall_succeeded {
            self.settings.clear()?;
        }
        let _ = self.events.send(DesktopEvent::Changed);
        Ok(())
    }
    pub async fn close(&self) -> anyhow::Result<()> {
        self.disposed
            .store(true, std::sync::atomic::Ordering::SeqCst);
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
    async fn disabled_mismatch_reconciles_only_on_explicit_request_and_never_installs_absence() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let present = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let installed = present.clone();
        let called = requests.clone();
        let service = DesktopService::new(
            dir.path(),
            "current".into(),
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
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        service.refresh().await;
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        service.reconcile().await;
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        assert!(service.host.lock().await.is_none());
        service.close().await.unwrap();
        service.reconcile().await;
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn absence_disabled_uninstall_and_close_never_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let installed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let package_present = installed.clone();
        let service = DesktopService::new(
            dir.path(),
            "1".into(),
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
        let command = || Command::ListWindows {
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
