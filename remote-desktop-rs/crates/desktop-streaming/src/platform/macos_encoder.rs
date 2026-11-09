//! Maintained VideoToolbox bindings own callbacks/session lifetime. NV12 input,
//! no B frames, hardware REQUIRED (failure is handled by the encoder selector).
use crate::{codec::Limits, traits::EncodedFrame};
use apple_cf::{cm::CMTime, cv::CVPixelBuffer};
use openh264::formats::{YUVBuffer, YUVSource};
use std::time::{Duration, Instant};
use videotoolbox::compression::{
    CompressionSession, FrameProperties, HardwareAcceleration, ProfileLevel,
};
use videotoolbox::Codec;

pub struct Encoder {
    session: CompressionSession,
    size: (usize, usize),
    started: Instant,
}
impl Encoder {
    pub fn new(width: usize, height: usize, bitrate: u32, limits: Limits) -> anyhow::Result<Self> {
        // VT exposes fixed baseline levels13/30/31/32/40. Never silently choose
        // a profile/level above the receiver when a lower level is negotiated.
        let profile = match limits.level {
            13 => ProfileLevel::H264Baseline1_3,
            30 => ProfileLevel::H264Baseline3_0,
            31 => ProfileLevel::H264Baseline3_1,
            40 => ProfileLevel::H264Baseline4_0,
            _ => anyhow::bail!("VT baseline level unsupported"),
        };
        anyhow::ensure!(
            width > 0
                && height > 0
                && width <= 1920
                && height <= 1080
                && width.is_multiple_of(2)
                && height.is_multiple_of(2),
            "invalid VT dimensions"
        );
        let session = CompressionSession::builder(width as i32, height as i32, Codec::H264)
            .with_real_time(true)
            .with_allow_frame_reordering(false)
            .with_hardware_acceleration(HardwareAcceleration::Required)
            .with_low_latency_rate_control(true)
            .with_profile_level(profile)
            .with_average_bit_rate(bitrate.min(limits.max_bitrate) as i32)
            .with_expected_frame_rate(30.0)
            .with_max_keyframe_interval(60)
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
        let (annex_b, keyframe) = crate::annexb::from_avcc(
            &data,
            parameters.nal_unit_header_length as usize,
            &parameters.parameter_sets,
        )?;
        anyhow::ensure!(!idr || keyframe, "VT ignored IDR request");
        Ok(EncodedFrame {
            annex_b,
            keyframe,
            duration: Duration::from_secs_f64(1.0 / 30.0),
        })
    }
}
