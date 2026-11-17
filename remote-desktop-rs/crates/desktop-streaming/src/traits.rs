//! Platform backends own OS handles. Capture and input share one geometry.
use crate::session::CaptureSelection;
use async_trait::async_trait;
use std::time::Duration;

pub type Result<T> = anyhow::Result<T>;
/// Capture quality is independent from the encoded resolution preset. `Auto`
/// asks each platform for its best native/backing pixels; `Performance` keeps
/// the smaller logical dimensions and trades detail for capture cost.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapturePrecision {
    #[default]
    Auto,
    Performance,
}
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Geometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}
/// Native window mutation requested by the browser boundary. Width and height
/// are logical actuator dimensions, independent of capture and video pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WindowResizeTarget {
    Preset { width: u32, height: u32 },
    Viewport { width: u32, height: u32 },
}
impl Geometry {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.width > 0 && self.height > 0 && self.scale.is_finite() && self.scale > 0.0,
            crate::error::BackendError::InvalidGeometry
        );
        Ok(())
    }

    /// OS actuator rectangle, independent of captured pixel dimensions. Validate
    /// floats before conversion so saturating casts cannot mask invalid targets.
    pub fn from_actuator_rect(x: f64, y: f64, width: f64, height: f64) -> Result<Self> {
        anyhow::ensure!(
            [x, y, width, height].iter().all(|v| v.is_finite()),
            crate::error::BackendError::InvalidGeometry
        );
        let (x, y, width, height) = (x.round(), y.round(), width.round(), height.round());
        anyhow::ensure!(
            width >= 1.0
                && height >= 1.0
                && width <= u32::MAX as f64
                && height <= u32::MAX as f64
                && x >= i32::MIN as f64
                && y >= i32::MIN as f64
                && x + width - 1.0 <= i32::MAX as f64
                && y + height - 1.0 <= i32::MAX as f64,
            crate::error::BackendError::InvalidGeometry
        );
        Ok(Self {
            x: x as i32,
            y: y as i32,
            width: width as u32,
            height: height as u32,
            scale: 1.0,
        })
    }
}

/// A rectangle expressed as fractions of the encoded video surface. SCK may
/// letterbox a window plus its transient popovers into a fixed output canvas;
/// the content rectangle tells pointer input where the real pixels live.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl NormalizedRect {
    pub const FULL: Self = Self {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    };

    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Result<Self> {
        anyhow::ensure!(
            [x, y, width, height].iter().all(|value| value.is_finite())
                && width > 0.0
                && height > 0.0,
            crate::error::BackendError::InvalidGeometry
        );
        let x = x.clamp(0.0, 1.0);
        let y = y.clamp(0.0, 1.0);
        let width = width.min(1.0 - x);
        let height = height.min(1.0 - y);
        anyhow::ensure!(
            width > 0.0 && height > 0.0,
            crate::error::BackendError::InvalidGeometry
        );
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }
}

/// Maps normalized coordinates in the encoded video surface to the native
/// screen rectangle represented by that surface. The video can contain
/// letterbox bars, so a single `Geometry` is not sufficient.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerMapping {
    pub screen: Geometry,
    pub content: NormalizedRect,
}

impl PointerMapping {
    pub fn new(screen: Geometry, content: NormalizedRect) -> Result<Self> {
        anyhow::ensure!(
            screen.width > 0 && screen.height > 0 && screen.scale.is_finite() && screen.scale > 0.0,
            crate::error::BackendError::InvalidGeometry
        );
        Ok(Self { screen, content })
    }

    pub fn from_geometry(screen: Geometry) -> Self {
        Self {
            screen,
            content: NormalizedRect::FULL,
        }
    }

    /// Convert a point normalized over the full video surface into the native
    /// actuator rectangle. Coordinates in letterbox bars are clamped to the
    /// nearest content edge so they cannot move the host pointer into a region
    /// that is not represented by the video.
    pub fn map(self, x: f64, y: f64) -> Result<(i32, i32)> {
        anyhow::ensure!(
            x.is_finite() && y.is_finite() && (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y),
            "REMOTE_DESKTOP_INVALID_COORDINATES"
        );
        anyhow::ensure!(
            self.content.width > 0.0
                && self.content.height > 0.0
                && self.content.width.is_finite()
                && self.content.height.is_finite(),
            "REMOTE_DESKTOP_INVALID_GEOMETRY"
        );
        let content_x = (x - self.content.x) / self.content.width;
        let content_y = (y - self.content.y) / self.content.height;
        crate::input_driver::map_point(
            self.screen,
            content_x.clamp(0.0, 1.0),
            content_y.clamp(0.0, 1.0),
        )
    }
}

pub struct RawFrame {
    pub bgra: Vec<u8>,
    pub stride: usize,
    pub geometry: Geometry,
    pub captured_at: std::time::Instant,
}
pub struct EncodedFrame {
    pub annex_b: Vec<u8>,
    pub keyframe: bool,
    pub duration: Duration,
}
pub struct Cursor {
    pub argb: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub hotspot: (u32, u32),
    pub position: (i32, i32),
    pub visible: bool,
}
#[async_trait]
pub trait DesktopSurface: Send {
    async fn start(&mut self) -> Result<()>;
    async fn shutdown(&mut self) -> Result<()>;
}
#[async_trait]
pub trait CaptureCatalog: Send {
    type Entry: Send;
    async fn enumerate(&mut self) -> Result<Vec<Self::Entry>>;
}
#[async_trait]
pub trait CaptureSource: Send {
    async fn open(&mut self, selection: &CaptureSelection) -> Result<Geometry>;
    async fn frame(&mut self) -> Result<RawFrame>;
    async fn pause(&mut self) -> Result<()>;
}
pub trait VideoEncoder: Send {
    fn encode(&mut self, frame: &RawFrame, idr: bool) -> Result<EncodedFrame>;
    fn set_bitrate(&mut self, bits_per_second: u32) -> Result<()>;
}
pub trait CursorSource: Send {
    fn cursor(&mut self) -> Result<Cursor>;
}
pub trait InputSink: Send {
    fn apply(&mut self, event: &crate::channel::Input) -> Result<()>;
    fn release_all(&mut self) -> Result<()>;
}
pub trait ClipboardBridge: Send {
    fn read_text(&mut self) -> Result<String>;
    fn write_text(&mut self, text: &str) -> Result<()>;
}
#[async_trait]
pub trait PeerSession: Send {
    async fn offer(&mut self, sdp: &str) -> Result<String>;
    async fn send_frame(&mut self, frame: EncodedFrame) -> Result<()>;
    async fn close(&mut self) -> Result<()>;
}
