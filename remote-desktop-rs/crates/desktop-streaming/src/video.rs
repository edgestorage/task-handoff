//! Feedback-driven encoder load and maintained SIMD image conversion/scaling.
use crate::traits::RawFrame;
use fast_image_resize::{images::Image, PixelType, ResizeAlg, ResizeOptions, Resizer};
use openh264::formats::{YUVBuffer, YUVSource};
use std::time::Duration;

/// Initial content budget; congestion feedback can reduce below this default.
pub const INITIAL_BITRATE: u32 = 4_000_000;
/// WebSocket fallback uses the same product resolution and frame rate as
/// WebRTC. Only its proxy-chain bitrate is capped.
pub const FALLBACK_MAX_WIDTH: u32 = 1920;
pub const FALLBACK_MAX_HEIGHT: u32 = 1080;
pub const FALLBACK_MAX_FRAME_RATE: u32 = 30;
pub const FALLBACK_MAX_BITRATE: u32 = 4_000_000;
pub const FALLBACK_LIMITS: crate::codec::Limits = crate::codec::Limits {
    level: 40,
    max_fs: 8160,
    max_mbps: 244_800,
    max_bitrate: FALLBACK_MAX_BITRATE,
};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}
impl Budget {
    pub fn select(width: u32, height: u32, bitrate: u32) -> Self {
        Self::select_with_limits(width, height, bitrate, crate::codec::Limits::default())
    }
    pub fn select_with_limits(
        width: u32,
        height: u32,
        bitrate: u32,
        limits: crate::codec::Limits,
    ) -> Self {
        Self::select_with_limits_and_resolution(width, height, bitrate, limits, None)
    }
    pub fn select_with_limits_and_resolution(
        width: u32,
        height: u32,
        bitrate: u32,
        limits: crate::codec::Limits,
        resolution: Option<(u32, u32)>,
    ) -> Self {
        Self::select_with_limits_resolution_and_fps(
            width, height, bitrate, limits, resolution, None,
        )
    }
    pub fn select_with_limits_resolution_and_fps(
        width: u32,
        height: u32,
        bitrate: u32,
        limits: crate::codec::Limits,
        resolution: Option<(u32, u32)>,
        frame_rate: Option<u32>,
    ) -> Self {
        let (max_width, max_height, fps) = match bitrate {
            0..250_000 => (320, 180, 10),
            250_000..750_000 => (640, 360, 15),
            750_000..2_000_000 => (1280, 720, 24),
            _ if limits.level >= 40 => (1920, 1080, 30),
            _ => (1280, 720, 30),
        };
        let (max_width, max_height) = resolution
            .map(|(width, height)| (max_width.min(width), max_height.min(height)))
            .unwrap_or((max_width, max_height));
        // Scale to content/rate first, then enforce the negotiated codec limits.
        let ratio = (max_width as f64 / width.max(1) as f64)
            .min(max_height as f64 / height.max(1) as f64)
            .min(1.0);
        let mut budget = Self {
            width: ((width as f64 * ratio) as u32 / 2 * 2).max(2),
            height: ((height as f64 * ratio) as u32 / 2 * 2).max(2),
            fps,
        };
        let original_width = budget.width;
        let original_height = budget.height;
        let mut adjustment = 1.0f64;
        let max_dimension_mbs = ((8 * limits.max_fs) as f64).sqrt().floor() as u32;
        loop {
            let w = budget.width.div_ceil(16);
            let h = budget.height.div_ceil(16);
            if w * h <= limits.max_fs.min(limits.max_mbps)
                && w <= max_dimension_mbs
                && h <= max_dimension_mbs
            {
                break;
            }
            // Preserve aspect ratio while crossing macroblock boundaries. The
            // receiver's max-fs and max-mbps are hard codec limits, not bitrate tiers.
            adjustment *= 0.98;
            budget.width = ((original_width as f64 * adjustment) as u32 / 2 * 2).max(2);
            budget.height = ((original_height as f64 * adjustment) as u32 / 2 * 2).max(2);
        }
        budget.fps = budget
            .fps
            .min(limits.max_mbps / (budget.width.div_ceil(16) * budget.height.div_ceil(16)))
            .max(1);
        if let Some(frame_rate) = frame_rate {
            budget.fps = budget.fps.min(frame_rate.max(1));
        }
        budget
    }
    pub fn frame_time(self) -> Duration {
        Duration::from_secs_f64(1.0 / self.fps as f64)
    }
}
fn resize(
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    out_width: u32,
    out_height: u32,
    pixel: PixelType,
) -> anyhow::Result<Vec<u8>> {
    if (width, height) == (out_width, out_height) {
        return Ok(bytes);
    }
    let source = Image::from_vec_u8(width, height, bytes, pixel)?;
    let mut destination = Image::new(out_width, out_height, pixel);
    Resizer::new().resize(
        &source,
        &mut destination,
        &ResizeOptions::new()
            .resize_alg(ResizeAlg::Convolution(
                fast_image_resize::FilterType::Bilinear,
            ))
            .use_alpha(false),
    )?;
    Ok(destination.into_vec())
}
pub fn from_bgra(frame: RawFrame, budget: Budget) -> anyhow::Result<YUVBuffer> {
    let width = frame.geometry.width as usize;
    let height = frame.geometry.height as usize;
    anyhow::ensure!(
        width > 0
            && height > 0
            && frame.stride >= width * 4
            && height
                .checked_mul(frame.stride)
                .is_some_and(|size| size <= frame.bgra.len()),
        "REMOTE_DESKTOP_INVALID_CAPTURE_FRAME"
    );
    let packed = if frame.stride == width * 4 {
        frame.bgra
    } else {
        frame
            .bgra
            .chunks_exact(frame.stride)
            .take(height)
            .flat_map(|row| row[..width * 4].iter().copied())
            .collect()
    };
    let resized = resize(
        packed,
        width as u32,
        height as u32,
        budget.width,
        budget.height,
        PixelType::U8x4,
    )?;
    // OpenH264's built-in RGB converter is BT.601 limited-range, while our
    // negotiated encoder VUI is BT.709. Select the actual matrix explicitly
    // through the maintained SIMD converter; both software and native encoders
    // consume this same I420 authority (16..235 luma / 16..240 chroma).
    let width = budget.width as usize;
    let height = budget.height as usize;
    let mut data = vec![0; width * height * 3 / 2];
    let (y, uv) = data.split_at_mut(width * height);
    let (u, v) = uv.split_at_mut(width * height / 4);
    let mut image = yuv::YuvPlanarImageMut {
        y_plane: yuv::BufferStoreMut::Borrowed(y),
        y_stride: budget.width,
        u_plane: yuv::BufferStoreMut::Borrowed(u),
        u_stride: budget.width / 2,
        v_plane: yuv::BufferStoreMut::Borrowed(v),
        v_stride: budget.width / 2,
        width: budget.width,
        height: budget.height,
    };
    yuv::bgra_to_yuv420(
        &mut image,
        &resized,
        budget.width * 4,
        yuv::YuvRange::Limited,
        yuv::YuvStandardMatrix::Bt709,
        yuv::YuvConversionMode::Balanced,
    )?;
    Ok(YUVBuffer::from_vec(data, width, height))
}
pub fn scale_yuv(frame: YUVBuffer, budget: Budget) -> anyhow::Result<YUVBuffer> {
    let (width, height) = frame.dimensions();
    if (width, height) == (budget.width as usize, budget.height as usize) {
        return Ok(frame);
    }
    let mut data = resize(
        frame.y().to_vec(),
        width as u32,
        height as u32,
        budget.width,
        budget.height,
        PixelType::U8,
    )?;
    data.extend(resize(
        frame.u().to_vec(),
        width as u32 / 2,
        height as u32 / 2,
        budget.width / 2,
        budget.height / 2,
        PixelType::U8,
    )?);
    data.extend(resize(
        frame.v().to_vec(),
        width as u32 / 2,
        height as u32 / 2,
        budget.width / 2,
        budget.height / 2,
        PixelType::U8,
    )?);
    Ok(YUVBuffer::from_vec(
        data,
        budget.width as usize,
        budget.height as usize,
    ))
}

/// Encoded-frame pressure is separate from the network estimator. A fresh IDR
/// must itself fit the pacer's byte/time budget; requesting the same oversized
/// IDR forever cannot recover. Shrink pixel cost, then probe upward cautiously.
#[derive(Default)]
pub struct FramePressure {
    max_pixels: Option<u64>,
    last_change: Option<std::time::Instant>,
}
impl FramePressure {
    fn wire_bytes(encoded_bytes: usize) -> usize {
        // Conservative RTP/FU-A/extension overhead, shared by quality/pixel
        // admission so neither can quietly exceed the pacer byte/time budget.
        encoded_bytes
            .saturating_add(encoded_bytes.div_ceil(1000).saturating_mul(64))
            .saturating_add(256)
    }
    pub fn fits(encoded_bytes: usize, bitrate: u32) -> bool {
        Self::wire_bytes(encoded_bytes) <= crate::pacing::byte_budget(bitrate as f64)
    }
    pub fn fit(&mut self, base: Budget, now: std::time::Instant) -> Budget {
        let base_pixels = base.width as u64 * base.height as u64;
        if self
            .last_change
            .is_some_and(|at| now.saturating_duration_since(at) >= Duration::from_secs(1))
        {
            self.max_pixels = self.max_pixels.and_then(|pixels| {
                let increased = pixels.saturating_mul(4);
                (increased < base_pixels).then_some(increased)
            });
            self.last_change = Some(now);
        }
        let Some(limit) = self.max_pixels.filter(|pixels| *pixels < base_pixels) else {
            return base;
        };
        let scale = (limit as f64 / base_pixels as f64).sqrt();
        Budget {
            width: ((base.width as f64 * scale) as u32 / 2 * 2).max(2),
            height: ((base.height as f64 * scale) as u32 / 2 * 2).max(2),
            ..base
        }
    }
    pub fn admit(
        &mut self,
        encoded_bytes: usize,
        budget: Budget,
        bitrate: u32,
        now: std::time::Instant,
    ) -> anyhow::Result<bool> {
        if Self::fits(encoded_bytes, bitrate) {
            return Ok(true);
        }
        let wire = Self::wire_bytes(encoded_bytes);
        let available = crate::pacing::byte_budget(bitrate as f64);
        let pixels = budget.width as u64 * budget.height as u64;
        anyhow::ensure!(
            pixels > 160 * 90,
            "REMOTE_DESKTOP_ENCODER_FRAME_BUDGET_EXCEEDED"
        );
        let ratio = (available as f64 / wire as f64 * 0.8).clamp(0.1, 0.64);
        self.max_pixels = Some(((pixels as f64 * ratio) as u64).max(160 * 90));
        self.last_change = Some(now);
        Ok(false)
    }
}

/// Software quality pressure precedes pixel loss. A text-heavy1080p IDR can
/// exceed100ms even at8Mbps while encoding in10ms. Let maintained OpenH264
/// increase quantization first; only then reduce pixels. The floor36 ceiling
/// keeps this a bounded fallback, not an unbounded quality sacrifice. Stable
/// operation probes quality upward slowly, without repeatedly resizing the GOP.
#[derive(Default)]
pub struct SoftwareQuality {
    floor: u8,
    changed: Option<std::time::Instant>,
    keyframe_headroom: bool,
}
impl SoftwareQuality {
    pub fn floor(&mut self, now: std::time::Instant) -> u8 {
        if self.floor > 0
            && self.keyframe_headroom
            && self
                .changed
                .is_some_and(|at| now.saturating_duration_since(at) >= Duration::from_secs(5))
        {
            self.floor = if self.floor <= 24 { 0 } else { self.floor - 4 };
            self.changed = Some(now);
            self.keyframe_headroom = false;
        }
        self.floor
    }
    /// Only a naturally needed, accepted keyframe can establish room for a
    /// quality recovery probe. A timer alone must not continually create large
    /// IDRs that are already known to exceed the same wire budget. A QP step
    /// costs roughly 1.6x bits; require 2x measured headroom before attempting it.
    pub fn observe_keyframe(&mut self, bytes: usize, bitrate: u32) {
        self.keyframe_headroom = Self::has_probe_headroom(bytes, bitrate);
    }
    fn has_probe_headroom(bytes: usize, bitrate: u32) -> bool {
        FramePressure::wire_bytes(bytes).saturating_mul(2)
            <= crate::pacing::byte_budget(bitrate as f64)
    }
    pub fn reject(&mut self, now: std::time::Instant) -> bool {
        self.keyframe_headroom = false;
        if self.floor >= 36 {
            return false;
        }
        self.floor = if self.floor < 24 { 24 } else { self.floor + 4 };
        self.changed = Some(now);
        true
    }
}
