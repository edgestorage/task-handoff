use desktop_streaming::{
    codec::VideoCodec,
    pacing::{
        byte_budget, keyframe_byte_budget, GopPacer, PacingFeedback, KEYFRAME_QUEUE_AGE, QUEUE_AGE,
    },
    video::INITIAL_BITRATE,
};
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
fn h265_nal(nal_type: u8, payload: &[u8]) -> Vec<u8> {
    let mut nal = vec![nal_type << 1, 1];
    nal.extend_from_slice(payload);
    nal
}
fn h265_ap(nals: &[Vec<u8>]) -> Vec<u8> {
    let mut payload = vec![48 << 1, 1];
    for nal in nals {
        payload.extend_from_slice(&(nal.len() as u16).to_be_bytes());
        payload.extend_from_slice(nal);
    }
    payload
}
fn h265_idr(now: Instant, ts: u32, seq: u16, marker: bool) -> TaggedPacket {
    packet(
        now,
        ts,
        seq,
        marker,
        h265_ap(&[
            h265_nal(32, &[0; 8]),
            h265_nal(33, &[0; 8]),
            h265_nal(34, &[0; 8]),
            h265_nal(19, &[0xaa; 100]),
        ]),
    )
}
fn h265_p_frame(now: Instant, ts: u32, seq: u16) -> TaggedPacket {
    packet(now, ts, seq, true, [&[0x02, 0x01][..], &[0; 100]].concat())
}
fn drain(p: &mut GopPacer) -> Vec<TaggedPacket> {
    let mut out = Vec::new();
    while let Some(v) = p.poll_write() {
        out.push(v);
    }
    out
}

#[test]
fn hevc_aggregation_keyframe_unblocks_gop_admission() {
    let now = Instant::now();
    let feedback = Arc::new(PacingFeedback::default());
    feedback.set_codec(VideoCodec::H265);
    let mut p = GopPacer::new(feedback.clone());

    p.handle_write(h265_p_frame(now, 1, 1)).unwrap();
    p.handle_timeout(now).unwrap();
    assert!(drain(&mut p).is_empty());
    assert!(feedback.request_idr.load(Ordering::SeqCst));

    p.handle_write(h265_idr(now, 2, 2, true)).unwrap();
    p.handle_timeout(now).unwrap();
    assert_eq!(drain(&mut p).len(), 1);

    p.handle_write(h265_p_frame(now, 3, 3)).unwrap();
    p.handle_timeout(now).unwrap();
    assert_eq!(drain(&mut p).len(), 1);
}

#[test]
fn hevc_fragment_first_slice_can_complete_a_keyframe() {
    let now = Instant::now();
    let feedback = Arc::new(PacingFeedback::default());
    feedback.set_codec(VideoCodec::H265);
    let mut p = GopPacer::new(feedback.clone());

    p.handle_write(packet(
        now,
        1,
        1,
        false,
        h265_ap(&[
            h265_nal(32, &[0; 8]),
            h265_nal(33, &[0; 8]),
            h265_nal(34, &[0; 8]),
        ]),
    ))
    .unwrap();
    // FU header: start bit + IDR_W_RADL (type 19). The nested header follows.
    p.handle_write(packet(
        now,
        1,
        2,
        true,
        vec![49 << 1, 1, 0x80 | 19, 19 << 1, 1, 0xaa],
    ))
    .unwrap();
    p.handle_timeout(now).unwrap();

    assert_eq!(drain(&mut p).len(), 2);
    assert!(!feedback.request_idr.load(Ordering::SeqCst));
}

#[test]
fn hevc_parameter_sets_alone_do_not_start_the_gop() {
    let now = Instant::now();
    let feedback = Arc::new(PacingFeedback::default());
    feedback.set_codec(VideoCodec::H265);
    let mut p = GopPacer::new(feedback.clone());

    p.handle_write(packet(
        now,
        1,
        1,
        true,
        h265_ap(&[
            h265_nal(32, &[0; 8]),
            h265_nal(33, &[0; 8]),
            h265_nal(34, &[0; 8]),
        ]),
    ))
    .unwrap();
    p.handle_timeout(now).unwrap();
    assert!(drain(&mut p).is_empty());
    assert!(feedback.request_idr.load(Ordering::SeqCst));
}

#[test]
fn codec_switch_waits_for_a_keyframe_in_the_new_codec() {
    let now = Instant::now();
    let feedback = Arc::new(PacingFeedback::default());
    let mut p = GopPacer::new(feedback.clone());
    p.handle_write(idr(now, 1, 1)).unwrap();
    p.handle_timeout(now).unwrap();
    drain(&mut p);

    feedback.set_codec(VideoCodec::H265);
    p.handle_write(h265_p_frame(now, 2, 2)).unwrap();
    p.handle_timeout(now).unwrap();
    assert!(drain(&mut p).is_empty());
    assert_eq!(feedback.resets.load(Ordering::Relaxed), 1);

    p.handle_write(h265_idr(now, 3, 3, true)).unwrap();
    p.handle_timeout(now).unwrap();
    assert_eq!(drain(&mut p).len(), 1);
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
    // Derive the oversize payload from the shared initial rate so future
    // encoder budget changes cannot silently invalidate this boundary test.
    let oversized = keyframe_byte_budget(INITIAL_BITRATE as f64) * 2;
    p.handle_write(packet(now, 2, 2, true, vec![0x61; oversized]))
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
    p.handle_timeout(now + KEYFRAME_QUEUE_AGE).unwrap();
    assert!(drain(&mut p).is_empty());
    p.handle_write(TaggedPacket {
        now: now + KEYFRAME_QUEUE_AGE,
        transport: TransportContext::default(),
        message: AttributedPacket::new(Packet::Rtcp(vec![])),
    })
    .unwrap();
    assert_eq!(drain(&mut p).len(), 1);
    assert!(p.poll_timeout().is_none());
    assert_eq!(f.queued_bytes.load(Ordering::Relaxed), 0);
}

#[test]
fn keyframe_burst_fits_without_stalling_the_interframe_budget() {
    let now = Instant::now();
    let feedback = Arc::new(PacingFeedback::default());
    let mut p = GopPacer::new(feedback.clone());
    let keyframe_bytes = byte_budget(INITIAL_BITRATE as f64) + 50_000;
    assert!(keyframe_bytes < keyframe_byte_budget(INITIAL_BITRATE as f64));

    p.handle_write(packet(now, 1, 1, false, vec![24, 0, 1, 0x67, 0, 1, 0x68]))
        .unwrap();
    p.handle_write(packet(now, 1, 2, true, vec![0x65; keyframe_bytes]))
        .unwrap();
    p.handle_timeout(now).unwrap();
    assert!(!drain(&mut p).is_empty());
    assert_eq!(feedback.resets.load(Ordering::Relaxed), 0);

    p.handle_write(packet(
        now + Duration::from_millis(100),
        2,
        3,
        true,
        vec![0x61; keyframe_bytes],
    ))
    .unwrap();
    p.handle_timeout(now + Duration::from_millis(100)).unwrap();
    assert_eq!(feedback.resets.load(Ordering::Relaxed), 1);
    assert!(feedback.request_idr.load(Ordering::SeqCst));
}

#[test]
fn keyframe_queue_window_survives_interframe_expiry() {
    let now = Instant::now();
    let feedback = Arc::new(PacingFeedback::default());
    let mut p = GopPacer::new(feedback.clone());
    let keyframe_bytes = byte_budget(INITIAL_BITRATE as f64) + 50_000;
    p.handle_write(idr(now, 1, 1)).unwrap();
    p.handle_write(packet(now, 1, 2, true, vec![0x65; keyframe_bytes]))
        .unwrap();
    p.handle_timeout(now).unwrap();
    drain(&mut p);

    p.handle_timeout(now + QUEUE_AGE).unwrap();
    assert_eq!(feedback.resets.load(Ordering::Relaxed), 0);
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
