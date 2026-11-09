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
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const QUEUE_AGE: Duration = Duration::from_millis(100);
pub const QUEUE_BYTES: usize = 256 * 1024;
pub fn byte_budget(bitrate: f64) -> usize {
    ((bitrate * QUEUE_AGE.as_secs_f64() / 8.0) as usize)
        .saturating_add(1500)
        .min(QUEUE_BYTES)
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
    enqueued: Instant,
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
        self.feedback.request_idr.store(true, Ordering::SeqCst);
        self.feedback.resets.fetch_add(1, Ordering::Relaxed);
        self.publish();
    }
    fn expire(&mut self, now: Instant) {
        if self.feedback.reset_requested.swap(false, Ordering::SeqCst) {
            self.reset();
        }
        if self
            .queue
            .front()
            .is_some_and(|q| now.saturating_duration_since(q.enqueued) >= QUEUE_AGE)
            || self
                .staging
                .as_ref()
                .is_some_and(|f| now.saturating_duration_since(f.created) >= QUEUE_AGE)
        {
            self.reset();
        }
    }
    fn budget(&self) -> usize {
        // At most 100ms of estimated wire time, plus the bounded one-packet burst.
        byte_budget(self.bucket.target_bitrate())
    }
    fn push(&mut self, packet: TaggedPacket, bytes: usize, enqueued: Instant) {
        self.bytes += bytes;
        self.queue.push_back(Queued {
            packet,
            bytes,
            enqueued,
        });
    }
}
fn nal_flags(payload: &[u8]) -> u8 {
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
                result |= nal_flags(&remaining[..len]);
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
        if self.bytes + self.staging.as_ref().map_or(0, |f| f.bytes) > self.budget() {
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
                if self.bytes + self.staging.as_ref().map_or(0, |f| f.bytes) + bytes > self.budget()
                {
                    self.reset();
                } else {
                    self.push(packet, bytes, now);
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
        if total > self.budget() {
            self.latest = Some(timestamp);
            self.reset();
            return Ok(());
        }
        let frame = self.staging.as_mut().unwrap();
        frame.bytes += bytes;
        frame.nals |= nal_flags(&rtp.payload);
        frame.packets.push(packet);
        if marker {
            let frame = self.staging.take().unwrap();
            self.latest = Some(timestamp);
            if !self.waiting_idr || frame.nals == 7 {
                self.waiting_idr = false;
                self.recent.push_back(timestamp);
                if self.recent.len() > MAX_RECENT {
                    self.recent.pop_front();
                }
                for packet in frame.packets {
                    let bytes = match &packet.message.packet {
                        Packet::Rtp(r) => r.marshal_size(),
                        _ => 0,
                    };
                    self.push(packet, bytes, frame.created);
                }
            } else {
                self.feedback.request_idr.store(true, Ordering::SeqCst);
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
            .map(|q| q.enqueued + QUEUE_AGE)
            .into_iter()
            .chain(self.staging.as_ref().map(|f| f.created + QUEUE_AGE))
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
