fn control_project(session: &AiSession) -> Value {
    let mut result = project(session);
    result["actions"] = session.actions.clone().unwrap_or(Value::Null);
    result
}
async fn observe_control(scenario: &Value) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let persistence = directory.path().join("sessions");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let cwd = workspace.to_str().unwrap().to_string();
    let runtime = Arc::new(AiSessionRuntime::new("test", Some(persistence.clone())));
    let mut seed = test_session();
    seed.agent = "opencode".to_string();
    seed.cwd = Some(cwd.clone());
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
    let mut initial = scenario["initial"].clone();
    initial["directory"] = json!(cwd);
    let peer_state = Peer {
        data: Arc::new(StdMutex::new(initial)),
        requests: Arc::new(StdMutex::new(Vec::new())),
        transport: Arc::new(StdMutex::new(Vec::new())),
        hold: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        release: Arc::new(Notify::new()),
        frames: Arc::new(StdMutex::new(Some(receiver))),
        connected: Arc::new(Notify::new()),
        reject_first: false,
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
    controller.register_provider(provider.clone());
    let mut changes = controller.subscribe_changes();
    provider.read_session(PROVIDER).await.unwrap();
    timeout(Duration::from_secs(5), peer_state.connected.notified())
        .await
        .unwrap();
    timeout(Duration::from_secs(5), async {
        while runtime.get(SESSION).unwrap().actions.is_none() {
            changes.recv().await.unwrap();
        }
    })
    .await
    .unwrap();
    provider.read_session(PROVIDER).await.unwrap();
    provider.owner_barrier().await;
    let mut checkpoints =
        vec![json!({"name":"initial","session":control_project(&runtime.get(SESSION).unwrap())})];
    let mut results = Vec::new();
    for step in scenario["steps"].as_array().unwrap() {
        if let Some(snapshot) = step.get("snapshot") {
            let mut data = peer_state.data.lock().unwrap();
            for (k, v) in snapshot.as_object().unwrap() {
                data[k] = v.clone();
            }
        }
        if let Some(event) = step.get("event") {
            peer_state
                .hold
                .store(false, std::sync::atomic::Ordering::Release);
            peer_state.release.notify_waiters();
            let event = replace(event.clone(), "/workspace", &cwd);
            frames
                .send(format!("data: {event}\r\n\r\n").into_bytes())
                .unwrap();
            timeout(Duration::from_secs(5), async {
                loop {
                    let current = control_project(&runtime.get(SESSION).unwrap());
                    if step["wait"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .all(|(k, v)| current[k] == *v)
                    {
                        break;
                    }
                    changes.recv().await.unwrap();
                }
            })
            .await
            .unwrap();
            checkpoints.push(json!({"name":step["name"],"session":control_project(&runtime.get(SESSION).unwrap())}));
            continue;
        }
        peer_state
            .hold
            .store(step["hold"] == true, std::sync::atomic::Ordering::Release);
        {
            let mut data = peer_state.data.lock().unwrap();
            data["failure"] = step["failure"].clone();
            data["post"] = step["post"].clone();
        }
        let before = runtime.get(SESSION).unwrap();
        let result = match step["action"].as_str().unwrap() {
            "steer" => {
                controller
                    .send_message(
                        SESSION,
                        ProviderMessageInput::from_wire(
                            &serde_json::from_value(
                                json!({"message":step["message"],"mode":"steer"}),
                            )
                            .unwrap(),
                        ),
                    )
                    .await
            }
            "interrupt" => controller.interrupt(SESSION).await,
            _ => {
                controller
                    .resolve_approval(SESSION, step["decision"].as_str().unwrap())
                    .await
            }
        };
        let result = match result {
            Ok(ack) => {
                json!({"name":step["name"],"provider":ack.provider,"action":ack.action.action,"turnId":ack.action.turn_id,"providerTurnId":ack.action.provider_turn_id,"decision":ack.action.decision,"session":control_project(&ack.session)})
            }
            Err(error) => {
                json!({"name":step["name"],"error":{"message":error.message,"statusCode":error.status_code,"code":json!(error.code)}})
            }
        };
        if step["unchanged"] == true {
            assert_eq!(
                runtime.get(SESSION).unwrap(),
                before,
                "{} preserves full owner",
                step["name"]
            );
        }
        results.push(result);
        checkpoints.push(
            json!({"name":step["name"],"session":control_project(&runtime.get(SESSION).unwrap())}),
        );
    }
    peer_state
        .hold
        .store(false, std::sync::atomic::Ordering::Release);
    peer_state.release.notify_waiters();
    provider.read_session(PROVIDER).await.unwrap();
    provider.owner_barrier().await;
    checkpoints
        .push(json!({"name":"reread","session":control_project(&runtime.get(SESSION).unwrap())}));
    let reopened = AiSessionRuntime::new("test", Some(persistence))
        .get(SESSION)
        .unwrap();
    assert_eq!(
        reopened,
        runtime.get(SESSION).unwrap(),
        "full owner reopens including clocks"
    );
    let requests = peer_state.requests.lock().unwrap().clone();
    let transport = peer_state.transport.lock().unwrap().clone();
    let mut actual = json!({"results":results,"checkpoints":checkpoints,"requests":requests,"transport":transport,"restored":control_project(&reopened)});
    let mut ids = std::collections::HashSet::new();
    for (i, request) in requests
        .iter()
        .filter(|r| r["path"].as_str().unwrap().ends_with("/prompt_async"))
        .enumerate()
    {
        let id = request["body"]["messageID"].as_str().unwrap();
        assert!(ids.insert(id));
        actual = replace(actual, id, &format!("$prompt{}", i + 1));
    }
    provider.close();
    drop(frames);
    server.abort();
    let _ = server.await;
    replace(actual, &cwd, "/workspace")
}
async fn compare_control(id: &str) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/opencode-control-parity.json"
    ))
    .unwrap();
    let scenario = fixture["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap();
    let actual = observe_control(scenario).await;
    std::fs::write(
        format!("/tmp/ci-u046-{id}-rust.json"),
        serde_json::to_string_pretty(&actual).unwrap(),
    )
    .unwrap();
    assert_eq!(
        actual, scenario["expected"],
        "{id} actual controls owner parity"
    );
}
#[tokio::test]
async fn steer() {
    compare_control("C01-steer").await;
}
#[tokio::test]
async fn interrupt() {
    compare_control("C02-interrupt").await;
}
#[tokio::test]
async fn allow() {
    compare_control("C03-allow").await;
}
#[tokio::test]
async fn deny() {
    compare_control("C04-deny").await;
}
#[tokio::test]
async fn unsupported_missing() {
    compare_control("C05-unsupported-missing").await;
}
#[tokio::test]
async fn post_read_failed() {
    compare_control("C06-post-read-failed").await;
}
