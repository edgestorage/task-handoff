use desktop_streaming::{
    codec::{Limits, VideoCodec},
    encoder::{Encoder, Policy},
    synthetic::{pattern, SyntheticInput},
    video::{scale_yuv, Budget},
};
use openh264::formats::YUVSource;
#[test]
fn explicit_software_and_unsupported_hardware_level_both_emit_fresh_decodable_idrs() {
    let limits = Limits::parse("packetization-mode=1;profile-level-id=42e00a").unwrap();
    let yuv = scale_yuv(
        pattern(0, &SyntheticInput::default()),
        Budget {
            width: 128,
            height: 96,
            fps: 10,
        },
    )
    .unwrap();
    #[cfg(target_os = "macos")]
    let policies = [Policy::Software, Policy::Automatic];
    #[cfg(not(target_os = "macos"))]
    let policies = [Policy::Software];
    // Linux automatic fallback is exercised by the actual sibling-helper
    // diagnostic, not a Cargo test image whose sibling path differs.
    for policy in policies {
        let mut encoder = Encoder::new(100_000, limits, 0, policy, VideoCodec::H264).unwrap();
        // VT has no level1.0 profile option; the real adapter must fail closed
        // to OpenH264, rather than encode above the negotiated receiver level.
        let frame = encoder.encode(&yuv, false).unwrap().unwrap();
        assert_eq!(encoder.name(), "openh264");
        assert!(encoder.is_software());
        assert!(frame.keyframe);
        let mut decoder = openh264::decoder::Decoder::new().unwrap();
        assert_eq!(
            decoder
                .decode(&frame.annex_b)
                .unwrap()
                .unwrap()
                .dimensions(),
            (128, 96)
        );
        encoder
            .reconfigure(120_000, limits, 24, VideoCodec::H264)
            .unwrap();
        let frame = encoder.encode(&yuv, true).unwrap().unwrap();
        assert!(frame.keyframe);
        assert_eq!(encoder.name(), "openh264");
    }
}
