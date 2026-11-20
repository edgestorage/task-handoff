use super::*;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

const EVENT_TYPE: &str = "parity.socket-backpressure";

fn scenario() -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/event-socket-backpressure-parity.json"
    ))
    .expect("event socket backpressure fixture");
    fixture["scenario"].clone()
}

fn payload(scenario: &Value) -> Value {
    json!({"filler": "x".repeat(
        scenario["payloadBytes"].as_u64().expect("payloadBytes") as usize
    )})
}

fn observe(result: Value, scenario: &Value) -> Value {
    let expected = &scenario["expected"];
    assert_eq!(result["close"], expected["close"]);
    assert!(
        result["deliveredFrames"].as_u64().expect("deliveredFrames")
            >= expected["deliveredFramesAtLeast"]
                .as_u64()
                .expect("deliveredFramesAtLeast")
    );
    if expected["deliveredFramesBelowFrameCount"] == true {
        assert!(
            result["deliveredFrames"].as_u64().expect("deliveredFrames")
                < scenario["frameCount"].as_u64().expect("frameCount")
        );
    }
    assert!(
        result["deliveredPayloadBytes"]
            .as_u64()
            .expect("deliveredPayloadBytes")
            <= expected["deliveredPayloadBytesAtMost"]
                .as_u64()
                .expect("deliveredPayloadBytesAtMost")
    );
    assert_eq!(result["afterCloseDelivered"], expected["afterCloseDelivered"]);
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn event_socket_backpressure_matches_shared_node_fixture() {
    let scenario = scenario();
    let (state, _root) = test_state();
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind events route");
    let address = listener.local_addr().expect("events route address");
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let (mut client, _) =
        tokio_tungstenite::connect_async(format!("ws://{address}/api/events"))
            .await
            .expect("events upgrade");

    let hello: Value = serde_json::from_str(
        &match tokio::time::timeout(std::time::Duration::from_secs(10), client.next())
            .await
            .expect("hello timeout")
            .expect("hello message")
            .expect("hello frame")
        {
            TungsteniteMessage::Text(text) => text.to_string(),
            message => panic!("expected hello text frame, got {message:?}"),
        },
    )
    .expect("hello json");
    assert_eq!(hello["type"], "streams.hello");
    for _ in 0..2 {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), client.next())
            .await
            .expect("management timeout")
            .expect("management message")
            .expect("management frame");
        let TungsteniteMessage::Text(text) = frame else {
            panic!("expected management text frame, got {frame:?}");
        };
        let management: Value = serde_json::from_str(&text).expect("management json");
        assert_eq!(management["type"], "app.management");
    }
    client
        .send(TungsteniteMessage::Text(
            r#"{"type":"subscribe","topics":["*"]}"#.into(),
        ))
        .await
        .expect("subscribe frame");

    let payload = payload(&scenario);
    for _ in 0..scenario["frameCount"].as_u64().expect("frameCount") {
        state.events.publish(EVENT_TYPE, payload.clone());
    }
    tokio::time::sleep(std::time::Duration::from_millis(
        scenario["pauseMs"].as_u64().expect("pauseMs"),
    ))
    .await;

    let mut delivered_frames = 0_u64;
    let mut delivered_payload_bytes = 0_u64;
    let mut close = Value::Null;
    let deadline = std::time::Duration::from_secs(10);
    loop {
        let Some(message) = tokio::time::timeout(deadline, client.next())
            .await
            .expect("backpressure close timeout")
        else {
            break;
        };
        match message.expect("backpressure frame") {
            TungsteniteMessage::Text(text) => {
                let parsed: Value = serde_json::from_str(&text).expect("event json");
                if parsed["type"] == EVENT_TYPE {
                    delivered_frames += 1;
                    delivered_payload_bytes += text.len() as u64;
                }
            }
            TungsteniteMessage::Close(Some(frame)) => {
                close = json!({
                    "code": u16::from(frame.code),
                    "reason": frame.reason.to_string(),
                });
                break;
            }
            TungsteniteMessage::Close(None) => break,
            _ => {}
        }
    }

    state
        .events
        .publish(EVENT_TYPE, json!({"marker": "after-close"}));
    let after_close_delivered =
        match tokio::time::timeout(std::time::Duration::from_millis(250), client.next()).await {
            Ok(Some(Ok(TungsteniteMessage::Text(_)))) => 1,
            _ => 0,
        };

    drop(client);
    task.abort();
    observe(
        json!({
            "deliveredFrames": delivered_frames,
            "deliveredPayloadBytes": delivered_payload_bytes,
            "close": close,
            "afterCloseDelivered": after_close_delivered,
        }),
        &scenario,
    );
}
