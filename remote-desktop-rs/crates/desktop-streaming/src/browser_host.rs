//! Disposable loopback-only G1 harness, not a product API or instance adapter.
use crate::{
    contract::*,
    framing,
    host::TestHost,
    session::{secret, CaptureSelection, Owner},
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use futures_util::SinkExt;
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};
use tokio::sync::{broadcast, mpsc, oneshot, Notify};

type Call = (Command, oneshot::Sender<Reply>);
#[derive(Clone)]
struct Bus {
    calls: mpsc::Sender<Call>,
    events: broadcast::Sender<SessionEvent>,
    stop: Arc<Notify>,
}
impl Bus {
    async fn call(&self, command: Command) -> anyhow::Result<Reply> {
        let (tx, rx) = oneshot::channel();
        self.calls.send((command, tx)).await?;
        Ok(tokio::time::timeout(Duration::from_secs(12), rx).await??)
    }
    fn start(mut host: TestHost) -> Self {
        let (calls, mut requests) = mpsc::channel::<Call>(32);
        let (events, _) = broadcast::channel(64);
        let publish = events.clone();
        let stop = Arc::new(Notify::new());
        tokio::spawn(async move {
            let _directory = host._directory;
            let (mut reader, mut writer) = tokio::io::split(host.stream);
            let (tx, mut incoming) = mpsc::channel(16);
            let mut readers = tokio::task::JoinSet::new();
            readers.spawn(async move {
                while let Ok(Some(packet)) = framing::read::<Packet>(&mut reader).await {
                    if tx.send(packet).await.is_err() {
                        break;
                    }
                }
            });
            let mut pending = HashMap::new();
            loop {
                tokio::select! {
                    call=requests.recv()=>{
                        let Some((command,reply))=call else{break;};
                        if pending.len()>=32{let _=reply.send(Reply::Error{code:"REMOTE_DESKTOP_RATE_LIMITED".into()});continue;}
                        let id=secret();pending.insert(id.clone(),reply);
                        if !matches!(tokio::time::timeout(Duration::from_secs(5),framing::write(&mut writer,&Request{request_id:id,boot_id:host.welcome.boot_id.clone(),command})).await,Ok(Ok(()))){break;}
                    },
                    packet=incoming.recv()=>match packet{
                        Some(Packet::Event(event))=>{let _=publish.send(event);},
                        Some(Packet::Response(response))=>{if let Some(reply)=pending.remove(&response.request_id){let _=reply.send(response.result);}},
                        None=>break,
                    },
                }
            }
            drop(host._lifetime);
            let _ = tokio::time::timeout(Duration::from_secs(5), host.child.wait()).await;
        });
        Self {
            calls,
            events,
            stop,
        }
    }
}
#[derive(Clone)]
struct App {
    bus: Bus,
    origin: String,
}
async fn upgrade(
    State(app): State<App>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    if headers.get("origin").and_then(|v| v.to_str().ok()) != Some(&app.origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(600 * 1024)
        .on_upgrade(move |socket| {
            viewer(
                app.bus,
                socket,
                query.get("target").is_some_and(|t| t == "window"),
            )
        })
        .into_response()
}
async fn send(socket: &mut WebSocket, value: serde_json::Value) -> anyhow::Result<()> {
    socket
        .send(Message::Text(serde_json::to_string(&value)?.into()))
        .await?;
    Ok(())
}
#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum BrowserSignal {
    Offer {
        sdp: String,
    },
    #[serde(rename_all = "camelCase")]
    SelectSource {
        source_ref: String,
    },
    Alive,
    Metrics,
    Stop,
}
async fn viewer(bus: Bus, mut socket: WebSocket, window: bool) {
    let owner = Owner {
        actor_id: "synthetic-test-actor".into(),
        device_session_id: secret(),
    };
    let mut events = bus.events.subscribe();
    let selection = if window {
        let sources = match bus
            .call(Command::ListSources {
                owner: owner.clone(),
            })
            .await
        {
            Ok(Reply::Sources { sources }) => sources,
            Ok(Reply::Error { code }) => {
                let _ = send(&mut socket, serde_json::json!({"type":"error","code":code})).await;
                return;
            }
            _ => return,
        };
        if send(
            &mut socket,
            serde_json::json!({"type":"sources","sources":sources}),
        )
        .await
        .is_err()
        {
            return;
        }
        let Ok(Some(Ok(Message::Text(text)))) =
            tokio::time::timeout(Duration::from_secs(55), socket.recv()).await
        else {
            return;
        };
        let Ok(BrowserSignal::SelectSource { source_ref }) = serde_json::from_str(&text) else {
            return;
        };
        CaptureSelection {
            source_ref,
            stream_region: None,
            control_region: None,
        }
    } else {
        let sources = match bus
            .call(Command::ListSources {
                owner: owner.clone(),
            })
            .await
        {
            Ok(Reply::Sources { sources }) => sources,
            _ => return,
        };
        let Some(source) = sources.into_iter().find(|source| source.kind == "display") else {
            return;
        };
        CaptureSelection {
            source_ref: source.source_ref,
            stream_region: None,
            control_region: None,
        }
    };
    let (snapshot, attach_token) = match bus
        .call(Command::Reserve {
            owner: owner.clone(),
            capture_selection: selection.clone(),
        })
        .await
    {
        Ok(Reply::Reserved {
            snapshot,
            attach_token,
            ..
        }) => (snapshot, attach_token),
        Ok(Reply::Error { code }) => {
            let _ = send(&mut socket, serde_json::json!({"type":"error","code":code})).await;
            return;
        }
        _ => {
            let _ = send(
                &mut socket,
                serde_json::json!({"type":"error","code":"HARNESS_COMPONENT_UNAVAILABLE"}),
            )
            .await;
            return;
        }
    };
    let id = snapshot.viewer_session_id.clone();
    let run=async{
        let reply=bus.call(Command::Attach{owner:owner.clone(),viewer_session_id:id.clone(),capture_selection:selection,attach_token}).await?;
        let snapshot=match reply{
            Reply::Snapshot{snapshot}=>snapshot,
            Reply::Error{code}=>{
                send(&mut socket,serde_json::json!({"type":"error","code":code})).await?;
                return Ok(());
            },
            _=>anyhow::bail!("unexpected attach reply"),
        };
        send(&mut socket,serde_json::json!({"type":"ready","snapshot":snapshot})).await?;
        loop{
            tokio::select!{
                message=socket.recv()=>{
                    let Some(Ok(Message::Text(text)))=message else{break;};
                    match serde_json::from_str::<BrowserSignal>(&text)?{
                        BrowserSignal::Offer{sdp}=>{
                            let reply=bus.call(Command::Offer{owner:owner.clone(),viewer_session_id:id.clone(),sdp}).await?;
                            match reply{Reply::Answer{sdp}=>send(&mut socket,serde_json::json!({"type":"answer","sdp":sdp})).await?,Reply::Error{code}=>{send(&mut socket,serde_json::json!({"type":"error","code":code})).await?;break;},_=>anyhow::bail!("unexpected reply")}
                        },
                        BrowserSignal::SelectSource { .. } => break,
                        BrowserSignal::Metrics=>{
                            if let Reply::Metrics { metrics } = bus.call(Command::Metrics { owner:owner.clone(), viewer_session_id:id.clone() }).await? {
                                send(&mut socket, serde_json::json!({"type":"metrics","metrics":metrics})).await?;
                            }
                        },
                        BrowserSignal::Alive=>{let reply=bus.call(Command::SignalAlive{owner:owner.clone(),viewer_session_id:id.clone()}).await?;if !matches!(reply,Reply::Acknowledged){eprintln!("browser test signal alive rejected");break;}},
                        BrowserSignal::Stop=>{
                            let _=bus.call(Command::Stop{owner:owner.clone(),viewer_session_id:id.clone()}).await;
                            if let Reply::Snapshot{snapshot}=bus.call(Command::Snapshot{owner:owner.clone(),viewer_session_id:id.clone()}).await? {
                                send(&mut socket,serde_json::json!({"type":"snapshot","snapshot":snapshot})).await?;
                            }
                            break;
                        },
                    }
                },
                event=events.recv()=>{
                    let event=event?;
                    if event.snapshot.viewer_session_id==id{send(&mut socket,serde_json::json!({"type":"snapshot","snapshot":event.snapshot})).await?;}
                },
                _=bus.stop.notified()=>break,
            }
        }
        Ok::<(),anyhow::Error>(())
    }.await;
    if run.is_err() {
        eprintln!("browser test bridge aborted");
    }
    // Do not log SDP, private credentials or browser payloads.
    let _ = bus
        .call(Command::SignalClosed {
            owner,
            viewer_session_id: id,
        })
        .await;
    let _ = socket.close().await;
}

pub async fn serve(binary: &Path) -> anyhow::Result<()> {
    serve_mode(binary, crate::capture::Mode::Synthetic).await
}
pub async fn serve_mode(binary: &Path, mode: crate::capture::Mode) -> anyhow::Result<()> {
    let bus = Bus::start(TestHost::spawn_mode(binary, mode).await?);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let app = App {
        bus: bus.clone(),
        origin: origin.clone(),
    };
    let router = Router::new()
        .route(
            "/",
            get(move|| async move {
                let html=include_str!("../harness/viewer.html");
                Html(if mode==crate::capture::Mode::Synthetic {html.to_owned()} else {html.replace("G1 synthetic desktop harness","G1 native desktop harness").replace("Synthetic pixels and input only. No host screen, keyboard or system clipboard access.","Native desktop capture and OS input. Explicit clipboard opt-in accesses the system clipboard.").replace("Bars show animation, accepted input, committed Unicode characters and pressed keys. The cursor is encoded in video.","The selected desktop is live. Input affects its real applications. The cursor is encoded in video.")})
            }),
        )
        .route("/signal", get(upgrade))
        .with_state(app)
        .layer(axum::middleware::map_response(
            |mut response: axum::response::Response| async move {
                response.headers_mut().insert(
                    "cache-control",
                    axum::http::HeaderValue::from_static("no-store"),
                );
                response.headers_mut().insert(
                    "referrer-policy",
                    axum::http::HeaderValue::from_static("no-referrer"),
                );
                response
            },
        ));
    println!("Synthetic G1 harness: {origin}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            bus.stop.notify_waiters();
            let _ = bus.call(Command::Shutdown).await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::BrowserSignal;

    #[test]
    fn source_selection_decodes_the_viewer_camel_case_field() {
        let signal: BrowserSignal =
            serde_json::from_str(r#"{"type":"selectSource","sourceRef":"opaque"}"#).unwrap();
        assert!(
            matches!(signal, BrowserSignal::SelectSource { source_ref } if source_ref == "opaque")
        );
    }
}
