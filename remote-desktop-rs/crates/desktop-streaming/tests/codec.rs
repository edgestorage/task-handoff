use desktop_streaming::{codec::Limits, synthetic::SoftwareEncoder, video::Budget};
use openh264::{
    decoder::Decoder,
    formats::{YUVBuffer, YUVSource},
};
#[test]
fn receiver_level_and_optional_limits_bound_sender_work() {
    for level in [10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 42, 52] {
        let limits = Limits::parse(&format!(
            "packetization-mode=1;profile-level-id=42e0{level:02x}"
        ))
        .unwrap();
        for (w, h) in [(1920, 1080), (1080, 1920), (8192, 2), (2, 8192)] {
            let b = Budget::select_with_limits(w, h, 8_000_000, limits);
            let fs = b.width.div_ceil(16) * b.height.div_ceil(16);
            assert!(
                fs <= limits.max_fs && fs * b.fps <= limits.max_mbps,
                "level{level}: {}x{}@{}",
                b.width,
                b.height,
                b.fps
            );
        }
    }
    let low = Limits::default();
    let high = Limits::parse("packetization-mode=1;profile-level-id=42e028").unwrap();
    assert_eq!(
        Budget::select_with_limits(1920, 1080, 8_000_000, low).width,
        1280
    );
    assert_eq!(
        Budget::select_with_limits(1920, 1080, 8_000_000, high),
        Budget {
            width: 1920,
            height: 1080,
            fps: 30
        }
    );
    assert_eq!(
        Budget::select_with_limits_and_resolution(1920, 1080, 8_000_000, high, Some((1280, 720))),
        Budget {
            width: 1280,
            height: 720,
            fps: 30
        }
    );
    assert_eq!(
        Budget::select_with_limits_and_resolution(1920, 1080, 8_000_000, high, Some((1920, 1200))),
        Budget {
            width: 1920,
            height: 1080,
            fps: 30
        }
    );
    assert_eq!(
        Budget::select_with_limits_resolution_and_fps(
            1920,
            1080,
            8_000_000,
            high,
            Some((1280, 720)),
            Some(15),
        ),
        Budget {
            width: 1280,
            height: 720,
            fps: 15
        }
    );
    let restricted = Limits::parse(
        "packetization-mode=1;profile-level-id=42e028;max-fs=1200;max-mbps=12000;max-br=500",
    )
    .unwrap();
    assert_eq!(restricted.max_bitrate, 500_000);
    let b = Budget::select_with_limits(1920, 1080, 500_000, restricted);
    assert!(b.width.div_ceil(16) * b.height.div_ceil(16) * b.fps <= 12000);
    assert!((b.width as i64 * 1080 - b.height as i64 * 1920).abs() <= 2 * (1920 + 1080));
    let tiny = Limits::parse("packetization-mode=1;profile-level-id=42e028;max-mbps=1").unwrap();
    let b = Budget::select_with_limits(1920, 1080, 8_000_000, tiny);
    assert_eq!(b.width.div_ceil(16) * b.height.div_ceil(16) * b.fps, 1);
}

#[test]
fn answer_level_follows_receiver_sdp_capabilities() {
    let full_hd = desktop_streaming::codec::negotiate_h264_offer(
        "m=video 9 UDP/TLS/RTP/SAVPF 108\r\n\
         a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;max-fs=8160;max-mbps=244800\r\n",
    )
    .unwrap();
    assert_eq!(full_hd.limits.level, 40);
    assert_eq!(
        (full_hd.limits.max_fs, full_hd.limits.max_mbps),
        (8160, 244800)
    );
    assert!(full_hd.answer_fmtp.contains("profile-level-id=42e028"));

    let offered_only = desktop_streaming::codec::negotiate_h264_offer(
        "m=video 9 UDP/TLS/RTP/SAVPF 108\r\n\
         a=fmtp:108 packetization-mode=1;profile-level-id=42e01f\r\n",
    )
    .unwrap();
    assert_eq!(offered_only.limits.level, 31);
    assert_eq!(
        (offered_only.limits.max_fs, offered_only.limits.max_mbps),
        (3600, 108000)
    );
    assert!(offered_only.answer_fmtp.contains("profile-level-id=42e01f"));

    let asymmetric_only = desktop_streaming::codec::negotiate_h264_offer(
        "m=video 9 UDP/TLS/RTP/SAVPF 108\r\n\
         a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n",
    )
    .unwrap();
    assert_eq!(asymmetric_only.limits.level, 51);
    assert_eq!(
        (
            asymmetric_only.limits.max_fs,
            asymmetric_only.limits.max_mbps
        ),
        (36864, 983040)
    );
    assert!(asymmetric_only
        .answer_fmtp
        .contains("profile-level-id=42e033"));

    let only_frame_limit = desktop_streaming::codec::negotiate_h264_offer(
        "m=video 9 UDP/TLS/RTP/SAVPF 108\r\n\
         a=fmtp:108 packetization-mode=1;profile-level-id=42e01f;max-fs=8160\r\n",
    )
    .unwrap();
    assert_eq!(only_frame_limit.limits.level, 40);
    assert_eq!(only_frame_limit.limits.max_mbps, 245760);

    let four_k = desktop_streaming::codec::negotiate_h264_offer(
        "m=video 9 UDP/TLS/RTP/SAVPF 108\r\n\
         a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e033;max-fs=36864;max-mbps=983040\r\n",
    )
    .unwrap();
    assert_eq!(four_k.limits.level, 51);
    assert_eq!(
        (four_k.limits.max_fs, four_k.limits.max_mbps),
        (36864, 983040)
    );
    assert!(four_k.answer_fmtp.contains("profile-level-id=42e033"));

    let two_k = desktop_streaming::codec::negotiate_h264_offer(
        "m=video 9 UDP/TLS/RTP/SAVPF 108\r\n\
         a=fmtp:108 packetization-mode=1;profile-level-id=42e033;max-fs=22080;max-mbps=589824\r\n",
    )
    .unwrap();
    assert_eq!(two_k.limits.level, 50);
    assert!(two_k.answer_fmtp.contains("profile-level-id=42e032"));
}

#[test]
fn h265_offer_uses_main_profile_and_receiver_level_limits() {
    let offer = "m=video 9 UDP/TLS/RTP/SAVPF 49\r\n\
        a=rtpmap:49 H265/90000\r\n\
        a=fmtp:49 profile-id=1;tier-flag=0;level-id=153;max-br=16000;tx-mode=SRST\r\n";
    let negotiation = desktop_streaming::codec::negotiate_h265_offer(offer).unwrap();
    assert_eq!(negotiation.limits.level, 153);
    assert_eq!(negotiation.limits.max_fs, 34_816);
    assert_eq!(negotiation.limits.max_mbps, 2_088_960);
    assert_eq!(negotiation.limits.max_bitrate, 16_000_000);

    let level_four =
        desktop_streaming::codec::negotiate_h265_fmtp("profile-id=1;tier-flag=0;level-id=120")
            .unwrap();
    assert_eq!(level_four.max_fs, 8_704);
    assert_eq!(level_four.max_mbps, 261_120);
    assert_eq!(level_four.max_bitrate, 8_000_000);
}

#[test]
fn unsupported_h265_profiles_tiers_and_modes_fail_closed() {
    for fmtp in [
        "profile-id=2;level-id=153",
        "profile-id=1;tier-flag=1;level-id=153",
        "profile-id=1;tx-mode=MRMT",
        "profile-id=1;level-id=121",
        "profile-id=1;profile-id=1",
        "profile-id=1;max-fs=0",
    ] {
        assert!(
            desktop_streaming::codec::negotiate_h265_fmtp(fmtp).is_err(),
            "accepted {fmtp}"
        );
    }
    assert!(desktop_streaming::codec::negotiate_h265_offer(
        "m=video 9 UDP/TLS/RTP/SAVPF 49\r\na=rtpmap:49 H264/90000\r\n"
    )
    .is_err());
}

#[test]
fn negotiated_answer_fmtp_replaces_the_video_format() {
    let answer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n\
        a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028\r\n\
        m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
    let rewritten = desktop_streaming::codec::rewrite_h264_answer_fmtp(
        answer,
        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e033;max-fs=36864;max-mbps=983040;max-br=24000",
    )
    .unwrap();
    assert!(rewritten.contains("profile-level-id=42e033"));
    assert!(rewritten.contains("max-fs=36864"));
    assert!(!rewritten.contains("profile-level-id=42e028"));
}
#[test]
fn malformed_constraints_and_incompatible_profiles_are_not_silently_ignored() {
    for fmtp in [
        "packetization-mode=0;profile-level-id=42e028",
        "packetization-mode=1;profile-level-id=640028",
        "packetization-mode=1;profile-level-id=42e0ff00",
        "packetization-mode=1;max-fs=0",
        "packetization-mode=1;max-mbps=oops",
        "packetization-mode=1;max-fs=1;max-fs=2",
    ] {
        assert!(Limits::parse(fmtp).is_err(), "accepted {fmtp}");
    }
}
#[test]
fn future_optional_parameters_and_large_receiver_allowances_do_not_restrict_local_support() {
    let limits = Limits::parse("packetization-mode=1;profile-level-id=42e028;max-br=4294967295;max-fs=4294967295;max-mbps=4294967295;future-flag;future-value=a;future-value=b").unwrap();
    assert_eq!(limits.max_fs, 8192);
    assert_eq!(limits.max_mbps, 245760);
    assert_eq!(limits.max_bitrate, 24_000_000);
}

#[test]
fn level_four_idr_decodes_at_full_hd_with_fresh_decoder_state() {
    let limits = Limits::parse("packetization-mode=1;profile-level-id=42e028").unwrap();
    let mut encoder = SoftwareEncoder::with_limits(4_000_000, limits).unwrap();
    let yuv = YUVBuffer::new(1920, 1080);
    let frame = encoder.encode(&yuv, true).unwrap().unwrap();
    let mut decoder = Decoder::new().unwrap();
    let decoded = decoder.decode(&frame.annex_b).unwrap().unwrap();
    assert_eq!(decoded.dimensions(), (1920, 1080));
    // SPS: NAL type7, profile_idc, constraint flags, level_idc.
    let sps = openh264::nal_units(&frame.annex_b)
        .find_map(|nal| {
            let data = nal
                .strip_prefix(&[0, 0, 0, 1])
                .or_else(|| nal.strip_prefix(&[0, 0, 1]))?;
            (data.first().is_some_and(|b| b & 31 == 7)).then_some(data)
        })
        .unwrap();
    assert_eq!(sps[3], 40);
}
