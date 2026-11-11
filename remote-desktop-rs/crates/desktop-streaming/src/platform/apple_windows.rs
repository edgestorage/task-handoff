//! Maintained CrabGrab Windows Graphics Capture backend.
//! Only an explicit capture request creates a stream; no screenshot
//! commands or full-screen cropping can implement a window target.
use super::frame_mailbox::FrameMailbox;
use crate::error::BackendError;
use crate::traits::{Geometry, RawFrame};
use crabgrab::{
    feature::bitmap::{FrameBitmap, VideoFrameBitmap},
    prelude::*,
};
use std::sync::Arc;
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
            .map(crate::capture::Source::Native)
    }
}
pub async fn enumerate_displays() -> anyhow::Result<Vec<crate::catalog::NativeSource<DisplayTarget>>>
{
    #[cfg(target_os = "windows")]
    {
        crate::platform::windows_access::prepare_dpi()?;
        crate::platform::windows_access::check()?;
    }
    anyhow::ensure!(
        CaptureStream::test_access(false).is_some(),
        BackendError::ScreenPermissionRequired
    );
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
    config: CaptureConfig,
    stream: Option<CaptureStream>,
    latest: FrameMailbox<Arc<VideoFrame>>,
    geometry: Geometry,
    display_geometry: Option<super::display_geometry::DisplayGeometry>,
    pixel_size: Option<(usize, usize)>,
}
impl Capture {
    pub async fn primary_display() -> anyhow::Result<Self> {
        Self::primary_display_with_cursor(true).await
    }
    pub async fn primary_display_with_cursor(show_cursor: bool) -> anyhow::Result<Self> {
        #[cfg(target_os = "windows")]
        {
            crate::platform::windows_access::prepare_dpi()?;
            crate::platform::windows_access::check()?;
        }
        anyhow::ensure!(
            CaptureStream::test_access(false).is_some(),
            BackendError::ScreenPermissionRequired
        );
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
        #[cfg(target_os = "windows")]
        {
            crate::platform::windows_access::prepare_dpi()?;
            crate::platform::windows_access::check()?;
        }
        let display_target = matches!(&target, Target::Display(_));
        let (rect, config) = match target {
            Target::Display(d) => (
                d.rect(),
                CaptureConfig::with_display(d, CapturePixelFormat::Bgra8888),
            ),
            Target::Window(w) => {
                anyhow::ensure!(w.is_visible(), BackendError::WindowUnavailable);
                (
                    w.rect(),
                    CaptureConfig::with_window(w, CapturePixelFormat::Bgra8888)
                        .map_err(|_| anyhow::anyhow!(BackendError::WindowUnavailable))?,
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
        Ok(Self {
            config: config.with_buffer_count(2).with_show_cursor(show_cursor),
            stream: None,
            latest: FrameMailbox::default(),
            geometry,
            display_geometry,
            pixel_size: None,
        })
    }
    pub fn geometry(&self) -> Geometry {
        self.geometry
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
impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.pause();
    }
}
