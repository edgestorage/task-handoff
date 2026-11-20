use super::authority_parity::AuthorityClient;
use super::settings_apply_parity::{files, ReadOnlyDirectory};
use super::*;
use sha2::{Digest, Sha256};
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/attachment-authority-parity.json"
    ))
    .unwrap()
}
fn capture(state: &AppState, id: &str) -> Value {
    json!({"files":files(&state.config.storage_paths.data_dir),"rawTurns":state.ai_sessions.get(id).unwrap().turns})
}
async fn get(http: &reqwest::Client, base: &str, path: &str) -> Value {
    let response = http.get(format!("{base}{path}")).send().await.unwrap();
    json!({"status":response.status().as_u16(),"body":response.json::<Value>().await.unwrap()})
}
fn normalize(output: &mut Value, seed: &str, start: i64, end: i64) {
    let stream = output["initial"]["body"]["data"]["streamId"]
        .as_str()
        .unwrap()
        .to_string();
    let instance = output["bootstrap"]["payload"]["meta"]["instanceId"]
        .as_str()
        .unwrap()
        .to_string();
    let event1 = output["initial"]["body"]["data"]["lastEventAt"]
        .as_str()
        .unwrap()
        .to_string();
    let event2 = output["patch"]["payload"]["meta"]["generatedAt"]
        .as_str()
        .map(ToString::to_string);
    let mut traces = std::collections::BTreeMap::new();
    for key in ["bootstrap", "patch", "reconnect"] {
        if let Some(trace) = output[key]["payload"]["meta"]["traceId"].as_str() {
            let n = traces.len() + 1;
            traces.insert(trace.to_string(), format!("<trace-{n}>"));
        }
    }
    if let Some(event) = event2.as_deref() {
        assert_eq!(output["after"]["body"]["data"]["lastEventAt"], event);
    }
    for (key, marker) in [
        ("bootstrap", "<bootstrap-time>"),
        ("reconnect", "<reconnect-time>"),
    ] {
        let value = &mut output[key]["payload"]["meta"]["generatedAt"];
        let time = chrono::DateTime::parse_from_rfc3339(value.as_str().unwrap())
            .unwrap()
            .timestamp_millis();
        assert!(time >= start && time <= end);
        *value = json!(marker);
    }
    struct Clocks<'a> {
        stream: &'a str,
        instance: &'a str,
        seed: &'a str,
        event1: &'a str,
        event2: Option<&'a str>,
        start: i64,
        end: i64,
        traces: &'a std::collections::BTreeMap<String, String>,
        gc: Option<String>,
    }
    fn walk(value: &mut Value, clocks: &mut Clocks<'_>) {
        match value {
            Value::Array(values) => {
                for value in values {
                    walk(value, clocks)
                }
            }
            Value::Object(values) => {
                let snapshot = values.contains_key("sessions");
                for (key, value) in values {
                    if key == "streamId" {
                        assert_eq!(value, clocks.stream);
                        *value = json!("<stream>");
                    } else if key == "instanceId" {
                        assert_eq!(value, clocks.instance);
                        *value = json!("<instance>");
                    } else if key == "traceId" {
                        *value = json!(clocks.traces[value.as_str().unwrap()]);
                    } else if key == "generatedAt"
                        && matches!(
                            value.as_str(),
                            Some("<bootstrap-time>" | "<reconnect-time>")
                        )
                    {
                    } else if key == "generatedAt" || key == "lastEventAt" {
                        let time = value.as_str().unwrap();
                        let ms = chrono::DateTime::parse_from_rfc3339(time)
                            .unwrap()
                            .timestamp_millis();
                        assert!(ms >= clocks.start && ms <= clocks.end);
                        assert!(time == clocks.event1 || Some(time) == clocks.event2);
                        *value = json!(if Some(time) == clocks.event2 {
                            "<event-2>"
                        } else {
                            "<event-1>"
                        });
                    } else if key == "updatedAt" && snapshot {
                        let ms = chrono::DateTime::parse_from_rfc3339(value.as_str().unwrap())
                            .unwrap()
                            .timestamp_millis();
                        assert!(ms >= clocks.start && ms <= clocks.end);
                        *value = json!("<snapshot-time>");
                    } else if (key == "createdAt" || key == "committedAt")
                        && value.as_str() == Some(clocks.seed)
                    {
                        *value = json!("<seed-time>");
                    } else if key == "contentDeletedAt" {
                        let time = value.as_str().unwrap();
                        let ms = chrono::DateTime::parse_from_rfc3339(time)
                            .unwrap()
                            .timestamp_millis();
                        assert!(ms >= clocks.start && ms <= clocks.end);
                        if let Some(gc) = &clocks.gc {
                            assert_eq!(gc, time);
                        } else {
                            clocks.gc = Some(time.into());
                        }
                        *value = json!("<gc-time>");
                    } else {
                        walk(value, clocks)
                    }
                }
            }
            _ => {}
        }
    }
    walk(
        output,
        &mut Clocks {
            stream: &stream,
            instance: &instance,
            seed,
            event1: &event1,
            event2: event2.as_deref(),
            start,
            end,
            traces: &traces,
            gc: None,
        },
    );
}
async fn observe(name: &str) -> Value {
    let start = chrono::Utc::now().timestamp_millis();
    let seed = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let input = fixture()["input"][name].clone();
    let id = input["session"]["id"].as_str().unwrap();
    let (original, _root) = test_state_standalone();
    let config = (*original.config).clone();
    drop(original);
    let root = config.storage_paths.data_dir.clone();
    let attachment = &input["attachment"];
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
    state.start_ai_session_event_projection();
    state.publish_ai_session_snapshot("startup");
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = router(state.clone());
    struct Guard {
        task: tokio::task::JoinHandle<()>,
        state: AppState,
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            self.state.request_shutdown();
            self.task.abort();
        }
    }
    let _guard = Guard {
        task: tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        }),
        state: state.clone(),
    };
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap();
    let path = format!("/api/ai-sessions/{id}");
    let mut output = json!({"initial":get(&http,&base,"/api/ai-sessions/state").await,"initialIndex":get(&http,&base,&format!("{path}/turns?projection=index")).await,"initialBody":get(&http,&base,&format!("{path}/turns/turn-read")).await});
    let initial = output["initial"]["body"]["data"].clone();
    assert_eq!(initial["revision"], 1);
    let mut client = AuthorityClient::connect(&base).await;
    client.next("streams.hello").await;
    output["bootstrap"] = client.next("ai-session.snapshot").await;
    output["bootstrap"].as_object_mut().unwrap().remove("seq");
    let mut content_changes = state.ai_session_attachments.subscribe_content_changes();
    output["before"] = capture(&state, id);
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
    assert!(
        !content_changes.has_changed().unwrap(),
        "failed policy GC must not notify"
    );
    let conditional = format!(
        "{path}/turns?projection=index&revision={}",
        output["initialIndex"]["body"]["data"]["revision"]
            .as_str()
            .unwrap()
    );
    if name == "C02" {
        output["failure"] = get(&http, &base, &conditional).await;
        output["afterFailure"] = get(&http, &base, "/api/ai-sessions/state").await;
        output["failureDisk"] = capture(&state, id);
        output["computedFailure"] = serde_json::to_value(state.ai_sessions_snapshot()).unwrap();
    }
    assert!(
        !content_changes.has_changed().unwrap(),
        "failed read must not notify"
    );
    drop(guard);
    output["retry"] = get(&http, &base, &conditional).await;
    assert!(
        content_changes.has_changed().unwrap(),
        "durable expiry must notify"
    );
    content_changes.borrow_and_update();
    output["patch"] = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        client.next("ai-session.patch"),
    )
    .await
    .unwrap_or(Value::Null);
    if let Some(patch) = output["patch"].as_object_mut() {
        patch.remove("seq");
    }
    output["after"] = get(&http, &base, "/api/ai-sessions/state").await;
    output["computed"] = serde_json::to_value(state.ai_sessions_snapshot()).unwrap();
    output["freshIndex"] = get(&http, &base, &format!("{path}/turns?projection=index")).await;
    output["freshBody"] = get(&http, &base, &format!("{path}/turns/turn-read")).await;
    output["repeated"] = get(
        &http,
        &base,
        &format!(
            "{path}/turns?projection=index&revision={}",
            output["freshIndex"]["body"]["data"]["revision"]
                .as_str()
                .unwrap()
        ),
    )
    .await;
    assert!(
        !content_changes.has_changed().unwrap(),
        "unchanged reads must not notify"
    );
    output["afterRepeated"] = get(&http, &base, "/api/ai-sessions/state").await;
    output["afterDisk"] = capture(&state, id);
    output["delta"] = get(
        &http,
        &base,
        &format!(
            "/api/ai-sessions?streamId={}&sinceRevision=1",
            initial["streamId"].as_str().unwrap()
        ),
    )
    .await;
    client.close().await;
    let mut client = AuthorityClient::connect(&base).await;
    client.next("streams.hello").await;
    output["reconnect"] = client.next("ai-session.snapshot").await;
    output["reconnect"].as_object_mut().unwrap().remove("seq");
    client.close().await;
    // Envelope sequence is checked by AuthorityClient; unrelated management
    // frames can create different gaps across implementations.
    for key in ["bootstrap", "patch", "reconnect"] {
        if let Some(event) = output[key].as_object_mut() {
            event.retain(|key, _| key == "type" || key == "payload");
        }
    }
    normalize(
        &mut output,
        &seed,
        start,
        chrono::Utc::now().timestamp_millis(),
    );
    output
}
async fn compare(name: &str) {
    let actual = observe(name).await;
    let mut expected = fixture()["expected"][name].clone();
    // The TS cache consumes this exact HTTP/WS trace in the Node test. Its
    // derived observation is not a second Rust implementation of that cache.
    expected.as_object_mut().unwrap().remove("consumer");
    assert_eq!(
        actual, expected,
        "HTTP/WS authority, GC owner and revision contract"
    );
}
#[tokio::test]
async fn c01_latest_attachment_gc() {
    compare("C01").await;
}
#[tokio::test]
async fn c02_gc_failure_retry() {
    compare("C02").await;
}
#[tokio::test]
async fn c03_older_attachment_gc() {
    compare("C03").await;
}
