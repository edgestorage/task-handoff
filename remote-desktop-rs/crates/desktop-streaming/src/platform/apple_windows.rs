//! Maintained CrabGrab Windows Graphics Capture backend.
//! Only an explicit capture request creates a stream; no screenshot
//! commands or full-screen cropping can implement a window target.
use super::frame_mailbox::FrameMailbox;
use crate::capture::resolve_capture_size;
use crate::error::BackendError;
use crate::traits::{CapturePrecision, Geometry, RawFrame};
use crabgrab::{
    feature::bitmap::{FrameBitmap, VideoFrameBitmap},
    prelude::*,
};
use std::sync::Arc;

pub fn preflight() -> anyhow::Result<()> {
    crate::platform::windows_access::prepare_dpi()?;
    crate::platform::windows_access::check()?;
    anyhow::ensure!(
        CaptureStream::test_access(false).is_some(),
        BackendError::ScreenPermissionRequired
    );
    Ok(())
}
#[derive(Clone)]
pub enum Target {
    Display(CapturableDisplay),
    Window(CapturableWindow),
}
#[derive(Clone)]
pub struct DisplayTarget {
    display: CapturableDisplay,
}
impl DisplayTarget {
    pub fn source(&self, show_cursor: bool) -> anyhow::Result<crate::capture::Source> {
        Capture::new_with_cursor(Target::Display(self.display.clone()), show_cursor)
            .map(|capture| crate::capture::Source::Native(Box::new(capture)))
    }
}
pub async fn enumerate_displays() -> anyhow::Result<Vec<crate::catalog::NativeSource<DisplayTarget>>>
{
    preflight()?;
    let content = CapturableContent::new(CapturableContentFilter::DISPLAYS)
        .await
        .map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))?;
    let mut sources = Vec::new();
    for (index, display) in content.displays().enumerate() {
        let rect = display.rect();
        let width = rect.size.width.round();
        let height = rect.size.height.round();
        if width < 1.0 || height < 1.0 {
            continue;
        }
        sources.push(crate::catalog::NativeSource {
            identity: format!(
                "wgc-display:{}:{}:{}:{}",
                rect.origin.x, rect.origin.y, width, height
            ),
            unavailable_reason: None,
            handle: DisplayTarget { display },
            kind: "display".into(),
            title: format!("Display {}", index + 1),
            subtitle: None,
            width: width as u32,
            height: height as u32,
        });
    }
    anyhow::ensure!(!sources.is_empty(), BackendError::NoInteractiveSession);
    Ok(sources)
}
pub struct Capture {
    target: Target,
    config: CaptureConfig,
    stream: Option<CaptureStream>,
    latest: FrameMailbox<Arc<VideoFrame>>,
    geometry: Geometry,
    capture_size: (u32, u32),
    precision: CapturePrecision,
    display_geometry: Option<super::display_geometry::DisplayGeometry>,
    pixel_size: Option<(usize, usize)>,
    window_input: Option<super::windows_window::Identity>,
}
impl Capture {
    pub async fn primary_display() -> anyhow::Result<Self> {
        Self::primary_display_with_cursor(true).await
    }
    pub async fn primary_display_with_cursor(show_cursor: bool) -> anyhow::Result<Self> {
        preflight()?;
        let content = CapturableContent::new(CapturableContentFilter::DISPLAYS)
            .await
            .map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))?;
        let display = content
            .displays()
            .next()
            .ok_or_else(|| anyhow::anyhow!(BackendError::NoInteractiveSession))?;
        Self::new_with_cursor(Target::Display(display), show_cursor)
    }
    pub fn new(target: Target) -> anyhow::Result<Self> {
        Self::new_with_cursor(target, true)
    }
    pub fn new_with_cursor(target: Target, show_cursor: bool) -> anyhow::Result<Self> {
        preflight()?;
        let retained_target = target.clone();
        let display_target = matches!(&target, Target::Display(_));
        let (config, geometry, window_input) = match target {
            Target::Display(d) => {
                let rect = d.rect();
                (
                    CaptureConfig::with_display(d, CapturePixelFormat::Bgra8888),
                    Geometry::from_actuator_rect(
                        rect.origin.x,
                        rect.origin.y,
                        rect.size.width,
                        rect.size.height,
                    )?,
                    None,
                )
            }
            Target::Window(w) => {
                anyhow::ensure!(w.is_visible(), BackendError::WindowUnavailable);
                let identity = super::native_catalog::identity(&w)?;
                (
                    CaptureConfig::with_window(w, CapturePixelFormat::Bgra8888)
                        .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))?,
                    super::windows_window::geometry(identity)?,
                    Some(identity),
                )
            }
        };
        let display_geometry = display_target
            .then(|| super::display_geometry::DisplayGeometry::bind(geometry))
            .transpose()?;
        let precision = CapturePrecision::Auto;
        let capture_size = capture_size_for(&retained_target, precision)?;
        Ok(Self {
            target: retained_target,
            config: config
                .with_output_size(Size {
                    width: capture_size.0 as f64,
                    height: capture_size.1 as f64,
                })
                .with_buffer_count(2)
                .with_show_cursor(show_cursor),
            stream: None,
            latest: FrameMailbox::default(),
            geometry,
            capture_size,
            precision,
            display_geometry,
            pixel_size: None,
            window_input,
        })
    }
    pub fn window_input(&self) -> Option<(super::windows_window::Identity, Geometry)> {
        self.window_input.map(|identity| (identity, self.geometry))
    }
    pub fn geometry(&self) -> Geometry {
        self.geometry
    }
    pub fn set_capture_precision(&mut self, precision: CapturePrecision) -> anyhow::Result<bool> {
        if precision == self.precision {
            return Ok(false);
        }
        self.precision = precision;
        self.reconfigure_capture_size()?;
        Ok(true)
    }
    pub fn capture_dimensions(&self) -> (u32, u32) {
        self.capture_size
    }
    fn reconfigure_capture_size(&mut self) -> anyhow::Result<()> {
        let next = capture_size_for(&self.target, self.precision)?;
        if next == self.capture_size {
            return Ok(());
        }
        self.pause()?;
        self.capture_size = next;
        self.pixel_size = None;
        self.config = self.config.clone().with_output_size(Size {
            width: next.0 as f64,
            height: next.1 as f64,
        });
        Ok(())
    }
    pub fn refresh_geometry(&mut self) -> anyhow::Result<Geometry> {
        if let Some(display) = &self.display_geometry {
            display.validate()?;
        }
        let geometry = match &self.target {
            Target::Display(display) => {
                let rect = display.rect();
                Geometry::from_actuator_rect(
                    rect.origin.x,
                    rect.origin.y,
                    rect.size.width,
                    rect.size.height,
                )?
            }
            Target::Window(window) => {
                anyhow::ensure!(window.is_visible(), BackendError::WindowUnavailable);
                let identity = self
                    .window_input
                    .ok_or_else(|| anyhow::anyhow!(BackendError::WindowUnavailable))?;
                super::windows_window::geometry(identity)?
            }
        };
        let next_capture_size = capture_size_for(&self.target, self.precision)?;
        if geometry != self.geometry || next_capture_size != self.capture_size {
            self.pause()?;
            self.geometry = geometry;
            self.capture_size = next_capture_size;
            self.pixel_size = None;
            self.config = self.config.clone().with_output_size(Size {
                width: next_capture_size.0 as f64,
                height: next_capture_size.1 as f64,
            });
        }
        Ok(self.geometry)
    }
    pub fn resume(&mut self) -> anyhow::Result<()> {
        if self.stream.is_some() {
            return Ok(());
        }
        let token = CaptureStream::test_access(false)
            .ok_or_else(|| anyhow::anyhow!(BackendError::ScreenPermissionRequired))?;
        // A stopped stream can deliver late callbacks. Give the replacement
        // its own mailbox rather than letting an obsolete callback fail it.
        self.latest = FrameMailbox::default();
        let latest = self.latest.clone();
        let stream = CaptureStream::new(token, self.config.clone(), move |event| match event {
            Ok(StreamEvent::Video(frame)) => latest.publish(Arc::new(frame)),
            Ok(StreamEvent::End) | Err(_) => latest.fail(BackendError::CaptureFailed),
            _ => {}
        })
        .map_err(|_| anyhow::anyhow!(BackendError::CaptureUnavailable))?;
        self.stream = Some(stream);
        Ok(())
    }
    pub fn pause(&mut self) -> anyhow::Result<()> {
        if let Some(mut stream) = self.stream.take() {
            stream
                .stop()
                .map_err(|_| anyhow::anyhow!(BackendError::CaptureStopFailed))?;
        }
        self.latest = FrameMailbox::default();
        Ok(())
    }
    pub fn frame(&mut self, _force: bool) -> anyhow::Result<Option<RawFrame>> {
        if let Some(display) = &self.display_geometry {
            display.validate()?;
        }
        #[cfg(target_os = "windows")]
        crate::platform::windows_access::check()?;
        self.resume()?;
        // WGC may emit no new sample for an idle desktop. Reuse only the one
        // latest retained frame to maintain cadence, as SCK/X11 already do.
        let Some(frame) = self.latest.snapshot()? else {
            return Ok(None);
        };
        let bitmap = frame
            .get_bitmap()
            .map_err(|_| anyhow::anyhow!(BackendError::CaptureFailed))?;
        let FrameBitmap::BgraUnorm8x4(bitmap) = bitmap else {
            anyhow::bail!(BackendError::CaptureFormatUnsupported);
        };
        anyhow::ensure!(
            bitmap.width > 0 && bitmap.height > 0 && bitmap.width <= 8192 && bitmap.height <= 8192,
            BackendError::InvalidGeometry
        );
        let size = (bitmap.width, bitmap.height);
        // Retina pixels and actuator points are separate coordinate spaces.
        // Until geometry transitions issue new input authority, fail this peer
        // before stretching changed pixels over stale actuator coordinates.
        if let Some(previous) = self.pixel_size {
            anyhow::ensure!(previous == size, BackendError::GeometryChanged);
        } else {
            self.pixel_size = Some(size);
        }
        let bgra = bitmap
            .data
            .iter()
            .flat_map(|pixel| pixel.iter().copied())
            .collect();
        Ok(Some(RawFrame {
            bgra,
            stride: bitmap.width * 4,
            geometry: Geometry {
                width: bitmap.width as u32,
                height: bitmap.height as u32,
                ..self.geometry
            },
            captured_at: frame.capture_time(),
        }))
    }
}

#[cfg(target_os = "windows")]
fn logical_scale_for_rect(rect: crabgrab::prelude::Rect) -> f64 {
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{MonitorFromRect, MONITOR_DEFAULTTONEAREST},
        UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
    };
    let rect = RECT {
        left: rect.origin.x.round() as i32,
        top: rect.origin.y.round() as i32,
        right: (rect.origin.x + rect.size.width).round() as i32,
        bottom: (rect.origin.y + rect.size.height).round() as i32,
    };
    let monitor = unsafe { MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return 1.0;
    }
    let (mut dpi_x, mut dpi_y) = (0u32, 0u32);
    let ok = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
    if ok != 0 || dpi_x == 0 {
        return 1.0;
    }
    (96.0 / dpi_x as f64).clamp(0.25, 4.0)
}

fn capture_size_for(target: &Target, precision: CapturePrecision) -> anyhow::Result<(u32, u32)> {
    let (width, height, rect) = match target {
        Target::Display(display) => {
            let rect = display.rect();
            (rect.size.width.round(), rect.size.height.round(), rect)
        }
        Target::Window(window) => {
            anyhow::ensure!(window.is_visible(), BackendError::WindowUnavailable);
            let identity = super::native_catalog::identity(window)?;
            let geometry = super::windows_window::geometry(identity)?;
            (geometry.width as f64, geometry.height as f64, window.rect())
        }
    };
    anyhow::ensure!(width >= 1.0 && height >= 1.0, BackendError::InvalidGeometry);
    // Per-monitor DPI aware V2 exposes WGC rectangles in physical pixels.
    // Performance mode divides that native size by the monitor scale, while
    // auto keeps the compositor's native pixels unchanged.
    let scale = logical_scale_for_rect(rect);
    resolve_capture_size(width as u32, height as u32, precision, scale, scale)
}
impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.pause();
    }
}
