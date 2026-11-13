//! Single actor owns session authority and applies effects before publishing events.
use crate::{
    channel::{Channel, Clipboard, Control, Decoder, Message},
    contract::*,
    fallback_server::{AttachReply, FallbackEvent},
    framing,
    media::{MediaControl, MediaPeer, PeerEvent},
    session::{Effects, Owner, Phase, Registry},
};
use controlled_instance_core::local_ipc::LocalIpcStream;
use remote_desktop_protocol::fallback::Role;
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tokio::{sync::mpsc, task::JoinSet};
use webrtc::data_channel::DataChannel;

struct FallbackRuntime {
    viewer: String,
    media: Option<mpsc::Sender<remote_desktop_protocol::fallback::EncodedFrame>>,
    control: Option<mpsc::Sender<String>>,
    media_started: bool,
    active: bool,
}

struct LivePeer {
    id: String,
    owner: Owner,
    input_backend: Option<crate::input_guard::Backend>,
    peer: MediaPeer,
    control: Arc<MediaControl>,
    channels: HashMap<Channel, Arc<dyn DataChannel>>,
    decoder: Decoder,
    reply_seq: u64,
    clipboard_enabled: bool,
    clipboard: String,
    native_clipboard: Option<crate::clipboard::Client>,
    ice_expires_at: Option<Instant>,
    pending_ice_expires_at: Option<Instant>,
    ice_restart_pending: bool,
    fallback_generation: Option<String>,
    fallback_active: bool,
    fallback_control: Option<mpsc::Sender<String>>,
    webrtc_connected: bool,
}
impl LivePeer {
    async fn reply(&mut self, kind: Channel, message: serde_json::Value) -> anyhow::Result<()> {
        self.reply_seq += 1;
        let mut envelope = message;
        envelope["v"] = CHANNEL_VERSION.into();
        envelope["seq"] = self.reply_seq.into();
        let text = serde_json::to_string(&envelope)?;
        anyhow::ensure!(
            text.len()
                <= if kind == Channel::Clipboard {
                    crate::channel::MAX_CLIPBOARD_WIRE
                } else {
                    crate::channel::MAX_MESSAGE
                },
            "reply too large"
        );
        if let Some(control) = &self.fallback_control {
            tokio::time::timeout(Duration::from_millis(100), control.send(text)).await??;
            return Ok(());
        }
        let Some(dc) = self.channels.get(&kind) else {
            return Ok(());
        };
        tokio::time::timeout(Duration::from_millis(100), dc.try_send_text(&text)).await??;
        Ok(())
    }
}
struct Service {
    registry: Registry,
    live: HashMap<String, LivePeer>,
    input_guard: Option<crate::input_guard::Client>,
    input_guard_backend: Option<crate::input_guard::Backend>,
    mode: crate::capture::Mode,
    show_cursor: bool,
    source_salt: String,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    catalog: Option<crate::platform::window::WindowCatalog>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    display_catalog: Option<crate::platform::display::DisplayCatalog>,
    pending_source: HashMap<String, crate::capture::Source>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    selected_source: HashMap<String, (String, crate::platform::display::SourceTarget)>,
    #[cfg(target_os = "linux")]
    surface: Option<crate::surface::Client>,
    events: mpsc::Sender<PeerEvent>,
    fallbacks: HashMap<String, FallbackRuntime>,
}
impl Service {
    fn window_mode_supported(mode: crate::capture::Mode) -> bool {
        #[cfg(target_os = "macos")]
        {
            mode == crate::capture::Mode::Local
        }
        #[cfg(target_os = "linux")]
        {
            matches!(
                mode,
                crate::capture::Mode::Local | crate::capture::Mode::Virtual
            )
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = mode;
            false
        }
    }
    #[cfg(target_os = "linux")]
    async fn ensure_surface(&mut self) -> anyhow::Result<()> {
        if self.surface.is_none() {
            self.surface = Some(crate::surface::Client::spawn(&component_executable()?).await?);
        }
        Ok(())
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    async fn source_catalogs(
        &mut self,
    ) -> anyhow::Result<(
        &mut crate::platform::window::WindowCatalog,
        &mut crate::platform::display::DisplayCatalog,
    )> {
        if self.catalog.is_none() {
            anyhow::ensure!(
                Self::window_mode_supported(self.mode),
                crate::error::BackendError::WindowUnsupported
            );
            #[cfg(target_os = "macos")]
            {
                self.catalog = Some(crate::platform::window::WindowCatalog::with_source_salt(
                    self.source_salt.clone(),
                ));
                self.display_catalog =
                    Some(crate::platform::display::DisplayCatalog::with_source_salt(
                        self.source_salt.clone(),
                    ));
            }
            #[cfg(target_os = "linux")]
            {
                let mut config = if self.mode == crate::capture::Mode::Virtual {
                    self.ensure_surface().await?;
                    self.surface.as_ref().unwrap().config()
                } else {
                    crate::platform::linux::Config::environment(self.show_cursor)?
                };
                config.include_cursor = self.show_cursor;
                self.catalog = Some(crate::platform::window::WindowCatalog::Linux(
                    crate::platform::linux::WindowCatalog::with_source_salt(
                        config.clone(),
                        self.source_salt.clone(),
                    ),
                ));
                self.display_catalog =
                    Some(crate::platform::display::DisplayCatalog::with_source_salt(
                        config,
                        self.source_salt.clone(),
                    ));
            }
        } else if self.display_catalog.is_none() {
            anyhow::bail!(crate::error::BackendError::DesktopUnavailable);
        }
        Ok((
            self.catalog.as_mut().unwrap(),
            self.display_catalog.as_mut().unwrap(),
        ))
    }
    async fn resolve_source_target(
        &mut self,
        source_ref: &str,
        owner: &Owner,
    ) -> anyhow::Result<crate::platform::display::SourceTarget> {
        let (windows, displays) = self.source_catalogs().await?;
        match displays.consume(source_ref, owner).await {
            Ok(target) => Ok(crate::platform::display::SourceTarget::Display(target)),
            Err(error)
                if matches!(
                    error.downcast_ref::<crate::catalog::CatalogError>(),
                    Some(crate::catalog::CatalogError::InvalidReference)
                ) =>
            {
                Ok(crate::platform::display::SourceTarget::Window(
                    windows.consume(source_ref, owner).await?,
                ))
            }
            Err(error) => Err(error),
        }
    }
    fn input_environment(&self) -> (Option<String>, Option<std::path::PathBuf>) {
        #[cfg(target_os = "linux")]
        if let Some(surface) = &self.surface {
            return (
                Some(surface.ready.display.clone()),
                Some(surface.ready.authority.clone()),
            );
        }
        (
            std::env::var("DISPLAY").ok(),
            std::env::var_os("XAUTHORITY").map(Into::into),
        )
    }
    async fn effects(&mut self, id: &str, effects: Effects) {
        if effects.close_peer {
            self.pending_source.remove(id);
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                self.selected_source.remove(id);
            }
        }
        let mut close_peer = effects.close_peer;
        if effects.release_input {
            if let Some(guard) = self.input_guard.as_mut() {
                if guard
                    .call(&crate::input_guard::Command::Suspend)
                    .await
                    .is_err()
                {
                    close_peer = true;
                    let _ = self.registry.peer_failed(id, Instant::now());
                }
            }
            if let Some(live) = self.live.get_mut(id) {
                live.control.input.lock().unwrap().release_all();
            }
        }
        if let Some(live) = self.live.get_mut(id) {
            if effects.request_idr {
                live.control.idr.store(true, Ordering::SeqCst);
            }
            if let Ok(snapshot) = self.registry.snapshot(&live.id, &live.owner) {
                live.control.pause(snapshot.media_paused);
            }
        }
        if close_peer {
            if let Some(live) = self.live.remove(id) {
                live.control.input.lock().unwrap().release_all();
                live.peer.close().await;
                let _ = self.registry.drained(id);
            } else {
                // Starting or negotiating sessions may not have a peer yet. Once
                // their reservation is closed there is nothing to drain, so do
                // not leave a Draining record occupying a viewer slot.
                let _ = self.registry.drained(id);
            }
            if self.live.is_empty() {
                if let Some(guard) = self.input_guard.take() {
                    let _ = guard.close().await;
                }
                self.input_guard_backend = None;
            }
        }
    }
    async fn fail(&mut self, id: &str) {
        if let Ok(effects) = self.registry.peer_failed(id, Instant::now()) {
            self.effects(id, effects).await;
        }
    }
    async fn fail_backend(&mut self, id: &str, cause: crate::error::BackendError) {
        let had_live = self.live.contains_key(id);
        if let Ok(effects) = self.registry.backend_failed(id, cause, Instant::now()) {
            self.effects(id, effects).await;
            // Failed construction owns no live peer/guard. Its resources have
            // already been dropped, so do not hold the slot for a drain timeout.
            if !had_live {
                let _ = self.registry.drained(id);
            }
        }
    }
    fn fallback_channel(bytes: &[u8]) -> Option<Channel> {
        let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
        let kind = value.get("type")?.as_str()?;
        Some(match kind {
            "control.request" | "input.resume" | "input.suspend" | "input.alive" | "visibility"
            | "stream.keyframe" | "stream.resolution" | "session.stop" | "clipboard.enable"
            | "transport.upgrade" => Channel::Control,
            "key" | "button" | "wheel" | "text.commit" => Channel::Input,
            "pointer" => Channel::Pointer,
            "clipboard.write" | "clipboard.read" => Channel::Clipboard,
            _ => return None,
        })
    }
    async fn fallback_event(&mut self, event: FallbackEvent) -> anyhow::Result<()> {
        match event {
            FallbackEvent::Attach {
                role,
                generation,
                viewer,
                owner,
                capture_selection,
                media,
                control,
                reply,
            } => {
                let Some(live) = self.live.get_mut(&viewer) else {
                    let _ = reply.send(Err("REMOTE_DESKTOP_NOT_FOUND"));
                    return Ok(());
                };
                if live.owner != owner {
                    let _ = reply.send(Err("REMOTE_DESKTOP_UNAUTHORIZED"));
                    return Ok(());
                }
                if self.registry.snapshot(&viewer, &owner)?.capture_selection != capture_selection {
                    let _ = reply.send(Err("REMOTE_DESKTOP_FALLBACK_TARGET"));
                    return Ok(());
                }
                if live
                    .fallback_generation
                    .as_deref()
                    .is_some_and(|current| current != generation)
                {
                    let _ = reply.send(Err("REMOTE_DESKTOP_FALLBACK_STALE"));
                    return Ok(());
                }
                let pair =
                    self.fallbacks
                        .entry(generation.clone())
                        .or_insert_with(|| FallbackRuntime {
                            viewer: viewer.clone(),
                            media: None,
                            control: None,
                            media_started: false,
                            active: false,
                        });
                if pair.viewer != viewer {
                    let _ = reply.send(Err("REMOTE_DESKTOP_FALLBACK_CONFLICT"));
                    return Ok(());
                }
                match role {
                    Role::Media if pair.media.is_none() => pair.media = media,
                    Role::Control if pair.control.is_none() => pair.control = control,
                    _ => {
                        let _ = reply.send(Err("REMOTE_DESKTOP_FALLBACK_DUPLICATE"));
                        return Ok(());
                    }
                }
                let geometry = self
                    .registry
                    .snapshot(&viewer, &owner)?
                    .capture_geometry
                    .unwrap_or(crate::session::CaptureGeometry {
                        width: 1280,
                        height: 720,
                    });
                let budget = crate::video::Budget::select_with_limits_and_resolution(
                    geometry.width,
                    geometry.height,
                    crate::video::INITIAL_BITRATE,
                    crate::video::FALLBACK_LIMITS,
                    Some((
                        crate::video::FALLBACK_MAX_WIDTH,
                        crate::video::FALLBACK_MAX_HEIGHT,
                    )),
                );
                let _ = reply.send(Ok(AttachReply {
                    width: budget.width,
                    height: budget.height,
                    fps: budget.fps,
                    bitrate: crate::video::INITIAL_BITRATE,
                    codec: live.control.video_codec(),
                }));
                self.activate_fallback(&generation).await?;
            }
            FallbackEvent::MediaStarted { generation } => {
                if let Some(pair) = self.fallbacks.get_mut(&generation) {
                    pair.media_started = true;
                }
                self.send_fallback_ready(&generation).await?;
            }
            FallbackEvent::Keyframe { generation } => {
                if let Some(pair) = self.fallbacks.get(&generation) {
                    if let Some(live) = self.live.get_mut(&pair.viewer) {
                        live.control.idr.store(true, Ordering::SeqCst);
                    }
                }
            }
            FallbackEvent::ControlMessage {
                generation,
                bytes,
                received,
            } => {
                let Some(pair) = self.fallbacks.get(&generation).filter(|pair| pair.active) else {
                    return Ok(());
                };
                let viewer = pair.viewer.clone();
                let Some(kind) = Self::fallback_channel(&bytes) else {
                    return Ok(());
                };
                if received.elapsed() > Duration::from_millis(100) && kind != Channel::Pointer {
                    let effects = self.registry.suspend_input(&viewer)?;
                    self.effects(&viewer, effects).await;
                    return Ok(());
                }
                let Some(Ok((message, _warning))) = self
                    .live
                    .get_mut(&viewer)
                    .map(|live| live.decoder.decode(kind, &bytes))
                else {
                    return Ok(());
                };
                self.message(viewer, message, None).await?;
            }
            FallbackEvent::Detach { role, generation } => {
                self.detach_fallback(role, &generation).await?;
            }
        }
        Ok(())
    }
    async fn activate_fallback(&mut self, generation: &str) -> anyhow::Result<()> {
        let Some(pair) = self.fallbacks.get_mut(generation) else {
            return Ok(());
        };
        if pair.active || pair.media.is_none() || pair.control.is_none() {
            return Ok(());
        }
        let viewer = pair.viewer.clone();
        let media = pair.media.clone().unwrap();
        let control = pair.control.clone().unwrap();
        pair.active = true;
        let events = self.events.clone();
        let owner = {
            let Some(live) = self.live.get_mut(&viewer) else {
                return Ok(());
            };
            live.fallback_generation = Some(generation.into());
            live.fallback_active = true;
            live.fallback_control = Some(control);
            let fallback_limit = live.control.resolution_limit().map_or(
                (
                    crate::video::FALLBACK_MAX_WIDTH,
                    crate::video::FALLBACK_MAX_HEIGHT,
                ),
                |(width, height)| {
                    (
                        width.min(crate::video::FALLBACK_MAX_WIDTH),
                        height.min(crate::video::FALLBACK_MAX_HEIGHT),
                    )
                },
            );
            let fallback_frame_rate = live
                .control
                .frame_rate_limit()
                .map_or(crate::video::FALLBACK_MAX_FRAME_RATE, |frame_rate| {
                    frame_rate.min(crate::video::FALLBACK_MAX_FRAME_RATE)
                });
            live.control
                .set_stream_limits(Some(fallback_limit), Some(fallback_frame_rate));
            live.control.ensure_fallback_format();
            live.control.set_fallback(Some(media));
            live.control.pause(false);
            live.control.idr.store(true, Ordering::SeqCst);
            // WebRTC may never have reached Connected. The fallback path owns
            // the same capture/encode loop and must start it explicitly.
            live.peer.start(viewer.clone(), events).await?;
            live.owner.clone()
        };
        self.registry.fallback_activated(&viewer)?;
        // Keep the peer connection and data channels alive. WebRTC keeps
        // negotiating and sending the same encoded frames in the background;
        // the browser promotes it after decoding a real video frame.
        if let Ok(snapshot) = self.registry.snapshot(&viewer, &owner) {
            if snapshot.input_epoch.is_some() {
                let effects = self.registry.suspend_input(&viewer)?;
                self.effects(&viewer, effects).await;
            }
        }
        self.send_fallback_ready(generation).await
    }
    async fn upgrade_transport(&mut self, id: &str) -> anyhow::Result<()> {
        let (active, connected, generation, control) = {
            let Some(live) = self.live.get(id) else {
                return Ok(());
            };
            (
                live.fallback_active,
                live.webrtc_connected,
                live.fallback_generation.clone(),
                live.fallback_control.clone(),
            )
        };
        if !active {
            return Ok(());
        }
        if !connected {
            if let Some(control) = control {
                let text = serde_json::to_string(&serde_json::json!({
                    "type":"error",
                    "payload":{"code":"REMOTE_DESKTOP_WEBRTC_NOT_READY"}
                }))?;
                let _ = tokio::time::timeout(Duration::from_millis(100), control.send(text)).await;
            }
            return Ok(());
        }
        let effects = self.registry.webrtc_upgraded(id)?;
        self.effects(id, effects).await;
        if let Some(control) = control {
            let text = serde_json::to_string(&serde_json::json!({
                "type":"transport.upgraded",
                "payload":{"transport":"webrtc"}
            }))?;
            let _ = tokio::time::timeout(Duration::from_millis(100), control.send(text)).await;
        }
        if let Some(live) = self.live.get_mut(id) {
            live.fallback_active = false;
            live.fallback_generation = None;
            live.fallback_control = None;
            live.control.set_fallback(None);
            live.control.set_webrtc_ready(true);
            // The browser re-applies its explicit resolution preset after the
            // upgrade. Clearing the fallback cap restores auto/full quality.
            live.control.set_stream_limits(None, None);
            live.control.pause(false);
            live.control.idr.store(true, Ordering::SeqCst);
            live.control
                .pacing
                .request_idr
                .store(true, Ordering::SeqCst);
        }
        if let Some(generation) = generation {
            // Dropping both senders ends the fallback WebSockets and releases
            // the control-plane capacity slot without touching the session.
            self.fallbacks.remove(&generation);
        }
        Ok(())
    }
    async fn send_fallback_ready(&mut self, generation: &str) -> anyhow::Result<()> {
        let Some(pair) = self.fallbacks.get(generation) else {
            return Ok(());
        };
        if !pair.active || !pair.media_started {
            return Ok(());
        }
        let Some(control) = pair.control.clone() else {
            return Ok(());
        };
        let text = serde_json::to_string(&serde_json::json!({
            "type":"fallback.ready",
            "payload":{"fallbackGeneration":generation}
        }))?;
        let _ = tokio::time::timeout(Duration::from_millis(100), control.send(text)).await;
        Ok(())
    }
    async fn detach_fallback(&mut self, _role: Role, generation: &str) -> anyhow::Result<()> {
        let Some(pair) = self.fallbacks.remove(generation) else {
            return Ok(());
        };
        let viewer = pair.viewer;
        if let Some(live) = self.live.get_mut(&viewer) {
            if live.fallback_generation.as_deref() == Some(generation) {
                live.fallback_generation = None;
                live.fallback_control = None;
                live.control.set_fallback(None);
                // Keep the session sticky but pause the shared encoder during the
                // bounded reconnect window; never fall through to the closed
                // WebRTC track.
                live.control.pause(true);
                if let Ok(snapshot) = self.registry.snapshot(&viewer, &live.owner.clone()) {
                    if snapshot.input_epoch.is_some() {
                        let effects = self.registry.suspend_input(&viewer)?;
                        self.effects(&viewer, effects).await;
                    }
                }
            }
        }
        Ok(())
    }
    async fn command(&mut self, request: &Request) -> Reply {
        if request.boot_id != self.registry.boot_id() {
            return Reply::Error {
                code: "REMOTE_DESKTOP_STALE_BOOT".into(),
            };
        }
        if request.request_id.is_empty() || request.request_id.len() > 128 {
            return Reply::Error {
                code: "REMOTE_DESKTOP_INVALID_REQUEST".into(),
            };
        }
        let result = self.execute(request).await;
        result.unwrap_or_else(|_| Reply::Error {
            code: "REMOTE_DESKTOP_OPERATION_FAILED".into(),
        })
    }
    async fn execute(&mut self, r: &Request) -> anyhow::Result<Reply> {
        let now = Instant::now();
        // Registry errors are stable, redacted codes. Transport/library details
        // never become a response body (they can contain SDP/candidates).
        macro_rules! authority {
            ($expr:expr) => {
                match $expr {
                    Ok(v) => v,
                    Err(e) => {
                        return Ok(Reply::Error {
                            code: e.to_string(),
                        })
                    }
                }
            };
        }
        Ok(match &r.command {
            Command::ListSources { owner } => {
                // Enumeration is an on-demand catalog read, not a viewer
                // reservation. Active viewers may need it to switch scope.
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                {
                    let (windows, displays) = match self.source_catalogs().await {
                        Ok(catalogs) => catalogs,
                        Err(error) => {
                            return Ok(Reply::Error {
                                code: crate::error::BackendError::from_error(&error).to_string(),
                            });
                        }
                    };
                    let mut sources = match displays.enumerate(owner.clone()).await {
                        Ok(sources) => sources,
                        Err(error) => {
                            return Ok(Reply::Error {
                                code: crate::error::BackendError::from_error(&error).to_string(),
                            })
                        }
                    };
                    match windows.enumerate(owner.clone()).await {
                        Ok(mut windows) => sources.append(&mut windows),
                        Err(_) if sources.is_empty() => {
                            return Ok(Reply::Error {
                                code: crate::error::BackendError::WindowUnsupported.to_string(),
                            })
                        }
                        Err(_) => {}
                    }
                    return Ok(Reply::Sources { sources });
                }
                #[allow(unreachable_code)]
                let _ = owner;
                Reply::Error {
                    code: crate::error::BackendError::PlatformUnsupported.to_string(),
                }
            }
            Command::Probe => Reply::Capability {
                capability: Box::new(crate::preflight::probe(self.mode, self.show_cursor)),
            },
            Command::Metrics {
                owner,
                viewer_session_id,
            } => {
                authority!(self.registry.snapshot(viewer_session_id, owner));
                match self.live.get(viewer_session_id) {
                    Some(live) => Reply::Metrics {
                        metrics: live.peer.metrics(),
                    },
                    None => Reply::Error {
                        code: "REMOTE_DESKTOP_INVALID_STATE".into(),
                    },
                }
            }
            Command::Reserve {
                owner,
                capture_selection,
            }
            | Command::Takeover {
                owner,
                capture_selection,
                ..
            } => {
                let takeover = match &r.command {
                    Command::Takeover {
                        viewer_session_id, ..
                    } => Some(viewer_session_id.as_str()),
                    _ => None,
                };
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                let prepared = if self.mode == crate::capture::Mode::Control {
                    None
                } else if self.mode == crate::capture::Mode::Synthetic {
                    Some((None, crate::capture::Source::Synthetic))
                } else {
                    let retained = takeover.and_then(|viewer_session_id| {
                        self.selected_source
                            .get(viewer_session_id)
                            .filter(|(reference, _)| reference == &capture_selection.source_ref)
                            .map(|(_, target)| target.clone())
                    });
                    let target = match retained {
                        Some(target) => target,
                        None => match self
                            .resolve_source_target(&capture_selection.source_ref, owner)
                            .await
                        {
                            Ok(target) => target,
                            Err(error) => {
                                return Ok(Reply::Error {
                                    code: crate::error::BackendError::from_error(&error)
                                        .to_string(),
                                });
                            }
                        },
                    };
                    match target.source(self.show_cursor) {
                        Ok(mut source) => {
                            if let Err(error) = source.refresh_geometry() {
                                return Ok(Reply::Error {
                                    code: crate::error::BackendError::from_error(&error)
                                        .to_string(),
                                });
                            }
                            Some((Some(target), source))
                        }
                        Err(error) => {
                            return Ok(Reply::Error {
                                code: crate::error::BackendError::from_error(&error).to_string(),
                            });
                        }
                    }
                };
                let replacement = if let Command::Takeover {
                    viewer_session_id, ..
                } = &r.command
                {
                    let effects = authority!(self.registry.prepare_takeover(
                        &r.request_id,
                        viewer_session_id,
                        owner,
                        capture_selection,
                        now
                    ));
                    self.effects(viewer_session_id, effects).await;
                    let _ = self.registry.drained(viewer_session_id);
                    Some(viewer_session_id.as_str())
                } else {
                    None
                };
                let (snapshot, attach_token) = authority!(self.registry.reserve_for(
                    &r.request_id,
                    owner.clone(),
                    capture_selection.clone(),
                    replacement,
                    now
                ));
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                if let Some((target, source)) = prepared {
                    if let Some(target) = target {
                        self.selected_source.insert(
                            snapshot.viewer_session_id.clone(),
                            (capture_selection.source_ref.clone(), target),
                        );
                    }
                    self.pending_source
                        .insert(snapshot.viewer_session_id.clone(), source);
                }
                Reply::Reserved {
                    attach_expires_at: self
                        .registry
                        .attach_expires_at(&snapshot.viewer_session_id, Instant::now())?,
                    snapshot,
                    attach_token,
                }
            }
            Command::Attach {
                owner,
                viewer_session_id,
                capture_selection,
                attach_token,
                ..
            } => {
                let snapshot = authority!(self.registry.attach(
                    viewer_session_id,
                    owner,
                    capture_selection,
                    attach_token,
                    now
                ));
                if self.mode != crate::capture::Mode::Control {
                    let source_result =
                        self.pending_source
                            .remove(viewer_session_id)
                            .ok_or_else(|| {
                                anyhow::anyhow!(crate::error::BackendError::DesktopUnavailable)
                            });
                    let mut source = match source_result {
                        Ok(s) => s,
                        Err(error) => {
                            let cause = crate::error::BackendError::from_error(&error);
                            self.fail_backend(viewer_session_id, cause).await;
                            return Ok(Reply::Error {
                                code: cause.to_string(),
                            });
                        }
                    };
                    let geometry = match source.refresh_geometry() {
                        Ok(g) => g,
                        Err(e) => {
                            let cause = crate::error::BackendError::from_error(&e);
                            self.fail_backend(viewer_session_id, cause).await;
                            return Ok(Reply::Error {
                                code: cause.to_string(),
                            });
                        }
                    };
                    self.registry
                        .capture_geometry(viewer_session_id, geometry)?;
                    let (display, authority) = self.input_environment();
                    let backend = if self.mode == crate::capture::Mode::Synthetic {
                        crate::input_guard::Backend::Synthetic
                    } else {
                        crate::input_guard::Backend::Native {
                            geometry,
                            display: display.clone(),
                            authority: authority.clone(),
                        }
                    };
                    #[cfg(target_os = "macos")]
                    let backend = match &source {
                        crate::capture::Source::Native(c) => {
                            c.window_input()
                                .map(|(identity, geometry)| {
                                    crate::input_guard::Backend::MacWindow { identity, geometry }
                                })
                                .unwrap_or(backend)
                        }
                        _ => backend,
                    };
                    #[cfg(target_os = "linux")]
                    let backend = match &source {
                        crate::capture::Source::X11(c) => c
                            .window_input()
                            .map(
                                |(window, geometry)| crate::input_guard::Backend::LinuxWindow {
                                    window,
                                    geometry,
                                    display: display.clone(),
                                    authority: authority.clone(),
                                },
                            )
                            .unwrap_or(backend),
                        _ => backend,
                    };
                    let peer = match MediaPeer::with_source(
                        viewer_session_id.clone(),
                        self.events.clone(),
                        source,
                    )
                    .await
                    {
                        Ok(p) => p,
                        Err(_) => {
                            self.fail(viewer_session_id).await;
                            return Ok(Reply::Error {
                                code: "REMOTE_DESKTOP_PEER_FAILED".into(),
                            });
                        }
                    };
                    let input_backend = Some(backend.clone());
                    if self.input_guard.is_none() {
                        match crate::input_guard::Client::spawn(&component_executable()?, backend)
                            .await
                        {
                            Ok(guard) => {
                                self.input_guard = Some(guard);
                                self.input_guard_backend = input_backend.clone();
                            }
                            Err(error) => {
                                peer.close().await;
                                let cause = error
                                    .downcast_ref::<crate::error::BackendError>()
                                    .copied()
                                    .unwrap_or(crate::error::BackendError::InputGuardFailed);
                                self.fail_backend(viewer_session_id, cause).await;
                                return Ok(Reply::Error {
                                    code: cause.to_string(),
                                });
                            }
                        }
                    }
                    let control = peer.control();
                    self.live.insert(
                        viewer_session_id.clone(),
                        LivePeer {
                            id: viewer_session_id.clone(),
                            owner: owner.clone(),
                            input_backend,
                            peer,
                            control,
                            channels: HashMap::new(),
                            decoder: Decoder::default(),
                            reply_seq: 0,
                            clipboard_enabled: false,
                            clipboard: String::new(),
                            native_clipboard: None,
                            ice_expires_at: None,
                            pending_ice_expires_at: None,
                            ice_restart_pending: false,
                            fallback_generation: None,
                            fallback_active: false,
                            fallback_control: None,
                            webrtc_connected: false,
                        },
                    );
                }
                Reply::Snapshot {
                    snapshot: self
                        .registry
                        .snapshot(viewer_session_id, owner)
                        .unwrap_or(snapshot),
                }
            }
            Command::Snapshot {
                owner,
                viewer_session_id,
            } => Reply::Snapshot {
                snapshot: authority!(self.registry.snapshot(viewer_session_id, owner)),
            },
            Command::Stop {
                owner,
                viewer_session_id,
            } => {
                self.pending_source.remove(viewer_session_id);
                let effects = authority!(self.registry.stop(viewer_session_id, owner, now));
                self.effects(viewer_session_id, effects).await;
                let _ = self.registry.drained(viewer_session_id);
                Reply::Stopped
            }
            Command::ForceStop { viewer_session_id } => {
                let effects = authority!(self.registry.force_stop(viewer_session_id, now));
                self.effects(viewer_session_id, effects).await;
                self.pending_source.remove(viewer_session_id);
                let _ = self.registry.drained(viewer_session_id);
                Reply::Stopped
            }
            Command::SignalAlive {
                owner,
                viewer_session_id,
            } => {
                authority!(self.registry.snapshot(viewer_session_id, owner));
                authority!(self.registry.signal_alive(viewer_session_id, now));
                Reply::Acknowledged
            }
            Command::SignalClosed {
                owner,
                viewer_session_id,
            } => {
                authority!(self.registry.snapshot(viewer_session_id, owner));
                let effects = authority!(self.registry.signal_closed(viewer_session_id, now));
                self.effects(viewer_session_id, effects).await;
                Reply::Stopped
            }
            Command::ConfigureIce {
                owner,
                viewer_session_id,
                ice_servers,
                ice_credentials_expires_at,
            } => {
                authority!(self.registry.snapshot(viewer_session_id, owner));
                let wall = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_millis() as u64;
                if ice_servers.len() > 16
                    || ice_credentials_expires_at.is_some_and(|at| at <= wall)
                    || ice_servers.iter().any(|s| {
                        s.urls.is_empty()
                            || s.urls.len() > 16
                            || s.urls.iter().any(|u| u.len() > 2048)
                            || s.username.len() > 1024
                            || s.credential.len() > 1024
                    })
                {
                    return Ok(Reply::Error {
                        code: "REMOTE_DESKTOP_ICE_CONFIG_INVALID".into(),
                    });
                }
                let Some(live) = self.live.get_mut(viewer_session_id) else {
                    return Ok(Reply::Error {
                        code: "REMOTE_DESKTOP_INVALID_STATE".into(),
                    });
                };
                let configured = live.peer.configure_ice(ice_servers).await;
                let preserve_fallback = live.fallback_active;
                if configured.is_err() {
                    if !preserve_fallback {
                        self.fail(viewer_session_id).await;
                    }
                    return Ok(Reply::Error {
                        code: "REMOTE_DESKTOP_ICE_CONFIG_INVALID".into(),
                    });
                }
                let next_expiry = ice_credentials_expires_at
                    .map(|at| Instant::now() + Duration::from_millis(at - wall));
                // A configuration ACK does not prove a renewed allocation. Keep
                // the OLD expiry until the restarted generation reaches a
                // connected pair and publishes transportGeneration.
                if live.ice_expires_at.is_none() {
                    live.ice_expires_at = next_expiry;
                } else {
                    live.pending_ice_expires_at = next_expiry;
                    live.ice_restart_pending = false;
                }
                Reply::Acknowledged
            }
            Command::Candidate {
                owner,
                viewer_session_id,
                candidate,
            } => {
                authority!(self.registry.snapshot(viewer_session_id, owner));
                if candidate.candidate.len() > 4096
                    || candidate.sdp_mid.as_ref().is_some_and(|v| v.len() > 256)
                    || candidate.sdp_m_line_index.is_some_and(|v| v > 1)
                {
                    return Ok(Reply::Error {
                        code: "REMOTE_DESKTOP_CANDIDATE_INVALID".into(),
                    });
                }
                let Some(live) = self.live.get(viewer_session_id) else {
                    return Ok(Reply::Error {
                        code: "REMOTE_DESKTOP_INVALID_STATE".into(),
                    });
                };
                match live.peer.candidate(candidate).await {
                    Ok(()) => Reply::Acknowledged,
                    Err(_) => Reply::Error {
                        code: "REMOTE_DESKTOP_CANDIDATE_INVALID".into(),
                    },
                }
            }
            Command::Offer {
                owner,
                viewer_session_id,
                sdp,
            } => {
                let snapshot = authority!(self.registry.snapshot(viewer_session_id, owner));
                if !matches!(snapshot.phase, Phase::Negotiating | Phase::Active) {
                    return Ok(Reply::Error {
                        code: "REMOTE_DESKTOP_INVALID_STATE".into(),
                    });
                }
                let fallback_active = self
                    .live
                    .get(viewer_session_id)
                    .is_some_and(|live| live.fallback_active);
                if snapshot.phase == Phase::Active && !fallback_active {
                    let effects = authority!(self.registry.suspend_input(viewer_session_id));
                    self.effects(viewer_session_id, effects).await;
                }
                let Some(live) = self.live.get_mut(viewer_session_id) else {
                    return Ok(Reply::Error {
                        code: "REMOTE_DESKTOP_BACKEND_NOT_IMPLEMENTED".into(),
                    });
                };
                match live.peer.answer(sdp.clone(), fallback_active).await {
                    Ok((sdp, restarted)) => {
                        if restarted && live.pending_ice_expires_at.is_some() {
                            live.ice_restart_pending = true;
                        }
                        Reply::Answer { sdp }
                    }
                    Err(_) => {
                        // Negotiation failure is recoverable: the browser can
                        // select the WebSocket fallback on the same viewer
                        // session. Keep the component-owned session alive so
                        // the fallback endpoint remains authoritative.
                        eprintln!("remote-desktop negotiation failed");
                        Reply::Error {
                            code: "REMOTE_DESKTOP_NEGOTIATION_FAILED".into(),
                        }
                    }
                }
            }
            Command::Shutdown => {
                for (_, live) in self.live.drain() {
                    live.control.input.lock().unwrap().release_all();
                    live.peer.close().await;
                }
                if let Some(guard) = self.input_guard.take() {
                    let _ = guard.close().await;
                }
                self.input_guard_backend = None;
                Reply::Stopped
            }
        })
    }
    async fn event(&mut self, event: PeerEvent) -> anyhow::Result<()> {
        let id = match &event {
            PeerEvent::Connected(id)
            | PeerEvent::Disconnected(id)
            | PeerEvent::Failed(id)
            | PeerEvent::Recovering(id)
            | PeerEvent::Recovered(id) => id,
            PeerEvent::Channel { session, .. }
            | PeerEvent::Message { session, .. }
            | PeerEvent::BackendFailed { session, .. }
            | PeerEvent::GeometryChanged { session, .. }
            | PeerEvent::GeometryUnstable { session, .. } => session,
        };
        let Some(owner) = self.live.get(id).map(|live| live.owner.clone()) else {
            return Ok(());
        };
        if let Some(live) = self.live.get_mut(id).filter(|live| live.fallback_active) {
            match &event {
                PeerEvent::Channel { kind, channel, .. } => {
                    live.channels.insert(*kind, channel.clone());
                    return Ok(());
                }
                // Fallback control owns input while it is active. WebRTC data
                // channel messages remain ignored until the explicit upgrade.
                PeerEvent::Message { .. } => return Ok(()),
                PeerEvent::Connected(session) | PeerEvent::Recovered(session) => {
                    live.webrtc_connected = true;
                    live.control.set_webrtc_ready(true);
                    live.control.idr.store(true, Ordering::SeqCst);
                    live.control
                        .pacing
                        .request_idr
                        .store(true, Ordering::SeqCst);
                    live.peer
                        .start(session.clone(), self.events.clone())
                        .await?;
                    return Ok(());
                }
                PeerEvent::Recovering(_) | PeerEvent::Disconnected(_) | PeerEvent::Failed(_) => {
                    live.webrtc_connected = false;
                    live.control.set_webrtc_ready(false);
                    return Ok(());
                }
                _ => {}
            }
        }
        match event {
            PeerEvent::Connected(id) => {
                let phase = self.registry.snapshot(&id, &owner)?.phase;
                if phase == Phase::Negotiating {
                    self.registry.connected(&id, Instant::now())?;
                } else {
                    self.recover_transport(&id, Instant::now())?;
                }
                let live = self
                    .live
                    .get_mut(&id)
                    .ok_or_else(|| anyhow::anyhow!("peer closed"))?;
                live.webrtc_connected = true;
                live.control.set_webrtc_ready(true);
                live.control.idr.store(true, Ordering::SeqCst);
                live.peer.start(id, self.events.clone()).await?;
                let snapshot = self.registry.snapshot(&live.id, &live.owner)?;
                live.control.pause(snapshot.media_paused);
            }
            PeerEvent::Recovering(id) => {
                if let Some(live) = self.live.get_mut(&id) {
                    live.webrtc_connected = false;
                    live.control.set_webrtc_ready(false);
                }
                if self.registry.snapshot(&id, &owner)?.phase == Phase::Active {
                    let effects = self.registry.ice_disconnected(&id, Instant::now())?;
                    self.effects(&id, effects).await;
                }
            }
            PeerEvent::Recovered(id) => {
                if let Some(live) = self.live.get_mut(&id) {
                    live.webrtc_connected = true;
                    live.control.set_webrtc_ready(true);
                }
                if self.registry.snapshot(&id, &owner)?.phase == Phase::Active {
                    self.recover_transport(&id, Instant::now())?;
                }
            }
            PeerEvent::Disconnected(id) => {
                if let Some(live) = self.live.get_mut(&id) {
                    live.webrtc_connected = false;
                    live.control.set_webrtc_ready(false);
                }
                let effects = self.registry.ice_disconnected(&id, Instant::now())?;
                self.effects(&id, effects).await;
            }
            PeerEvent::Failed(id) => {
                if let Some(live) = self.live.get_mut(&id) {
                    live.webrtc_connected = false;
                    live.control.set_webrtc_ready(false);
                }
                self.fail(&id).await
            }
            PeerEvent::GeometryUnstable {
                session,
                acknowledged,
            } => {
                if self
                    .registry
                    .snapshot(&session, &owner)?
                    .input_epoch
                    .is_some()
                {
                    let effects = self.registry.suspend_input(&session)?;
                    self.effects(&session, effects).await;
                }
                let _ = acknowledged.send(());
            }
            PeerEvent::GeometryChanged {
                session,
                geometry,
                acknowledged,
            } => {
                let input_was_held = self
                    .registry
                    .snapshot(&session, &owner)?
                    .input_epoch
                    .is_some();
                let effects = self.registry.suspend_input(&session)?;
                self.effects(&session, effects).await;
                let live_backend = self
                    .live
                    .get(&session)
                    .and_then(|live| live.input_backend.clone());
                let guard_matches = live_backend.as_ref().is_some_and(|backend| {
                    self.input_guard_backend
                        .as_ref()
                        .is_some_and(|guard| guard.same_binding(backend))
                });
                if guard_matches {
                    let guard = self
                        .input_guard
                        .as_mut()
                        .ok_or_else(|| anyhow::anyhow!("input guard closed"))?;
                    let reply = guard
                        .call(&crate::input_guard::Command::Geometry { geometry })
                        .await?;
                    if matches!(
                        reply,
                        crate::input_guard::Event::Suspended {
                            cause: crate::error::BackendError::GeometryChanged
                        }
                    ) {
                        let _ = acknowledged.send(false);
                        return Ok(());
                    }
                    anyhow::ensure!(
                        matches!(reply, crate::input_guard::Event::Released),
                        "REMOTE_DESKTOP_INPUT_GUARD_FAILED"
                    );
                    self.input_guard_backend
                        .as_mut()
                        .ok_or_else(|| anyhow::anyhow!("input guard closed"))?
                        .set_geometry(geometry);
                }
                self.registry.capture_geometry(&session, geometry)?;
                if let Some(backend) = self
                    .live
                    .get_mut(&session)
                    .and_then(|live| live.input_backend.as_mut())
                {
                    backend.set_geometry(geometry);
                }
                if input_was_held {
                    let session_revision =
                        self.registry.snapshot(&session, &owner)?.session_revision;
                    self.live
                        .get_mut(&session)
                        .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                        .reply(
                            Channel::Control,
                            geometry_input_suspended_notice(session_revision),
                        )
                        .await?;
                }
                // Snapshot enters the actor's ordered output before another input
                // can arm. Old revision/epoch is invalid even for move-only changes.
                let _ = acknowledged.send(true);
            }
            PeerEvent::BackendFailed { session, cause } => {
                self.fail_backend(&session, cause).await;
            }
            PeerEvent::Channel {
                session,
                kind,
                channel,
            } => {
                if let Some(live) = self.live.get_mut(&session) {
                    live.channels.insert(kind, channel);
                }
            }
            PeerEvent::Message {
                session,
                kind,
                bytes,
                received,
            } => {
                if received.elapsed() > Duration::from_millis(100) && kind != Channel::Pointer {
                    let effects = self.registry.suspend_input(&session)?;
                    self.effects(&session, effects).await;
                    return Ok(());
                }
                let Some(live) = self.live.get_mut(&session) else {
                    return Ok(());
                };
                let message = match live.decoder.decode(kind, &bytes) {
                    Ok((message, _warning)) => message,
                    Err(_) if kind == Channel::Pointer => return Ok(()),
                    Err(_) => {
                        // Reject only this message. Malformed or oversized channel
                        // data must leave the control queue and media session intact;
                        // a client bug must not tear down video.
                        eprintln!("remote-desktop invalid channel message: {kind:?}");
                        return Ok(());
                    }
                };
                // Explicit diagnostic only: retain numeric correlation, never input
                // payloads. Bound output for the lifetime of this process.
                static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
                static TRACE_COUNT: std::sync::atomic::AtomicUsize =
                    std::sync::atomic::AtomicUsize::new(0);
                let trace_seq = if kind == Channel::Input
                    && *TRACE.get_or_init(|| std::env::var_os("G1_DESKTOP_INPUT_TRACE").is_some())
                    && TRACE_COUNT.fetch_add(1, Ordering::Relaxed) < 1024
                {
                    serde_json::from_slice::<serde_json::Value>(&bytes)
                        .ok()
                        .and_then(|v| v.get("seq").and_then(|v| v.as_u64()))
                } else {
                    None
                };
                if let Some(seq) = trace_seq {
                    eprintln!(
                        "desktop-input-trace received seq={seq} queueMicros={}",
                        received.elapsed().as_micros()
                    );
                }
                self.message(session, message, trace_seq).await?;
            }
        }
        Ok(())
    }
    async fn guard_state(
        &mut self,
        id: &str,
        expected: u64,
        reply: crate::input_guard::Event,
    ) -> anyhow::Result<bool> {
        match reply {
            crate::input_guard::Event::Suspended { cause } => {
                let effects = self.registry.suspend_input(id)?;
                self.effects(id, effects).await;
                self.live
                    .get_mut(id)
                    .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                    .reply(
                        Channel::Control,
                        serde_json::json!({"type":"error","payload":{"code":cause.to_string()}}),
                    )
                    .await?;
                Ok(false)
            }
            crate::input_guard::Event::State {
                epoch: Some(current),
                ..
            } if current == expected => Ok(true),
            crate::input_guard::Event::State { epoch: None, .. }
            | crate::input_guard::Event::Rejected => {
                // Lease/backlog expiry is an input state transition, not a peer
                // crash. Reconcile the authority before publishing its snapshot.
                let effects = self.registry.suspend_input(id)?;
                self.effects(id, effects).await;
                Ok(false)
            }
            _ => anyhow::bail!("REMOTE_DESKTOP_INPUT_GUARD_FAILED"),
        }
    }
    async fn bind_input_for_viewer(&mut self, id: &str) -> anyhow::Result<bool> {
        let Some(backend) = self
            .live
            .get(id)
            .and_then(|live| live.input_backend.clone())
        else {
            return Ok(true);
        };
        if self.input_guard_backend.as_ref() == Some(&backend) {
            return Ok(true);
        }
        let reply = self
            .input_guard
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("input guard closed"))?
            .call(&crate::input_guard::Command::Rebind {
                backend: backend.clone(),
            })
            .await?;
        match reply {
            crate::input_guard::Event::Released => {
                self.input_guard_backend = Some(backend);
                Ok(true)
            }
            crate::input_guard::Event::Suspended { cause } => {
                let effects = self.registry.suspend_input(id)?;
                self.effects(id, effects).await;
                self.live
                    .get_mut(id)
                    .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                    .reply(
                        Channel::Control,
                        serde_json::json!({"type":"error","payload":{"code":cause.to_string()}}),
                    )
                    .await?;
                Ok(false)
            }
            _ => anyhow::bail!("REMOTE_DESKTOP_INPUT_GUARD_FAILED"),
        }
    }
    async fn message(
        &mut self,
        id: String,
        message: Message,
        trace_seq: Option<u64>,
    ) -> anyhow::Result<()> {
        let now = Instant::now();
        let owner = self
            .live
            .get(&id)
            .map(|live| live.owner.clone())
            .ok_or_else(|| anyhow::anyhow!("peer closed"))?;
        match message {
            Message::Control(control) => match control {
                Control::RequestControl => {
                    let response = match self.registry.request_control(&id, now) {
                        Ok(previous) => {
                            if let Some(previous) = previous.filter(|previous| previous != &id) {
                                self.effects(
                                    &previous,
                                    Effects {
                                        release_input: true,
                                        ..Default::default()
                                    },
                                )
                                .await;
                            }
                            match self.registry.snapshot(&id, &owner) {
                                Ok(snapshot) => serde_json::json!({
                                    "type": "control.changed",
                                    "payload": {
                                        "isController": snapshot.is_controller,
                                        "controlRevision": snapshot.control_revision,
                                        "viewerCount": snapshot.viewer_count,
                                        "viewerSources": snapshot.viewer_sources
                                    }
                                }),
                                Err(error) => serde_json::json!({
                                    "type": "error",
                                    "payload": { "code": error.to_string() }
                                }),
                            }
                        }
                        Err(error) => serde_json::json!({
                            "type": "error",
                            "payload": { "code": error.to_string() }
                        }),
                    };
                    self.live
                        .get_mut(&id)
                        .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                        .reply(Channel::Control, response)
                        .await?;
                }
                Control::Resume(resume) => {
                    let snapshot = self.registry.snapshot(&id, &owner)?;
                    let response = match self.registry.live_input_epoch(&id, now) {
                        Some(epoch) => {
                            serde_json::json!({"type":"input.resumed","payload":{"inputEpoch":epoch}})
                        }
                        None => {
                            let window_target =
                                self.selected_source.get(&id).is_some_and(|(_, target)| {
                                    matches!(
                                        target,
                                        crate::platform::display::SourceTarget::Window(_)
                                    )
                                });
                            let revision_valid = !window_target
                                || resume.session_revision == Some(snapshot.session_revision);
                            match if revision_valid {
                                self.registry.prepare_input(&id, now)
                            } else {
                                Err(crate::session::Error::StaleEpoch)
                            } {
                                Ok(epoch) => {
                                    if !self.bind_input_for_viewer(&id).await? {
                                        return Ok(());
                                    }
                                    let reply = self
                                        .input_guard
                                        .as_mut()
                                        .ok_or_else(|| anyhow::anyhow!("input guard closed"))?
                                        .call(&crate::input_guard::Command::Arm { epoch })
                                        .await?;
                                    if !self.guard_state(&id, epoch, reply).await? {
                                        return Ok(());
                                    }
                                    if let Err(error) =
                                        self.registry.commit_input(&id, epoch, Instant::now())
                                    {
                                        self.input_guard
                                            .as_mut()
                                            .ok_or_else(|| anyhow::anyhow!("input guard closed"))?
                                            .call(&crate::input_guard::Command::Suspend)
                                            .await?;
                                        return Err(error.into());
                                    }
                                    serde_json::json!({"type":"input.resumed","payload":{"inputEpoch":epoch}})
                                }
                                Err(e) => {
                                    serde_json::json!({"type":"error","payload":{"code":e.to_string()}})
                                }
                            }
                        }
                    };
                    self.live
                        .get_mut(&id)
                        .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                        .reply(Channel::Control, response)
                        .await?;
                }
                Control::Suspend => {
                    let effects = self.registry.suspend_input(&id)?;
                    self.effects(&id, effects).await;
                    self.live
                        .get_mut(&id)
                        .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                        .reply(
                            Channel::Control,
                            serde_json::json!({"type":"input.suspended"}),
                        )
                        .await?;
                }
                Control::Alive(epoch) => {
                    if self
                        .registry
                        .input_alive(&id, epoch.input_epoch, now)
                        .is_ok()
                    {
                        let reply = self
                            .input_guard
                            .as_mut()
                            .ok_or_else(|| anyhow::anyhow!("input guard closed"))?
                            .call(&crate::input_guard::Command::Alive {
                                epoch: epoch.input_epoch,
                            })
                            .await?;
                        if !self.guard_state(&id, epoch.input_epoch, reply).await? {
                            return Ok(());
                        }
                    }
                }
                Control::Visibility { hidden } => {
                    let effects = self.registry.visibility(&id, hidden, now)?;
                    self.effects(&id, effects).await;
                }
                Control::Keyframe => {
                    self.live
                        .get(&id)
                        .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                        .control
                        .idr
                        .store(true, Ordering::SeqCst);
                }
                Control::TransportUpgrade => {
                    self.upgrade_transport(&id).await?;
                }
                Control::StreamResolution {
                    max_width,
                    max_height,
                    max_frame_rate,
                    capture_precision,
                } => {
                    let resolution = match (max_width, max_height) {
                        (None, None) => None,
                        (Some(width), Some(height))
                            if (160..=16_384).contains(&width)
                                && (90..=16_384).contains(&height) =>
                        {
                            Some((width, height))
                        }
                        _ => {
                            self.live
                                .get_mut(&id)
                                .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                                .reply(
                                    Channel::Control,
                                    serde_json::json!({
                                        "type":"error",
                                        "payload":{"code":"REMOTE_DESKTOP_INVALID_REQUEST"}
                                    }),
                                )
                                .await?;
                            return Ok(());
                        }
                    };
                    if max_frame_rate.is_some_and(|fps| !(1..=120).contains(&fps)) {
                        self.live
                            .get_mut(&id)
                            .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                            .reply(
                                Channel::Control,
                                serde_json::json!({
                                    "type":"error",
                                    "payload":{"code":"REMOTE_DESKTOP_INVALID_REQUEST"}
                                }),
                            )
                            .await?;
                        return Ok(());
                    }
                    self.live
                        .get(&id)
                        .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                        .control
                        .set_stream_limits(resolution, max_frame_rate);
                    self.live
                        .get(&id)
                        .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                        .control
                        .set_capture_precision(capture_precision);
                    self.live
                        .get_mut(&id)
                        .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                        .reply(
                            Channel::Control,
                            serde_json::json!({
                                "type":"stream.resolution",
                                "payload":{
                                    "maxWidth":max_width,
                                    "maxHeight":max_height,
                                    "maxFrameRate":max_frame_rate,
                                    "capturePrecision":capture_precision
                                }
                            }),
                        )
                        .await?;
                }
                Control::Stop => {
                    let effects = self.registry.stop(&id, &owner, now)?;
                    self.effects(&id, effects).await;
                }
                Control::Clipboard { enabled } => {
                    // Negotiation gates the whole native clipboard boundary,
                    // including worker creation and OS clipboard initialization.
                    let enabled = enabled
                        && self
                            .live
                            .get(&id)
                            .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                            .peer
                            .clipboard_supported()
                            .await;
                    let native = if enabled && self.mode != crate::capture::Mode::Synthetic {
                        let (display, authority) = self.input_environment();
                        crate::clipboard::Client::spawn(
                            &component_executable()?,
                            display,
                            authority,
                        )
                        .await
                        .ok()
                    } else {
                        None
                    };
                    let live = self
                        .live
                        .get_mut(&id)
                        .ok_or_else(|| anyhow::anyhow!("peer closed"))?;
                    live.clipboard_enabled = enabled
                        && (self.mode == crate::capture::Mode::Synthetic || native.is_some());
                    live.native_clipboard = if live.clipboard_enabled { native } else { None };
                    if !live.clipboard_enabled {
                        live.clipboard.clear();
                    }
                    live.reply(Channel::Control, serde_json::json!({"type":"clipboard.enabled","payload":{"enabled":live.clipboard_enabled}})).await?;
                }
            },
            Message::Input(input) => {
                if self.registry.check_epoch(&id, input.epoch(), now).is_ok() {
                    let reply = self
                        .input_guard
                        .as_mut()
                        .ok_or_else(|| anyhow::anyhow!("input guard closed"))?
                        .call(&crate::input_guard::Command::Input {
                            event: input.clone(),
                        })
                        .await?;
                    if let Some(seq) = trace_seq {
                        if let crate::input_guard::Event::State {
                            epoch,
                            interactions,
                            ..
                        } = &reply
                        {
                            eprintln!("desktop-input-trace applied seq={seq} armed={} interactions={interactions}", epoch.is_some());
                        } else {
                            eprintln!("desktop-input-trace rejected seq={seq}");
                        }
                    }
                    if !self.guard_state(&id, input.epoch(), reply).await? {
                        return Ok(());
                    }
                    self.live
                        .get(&id)
                        .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                        .control
                        .input
                        .lock()
                        .unwrap()
                        .apply(&input);
                    if matches!(input, crate::channel::Input::Text(_)) {
                        self.live
                            .get_mut(&id)
                            .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                            .reply(Channel::Input, serde_json::json!({"type":"text.committed","payload":{"inputEpoch":input.epoch()}}))
                            .await?;
                    }
                }
            }
            Message::Pointer(pointer) => {
                if self
                    .registry
                    .check_epoch(&id, pointer.input_epoch, now)
                    .is_ok()
                {
                    let reply = self
                        .input_guard
                        .as_mut()
                        .ok_or_else(|| anyhow::anyhow!("input guard closed"))?
                        .call(&crate::input_guard::Command::Pointer {
                            event: pointer.clone(),
                        })
                        .await?;
                    if !self.guard_state(&id, pointer.input_epoch, reply).await? {
                        return Ok(());
                    }
                    self.live
                        .get(&id)
                        .ok_or_else(|| anyhow::anyhow!("peer closed"))?
                        .control
                        .input
                        .lock()
                        .unwrap()
                        .pointer(&pointer);
                }
            }
            Message::Clipboard(clipboard) => {
                if !self.registry.snapshot(&id, &owner)?.is_controller {
                    return Ok(());
                }
                let live = self
                    .live
                    .get_mut(&id)
                    .ok_or_else(|| anyhow::anyhow!("peer closed"))?;
                if !live.clipboard_enabled {
                    return Ok(());
                }
                let response = if let Some(native) = live.native_clipboard.as_mut() {
                    let command = match clipboard {
                        Clipboard::Write { text } => crate::clipboard::Command::Write { text },
                        Clipboard::Read => crate::clipboard::Command::Read,
                    };
                    match native.call(&command).await {
                        Ok(crate::clipboard::Reply::Written) => {
                            serde_json::json!({"type":"clipboard.written"})
                        }
                        Ok(crate::clipboard::Reply::Text { text }) => {
                            serde_json::json!({"type":"clipboard.text","payload":{"text":text}})
                        }
                        _ => {
                            serde_json::json!({"type":"error","payload":{"code":"REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE"}})
                        }
                    }
                } else {
                    match clipboard {
                        Clipboard::Write { text } => {
                            live.clipboard = text;
                            serde_json::json!({"type":"clipboard.written"})
                        }
                        Clipboard::Read => {
                            serde_json::json!({"type":"clipboard.text","payload":{"text":live.clipboard}})
                        }
                    }
                };
                live.reply(Channel::Clipboard, response).await?;
            }
        }
        Ok(())
    }
    /// A renewed credential is committed only after the component observes the
    /// replacement ICE generation connected. Ordinary recoveries keep the old
    /// deadline and do not advance the renewal proof.
    fn recover_transport(&mut self, id: &str, now: Instant) -> anyhow::Result<()> {
        let pending = self
            .live
            .get(id)
            .is_some_and(|live| live.ice_restart_pending);
        if !pending {
            self.registry.ice_recovered(id, now)?;
            return Ok(());
        }
        self.registry.transport_recovered(id, now)?;
        if let Some(live) = self.live.get_mut(id) {
            live.ice_restart_pending = false;
            if let Some(expires_at) = live.pending_ice_expires_at.take() {
                live.ice_expires_at = Some(expires_at);
            }
        }
        Ok(())
    }
}

pub async fn serve(stream: LocalIpcStream, synthetic: bool) -> anyhow::Result<()> {
    serve_mode(
        stream,
        if synthetic {
            crate::capture::Mode::Synthetic
        } else {
            crate::capture::Mode::Control
        },
    )
    .await
}
pub async fn serve_mode(stream: LocalIpcStream, mode: crate::capture::Mode) -> anyhow::Result<()> {
    serve_mode_with_cursor(stream, mode, true).await
}
pub async fn serve_mode_with_cursor(
    stream: LocalIpcStream,
    mode: crate::capture::Mode,
    show_cursor: bool,
) -> anyhow::Result<()> {
    serve_mode_with_cursor_and_source_salt(stream, mode, show_cursor, None).await
}
pub async fn serve_mode_with_cursor_and_source_salt(
    mut stream: LocalIpcStream,
    mode: crate::capture::Mode,
    show_cursor: bool,
    source_salt: Option<String>,
) -> anyhow::Result<()> {
    let (events, mut peer_events) = mpsc::channel(32);
    let mut fallback = if mode == crate::capture::Mode::Control {
        None
    } else {
        crate::fallback_server::start().await.ok()
    };
    let (fallback_url, fallback_token, mut fallback_events) = match fallback.take() {
        Some(server) => (server.url, server.token, server.events),
        None => (String::new(), String::new(), mpsc::channel(1).1),
    };
    let mut service = Service {
        registry: Registry::new(),
        live: HashMap::new(),
        input_guard: None,
        input_guard_backend: None,
        mode,
        show_cursor,
        source_salt: source_salt.unwrap_or_else(crate::session::secret),
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        catalog: None,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        display_catalog: None,
        pending_source: HashMap::new(),
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        selected_source: HashMap::new(),
        #[cfg(target_os = "linux")]
        surface: None,
        events,
        fallbacks: HashMap::new(),
    };
    let mut capability = crate::preflight::probe(mode, show_cursor);
    capability.fallback = if fallback_url.is_empty() {
        controlled_instance_protocol::RemoteDesktopFallbackCapabilities::unavailable(
            "REMOTE_DESKTOP_FALLBACK_UNAVAILABLE",
        )
    } else {
        controlled_instance_protocol::RemoteDesktopFallbackCapabilities::ready()
    };
    framing::write(
        &mut stream,
        &Welcome {
            protocol_version: IPC_VERSION.into(),
            boot_id: service.registry.boot_id().into(),
            capability,
            fallback_url,
            fallback_token,
        },
    )
    .await?;
    let (mut reader, mut writer) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::channel::<Request>(8);
    let (out, mut outgoing) = mpsc::channel(16);
    let mut tasks = JoinSet::new();
    tasks.spawn(async move {
        while let Ok(Some(r)) = framing::read(&mut reader).await {
            if tx.send(r).await.is_err() {
                break;
            }
        }
    });
    let (writer_done, writer_finished) = tokio::sync::oneshot::channel();
    tasks.spawn(async move {
        while let Some(packet) = outgoing.recv().await {
            if !matches!(
                tokio::time::timeout(Duration::from_secs(5), framing::write(&mut writer, &packet))
                    .await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
        let _ = writer_done.send(());
    });
    let result = async {
        loop {
            let deadline = [
                service.registry.next_deadline(),
                service
                    .live
                    .values()
                    .filter_map(|live| live.ice_expires_at)
                    .min(),
            ]
            .into_iter()
            .flatten()
            .min();
            let wait = async {
                if let Some(d) = deadline {
                    tokio::time::sleep_until(d.into()).await;
                } else {
                    std::future::pending::<()>().await;
                }
            };
            enum Input {
                Request(Option<Request>),
                Peer(PeerEvent),
                Deadline,
                Closed,
                GuardDead,
                Fallback(FallbackEvent),
                #[cfg(target_os = "linux")]
                SurfaceDead,
            }
            let guard_exit = async {
                if let Some(guard) = service.input_guard.as_mut() {
                    let _ = guard.child.wait().await;
                } else {
                    std::future::pending::<()>().await;
                }
            };
            #[cfg(target_os = "linux")]
            let surface_exit = async {
                if let Some(surface) = service.surface.as_mut() {
                    let _ = surface.child.wait().await;
                } else {
                    std::future::pending::<()>().await;
                }
            };
            #[cfg(not(target_os = "linux"))]
            let surface_exit = std::future::pending::<()>();
            let input = tokio::select! {
                _=surface_exit=>{
                    #[cfg(target_os = "linux")]
                    { Input::SurfaceDead }
                    #[cfg(not(target_os = "linux"))]
                    { Input::Closed }
                },
                r=rx.recv()=>Input::Request(r),
                _=guard_exit=>Input::GuardDead,
                Some(event)=peer_events.recv()=>Input::Peer(event),
                Some(event)=fallback_events.recv()=>Input::Fallback(event),
                _=wait=>Input::Deadline,
                _=out.closed()=>Input::Closed,
            };
            let expired_ice = service
                .live
                .values()
                .filter(|live| live.ice_expires_at.is_some_and(|at| at <= Instant::now()))
                .map(|live| live.id.clone())
                .collect::<Vec<_>>();
            for id in expired_ice {
                service.fail(&id).await;
            }
            let effects = service.registry.tick(Instant::now());
            for (id, effects) in effects {
                service.effects(&id, effects).await;
            }
            let mut response = None;
            let mut shutdown = false;
            match input {
                Input::Request(Some(r)) => {
                    shutdown = r.boot_id == service.registry.boot_id()
                        && !r.request_id.is_empty()
                        && matches!(r.command, Command::Shutdown);
                    let result = service.command(&r).await;
                    response = Some(Response {
                        request_id: r.request_id,
                        boot_id: service.registry.boot_id().into(),
                        result,
                    });
                }
                Input::Request(None) | Input::Closed => break,
                Input::Fallback(event) => {
                    service.fallback_event(event).await?;
                }
                Input::Peer(event) => {
                    let id = match &event {
                        PeerEvent::Connected(id)
                        | PeerEvent::Disconnected(id)
                        | PeerEvent::Failed(id)
                        | PeerEvent::Recovering(id)
                        | PeerEvent::Recovered(id) => id.clone(),
                        PeerEvent::Channel { session, .. }
                        | PeerEvent::Message { session, .. }
                        | PeerEvent::BackendFailed { session, .. }
                        | PeerEvent::GeometryChanged { session, .. }
                        | PeerEvent::GeometryUnstable { session, .. } => session.clone(),
                    };
                    if let Err(error) = service.event(event).await {
                        eprintln!("REMOTE_DESKTOP_CHANNEL_FAILED");
                        if let Some(cause) = error.downcast_ref::<crate::error::BackendError>() {
                            service.fail_backend(&id, *cause).await;
                        } else {
                            service.fail(&id).await;
                        }
                    }
                }
                Input::GuardDead => {
                    let cause = match service.input_guard.as_mut() {
                        Some(guard) => guard.exited_cause().await,
                        None => continue,
                    };
                    let ids = service.live.keys().cloned().collect::<Vec<_>>();
                    for id in ids {
                        service.fail_backend(&id, cause).await;
                    }
                }
                #[cfg(target_os = "linux")]
                Input::SurfaceDead => {
                    // The next reservation must create a fresh owned surface;
                    // never reconnect capture/input to a dead display.
                    service.surface.take();
                    let ids = service.live.keys().cloned().collect::<Vec<_>>();
                    for id in ids {
                        service.fail(&id).await;
                    }
                }
                Input::Deadline => {}
            }
            let boot_id = service.registry.boot_id().to_owned();
            for snapshot in service.registry.drain_events() {
                out.try_send(Packet::Event(SessionEvent {
                    boot_id: boot_id.clone(),
                    snapshot,
                }))
                .map_err(|_| anyhow::anyhow!("host event backpressure"))?;
            }
            if let Some(response) = response {
                out.try_send(Packet::Response(response))
                    .map_err(|_| anyhow::anyhow!("host response backpressure"))?;
            }
            if shutdown {
                break;
            }
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    for (_, live) in service.live.drain() {
        live.control.input.lock().unwrap().release_all();
        live.peer.close().await;
    }
    if let Some(guard) = service.input_guard.take() {
        let _ = guard.close().await;
    }
    service.input_guard_backend = None;
    #[cfg(target_os = "linux")]
    if let Some(surface) = service.surface.take() {
        let _ = surface.close().await;
    }
    drop(out);
    let _ = tokio::time::timeout(Duration::from_secs(5), writer_finished).await;
    result
}

fn component_executable() -> anyhow::Result<std::path::PathBuf> {
    #[cfg(target_os = "linux")]
    {
        // Execute this owned image, even if its on-disk path was atomically
        // replaced. Resolving the current path could mix worker versions or
        // fail with ENOENT after a diagnostic Cargo rebuild.
        Ok(std::path::PathBuf::from("/proc/self/exe"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(std::env::current_exe()?)
    }
}

fn geometry_input_suspended_notice(session_revision: u64) -> serde_json::Value {
    serde_json::json!({
        "type": "input.suspended",
        "payload": {
            "cause": crate::error::BackendError::GeometryChanged.to_string(),
            "recoverable": true,
            "sessionRevision": session_revision,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn geometry_suspension_notice_carries_authoritative_revision() {
        let notice = geometry_input_suspended_notice(17);
        assert_eq!(notice["type"], "input.suspended");
        assert_eq!(
            notice["payload"]["cause"],
            "REMOTE_DESKTOP_GEOMETRY_CHANGED"
        );
        assert_eq!(notice["payload"]["recoverable"], true);
        assert_eq!(notice["payload"]["sessionRevision"], 17);
    }

    #[tokio::test]
    async fn window_enumeration_cannot_stall_an_occupied_authority_actor() {
        let (events, _receiver) = mpsc::channel(1);
        let mut service = Service {
            registry: Registry::new(),
            live: HashMap::new(),
            input_guard: None,
            input_guard_backend: None,
            mode: crate::capture::Mode::Control,
            show_cursor: true,
            source_salt: crate::session::secret(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            catalog: None,
            display_catalog: None,
            pending_source: HashMap::new(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            selected_source: HashMap::new(),
            #[cfg(target_os = "linux")]
            surface: None,
            events,
            fallbacks: HashMap::new(),
        };
        let owner = Owner {
            actor_id: "fixture".into(),
            device_session_id: "device".into(),
        };
        service
            .registry
            .reserve(
                "owned",
                owner.clone(),
                crate::session::CaptureSelection {
                    source_ref: "display".into(),
                    stream_region: None,
                    control_region: None,
                },
                Instant::now(),
            )
            .unwrap();
        let reply = service
            .execute(&Request {
                request_id: "enumerate".into(),
                boot_id: service.registry.boot_id().into(),
                command: Command::ListSources { owner },
            })
            .await
            .unwrap();
        assert!(matches!(
            reply,
            Reply::Error { code }
                if code == crate::error::BackendError::WindowUnsupported.to_string()
        ));
    }
    #[tokio::test]
    async fn failed_construction_records_backend_cause_and_frees_slot_without_a_live_peer() {
        let (events, _receiver) = mpsc::channel(1);
        let mut service = Service {
            registry: Registry::new(),
            live: HashMap::new(),
            input_guard: None,
            input_guard_backend: None,
            mode: crate::capture::Mode::Control,
            show_cursor: true,
            source_salt: crate::session::secret(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            catalog: None,
            display_catalog: None,
            pending_source: HashMap::new(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            selected_source: HashMap::new(),
            #[cfg(target_os = "linux")]
            surface: None,
            events,
            fallbacks: HashMap::new(),
        };
        let owner = Owner {
            actor_id: "fixture".into(),
            device_session_id: "device".into(),
        };
        let now = Instant::now();
        let (snapshot, token) = service
            .registry
            .reserve(
                "first",
                owner.clone(),
                crate::session::CaptureSelection {
                    source_ref: "display".into(),
                    stream_region: None,
                    control_region: None,
                },
                now,
            )
            .unwrap();
        service
            .registry
            .attach(
                &snapshot.viewer_session_id,
                &owner,
                &crate::session::CaptureSelection {
                    source_ref: "display".into(),
                    stream_region: None,
                    control_region: None,
                },
                &token,
                now,
            )
            .unwrap();
        service
            .fail_backend(
                &snapshot.viewer_session_id,
                crate::error::BackendError::InputPermissionRequired,
            )
            .await;
        let failed = service
            .registry
            .snapshot(&snapshot.viewer_session_id, &owner)
            .unwrap();
        assert_eq!(failed.phase, Phase::Failed);
        assert_eq!(
            failed.reason.as_deref(),
            Some("REMOTE_DESKTOP_INPUT_PERMISSION_REQUIRED")
        );
        assert!(service
            .registry
            .reserve(
                "replacement",
                owner,
                crate::session::CaptureSelection {
                    source_ref: "display".into(),
                    stream_region: None,
                    control_region: None
                },
                Instant::now()
            )
            .is_ok());
    }

    #[tokio::test]
    async fn fallback_activates_capture_without_webrtc_connected_and_survives_pair_reconnect() {
        let (events, _receiver) = mpsc::channel(16);
        let mut service = Service {
            registry: Registry::new(),
            live: HashMap::new(),
            input_guard: None,
            input_guard_backend: None,
            mode: crate::capture::Mode::Synthetic,
            show_cursor: true,
            source_salt: crate::session::secret(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            catalog: None,
            display_catalog: None,
            pending_source: HashMap::new(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            selected_source: HashMap::new(),
            #[cfg(target_os = "linux")]
            surface: None,
            events: events.clone(),
            fallbacks: HashMap::new(),
        };
        let owner = Owner {
            actor_id: "fixture".into(),
            device_session_id: "device".into(),
        };
        let target = crate::session::CaptureSelection {
            source_ref: "display".into(),
            stream_region: None,
            control_region: None,
        };
        let now = Instant::now();
        let (snapshot, token) = service
            .registry
            .reserve("fallback", owner.clone(), target.clone(), now)
            .unwrap();
        let viewer = snapshot.viewer_session_id;
        service
            .registry
            .attach(&viewer, &owner, &target, &token, now)
            .unwrap();
        let peer = MediaPeer::new(viewer.clone(), events).await.unwrap();
        let control = peer.control();
        service.live.insert(
            viewer.clone(),
            LivePeer {
                id: viewer.clone(),
                owner: owner.clone(),
                input_backend: None,
                peer,
                control: control.clone(),
                channels: HashMap::new(),
                decoder: Decoder::default(),
                reply_seq: 0,
                clipboard_enabled: false,
                clipboard: String::new(),
                native_clipboard: None,
                ice_expires_at: None,
                pending_ice_expires_at: None,
                ice_restart_pending: false,
                fallback_generation: None,
                fallback_active: false,
                fallback_control: None,
                webrtc_connected: false,
            },
        );

        let (media, mut media_rx) = mpsc::channel(4);
        let (control_ws, mut control_rx) = mpsc::channel(8);
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        service
            .fallback_event(FallbackEvent::Attach {
                role: Role::Media,
                generation: "fgen_pair".into(),
                viewer: viewer.clone(),
                owner: owner.clone(),
                capture_selection: target.clone(),
                media: Some(media),
                control: None,
                reply,
            })
            .await
            .unwrap();
        assert!(reply_rx.await.unwrap().is_ok());
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        service
            .fallback_event(FallbackEvent::Attach {
                role: Role::Control,
                generation: "fgen_pair".into(),
                viewer: viewer.clone(),
                owner: owner.clone(),
                capture_selection: target.clone(),
                media: None,
                control: Some(control_ws),
                reply,
            })
            .await
            .unwrap();
        assert!(reply_rx.await.unwrap().is_ok());

        let frame = tokio::time::timeout(Duration::from_secs(10), media_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(frame.keyframe);
        assert!(!frame.data.is_empty());
        service
            .fallback_event(FallbackEvent::MediaStarted {
                generation: "fgen_pair".into(),
            })
            .await
            .unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(1), control_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(ready.contains("fallback.ready"));
        let active = service.registry.snapshot(&viewer, &owner).unwrap();
        assert_eq!(active.phase, Phase::Active);
        assert_eq!(active.transport, "websocket-fallback");
        assert!(!active.media_paused);

        service
            .fallback_event(FallbackEvent::Detach {
                role: Role::Media,
                generation: "fgen_pair".into(),
            })
            .await
            .unwrap();
        assert!(control.paused.load(Ordering::SeqCst));
        assert_eq!(
            service
                .registry
                .snapshot(&viewer, &owner)
                .unwrap()
                .transport,
            "websocket-fallback"
        );

        let (media, mut media_rx) = mpsc::channel(4);
        let (control_ws, mut control_rx) = mpsc::channel(8);
        for (role, media, control) in [
            (Role::Media, Some(media), None),
            (Role::Control, None, Some(control_ws)),
        ] {
            let (reply, reply_rx) = tokio::sync::oneshot::channel();
            service
                .fallback_event(FallbackEvent::Attach {
                    role,
                    generation: "fgen_2".into(),
                    viewer: viewer.clone(),
                    owner: owner.clone(),
                    capture_selection: target.clone(),
                    media,
                    control,
                    reply,
                })
                .await
                .unwrap();
            assert!(reply_rx.await.unwrap().is_ok());
        }
        assert!(!control.paused.load(Ordering::SeqCst));
        let frame = tokio::time::timeout(Duration::from_secs(10), media_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(!frame.data.is_empty());
        service
            .fallback_event(FallbackEvent::MediaStarted {
                generation: "fgen_2".into(),
            })
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), control_rx.recv())
                .await
                .unwrap()
                .unwrap()
                .contains("fallback.ready")
        );

        if let Some(live) = service.live.remove(&viewer) {
            live.peer.close().await;
        }
    }
}
