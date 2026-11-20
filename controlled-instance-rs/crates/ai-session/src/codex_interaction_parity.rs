use super::*;
use crate::codex_app_server::{CodexAppServerClient, CodexAppServerProvider, CodexAppServerTarget};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::Message;

const SESSION: &str = "ses_0000000000001";
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../tests/fixtures/codex-interaction-parity.json"
    ))
    .unwrap()
}
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
fn capture(
    name: &str,
    runtime: &AiSessionRuntime,
    identities: &mut HashMap<String, String>,
    deltas: &[Value],
    timeline: &[Value],
) -> Value {
    json!({"name":name,"session":project(&runtime.get(SESSION).unwrap(), identities),"deltas":deltas,"timeline":timeline})
}
fn input(request: &str) -> ProviderMessageInput {
    ProviderMessageInput::from_wire(
        &serde_json::from_value(json!({"message":" Hello 世界 ","clientRequestId":request}))
            .unwrap(),
    )
}
#[allow(clippy::result_large_err)]
async fn observe(scenario: &Value) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let persistence = directory.path().join("sessions");
    let runtime = Arc::new(AiSessionRuntime::new("test", Some(persistence.clone())));
    let mut seed = test_session();
    seed.provider_session_id = Some("thread-u041".to_string());
    seed.active_turn_id = None;
    seed.title = Some("Existing title".to_string());
    seed.status = "idle".to_string();
    seed.phase = "unknown".to_string();
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
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let (send, mut notifications) = mpsc::unbounded_channel::<(Value, oneshot::Sender<()>)>();
    let requests = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let transport = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let server_requests = requests.clone();
    let server_transport = transport.clone();
    let reject_first = scenario["rejectFirst"].as_bool().unwrap_or(false);
    let responses = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let server_responses = responses.clone();
    let response_ready = Arc::new(tokio::sync::Notify::new());
    let server_response_ready = response_ready.clone();
    let mut rpc_replies = scenario["rpcReplies"].clone();
    let early_ack = scenario.get("beforeAck").is_some();
    let held_ready = Arc::new(tokio::sync::Notify::new());
    let server_held_ready = held_ready.clone();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let handshake_transport = server_transport.clone();
        let mut socket = tokio_tungstenite::accept_hdr_async(
            stream,
            move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                  response| {
                let authorized =
                    request.headers().get("authorization").unwrap() == "Bearer fixture-token";
                assert!(authorized);
                handshake_transport
                    .lock()
                    .unwrap()
                    .push(json!({"path":request.uri().path(),"authorized":authorized}));
                Ok(response)
            },
        )
        .await
        .unwrap();
        let mut starts = 0;
        let mut pending_start = None;
        loop {
            tokio::select! {
                notification=notifications.recv()=>{
                    let Some((notification,done))=notification else { break; };
                    let notification = if notification.get("__replyStart").is_some() {
                        let mut reply=notification["__replyStart"].clone();
                        reply["id"]=pending_start.take().expect("turn/start must precede early events");
                        reply
                    } else { notification };
                    socket.send(Message::Text(notification.to_string().into())).await.unwrap();
                    let _=done.send(());
                }
                message=socket.next()=>{
                    let Some(Ok(message))=message else { break; };
                    if message.is_close() { break; }
                    let Message::Text(text)=message else { continue; };
                    let rpc:Value=serde_json::from_str(text.as_str()).unwrap();
                    let method=rpc["method"].as_str().unwrap_or("");
                    if method.starts_with("turn/") { server_requests.lock().unwrap().push(json!({"method":method,"params":rpc["params"]})); }
                    if method=="thread/loaded/list" { server_transport.lock().unwrap().push(json!({"method":method,"params":rpc["params"]})); }
                    if method.is_empty() && rpc.get("id").is_some() {
                        server_responses.lock().unwrap().push(rpc);
                        server_response_ready.notify_one();
                        continue;
                    }
                    if rpc.get("id").is_none() { continue; }
                    if early_ack && method=="turn/start" {
                        pending_start=Some(rpc["id"].clone());
                        server_held_ready.notify_one();
                        continue;
                    }
                    let scripted = rpc_replies.get_mut(method).and_then(Value::as_array_mut)
                        .filter(|replies| !replies.is_empty()).map(|replies| replies.remove(0));
                    let response=if let Some(mut scripted)=scripted {
                        scripted["id"]=rpc["id"].clone();
                        scripted
                    } else { match method {
                        "initialize"=>json!({"id":rpc["id"],"result":{"userAgent":"codex_cli_rs/0.161.0 test"}}),
                        "thread/loaded/list"=>json!({"id":rpc["id"],"result":{"data":["thread-u041"]}}),
                        "turn/start"=>{
                            let reject=reject_first&&starts==0; starts+=1;
                            if reject {json!({"id":rpc["id"],"error":{"code":-32000,"message":"fixture turn rejected"}})}
                            else {json!({"id":rpc["id"],"result":{"turn":{"id":"turn-u041","status":"inProgress"}}})}
                        }
                        "turn/steer"=>json!({"id":rpc["id"],"result":{"turnId":rpc["params"]["expectedTurnId"]}}),
                        "turn/interrupt"=>json!({"id":rpc["id"],"result":{}}),
                        _=>panic!("unexpected RPC {rpc}"),
                    }};
                    socket.send(Message::Text(response.to_string().into())).await.unwrap();
                }
            }
        }
    });
    let token = directory.path().join("token");
    std::fs::write(&token, "fixture-token").unwrap();
    let client = CodexAppServerClient::with_command("missing-u041-cli");
    let mut events = client.subscribe_events();
    controller.register_provider(Arc::new(CodexAppServerProvider::new(client.clone(), None)));
    client
        .configure_external_target(Some(CodexAppServerTarget::WebSocket {
            endpoint: format!("ws://{address}"),
            token_file: Some(token),
        }))
        .await
        .unwrap();
    // Drop connection events before actions, retaining the real registered owner task.
    while events.try_recv().is_ok() {}
    let mut identities = HashMap::new();
    let mut deltas = Vec::new();
    let mut timeline = Vec::new();
    let mut checkpoints = vec![capture(
        "initial",
        &runtime,
        &mut identities,
        &deltas,
        &timeline,
    )];
    let mut rejection = if reject_first {
        let error = controller
            .send_message(SESSION, input("rejected-u041"))
            .await
            .unwrap_err();
        checkpoints.push(capture(
            "rejected",
            &runtime,
            &mut identities,
            &deltas,
            &timeline,
        ));
        json!({"message":error.message})
    } else {
        Value::Null
    };
    let mut action = Value::Null;
    let mut pending_ack = if early_ack {
        let controller = controller.clone();
        let pending = tokio::spawn(async move {
            controller
                .send_message(SESSION, input("accepted-u041"))
                .await
        });
        timeout(Duration::from_secs(4), held_ready.notified())
            .await
            .unwrap();
        Some(pending)
    } else {
        let ack = controller
            .send_message(SESSION, input("accepted-u041"))
            .await
            .unwrap();
        action = json!({"provider":ack.provider,"action":ack.action.action,"turnId":ack.action.turn_id,"providerTurnId":ack.action.provider_turn_id});
        checkpoints.push(capture(
            "ack",
            &runtime,
            &mut identities,
            &deltas,
            &timeline,
        ));
        None
    };
    let mut outcomes = Vec::new();
    let mut steps = Vec::new();
    if early_ack {
        steps.extend(scenario["beforeAck"].as_array().unwrap().clone());
        steps.push(json!({"__ack":true}));
    }
    steps.extend(scenario["steps"].as_array().unwrap().clone());
    for step in &steps {
        if step["__ack"] == true {
            let before = runtime.get(SESSION).unwrap();
            let before_turn = before
                .turns
                .as_deref()
                .and_then(|turns| turns.iter().find(|t| t["id"] == "turn-u041"))
                .cloned();
            let completion = before_turn
                .as_ref()
                .and_then(|t| t.get("completedAt"))
                .cloned();
            let reply = scenario.get("ackReply").cloned().unwrap_or_else(
                || json!({"result":{"turn":{"id":"turn-u041","status":"inProgress"}}}),
            );
            let (sent, done) = oneshot::channel();
            send.send((json!({"__replyStart":reply}), sent)).unwrap();
            done.await.unwrap();
            match timeout(Duration::from_secs(4), pending_ack.take().unwrap())
                .await
                .unwrap()
                .unwrap()
            {
                Ok(ack) => {
                    action = json!({"provider":ack.provider,"action":ack.action.action,"turnId":ack.action.turn_id,"providerTurnId":ack.action.provider_turn_id});
                    checkpoints.push(capture(
                        "ack",
                        &runtime,
                        &mut identities,
                        &deltas,
                        &timeline,
                    ));
                }
                Err(error) => {
                    rejection = json!({"message":error.message});
                    checkpoints.push(capture(
                        "rejected",
                        &runtime,
                        &mut identities,
                        &deltas,
                        &timeline,
                    ));
                }
            }
            if scenario["assertAck"] == true {
                let after = runtime.get(SESSION).unwrap();
                let after_turn = after
                    .turns
                    .as_deref()
                    .unwrap()
                    .iter()
                    .find(|t| t["id"] == "turn-u041")
                    .unwrap();
                if let Some(completion) = completion {
                    assert_eq!(after_turn["completedAt"], completion);
                }
                if let Some(before_turn) = before_turn {
                    assert_eq!(after_turn["startedAt"], before_turn["startedAt"]);
                }
                let before_raw = serde_json::to_value(&before).unwrap();
                let after_raw = serde_json::to_value(&after).unwrap();
                for key in [
                    "status",
                    "phase",
                    "error",
                    "activeTurnId",
                    "completedAt",
                    "summary",
                    "lastMessage",
                    "unread",
                ] {
                    assert_eq!(after_raw[key], before_raw[key], "ack preserves {key}");
                }
                if !rejection.is_null() {
                    assert_eq!(
                        after_raw, before_raw,
                        "rejection preserves complete realtime owner including clocks"
                    );
                } else {
                    assert_eq!(after_turn["userMessages"].as_array().unwrap().len(), 1);
                }
            }
            continue;
        }
        if let Some(operation) = step["action"].as_str() {
            let before = serde_json::to_value(runtime.get(SESSION).unwrap()).unwrap();
            let result = match operation {
                "approval" => controller.resolve_approval(SESSION, step["decision"].as_str().unwrap()).await,
                "interrupt" => controller.interrupt(SESSION).await,
                "steer" => controller.send_message(SESSION, ProviderMessageInput::from_wire(
                    &serde_json::from_value(json!({"message":" Follow up ","mode":"steer","clientRequestId":step["name"]})).unwrap()
                )).await,
                _ => panic!("unexpected action {operation}"),
            };
            match result {
                Ok(result) => {
                    let mut outcome =
                        json!({"provider":result.provider,"action":result.action.action});
                    if operation == "approval" {
                        outcome["decision"] = json!(result.action.decision);
                        assert!(matches!(
                            timeout(Duration::from_secs(4), events.recv())
                                .await
                                .unwrap()
                                .unwrap(),
                            ProviderEvent::ApprovalResolved { .. }
                        ));
                        tokio::task::yield_now().await;
                    } else {
                        outcome["providerTurnId"] = json!(result.action.provider_turn_id);
                    }
                    outcomes.push(json!({"name":step["name"],"result":outcome}));
                }
                Err(error) => {
                    assert_eq!(
                        serde_json::to_value(runtime.get(SESSION).unwrap()).unwrap(),
                        before,
                        "rejected control preserves complete owner, including clocks"
                    );
                    let mut observed = json!({"message":error.message});
                    if step["error"] == "typed" {
                        observed["code"] = json!(error.code);
                        observed["statusCode"] = json!(error.status_code);
                    }
                    outcomes.push(json!({"name":step["name"],"error":observed}));
                }
            }
            if let Some(count) = step["responses"].as_u64() {
                timeout(Duration::from_secs(4), async {
                    loop {
                        if responses.lock().unwrap().len() == count as usize {
                            break;
                        }
                        response_ready.notified().await;
                    }
                })
                .await
                .expect("approval response arrives at actual server");
            }
            checkpoints.push(capture(
                step["name"].as_str().unwrap(),
                &runtime,
                &mut identities,
                &deltas,
                &timeline,
            ));
            continue;
        }
        let previous_completion = if step["notification"]["method"] == "turn/completed" {
            runtime
                .get(SESSION)
                .unwrap()
                .turns
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|turn| {
                    turn["id"] == step["notification"]["params"]["turn"]["id"]
                        || turn["providerTurnId"] == step["notification"]["params"]["turn"]["id"]
                })
                .and_then(|turn| {
                    turn.get("completedAt")
                        .cloned()
                        .map(|clock| (turn["id"].clone(), clock))
                })
        } else {
            None
        };
        let (sent, done) = oneshot::channel();
        send.send((step["notification"].clone(), sent)).unwrap();
        done.await.unwrap();
        timeout(Duration::from_secs(4), async {
            let method = step["notification"]["method"].as_str().unwrap();
            let event = events.recv().await.unwrap();
            match (method, event) {
                ("item/commandExecution/requestApproval" | "item/fileChange/requestApproval", ProviderEvent::ApprovalRequested { provider_session_id, turn_id, .. }) => {
                    assert_eq!(provider_session_id, "thread-u041");
                    assert_eq!(turn_id.as_deref(), Some("turn-u041"));
                }
                ("turn/started", ProviderEvent::TurnStarted { provider_session_id, turn_id, .. }) => {
                    assert_eq!(provider_session_id, "thread-u041");
                    assert_eq!(turn_id, "turn-u041");
                }
                ("item/agentMessage/delta", ProviderEvent::AgentMessageDelta { provider_session_id, turn_id, item_id, delta }) => {
                    deltas.push(json!({"sessionId":SESSION,"providerSessionId":provider_session_id,"turnId":turn_id,"itemId":item_id,"delta":delta}));
                }
                ("item/started" | "item/completed", ProviderEvent::TimelineItem { provider_session_id, item }) => {
                    timeline.push(json!({"sessionId":SESSION,"providerSessionId":provider_session_id,"item":item}));
                    // The real transport emits timeline first, then the owner event.
                    // Validate both so an unrelated event cannot satisfy the barrier.
                    let event = events.recv().await.unwrap();
                    match event {
                        ProviderEvent::ToolActivity { provider_session_id, turn_id, running, .. } => {
                            assert_eq!(provider_session_id, "thread-u041");
                            assert_eq!(turn_id.as_deref(), Some("turn-u041"));
                            assert_eq!(running, method == "item/started");
                        }
                        ProviderEvent::AgentMessageCompleted { provider_session_id, turn_id, item_id, text, .. } => {
                            assert_eq!(provider_session_id, "thread-u041");
                            assert_eq!(turn_id, "turn-u041");
                            assert_eq!(item_id, "answer-u041");
                            assert_eq!(text, "Hello 世界");
                        }
                        event => panic!("unexpected item owner event {event:?}"),
                    }
                }
                ("turn/completed", ProviderEvent::TurnCompleted { provider_session_id, turn_id, .. }) => {
                    assert_eq!(provider_session_id, "thread-u041");
                    assert_eq!(turn_id.as_deref(), Some("turn-u041"));
                }
                (_, event) => panic!("unexpected {method} event {event:?}"),
            }
            loop {
                // This current-thread test has no competing owner mutation. Yield to
                // the real registration task, then gate on its observable state.
                tokio::task::yield_now().await;
                let current = project(&runtime.get(SESSION).unwrap(), &mut identities);
                let state_ready = step["wait"].as_object().is_none_or(|fields| fields.iter().all(|(k,v)| current[k] == *v));
                let deltas_ready = step["deltas"].as_u64().is_none_or(|n| deltas.len() == n as usize);
                let timeline_ready = step["timeline"].as_u64().is_none_or(|n| timeline.len() == n as usize);
                if state_ready && deltas_ready && timeline_ready { break; }
            }
        }).await.unwrap_or_else(|_| panic!("{} barrier state {}", step["name"], project(&runtime.get(SESSION).unwrap(), &mut identities)));
        if let Some((id, clock)) = previous_completion {
            let session = runtime.get(SESSION).unwrap();
            let turn = session
                .turns
                .as_deref()
                .unwrap()
                .iter()
                .find(|turn| turn["id"] == id)
                .unwrap();
            assert_eq!(
                turn["completedAt"], clock,
                "late completion preserves committed time"
            );
        }
        checkpoints.push(capture(
            step["name"].as_str().unwrap(),
            &runtime,
            &mut identities,
            &deltas,
            &timeline,
        ));
    }
    let restored = project(
        &AiSessionRuntime::new("test", Some(persistence))
            .get(SESSION)
            .unwrap(),
        &mut identities,
    );
    client.stop().await;
    drop(send);
    server.await.unwrap();
    let requests = requests.lock().unwrap().clone();
    let transport = transport.lock().unwrap().clone();
    let mut result = json!({"action":action,"rejection":rejection,"requests":requests,"checkpoints":checkpoints,"restored":restored,"transport":transport});
    if scenario["controls"] == true {
        result["responses"] = json!(responses.lock().unwrap().clone());
        result["outcomes"] = json!(outcomes);
    }
    result
}
async fn run_fixture(fixture: Value, id: &str) {
    let scenario = fixture["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap();
    let actual = observe(scenario).await;
    std::fs::write(
        format!(
            "/tmp/ci-{}-{id}-rust.json",
            if scenario["controls"] == true {
                "u042"
            } else {
                "u041"
            }
        ),
        serde_json::to_vec_pretty(&actual).unwrap(),
    )
    .unwrap();
    // Transport discovery caching/null cursor is private connection strategy.
    // Keep raw transport observations above; compare RPC action and complete owner trace.
    assert_eq!(actual["transport"][0], scenario["expected"]["transport"][0]);
    let mut actual = actual;
    actual.as_object_mut().unwrap().remove("transport");
    let mut expected = scenario["expected"].clone();
    expected.as_object_mut().unwrap().remove("transport");
    assert_eq!(actual, expected, "{id}");
}
async fn run(id: &str) {
    run_fixture(fixture(), id).await;
}
async fn run_control(id: &str) {
    run_fixture(
        serde_json::from_str(include_str!("../tests/fixtures/codex-control-parity.json")).unwrap(),
        id,
    )
    .await;
}
#[tokio::test]
async fn codex_ws_control_allow_steer_interrupt() {
    run_control("C01-allow-steer-interrupt").await;
}
#[tokio::test]
async fn codex_ws_control_deny_failure() {
    run_control("C02-deny-failure").await;
}
#[tokio::test]
async fn codex_ws_control_skip_file() {
    run_control("C03-skip-file").await;
}
#[tokio::test]
async fn codex_ws_control_mismatch_recovery() {
    run_control("C04-mismatch-recovery").await;
}
#[tokio::test]
async fn codex_ws_control_interrupt_retry() {
    run_control("C05-interrupt-retry").await;
}
#[tokio::test]
async fn codex_ws_success_matches_node() {
    run("C01-success").await;
}
#[tokio::test]
async fn codex_ws_rejected_send_retry_matches_node() {
    run("C02-reject-retry").await;
}
#[tokio::test]
async fn codex_ws_failed_active_tool_matches_node() {
    run("C03-failed-with-tool").await;
}

async fn run_early(id: &str) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/codex-early-ack-parity.json"
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
        format!("/tmp/ci-u044-{id}-rust.json"),
        serde_json::to_vec_pretty(&actual).unwrap(),
    )
    .unwrap();
    let mut actual = actual;
    actual.as_object_mut().unwrap().remove("transport");
    let mut expected = scenario["expected"].clone();
    expected.as_object_mut().unwrap().remove("transport");
    assert_eq!(actual, expected, "{id}");
}
#[tokio::test]
async fn codex_early_started_delta() {
    run_early("C01-started-delta").await;
}
#[tokio::test]
async fn codex_early_completed() {
    run_early("C02-completed").await;
}
#[tokio::test]
async fn codex_early_approval() {
    run_early("C03-approval").await;
}
#[tokio::test]
async fn codex_early_failed() {
    run_early("C04-failed").await;
}
#[tokio::test]
async fn codex_early_rejected() {
    run_early("C05-rejected").await;
}
