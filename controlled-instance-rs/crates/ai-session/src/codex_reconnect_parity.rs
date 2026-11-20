use super::*;
use crate::{
    AiSessionController, AiSessionConversationAttachmentStore, AiSessionRuntime,
    ProviderMessageInput,
};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

const SESSION: &str = "ses_0000000000001";
// Same explicit non-clock projection and message-ID bijection as U04.1/2.
fn project(session: &AiSession, identities: &mut HashMap<String, String>) -> Value {
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
            let mut projected = Map::new();
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
                "currentTool",
                "toolCallsSinceLastMessage",
            ] {
                projected.insert(key.to_string(), turn[key].clone());
            }
            if let Some(tool) = projected
                .get_mut("currentTool")
                .and_then(Value::as_object_mut)
            {
                tool.remove("startedAt");
            }
            let messages = turn["userMessages"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|message| {
                    let mut message = message.clone();
                    let id = message["id"].as_str().unwrap().to_string();
                    let next = format!("$message{}", identities.len() + 1);
                    let mapped = identities.entry(id).or_insert(next).clone();
                    message["id"] = json!(mapped);
                    message
                })
                .collect::<Vec<_>>();
            projected.insert("userMessages".to_string(), json!(messages));
            Value::Object(projected)
        })
        .collect::<Vec<_>>();
    out.insert("turns".to_string(), json!(turns));
    Value::Object(out)
}
#[derive(Default)]
struct Trace {
    requests: Vec<Value>,
    responses: Vec<Value>,
    readiness: Vec<usize>,
    senders: Vec<mpsc::UnboundedSender<PeerCommand>>,
    held: bool,
}
enum PeerCommand {
    Park(oneshot::Sender<()>),
    Frames(Vec<Value>, bool, oneshot::Sender<()>),
    Drop(oneshot::Sender<()>),
}
struct Peer {
    endpoint: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[allow(clippy::result_large_err)]
async fn peer(
    trace: Arc<std::sync::Mutex<Trace>>,
    changed: Arc<tokio::sync::Notify>,
    hold_first: bool,
) -> Peer {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut children = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted=listener.accept()=>{
                    let (stream,_)=accepted.unwrap();
                    let trace=trace.clone();let changed=changed.clone();
                    children.spawn(async move {
                        let mut socket=tokio_tungstenite::accept_hdr_async(stream, |request: &tokio_tungstenite::tungstenite::handshake::server::Request,response| {
                            assert_eq!(request.uri().path(),"/rpc");
                            assert_eq!(request.headers()["authorization"],"Bearer fixture-token");Ok(response)
                        }).await.unwrap();
                        let (send,mut commands)=mpsc::unbounded_channel();
                        let connection={let mut t=trace.lock().unwrap();t.senders.push(send);t.senders.len()};
                        let mut parked=false;
                        let mut closing=None;
                        'connection: loop {
                            tokio::select! {
                                biased;
                                command=commands.recv()=>{
                                    match command {
                                        Some(PeerCommand::Park(done))=>{parked=true;let _=done.send(());},
                                        Some(PeerCommand::Frames(frames,close_after,done))=>{
                                            for (index,frame) in frames.into_iter().enumerate() {
                                                if let Err(error)=socket.send(Message::Text(frame.to_string().into())).await {
                                                    // Only the retired-peer batch may observe the
                                                    // client's completed transport cancellation.
                                                    let disconnected=match &error {
                                                        tokio_tungstenite::tungstenite::Error::ConnectionClosed
                                                        | tokio_tungstenite::tungstenite::Error::AlreadyClosed=>true,
                                                        tokio_tungstenite::tungstenite::Error::Io(error)=>matches!(error.kind(),
                                                            std::io::ErrorKind::BrokenPipe|std::io::ErrorKind::ConnectionReset
                                                            |std::io::ErrorKind::NotConnected|std::io::ErrorKind::ConnectionAborted),
                                                        _=>false,
                                                    };
                                                    assert!(close_after && disconnected,"unexpected peer write: {error}");
                                                    eprintln!("retired peer closed after {index} late frame writes: {error}");
                                                    let _=done.send(());
                                                    break 'connection;
                                                }
                                            }
                                            if close_after {parked=false;closing=Some(done);} else {let _=done.send(());}
                                        }
                                        Some(PeerCommand::Drop(done))=>{drop(socket);let _=done.send(());break;},
                                        None=>break,
                                    }
                                }
                                frame=socket.next(),if !parked=>{
                                    let Some(Ok(frame))=frame else {break;};
                                    if frame.is_close() {let _=socket.flush().await;break;}
                                    let Message::Text(text)=frame else {continue;};
                                    let rpc:Value=serde_json::from_str(text.as_str()).unwrap();
                                    let method=rpc["method"].as_str().unwrap_or("");
                                    if method.is_empty() && rpc.get("id").is_some() {
                                        let mut response=rpc;response["connection"]=json!(connection);
                                        trace.lock().unwrap().responses.push(response);changed.notify_one();continue;
                                    }
                                    if rpc.get("id").is_none(){continue;}
                                    if method.starts_with("turn/"){trace.lock().unwrap().requests.push(json!({"connection":connection,"method":method,"params":rpc["params"]}));}
                                    if method=="thread/loaded/list"{trace.lock().unwrap().readiness.push(connection);}
                                    if hold_first && connection==1 && method=="turn/start" {trace.lock().unwrap().held=true;changed.notify_one();continue;}
                                    let result=match method {
                                        "initialize"=>json!({"userAgent":"codex_cli_rs/0.161.0 test"}),
                                        "thread/loaded/list"=>json!({"data":["thread-u041"]}),
                                        "turn/start"=>json!({"turn":{"id":"turn-u041","status":"inProgress"}}),
                                        _=>panic!("unexpected RPC {rpc}"),
                                    };
                                    socket.send(Message::Text(json!({"id":rpc["id"],"result":result}).to_string().into())).await.unwrap();
                                }
                            }
                        }
                        if let Some(done)=closing {let _=done.send(());}
                    });
                }
                completed=children.join_next(),if !children.is_empty()=>{completed.unwrap().unwrap();}
            }
        }
    });
    Peer { endpoint, task }
}
async fn command(
    trace: &Arc<std::sync::Mutex<Trace>>,
    connection: usize,
    make: impl FnOnce(oneshot::Sender<()>) -> PeerCommand,
) {
    let (send, done) = oneshot::channel();
    trace.lock().unwrap().senders[connection - 1]
        .send(make(send))
        .unwrap();
    timeout(Duration::from_secs(4), done)
        .await
        .unwrap()
        .unwrap();
}
fn approval(id: u64, reason: &str) -> Value {
    json!({"id":id,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-u041","turnId":"turn-u041","itemId":"command-u043","command":"echo test","reason":reason}})
}
fn input(request: &str) -> ProviderMessageInput {
    ProviderMessageInput::from_wire(
        &serde_json::from_value(json!({"message":" Hello 世界 ","clientRequestId":request}))
            .unwrap(),
    )
}
async fn gate(mut ready: impl FnMut() -> bool) {
    timeout(Duration::from_secs(4), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("observable owner gate");
}
async fn observe(scenario: &Value) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let persistence = directory.path().join("sessions");
    let runtime = Arc::new(AiSessionRuntime::new("test", Some(persistence.clone())));
    let mut seed = test_session();
    seed.provider_session_id = Some("thread-u041".into());
    seed.active_turn_id = None;
    seed.title = Some("Existing title".into());
    seed.status = "idle".into();
    seed.phase = "unknown".into();
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
    let trace = Arc::new(std::sync::Mutex::new(Trace::default()));
    let changed = Arc::new(tokio::sync::Notify::new());
    let id = scenario["id"].as_str().unwrap();
    let mut peers = vec![peer(trace.clone(), changed.clone(), id == "C01").await];
    let token = directory.path().join("token");
    std::fs::write(&token, "fixture-token").unwrap();
    let target = |endpoint: String| {
        Some(CodexAppServerTarget::WebSocket {
            endpoint,
            token_file: Some(token.clone()),
        })
    };
    let client = CodexAppServerClient::with_command("missing-u043-cli");
    let mut events = client.subscribe_events();
    controller.register_provider(Arc::new(CodexAppServerProvider::new(client.clone(), None)));
    client
        .configure_external_target(target(peers[0].endpoint.clone()))
        .await
        .unwrap();
    let mut ids = HashMap::new();
    let mut outcomes = Vec::new();
    let mut checkpoints = Vec::new();
    let mut deltas = Vec::new();
    let mut timeline = Vec::new();
    macro_rules! capture {($name:expr)=>{checkpoints.push(json!({"name":$name,"session":project(&runtime.get(SESSION).unwrap(),&mut ids),"deltas":deltas,"timeline":timeline}));};}
    capture!("initial");
    if id == "C01" {
        let before = serde_json::to_value(runtime.get(SESSION).unwrap()).unwrap();
        let owner = controller.clone();
        let attempt =
            tokio::spawn(async move { owner.send_message(SESSION, input("pending-u043")).await });
        timeout(Duration::from_secs(4), async {
            loop {
                if trace.lock().unwrap().held {
                    break;
                }
                changed.notified().await;
            }
        })
        .await
        .unwrap();
        command(&trace, 1, PeerCommand::Drop).await;
        let error = timeout(Duration::from_secs(4), attempt)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        outcomes.push(json!({"name":"disconnected","error":{"message":error.message}}));
        assert_eq!(
            serde_json::to_value(runtime.get(SESSION).unwrap()).unwrap(),
            before,
            "pending disconnect preserves complete owner including clocks"
        );
        assert!(client.inner.pending.lock().await.is_empty());
        capture!("disconnected");
        controller
            .send_message(SESSION, input("retry-u043"))
            .await
            .unwrap();
        capture!("retry");
    } else {
        controller
            .send_message(SESSION, input("accepted-u043"))
            .await
            .unwrap();
        capture!("ack");
        command(&trace, 1, |done| {
            PeerCommand::Frames(vec![approval(701, "Old command")], false, done)
        })
        .await;
        gate(|| runtime.get(SESSION).unwrap().phase == "approval").await;
        capture!("old-approval");
        if id == "C02" {
            command(&trace, 1, PeerCommand::Drop).await;
            gate(|| !client.is_connected()).await;
            capture!("disconnected");
            let before = serde_json::to_value(runtime.get(SESSION).unwrap()).unwrap();
            let error = controller
                .resolve_approval(SESSION, "allow")
                .await
                .unwrap_err();
            outcomes.push(json!({"name":"not-attached","error":{"code":error.code,"message":error.message,"statusCode":error.status_code}}));
            assert_eq!(
                serde_json::to_value(runtime.get(SESSION).unwrap()).unwrap(),
                before
            );
            capture!("not-attached");
            command(&trace, 2, |done| {
                PeerCommand::Frames(vec![approval(702, "New command")], false, done)
            })
            .await;
            gate(|| {
                runtime.get(SESSION).unwrap().summary.as_deref()
                    == Some("New command · Command: echo test")
            })
            .await;
            capture!("replayed");
        } else {
            command(&trace, 1, PeerCommand::Park).await;
            let retired_reader = client
                .inner
                .connection
                .lock()
                .await
                .as_ref()
                .unwrap()
                .reader
                .as_ref()
                .unwrap()
                .abort_handle();
            peers.push(peer(trace.clone(), changed.clone(), false).await);
            client
                .configure_external_target(target(peers[1].endpoint.clone()))
                .await
                .unwrap();
            assert!(
                retired_reader.is_finished(),
                "old reader joined before new endpoint is ready"
            );
            command(&trace, 2, |done| {
                PeerCommand::Frames(vec![approval(701, "New command")], false, done)
            })
            .await;
            gate(|| {
                runtime.get(SESSION).unwrap().summary.as_deref()
                    == Some("New command · Command: echo test")
            })
            .await;
            capture!("new-approval");
            while events.try_recv().is_ok() {}
            let before = serde_json::to_value(runtime.get(SESSION).unwrap()).unwrap();
            // Actual old peer sends data while the replacement connection owns
            // the controller. Reading its delayed close handshake ends this batch.
            command(&trace, 1, |done| {
                PeerCommand::Frames(
                    scenario["lateFrames"].as_array().unwrap().clone(),
                    true,
                    done,
                )
            })
            .await;
            // On this current-thread executor the old reader and the registered
            // owner drain without contended locks. Yield after the peer's close.
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
            while let Ok(event) = events.try_recv() {
                match event {
                ProviderEvent::AgentMessageDelta{provider_session_id,turn_id,item_id,delta}=>deltas.push(json!({"sessionId":SESSION,"providerSessionId":provider_session_id,"turnId":turn_id,"itemId":item_id,"delta":delta})),
                ProviderEvent::TimelineItem{provider_session_id,item}=>timeline.push(json!({"sessionId":SESSION,"providerSessionId":provider_session_id,"item":item})),
                _=>{}
            }
            }
            assert_eq!(
                serde_json::to_value(runtime.get(SESSION).unwrap()).unwrap(),
                before,
                "old connection preserves complete current owner including clocks"
            );
            capture!("late-ignored");
        }
        let action = controller.resolve_approval(SESSION, "allow").await.unwrap();
        outcomes.push(json!({"name":"approved","result":{"provider":action.provider,"action":action.action.action,"decision":action.action.decision}}));
        timeout(Duration::from_secs(4), async {
            loop {
                if trace.lock().unwrap().responses.len() == 1 {
                    break;
                }
                changed.notified().await;
            }
        })
        .await
        .unwrap();
        gate(|| runtime.get(SESSION).unwrap().phase == "thinking").await;
        capture!("approved");
    }
    command(&trace,2,|done|PeerCommand::Frames(vec![json!({"method":"turn/completed","params":{"threadId":"thread-u041","turn":{"id":"turn-u041","status":"completed"}}})],false,done)).await;
    gate(|| runtime.get(SESSION).unwrap().status == "idle").await;
    capture!("completed");
    let restored = project(
        &AiSessionRuntime::new("test", Some(persistence))
            .get(SESSION)
            .unwrap(),
        &mut ids,
    );
    client.stop().await;
    let t = trace.lock().unwrap();
    json!({"requests":t.requests,"responses":t.responses,"outcomes":outcomes,"checkpoints":checkpoints,"restored":restored,"readiness":[t.readiness.contains(&1),t.readiness.contains(&2)]})
}
async fn run(id: &str) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/codex-reconnect-parity.json"
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
        format!("/tmp/ci-u043-{id}-rust.json"),
        serde_json::to_vec_pretty(&actual).unwrap(),
    )
    .unwrap();
    let mut actual = actual;
    let mut expected = scenario["expected"].clone();
    // Node can resolve a replayed approval without a readiness query; Rust
    // defensively checks loaded threads. Keep raw observations in the artifact.
    // These private discovery calls are not turn actions or approval responses.
    if id == "C03" {
        actual.as_object_mut().unwrap().remove("readiness");
        expected.as_object_mut().unwrap().remove("readiness");
    }
    assert_eq!(actual, expected, "{id}");
}
#[tokio::test]
async fn pending_disconnect_retry() {
    run("C01").await;
}
#[tokio::test]
async fn approval_requires_replay() {
    run("C02").await;
}
#[tokio::test]
async fn replaced_connection_ignores_late_frames() {
    run("C03").await;
}

#[tokio::test]
async fn suspended_reader_is_joined_before_replacement() {
    // Rust-local cancellation invariant: use a real WS frame and the actual
    // live-item mutex to suspend its production handler, never call a parser.
    let trace = Arc::new(std::sync::Mutex::new(Trace::default()));
    let changed = Arc::new(tokio::sync::Notify::new());
    let old = peer(trace.clone(), changed.clone(), false).await;
    let new = peer(trace.clone(), changed, false).await;
    let directory = tempfile::tempdir().unwrap();
    let token = directory.path().join("token");
    std::fs::write(&token, "fixture-token").unwrap();
    let target = |endpoint: String| {
        Some(CodexAppServerTarget::WebSocket {
            endpoint,
            token_file: Some(token.clone()),
        })
    };
    let client = CodexAppServerClient::with_command("missing-u043-cli");
    let mut events = client.subscribe_events();
    let mut notifications = client.subscribe_notifications();
    client
        .configure_external_target(target(old.endpoint.clone()))
        .await
        .unwrap();
    command(&trace,1,|done|PeerCommand::Frames(vec![
        approval(701,"Old command"),
        json!({"method":"error","params":{"threadId":"thread-u041","turnId":"turn-u041","error":{"message":"Old error"},"willRetry":false}}),
        json!({"method":"error","params":{"threadId":"thread-u041","turnId":"turn-u041","error":{"message":"Old retry"},"willRetry":true}}),
    ],false,done)).await;
    timeout(Duration::from_secs(4), async {
        loop {
            if client
                .inner
                .turn_errors
                .lock()
                .await
                .contains_key("thread-u041")
                && client
                    .inner
                    .retry_warnings
                    .lock()
                    .await
                    .contains_key("thread-u041")
                && !client.live_items("thread-u041").await.is_empty()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let held = client.inner.live_items.lock().await;
    while events.try_recv().is_ok() {}
    while notifications.try_recv().is_ok() {}
    let suspended = json!({"method":"item/completed","params":{"threadId":"thread-u041","turnId":"turn-u041","item":{"id":"suspended-answer","type":"agentMessage","text":"Must never publish"}}});
    command(&trace, 1, |done| {
        PeerCommand::Frames(vec![suspended.clone()], false, done)
    })
    .await;
    let observed = timeout(Duration::from_secs(4), notifications.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        observed, suspended,
        "real reader reached its live-item await"
    );
    let reader = client
        .inner
        .connection
        .lock()
        .await
        .as_ref()
        .unwrap()
        .reader
        .as_ref()
        .unwrap()
        .abort_handle();
    let replacement = client.clone();
    let next = target(new.endpoint.clone());
    let replace = tokio::spawn(async move { replacement.configure_external_target(next).await });
    // Joining the old task must not require releasing the live-item lock. A
    // generation check only at handle_line entry would miss this in-flight frame.
    gate(|| reader.is_finished()).await;
    assert!(
        !replace.is_finished(),
        "replacement still awaits clearing old live items"
    );
    drop(held);
    timeout(Duration::from_secs(4), replace)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(client.inner.approvals.lock().await.is_empty());
    assert!(client.inner.turn_errors.lock().await.is_empty());
    assert!(client.inner.retry_warnings.lock().await.is_empty());
    assert!(client.live_items("thread-u041").await.is_empty());
    let emitted = drain_events(&mut events);
    assert!(
        emitted
            .iter()
            .all(|event| matches!(event, ProviderEvent::ConnectionChanged { connected: true })),
        "old suspended handler emitted {emitted:?}"
    );
    assert_eq!(
        client.list_loaded_thread_ids().await.unwrap(),
        vec!["thread-u041".to_string()]
    );
    assert!(client.is_connected());
    client.stop().await;
}
