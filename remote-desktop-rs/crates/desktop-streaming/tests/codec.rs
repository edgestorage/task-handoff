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
fn level_four_and_full_hd_limits_are_promoted_for_h264() {
    let offer = "m=video 9 UDP/TLS/RTP/SAVPF 108\r\n\
        a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n";
    let promoted = desktop_streaming::codec::promote_h264_level_4_0(offer);
    assert!(promoted.contains("profile-level-id=42e028"));
    assert!(promoted.contains("max-fs=8160"));
    assert!(promoted.contains("max-mbps=244800"));
    assert_eq!(
        Limits::parse("level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028;max-fs=8160;max-mbps=244800")
            .unwrap()
            .level,
        40
    );

    let no_asymmetry = "m=video 9 UDP/TLS/RTP/SAVPF 108\r\n\
        a=fmtp:108 packetization-mode=1;profile-level-id=42e01f\r\n";
    let promoted = desktop_streaming::codec::promote_h264_level_4_0(no_asymmetry);
    assert!(promoted.contains("level-asymmetry-allowed=1"));
    assert!(promoted.contains("profile-level-id=42e028"));
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
    assert_eq!(limits.max_bitrate, 8_000_000);
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
