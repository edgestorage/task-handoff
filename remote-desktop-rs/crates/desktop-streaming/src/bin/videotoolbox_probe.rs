//! Synthetic-only hardware codec probe; writes no native desktop pixels.
#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    use desktop_streaming::{
        codec::Limits,
        platform::macos_encoder::Encoder,
        synthetic::{pattern, SyntheticInput},
    };
    use openh264::formats::YUVSource;
    let mut encoder = Encoder::new(640, 360, 2_000_000, Limits::default())?;
    let mut samples = Vec::new();
    for i in 0..12 {
        let yuv = pattern(i, &SyntheticInput::default());
        let start = std::time::Instant::now();
        let encoded = encoder.encode(&yuv, i % 5 == 0)?;
        if encoded.keyframe {
            let mut decoder = openh264::decoder::Decoder::new()?;
            let decoded = decoder
                .decode(&encoded.annex_b)?
                .ok_or_else(|| anyhow::anyhow!("hardware IDR missing"))?;
            anyhow::ensure!(
                decoded.dimensions() == (640, 360),
                "hardware IDR geometry mismatch"
            );
        }
        samples.push(serde_json::json!({"frame":i,"keyframe":encoded.keyframe,"bytes":encoded.annex_b.len(),"encodeMicros":start.elapsed().as_micros()}));
    }
    println!(
        "{}",
        serde_json::json!({"ok":true,"encoder":"videotoolbox-hardware-required","samples":samples})
    );
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("macOS hardware codec diagnostic only")
}
