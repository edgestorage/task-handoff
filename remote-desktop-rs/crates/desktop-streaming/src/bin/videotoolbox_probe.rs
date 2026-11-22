//! Synthetic-only hardware codec probe; writes no native desktop pixels.
#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    use desktop_streaming::{
        codec::{Limits, VideoCodec},
        platform::macos_encoder::Encoder,
        synthetic::{pattern, SyntheticInput},
    };
    use openh264::formats::YUVSource;
    let codec = if std::env::args().any(|arg| arg == "--h265") {
        VideoCodec::H265
    } else {
        VideoCodec::H264
    };
    let mut encoder = Encoder::new(640, 360, 60, 2_000_000, Limits::default(), codec)?;
    let mut samples = Vec::new();
    let mut packetized = 0usize;
    let mut payload_bytes = 0usize;
    let mut keyframe_nal_types = Vec::new();
    let yuv = pattern(0, &SyntheticInput::default());
    let mut unexpected_keyframes = 0;
    for i in 0..90 {
        let requested = i == 0 || i == 70;
        let start = std::time::Instant::now();
        let encoded = encoder.encode(&yuv, requested)?;
        anyhow::ensure!(!requested || encoded.keyframe, "requested IDR missing");
        if !requested && encoded.keyframe {
            unexpected_keyframes += 1;
        }
        if codec == VideoCodec::H264 && encoded.keyframe {
            let mut decoder = openh264::decoder::Decoder::new()?;
            let decoded = decoder
                .decode(&encoded.annex_b)?
                .ok_or_else(|| anyhow::anyhow!("hardware IDR missing"))?;
            anyhow::ensure!(
                decoded.dimensions() == (640, 360),
                "hardware IDR geometry mismatch"
            );
        }
        if codec == VideoCodec::H265 {
            use bytes::Bytes;
            use rtc::rtp::{codec::h265::HevcPayloader, packetizer::Payloader};
            if encoded.keyframe {
                let mut rest = encoded.annex_b.as_slice();
                while let Some(start) = rest
                    .windows(4)
                    .position(|window| window == b"\x00\x00\x00\x01")
                {
                    rest = &rest[start + 4..];
                    if rest.len() >= 2 {
                        keyframe_nal_types.push((rest[0] >> 1) & 0x3f);
                    }
                }
            }
            let payloads = HevcPayloader.payload(1188, &Bytes::from(encoded.annex_b.clone()))?;
            anyhow::ensure!(!payloads.is_empty(), "HEVC frame produced no RTP payload");
            anyhow::ensure!(
                payloads.iter().all(|payload| !payload.is_empty()),
                "HEVC frame produced an empty RTP payload"
            );
            packetized += payloads.len();
            payload_bytes += payloads.iter().map(Bytes::len).sum::<usize>();
        }
        if i < 12 || requested || encoded.keyframe {
            samples.push(serde_json::json!({"frame":i,"keyframe":encoded.keyframe,"bytes":encoded.annex_b.len(),"encodeMicros":start.elapsed().as_micros()}));
        }
    }
    anyhow::ensure!(unexpected_keyframes == 0, "unexpected VT keyframes");
    println!(
        "{}",
        serde_json::json!({"ok":true,"codec":codec.as_str(),"encoder":"videotoolbox-hardware-required","unexpectedKeyframes":unexpected_keyframes,"packetized":packetized,"payloadBytes":payload_bytes,"keyframeNalTypes":keyframe_nal_types,"samples":samples})
    );
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("macOS hardware codec diagnostic only")
}
