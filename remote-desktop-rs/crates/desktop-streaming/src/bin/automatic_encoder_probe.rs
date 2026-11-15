//! Synthetic pixels only; exercise real hardware selection/fallback and IDRs.
fn main() -> anyhow::Result<()> {
    use desktop_streaming::{
        codec::{Limits, VideoCodec},
        encoder::{Encoder, Policy},
        synthetic::{pattern, SyntheticInput},
        video::{Budget, Frame},
    };
    use openh264::formats::YUVSource;
    let expect_software = std::env::args().any(|a| a == "--expect-software");
    let mut encoder = Encoder::new(
        2_000_000,
        Limits::default(),
        0,
        Policy::Automatic,
        VideoCodec::H264,
    )?;
    let mut samples = Vec::new();
    for i in 0..12 {
        if i == 7 {
            encoder.reconfigure(1_800_000, Limits::default(), 0, VideoCodec::H264)?;
        }
        let start = std::time::Instant::now();
        let encoded = encoder
            .encode(
                Frame::I420(pattern(i, &SyntheticInput::default())),
                Budget {
                    width: 640,
                    height: 360,
                    fps: 30,
                },
                i % 5 == 0,
            )?
            .ok_or_else(|| anyhow::anyhow!("missing frame"))?;
        if i % 5 == 0 || i == 7 {
            anyhow::ensure!(encoded.keyframe, "requested IDR missing");
        }
        if encoded.keyframe {
            let mut decoder = openh264::decoder::Decoder::new()?;
            let decoded = decoder
                .decode(&encoded.annex_b)?
                .ok_or_else(|| anyhow::anyhow!("IDR not independently decodable"))?;
            anyhow::ensure!(decoded.dimensions() == (640, 360), "IDR geometry changed");
        }
        if expect_software {
            anyhow::ensure!(
                encoder.name() == "openh264",
                "unexpected hardware selection"
            );
        }
        samples.push(serde_json::json!({"frame":i,"encoder":encoder.name(),"keyframe":encoded.keyframe,"bytes":encoded.annex_b.len(),"encodeMicros":start.elapsed().as_micros()}));
    }
    println!(
        "{}",
        serde_json::json!({"ok":true,"expectedSoftware":expect_software,"samples":samples})
    );
    Ok(())
}
