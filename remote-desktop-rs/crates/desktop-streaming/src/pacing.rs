//! GOP-aware queue boundary around the maintained rtc-interceptor token bucket.
//!
//! The stock interceptor silently drops individual RTP packets at a packet-count
//! limit and has no frame/age/byte boundary. Reuse its tested pacing algorithm,
//! but own frame admission and reset here: every reset discards all dependent
//! queued media, rejects old retransmissions, and waits for SPS/PPS + IDR.
use rtc::{
    interceptor::{Attribute, Interceptor, Pacer, Packet, StreamInfo, TaggedPacket},
    sansio::Protocol,
    shared::{error::Error, marshal::MarshalSize},
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use crate::codec::VideoCodec;

pub const QUEUE_AGE: Duration = Duration::from_millis(100);
pub const QUEUE_BYTES: usize = 256 * 1024;
pub const KEYFRAME_QUEUE_AGE: Duration = Duration::from_millis(300);
pub const KEYFRAME_QUEUE_BYTES: usize = 4 * 1024 * 1024;
pub fn byte_budget(bitrate: f64) -> usize {
    ((bitrate * QUEUE_AGE.as_secs_f64() / 8.0) as usize)
        .saturating_add(1500)
        .min(QUEUE_BYTES)
}
pub fn keyframe_byte_budget(bitrate: f64) -> usize {
    // An IDR is naturally larger than an inter frame. Allow a bounded burst
    // long enough to transmit it plus the following queue window, while P
    // frames keep the 100ms low-latency budget.
    ((bitrate * KEYFRAME_QUEUE_AGE.as_secs_f64() / 8.0) as usize)
        .saturating_add(1500)
        .min(KEYFRAME_QUEUE_BYTES)
}
const MIN_BURST_BITS: f64 = 12_000.0;
const BURST_TIME: f64 = 0.005;
const MAX_RECENT: usize = 64;
#[derive(Default)]
pub struct PacingFeedback {
    pub request_idr: AtomicBool,
    pub reset_requested: AtomicBool,
    pub paused: AtomicBool,
    pub resets: AtomicU64,
    pub queued_bytes: AtomicU64,
    pub max_queued_bytes: AtomicU64,
    pub target_bitrate: AtomicU64,
    codec: AtomicU8,
}

impl PacingFeedback {
    pub fn set_codec(&self, codec: VideoCodec) {
        self.codec.store(codec as u8, Ordering::SeqCst);
    }

    fn codec(&self) -> VideoCodec {
        match self.codec.load(Ordering::SeqCst) {
            1 => VideoCodec::H265,
            _ => VideoCodec::H264,
        }
    }
}
struct Frame {
    timestamp: u32,
    created: Instant,
    packets: Vec<TaggedPacket>,
    bytes: usize,
    nals: u8,
}
struct Queued {
    packet: TaggedPacket,
    bytes: usize,
    expires: Instant,
}
pub struct GopPacer {
    bucket: Pacer,
    queue: VecDeque<Queued>,
    staging: Option<Frame>,
    bytes: usize,
    recent: VecDeque<u32>,
    latest: Option<u32>,
    waiting_idr: bool,
    read: VecDeque<TaggedPacket>,
    control: VecDeque<TaggedPacket>,
    feedback: Arc<PacingFeedback>,
    codec: VideoCodec,
    burst_deadline: Option<Instant>,
}
impl GopPacer {
    pub fn new(feedback: Arc<PacingFeedback>) -> Self {
        feedback
            .target_bitrate
            .store(crate::video::INITIAL_BITRATE as u64, Ordering::Relaxed);
        Self {
            bucket: Pacer::new(crate::video::INITIAL_BITRATE as f64).with_burst_bits(
                MIN_BURST_BITS.max(crate::video::INITIAL_BITRATE as f64 * BURST_TIME),
            ),
            queue: VecDeque::new(),
            staging: None,
            bytes: 0,
            recent: VecDeque::new(),
            latest: None,
            waiting_idr: true,
            read: VecDeque::new(),
            control: VecDeque::new(),
            codec: feedback.codec(),
            burst_deadline: None,
            feedback,
        }
    }
    fn publish(&self) {
        self.feedback.max_queued_bytes.fetch_max(
            (self.bytes + self.staging.as_ref().map_or(0, |f| f.bytes)) as u64,
            Ordering::Relaxed,
        );
        self.feedback.queued_bytes.store(
            (self.bytes + self.staging.as_ref().map_or(0, |f| f.bytes)) as u64,
            Ordering::Relaxed,
        );
    }
    fn reset(&mut self) {
        self.control
            .retain(|p| !matches!(p.message.packet, Packet::Rtp(_)));
        self.queue.clear();
        self.staging = None;
        self.bytes = 0;
        self.recent.clear();
        self.waiting_idr = true;
        self.burst_deadline = None;
        self.feedback.request_idr.store(true, Ordering::SeqCst);
        self.feedback.resets.fetch_add(1, Ordering::Relaxed);
        self.publish();
    }
    fn expire(&mut self, now: Instant) {
        let codec = self.feedback.codec();
        if codec != self.codec {
            self.codec = codec;
            self.reset();
        }
        if self.feedback.reset_requested.swap(false, Ordering::SeqCst) {
            self.reset();
        }
        if self.burst_deadline.is_some_and(|deadline| now >= deadline) {
            self.burst_deadline = None;
        }
        if self.queue.front().is_some_and(|q| now >= q.expires)
            || self
                .staging
                .as_ref()
                .is_some_and(|f| now.saturating_duration_since(f.created) >= KEYFRAME_QUEUE_AGE)
        {
            self.reset();
        }
    }
    fn budget(&self) -> usize {
        // At most 100ms of estimated wire time, plus the bounded one-packet burst.
        byte_budget(self.bucket.target_bitrate())
    }
    fn keyframe_budget(&self) -> usize {
        keyframe_byte_budget(self.bucket.target_bitrate())
    }
    fn push(&mut self, packet: TaggedPacket, bytes: usize, expires: Instant) {
        self.bytes += bytes;
        self.queue.push_back(Queued {
            packet,
            bytes,
            expires,
        });
    }
}
fn nal_flags(payload: &[u8], codec: VideoCodec) -> u8 {
    match codec {
        VideoCodec::H264 => h264_nal_flags(payload),
        VideoCodec::H265 => h265_nal_flags(payload),
    }
}

fn h264_nal_flags(payload: &[u8]) -> u8 {
    let Some(&first) = payload.first() else {
        return 0;
    };
    match first & 31 {
        5 => 1,
        7 => 2,
        8 => 4,
        28 if payload.len() >= 2 && payload[1] & 0x80 != 0 && payload[1] & 31 == 5 => 1,
        24 => {
            let mut result = 0;
            let mut remaining = &payload[1..];
            while remaining.len() >= 2 {
                let len = u16::from_be_bytes([remaining[0], remaining[1]]) as usize;
                remaining = &remaining[2..];
                if len == 0 || len > remaining.len() {
                    return 0;
                }
                result |= h264_nal_flags(&remaining[..len]);
                remaining = &remaining[len..];
            }
            if remaining.is_empty() {
                result
            } else {
                0
            }
        }
        _ => 0,
    }
}

fn h265_nal_flags(payload: &[u8]) -> u8 {
    if payload.len() < 2 {
        return 0;
    }
    // HEVC NAL header: F(1) Type(6) LayerId(6) TID(3).
    let nalu_type = (payload[0] >> 1) & 0x3f;
    match nalu_type {
        // IRAP pictures include BLA, IDR and CRA. They are the HEVC equivalent
        // of H.264 IDR for GOP admission.
        16..=23 => 1,
        32 => 8, // VPS
        33 => 2, // SPS
        34 => 4, // PPS
        48 => {
            // Aggregation packet: PayloadHdr followed by 16-bit length-prefixed
            // NAL units. The nested NALs carry the actual keyframe flags.
            let mut result = 0;
            let mut remaining = &payload[2..];
            while remaining.len() >= 2 {
                let len = u16::from_be_bytes([remaining[0], remaining[1]]) as usize;
                remaining = &remaining[2..];
                if len == 0 || len > remaining.len() {
                    return 0;
                }
                result |= h265_nal_flags(&remaining[..len]);
                remaining = &remaining[len..];
            }
            if remaining.is_empty() {
                result
            } else {
                0
            }
        }
        49 if payload.len() >= 3 => {
            // Fragmentation unit: only the first fragment carries the original
            // NAL type in FU header bits 0..5.
            if payload[2] & 0x80 == 0 {
                0
            } else {
                match payload[2] & 0x3f {
                    16..=23 => 1,
                    _ => 0,
                }
            }
        }
        _ => 0,
    }
}

fn complete_keyframe(codec: VideoCodec, flags: u8) -> bool {
    match codec {
        // H.264 prefixes IDR with SPS/PPS.
        VideoCodec::H264 => flags & 7 == 7,
        // HEVC keyframes repeat VPS/SPS/PPS before the IRAP picture.
        VideoCodec::H265 => flags & 15 == 15,
    }
}
impl Protocol<TaggedPacket, TaggedPacket, ()> for GopPacer {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = Error;
    type Time = Instant;
    fn handle_read(&mut self, packet: TaggedPacket) -> Result<(), Error> {
        if let Some(Attribute::TargetBitrateChanged { bits_per_second }) =
            packet.message.get(&Attribute::TargetBitrateChanged {
                bits_per_second: 0.0,
            })
        {
            if bits_per_second.is_finite() && *bits_per_second > 0.0 {
                self.bucket.set_target_bitrate(*bits_per_second);
                // A one-packet burst caps throughput at one packet per timer
                // wake. Tokio/Linux timer quantization is ~1–2ms; a maintained
                // 5ms token bucket can catch up without a100ms packet burst.
                self.bucket = self
                    .bucket
                    .clone()
                    .with_burst_bits(MIN_BURST_BITS.max(*bits_per_second * BURST_TIME));
                self.feedback
                    .target_bitrate
                    .store(*bits_per_second as u64, Ordering::Relaxed);
            }
        }
        self.expire(packet.now);
        if self.bytes + self.staging.as_ref().map_or(0, |f| f.bytes) > self.keyframe_budget() {
            self.reset();
        }
        self.read.push_back(packet);
        Ok(())
    }
    fn poll_read(&mut self) -> Option<TaggedPacket> {
        self.read.pop_front()
    }
    fn handle_write(&mut self, packet: TaggedPacket) -> Result<(), Error> {
        let now = packet.now;
        self.expire(now);
        if self.feedback.paused.load(Ordering::SeqCst)
            && (!self.queue.is_empty() || self.staging.is_some())
        {
            self.reset();
        }
        self.bucket.refill(now);
        let Packet::Rtp(rtp) = &packet.message.packet else {
            self.control.push_back(packet);
            return Ok(());
        };
        if self.feedback.paused.load(Ordering::SeqCst) {
            return Ok(());
        }
        let timestamp = rtp.header.timestamp;
        let marker = rtp.header.marker;
        let bytes = rtp.marshal_size();
        if packet.message.has(&Attribute::Retransmission) {
            if !self.waiting_idr && self.recent.contains(&timestamp) {
                if self.bytes + self.staging.as_ref().map_or(0, |f| f.bytes) + bytes
                    > self.keyframe_budget()
                {
                    self.reset();
                } else {
                    let expires = self.burst_deadline.unwrap_or(now + QUEUE_AGE);
                    self.push(packet, bytes, expires);
                    self.publish();
                }
            }
            return Ok(());
        }
        if self
            .staging
            .as_ref()
            .is_some_and(|f| f.timestamp != timestamp)
        {
            self.reset();
        }
        if self.staging.is_none() {
            if self
                .latest
                .is_some_and(|last| timestamp.wrapping_sub(last) as i32 <= 0)
            {
                return Ok(());
            }
            self.staging = Some(Frame {
                timestamp,
                created: now,
                packets: Vec::new(),
                bytes: 0,
                nals: 0,
            });
        }
        let total = self.bytes + self.staging.as_ref().unwrap().bytes + bytes;
        if total > self.keyframe_budget() {
            self.latest = Some(timestamp);
            self.reset();
            return Ok(());
        }
        let frame = self.staging.as_mut().unwrap();
        frame.bytes += bytes;
        frame.nals |= nal_flags(&rtp.payload, self.codec);
        frame.packets.push(packet);
        if marker {
            let frame = self.staging.take().unwrap();
            self.latest = Some(timestamp);
            let keyframe = complete_keyframe(self.codec, frame.nals);
            let allowed = if keyframe {
                self.keyframe_budget()
            } else {
                self.budget()
            };
            if (!self.waiting_idr || keyframe) && frame.bytes <= allowed {
                self.waiting_idr = false;
                let expires = if keyframe {
                    let deadline = frame.created + KEYFRAME_QUEUE_AGE;
                    self.burst_deadline = Some(deadline);
                    deadline
                } else {
                    self.burst_deadline.unwrap_or(frame.created + QUEUE_AGE)
                };
                self.recent.push_back(timestamp);
                if self.recent.len() > MAX_RECENT {
                    self.recent.pop_front();
                }
                for packet in frame.packets {
                    let bytes = match &packet.message.packet {
                        Packet::Rtp(r) => r.marshal_size(),
                        _ => 0,
                    };
                    self.push(packet, bytes, expires);
                }
            } else {
                if keyframe || !self.waiting_idr {
                    self.reset();
                } else {
                    self.feedback.request_idr.store(true, Ordering::SeqCst);
                }
            }
        }
        self.publish();
        Ok(())
    }
    fn poll_write(&mut self) -> Option<TaggedPacket> {
        if self.feedback.reset_requested.swap(false, Ordering::SeqCst) {
            self.reset();
        }
        self.control.pop_front()
    }
    fn handle_timeout(&mut self, now: Instant) -> Result<(), Error> {
        self.expire(now);
        if self.feedback.paused.load(Ordering::SeqCst)
            && (!self.queue.is_empty() || self.staging.is_some())
        {
            self.reset();
        }
        self.bucket.refill(now);
        while self
            .queue
            .front()
            .is_some_and(|q| self.bucket.can_release((q.bytes * 8) as f64))
        {
            let mut q = self.queue.pop_front().unwrap();
            self.bytes -= q.bytes;
            self.bucket.consume((q.bytes * 8) as f64);
            q.packet.now = now;
            self.control.push_back(q.packet);
        }
        self.publish();
        Ok(())
    }
    fn poll_timeout(&mut self) -> Option<Instant> {
        let release = self
            .queue
            .front()
            .and_then(|q| self.bucket.releasable_at((q.bytes * 8) as f64));
        let expiry = self
            .queue
            .front()
            .map(|q| q.expires)
            .into_iter()
            .chain(
                self.staging
                    .as_ref()
                    .map(|f| f.created + KEYFRAME_QUEUE_AGE),
            )
            .min();
        release.into_iter().chain(expiry).min()
    }
}
impl Interceptor for GopPacer {
    fn bind_local_stream(&mut self, _: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _: &StreamInfo) {
        self.reset();
    }
    fn bind_remote_stream(&mut self, _: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _: &StreamInfo) {}
}
