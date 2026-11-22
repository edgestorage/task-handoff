//! Feedback-driven encoder load and maintained SIMD image conversion/scaling.
use crate::traits::RawFrame;
#[cfg(target_os = "macos")]
use apple_cf::cv::{CVPixelBuffer, CVPixelBufferLockFlags};
use fast_image_resize::{images::Image, PixelType, ResizeAlg, ResizeOptions, Resizer};
use openh264::formats::{YUVBuffer, YUVSource};
use std::time::Duration;

/// One capture result at the component-local encoder boundary. Native macOS
/// frames stay in ScreenCaptureKit's 420v surface until VideoToolbox consumes
/// them; software encoding and every other platform use the normalized I420
/// representation.
pub enum Frame {
    I420(YUVBuffer),
    #[cfg(target_os = "macos")]
    Native420(Native420Frame),
}

#[cfg(target_os = "macos")]
pub struct Native420Frame {
    pub buffer: CVPixelBuffer,
    pub geometry: crate::traits::Geometry,
    pub captured_at: std::time::Instant,
}

impl Frame {
    /// Normalize to the encoder target. Native 420v is converted only when a
    /// hardware encoder is unavailable, never on the successful zero-copy path.
    pub fn into_i420(self, budget: Budget) -> anyhow::Result<YUVBuffer> {
        match self {
            Self::I420(frame) => {
                if frame.dimensions() == (budget.width as usize, budget.height as usize) {
                    Ok(frame)
                } else {
                    scale_yuv(frame, budget)
                }
            }
            #[cfg(target_os = "macos")]
            Self::Native420(frame) => from_native_420v(frame, budget),
        }
    }
}

/// Initial content budget; congestion feedback can reduce below this default.
pub const INITIAL_BITRATE: u32 = 8_000_000;
/// Product frame-rate ceiling shared by WebRTC and WebSocket fallback. The
/// bitrate/level budget may reduce below this value for constrained receivers.
pub const MAX_FRAME_RATE: u32 = 60;
/// WebSocket fallback shares the product resolution cap and initial encoder
/// budget with WebRTC, but defaults to 30 fps because N-1 viewers only probe
/// level 4.0. An explicit frame-rate request may raise it to the product
/// ceiling. The fallback has no receiver congestion feedback, so its bitrate
/// must not be held below the WebRTC start budget.
pub const FALLBACK_MAX_WIDTH: u32 = 1920;
pub const FALLBACK_MAX_HEIGHT: u32 = 1080;
pub const FALLBACK_MAX_FRAME_RATE: u32 = MAX_FRAME_RATE;
/// Fallback has no congestion feedback and old clients probe level 4.0, so its
/// default envelope stays at 1080p30. An explicit 60 fps request opts into the
/// higher level.
pub const FALLBACK_DEFAULT_FRAME_RATE: u32 = 30;
pub const FALLBACK_MAX_BITRATE: u32 = INITIAL_BITRATE;

/// Derive the fallback codec envelope from the actual frame-rate request.
/// 1080p30 and 720p60 fit H.264/HEVC level 4.0; 1080p60 exceeds both and needs
/// H.264 level 4.2 or HEVC level 4.1. The encoder, SPS and
/// `fallback.configure.codec` all consume this single projection.
pub const fn fallback_limits(
    codec: crate::codec::VideoCodec,
    width: u32,
    height: u32,
    frame_rate: u32,
) -> crate::codec::Limits {
    // The level must cover the macroblock rate of the actual capture cap, not
    // just the requested frame rate: 720p60 fits level 4.0 while 1080p60 does
    // not.
    let macroblocks = width.div_ceil(16) * height.div_ceil(16);
    let frame_rate = if frame_rate == 0 { 1 } else { frame_rate };
    let macroblocks_per_second = macroblocks * frame_rate;
    match codec {
        crate::codec::VideoCodec::H264 => crate::codec::Limits {
            level: if macroblocks_per_second > 245_760 {
                42
            } else {
                40
            },
            max_fs: 8160,
            max_mbps: if macroblocks_per_second > 245_760 {
                522_240
            } else {
                245_760
            },
            max_bitrate: FALLBACK_MAX_BITRATE,
        },
        crate::codec::VideoCodec::H265 => crate::codec::Limits {
            level: if macroblocks_per_second > 261_120 {
                123
            } else {
                120
            },
            max_fs: 8160,
            max_mbps: if macroblocks_per_second > 261_120 {
                522_240
            } else {
                261_120
            },
            max_bitrate: FALLBACK_MAX_BITRATE,
        },
    }
}

pub const FALLBACK_LIMITS: crate::codec::Limits = fallback_limits(
    crate::codec::VideoCodec::H264,
    FALLBACK_MAX_WIDTH,
    FALLBACK_MAX_HEIGHT,
    FALLBACK_DEFAULT_FRAME_RATE,
);
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
        let (tier_width, tier_height, fps) = match bitrate {
            0..250_000 => (320, 180, 10),
            250_000..750_000 => (640, 360, 15),
            750_000..2_000_000 => (1280, 720, 24),
            2_000_000..12_000_000 if limits.level >= 42 => (1920, 1080, MAX_FRAME_RATE),
            2_000_000..12_000_000 if limits.level >= 40 => (1920, 1080, 30),
            12_000_000..24_000_000 if limits.level >= 51 => (2560, 1440, MAX_FRAME_RATE),
            12_000_000..24_000_000 if limits.level >= 50 => (2560, 1440, 30),
            24_000_000.. if limits.level >= 51 => (3840, 2160, MAX_FRAME_RATE),
            _ => (1280, 720, 30),
        };
        // An explicit user quality target controls pixel dimensions. The bitrate
        // tier still controls frame rate and remains the automatic-resolution
        // policy when no target was requested.
        let (max_width, max_height) = resolution.unwrap_or((tier_width, tier_height));
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

#[cfg(target_os = "macos")]
fn from_native_420v(frame: Native420Frame, budget: Budget) -> anyhow::Result<YUVBuffer> {
    anyhow::ensure!(
        frame.buffer.pixel_format() == u32::from_be_bytes(*b"420v"),
        "REMOTE_DESKTOP_NATIVE_PIXEL_FORMAT_UNSUPPORTED"
    );
    let guard = frame
        .buffer
        .lock(CVPixelBufferLockFlags::READ_ONLY)
        .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_NATIVE_PIXEL_LOCK_FAILED"))?;
    let width = guard.width();
    let height = guard.height();
    anyhow::ensure!(
        width > 0
            && height > 0
            && width.is_multiple_of(2)
            && height.is_multiple_of(2)
            && guard.plane_count() == 2
            && guard.width_of_plane(0) == width
            && guard.width_of_plane(1) == width / 2
            && guard.height_of_plane(0) == height
            && guard.height_of_plane(1) == height / 2,
        "REMOTE_DESKTOP_NATIVE_PIXEL_LAYOUT_INVALID"
    );
    let target_width = budget.width as usize;
    let target_height = budget.height as usize;
    anyhow::ensure!(
        target_width > 0
            && target_height > 0
            && target_width.is_multiple_of(2)
            && target_height.is_multiple_of(2),
        "REMOTE_DESKTOP_INVALID_ENCODE_BUDGET"
    );

    let y_plane = unsafe { guard.plane_data(0) }
        .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_NATIVE_Y_PLANE_MISSING"))?;
    let uv_plane = unsafe { guard.plane_data(1) }
        .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_NATIVE_UV_PLANE_MISSING"))?;
    let packed_y = pack_plane(y_plane, guard.bytes_per_row_of_plane(0), width, height)?;
    let packed_uv = pack_plane(uv_plane, guard.bytes_per_row_of_plane(1), width, height / 2)?;
    let y = if (width, height) == (target_width, target_height) {
        packed_y
    } else {
        resize(
            packed_y,
            width as u32,
            height as u32,
            target_width as u32,
            target_height as u32,
            PixelType::U8,
        )?
    };
    let uv = if (width, height) == (target_width, target_height) {
        packed_uv
    } else {
        resize(
            packed_uv,
            width as u32,
            (height / 2) as u32,
            target_width as u32,
            (target_height / 2) as u32,
            PixelType::U8x2,
        )?
    };

    let mut data = vec![0; target_width * target_height * 3 / 2];
    let (y_out, uv_out) = data.split_at_mut(target_width * target_height);
    y_out.copy_from_slice(&y);
    let (u_out, v_out) = uv_out.split_at_mut(target_width * target_height / 4);
    for (pixel, (u, v)) in uv
        .chunks_exact(2)
        .zip(u_out.iter_mut().zip(v_out.iter_mut()))
    {
        *u = pixel[0];
        *v = pixel[1];
    }
    Ok(YUVBuffer::from_vec(data, target_width, target_height))
}

#[cfg(target_os = "macos")]
fn pack_plane(bytes: &[u8], stride: usize, width: usize, height: usize) -> anyhow::Result<Vec<u8>> {
    let length = height
        .checked_mul(stride)
        .ok_or_else(|| anyhow::anyhow!("REMOTE_DESKTOP_NATIVE_PLANE_TOO_LARGE"))?;
    anyhow::ensure!(
        stride >= width && bytes.len() >= length,
        "REMOTE_DESKTOP_NATIVE_PLANE_INVALID"
    );
    if stride == width {
        return Ok(bytes[..length].to_vec());
    }
    let mut packed = Vec::with_capacity(width * height);
    for row in bytes.chunks_exact(stride).take(height) {
        packed.extend_from_slice(&row[..width]);
    }
    Ok(packed)
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
    probe_bitrate: u32,
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
    pub fn fits_frame(encoded_bytes: usize, bitrate: u32, keyframe: bool) -> bool {
        let budget = if keyframe {
            crate::pacing::keyframe_byte_budget(bitrate as f64)
        } else {
            crate::pacing::byte_budget(bitrate as f64)
        };
        Self::wire_bytes(encoded_bytes) <= budget
    }
    pub fn fit(&mut self, base: Budget, bitrate: u32, now: std::time::Instant) -> Budget {
        let base_pixels = base.width as u64 * base.height as u64;
        let has_rate_headroom = bitrate as u64 >= self.probe_bitrate as u64 * 5 / 4;
        if self.max_pixels.is_some()
            && has_rate_headroom
            && self
                .last_change
                .is_some_and(|at| now.saturating_duration_since(at) >= Duration::from_secs(5))
        {
            self.max_pixels = self
                .max_pixels
                .map(|pixels| ((pixels as f64 * 1.5) as u64).min(base_pixels));
            self.last_change = Some(now);
            self.probe_bitrate = bitrate;
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
        keyframe: bool,
    ) -> anyhow::Result<bool> {
        if Self::fits_frame(encoded_bytes, bitrate, keyframe) {
            return Ok(true);
        }
        let wire = Self::wire_bytes(encoded_bytes);
        let available = if keyframe {
            crate::pacing::keyframe_byte_budget(bitrate as f64)
        } else {
            crate::pacing::byte_budget(bitrate as f64)
        };
        let pixels = budget.width as u64 * budget.height as u64;
        anyhow::ensure!(
            pixels > 160 * 90,
            "REMOTE_DESKTOP_ENCODER_FRAME_BUDGET_EXCEEDED"
        );
        let ratio = (available as f64 / wire as f64 * 0.8).clamp(0.1, 0.64);
        self.max_pixels = Some(((pixels as f64 * ratio) as u64).max(160 * 90));
        self.last_change = Some(now);
        self.probe_bitrate = bitrate;
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

#[cfg(all(test, target_os = "macos"))]
mod native_tests {
    use super::{Budget, Frame, Native420Frame};
    use apple_cf::cv::CVPixelBuffer;
    use openh264::formats::YUVSource;
    use std::time::Instant;

    #[test]
    fn native_420v_copies_biplanar_planes_into_i420_without_color_conversion() {
        let buffer =
            CVPixelBuffer::create(4, 4, u32::from_be_bytes(*b"420v")).expect("native buffer");
        {
            let mut lock = buffer.lock_read_write().expect("native write lock");
            assert_eq!(lock.plane_count(), 2);
            let y_stride = lock.bytes_per_row_of_plane(0);
            let uv_stride = lock.bytes_per_row_of_plane(1);
            assert!(y_stride >= 4);
            assert!(uv_stride >= 4);
            let y = lock.base_address_of_plane_mut(0).expect("Y plane");
            let uv = lock.base_address_of_plane_mut(1).expect("UV plane");
            unsafe {
                let y_plane = std::slice::from_raw_parts_mut(y, y_stride * 4);
                y_plane.fill(0);
                for (row, values) in [
                    [16, 17, 18, 19],
                    [20, 21, 22, 23],
                    [24, 25, 26, 27],
                    [28, 29, 30, 31],
                ]
                .into_iter()
                .enumerate()
                {
                    y_plane[row * y_stride..row * y_stride + 4].copy_from_slice(&values);
                }
                let uv_plane = std::slice::from_raw_parts_mut(uv, uv_stride * 2);
                uv_plane.fill(128);
                uv_plane[..4].copy_from_slice(&[40, 140, 41, 141]);
                uv_plane[uv_stride..uv_stride + 4].copy_from_slice(&[42, 142, 43, 143]);
            }
        }
        let frame = Frame::Native420(Native420Frame {
            buffer,
            geometry: crate::traits::Geometry {
                x: 0,
                y: 0,
                width: 4,
                height: 4,
                scale: 1.0,
            },
            captured_at: Instant::now(),
        });
        let yuv = frame
            .into_i420(Budget {
                width: 4,
                height: 4,
                fps: 30,
            })
            .expect("I420 fallback");
        assert_eq!(
            yuv.y(),
            &[16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]
        );
        assert_eq!(yuv.u(), &[40, 41, 42, 43]);
        assert_eq!(yuv.v(), &[140, 141, 142, 143]);
    }
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
