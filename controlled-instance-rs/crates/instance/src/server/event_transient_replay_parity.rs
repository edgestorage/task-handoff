use super::*;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

type Client = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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

fn project_replay(event: &Value) -> Value {
    let payload = &event["payload"];
    let item = &payload["item"];
    let field = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(ToString::to_string);
    json!({
        "type": event["type"],
        "replay": event["replay"] == true,
        "instanceId": field(payload, "instanceId"),
        "sessionId": field(payload, "sessionId"),
        "itemId": field(item, "id").or_else(|| field(payload, "itemId")),
        "turnId": field(item, "turnId").or_else(|| field(payload, "turnId")),
        "status": field(item, "status"),
        "summary": field(item, "summary"),
        "delta": field(payload, "delta"),
        "field": field(payload, "field"),
    })
}

async fn observe_rust_transient_replay(scenario: &Value) -> Value {
    let (state, _root) = test_state();
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind events route");
    let address = listener.local_addr().expect("events route address");
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let (mut client, _) = tokio_tungstenite::connect_async(format!(
        "ws://{address}/api/events?aiSessionTransient=1"
    ))
    .await
    .expect("events upgrade");

    let hello = next_event(&mut client).await;
    assert_eq!(hello["type"], "streams.hello");
    for event in scenario["publish"].as_array().expect("publish events") {
        state.events.publish(
            event["type"].as_str().expect("event type"),
            event["payload"].clone(),
        );
    }
    let subscribe = json!({
        "v": 1,
        "type": "subscribe",
        "topics": scenario["subscribe"]["topics"],
        "aiSessionTransient": scenario["subscribe"]["aiSessionTransient"],
    });
    client
        .send(TungsteniteMessage::Text(subscribe.to_string().into()))
        .await
        .expect("send subscribe");
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    state.events.publish(
        "ai-session.replay-barrier",
        json!({"scenario": scenario["name"]}),
    );

    let mut replayed = Vec::new();
    loop {
        let event = next_event(&mut client).await;
        if event["type"] == "ai-session.replay-barrier" {
            break;
        }
        if event["replay"] == true {
            replayed.push(project_replay(&event));
        }
    }
    drop(client);
    task.abort();
    json!({ "replayed": replayed })
}

#[tokio::test]
async fn event_transient_replay_matches_shared_node_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/event-transient-replay-parity.json"
    ))
    .expect("transient replay fixture");
    for scenario in fixture["scenarios"].as_array().expect("scenarios") {
        let expected = &scenario["expected"];
        let actual = observe_rust_transient_replay(scenario).await;
        assert_eq!(
            &actual,
            expected,
            "{}: expected {expected}, got {actual}",
            scenario["name"].as_str().unwrap_or_default()
        );
    }
}
