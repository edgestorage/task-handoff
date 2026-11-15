//! Explicit owned-display encoder diagnostic. Reports sizes/timings only;
//! captured pixels, input and native identifiers never leave the process.
#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use desktop_streaming::{
        capture::Source,
        codec::Limits,
        synthetic::{SoftwareEncoder, SyntheticInput},
        video::Budget,
    };
    use std::time::Instant;
    anyhow::ensure!(
        std::env::var_os("DISPLAY").is_some() && std::env::var_os("XAUTHORITY").is_some(),
        "explicit owned display required"
    );
    let mut source = Source::local(true).await?;
    let geometry = source.geometry();
    let limits = Limits::parse("packetization-mode=1;profile-level-id=42e028")?;
    let budget = Budget::select_with_limits(geometry.width, geometry.height, 8_000_000, limits);
    let yuv = source
        .frame(0, &SyntheticInput::default(), true, budget)?
        .ok_or_else(|| anyhow::anyhow!("no fixture frame"))?
        .into_i420(budget)?;
    let mut samples = Vec::new();
    let qp = std::env::args()
        .nth(1)
        .map(|s| s.parse::<u8>())
        .transpose()?
        .unwrap_or(0);
    for bitrate in [2_000_000, 4_000_000, 8_000_000] {
        let mut encoder = SoftwareEncoder::with_quality(bitrate, limits, qp)?;
        let start = Instant::now();
        let encoded = encoder
            .encode(&yuv, true)?
            .ok_or_else(|| anyhow::anyhow!("no IDR"))?;
        samples.push(serde_json::json!({"bitrate":bitrate,"minQp":qp,"idrBytes":encoded.annex_b.len(),"encodeMicros":start.elapsed().as_micros(),"keyframe":encoded.keyframe,"pacerBudgetBytes":desktop_streaming::pacing::byte_budget(bitrate as f64)}));
    }
    println!(
        "{}",
        serde_json::json!({"width":budget.width,"height":budget.height,"samples":samples})
    );
    Ok(())
}
#[cfg(not(target_os = "linux"))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("Linux owned-display encoder diagnostic only")
}
