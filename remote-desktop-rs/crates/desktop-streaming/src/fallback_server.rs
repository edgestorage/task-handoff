//! Loopback-only fallback media/control WebSocket host. The instance proxies
//! these sockets; the component remains the sole session/media authority.
use crate::session::Owner;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::SinkExt;
use remote_desktop_protocol::fallback::{self, Role};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};

pub struct AttachReply {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
}

pub enum FallbackEvent {
    Attach {
        role: Role,
        generation: String,
        viewer: String,
        owner: Owner,
        capture_target: crate::session::CaptureTarget,
        media: Option<mpsc::Sender<fallback::EncodedFrame>>,
        control: Option<mpsc::Sender<String>>,
        reply: oneshot::Sender<Result<AttachReply, &'static str>>,
    },
    MediaStarted {
        generation: String,
    },
    Keyframe {
        generation: String,
    },
    ControlMessage {
        generation: String,
        bytes: Vec<u8>,
        received: Instant,
    },
    Detach {
        role: Role,
        generation: String,
    },
}

#[derive(Clone)]
struct Hub {
    events: mpsc::Sender<FallbackEvent>,
    token: Arc<String>,
}

pub struct Server {
    pub url: String,
    pub token: String,
    pub events: mpsc::Receiver<FallbackEvent>,
}

pub async fn start() -> anyhow::Result<Server> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address: SocketAddr = listener.local_addr()?;
    let token = crate::session::secret();
    let (events, receiver) = mpsc::channel(64);
    let hub = Hub {
        events,
        token: Arc::new(token.clone()),
    };
    let router = Router::new()
        .route("/fallback/media", get(upgrade))
        .route("/fallback/control", get(upgrade))
        .with_state(hub);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(Server {
        url: format!("ws://{address}"),
        token,
        events: receiver,
    })
}

async fn upgrade(
    State(hub): State<Hub>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    Query(query): Query<HashMap<String, String>>,
    request: axum::extract::Request,
) -> impl IntoResponse {
    if query.get("token").map(String::as_str) != Some(hub.token.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let role = if request.uri().path().ends_with("/media") {
        Role::Media
    } else {
        Role::Control
    };
    let protocol = headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !protocol
        .split(',')
        .any(|value| value.trim() == role.subprotocol())
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let max_message_size = match role {
        Role::Media => fallback::MAX_CHUNK_BYTES + fallback::HEADER_BYTES + 1024,
        // Control reuses the DataChannel envelope. The largest legal message is
        // the 64 KiB clipboard wire payload plus JSON framing.
        Role::Control => 128 * 1024,
    };
    ws.protocols([role.subprotocol().to_string()])
        .max_message_size(max_message_size)
        .on_upgrade(move |socket| connection(hub, role, socket))
        .into_response()
}

async fn send(socket: &mut WebSocket, value: Value) -> anyhow::Result<()> {
    socket
        .send(Message::Text(serde_json::to_string(&value)?.into()))
        .await?;
    Ok(())
}

async fn connection(hub: Hub, role: Role, mut socket: WebSocket) {
    let attach = tokio::time::timeout(Duration::from_secs(5), socket.recv())
        .await
        .ok()
        .flatten()
        .and_then(|message| match message {
            Ok(Message::Text(text)) => serde_json::from_str::<fallback::Attach>(&text).ok(),
            _ => None,
        });
    let Some(attach) =
        attach.filter(|attach| attach.kind == "fallback.attach" && attach.role == role.as_str())
    else {
        let _ = socket.close().await;
        return;
    };
    let Ok(owner) = serde_json::from_value::<Owner>(json!({
        "actorId": attach.actor_id,
        "deviceSessionId": attach.device_session_id,
    })) else {
        let _ = socket.close().await;
        return;
    };
    let generation = attach.fallback_generation.clone();
    let viewer = attach.viewer_session_id.clone();
    let (reply_tx, reply_rx) = oneshot::channel();
    let (media_tx, media_rx) = mpsc::channel(4);
    let (control_tx, mut control_rx) = mpsc::channel(16);
    let event = FallbackEvent::Attach {
        role,
        generation: generation.clone(),
        viewer: viewer.clone(),
        owner,
        capture_target: attach.capture_target,
        media: (role == Role::Media).then(|| media_tx),
        control: (role == Role::Control).then(|| control_tx),
        reply: reply_tx,
    };
    if hub.events.send(event).await.is_err() {
        let _ = socket.close().await;
        return;
    }
    let reply = tokio::time::timeout(Duration::from_secs(5), reply_rx)
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(Result::ok);
    let Some(config) = reply else {
        let _ = send(
            &mut socket,
            json!({"type":"error","payload":{"code":"REMOTE_DESKTOP_FALLBACK_ATTACH_FAILED"}}),
        )
        .await;
        let _ = socket.close().await;
        let _ = hub
            .events
            .send(FallbackEvent::Detach { role, generation })
            .await;
        return;
    };
    if role == Role::Media {
        let _ = send(
            &mut socket,
            json!({
                "type":"fallback.configure",
                "payload": {
                    "width": config.width,
                    "height": config.height,
                    "fps": config.fps,
                    "bitrate": config.bitrate,
                    "codec": "avc1.42E028"
                }
            }),
        )
        .await;
    }
    let mut media_rx = media_rx;
    let mut started = false;
    loop {
        tokio::select! {
            message = socket.recv() => {
                let Some(Ok(message)) = message else { break; };
                match (role, message) {
                    (Role::Control, Message::Text(text)) => {
                        if text.len() > 64 * 1024 {
                            break;
                        }
                        if hub.events.send(FallbackEvent::ControlMessage {
                            generation: generation.clone(),
                            bytes: text.as_bytes().to_vec(),
                            received: Instant::now(),
                        }).await.is_err() { break; }
                    }
                    (Role::Media, Message::Text(text)) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { break; };
                        if value.get("type").and_then(Value::as_str) != Some("fallback.keyframe-request") { break; }
                        if hub.events.send(FallbackEvent::Keyframe { generation: generation.clone() }).await.is_err() { break; }
                    }
                    (_, Message::Ping(payload)) => { if socket.send(Message::Pong(payload)).await.is_err() { break; } }
                    (_, Message::Pong(_)) => {}
                    _ => break,
                }
            }
            frame = media_rx.recv(), if role == Role::Media => {
                let Some(frame) = frame else { break; };
                let chunks: Vec<&[u8]> = frame.data.chunks(fallback::MAX_CHUNK_BYTES).collect();
                let count = chunks.len() as u16;
                for (index, payload) in chunks.into_iter().enumerate() {
                    let encoded = fallback::encode_chunk(&frame, index as u16, count, payload);
                    if socket.send(Message::Binary(encoded.into())).await.is_err() {
                        break;
                    }
                }
                if !started {
                    started = true;
                    let _ = hub.events.send(FallbackEvent::MediaStarted { generation: generation.clone() }).await;
                }
            }
            outbound = control_rx.recv(), if role == Role::Control => {
                let Some(text) = outbound else { break; };
                if socket.send(Message::Text(text.into())).await.is_err() { break; }
            }
        }
    }
    let _ = hub
        .events
        .send(FallbackEvent::Detach { role, generation })
        .await;
    let _ = socket.close().await;
}
