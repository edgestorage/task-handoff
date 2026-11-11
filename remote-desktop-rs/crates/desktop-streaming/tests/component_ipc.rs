use desktop_streaming::{
    contract::*,
    framing,
    host::TestHost,
    session::{CaptureSelection, Owner, Phase},
};
use std::{path::Path, time::Duration};
fn binary() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_task-handoff-desktop-streaming"))
}
fn owner() -> Owner {
    Owner {
        actor_id: "fixture-actor".into(),
        device_session_id: "fixture-device".into(),
    }
}
fn selection(source_ref: &str) -> CaptureSelection {
    CaptureSelection {
        source_ref: source_ref.into(),
        stream_region: None,
        control_region: None,
    }
}
#[tokio::test]
async fn independent_process_authenticates_reserves_attaches_reports_events_and_stops() {
    let mut host = TestHost::spawn(binary()).await.unwrap();
    assert!(!host.welcome.capability.available);
    let Reply::Reserved {
        snapshot,
        attach_token,
        ..
    } = host
        .request(
            "create",
            Command::Reserve {
                owner: owner(),
                capture_selection: selection("display"),
            },
        )
        .await
        .unwrap()
    else {
        panic!("reserve");
    };
    let id = snapshot.viewer_session_id;
    assert_eq!(
        host.latest_event.as_ref().unwrap().snapshot.phase,
        Phase::Starting
    );
    let Reply::Reserved {
        snapshot: second, ..
    } = host
        .request(
            "second",
            Command::Reserve {
                owner: owner(),
                capture_selection: selection("display"),
            },
        )
        .await
        .unwrap()
    else {
        panic!("second reserve");
    };
    assert_ne!(second.viewer_session_id, id);
    assert!(!second.is_controller);
    assert_eq!(second.viewer_count, 2);
    let command = || Command::Attach {
        owner: owner(),
        viewer_session_id: id.clone(),
        capture_selection: selection("display"),
        attach_token: attach_token.clone(),
    };
    assert!(matches!(
        host.request("attach", command()).await.unwrap(),
        Reply::Snapshot { .. }
    ));
    assert_eq!(
        host.latest_event.as_ref().unwrap().snapshot.phase,
        Phase::Negotiating
    );
    assert!(
        matches!(host.request("replay",command()).await.unwrap(),Reply::Error { code } if code=="REMOTE_DESKTOP_ATTACH_INVALID")
    );
    assert!(matches!(
        host.request(
            "stop",
            Command::Stop {
                owner: owner(),
                viewer_session_id: id.clone()
            }
        )
        .await
        .unwrap(),
        Reply::Stopped
    ));
    let Reply::Snapshot { snapshot } = host
        .request(
            "stopped",
            Command::Snapshot {
                owner: owner(),
                viewer_session_id: id,
            },
        )
        .await
        .unwrap()
    else {
        panic!("stopped snapshot");
    };
    assert_eq!(snapshot.phase, Phase::Stopped);
    host.shutdown().await.unwrap();
}
#[tokio::test]
async fn stale_boot_commands_cannot_mutate_or_shutdown_component() {
    let mut host = TestHost::spawn(binary()).await.unwrap();
    framing::write(
        &mut host.stream,
        &Request {
            request_id: "stale".into(),
            boot_id: "old-boot".into(),
            command: Command::Shutdown,
        },
    )
    .await
    .unwrap();
    let Some(Packet::Response(response)) = framing::read(&mut host.stream).await.unwrap() else {
        panic!("response");
    };
    assert!(matches!(response.result,Reply::Error { code } if code=="REMOTE_DESKTOP_STALE_BOOT"));
    assert!(host.child.try_wait().unwrap().is_none());
    host.shutdown().await.unwrap();
}
#[tokio::test]
async fn component_exits_on_host_stdin_eof_even_with_incomplete_ipc_frame() {
    use tokio::io::AsyncWriteExt;
    let mut host = TestHost::spawn(binary()).await.unwrap();
    host.stream.write_all(&[0, 0, 1, 0, b'{']).await.unwrap();
    host.close_parent_lifetime();
    tokio::time::timeout(Duration::from_secs(5), host.child.wait())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn distinct_source_selections_are_preserved_without_native_fallback() {
    let mut host = TestHost::spawn_synthetic(binary()).await.unwrap();
    let Reply::Reserved { snapshot, .. } = host
        .request(
            "source",
            Command::Reserve {
                owner: owner(),
                capture_selection: selection("opaque-unverified"),
            },
        )
        .await
        .unwrap()
    else {
        panic!("source reserve");
    };
    assert_eq!(snapshot.capture_selection, selection("opaque-unverified"));
    let Reply::Reserved { snapshot, .. } = host
        .request(
            "display",
            Command::Reserve {
                owner: owner(),
                capture_selection: selection("display"),
            },
        )
        .await
        .unwrap()
    else {
        panic!("display reserve");
    };
    assert_eq!(snapshot.capture_selection, selection("display"));
    host.shutdown().await.unwrap();
}
