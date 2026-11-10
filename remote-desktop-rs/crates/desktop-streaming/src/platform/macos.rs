//! ScreenCaptureKit for both display and desktop-independent window capture.
//! CrabGrab 0.4 uses CGDisplayStream for displays, so it cannot implement this
//! boundary. The maintained SCK binding owns native retains, callbacks and Swift
//! bridging; this adapter owns only bounded frames and redacted backend errors.
use super::frame_mailbox::FrameMailbox;
use crate::{
    error::BackendError,
    traits::{Geometry, RawFrame},
};
use core_graphics::access::ScreenCaptureAccess;
use screencapturekit::{cm::SCFrameStatus, cv::CVPixelBufferLockFlags, prelude::*};
use std::time::Instant;

#[derive(Clone)]
pub enum Target {
    Display(SCDisplay),
    Window(SCWindow),
}
struct Output(FrameMailbox<(CMSampleBuffer, Instant)>);
impl SCStreamOutputTrait for Output {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
        if !matches!(kind, SCStreamOutputType::Screen) {
            return;
        }
        match sample.frame_status() {
            Some(SCFrameStatus::Complete | SCFrameStatus::Started) => {
                self.0.publish((sample, Instant::now()))
            }
            Some(SCFrameStatus::Idle) => {}
            Some(SCFrameStatus::Blank | SCFrameStatus::Suspended) => {
                self.0.fail(BackendError::DesktopUnavailable);
            }
            Some(SCFrameStatus::Stopped) => {
                self.0.fail(BackendError::CaptureFailed);
            }
            _ => {}
        }
    }
}
struct Delegate(FrameMailbox<(CMSampleBuffer, Instant)>);
impl SCStreamDelegateTrait for Delegate {
    fn did_stop_with_error(&self, _error: SCError) {
        // No native description/title/path crosses the adapter boundary.
        self.0.fail(BackendError::CaptureFailed);
    }
}
pub fn preflight() -> anyhow::Result<()> {
    // The maintained binding's window-capture example requires its CG
    // initializer before SCContentFilter(desktopIndependentWindow:). Merely
    // fetching SCShareableContent does not initialize the process connection:
    // native macOS27.2 otherwise aborts in SLSGetDisplaysWithRect/CGS_REQUIRE_INIT.
    // Initialize once for every entry path, rather than accidentally relying on
    // a preceding display capture or another library's CGMainDisplayID call.
    static INITIALIZE: std::sync::Once = std::sync::Once::new();
    INITIALIZE.call_once(|| {
        // This is the exact operation in the binding's Swift initializer; use
        // the maintained public CoreGraphics wrapper instead of private FFI.
        let _ = core_graphics::display::CGDisplay::main();
    });
    anyhow::ensure!(
        ScreenCaptureAccess.preflight(),
        BackendError::ScreenPermissionRequired
    );
    Ok(())
}
pub struct Capture {
    target: Target,
    filter: SCContentFilter,
    config: SCStreamConfiguration,
    geometry: Geometry,
    display_geometry: Option<super::display_geometry::DisplayGeometry>,
    pixel_size: (usize, usize),
    window: Option<(super::macos_window::Identity, super::macos_window::Lease)>,
    stream: Option<SCStream>,
    latest: FrameMailbox<(CMSampleBuffer, Instant)>,
}
impl Capture {
    pub async fn primary_display() -> anyhow::Result<Self> {
        Self::primary_display_with_cursor(true).await
    }
    pub async fn primary_display_with_cursor(show_cursor: bool) -> anyhow::Result<Self> {
        tokio::task::spawn_blocking(move || {
            preflight()?;
            let content = SCShareableContent::get()
                .map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))?;
            let display = content
                .displays()
                .into_iter()
                .find(|display| {
                    display.display_id() == core_graphics::display::CGDisplay::main().id
                })
                .ok_or_else(|| anyhow::anyhow!(BackendError::NoInteractiveSession))?;
            Self::new_with_cursor(Target::Display(display), show_cursor)
        })
        .await?
    }
    pub fn new(target: Target) -> anyhow::Result<Self> {
        Self::new_with_cursor(target, true)
    }
    pub fn new_with_cursor(target: Target, show_cursor: bool) -> anyhow::Result<Self> {
        preflight()?;
        let retained_target = target.clone();
        let display_target = matches!(&target, Target::Display(_));
        let mut window_lease = None;
        let (rect, width, height, filter) = match target {
            Target::Display(display) => {
                let rect = display.frame();
                let filter = SCContentFilter::create()
                    .with_display(&display)
                    .with_excluding_windows(&[])
                    .build()
                    .map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))?;
                (rect, display.width(), display.height(), filter)
            }
            Target::Window(window) => {
                anyhow::ensure!(
                    window.is_on_screen() && window.window_layer() == 0,
                    BackendError::WindowUnavailable
                );
                let rect = window.frame();
                let geometry = Geometry::from_actuator_rect(
                    rect.origin.x,
                    rect.origin.y,
                    rect.size.width,
                    rect.size.height,
                )?;
                let identity = super::macos_window::Identity {
                    window: window.window_id(),
                    pid: window
                        .owning_application()
                        .ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))?
                        .process_id(),
                };
                window_lease = Some((
                    identity,
                    super::macos_window::Lease::bind(identity, geometry)?,
                ));
                let filter = SCContentFilter::create()
                    .with_window(&window)
                    .build()
                    .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))?;
                (
                    rect,
                    rect.size.width.round() as u32,
                    rect.size.height.round() as u32,
                    filter,
                )
            }
        };
        let geometry = Geometry::from_actuator_rect(
            rect.origin.x,
            rect.origin.y,
            rect.size.width,
            rect.size.height,
        )?;
        let display_geometry = display_target
            .then(|| super::display_geometry::DisplayGeometry::bind(geometry))
            .transpose()?;
        anyhow::ensure!(
            width > 0 && height > 0 && width <= 8192 && height <= 8192,
            BackendError::InvalidGeometry
        );
        let config = SCStreamConfiguration::new()
            .with_width(width)
            .with_height(height)
            .with_pixel_format(PixelFormat::BGRA)
            .with_shows_cursor(show_cursor)
            .with_captures_audio(false)
            .with_minimum_frame_interval(&CMTime::new(1, 30))
            // SCK requires >=3 OS driver buffers. The application retains only
            // latest sample + one in flight (no raw-frame queue); never bypass
            // the maintained binding's documented native minimum.
            .with_queue_depth(3);
        Ok(Self {
            target: retained_target,
            filter,
            config,
            geometry,
            display_geometry,
            pixel_size: (width as usize, height as usize),
            window: window_lease,
            stream: None,
            latest: FrameMailbox::default(),
        })
    }
    pub fn retained_target(&self) -> Target {
        self.target.clone()
    }
    pub fn window_input(&self) -> Option<(super::macos_window::Identity, Geometry)> {
        self.window.as_ref().map(|(id, _)| (*id, self.geometry))
    }
    pub fn refresh_geometry(&mut self) -> anyhow::Result<Geometry> {
        if let Some((_, lease)) = &self.window {
            let current = lease.geometry()?;
            anyhow::ensure!(
                current.width <= 8192 && current.height <= 8192,
                BackendError::InvalidGeometry
            );
            if current != self.geometry {
                self.pause()?;
                self.geometry = current;
                self.pixel_size = (current.width as usize, current.height as usize);
                self.config = self
                    .config
                    .clone()
                    .with_width(current.width)
                    .with_height(current.height);
            }
        } else if let Some(display) = &self.display_geometry {
            display.validate()?;
        }
        Ok(self.geometry)
    }
    pub fn geometry(&self) -> Geometry {
        self.geometry
    }
    pub fn resume(&mut self) -> anyhow::Result<()> {
        if self.stream.is_some() {
            return Ok(());
        }
        preflight()?;
        // Fresh mailbox isolates late callbacks from an obsolete stream.
        self.latest = FrameMailbox::default();
        let mut stream =
            SCStream::new_with_delegate(&self.filter, &self.config, Delegate(self.latest.clone()))
                .map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))?;
        stream
            .add_output_handler(Output(self.latest.clone()), SCStreamOutputType::Screen)
            .map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))?;
        stream
            .start_capture()
            .map_err(|_| anyhow::anyhow!(BackendError::CaptureFailed))?;
        self.stream = Some(stream);
        Ok(())
    }
    pub fn pause(&mut self) -> anyhow::Result<()> {
        let result = if let Some(stream) = self.stream.take() {
            stream
                .stop_capture()
                .map_err(|_| anyhow::anyhow!(BackendError::CaptureStopFailed))
        } else {
            Ok(())
        };
        self.latest = FrameMailbox::default();
        result
    }
    pub fn frame(&mut self, _force: bool) -> anyhow::Result<Option<RawFrame>> {
        if let Some(display) = &self.display_geometry {
            display.validate()?;
        }
        self.resume()?;
        let sample = self.latest.snapshot()?;
        let Some((sample, captured_at)) = sample else {
            return Ok(None);
        };
        let buffer = sample
            .pixel_buffer()
            .ok_or_else(|| anyhow::anyhow!(BackendError::CaptureFailed))?;
        let guard = buffer
            .lock(CVPixelBufferLockFlags::READ_ONLY)
            .map_err(|_| anyhow::anyhow!(BackendError::CaptureFailed))?;
        let (width, height, stride) = (guard.width(), guard.height(), guard.bytes_per_row());
        anyhow::ensure!(
            (width, height) == self.pixel_size,
            BackendError::GeometryChanged
        );
        anyhow::ensure!(
            stride >= width * 4 && stride <= 8192 * 4,
            BackendError::CaptureFormatUnsupported
        );
        // The maintained read-only lock pins this non-planar BGRA buffer for
        // the slice lifetime; copy exactly its bounded rows before unlocking.
        let bytes = unsafe { guard.as_slice() }
            .ok_or_else(|| anyhow::anyhow!(BackendError::CaptureFailed))?;
        let length = height
            .checked_mul(stride)
            .ok_or_else(|| anyhow::anyhow!(BackendError::InvalidGeometry))?;
        anyhow::ensure!(bytes.len() >= length, BackendError::CaptureFailed);
        Ok(Some(RawFrame {
            bgra: bytes[..length].to_vec(),
            stride,
            geometry: Geometry {
                x: 0,
                y: 0,
                width: width as u32,
                height: height as u32,
                scale: 1.0,
            },
            captured_at,
        }))
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.pause();
    }
}

#[derive(Default)]
pub struct WindowCatalog {
    references: crate::catalog::Catalog<Option<Capture>>,
}
impl WindowCatalog {
    pub async fn enumerate(
        &mut self,
        owner: crate::session::Owner,
    ) -> anyhow::Result<Vec<crate::catalog::WindowEntry>> {
        self.references.invalidate();
        let windows = tokio::task::spawn_blocking(|| {
            preflight()?;
            let content = SCShareableContent::get()
                .map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))?;
            let mut result = Vec::new();
            for window in content.windows() {
                if !window.is_on_screen() || window.window_layer() != 0 {
                    continue;
                }
                let rect = window.frame();
                let Ok(g) = Geometry::from_actuator_rect(
                    rect.origin.x,
                    rect.origin.y,
                    rect.size.width,
                    rect.size.height,
                ) else {
                    continue;
                };
                let Some(app) = window.owning_application() else {
                    continue;
                };
                let capture = Capture::new(Target::Window(window.clone()));
                let reason = capture
                    .as_ref()
                    .err()
                    .map(|e| BackendError::from_error(e).to_string());
                result.push(crate::catalog::NativeWindow {
                    identity: format!("sck:{}:{}", window.window_id(), app.process_id()),
                    handle: capture.ok(),
                    unavailable_reason: reason,
                    title: window.title().unwrap_or_default(),
                    application_name: app.application_name(),
                    width: g.width,
                    height: g.height,
                });
                if result.len() > crate::catalog::MAX_WINDOWS {
                    break;
                }
            }
            Ok::<_, anyhow::Error>(result)
        })
        .await??;
        self.references
            .publish(owner, windows, Instant::now())
            .map_err(Into::into)
    }
    pub async fn consume(
        &mut self,
        reference: &str,
        owner: &crate::session::Owner,
    ) -> anyhow::Result<Capture> {
        let retained = match self.references.consume(reference, owner, Instant::now()) {
            Ok(capture) => capture,
            Err(crate::catalog::CatalogError::InvalidReference) => {
                // Stable window identities survive refreshes, but retained
                // native captures are short-lived. Re-enumerate and resolve the
                // same reference instead of rotating it.
                self.enumerate(owner.clone()).await?;
                self.references.consume(reference, owner, Instant::now())?
            }
            Err(error) => return Err(error.into()),
        };
        let mut capture =
            retained.ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))?;
        capture.refresh_geometry()?;
        Ok(capture)
    }
}
