use super::*;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

type Client = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn seed_sessions(state: &AppState) {
    state
        .app_runtime
        .insert_session(app_session_record("aps_query_root", "codex", "running"));
    state
        .app_runtime
        .insert_session(app_session_record("aps_query_child", "codex", "running"));

    let mut root = ai_session_record("ses_query_root", "aps_query_root");
    root.provider_session_id = Some("provider-root".to_string());
    root.title = Some("Root session".to_string());
    root.lineage = None;
    state.ai_sessions.save(root).expect("root session");

    let mut child = ai_session_record("ses_query_child", "aps_query_child");
    child.provider_session_id = Some("provider-child".to_string());
    child.title = Some("Child session".to_string());
    child.lineage = Some(json!({
        "kind": "subagent",
        "parentProviderSessionId": "provider-root"
    }));
    state.ai_sessions.save(child).expect("child session");
}

async fn next_event(client: &mut Client) -> Value {
    let message = tokio::time::timeout(std::time::Duration::from_secs(3), client.next())
        .await
        .expect("event timeout")
        .expect("event stream ended")
        .expect("event frame");
    let TungsteniteMessage::Text(text) = message else {
        panic!("expected event text frame, got {message:?}");
    };
    serde_json::from_str(&text).expect("event json")
}

fn lineage_for(snapshot: Option<&Value>, provider_session_id: &str) -> Value {
    snapshot
        .and_then(|snapshot| snapshot["payload"]["snapshot"]["sessions"].as_array())
        .and_then(|sessions| {
            sessions
                .iter()
                .find(|session| session["providerSessionId"] == provider_session_id)
        })
        .and_then(|session| session.get("lineage"))
        .cloned()
        .unwrap_or(Value::Null)
}

async fn observe_rust_event_query(scenario: &Value) -> Value {
    let (state, _root) = test_state();
    seed_sessions(&state);
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind events route");
    let address = listener.local_addr().expect("events route address");
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let query = scenario["query"].as_str().expect("query");
    let suffix = if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    };
    let (mut client, _) = tokio_tungstenite::connect_async(format!(
        "ws://{address}/api/events{suffix}"
    ))
    .await
    .expect("events upgrade");

    let hello = next_event(&mut client).await;
    assert_eq!(hello["type"], "streams.hello");
    state.events.publish(
        "ai-session.message-delta",
        json!({
            "instanceId": "instance-query",
            "sessionId": "session-query",
            "providerSessionId": "provider-root",
            "turnId": "turn-query",
            "itemId": "item-query",
            "delta": "query-flag",
            "generatedAt": "2026-11-20T00:00:02.000Z"
        }),
    );
    state
        .events
        .publish("parity.query-barrier", json!({"scenario": scenario["name"]}));

    let mut snapshot = None;
    let mut transient_delta_delivered = false;
    loop {
        let event = next_event(&mut client).await;
        if event["type"] == "parity.query-barrier" {
            break;
        }
        if event["type"] == "ai-session.snapshot" {
            snapshot = Some(event);
        } else if event["type"] == "ai-session.message-delta" {
            transient_delta_delivered = true;
        }
    }
    let result = json!({
        "snapshotPresent": snapshot.is_some(),
        "rootLineage": lineage_for(snapshot.as_ref(), "provider-root"),
        "childLineage": lineage_for(snapshot.as_ref(), "provider-child"),
        "transientDeltaDelivered": transient_delta_delivered,
    });
    drop(client);
    task.abort();
    result
}

#[tokio::test]
async fn event_connection_query_flags_match_shared_node_fixtures() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/event-query-parity.json"
    ))
    .expect("event query fixture");
    for scenario in fixture["scenarios"].as_array().expect("scenarios") {
        let expected = &scenario["expected"];
        let actual = observe_rust_event_query(scenario).await;
        assert_eq!(
            &actual,
            expected,
            "{}: expected {expected}, got {actual}",
            scenario["name"].as_str().unwrap_or_default()
        );
    }
}
