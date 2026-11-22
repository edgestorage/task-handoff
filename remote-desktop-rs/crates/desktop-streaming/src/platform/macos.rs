//! ScreenCaptureKit for both display and desktop-independent window capture.
//! CrabGrab 0.4 uses CGDisplayStream for displays, so it cannot implement this
//! boundary. The maintained SCK binding owns native retains, callbacks and Swift
//! bridging; this adapter owns only bounded frames and redacted backend errors.
use super::frame_mailbox::FrameMailbox;
use crate::{
    capture::resolve_capture_size,
    error::BackendError,
    traits::{CapturePrecision, Geometry, NormalizedRect, PointerMapping},
    video::{Frame, Native420Frame},
};
use apple_cf::cv::{CVPixelBuffer, CVPixelBufferLockFlags};
use core_graphics::access::ScreenCaptureAccess;
use screencapturekit::{cm::SCFrameStatus, prelude::*};
use std::time::{Duration, Instant};

const STATIC_FRAME_HEARTBEAT: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub enum Target {
    Display(SCDisplay),
    Window(SCWindow),
}
#[derive(Clone)]
pub struct DisplayTarget {
    display: SCDisplay,
}
#[derive(Clone, Copy, PartialEq)]
struct ContentKey {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}
#[derive(Default)]
struct FrameCadence {
    emitted_display_time: Option<u64>,
    emitted_signature: Option<(u32, u32)>,
    emitted_at: Option<Instant>,
    dirty_rects_observed: bool,
}
impl FrameCadence {
    /// ScreenCaptureKit may deliver callbacks at the capture frame rate even when the captured
    /// surface did not change. Window capture on supported macOS releases can
    /// omit dirtyRects, so the native plane signature is the primary detector.
    /// Display time remains available as a conservative last resort.
    fn should_emit(
        &mut self,
        display_time: Option<u64>,
        dirty: Option<bool>,
        signature: Option<(u32, u32)>,
        force: bool,
        now: Instant,
    ) -> bool {
        if dirty.is_some() {
            self.dirty_rects_observed = true;
        }
        let display_time_changed =
            display_time.is_some_and(|sample| self.emitted_display_time != Some(sample));
        let changed = match (signature, dirty) {
            (Some(signature), _) => self
                .emitted_signature
                .is_none_or(|emitted| emitted != signature),
            (None, Some(changed)) => changed,
            (None, None) if self.dirty_rects_observed => false,
            (None, None) => display_time.is_none() || display_time_changed,
        };
        let heartbeat = self
            .emitted_at
            .is_none_or(|emitted| now.saturating_duration_since(emitted) >= STATIC_FRAME_HEARTBEAT);
        if !force && !changed && !heartbeat {
            return false;
        }
        if let Some(display_time) = display_time {
            self.emitted_display_time = Some(display_time);
        }
        if signature.is_some() {
            self.emitted_signature = signature;
        }
        self.emitted_at = Some(now);
        true
    }

    fn reset(&mut self) {
        self.emitted_display_time = None;
        self.emitted_signature = None;
        self.emitted_at = None;
        self.dirty_rects_observed = false;
    }
}

fn native_420v_signature(buffer: &CVPixelBuffer) -> Option<(u32, u32)> {
    let guard = buffer.lock(CVPixelBufferLockFlags::READ_ONLY).ok()?;
    if !buffer.is_planar() || guard.plane_count() != 2 {
        return None;
    }
    Some((hash_plane(&guard, 0)?, hash_plane(&guard, 1)?))
}

fn hash_plane(guard: &apple_cf::cv::CVPixelBufferLockGuard<'_>, plane: usize) -> Option<u32> {
    let width = guard.width_of_plane(plane);
    let height = guard.height_of_plane(plane);
    let stride = guard.bytes_per_row_of_plane(plane);
    if width == 0 || height == 0 || stride < width {
        return None;
    }
    let data = unsafe { guard.plane_data(plane) }?;
    let length = height.checked_mul(stride)?;
    if data.len() < length {
        return None;
    }
    if width == stride {
        return Some(crc32fast::hash(&data[..length]));
    }
    let mut hasher = crc32fast::Hasher::new();
    for row in data.chunks_exact(stride).take(height) {
        hasher.update(&row[..width]);
    }
    Some(hasher.finalize())
}
#[derive(Default)]
struct ScaleTracker {
    queried: Option<(f64, f64)>,
    observed: Option<(f64, f64)>,
}
impl ScaleTracker {
    fn new(queried: (f64, f64)) -> Self {
        Self {
            queried: Some(queried),
            observed: None,
        }
    }
    /// ScreenCaptureKit frame metadata is authoritative for the display that
    /// actually produced the frame. Some long-lived processes keep returning a
    /// stale CoreGraphics mode after display topology changes, so prefer the
    /// observed scale until CoreGraphics itself reports a different mode.
    fn effective(&mut self, queried: (f64, f64)) -> (f64, f64) {
        if self
            .queried
            .is_none_or(|previous| !same_scale(previous, queried))
        {
            self.observed = None;
        }
        self.queried = Some(queried);
        self.observed.unwrap_or(queried)
    }
    fn observe(&mut self, observed: Option<(f64, f64)>) {
        if let Some(scale) = observed.filter(|(x, y)| valid_scale(*x) && valid_scale(*y)) {
            self.observed = Some(scale);
        }
    }
}
impl DisplayTarget {
    pub fn source(&self, show_cursor: bool) -> anyhow::Result<crate::capture::Source> {
        Capture::new_with_cursor(Target::Display(self.display.clone()), show_cursor)
            .map(|capture| crate::capture::Source::Native(Box::new(capture)))
    }
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
    capture_bounds: Geometry,
    pointer_mapping: PointerMapping,
    content_key: Option<ContentKey>,
    capture_size: (u32, u32),
    scale: (f64, f64),
    scale_tracker: ScaleTracker,
    precision: CapturePrecision,
    display_geometry: Option<super::display_geometry::DisplayGeometry>,
    pixel_size: (usize, usize),
    window: Option<super::macos_window::Identity>,
    stream: Option<SCStream>,
    latest: FrameMailbox<(CMSampleBuffer, Instant)>,
    cadence: FrameCadence,
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
        let mut window_identity = None;
        let (rect, width, height, filter) = match &target {
            Target::Display(display) => {
                let rect = display.frame();
                let filter = SCContentFilter::create()
                    .with_display(display)
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
                let identity = super::macos_window::Identity {
                    window: window.window_id(),
                    pid: window
                        .owning_application()
                        .ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))?
                        .process_id(),
                };
                window_identity = Some(identity);
                let filter = SCContentFilter::create()
                    .with_window(window)
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
        let capture_bounds = match window_identity {
            Some(identity) => super::macos_window::capture_bounds(identity).unwrap_or_else(|error| {
                eprintln!(
                    "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.bounds_query.error window={geometry:?} error={error}"
                );
                geometry
            }),
            None => geometry,
        };
        anyhow::ensure!(
            width > 0 && height > 0 && width <= 8192 && height <= 8192,
            BackendError::InvalidGeometry
        );
        let precision = CapturePrecision::Auto;
        let scale = capture_scale_for(&retained_target, capture_bounds);
        let capture_size = capture_size_for_scaled_bounds(
            capture_bounds.width,
            capture_bounds.height,
            precision,
            scale.0,
            scale.1,
        )?;
        let config = SCStreamConfiguration::new()
            .with_width(capture_size.0)
            .with_height(capture_size.1)
            .with_pixel_format(PixelFormat::YCbCr_420v)
            .with_shows_cursor(show_cursor)
            .with_captures_audio(false)
            .with_minimum_frame_interval(&CMTime::new(1, 60))
            // SCK requires >=3 OS driver buffers. The application retains only
            // latest sample + one in flight (no raw-frame queue); never bypass
            // the maintained binding's documented native minimum.
            .with_queue_depth(3);
        Ok(Self {
            target: retained_target,
            filter,
            config,
            geometry,
            capture_bounds,
            pointer_mapping: PointerMapping::from_geometry(capture_bounds),
            content_key: None,
            capture_size,
            scale,
            scale_tracker: ScaleTracker::new(scale),
            precision,
            display_geometry,
            pixel_size: (capture_size.0 as usize, capture_size.1 as usize),
            window: window_identity,
            stream: None,
            latest: FrameMailbox::default(),
            cadence: FrameCadence::default(),
        })
    }
    pub fn retained_target(&self) -> Target {
        self.target.clone()
    }
    pub fn window_input(&self) -> Option<(super::macos_window::Identity, Geometry)> {
        self.window.map(|identity| (identity, self.geometry))
    }
    pub fn set_capture_precision(&mut self, precision: CapturePrecision) -> anyhow::Result<bool> {
        if precision == self.precision {
            return Ok(false);
        }
        self.precision = precision;
        self.reconfigure_capture_size(self.scale)?;
        Ok(true)
    }
    pub fn capture_dimensions(&self) -> (u32, u32) {
        self.capture_size
    }
    fn reconfigure_capture_size(&mut self, scale: (f64, f64)) -> anyhow::Result<()> {
        let next = capture_size_for_scaled_bounds(
            self.capture_bounds.width,
            self.capture_bounds.height,
            self.precision,
            scale.0,
            scale.1,
        )?;
        if next == self.capture_size && same_scale(scale, self.scale) {
            return Ok(());
        }
        self.pause()?;
        self.content_key = None;
        self.scale = scale;
        self.capture_size = next;
        self.pixel_size = (next.0 as usize, next.1 as usize);
        self.config = self.config.clone().with_width(next.0).with_height(next.1);
        Ok(())
    }
    pub fn refresh_geometry(&mut self) -> anyhow::Result<Geometry> {
        if let Some(identity) = self.window {
            let query_started = Instant::now();
            let layout = match super::macos_window::capture_layout(identity) {
                Ok(layout) => layout,
                Err(error) => {
                    eprintln!(
                        "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.geometry_query.error elapsedMs={} error={error}",
                        query_started.elapsed().as_millis()
                    );
                    return Err(error);
                }
            };
            let current = layout.geometry;
            let bounds = layout.capture_bounds;
            anyhow::ensure!(
                current.width <= 8192 && current.height <= 8192,
                BackendError::InvalidGeometry
            );
            let queried_scale = capture_scale_for(&self.target, bounds);
            let scale = self.scale_tracker.effective(queried_scale);
            let next_capture_size = capture_size_for_scaled_bounds(
                bounds.width,
                bounds.height,
                self.precision,
                scale.0,
                scale.1,
            )?;
            let window_changed = current != self.geometry;
            let bounds_changed = bounds != self.capture_bounds;
            let size_changed = next_capture_size != self.capture_size;
            let scale_changed = !same_scale(scale, self.scale);
            if window_changed || bounds_changed || size_changed || scale_changed {
                eprintln!(
                    "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.geometry_changed queryMs={} windowFrom={:?} windowTo={current:?} boundsFrom={:?} boundsTo={bounds:?} captureFrom={:?} captureTo={next_capture_size:?} scaleFrom={:?} scaleTo={scale:?} windowChanged={window_changed} boundsChanged={bounds_changed}",
                    query_started.elapsed().as_millis(),
                    self.geometry,
                    self.capture_bounds,
                    self.capture_size,
                    self.scale,
                );
                let pause_started = Instant::now();
                let pause_result = self.pause();
                eprintln!(
                    "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.pause elapsedMs={} result={}",
                    pause_started.elapsed().as_millis(),
                    if pause_result.is_ok() { "ok" } else { "error" }
                );
                if let Err(error) = &pause_result {
                    eprintln!(
                        "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.pause.error error={error}"
                    );
                }
                pause_result?;
                self.geometry = current;
                self.capture_bounds = bounds;
                if window_changed || bounds_changed {
                    self.pointer_mapping = PointerMapping::from_geometry(bounds);
                    self.content_key = None;
                }
                self.scale = scale;
                if size_changed {
                    self.capture_size = next_capture_size;
                    self.pixel_size = (next_capture_size.0 as usize, next_capture_size.1 as usize);
                    self.config = self
                        .config
                        .clone()
                        .with_width(next_capture_size.0)
                        .with_height(next_capture_size.1);
                }
            }
        } else if let Some(display) = &self.display_geometry {
            display.validate()?;
        }
        if self.window.is_none() && self.display_geometry.is_some() {
            let queried_scale = capture_scale_for(&self.target, self.capture_bounds);
            let scale = self.scale_tracker.effective(queried_scale);
            self.reconfigure_capture_size(scale)?;
        }
        Ok(self.geometry)
    }
    pub fn geometry(&self) -> Geometry {
        self.geometry
    }
    pub fn pointer_mapping(&self) -> PointerMapping {
        self.pointer_mapping
    }
    pub fn resume(&mut self) -> anyhow::Result<()> {
        if self.stream.is_some() {
            return Ok(());
        }
        let started = Instant::now();
        eprintln!(
            "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.resume.start geometry={:?} captureSize={:?}",
            self.geometry, self.capture_size
        );
        let result = (|| -> anyhow::Result<()> {
            preflight()?;
            // Fresh mailbox isolates late callbacks from an obsolete stream.
            self.latest = FrameMailbox::default();
            self.cadence.reset();
            let mut stream = SCStream::new_with_delegate(
                &self.filter,
                &self.config,
                Delegate(self.latest.clone()),
            )
            .map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))?;
            stream
                .add_output_handler(Output(self.latest.clone()), SCStreamOutputType::Screen)
                .map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))?;
            stream
                .start_capture()
                .map_err(|_| anyhow::anyhow!(BackendError::CaptureFailed))?;
            self.stream = Some(stream);
            Ok(())
        })();
        match &result {
            Ok(()) => eprintln!(
                "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.resume.end elapsedMs={} result=ok",
                started.elapsed().as_millis()
            ),
            Err(error) => eprintln!(
                "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.resume.end elapsedMs={} result=error error={error}",
                started.elapsed().as_millis()
            ),
        }
        result
    }
    pub fn pause(&mut self) -> anyhow::Result<()> {
        let had_stream = self.stream.is_some();
        let started = Instant::now();
        let result = if let Some(stream) = self.stream.take() {
            stream
                .stop_capture()
                .map_err(|_| anyhow::anyhow!(BackendError::CaptureStopFailed))
        } else {
            Ok(())
        };
        self.latest = FrameMailbox::default();
        self.cadence.reset();
        if had_stream {
            eprintln!(
                "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.stop elapsedMs={} result={}",
                started.elapsed().as_millis(),
                if result.is_ok() { "ok" } else { "error" }
            );
        }
        result
    }
    pub fn frame(&mut self, force: bool) -> anyhow::Result<Option<Frame>> {
        self.resume()?;
        let sample = self.latest.snapshot()?;
        let Some((sample, captured_at)) = sample else {
            return Ok(None);
        };
        let frame_info = sample.frame_info();
        if let Some(info) = &frame_info {
            let frame_scale = info
                .scale_factor
                .filter(|scale| valid_scale(*scale))
                .map(|scale| (scale, scale));
            if let Some(scale) = frame_scale {
                self.scale_tracker.observe(Some(scale));
                if !same_scale(scale, self.scale) {
                    eprintln!(
                        "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.scale_changed window={:?} configured={:?} observed={scale:?} captureSize={:?}",
                        self.geometry, self.scale, self.capture_size
                    );
                    self.content_key = None;
                    return Ok(None);
                }
            }
            if let Some(content_rect) = info.content_rect {
                let scale = frame_scale.map(|scale| scale.0).unwrap_or(1.0);
                let key = ContentKey {
                    x: content_rect.origin.x,
                    y: content_rect.origin.y,
                    width: content_rect.size.width,
                    height: content_rect.size.height,
                    scale,
                };
                if self.content_key != Some(key) {
                    let screen = self.capture_bounds;
                    match normalized_content_rect(content_rect, self.pixel_size, scale) {
                        Some(content) => match PointerMapping::new(screen, content) {
                            Ok(mapping) if mapping != self.pointer_mapping => {
                                eprintln!(
                                    "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.pointer_mapping window={:?} screen={screen:?} rawContent={content_rect:?} pixelSize={:?} scale={scale} content={content:?} mapping={mapping:?}",
                                    self.geometry, self.pixel_size
                                );
                                self.pointer_mapping = mapping;
                                self.content_key = Some(key);
                            }
                            Ok(_) => self.content_key = Some(key),
                            Err(error) => {
                                eprintln!(
                                        "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.pointer_mapping.error window={:?} error={error}",
                                        self.geometry
                                    );
                            }
                        },
                        None => {
                            eprintln!(
                                "REMOTE_DESKTOP_GEOMETRY_TRACE phase=capture.pointer_mapping.error window={:?} content={content_rect:?} pixelSize={:?} scale={scale} error=invalid_content_rect",
                                self.geometry, self.pixel_size,
                            );
                        }
                    }
                }
            }
        }
        let buffer = sample
            .pixel_buffer()
            .ok_or_else(|| anyhow::anyhow!(BackendError::CaptureFailed))?;
        anyhow::ensure!(
            buffer.pixel_format() == u32::from_be_bytes(*b"420v")
                && buffer.is_planar()
                && buffer.plane_count() == 2,
            BackendError::CaptureFormatUnsupported
        );
        let (width, height) = (buffer.width(), buffer.height());
        anyhow::ensure!(
            (width, height) == self.pixel_size,
            BackendError::GeometryChanged
        );
        let display_time = frame_info.as_ref().and_then(|info| info.display_time);
        let dirty = frame_info
            .as_ref()
            .and_then(|info| info.dirty_rects.as_ref())
            .map(|rects| {
                rects
                    .iter()
                    .any(|rect| rect.size.width > 0.0 && rect.size.height > 0.0)
            });
        let signature = native_420v_signature(&buffer);
        if !self
            .cadence
            .should_emit(display_time, dirty, signature, force, Instant::now())
        {
            return Ok(None);
        }
        Ok(Some(Frame::Native420(Native420Frame {
            buffer,
            geometry: Geometry {
                x: 0,
                y: 0,
                width: width as u32,
                height: height as u32,
                scale: 1.0,
            },
            captured_at,
        })))
    }
}

/// `contentRect` is expressed in surface points, while the pixel buffer uses
/// output pixels. A fixed SCStream canvas can also contain letterbox bars when
/// menus enlarge the captured screen union, so both scale and offset matter.
fn normalized_content_rect(
    content: screencapturekit::cg::CGRect,
    pixel_size: (usize, usize),
    scale_factor: f64,
) -> Option<NormalizedRect> {
    let surface_width = pixel_size.0 as f64;
    let surface_height = pixel_size.1 as f64;
    if surface_width <= 0.0
        || surface_height <= 0.0
        || !scale_factor.is_finite()
        || scale_factor <= 0.0
    {
        return None;
    }
    NormalizedRect::new(
        content.origin.x * scale_factor / surface_width,
        content.origin.y * scale_factor / surface_height,
        content.size.width * scale_factor / surface_width,
        content.size.height * scale_factor / surface_height,
    )
    .ok()
}

fn backing_scale_for_display(display: core_graphics::display::CGDisplay) -> (f64, f64) {
    let Some(mode) = display.display_mode() else {
        return (1.0, 1.0);
    };
    let width = mode.width() as f64;
    let height = mode.height() as f64;
    let pixel_width = mode.pixel_width() as f64;
    let pixel_height = mode.pixel_height() as f64;
    if width <= 0.0 || height <= 0.0 || pixel_width <= 0.0 || pixel_height <= 0.0 {
        return (1.0, 1.0);
    }
    (pixel_width / width, pixel_height / height)
}

fn backing_scale_for_window(origin_x: f64, origin_y: f64, width: f64, height: f64) -> (f64, f64) {
    use core_graphics::display::CGDisplay;
    let center_x = origin_x + width / 2.0;
    let center_y = origin_y + height / 2.0;
    let mut displays = CGDisplay::active_displays()
        .unwrap_or_default()
        .into_iter()
        .map(CGDisplay::new)
        .filter(|display| {
            let bounds = display.bounds();
            center_x >= bounds.origin.x
                && center_x < bounds.origin.x + bounds.size.width
                && center_y >= bounds.origin.y
                && center_y < bounds.origin.y + bounds.size.height
        });
    let display = displays.next().unwrap_or_else(CGDisplay::main);
    backing_scale_for_display(display)
}

fn valid_scale(scale: f64) -> bool {
    scale.is_finite() && scale > 0.0
}

fn same_scale(left: (f64, f64), right: (f64, f64)) -> bool {
    (left.0 - right.0).abs() < 0.001 && (left.1 - right.1).abs() < 0.001
}

fn capture_scale_for(target: &Target, bounds: Geometry) -> (f64, f64) {
    match target {
        Target::Display(display) => {
            backing_scale_for_display(core_graphics::display::CGDisplay::new(display.display_id()))
        }
        Target::Window(_) => backing_scale_for_window(
            f64::from(bounds.x),
            f64::from(bounds.y),
            f64::from(bounds.width),
            f64::from(bounds.height),
        ),
    }
}

fn capture_size_for_scaled_bounds(
    logical_width: u32,
    logical_height: u32,
    precision: CapturePrecision,
    scale_x: f64,
    scale_y: f64,
) -> anyhow::Result<(u32, u32)> {
    let native_width = (f64::from(logical_width) * scale_x).round().max(1.0);
    let native_height = (f64::from(logical_height) * scale_y).round().max(1.0);
    anyhow::ensure!(
        native_width <= u32::MAX as f64 && native_height <= u32::MAX as f64,
        crate::error::BackendError::InvalidGeometry
    );
    resolve_capture_size(
        native_width as u32,
        native_height as u32,
        precision,
        scale_x,
        scale_y,
    )
    .map(|(width, height)| (width.max(2) & !1, height.max(2) & !1))
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.pause();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        capture_size_for_scaled_bounds, native_420v_signature, normalized_content_rect,
        FrameCadence, ScaleTracker, STATIC_FRAME_HEARTBEAT,
    };
    use crate::traits::{CapturePrecision, Geometry, PointerMapping};
    use apple_cf::cv::CVPixelBuffer;
    use screencapturekit::cg::CGRect;
    use std::time::Duration;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> CGRect {
        CGRect::new(x, y, width, height)
    }

    fn popover_mapping() -> PointerMapping {
        let surface = normalized_content_rect(rect(0.0, 0.0, 1386.0, 811.204), (1386, 1050), 1.0)
            .expect("content rect");
        PointerMapping::new(
            Geometry {
                x: -149,
                y: 30,
                width: 1794,
                height: 1050,
                scale: 1.0,
            },
            surface,
        )
        .expect("mapping")
    }

    #[test]
    fn letterboxed_surface_maps_its_visible_center_to_the_screen_union_center() {
        let mapping = popover_mapping();
        assert!((mapping.content.height - 0.772575).abs() < 0.000001);
        assert_eq!(
            mapping.map(0.5, mapping.content.height / 2.0).unwrap(),
            (748, 555)
        );
    }

    #[test]
    fn letterboxed_surface_maps_the_far_popover_edge_to_the_screen_union_edge() {
        let mapping = popover_mapping();
        assert_eq!(
            mapping.map(1.0, mapping.content.height).unwrap(),
            (1644, 1079)
        );
    }

    #[test]
    fn surface_points_are_scaled_to_the_output_pixel_buffer() {
        let content = normalized_content_rect(rect(0.0, 0.0, 1794.0, 1050.0), (2772, 2100), 1.0)
            .expect("content rect");
        assert!((content.width - 1794.0 / 2772.0).abs() < 0.000001);
        assert!((content.height - 0.5).abs() < 0.000001);
    }

    #[test]
    fn retina_content_rect_fills_its_native_pixel_canvas() {
        let content = normalized_content_rect(rect(0.0, 0.0, 1794.0, 1050.0), (3588, 2100), 2.0)
            .expect("content rect");
        assert_eq!(content.x, 0.0);
        assert_eq!(content.y, 0.0);
        assert_eq!(content.width, 1.0);
        assert_eq!(content.height, 1.0);
    }

    #[test]
    fn expanded_popover_bounds_drive_the_capture_canvas_size() {
        assert_eq!(
            capture_size_for_scaled_bounds(1386, 1050, CapturePrecision::Auto, 1.0, 1.0).unwrap(),
            (1386, 1050)
        );
        assert_eq!(
            capture_size_for_scaled_bounds(1794, 1050, CapturePrecision::Auto, 1.0, 1.0).unwrap(),
            (1794, 1050)
        );
        assert_eq!(
            capture_size_for_scaled_bounds(1794, 1050, CapturePrecision::Auto, 2.0, 2.0).unwrap(),
            (3588, 2100)
        );
    }

    #[test]
    fn window_retina_scale_change_updates_the_capture_canvas() {
        assert_eq!(
            capture_size_for_scaled_bounds(1217, 820, CapturePrecision::Auto, 1.0, 1.0).unwrap(),
            (1216, 820)
        );
        assert_eq!(
            capture_size_for_scaled_bounds(1217, 820, CapturePrecision::Auto, 2.0, 2.0).unwrap(),
            (2434, 1640)
        );
    }

    #[test]
    fn cadence_uses_content_signature_before_timestamps() {
        let mut cadence = FrameCadence::default();
        let started = std::time::Instant::now();
        assert!(cadence.should_emit(Some(10), None, Some((1, 2)), false, started));
        assert!(!cadence.should_emit(
            Some(11),
            None,
            Some((1, 2)),
            false,
            started + Duration::from_millis(30)
        ));
        assert!(cadence.should_emit(
            Some(11),
            None,
            Some((2, 2)),
            false,
            started + Duration::from_millis(60)
        ));
        assert!(cadence.should_emit(
            Some(12),
            None,
            Some((2, 2)),
            true,
            started + Duration::from_millis(90)
        ));
        assert!(!cadence.should_emit(
            Some(13),
            None,
            Some((2, 2)),
            false,
            started + Duration::from_millis(100)
        ));
        assert!(cadence.should_emit(
            Some(14),
            None,
            Some((2, 2)),
            false,
            started + Duration::from_millis(90) + STATIC_FRAME_HEARTBEAT
        ));
    }

    #[test]
    fn cadence_falls_back_to_dirty_rectangles_without_a_signature() {
        let mut cadence = FrameCadence::default();
        let started = std::time::Instant::now();
        assert!(cadence.should_emit(Some(1), Some(true), None, false, started));
        assert!(!cadence.should_emit(
            Some(2),
            Some(false),
            None,
            false,
            started + Duration::from_millis(30)
        ));
        assert!(cadence.should_emit(
            Some(3),
            Some(true),
            None,
            false,
            started + Duration::from_millis(60)
        ));
    }

    #[test]
    fn native_signature_is_stable_until_plane_content_changes() {
        let buffer =
            CVPixelBuffer::create(4, 4, u32::from_be_bytes(*b"420v")).expect("native buffer");
        let initial = native_420v_signature(&buffer).expect("initial signature");
        assert_eq!(
            initial,
            native_420v_signature(&buffer).expect("repeated signature")
        );
        {
            let mut guard = buffer.lock_read_write().expect("native write lock");
            let y = guard
                .base_address_of_plane_mut(0)
                .expect("writable Y plane");
            unsafe { *y = y.read().wrapping_add(1) };
        }
        assert_ne!(
            initial,
            native_420v_signature(&buffer).expect("changed signature")
        );
    }

    #[test]
    fn observed_frame_scale_corrects_a_stale_display_query() {
        let mut scale = ScaleTracker::new((1.0, 1.0));
        assert_eq!(scale.effective((1.0, 1.0)), (1.0, 1.0));

        scale.observe(Some((2.0, 2.0)));
        assert_eq!(scale.effective((1.0, 1.0)), (2.0, 2.0));

        // Once CoreGraphics catches up, the observed override is released.
        assert_eq!(scale.effective((2.0, 2.0)), (2.0, 2.0));

        scale.observe(Some((1.0, 1.0)));
        assert_eq!(scale.effective((1.0, 1.0)), (1.0, 1.0));
    }

    #[test]
    fn content_offset_is_preserved_for_centered_letterboxing() {
        let content =
            normalized_content_rect(rect(100.0, 50.0, 800.0, 600.0), (1000, 700), 1.0).unwrap();
        assert_eq!(content.x, 0.1);
        assert_eq!(content.y, 50.0 / 700.0);
        assert_eq!(content.width, 0.8);
        assert_eq!(content.height, 600.0 / 700.0);
    }
}

#[derive(Default)]
pub struct WindowCatalog {
    references: crate::catalog::Catalog<Option<Capture>>,
}
pub fn enumerate_displays() -> anyhow::Result<Vec<crate::catalog::NativeSource<DisplayTarget>>> {
    preflight()?;
    let content =
        SCShareableContent::get().map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))?;
    let main_id = core_graphics::display::CGDisplay::main().id;
    let mut displays = content.displays();
    displays.sort_by_key(|display| display.display_id() != main_id);
    let mut sources = Vec::with_capacity(displays.len());
    for (index, display) in displays.into_iter().enumerate() {
        let width = display.width();
        let height = display.height();
        if width == 0 || height == 0 {
            continue;
        }
        sources.push(crate::catalog::NativeSource {
            identity: format!("sck-display:{}", display.display_id()),
            unavailable_reason: None,
            handle: DisplayTarget { display },
            kind: "display".into(),
            title: format!("Display {}", index + 1),
            subtitle: (index == 0 && main_id != 0).then(|| "Primary".into()),
            width,
            height,
        });
    }
    anyhow::ensure!(!sources.is_empty(), BackendError::NoInteractiveSession);
    Ok(sources)
}
impl WindowCatalog {
    pub fn new(source_salt: String) -> Self {
        Self {
            references: crate::catalog::Catalog::with_salt(source_salt),
        }
    }
    pub async fn enumerate(
        &mut self,
        owner: crate::session::Owner,
    ) -> anyhow::Result<Vec<crate::catalog::CaptureSource>> {
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
                let application_name = app.application_name();
                let (title, subtitle) = crate::catalog::source_labels(
                    window.title().unwrap_or_default(),
                    application_name,
                );
                result.push(crate::catalog::NativeSource {
                    identity: format!("sck:{}:{}", window.window_id(), app.process_id()),
                    handle: capture.ok(),
                    unavailable_reason: reason,
                    kind: "window".into(),
                    title,
                    subtitle,
                    width: g.width,
                    height: g.height,
                });
                if result.len() > crate::catalog::MAX_SOURCES {
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
