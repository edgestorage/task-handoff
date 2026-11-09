//! Explicit native capture diagnostic: report dimensions/counters only. Never
//! save captured pixels, native IDs, titles, or screen contents to an artifact.
#[cfg(target_os = "macos")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use desktop_streaming::{
        codec::Limits,
        platform::macos::{Capture, WindowCatalog},
        session::Owner,
        synthetic::SoftwareEncoder,
        video::{from_bgra, Budget},
    };
    use openh264::formats::YUVSource;
    use std::time::{Duration, Instant};
    let owned_window = match std::env::args().nth(1).as_deref() {
        None => false,
        Some("--owned-window") => true,
        _ => anyhow::bail!("expected no arguments or --owned-window"),
    };
    let mut replay_rejected = false;
    let mut capture = if owned_window {
        let mut catalog = WindowCatalog::default();
        let owner = Owner {
            actor_id: "native-probe".into(),
            device_session_id: "owned-fixture".into(),
        };
        // Test-only selection of the fixture we own. Native app titles/handles
        // never enter results; this is not a product window-selection policy.
        let entries = catalog.enumerate(owner.clone()).await?;
        let selected = entries
            .iter()
            .find(|entry| entry.title == "G1 owned macOS input fixture" && entry.capturable)
            .ok_or_else(|| anyhow::anyhow!("owned fixture window missing"))?;
        let capture = catalog.consume(&selected.window_ref, &owner).await?;
        replay_rejected = catalog.consume(&selected.window_ref, &owner).await.is_err();
        capture
    } else {
        Capture::primary_display().await?
    };
    let geometry = capture.geometry();
    let mut phases = Vec::new();
    for phase in 0..2 {
        let began = Instant::now();
        let mut frames = 0;
        let mut encoded = None;
        let mut pixel_size = None;
        let limits = Limits::default();
        let mut encoder = SoftwareEncoder::with_limits(2_000_000, limits)?;
        while began.elapsed() < Duration::from_secs(5) && frames < 10 {
            if let Some(frame) = capture.frame(true)? {
                anyhow::ensure!(
                    frame.captured_at >= began,
                    "obsolete native sample after resume"
                );
                pixel_size = Some((frame.geometry.width, frame.geometry.height));
                if encoded.is_none() {
                    let budget = Budget::select_with_limits(
                        frame.geometry.width,
                        frame.geometry.height,
                        2_000_000,
                        limits,
                    );
                    let yuv = from_bgra(frame, budget)?;
                    if let Some(frame) = encoder.encode(&yuv, true)? {
                        let mut decoder = openh264::decoder::Decoder::new()?;
                        let decoded = decoder.decode(&frame.annex_b)?.ok_or_else(|| {
                            anyhow::anyhow!("native IDR not independently decodable")
                        })?;
                        anyhow::ensure!(
                            decoded.dimensions() == (budget.width as usize, budget.height as usize),
                            "decoded geometry mismatch"
                        );
                        encoded = Some(
                            serde_json::json!({"width":budget.width,"height":budget.height,"idr":frame.keyframe,"bytes":frame.annex_b.len()}),
                        );
                    }
                }
                frames += 1;
            }
            tokio::time::sleep(Duration::from_millis(33)).await;
        }
        anyhow::ensure!(frames == 10 && encoded.is_some(), "native frames missing");
        capture.pause()?;
        phases.push(serde_json::json!({"phase":phase,"frames":frames,"freshAfterResume":true,"pixelSize":pixel_size,"encoded":encoded,"elapsedMs":began.elapsed().as_millis()}));
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    println!(
        "{}",
        serde_json::json!({"ok":true,"target":if owned_window{"owned-window"}else{"display"},"actuatorSize":[geometry.width,geometry.height],"replayRejected":replay_rejected,"phases":phases})
    );
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("macOS native diagnostic only")
}
