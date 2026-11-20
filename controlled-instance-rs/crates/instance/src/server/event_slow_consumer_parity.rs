use super::*;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

const EVENT_TYPE: &str = "parity.slow-consumer";
type Client = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn frame_payload(state: &AppState, frame_bytes: usize) -> Value {
    let probe = state.events.new_event(EVENT_TYPE, json!({"filler": ""}));
    let envelope_bytes = encode_event(&probe, false, false).len();
    let filler_bytes = frame_bytes
        .checked_sub(envelope_bytes)
        .expect("fixture frame is smaller than the event envelope");
    json!({"filler": "x".repeat(filler_bytes)})
}

async fn next_text(client: &mut Client) -> String {
    let message = tokio::time::timeout(std::time::Duration::from_secs(10), client.next())
        .await
        .expect("event frame timeout")
        .expect("event stream ended")
        .expect("event frame");
    let TungsteniteMessage::Text(text) = message else {
        panic!("expected event text frame, got {message:?}");
    };
    text.to_string()
}

async fn observe_rust_event_slow_consumer(scenario: &Value) -> Value {
    let frame_bytes = scenario["frameBytes"].as_u64().expect("frameBytes") as usize;
    let (state, _root) = test_state();
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind events route");
    let address = listener.local_addr().expect("events route address");
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{address}/api/events"))
        .await
        .expect("events upgrade");

    let hello: Value = serde_json::from_str(&next_text(&mut client).await).expect("hello json");
    assert_eq!(hello["type"], "streams.hello");
    for _ in 0..2 {
        let management: Value =
            serde_json::from_str(&next_text(&mut client).await).expect("management json");
        assert_eq!(management["type"], "app.management");
    }
    client
        .send(TungsteniteMessage::Text(
            r#"{"type":"subscribe","topics":["*"]}"#.into(),
        ))
        .await
        .expect("subscribe frame");

    let event = state
        .events
        .publish(EVENT_TYPE, frame_payload(&state, frame_bytes));
    let frame = encode_event(&event, false, false);
    assert_eq!(frame.len(), frame_bytes);

    let mut delivered = 0_u64;
    let mut delivered_bytes = 0_u64;
    let mut close = Value::Null;
    if frame_bytes <= MAX_EVENT_CLIENT_BUFFERED_BYTES {
        let text = next_text(&mut client).await;
        let parsed: Value = serde_json::from_str(&text).expect("event json");
        assert_eq!(parsed["type"], EVENT_TYPE);
        delivered = 1;
        delivered_bytes = text.len() as u64;
    } else {
        let closed = tokio::time::timeout(std::time::Duration::from_secs(10), client.next())
            .await
            .expect("slow consumer close timeout")
            .expect("slow consumer close frame")
            .expect("slow consumer close message");
        let TungsteniteMessage::Close(Some(frame)) = closed else {
            panic!("expected slow-consumer close frame, got {closed:?}");
        };
        close = json!({"code": u16::from(frame.code), "reason": frame.reason.to_string()});
    }

    let after_close_delivered = if scenario["expected"]["close"].is_null() {
        0
    } else {
        state
            .events
            .publish(EVENT_TYPE, json!({"marker": "after-close"}));
        let after_close =
            tokio::time::timeout(std::time::Duration::from_millis(250), client.next()).await;
        match after_close {
            Ok(Some(Ok(TungsteniteMessage::Text(_)))) => 1,
            Ok(Some(Ok(TungsteniteMessage::Close(_))) | None) | Err(_) => 0,
            Ok(Some(Ok(_))) => 0,
            Ok(Some(Err(_))) => 0,
        }
    };

    drop(client);
    task.abort();
    json!({
        "delivered": delivered,
        "deliveredBytes": delivered_bytes,
        "close": close,
        "afterCloseDelivered": after_close_delivered,
    })
}

#[tokio::test]
async fn event_slow_consumer_matches_shared_node_fixtures() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/event-slow-consumer-parity.json"
    ))
    .expect("event slow consumer fixture");
    for scenario in fixture["scenarios"].as_array().expect("scenarios") {
        let expected = &scenario["expected"];
        let actual = observe_rust_event_slow_consumer(scenario).await;
        assert_eq!(
            &actual,
            expected,
            "{}: expected {expected}, got {actual}",
            scenario["name"].as_str().unwrap_or_default()
        );
    }
}
