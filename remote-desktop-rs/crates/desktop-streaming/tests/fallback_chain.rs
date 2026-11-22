use desktop_streaming::{
    contract::{Command, Reply},
    host::TestHost,
    session::{CaptureSelection, Owner},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

const MEDIA_PROTOCOL: &str = "taskhandoff.remote-desktop.fallback.media.v1";
const CONTROL_PROTOCOL: &str = "taskhandoff.remote-desktop.fallback.control.v1";

fn binary() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_task-handoff-desktop-streaming"))
}

fn owner() -> Owner {
    Owner {
        actor_id: "fallback-actor".into(),
        device_session_id: "fallback-device".into(),
    }
}

fn selection() -> CaptureSelection {
    CaptureSelection {
        source_ref: "display".into(),
        stream_region: None,
        control_region: None,
    }
}

async fn connect_fallback(
    host: &TestHost,
    role: &str,
    protocol: &str,
    viewer: &str,
    generation: &str,
) -> anyhow::Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let url = format!(
        "{}/fallback/{role}?token={}",
        host.welcome.fallback_url, host.welcome.fallback_token
    );
    let mut request = url.into_client_request()?;
    request
        .headers_mut()
        .insert("sec-websocket-protocol", HeaderValue::from_str(protocol)?);
    let (mut socket, _) = connect_async(request).await?;
    socket
        .send(Message::Text(
            json!({
                "type": "fallback.attach",
                "role": role,
                "fallbackGeneration": generation,
                "viewerSessionId": viewer,
                "actorId": owner().actor_id,
                "deviceSessionId": owner().device_session_id,
                "captureSelection": selection(),
            })
            .to_string()
            .into(),
        ))
        .await?;
    Ok(socket)
}

#[tokio::test]
async fn synthetic_component_delivers_fallback_media_and_recovers_on_keyframe_request() {
    let mut host = TestHost::spawn_synthetic(binary()).await.unwrap();
    let Reply::Reserved {
        snapshot,
        attach_token,
        ..
    } = host
        .request(
            "fallback-reserve",
            Command::Reserve {
                owner: owner(),
                capture_selection: selection(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("reserve");
    };
    let viewer = snapshot.viewer_session_id;
    let Reply::Snapshot { .. } = host
        .request(
            "fallback-attach",
            Command::Attach {
                owner: owner(),
                viewer_session_id: viewer.clone(),
                capture_selection: selection(),
                attach_token,
            },
        )
        .await
        .unwrap()
    else {
        panic!("attach");
    };

    let mut media = connect_fallback(&host, "media", MEDIA_PROTOCOL, &viewer, "fgen_e2e")
        .await
        .unwrap();
    let configure = timeout(Duration::from_secs(5), media.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(configure) = configure else {
        panic!("fallback.configure");
    };
    let configure: serde_json::Value = serde_json::from_str(&configure).unwrap();
    assert_eq!(configure["type"], "fallback.configure");
    assert_eq!(configure["payload"]["fps"], 30);
    assert_eq!(configure["payload"]["codec"], "avc1.42E028");

    let mut control = connect_fallback(&host, "control", CONTROL_PROTOCOL, &viewer, "fgen_e2e")
        .await
        .unwrap();
    let ready = timeout(Duration::from_secs(10), control.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(ready) = ready else {
        panic!("fallback.ready");
    };
    assert!(ready.contains("fallback.ready"));
    control
        .send(Message::Text(
            json!({ "type": "fallback.rtt.ping", "payload": { "requestId": "rtt-e2e" } })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let pong = timeout(Duration::from_secs(5), control.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(pong) = pong else {
        panic!("fallback.rtt.pong");
    };
    let pong: serde_json::Value = serde_json::from_str(&pong).unwrap();
    assert_eq!(pong["type"], "fallback.rtt.pong");
    assert_eq!(pong["payload"]["requestId"], "rtt-e2e");

    let first_keyframe = timeout(Duration::from_secs(10), async {
        let started = Instant::now();
        let mut chunks = Vec::new();
        while started.elapsed() < Duration::from_secs(10) {
            let Some(Ok(Message::Binary(bytes))) = media.next().await else {
                continue;
            };
            let Some((frame, _, count, payload)) =
                remote_desktop_protocol::fallback::decode_chunk(&bytes)
            else {
                panic!("valid fallback frame");
            };
            if !frame.keyframe {
                continue;
            }
            chunks.push(payload.to_vec());
            if chunks.len() as u16 == count {
                return chunks.concat();
            }
        }
        panic!("fallback keyframe timeout");
    })
    .await
    .unwrap();
    assert!(!first_keyframe.is_empty());

    media
        .send(Message::Text(
            json!({ "type": "fallback.keyframe-request" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let recovered = timeout(Duration::from_secs(10), async {
        while let Some(Ok(message)) = media.next().await {
            let Message::Binary(bytes) = message else {
                continue;
            };
            let Some((frame, index, _, payload)) =
                remote_desktop_protocol::fallback::decode_chunk(&bytes)
            else {
                panic!("valid fallback frame");
            };
            if frame.keyframe && index == 0 {
                return payload.len();
            }
        }
        panic!("fallback media closed");
    })
    .await
    .unwrap();
    assert!(recovered > 0);

    let _ = media.close(None).await;
    let _ = control.close(None).await;
    host.shutdown().await.unwrap();
}
