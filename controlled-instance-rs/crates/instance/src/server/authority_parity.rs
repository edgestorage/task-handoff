use super::*;

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub(super) struct AuthorityClient {
    socket: Client,
    previous_seq: u64,
}

impl AuthorityClient {
    pub(super) async fn connect(base: &str) -> Self {
        let (socket, _) = tokio_tungstenite::connect_async(format!(
            "{}/api/events?aiSessionAuthoritySnapshot=1",
            base.replacen("http:", "ws:", 1)
        ))
        .await
        .expect("connect own events server");
        Self {
            socket,
            previous_seq: 0,
        }
    }

    pub(super) async fn next(&mut self, event_type: &str) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let frame = self.socket.next().await.expect("event").expect("frame");
                if let tokio_tungstenite::tungstenite::Message::Text(text) = frame {
                    let event: Value = serde_json::from_str(&text).expect("event JSON");
                    let seq = event["seq"].as_u64().expect("sequence");
                    assert!(seq > self.previous_seq, "wire sequence must increase");
                    self.previous_seq = seq;
                    if event_type.is_empty() || event["type"] == event_type {
                        return event;
                    }
                }
            }
        })
        .await
        .expect("bounded event delivery")
    }

    pub(super) async fn close(mut self) {
        self.socket.close(None).await.expect("close own websocket");
    }
}

struct Projection {
    stream_id: String,
    instance_id: String,
}

impl Projection {
    // Same explicit contract projection as the Node harness: exact authority
    // revisions and links; IDs mapped bijectively, time checked relationally.
    fn session(&self, session: &Value) -> Value {
        assert_eq!(session["id"], "ses_authority");
        assert_eq!(session["providerSessionId"], "provider-authority");
        let mut value = json!({"id": "<session>", "providerSessionId": session["providerSessionId"],
            "title": session["title"], "status": session["status"], "unread": session["unread"]});
        if let Some(story_id) = session.get("storyId") {
            value["storyId"] = story_id.clone();
        }
        value
    }

    fn snapshot(&self, snapshot: &Value) -> Value {
        json!({"runningCount": snapshot["runningCount"], "waitingCount": snapshot["waitingCount"],
            "staleCount": snapshot["staleCount"], "sessions": snapshot["sessions"].as_array().expect("sessions")
                .iter().map(|session| self.session(session)).collect::<Vec<_>>()})
    }

    fn state(&self, state: &Value) -> Value {
        assert_eq!(state["streamId"], self.stream_id);
        json!({"streamId": "<stream>", "revision": state["revision"], "snapshot": self.snapshot(&state["snapshot"])})
    }

    fn event(&self, event: &Value) -> Value {
        let payload = &event["payload"];
        let meta = &payload["meta"];
        assert_eq!(meta["streamId"], self.stream_id);
        assert_eq!(meta["instanceId"], self.instance_id);
        chrono::DateTime::parse_from_rfc3339(meta["generatedAt"].as_str().expect("event time"))
            .expect("valid time");
        let mut normalized_meta =
            json!({"streamId": "<stream>", "revision": meta["revision"], "reason": meta["reason"]});
        if let Some(previous) = meta.get("previousRevision") {
            normalized_meta["previousRevision"] = previous.clone();
        }
        let mut normalized_payload = json!({"meta": normalized_meta});
        if let Some(snapshot) = payload.get("snapshot") {
            normalized_payload["snapshot"] = self.snapshot(snapshot);
        } else {
            normalized_payload["upserted"] = json!(payload["upserted"]
                .as_array()
                .expect("upserted")
                .iter()
                .map(|session| self.session(session))
                .collect::<Vec<_>>());
            assert_eq!(payload["removed"], json!([]));
            normalized_payload["removed"] = json!([]);
        }
        json!({"type": event["type"], "payload": normalized_payload})
    }

    fn delta(&self, delta: &Value) -> Value {
        assert_eq!(delta["streamId"], self.stream_id);
        assert_eq!(delta["instanceId"], self.instance_id);
        json!({"streamId": "<stream>", "sinceRevision": delta["sinceRevision"], "latestRevision": delta["latestRevision"],
            "earliestRetainedRevision": delta["earliestRetainedRevision"], "syncRequired": delta["syncRequired"],
            "events": delta["events"].as_array().expect("events").iter().map(|event| self.event(event)).collect::<Vec<_>>()})
    }

    fn resync(&self, status: StatusCode, body: &Value) -> Value {
        let body = match body.get("data") {
            Some(data) if data.get("events").is_some() => self.delta(data),
            Some(data) => self.state(data),
            None => body.clone(),
        };
        json!({"status": status.as_u16(), "body": body})
    }
}

async fn request_status(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = if let Some(body) = body {
        let method = if path.ends_with("/story") {
            reqwest::Method::PUT
        } else {
            reqwest::Method::POST
        };
        client.request(method, format!("{base}{path}")).json(&body)
    } else {
        client.get(format!("{base}{path}"))
    };
    let response = request.send().await.expect("own HTTP server");
    let status = response.status();
    let bytes = response.bytes().await.expect("HTTP body");
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, body)
}

async fn request(client: &reqwest::Client, base: &str, path: &str, body: Option<Value>) -> Value {
    let (status, body) = request_status(client, base, path, body).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["data"].clone()
}

#[tokio::test]
async fn http_ws_authority_reconnect_matches_node_golden() {
    let (state, _root) = test_state();
    state.ai_sessions.save(serde_json::from_value(json!({
        "id": "ses_authority", "agent": "codex", "creationSource": "ai-session",
        "providerSessionId": "provider-authority", "title": "Initial title", "status": "idle", "phase": "unknown",
        "unread": false, "startedAt": "2026-11-02T00:00:00.000Z", "updatedAt": "2026-11-02T00:00:00.000Z"
    })).expect("session")).expect("seed store");
    state
        .publish_ai_session_snapshot("startup")
        .expect("initial authority publish");
    let p = Projection {
        stream_id: state.ai_session_stream_info().0,
        instance_id: state.config.instance_id.clone(),
    };
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("own listener");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("own server");
    });
    // Dropping the guard also aborts the server if an assertion unwinds.
    struct ServerGuard(tokio::task::JoinHandle<()>);
    impl Drop for ServerGuard {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _server = ServerGuard(task);
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .expect("HTTP client");
    request(
        &http,
        &base,
        "/api/ai-sessions/ses_authority/read",
        Some(json!({})),
    )
    .await;
    let initial = request(&http, &base, "/api/ai-sessions", None).await;
    let mut client = AuthorityClient::connect(&base).await;
    let hello = client.next("streams.hello").await;
    let descriptor = hello["payload"]["streams"]
        .as_array()
        .expect("streams")
        .iter()
        .find(|stream| stream["topic"] == "ai.sessions")
        .expect("AI stream");
    assert_eq!(descriptor["streamId"], p.stream_id);
    assert_eq!(descriptor["latestRevision"], initial["revision"]);
    let bootstrap = client.next("ai-session.snapshot").await;
    assert_eq!(
        p.event(&bootstrap)["payload"]["snapshot"],
        p.state(&initial)["snapshot"]
    );
    request(
        &http,
        &base,
        "/api/ai-sessions/ses_authority/story",
        Some(json!({"storyId": "story-one"})),
    )
    .await;
    let patch = client.next("ai-session.patch").await;
    let after = request(&http, &base, "/api/ai-sessions/state", None).await;
    assert_eq!(
        after["lastEventAt"],
        patch["payload"]["meta"]["generatedAt"]
    );
    request(
        &http,
        &base,
        "/api/ai-sessions/ses_authority/read",
        Some(json!({})),
    )
    .await;
    let unchanged = request(&http, &base, "/api/ai-sessions", None).await;
    assert_eq!(unchanged, after);
    client.close().await;
    request(
        &http,
        &base,
        "/api/ai-sessions/ses_authority/story",
        Some(json!({"storyId": "story-offline"})),
    )
    .await;
    let recovered = request(&http, &base, "/api/ai-sessions/state", None).await;
    let mut client = AuthorityClient::connect(&base).await;
    let hello = client.next("streams.hello").await;
    assert_eq!(
        hello["payload"]["streams"][0]["latestRevision"],
        recovered["revision"]
    );
    let reconnect = client.next("ai-session.snapshot").await;
    assert_eq!(
        p.event(&reconnect)["payload"]["snapshot"],
        p.state(&recovered)["snapshot"]
    );
    request(
        &http,
        &base,
        "/api/ai-sessions/ses_authority/story",
        Some(json!({"storyId": "story-after-reconnect"})),
    )
    .await;
    let next = client.next("ai-session.patch").await;
    let latest = request(&http, &base, "/api/ai-sessions", None).await;
    assert_eq!(
        latest["lastEventAt"],
        next["payload"]["meta"]["generatedAt"]
    );
    let delta = |revision: u64, stream: &str| {
        format!("/api/ai-sessions?streamId={stream}&sinceRevision={revision}")
    };
    let missed = request(&http, &base, &delta(2, &p.stream_id), None).await;
    assert_eq!(missed["events"][1]["payload"], next["payload"]);
    assert_eq!(
        p.event(&missed["events"][0])["payload"]["upserted"],
        p.state(&recovered)["snapshot"]["sessions"]
    );
    let actual = json!({"initial": p.state(&initial), "bootstrap": p.event(&bootstrap), "patch": p.event(&patch),
        "after": p.state(&after), "unchanged": p.state(&unchanged), "recovered": p.state(&recovered),
        "reconnect": p.event(&reconnect), "next": p.event(&next), "latest": p.state(&latest), "missed": p.delta(&missed),
        "current": p.delta(&request(&http, &base, &delta(4, &p.stream_id), None).await),
        "wrongStream": p.delta(&request(&http, &base, &delta(2, "wrong-stream"), None).await),
        "future": p.delta(&request(&http, &base, &delta(5, &p.stream_id), None).await)});
    let mut resync_queries = serde_json::Map::new();
    for (name, query) in [
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
                p.stream_id
            ),
        ),
        ("hex", "streamId=wrong&sinceRevision=0x10".to_string()),
    ] {
        let (status, body) = request_status(
            &http,
            &base,
            &format!("/api/ai-sessions?{query}"),
            None,
        )
        .await;
        resync_queries.insert(name.to_string(), p.resync(status, &body));
    }
    let mut actual = actual;
    actual["resyncQueries"] = Value::Object(resync_queries);
    let mut state_queries = serde_json::Map::new();
    for (name, query) in [
        ("current", ""),
        ("subagents", "?hierarchy=subagents"),
        (
            "duplicateHierarchy",
            "?hierarchy=subagents&hierarchy=subagents",
        ),
        ("caseSensitive", "?hierarchy=SUBAGENTS"),
    ] {
        let (status, body) = request_status(
            &http,
            &base,
            &format!("/api/ai-sessions/state{query}"),
            None,
        )
        .await;
        state_queries.insert(name.to_string(), p.resync(status, &body));
    }
    actual["stateQueries"] = Value::Object(state_queries);
    client.close().await;
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/ai-session-authority-parity.json"
    ))
    .expect("Node golden");
    let mut expected = fixture["expected"].clone();
    expected
        .as_object_mut()
        .expect("observation")
        .remove("expired");
    assert_eq!(actual, expected, "C01-C04: exact Node authority contract");
}
