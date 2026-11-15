//! Maintained VideoToolbox bindings own callbacks/session lifetime. NV12 input,
//! no B frames, hardware REQUIRED (failure is handled by the encoder selector).
use crate::{
    codec::{Limits, VideoCodec},
    traits::EncodedFrame,
};
use apple_cf::{cm::CMTime, cv::CVPixelBuffer};
use openh264::formats::{YUVBuffer, YUVSource};
use std::time::{Duration, Instant};
use videotoolbox::compression::{
    CompressionSession, FrameProperties, HardwareAcceleration, ProfileLevel,
};
use videotoolbox::Codec as VtCodec;

/// HEVC is registered as a sender capability only when VideoToolbox can create a
/// hardware encoder. The result is process-stable; actual session allocation can
/// still fail during a stream, in which case the stream fails rather than sending
/// an H.264 fallback under an H.265 payload type.
pub fn hevc_supported() -> bool {
    static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SUPPORTED.get_or_init(|| {
        CompressionSession::builder(64, 64, VtCodec::HEVC)
            .with_real_time(true)
            .with_allow_frame_reordering(false)
            .with_hardware_acceleration(HardwareAcceleration::Required)
            .with_low_latency_rate_control(true)
            .with_profile_level(ProfileLevel::HEVCMainAutoLevel)
            .build()
            .is_ok()
    })
}

pub struct Encoder {
    session: CompressionSession,
    size: (usize, usize),
    started: Instant,
    codec: VideoCodec,
}
impl Encoder {
    pub fn new(
        width: usize,
        height: usize,
        bitrate: u32,
        limits: Limits,
        codec: VideoCodec,
    ) -> anyhow::Result<Self> {
        // VT exposes fixed H.264 baseline levels. Never silently choose a profile
        // above the receiver. HEVC uses Main profile with VT selecting the level
        // from the validated dimension/rate budget.
        let profile = match codec {
            VideoCodec::H264 => match limits.level {
                13 => ProfileLevel::H264Baseline1_3,
                30 => ProfileLevel::H264Baseline3_0,
                31 => ProfileLevel::H264Baseline3_1,
                32 => ProfileLevel::H264Baseline3_2,
                40 => ProfileLevel::H264Baseline4_0,
                41 => ProfileLevel::H264Baseline4_1,
                42 => ProfileLevel::H264Baseline4_2,
                50 => ProfileLevel::H264Baseline5_0,
                51 => ProfileLevel::H264Baseline5_1,
                52 => ProfileLevel::H264Baseline5_2,
                _ => anyhow::bail!("VT baseline level unsupported"),
            },
            VideoCodec::H265 => ProfileLevel::HEVCMainAutoLevel,
        };
        anyhow::ensure!(
            width > 0
                && height > 0
                && width <= 3840
                && height <= 2160
                && width.is_multiple_of(2)
                && height.is_multiple_of(2),
            "invalid VT dimensions"
        );
        let native_codec = match codec {
            VideoCodec::H264 => VtCodec::H264,
            VideoCodec::H265 => VtCodec::HEVC,
        };
        let session = CompressionSession::builder(width as i32, height as i32, native_codec)
            .with_real_time(true)
            .with_allow_frame_reordering(false)
            .with_hardware_acceleration(HardwareAcceleration::Required)
            .with_low_latency_rate_control(true)
            .with_profile_level(profile)
            .with_average_bit_rate(bitrate.min(limits.max_bitrate) as i32)
            .with_expected_frame_rate(30.0)
            .build()?;
        // SDK documented compression property names and ITU-R709 value. Keep
        // the encoded VUI consistent with the shared BGRA conversion matrix.
        use apple_cf::cf::{CFDictionary, CFString};
        let color = CFString::new("ITU_R_709_2");
        let primaries = CFString::new("ColorPrimaries");
        let transfer = CFString::new("TransferFunction");
        let matrix = CFString::new("YCbCrMatrix");
        session.set_properties(&CFDictionary::from_pairs(&[
            (&primaries, &color),
            (&transfer, &color),
            (&matrix, &color),
        ]))?;
        Ok(Self {
            session,
            size: (width, height),
            started: Instant::now(),
            codec,
        })
    }
    pub fn size(&self) -> (usize, usize) {
        self.size
    }
    pub fn encode(&mut self, yuv: &YUVBuffer, idr: bool) -> anyhow::Result<EncodedFrame> {
        let (w, h) = yuv.dimensions();
        anyhow::ensure!((w, h) == self.size, "VT geometry changed");
        // 420v matches the shared BT.709 limited-range I420 conversion; interleave
        // U/V planes without another RGB conversion or color matrix operation.
        let buffer = CVPixelBuffer::create(w, h, u32::from_be_bytes(*b"420v"))
            .map_err(|_| anyhow::anyhow!("VT pixel allocation failed"))?;
        {
            let mut lock = buffer
                .lock_read_write()
                .map_err(|_| anyhow::anyhow!("VT pixel lock failed"))?;
            anyhow::ensure!(lock.plane_count() == 2, "VT plane format changed");
            let ys = lock.bytes_per_row_of_plane(0);
            let uvs = lock.bytes_per_row_of_plane(1);
            anyhow::ensure!(
                ys >= w
                    && ys <= 8192 * 4
                    && uvs >= w
                    && uvs <= 8192 * 4
                    && lock.width_of_plane(0) == w
                    && lock.width_of_plane(1) == w / 2
                    && ys * h + uvs * h / 2 <= lock.data_size()
                    && lock.height_of_plane(0) == h
                    && lock.height_of_plane(1) == h / 2,
                "invalid VT plane geometry"
            );
            let yp = lock
                .base_address_of_plane_mut(0)
                .ok_or_else(|| anyhow::anyhow!("VT Y plane missing"))?;
            let uvp = lock
                .base_address_of_plane_mut(1)
                .ok_or_else(|| anyhow::anyhow!("VT UV plane missing"))?;
            let (sy, su, sv) = yuv.strides();
            // Fresh unshared buffer; read-write lock pins both native planes.
            // Initialize padding too, before submitting any native/GPU alias.
            unsafe {
                let out = std::slice::from_raw_parts_mut(yp, ys * h);
                out.fill(0);
                for row in 0..h {
                    out[row * ys..row * ys + w].copy_from_slice(&yuv.y()[row * sy..row * sy + w]);
                }
                let out = std::slice::from_raw_parts_mut(uvp, uvs * h / 2);
                out.fill(128);
                for row in 0..h / 2 {
                    for col in 0..w / 2 {
                        out[row * uvs + 2 * col] = yuv.u()[row * su + col];
                        out[row * uvs + 2 * col + 1] = yuv.v()[row * sv + col];
                    }
                }
            }
        }
        self.encode_buffer(buffer, idr)
    }
    /// Submit a ScreenCaptureKit-owned 420v surface directly. The retained
    /// wrapper is cloned cheaply; no CPU color conversion or plane copy occurs.
    pub fn encode_native(
        &mut self,
        buffer: &CVPixelBuffer,
        idr: bool,
    ) -> anyhow::Result<EncodedFrame> {
        anyhow::ensure!(
            buffer.pixel_format() == u32::from_be_bytes(*b"420v"),
            "VT native pixel format changed"
        );
        anyhow::ensure!(
            buffer.is_planar() && buffer.plane_count() == 2,
            "VT native plane format changed"
        );
        self.encode_buffer(buffer.clone(), idr)
    }
    fn encode_buffer(&mut self, buffer: CVPixelBuffer, idr: bool) -> anyhow::Result<EncodedFrame> {
        let sample = futures_executor::block_on(
            self.session.encode_frame_async(
                buffer,
                CMTime::new(self.started.elapsed().as_micros() as i64, 1_000_000),
                CMTime::INVALID,
                FrameProperties::new()
                    .with_force_key_frame(idr)
                    .to_dictionary(),
            ),
        )?;
        let description = sample
            .format_description()
            .ok_or_else(|| anyhow::anyhow!("VT format missing"))?;
        let parameters = description
            .video_parameter_sets()
            .map_err(|_| anyhow::anyhow!("VT parameters missing"))?;
        let block = sample
            .data_buffer()
            .ok_or_else(|| anyhow::anyhow!("VT data missing"))?;
        anyhow::ensure!(
            block.data_length() <= 16 * 1024 * 1024,
            "VT sample too large"
        );
        let data = block
            .copy_data_bytes(0, block.data_length())
            .ok_or_else(|| anyhow::anyhow!("VT data copy failed"))?;
        let (annex_b, keyframe) = crate::annexb::from_avcc_for(
            &data,
            parameters.nal_unit_header_length as usize,
            &parameters.parameter_sets,
            self.codec,
        )?;
        anyhow::ensure!(!idr || keyframe, "VT ignored IDR request");
        Ok(EncodedFrame {
            annex_b,
            keyframe,
            duration: Duration::from_secs_f64(1.0 / 30.0),
        })
    }
}
