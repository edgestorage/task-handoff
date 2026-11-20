use super::settings_apply_parity::{files, ReadOnlyDirectory};
use super::*;
use sha2::{Digest, Sha256};
use std::io::Write;
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/attachment-background-gc-parity.json"
    ))
    .unwrap()
}
#[derive(Clone, Default)]
struct Logs(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
impl Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn capture(state: &AppState, id: &str) -> Value {
    let input = fixture()["input"]["attachment"].clone();
    json!({"files":files(&state.config.storage_paths.data_dir),"rawTurns":state.ai_sessions.get(id).unwrap().turns,
        "attachments":state.ai_session_attachments.project_message_attachments(id,"message-read",&[serde_json::from_value(input).unwrap()])})
}
async fn get(state: &AppState, path: &str) -> Value {
    let response = router(state.clone())
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    json!({"status":response.status().as_u16(),"body":body_json(response).await})
}
async fn snapshot(state: &AppState, id: &str) -> Value {
    json!({"state":get(state,"/api/ai-sessions/state").await,"disk":capture(state,id)})
}
async fn tick() {
    tokio::time::advance(std::time::Duration::from_secs(3600)).await;
    tokio::task::yield_now().await;
}
fn normalize(output: &mut Value, seed: &str, start: i64, end: i64, instance: &str) {
    let stream = output["initial"]["body"]["data"]["streamId"]
        .as_str()
        .unwrap()
        .to_string();
    let mut times = std::collections::BTreeMap::new();
    let mut traces = std::collections::BTreeMap::new();
    for event in output["events"].as_array().unwrap() {
        let meta = &event["payload"]["meta"];
        times.insert(
            meta["revision"].as_u64().unwrap(),
            meta["generatedAt"].as_str().unwrap().to_string(),
        );
        traces.insert(
            meta["traceId"].as_str().unwrap().to_string(),
            format!("<trace-{}>", traces.len() + 1),
        );
    }
    struct Context<'a> {
        stream: &'a str,
        instance: &'a str,
        seed: &'a str,
        start: i64,
        end: i64,
        times: &'a std::collections::BTreeMap<u64, String>,
        traces: &'a std::collections::BTreeMap<String, String>,
        gc: Option<String>,
    }
    fn walk(value: &mut Value, context: &mut Context<'_>) {
        match value {
            Value::Array(values) => {
                for value in values {
                    walk(value, context)
                }
            }
            Value::Object(values) => {
                let revision = values.get("revision").and_then(Value::as_u64);
                let snapshot = values.contains_key("sessions");
                for (key, value) in values {
                    if key == "streamId" {
                        assert_eq!(value, context.stream);
                        *value = json!("<stream>");
                    } else if key == "instanceId" {
                        assert_eq!(value, context.instance);
                        *value = json!("<instance>");
                    } else if key == "traceId" {
                        *value = json!(context.traces[value.as_str().unwrap()]);
                    } else if key == "generatedAt" || key == "lastEventAt" {
                        let time = value.as_str().unwrap();
                        let ms = chrono::DateTime::parse_from_rfc3339(time)
                            .unwrap()
                            .timestamp_millis();
                        assert!(ms >= context.start && ms <= context.end);
                        let revision = revision.unwrap();
                        assert_eq!(time, context.times[&revision]);
                        *value = json!(format!("<event-{revision}>"));
                    } else if key == "updatedAt" && snapshot {
                        let ms = chrono::DateTime::parse_from_rfc3339(value.as_str().unwrap())
                            .unwrap()
                            .timestamp_millis();
                        assert!(ms >= context.start && ms <= context.end);
                        *value = json!("<snapshot-time>");
                    } else if (key == "createdAt" || key == "committedAt")
                        && value.as_str() == Some(context.seed)
                    {
                        *value = json!("<seed-time>");
                    } else if key == "contentDeletedAt" {
                        let time = value.as_str().unwrap();
                        let ms = chrono::DateTime::parse_from_rfc3339(time)
                            .unwrap()
                            .timestamp_millis();
                        assert!(ms >= context.start && ms <= context.end);
                        if let Some(gc) = &context.gc {
                            assert_eq!(gc, time);
                        } else {
                            context.gc = Some(time.into());
                        }
                        *value = json!("<gc-time>");
                    } else {
                        walk(value, context)
                    }
                }
            }
            _ => {}
        }
    }
    walk(
        output,
        &mut Context {
            stream: &stream,
            instance,
            seed,
            start,
            end,
            times: &times,
            traces: &traces,
            gc: None,
        },
    );
}
async fn observe(name: &str) -> Value {
    let logs = Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let _subscriber = tracing::subscriber::set_default(subscriber);
    let start = chrono::Utc::now().timestamp_millis();
    let seed = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let input = fixture()["input"].clone();
    let id = input["session"]["id"].as_str().unwrap();
    let attachment = &input["attachment"];
    let (original, _root) = test_state_standalone();
    let config = (*original.config).clone();
    drop(original);
    let root = config.storage_paths.data_dir.clone();
    let hash = hex::encode(Sha256::digest(b"read bytes"));
    let manifest = json!({"schemaVersion":1,"id":attachment["id"],"inputId":"input-read","sessionId":id,"messageId":"message-read","turnId":"turn-read","kind":attachment["kind"],"name":attachment["name"],"mime":attachment["mime"],"size":attachment["size"],"blobHash":hash,"sourceType":"inline","state":"committed","createdAt":seed,"committedAt":seed});
    std::fs::write(
        root.join("ai-session-attachments/blobs").join(&hash),
        b"read bytes",
    )
    .unwrap();
    std::fs::write(
        root.join("ai-session-attachments/manifests")
            .join(format!("{}.json", attachment["id"].as_str().unwrap())),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let state = AppState::new(config, WebAuthState::disabled(None));
    state
        .ai_sessions
        .save(serde_json::from_value(input["session"].clone()).unwrap())
        .unwrap();
    struct Shutdown(AppState);
    impl Drop for Shutdown {
        fn drop(&mut self) {
            self.0.request_shutdown();
        }
    }
    let _shutdown = Shutdown(state.clone());
    let mut events = state.events.subscribe();
    state.start_ai_session_event_projection();
    state.publish_ai_session_snapshot("startup");
    tokio::task::yield_now().await;
    let mut output = json!({"intervalMs":3600000,"initial":get(&state,"/api/ai-sessions/state").await,"before":capture(&state,id)});
    if name == "C01" {
        tick().await;
        output["retained"] = snapshot(&state, id).await;
    }
    let guard = ReadOnlyDirectory::new(root.join("ai-session-attachments/manifests"));
    assert_eq!(
        state
            .ai_session_attachments
            .set_retention_days(0)
            .unwrap_err()
            .code,
        "AI_SESSION_ATTACHMENT_IO_FAILED"
    );
    assert_eq!(capture(&state, id), output["before"]);
    if name == "C02" {
        tick().await;
        output["failure"] = snapshot(&state, id).await;
        let bytes = logs.0.lock().unwrap();
        let text = String::from_utf8_lossy(&bytes);
        output["failureWarningCount"] = json!(text
            .matches("AI session attachment garbage collection failed; will retry.")
            .count());
    }
    drop(guard);
    if name == "C03" {
        // Poll clock advancement once to make the deadline ready, without
        // yielding to the GC task. Shutdown must win when both are ready.
        let advancement = tokio::time::advance(std::time::Duration::from_secs(3600));
        tokio::pin!(advancement);
        assert!(futures_util::poll!(advancement.as_mut()).is_pending());
        state.request_shutdown();
        output["closed"] = capture(&state, id);
        advancement.await;
        tokio::task::yield_now().await;
        output["afterQueued"] = capture(&state, id);
    } else {
        tick().await;
        output["expired"] = snapshot(&state, id).await;
        tick().await;
        output["repeated"] = snapshot(&state, id).await;
        let stream = output["initial"]["body"]["data"]["streamId"]
            .as_str()
            .unwrap();
        output["delta"] = get(
            &state,
            &format!("/api/ai-sessions?streamId={stream}&sinceRevision=1"),
        )
        .await;
        state.request_shutdown();
        tokio::task::yield_now().await;
        let before = capture(&state, id);
        tick().await;
        assert_eq!(capture(&state, id), before, "shutdown must stop GC");
    }
    let reopened = controlled_instance_ai_session::AiSessionConversationAttachmentStore::new(&root);
    output["reopened"] = json!({"files":files(&root),"attachments":reopened.attachments_for_message(id,"message-read")});
    let mut captured = Vec::new();
    while let Ok(event) = events.try_recv() {
        if event.r#type == "ai-session.snapshot" || event.r#type == "ai-session.patch" {
            captured.push(json!({"type":event.r#type,"payload":event.payload}));
        }
    }
    output["events"] = json!(captured);
    normalize(
        &mut output,
        &seed,
        start,
        chrono::Utc::now().timestamp_millis(),
        &state.config.instance_id,
    );
    output
}
async fn compare(name: &str) {
    let actual = observe(name).await;
    // Node records clearInterval identity. Rust proves cancellation by making
    // shutdown and a due expiry ready together in C03, then comparing disk/events.
    let mut expected = fixture()["expected"][name].clone();
    expected.as_object_mut().unwrap().remove("timerStopped");
    assert_eq!(
        actual, expected,
        "scheduled GC, durable owner, authority and close must match Node"
    );
}
#[tokio::test(start_paused = true)]
async fn c01_retention_expiry_repeat() {
    compare("C01").await;
}
#[tokio::test(start_paused = true)]
async fn c02_background_failure_retry() {
    compare("C02").await;
}
#[tokio::test(start_paused = true)]
async fn c03_shutdown_wins_ready_tick() {
    compare("C03").await;
}
