use super::authority_parity::AuthorityClient;
use super::*;
use controlled_instance_protocol::EventEnvelope;

fn expected(name: &str) -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/app-session-bootstrap-parity.json"
    ))
    .expect("Node wire golden");
    fixture["expected"][name].clone()
}

fn publish(state: &AppState, title: &str) -> EventEnvelope<Value> {
    let mut record = app_session_record("app_bootstrap", "terminal-tty", "running");
    record.title = title.to_string();
    state.app_runtime.insert_session(record);
    state
        .publish_app_session_snapshot(if title == "Initial title" {
            "app-session-created"
        } else {
            "app-session-updated"
        })
        .expect("changed")
}

struct Projection {
    stream_id: String,
    instance_id: String,
}

impl Projection {
    fn normalize(&self, value: &mut Value) {
        match value {
            Value::Array(values) => values.iter_mut().for_each(|value| self.normalize(value)),
            Value::Object(object) => {
                for (key, value) in object {
                    match key.as_str() {
                        "streamId" => {
                            assert_eq!(value, &self.stream_id);
                            *value = json!("<stream>");
                        }
                        "instanceId" => {
                            assert_eq!(value, &self.instance_id);
                            *value = json!("<instance>");
                        }
                        "traceId" => {
                            assert!(value.as_str().expect("trace").starts_with("aps_evt_"));
                            *value = json!("<trace>");
                        }
                        "lastEventAt" | "generatedAt" => {
                            chrono::DateTime::parse_from_rfc3339(value.as_str().expect("time"))
                                .expect("valid time");
                            *value = json!("<wall-clock>");
                        }
                        "updatedAt" if value != "2026-11-02T00:00:00.000Z" => {
                            chrono::DateTime::parse_from_rfc3339(value.as_str().expect("time"))
                                .expect("valid time");
                            *value = json!("<wall-clock>");
                        }
                        _ => self.normalize(value),
                    }
                }
            }
            _ => {}
        }
    }

    fn hello(&self, event: &Value) -> Value {
        assert_eq!(event["type"], "streams.hello");
        let app_stream = event["payload"]["streams"]
            .as_array()
            .expect("streams")
            .iter()
            .find(|stream| stream["topic"] == "app.sessions")
            .expect("app descriptor");
        json!({"protocolVersion": event["payload"]["protocolVersion"], "appStream": app_stream})
    }
}

async fn state_request(app: &Router) -> Value {
    let response = get_json(app, "/api/apps/sessions/state").await;
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await["data"].clone()
}

async fn observe_wire(rename_before_connect: bool) -> Value {
    let (state, _root) = test_state();
    publish(&state, "Initial title");
    let app = router(state.clone());
    let initial = state_request(&app).await;
    let projection = Projection {
        stream_id: initial["streamId"].as_str().expect("stream").to_string(),
        instance_id: state.config.instance_id.clone(),
    };
    if rename_before_connect {
        publish(&state, "Before connect");
    }
    let before = state_request(&app).await;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("own listener");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("own server");
    });
    struct ServerGuard(tokio::task::JoinHandle<()>);
    impl Drop for ServerGuard {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _server = ServerGuard(server);
    let mut client = AuthorityClient::connect(&base).await;
    let hello = client.next("").await;
    let ai_snapshot = client.next("").await;
    assert_eq!(ai_snapshot["type"], "ai-session.snapshot");
    let management = client.next("").await;
    assert_eq!(management["type"], "app.management");
    publish(&state, "After connect");
    let patch = client.next("app-session.patch").await;
    assert_eq!(patch["topic"], "app.sessions");
    assert_eq!(patch["v"], 1);
    let after = state_request(&router(state)).await;
    assert_eq!(
        after["lastEventAt"],
        patch["payload"]["meta"]["generatedAt"]
    );
    assert_eq!(
        after["snapshot"]["sessions"][0],
        patch["payload"]["session"]
    );
    let mut result = json!({"initial": initial, "before": before, "hello": projection.hello(&hello),
        "bootstrapTypes": [hello["type"], ai_snapshot["type"], management["type"]],
        "patch": {"type": patch["type"], "topic": patch["topic"], "payload": patch["payload"]}, "after": after});
    projection.normalize(&mut result);
    client.close().await;
    result
}

#[tokio::test]
async fn c01_app_http_hello_and_next_patch_match_node_wire() {
    assert_eq!(observe_wire(false).await, expected("normal"));
}

#[tokio::test]
async fn c02_app_changed_before_connect_matches_node_wire() {
    assert_eq!(observe_wire(true).await, expected("changedBeforeConnect"));
}

#[tokio::test]
async fn app_session_delta_queries_match_fastify_arrays() {
    let (state, _root) = test_state();
    publish(&state, "Initial title");
    publish(&state, "Renamed");
    let app = router(state.clone());
    let initial = state_request(&app).await;
    let projection = Projection {
        stream_id: initial["streamId"].as_str().expect("stream").to_string(),
        instance_id: state.config.instance_id.clone(),
    };
    let cases = [
        ("duplicateStream", "streamId=a&streamId=b&sinceRevision=1".to_string()),
        (
            "duplicateSince",
            "streamId=wrong&sinceRevision=1&sinceRevision=0".to_string(),
        ),
        ("fractional", "streamId=wrong&sinceRevision=1.5".to_string()),
        ("negative", "streamId=wrong&sinceRevision=-1".to_string()),
        ("nan", "streamId=wrong&sinceRevision=NaN".to_string()),
        ("infinity", "streamId=wrong&sinceRevision=Infinity".to_string()),
        ("emptySince", "streamId=wrong&sinceRevision=".to_string()),
        ("missingStream", "sinceRevision=1".to_string()),
        ("emptyStream", "streamId=&sinceRevision=1".to_string()),
        (
            "duplicateActual",
            format!(
                "streamId={0}&streamId={0}&sinceRevision=1",
                projection.stream_id
            ),
        ),
        ("hex", "streamId=wrong&sinceRevision=0x10".to_string()),
    ];
    let mut queries = serde_json::Map::new();
    for (name, query) in cases {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/apps/sessions?{query}"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("query response");
        let status = response.status();
        let body = body_json(response).await;
        let mut value = json!({
            "status": status.as_u16(),
            "body": body.get("data").cloned().unwrap_or(body),
        });
        projection.normalize(&mut value);
        queries.insert(name.to_string(), value);
    }
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/app-session-authority-parity.json"
    ))
    .expect("Node app authority golden");
    assert_eq!(Value::Object(queries), fixture["expected"]["resyncQueries"]);
}

#[tokio::test]
async fn c03_mutation_at_registration_cannot_fall_between_hello_and_live_stream() {
    let (state, _root) = test_state();
    publish(&state, "Initial title");
    // Execute a real mutation at the production connection-registration
    // boundary. A linearized connection must either advertise that revision
    // or receive its event. No missing-event timeout is used: revision 3 is a
    // fence that exposes a missing revision 2 immediately.
    let (mut receiver, bootstrap) =
        state.connect_event_stream_before_registration(true, false, || {
            publish(&state, "Before connect");
        });
    publish(&state, "After connect");
    let first_live = tokio::time::timeout(std::time::Duration::from_secs(3), receiver.recv())
        .await
        .expect("bounded first live event")
        .expect("live event");
    let descriptor = bootstrap[0].payload["streams"]
        .as_array()
        .expect("streams")
        .iter()
        .find(|stream| stream["topic"] == "app.sessions")
        .expect("app descriptor");
    let observation = json!({"helloRevision": descriptor["latestRevision"],
        "firstLiveRevision": first_live.payload["meta"]["revision"],
        "firstLivePrevious": first_live.payload["meta"]["previousRevision"]});
    let reference = expected("changedBeforeConnect");
    assert_eq!(
        observation,
        json!({"helloRevision": reference["hello"]["appStream"]["latestRevision"],
        "firstLiveRevision": reference["patch"]["payload"]["meta"]["revision"],
        "firstLivePrevious": reference["patch"]["payload"]["meta"]["previousRevision"]}),
        "connection lost the mutation between descriptor capture and registration"
    );
}

#[tokio::test]
async fn pending_runtime_change_cannot_relabel_the_published_http_snapshot() {
    let (state, _root) = test_state();
    publish(&state, "Initial title");
    // Runtime changes reach the Rust authority through an async service. Hold
    // that handoff pending: revision 1 must still name the published content,
    // then the eventual publication must advance it together with the patch.
    let mut pending = app_session_record("app_bootstrap", "terminal-tty", "running");
    pending.title = "Pending runtime".to_string();
    state.app_runtime.insert_session(pending);
    let app = router(state.clone());
    let pending_state = state_request(&app).await;
    assert_eq!(
        json!({"revision": pending_state["revision"], "title": pending_state["snapshot"]["sessions"][0]["title"]}),
        json!({"revision": 1, "title": "Initial title"}),
        "HTTP content must belong to its authority revision"
    );
    let event = state
        .publish_app_session_snapshot("app-session-updated")
        .expect("publish pending change");
    let published = state_request(&app).await;
    assert_eq!(published["revision"], 2);
    assert_eq!(
        published["snapshot"]["sessions"][0],
        event.payload["session"]
    );
    assert_eq!(
        published["snapshot"]["sessions"][0]["title"],
        "Pending runtime"
    );
}
