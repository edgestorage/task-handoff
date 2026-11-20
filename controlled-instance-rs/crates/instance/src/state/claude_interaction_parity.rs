use controlled_instance_ai_session::ProviderMessageInput;
use controlled_instance_core::{
    local_ipc::{bind, LocalIpcEndpoint},
    paths::StoragePaths,
};
use std::sync::atomic::AtomicUsize;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, Notify},
    time::timeout,
};
const SESSION: &str = "ses_0000000000001";
fn replace(value: Value, from: &str, to: &str) -> Value {
    match value {
        Value::String(s) if s == from => json!(to),
        Value::Array(v) => json!(v
            .into_iter()
            .map(|v| replace(v, from, to))
            .collect::<Vec<_>>()),
        Value::Object(v) => Value::Object(
            v.into_iter()
                .map(|(k, v)| (k, replace(v, from, to)))
                .collect(),
        ),
        v => v,
    }
}
fn project(session: &AiSession) -> Value {
    let raw = serde_json::to_value(session).unwrap();
    let mut result = serde_json::Map::new();
    for k in [
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
        "agent",
        "creationSource",
        "appId",
        "appSessionId",
        "appBindingKeys",
        "providerMeta",
        "actions",
    ] {
        result.insert(k.into(), raw[k].clone());
    }
    if let Some(tool) = result.get_mut("currentTool").and_then(Value::as_object_mut) {
        tool.remove("startedAt");
    }
    result.insert(
        "turns".into(),
        json!(session
            .turns
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|t| {
                let mut turn = serde_json::Map::new();
                for k in [
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
                    turn.insert(k.into(), t[k].clone());
                }
                if let Some(tool) = turn.get_mut("currentTool").and_then(Value::as_object_mut) {
                    tool.remove("startedAt");
                }
                turn.insert(
                    "userMessages".into(),
                    t.get("userMessages").cloned().unwrap_or_else(|| json!([])),
                );
                Value::Object(turn)
            })
            .collect::<Vec<_>>()),
    );
    Value::Object(result)
}
fn normalize(mut value: Value, cwd: &str, socket: &str) -> Value {
    fn scan(v: &Value, turns: &mut Vec<String>, messages: &mut Vec<String>) {
        if let Some(a) = v.as_array() {
            for v in a {
                scan(v, turns, messages);
            }
            return;
        }
        let Some(o) = v.as_object() else {
            return;
        };
        let mut add = |v: Option<&str>| {
            if let Some(v) = v.filter(|v| !v.starts_with("existing-")) {
                if !turns.iter().any(|x| x == v) {
                    turns.push(v.to_string());
                }
            }
        };
        add(v["activeTurnId"].as_str());
        for t in v["turns"].as_array().into_iter().flatten() {
            add(t["id"].as_str());
            for m in t["userMessages"].as_array().into_iter().flatten() {
                let id = m["id"].as_str().unwrap();
                if !id.starts_with("existing-") && !messages.iter().any(|m| m == id) {
                    messages.push(id.to_string());
                }
            }
        }
        for v in o.values() {
            scan(v, turns, messages);
        }
    }
    let (mut turns, mut messages) = (Vec::new(), Vec::new());
    scan(&value, &mut turns, &mut messages);
    for (i, id) in turns.iter().enumerate() {
        value = replace(value, id, &format!("$turn{}", i + 1));
    }
    for (i, id) in messages.iter().enumerate() {
        value = replace(value, id, &format!("$message{}", i + 1));
    }
    replace(replace(value, cwd, "/workspace"), socket, "/control.sock")
}
async fn observe(scenario: &Value) -> Value {
    let root = tempfile::Builder::new()
        .prefix("ci-u047-")
        .tempdir_in("/tmp")
        .unwrap();
    let data = root.path().join("data");
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let socket = root.path().join("c.sock");
    let cwd = workspace.to_str().unwrap();
    let sock = socket.to_str().unwrap();
    let paths = StoragePaths {
        config_path: data.join("config.json"),
        data_dir: data.clone(),
        app_catalog_dir: data.join("app-catalog"),
        app_sessions_dir: data.join("app-sessions"),
        triggers_dir: data.join("triggers"),
        runtime_dir: data.join("runtime"),
        events_dir: data.join("events"),
        artifact_dir: data.join("artifacts"),
        log_dir: data.join("logs"),
        web_token_path: data.join("web-token"),
    };
    let state = AppState::new(
        InstanceConfig::for_test(root.path().join("ui"), paths),
        WebAuthState::disabled(None),
    );
    let seed = replace(
        replace(scenario["seed"].clone(), "/workspace", cwd),
        "/control.sock",
        sock,
    );
    state
        .ai_sessions
        .save(serde_json::from_value(seed.clone()).unwrap())
        .unwrap();
    let job = json!({"short":"a1b2c3d4","sessionId":"provider-u047","cwd":cwd,"state":if seed["status"]=="running"{"running"}else{"idle"},"detail":if seed["status"]=="running"{json!("working")}else{Value::Null}});
    let endpoint = LocalIpcEndpoint::explicit(&socket).unwrap();
    endpoint.prepare().unwrap();
    let mut listener = bind(&endpoint).unwrap();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let counts = Arc::new(AtomicUsize::new(0));
    let connected = Arc::new(Notify::new());
    let (frames, receiver) = mpsc::unbounded_channel::<Vec<u8>>();
    let receiver = Arc::new(Mutex::new(Some(receiver)));
    let reject = scenario["rejectFirst"] == true;
    let server = tokio::spawn({
        let requests = requests.clone();
        let counts = counts.clone();
        let connected = connected.clone();
        async move {
            loop {
                let stream = listener.accept().await.unwrap();
                let requests = requests.clone();
                let counts = counts.clone();
                let connected = connected.clone();
                let receiver = receiver.clone();
                let job = job.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stream);
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    let request: Value = serde_json::from_str(line.trim()).unwrap();
                    assert_eq!(request["proto"], 1);
                    requests.lock().unwrap().push(request.clone());
                    let mut stream = reader.into_inner();
                    match request["op"].as_str().unwrap() {
                        "list" => stream
                            .write_all(format!("{}\n", json!({"ok":true,"jobs":[job]})).as_bytes())
                            .await
                            .unwrap(),
                        "subscribe" => {
                            assert_eq!(request["short"], "a1b2c3d4");
                            let mut receiver = receiver.lock().unwrap().take().unwrap();
                            connected.notify_one();
                            while let Some(frame) = receiver.recv().await {
                                if stream.write_all(&frame).await.is_err() {
                                    break;
                                }
                            }
                        }
                        "reply" => {
                            assert_eq!(request["short"], "a1b2c3d4");
                            let n = counts.fetch_add(1, Ordering::AcqRel);
                            let response = if reject && n == 0 {
                                json!({"ok":false,"code":"EBUSY","error":"fixture reply rejected"})
                            } else {
                                json!({"ok":true})
                            };
                            stream
                                .write_all(format!("{response}\n").as_bytes())
                                .await
                                .unwrap();
                        }
                        op => panic!("unexpected {op}"),
                    }
                });
            }
        }
    });
    let jobs = state
        .ai_session_claude
        .client()
        .list_jobs_at(&socket)
        .await
        .unwrap();
    let mut app = scenario["app"].clone();
    app["ai"] = json!({"claude":{"short":"a1b2c3d4","controlSock":sock}});
    app["launch"] = json!({"cwd":cwd});
    let refresh = crate::claude_discovery::refresh_claude_sessions_with_home(
        &state.ai_sessions,
        &jobs,
        &[serde_json::from_value(app).unwrap()],
        Some(root.path()),
    )
    .unwrap();
    let mut observations = state.claude_observations.subscribe();
    state.sync_claude_subscriptions(refresh.subscriptions).await;
    timeout(Duration::from_secs(5), connected.notified())
        .await
        .unwrap();
    let capture = |name: &str| json!({"name":name,"session":project(&state.ai_sessions.get(SESSION).unwrap())});
    let mut checkpoints = vec![capture("initial")];
    let mut results = Vec::new();
    let input = |id: &str| {
        ProviderMessageInput::from_wire(
            &serde_json::from_value(json!({"message":" Hello 世界 ","clientRequestId":id}))
                .unwrap(),
        )
    };
    if scenario["send"] == true {
        if reject {
            let before = state.ai_sessions.get(SESSION).unwrap();
            let error = state
                .ai_session_controller
                .send_message(SESSION, input("rejected-u047"))
                .await
                .unwrap_err();
            assert_eq!(
                before,
                state.ai_sessions.get(SESSION).unwrap(),
                "rejection preserves full owner"
            );
            results.push(json!({"name":"rejected","error":{"code":error.code,"message":error.message,"statusCode":error.status_code}}));
            checkpoints.push(capture("rejected"));
        }
        let ack = state
            .ai_session_controller
            .send_message(SESSION, input("accepted-u047"))
            .await
            .unwrap();
        results.push(json!({"name":"ack","provider":ack.provider,"action":ack.action.action,"turnId":ack.action.turn_id,"providerTurnId":ack.action.provider_turn_id,"session":project(&ack.session)}));
        checkpoints.push(capture("ack"));
    }
    for step in scenario["steps"].as_array().unwrap() {
        let before = state.ai_sessions.get(SESSION).unwrap();
        frames
            .send(format!("{}\r\n", step["message"]).into_bytes())
            .unwrap();
        let received = timeout(Duration::from_secs(5), observations.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            received, step["message"],
            "real registered consumer processed this frame"
        );
        if step["unchanged"] == true {
            assert_eq!(
                before,
                state.ai_sessions.get(SESSION).unwrap(),
                "diagnostic stream preserves full owner"
            );
        }
        checkpoints.push(capture(step["name"].as_str().unwrap()));
    }
    let reopened = AiSessionRuntime::new("test", Some(data.join("ai-sessions")))
        .get(SESSION)
        .unwrap();
    assert_eq!(
        reopened,
        state.ai_sessions.get(SESSION).unwrap(),
        "full owner reopens including clocks"
    );
    let actual = json!({"requests":requests.lock().unwrap().clone(),"results":results,"checkpoints":checkpoints,"restored":project(&reopened)});
    state.stop_ai_session_services().await;
    drop(frames);
    server.abort();
    let _ = server.await;
    normalize(actual, cwd, sock)
}
async fn compare(id: &str) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/claude-interaction-parity.json"
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
        format!("/tmp/ci-u047-{id}-rust.json"),
        serde_json::to_string_pretty(&actual).unwrap(),
    )
    .unwrap();
    assert_eq!(
        actual, scenario["expected"],
        "{id} real Claude control socket owner parity"
    );
}
#[tokio::test]
async fn accepted_pending() {
    compare("C01-accepted-pending").await;
}
#[tokio::test]
async fn rejected_retry() {
    compare("C02-rejected-retry").await;
}
#[tokio::test]
async fn responded_terminal() {
    compare("C03-responded-terminal").await;
}
#[tokio::test]
async fn lifecycle() {
    compare("C04-lifecycle").await;
}
