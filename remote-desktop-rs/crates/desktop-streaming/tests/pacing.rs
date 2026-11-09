use desktop_streaming::pacing::{GopPacer, PacingFeedback, QUEUE_AGE};
use rtc::{
    interceptor::{Attribute, AttributedPacket, Packet, TaggedPacket},
    sansio::Protocol,
    shared::TransportContext,
};
use std::{
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
fn packet(now: Instant, ts: u32, seq: u16, marker: bool, payload: Vec<u8>) -> TaggedPacket {
    TaggedPacket {
        now,
        transport: TransportContext::default(),
        message: AttributedPacket::new(Packet::Rtp(rtc::rtp::Packet {
            header: rtc::rtp::header::Header {
                version: 2,
                payload_type: 96,
                ssrc: 1,
                timestamp: ts,
                sequence_number: seq,
                marker,
                ..Default::default()
            },
            payload: payload.into(),
        })),
    }
}
fn idr(now: Instant, ts: u32, seq: u16) -> TaggedPacket {
    packet(
        now,
        ts,
        seq,
        true,
        vec![24, 0, 1, 0x67, 0, 1, 0x68, 0, 1, 0x65],
    )
}
fn drain(p: &mut GopPacer) -> Vec<TaggedPacket> {
    let mut out = Vec::new();
    while let Some(v) = p.poll_write() {
        out.push(v);
    }
    out
}
#[test]
fn entire_frames_are_admitted_and_pacing_preserves_release_time() {
    let now = Instant::now();
    let feedback = Arc::new(PacingFeedback::default());
    let mut p = GopPacer::new(feedback.clone());
    p.handle_write(packet(now, 1, 1, false, vec![24, 0, 1, 0x67, 0, 1, 0x68]))
        .unwrap();
    p.handle_timeout(now).unwrap();
    assert!(drain(&mut p).is_empty());
    p.handle_write(packet(now, 1, 2, true, vec![0x65; 1000]))
        .unwrap();
    p.handle_timeout(now).unwrap();
    assert_eq!(drain(&mut p).len(), 2);
    // The maintained pacer starts with a bounded burst, so use a frame larger
    // than that burst to exercise the release schedule rather than the burst.
    p.handle_write(packet(now, 2, 3, true, vec![0x61; 4000]))
        .unwrap();
    p.handle_timeout(now).unwrap();
    assert!(drain(&mut p).is_empty());
    let release = p.poll_timeout().unwrap();
    assert!(release > now && release < now + QUEUE_AGE);
    p.handle_timeout(release).unwrap();
    let out = drain(&mut p);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].now, release);
    assert_eq!(feedback.queued_bytes.load(Ordering::Relaxed), 0);
}
#[test]
fn byte_overflow_discards_whole_gop_and_old_retransmissions_until_fresh_idr() {
    let now = Instant::now();
    let f = Arc::new(PacingFeedback::default());
    let mut p = GopPacer::new(f.clone());
    p.handle_write(idr(now, 1, 1)).unwrap();
    // INITIAL_BITRATE is 4 Mbps, so the 100 ms byte budget is about 51 KiB.
    // Exceed it explicitly instead of relying on the previous 2 Mbps budget.
    p.handle_write(packet(now, 2, 2, true, vec![0x61; 64_000]))
        .unwrap();
    p.handle_timeout(now).unwrap();
    assert!(drain(&mut p).is_empty());
    assert!(f.request_idr.load(Ordering::SeqCst));
    assert_eq!(f.resets.load(Ordering::Relaxed), 1);
    let mut old = idr(now, 1, 1);
    old.message.add(Attribute::Retransmission);
    p.handle_write(old).unwrap();
    p.handle_write(packet(now, 3, 3, true, vec![0x61; 100]))
        .unwrap();
    p.handle_timeout(now).unwrap();
    assert!(drain(&mut p).is_empty());
    p.handle_write(idr(now, 4, 4)).unwrap();
    p.handle_timeout(now).unwrap();
    assert_eq!(drain(&mut p).len(), 1);
}
#[test]
fn expiry_runs_without_new_media_and_preserves_rtcp() {
    let now = Instant::now();
    let f = Arc::new(PacingFeedback::default());
    let mut p = GopPacer::new(f.clone());
    p.handle_write(idr(now, 1, 1)).unwrap();
    p.handle_timeout(now + QUEUE_AGE).unwrap();
    assert!(drain(&mut p).is_empty());
    p.handle_write(TaggedPacket {
        now: now + QUEUE_AGE,
        transport: TransportContext::default(),
        message: AttributedPacket::new(Packet::Rtcp(vec![])),
    })
    .unwrap();
    assert_eq!(drain(&mut p).len(), 1);
    assert!(p.poll_timeout().is_none());
    assert_eq!(f.queued_bytes.load(Ordering::Relaxed), 0);
}
#[test]
fn feedback_shrink_drops_pending_gop_and_timestamp_wrap_is_accepted() {
    let now = Instant::now();
    let f = Arc::new(PacingFeedback::default());
    let mut p = GopPacer::new(f.clone());
    p.handle_write(idr(now, u32::MAX - 100, 1)).unwrap();
    p.handle_timeout(now).unwrap();
    drain(&mut p);
    p.handle_write(packet(
        now + Duration::from_millis(1),
        10,
        2,
        true,
        vec![0x61; 6000],
    ))
    .unwrap();
    let mut feedback = TaggedPacket {
        now: now + Duration::from_millis(2),
        transport: TransportContext::default(),
        message: AttributedPacket::new(Packet::Rtcp(vec![])),
    };
    feedback.message.add(Attribute::TargetBitrateChanged {
        bits_per_second: 100_000.0,
    });
    p.handle_read(feedback).unwrap();
    assert_eq!(f.resets.load(Ordering::Relaxed), 1);
    assert_eq!(f.queued_bytes.load(Ordering::Relaxed), 0);
    p.handle_write(idr(now + Duration::from_millis(3), 20, 3))
        .unwrap();
    p.handle_timeout(now + Duration::from_millis(3)).unwrap();
    assert_eq!(drain(&mut p).len(), 1);
}

#[test]
fn pause_discards_queued_media_and_rejects_dependent_frames_on_resume() {
    let now = Instant::now();
    let f = Arc::new(PacingFeedback::default());
    let mut p = GopPacer::new(f.clone());
    p.handle_write(idr(now, 1, 1)).unwrap();
    f.paused.store(true, Ordering::SeqCst);
    p.handle_timeout(now).unwrap();
    assert!(drain(&mut p).is_empty());
    assert_eq!(f.queued_bytes.load(Ordering::Relaxed), 0);
    p.handle_write(idr(now, 2, 2)).unwrap();
    assert_eq!(f.queued_bytes.load(Ordering::Relaxed), 0);
    f.paused.store(false, Ordering::SeqCst);
    p.handle_write(packet(now, 3, 3, true, vec![0x61; 100]))
        .unwrap();
    p.handle_timeout(now).unwrap();
    assert!(drain(&mut p).is_empty());
    p.handle_write(idr(now, 4, 4)).unwrap();
    p.handle_timeout(now).unwrap();
    assert_eq!(drain(&mut p).len(), 1);
}

#[test]
fn delayed_timer_wakes_can_sustain_the_feedback_rate_without_gop_resets() {
    let now = Instant::now();
    let feedback = Arc::new(PacingFeedback::default());
    let mut p = GopPacer::new(feedback.clone());
    let mut rate = TaggedPacket {
        now,
        transport: TransportContext::default(),
        message: AttributedPacket::new(Packet::Rtcp(vec![])),
    };
    rate.message.add(Attribute::TargetBitrateChanged {
        bits_per_second: 8_000_000.0,
    });
    p.handle_read(rate).unwrap();
    p.handle_write(idr(now, 1, 0)).unwrap();
    p.handle_timeout(now).unwrap();
    drain(&mut p);
    let mut released = 0;
    // A 3ms scheduler cadence must release three 1000-byte packets per wake.
    // A one-packet bucket instead accumulates a GOP until the100ms deadline.
    for tick in 1..=100u16 {
        let at = now + Duration::from_millis(tick as u64 * 3);
        for sub in 0..3 {
            let seq = tick * 3 + sub;
            p.handle_write(packet(at, seq as u32, seq, true, vec![0x61; 988]))
                .unwrap();
        }
        p.handle_timeout(at).unwrap();
        released += drain(&mut p).len();
    }
    assert!(released >= 297, "released only {released} packets");
    assert_eq!(feedback.resets.load(Ordering::Relaxed), 0);
    assert!(feedback.max_queued_bytes.load(Ordering::Relaxed) <= 6000);
}

#[test]
fn format_change_discards_even_released_but_not_yet_polled_rtp() {
    let now = Instant::now();
    let feedback = Arc::new(PacingFeedback::default());
    let mut p = GopPacer::new(feedback.clone());
    p.handle_write(idr(now, 1, 1)).unwrap();
    p.handle_timeout(now).unwrap();
    // The packet is already in the outbound stage, not the pacing queue.
    feedback.reset_requested.store(true, Ordering::SeqCst);
    assert!(p.poll_write().is_none());
    p.handle_write(packet(now, 2, 2, true, vec![0x61; 100]))
        .unwrap();
    p.handle_timeout(now).unwrap();
    assert!(drain(&mut p).is_empty());
    p.handle_write(idr(now, 3, 3)).unwrap();
    p.handle_timeout(now).unwrap();
    assert_eq!(drain(&mut p).len(), 1);
}
