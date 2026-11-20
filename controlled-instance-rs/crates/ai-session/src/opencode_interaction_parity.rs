use super::*;
use crate::opencode::{OpenCodeConnection, OpenCodeConnectionProvider, OpenCodeSessionProvider};
use axum::{
    body::{to_bytes, Body},
    extract::State,
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use std::{convert::Infallible, sync::Mutex as StdMutex};
use tokio::sync::{mpsc, Notify};
use tokio::time::{timeout, Duration};
const SESSION: &str = "ses_0000000000001";
const PROVIDER: &str = "s-u045";
fn replace(value: Value, from: &str, to: &str) -> Value {
    match value {
        Value::String(s) if s == from => json!(to),
        Value::Array(values) => json!(values
            .into_iter()
            .map(|v| replace(v, from, to))
            .collect::<Vec<_>>()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(k, v)| (k, replace(v, from, to)))
                .collect(),
        ),
        value => value,
    }
}
// Explicit business projection shared with the Node harness; no stripping of
// revision/source/counters or ordered body/event data. Only generated IDs map.
fn project(session: &AiSession) -> Value {
    let raw = serde_json::to_value(session).unwrap();
    let mut out = Map::new();
    for key in [
        "id",
        "providerSessionId",
        "status",
        "phase",
        "activeTurnId",
        "userPrompt",
        "summary",
        "lastMessage",
        "lastMessageItemId",
        "currentTool",
        "toolCallsSinceLastMessage",
        "counters",
        "unread",
        "error",
    ] {
        out.insert(key.to_string(), raw[key].clone());
    }
    if let Some(tool) = out.get_mut("currentTool").and_then(Value::as_object_mut) {
        tool.remove("startedAt");
    }
    let turns = session
        .turns
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|turn| {
            let mut value = Map::new();
            for key in [
                "id",
                "providerTurnId",
                "status",
                "phase",
                "userPrompt",
                "summary",
                "lastMessage",
                "lastMessageItemId",
                "revision",
                "source",
                "toolCallsSinceLastMessage",
                "currentTool",
            ] {
                value.insert(key.to_string(), turn[key].clone());
            }
            if let Some(tool) = value.get_mut("currentTool").and_then(Value::as_object_mut) {
                tool.remove("startedAt");
            }
            value.insert(
                "userMessages".to_string(),
                turn.get("userMessages")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            );
            Value::Object(value)
        })
        .collect::<Vec<_>>();
    out.insert("turns".to_string(), json!(turns));
    Value::Object(out)
}
#[derive(Clone)]
struct Peer {
    data: Arc<StdMutex<Value>>,
    requests: Arc<StdMutex<Vec<Value>>>,
    transport: Arc<StdMutex<Vec<Value>>>,
    hold: Arc<std::sync::atomic::AtomicBool>,
    release: Arc<Notify>,
    frames: Arc<StdMutex<Option<mpsc::UnboundedReceiver<Vec<u8>>>>>,
    connected: Arc<Notify>,
    reject_first: bool,
    directory: String,
}
fn upstream_session(data: &Value) -> Value {
    json!({"id":PROVIDER,"directory":data["directory"],"title":"Existing title","version":"1.18.21","time":{"created":1793923200000i64,"updated":data["updated"]}})
}
async fn peer(State(peer): State<Peer>, request: axum::extract::Request) -> Response {
    assert_eq!(
        request.headers()["authorization"],
        "Basic Zml4dHVyZTpzZWNyZXQ="
    );
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let query = url_query(request.uri().query().unwrap_or_default());
    if path == "/global/event" {
        assert_eq!(request.headers()["accept"], "text/event-stream");
        peer.transport
            .lock()
            .unwrap()
            .push(json!({"path":path,"authorized":true}));
        let receiver = peer.frames.lock().unwrap().take().expect("one stream");
        peer.connected.notify_one();
        let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
            receiver
                .recv()
                .await
                .map(|bytes| (Ok::<_, Infallible>(bytes), receiver))
        });
        return (
            [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
            Body::from_stream(stream),
        )
            .into_response();
    }
    if path == "/global/health" {
        return Json(json!({"healthy":true,"version":"1.18.21"})).into_response();
    }
    if path == "/experimental/session" {
        return Json(json!({"data":[upstream_session(&peer.data.lock().unwrap())]}))
            .into_response();
    }
    assert!(query.contains(&json!(["directory", peer.directory])));
    if method == "POST" {
        assert_eq!(method, "POST");
        if path.ends_with("/prompt_async") || path.ends_with("/reply") {
            assert_eq!(request.headers()["content-type"], "application/json");
        }
        let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
        let body: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        let mut requests = peer.requests.lock().unwrap();
        requests.push(json!({"method":method,"path":path,"query":query,"body":body}));
        if peer.reject_first && requests.len() == 1 {
            return (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "fixture prompt rejected",
            )
                .into_response();
        }
        let mut data = peer.data.lock().unwrap();
        if data["failure"]["path"] == path {
            let message = data["failure"]["message"].as_str().unwrap().to_string();
            data["failure"] = Value::Null;
            return (axum::http::StatusCode::SERVICE_UNAVAILABLE, message).into_response();
        }
        if let Some(post) = data.get("post").cloned().filter(|v| !v.is_null()) {
            if let Some(snapshot) = post.get("snapshot") {
                for (k, v) in snapshot.as_object().unwrap() {
                    data[k] = v.clone();
                }
            }
            data["failure"] = post["failure"].clone();
            data["post"] = Value::Null;
        }
        if path.ends_with("/prompt_async") {
            data["userId"] = body["messageID"].clone();
            return axum::http::StatusCode::NO_CONTENT.into_response();
        }
        assert!(path.ends_with("/abort") || path.ends_with("/reply"));
        return Json(json!(true)).into_response();
    }
    loop {
        let released = peer.release.notified();
        if !peer.hold.load(std::sync::atomic::Ordering::Acquire) {
            break;
        }
        released.await;
    }
    let mut data = peer.data.lock().unwrap();
    if data["failure"]["path"] == path {
        let message = data["failure"]["message"].as_str().unwrap().to_string();
        data["failure"] = Value::Null;
        return (axum::http::StatusCode::SERVICE_UNAVAILABLE, message).into_response();
    }
    let body = match path.as_str() {
        "/session/status" => json!({PROVIDER:{"type":data["status"]}}),
        "/permission" => data
            .get("permissions")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "/session/s-u045/message" => {
            assert!(query.contains(&json!(["limit", "1000"])));
            data["messages"].clone()
        }
        "/session/s-u045" => upstream_session(&data),
        _ => panic!("unexpected {method} {path}"),
    };
    Json(body).into_response()
}
fn url_query(query: &str) -> Vec<Value> {
    reqwest::Url::parse(&format!("http://fixture/?{query}"))
        .unwrap()
        .query_pairs()
        .map(|(k, v)| json!([k, v]))
        .collect()
}
struct Connection(String, PathBuf);
#[async_trait]
impl OpenCodeConnectionProvider for Connection {
    async fn connection(&self) -> Result<OpenCodeConnection, ProviderError> {
        Ok(OpenCodeConnection {
            endpoint: self.0.clone(),
            headers: BTreeMap::from([(
                "authorization".to_string(),
                "Basic Zml4dHVyZTpzZWNyZXQ=".to_string(),
            )]),
        })
    }
    fn workspace_roots(&self) -> Vec<PathBuf> {
        vec![self.1.clone()]
    }
}
fn record(
    event: ProviderEvent,
    deltas: &mut Vec<Value>,
    timeline: &mut Vec<Value>,
    timeline_deltas: &mut Vec<Value>,
) {
    match event{
    ProviderEvent::AgentMessageDelta{provider_session_id,turn_id,item_id,delta}=>deltas.push(json!({"sessionId":SESSION,"providerSessionId":provider_session_id,"turnId":turn_id,"itemId":item_id,"delta":delta})),
    ProviderEvent::TimelineItem{provider_session_id,item}=>timeline.push(json!({"sessionId":SESSION,"providerSessionId":provider_session_id,"item":item})),
    ProviderEvent::TimelineItemDelta{provider_session_id,turn_id,item_id,field,delta}=>timeline_deltas.push(json!({"sessionId":SESSION,"providerSessionId":provider_session_id,"turnId":turn_id,"itemId":item_id,"field":field,"delta":delta})),
    _=>{}
}
}
fn capture(
    name: &str,
    runtime: &AiSessionRuntime,
    deltas: &[Value],
    timeline: &[Value],
    timeline_deltas: &[Value],
) -> Value {
    json!({"name":name,"session":project(&runtime.get(SESSION).unwrap()),"deltas":deltas,"timeline":timeline,"timelineDeltas":timeline_deltas})
}
async fn observe(scenario: &Value) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let persistence = directory.path().join("sessions");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let cwd = workspace.to_str().unwrap().to_string();
    let runtime = Arc::new(AiSessionRuntime::new("test", Some(persistence.clone())));
    let mut seed = test_session();
    seed.cwd = Some(cwd.clone());
    seed.agent = "opencode".to_string();
    seed.provider_session_id = Some(PROVIDER.to_string());
    seed.active_turn_id = None;
    seed.status = "idle".to_string();
    seed.phase = "unknown".to_string();
    seed.title = Some("Existing title".to_string());
    runtime.save(seed).unwrap();
    let attachments = Arc::new(AiSessionConversationAttachmentStore::new(
        &directory.path().join("attachments"),
    ));
    let controller = AiSessionController::new(
        runtime.clone(),
        attachments.clone(),
        Arc::new(attachments.draft_streams()),
        None,
    );
    let (frames, receiver) = mpsc::unbounded_channel();
    frames
        .send("\u{feff}: fixture\r\n\r\n".as_bytes().to_vec())
        .unwrap();
    let peer_state = Peer {
        data: Arc::new(StdMutex::new(
            json!({"messages":[],"status":"idle","updated":1793923200000i64,"directory":cwd}),
        )),
        requests: Arc::new(StdMutex::new(Vec::new())),
        transport: Arc::new(StdMutex::new(Vec::new())),
        hold: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        release: Arc::new(Notify::new()),
        frames: Arc::new(StdMutex::new(Some(receiver))),
        connected: Arc::new(Notify::new()),
        reject_first: scenario["rejectFirst"] == true,
        directory: cwd.clone(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .fallback(any(peer))
        .with_state(peer_state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let provider =
        OpenCodeSessionProvider::new(Arc::new(Connection(format!("http://{address}"), workspace)));
    let mut events = provider.subscribe_events().unwrap();
    controller.register_provider(provider.clone());
    let mut changes = controller.subscribe_changes();
    let mut deltas = Vec::new();
    let mut timeline = Vec::new();
    let mut timeline_deltas = Vec::new();
    provider.read_session(PROVIDER).await.unwrap();
    provider.owner_barrier().await;
    timeout(Duration::from_secs(5), peer_state.connected.notified())
        .await
        .unwrap();
    // The empty snapshot has no active work. Wait for the production consumer.
    timeout(Duration::from_secs(5), async {
        loop {
            if runtime.get(SESSION).unwrap().actions.is_some() {
                break;
            }
            changes.recv().await.unwrap();
        }
    })
    .await
    .unwrap();
    peer_state
        .hold
        .store(true, std::sync::atomic::Ordering::Release);
    let mut checkpoints = vec![capture(
        "initial",
        &runtime,
        &deltas,
        &timeline,
        &timeline_deltas,
    )];
    let input = |id: &str| {
        ProviderMessageInput::from_wire(
            &serde_json::from_value(json!({"message":" Hello 世界 ","clientRequestId":id}))
                .unwrap(),
        )
    };
    let rejection = if scenario["rejectFirst"] == true {
        let before = serde_json::to_value(runtime.get(SESSION).unwrap()).unwrap();
        let error = controller
            .send_message(SESSION, input("rejected-u045"))
            .await
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(runtime.get(SESSION).unwrap()).unwrap(),
            before
        );
        checkpoints.push(capture(
            "rejected",
            &runtime,
            &deltas,
            &timeline,
            &timeline_deltas,
        ));
        json!({"message":error.message,"statusCode":error.status_code})
    } else {
        Value::Null
    };
    let ack = controller
        .send_message(SESSION, input("accepted-u045"))
        .await
        .unwrap();
    let action = json!({"provider":ack.provider,"action":ack.action.action,"turnId":ack.action.turn_id,"providerTurnId":ack.action.provider_turn_id});
    checkpoints.push(capture(
        "ack",
        &runtime,
        &deltas,
        &timeline,
        &timeline_deltas,
    ));
    let accepted_owner = runtime.get(SESSION).unwrap();
    peer_state
        .hold
        .store(false, std::sync::atomic::Ordering::Release);
    peer_state.release.notify_waiters();
    provider.read_session(PROVIDER).await.unwrap();
    provider.owner_barrier().await;
    assert_eq!(
        runtime.get(SESSION).unwrap(),
        accepted_owner,
        "empty pre-transcript snapshot preserves complete accepted owner"
    );
    checkpoints.push(capture(
        "empty-snapshot",
        &runtime,
        &deltas,
        &timeline,
        &timeline_deltas,
    ));
    peer_state
        .hold
        .store(true, std::sync::atomic::Ordering::Release);
    let user = peer_state.data.lock().unwrap()["userId"]
        .as_str()
        .unwrap()
        .to_string();
    for raw in scenario["steps"].as_array().unwrap() {
        let step = replace(replace(raw.clone(), "$user", &user), "/workspace", &cwd);
        {
            let mut data = peer_state.data.lock().unwrap();
            data["messages"] = step["messages"].clone();
            data["status"] = step["status"].clone();
            data["updated"] = json!(data["updated"].as_i64().unwrap() + 1000);
        }
        for event in step["events"].as_array().unwrap() {
            for byte in format!("data: {event}\r\n\r\n").bytes() {
                frames.send(vec![byte]).unwrap();
            }
        }
        peer_state
            .hold
            .store(false, std::sync::atomic::Ordering::Release);
        peer_state.release.notify_waiters();
        let gate=timeout(Duration::from_secs(5),async{
            loop{
                while let Ok(event)=events.try_recv(){record(event,&mut deltas,&mut timeline,&mut timeline_deltas);}
                let state=project(&runtime.get(SESSION).unwrap());
                if step["wait"].as_object().unwrap().iter().all(|(k,v)|state[k]==*v)&&deltas.len()==step["deltas"].as_u64().unwrap() as usize&&timeline.len()==step["timeline"].as_u64().unwrap() as usize&&timeline_deltas.len()==step["timelineDeltas"].as_u64().unwrap() as usize{break;}
                tokio::select!{event=events.recv()=>record(event.unwrap(),&mut deltas,&mut timeline,&mut timeline_deltas),change=changes.recv()=>{change.unwrap();}}
            }
        }).await;
        if gate.is_err() {
            let failed = capture("timeout", &runtime, &deltas, &timeline, &timeline_deltas);
            std::fs::write(
                format!(
                    "/tmp/ci-u045-{}-timeout.json",
                    scenario["id"].as_str().unwrap()
                ),
                failed.to_string(),
            )
            .unwrap();
            panic!("owner/transport barrier failed: {} {failed}", step["name"]);
        }
        // Match the Node observation boundary after coalesced SSE work.
        for _ in 0..2 {
            provider.read_session(PROVIDER).await.unwrap();
            provider.owner_barrier().await;
        }
        checkpoints.push(capture(
            step["name"].as_str().unwrap(),
            &runtime,
            &deltas,
            &timeline,
            &timeline_deltas,
        ));
        peer_state
            .hold
            .store(true, std::sync::atomic::Ordering::Release);
    }
    let final_session = runtime.get(SESSION).unwrap();
    let final_turn = final_session.turns.as_ref().unwrap().last().unwrap();
    let clocks = if final_session.status == "idle" {
        json!({"startedAt":final_turn["startedAt"],"completedAt":final_turn["completedAt"]})
    } else {
        Value::Null
    };
    if !clocks.is_null() {
        assert_eq!(clocks["startedAt"], "2026-11-06T00:00:01.000Z");
        assert_eq!(clocks["completedAt"], "2026-11-06T00:00:06.000Z");
    }
    peer_state
        .hold
        .store(false, std::sync::atomic::Ordering::Release);
    peer_state.release.notify_waiters();
    provider.read_session(PROVIDER).await.unwrap();
    provider.owner_barrier().await;
    // Wait for the actual registered owner to consume its read snapshot.
    // OpenCode's body revision remains unchanged by this duplicate observation.
    timeout(Duration::from_secs(5),async{loop{
        while let Ok(event)=events.try_recv(){record(event,&mut deltas,&mut timeline,&mut timeline_deltas);}
        if runtime.get(SESSION).unwrap().turns.as_ref().unwrap().last().unwrap()["source"]=="adapter-snapshot"{break;}
        tokio::select!{event=events.recv()=>record(event.unwrap(),&mut deltas,&mut timeline,&mut timeline_deltas),change=changes.recv()=>{change.unwrap();}}
    }}).await.unwrap();
    let after = runtime.get(SESSION).unwrap();
    let after_turn = after.turns.as_ref().unwrap().last().unwrap();
    for key in ["startedAt", "completedAt", "revision"] {
        assert_eq!(after_turn[key], final_turn[key], "reread preserves {key}");
    }
    checkpoints.push(capture(
        "reread",
        &runtime,
        &deltas,
        &timeline,
        &timeline_deltas,
    ));
    let reopened = AiSessionRuntime::new("test", Some(persistence))
        .get(SESSION)
        .unwrap();
    assert_eq!(
        reopened,
        runtime.get(SESSION).unwrap(),
        "full owner reopens including clocks"
    );
    let restored = project(&reopened);
    let requests = peer_state.requests.lock().unwrap().clone();
    let transport = peer_state.transport.lock().unwrap().clone();
    let mut actual = json!({"action":action,"rejection":rejection,"requests":requests,"transport":transport,"checkpoints":checkpoints,"restored":restored,"clocks":clocks});
    for (i, request) in requests.iter().enumerate() {
        let id = request["body"]["messageID"].as_str().unwrap();
        if i > 0 {
            assert_ne!(id, requests[0]["body"]["messageID"].as_str().unwrap());
        }
        actual = replace(
            actual,
            id,
            if i == requests.len() - 1 {
                "$user"
            } else {
                "$rejectedUser"
            },
        );
    }
    provider.close();
    peer_state
        .hold
        .store(false, std::sync::atomic::Ordering::Release);
    peer_state.release.notify_waiters();
    drop(frames);
    server.abort();
    let _ = server.await;
    replace(actual, &cwd, "/workspace")
}
async fn compare(id: &str) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/opencode-interaction-parity.json"
    ))
    .unwrap();
    let scenario = fixture["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap();
    let actual = observe(scenario).await;
    std::fs::write(
        format!("/tmp/ci-u045-{id}-rust.json"),
        serde_json::to_string_pretty(&actual).unwrap(),
    )
    .unwrap();
    assert_eq!(
        actual, scenario["expected"],
        "{id} real HTTP/SSE owner parity"
    );
}
#[tokio::test]
async fn main_interaction() {
    compare("C01-main").await;
}
#[tokio::test]
async fn rejected_then_retry() {
    compare("C02-rejected").await;
}
#[tokio::test]
async fn terminal_error() {
    compare("C03-failed").await;
}

mod controls {
    use super::*;
    include!("opencode_control_parity.rs");
}
