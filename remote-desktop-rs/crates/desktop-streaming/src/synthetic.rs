//! Explicit test backend. Never probes a desktop or injects host OS input.
use crate::{
    channel::{Input, Pointer},
    traits::EncodedFrame,
    video::MAX_FRAME_RATE,
};
use openh264::{
    encoder::{
        BitRate, Encoder, EncoderConfig, FrameRate, Profile, QpRange, RateControlMode, UsageType,
        VuiConfig,
    },
    formats::YUVBuffer,
    OpenH264API, Timestamp,
};
use std::{collections::HashSet, time::Duration};

pub const WIDTH: usize = 640;
pub const HEIGHT: usize = 360;
pub const FRAME_TIME: Duration = Duration::from_micros(16_667);
#[derive(Default, Clone)]
pub struct SyntheticInput {
    pub pointer: (f64, f64),
    pub interactions: u64,
    pub committed_characters: u64,
    keys: HashSet<String>,
    buttons: HashSet<u8>,
}
impl SyntheticInput {
    pub fn pointer(&mut self, p: &Pointer) {
        self.pointer = (p.x, p.y);
    }
    pub fn apply(&mut self, input: &Input) {
        match input {
            Input::Key(k) => {
                if k.repeat {
                    return;
                }
                if k.down {
                    self.keys.insert(k.code.clone());
                } else {
                    self.keys.remove(&k.code);
                }
            }
            Input::Button(b) => {
                self.pointer = (b.x, b.y);
                if b.down {
                    self.buttons.insert(b.button);
                } else {
                    self.buttons.remove(&b.button);
                }
            }
            Input::Wheel(w) => self.pointer = (w.x, w.y),
            Input::Text(t) => {
                self.release_all();
                self.committed_characters += t.text.chars().count() as u64;
            }
        }
        self.interactions += 1;
    }
    pub fn release_all(&mut self) {
        self.keys.clear();
        self.buttons.clear();
    }
    pub fn pressed_count(&self) -> usize {
        self.keys.len() + self.buttons.len()
    }
}

pub struct SoftwareEncoder {
    encoder: Encoder,
    bitrate: u32,
    min_qp: u8,
    frame_rate: u32,
    started: std::time::Instant,
}
impl SoftwareEncoder {
    pub fn new(bitrate: u32) -> anyhow::Result<Self> {
        Self::with_limits(bitrate, crate::codec::Limits::default())
    }
    pub fn with_limits(bitrate: u32, limits: crate::codec::Limits) -> anyhow::Result<Self> {
        Self::with_quality(bitrate, limits, 0)
    }
    pub fn with_quality(
        bitrate: u32,
        limits: crate::codec::Limits,
        min_qp: u8,
    ) -> anyhow::Result<Self> {
        // Direct software-encoder users do not have a live budget. Advertise
        // the highest rate the negotiated level can sustain at the product
        // envelope; the streaming wrapper rebuilds with its exact budget rate.
        let frame_rate = if limits.level >= 42 {
            MAX_FRAME_RATE
        } else {
            30
        };
        Self::with_quality_at_frame_rate(bitrate, limits, min_qp, frame_rate)
    }
    pub fn with_quality_at_frame_rate(
        bitrate: u32,
        limits: crate::codec::Limits,
        min_qp: u8,
        frame_rate: u32,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(min_qp <= 51, "invalid encoder quantizer");
        anyhow::ensure!(
            (1..=120).contains(&frame_rate),
            "invalid encoder frame rate"
        );
        let bitrate = bitrate.min(limits.max_bitrate);
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(bitrate))
            .max_frame_rate(FrameRate::from_hz(frame_rate as f32))
            .profile(Profile::Baseline)
            .level(limits.encoder_level())
            .usage_type(UsageType::ScreenContentRealTime)
            .adaptive_quantization(false)
            .background_detection(false)
            .qp(QpRange::new(min_qp, 51))
            .rate_control_mode(RateControlMode::Bitrate)
            .skip_frames(true)
            .vui(VuiConfig::bt709());
        Ok(Self {
            encoder: Encoder::with_api_config(OpenH264API::from_source(), config)?,
            bitrate,
            min_qp,
            frame_rate,
            started: std::time::Instant::now(),
        })
    }
    pub fn min_qp(&self) -> u8 {
        self.min_qp
    }
    pub fn bitrate(&self) -> u32 {
        self.bitrate
    }
    pub fn frame_rate(&self) -> u32 {
        self.frame_rate
    }
    pub fn encode(&mut self, yuv: &YUVBuffer, idr: bool) -> anyhow::Result<Option<EncodedFrame>> {
        if idr {
            self.encoder.force_intra_frame();
        }
        // encode() supplies Timestamp::ZERO for every frame. Screen rate
        // control needs elapsed stream time, independently of RTP packet time.
        let elapsed = self.started.elapsed().as_millis().min(i64::MAX as u128) as u64;
        let frame = self
            .encoder
            .encode_at(yuv, Timestamp::from_millis(elapsed))?;
        let annex_b = frame.to_vec();
        let keyframe = openh264::nal_units(&annex_b).any(|nal| nal_type(nal) == Some(5));
        if annex_b.is_empty() {
            return Ok(None);
        }
        Ok(Some(EncodedFrame {
            annex_b,
            keyframe,
            duration: FRAME_TIME,
        }))
    }
}
fn nal_type(nal: &[u8]) -> Option<u8> {
    let start = if nal.starts_with(&[0, 0, 0, 1]) {
        4
    } else if nal.starts_with(&[0, 0, 1]) {
        3
    } else {
        0
    };
    nal.get(start).map(|b| b & 31)
}
pub fn pattern(frame: u64, input: &SyntheticInput) -> YUVBuffer {
    let mut data = vec![128; WIDTH * HEIGHT * 3 / 2];
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            data[y * WIDTH + x] = if x < WIDTH / 2 { 48 } else { 180 };
            if y < 24 && x < ((frame as usize * 4) % WIDTH) {
                data[y * WIDTH + x] = 220;
            }
            if (40..72).contains(&y) && x < (input.interactions as usize % 100) * 6 {
                data[y * WIDTH + x] = 235;
            }
            if (80..112).contains(&y) && x < (input.committed_characters as usize % 100) * 6 {
                data[y * WIDTH + x] = 210;
            }
            if (120..152).contains(&y) && x < input.pressed_count() * 24 {
                data[y * WIDTH + x] = 235;
            }
        }
    }
    // A remote cursor is composited into the same frame/geometry as input.
    let cx = (input.pointer.0 * (WIDTH - 1) as f64) as usize;
    let cy = (input.pointer.1 * (HEIGHT - 1) as f64) as usize;
    for dy in 0..16 {
        for dx in 0..=dy / 2 {
            let x = cx + dx;
            let y = cy + dy;
            if x < WIDTH && y < HEIGHT {
                data[y * WIDTH + x] = if dx == 0 || dx == dy / 2 { 16 } else { 235 };
            }
        }
    }
    YUVBuffer::from_vec(data, WIDTH, HEIGHT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openh264::{decoder::Decoder, formats::YUVSource};
    #[test]
    fn every_requested_idr_contains_parameters_and_decodes_independently() {
        let mut encoder = SoftwareEncoder::new(500_000).unwrap();
        for index in 0..6 {
            let idr = index == 0 || index == 5;
            let frame = encoder
                .encode(&pattern(index, &SyntheticInput::default()), idr)
                .unwrap()
                .unwrap();
            if idr {
                let types: Vec<_> = openh264::nal_units(&frame.annex_b)
                    .filter_map(nal_type)
                    .collect();
                assert!(
                    types.contains(&7) && types.contains(&8) && types.contains(&5),
                    "SPS/PPS/IDR required: {types:?}"
                );
                let mut decoder = Decoder::new().unwrap();
                let decoded = decoder.decode(&frame.annex_b).unwrap().unwrap();
                assert_eq!(decoded.dimensions(), (WIDTH, HEIGHT));
            }
        }
    }
}
