//! Control smoke or explicit synthetic browser harness. No native desktop backend.
use desktop_streaming::{
    contract::{Command, Reply},
    host::TestHost,
    session::{CaptureSelection, Owner},
};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let binary = std::env::current_exe()?.with_file_name(if cfg!(windows) {
        "task-handoff-desktop-streaming.exe"
    } else {
        "task-handoff-desktop-streaming"
    });
    if std::env::args().nth(1).as_deref() == Some("--browser") {
        return desktop_streaming::browser_host::serve(&binary).await;
    }
    if let Some(mode) = match std::env::args().nth(1).as_deref() {
        Some("--browser-native") => Some(desktop_streaming::capture::Mode::Local),
        Some("--browser-virtual") => Some(desktop_streaming::capture::Mode::Virtual),
        _ => None,
    } {
        return desktop_streaming::browser_host::serve_mode(&binary, mode).await;
    }
    let mut host = TestHost::spawn(&binary).await?;
    let owner = Owner {
        actor_id: "test-actor".into(),
        device_session_id: "test-device".into(),
    };
    let Reply::Reserved {
        snapshot,
        attach_token,
        ..
    } = host
        .request(
            "create",
            Command::Reserve {
                owner: owner.clone(),
                capture_selection: CaptureSelection {
                    source_ref: "synthetic-display".into(),
                    stream_region: None,
                    control_region: None,
                },
            },
        )
        .await?
    else {
        anyhow::bail!("reservation failed");
    };
    let Reply::Snapshot { .. } = host
        .request(
            "attach",
            Command::Attach {
                owner: owner.clone(),
                viewer_session_id: snapshot.viewer_session_id.clone(),
                capture_selection: CaptureSelection {
                    source_ref: "synthetic-display".into(),
                    stream_region: None,
                    control_region: None,
                },
                attach_token,
            },
        )
        .await?
    else {
        anyhow::bail!("attach failed");
    };
    let _ = host
        .request(
            "stop",
            Command::Stop {
                owner,
                viewer_session_id: snapshot.viewer_session_id,
            },
        )
        .await?;
    println!("private IPC reserve/attach/stop passed; platform backend unavailable");
    host.shutdown().await
}
