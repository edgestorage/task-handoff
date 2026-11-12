use desktop_streaming::{
    codec::Limits,
    traits::{Geometry, RawFrame},
    video::{
        from_bgra, Budget, FALLBACK_LIMITS, FALLBACK_MAX_BITRATE, FALLBACK_MAX_HEIGHT,
        FALLBACK_MAX_WIDTH, INITIAL_BITRATE,
    },
};
use openh264::formats::YUVSource;
use std::time::Instant;
#[test]
fn padded_bgra_rows_do_not_turn_padding_into_pixels_and_scale_preserves_color() {
    let geometry = Geometry {
        x: 0,
        y: 0,
        width: 8,
        height: 4,
        scale: 1.0,
    };
    let mut bytes = Vec::new();
    for _ in 0..4 {
        for _ in 0..8 {
            bytes.extend([0, 0, 255, 255]);
        }
        bytes.extend([0, 255, 0, 255, 0, 255, 0, 255]);
    }
    let yuv = from_bgra(
        RawFrame {
            bgra: bytes,
            stride: 40,
            geometry,
            captured_at: Instant::now(),
        },
        Budget {
            width: 4,
            height: 2,
            fps: 15,
        },
    )
    .unwrap();
    assert_eq!(yuv.dimensions(), (4, 2));
    assert!(yuv.y().iter().all(|y| y.abs_diff(yuv.y()[0]) < 2));
    // BT.709 limited red is Y63/U102/V240; BT.601 would produce Y82.
    assert!(yuv.y().iter().all(|y| y.abs_diff(63) <= 1));
    assert!(yuv.u().iter().all(|u| u.abs_diff(102) <= 1));
    assert!(yuv.v().iter().all(|v| *v > 200));
}
#[test]
fn truncated_frames_fail_and_budgets_keep_aspect_ratio_even_dimensions_and_codec_limits() {
    let geometry = Geometry {
        x: 0,
        y: 0,
        width: 8,
        height: 4,
        scale: 1.0,
    };
    assert!(from_bgra(
        RawFrame {
            bgra: vec![0; 127],
            stride: 32,
            geometry,
            captured_at: Instant::now()
        },
        Budget::select(8, 4, 1_000_000)
    )
    .is_err());
    for (w, h) in [(1920, 1080), (1080, 1920), (5120, 1440), (1, 1)] {
        let mut previous_pixels = 0;
        let mut previous_fps = 0;
        for bitrate in [100_000, 300_000, 1_000_000, 3_000_000] {
            let budget = Budget::select(w, h, bitrate);
            assert_eq!(budget.width % 2, 0);
            assert_eq!(budget.height % 2, 0);
            assert!(budget.width <= 1280 && budget.height <= 720 && budget.fps <= 30);
            assert!(budget.width * budget.height >= previous_pixels && budget.fps >= previous_fps);
            let macroblocks = budget.width.div_ceil(16) * budget.height.div_ceil(16);
            assert!(macroblocks <= 3600 && macroblocks * budget.fps <= 108000);
            previous_pixels = budget.width * budget.height;
            previous_fps = budget.fps;
        }
    }
}

#[test]
fn websocket_fallback_budget_reaches_full_hd_and_still_respects_explicit_resolution_caps() {
    assert_eq!(FALLBACK_MAX_BITRATE, INITIAL_BITRATE);
    assert_eq!(FALLBACK_LIMITS.max_bitrate, FALLBACK_MAX_BITRATE);
    let full_hd = Budget::select_with_limits_and_resolution(
        1920,
        1080,
        FALLBACK_MAX_BITRATE,
        FALLBACK_LIMITS,
        Some((FALLBACK_MAX_WIDTH, FALLBACK_MAX_HEIGHT)),
    );
    assert_eq!(
        (full_hd.width, full_hd.height, full_hd.fps),
        (1920, 1080, 30)
    );
    let capped = Budget::select_with_limits_and_resolution(
        1920,
        1080,
        FALLBACK_MAX_BITRATE,
        FALLBACK_LIMITS,
        Some((1280, 720)),
    );
    assert_eq!((capped.width, capped.height), (1280, 720));
}

#[test]
fn explicit_two_k_and_four_k_targets_follow_the_negotiated_level() {
    let level_five_one = Limits::parse("packetization-mode=1;profile-level-id=42e033").unwrap();
    for (requested, expected) in [
        ((2560, 1440), (2560, 1440, 30)),
        ((3840, 2160), (3840, 2160, 30)),
    ] {
        let budget = Budget::select_with_limits_resolution_and_fps(
            requested.0,
            requested.1,
            24_000_000,
            level_five_one,
            Some(requested),
            None,
        );
        assert_eq!((budget.width, budget.height, budget.fps), expected);
        let macroblocks = budget.width.div_ceil(16) * budget.height.div_ceil(16);
        assert!(macroblocks <= level_five_one.max_fs);
        assert!(macroblocks * budget.fps <= level_five_one.max_mbps);
    }
}

#[test]
fn ultrawide_native_capture_downscales_within_the_four_k_budget_without_stretching() {
    let level_five_one = Limits::parse("packetization-mode=1;profile-level-id=42e033").unwrap();
    let budget = Budget::select_with_limits_resolution_and_fps(
        5120,
        2160,
        24_000_000,
        level_five_one,
        Some((3840, 2160)),
        Some(30),
    );
    assert_eq!((budget.width, budget.height), (3840, 1620));
}

#[test]
fn oversized_idr_reduces_pixel_cost_and_recovers_only_with_rate_headroom() {
    use desktop_streaming::video::FramePressure;
    let now = Instant::now();
    let base = Budget {
        width: 1280,
        height: 720,
        fps: 30,
    };
    let mut pressure = FramePressure::default();
    assert!(!pressure.admit(300_000, base, 2_000_000, now, true).unwrap());
    let smaller = pressure.fit(base, 2_000_000, now);
    assert!(smaller.width < base.width && smaller.height < base.height);
    assert!(pressure
        .admit(1000, smaller, 2_000_000, now, false)
        .unwrap());
    assert_eq!(
        pressure.fit(base, 2_000_000, now + std::time::Duration::from_secs(60)),
        smaller
    );
    let recovered = pressure.fit(base, 2_500_000, now + std::time::Duration::from_secs(61));
    assert!(recovered.width > smaller.width && recovered.height > smaller.height);
    assert_eq!(
        pressure.fit(base, 2_500_000, now + std::time::Duration::from_secs(120)),
        recovered
    );
    let recovered_again = pressure.fit(base, 3_200_000, now + std::time::Duration::from_secs(121));
    assert!(recovered_again.width > recovered.width && recovered_again.height > recovered.height);
    assert!(pressure
        .admit(
            100_000,
            Budget {
                width: 160,
                height: 90,
                fps: 10
            },
            100_000,
            now,
            false,
        )
        .is_err());
}

#[test]
fn quality_pressure_is_bounded_and_probes_back_without_immediate_pixel_loss() {
    use desktop_streaming::video::{FramePressure, SoftwareQuality};
    let now = Instant::now();
    let mut quality = SoftwareQuality::default();
    assert_eq!(quality.floor(now), 0);
    for _ in 0..4 {
        assert!(quality.reject(now));
    }
    assert_eq!(quality.floor(now), 36);
    assert!(!quality.reject(now));
    // A normal editor IDR fits the bounded keyframe burst; a pathological IDR
    // still has to fit before quality may probe upward.
    assert!(!FramePressure::fits_frame(400_000, 8_000_000, true));
    assert!(FramePressure::fits_frame(162_537, 8_600_000, true));
    quality.observe_keyframe(400_000, 8_000_000);
    // This exact editor has insufficient IDR headroom. Repeating a timer
    // must not manufacture another known-oversized IDR every five seconds.
    for seconds in [4, 5, 10, 30, 300] {
        assert_eq!(
            quality.floor(now + std::time::Duration::from_secs(seconds)),
            36
        );
    }
    // A real later keyframe after a content/rate change proves space to probe.
    for (seconds, expected) in [(305, 32), (310, 28), (315, 24), (320, 0)] {
        quality.observe_keyframe(1_000, 8_000_000);
        assert_eq!(
            quality.floor(now + std::time::Duration::from_secs(seconds)),
            expected
        );
    }
}
