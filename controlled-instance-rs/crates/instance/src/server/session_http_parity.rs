use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone)]
struct SessionHttpProvider {
    calls: Arc<Mutex<Vec<Value>>>,
    fail_start: bool,
    fail_steer: bool,
}

#[async_trait::async_trait]
impl controlled_instance_ai_session::AiSessionControlProvider for SessionHttpProvider {
    fn agent(&self) -> &str {
        "codex"
    }

    fn capability(&self) -> AiSessionProviderCapability {
        AiSessionProviderCapability {
            agent: "codex".to_string(),
            actions: AiSessionProviderActions {
                create: true,
                send: true,
                queue: true,
                steer: true,
                ..AiSessionProviderActions::default()
            },
            permission_modes: Vec::new(),
            timeline: AiSessionProviderTimelineCapabilities::default(),
            model_selection: None,
            reasoning_effort: None,
            hierarchy: None,
        }
    }

    async fn create_session(
        &self,
        input: controlled_instance_ai_session::ProviderCreateInput,
    ) -> Result<
        controlled_instance_ai_session::ProviderCreateResult,
        controlled_instance_ai_session::ProviderError,
    > {
        let mut calls = self.calls.lock().unwrap();
        let creates = calls
            .iter()
            .filter(|call| call["action"] == "create")
            .count()
            + 1;
        calls.push(json!({"action": "create", "cwd": input.cwd}));
        Ok(controlled_instance_ai_session::ProviderCreateResult {
            provider_session_id: format!("provider-http-{creates}"),
            cwd: input.cwd,
            model_selection: None,
            reasoning_effort: None,
        })
    }

    async fn start_message(
        &self,
        session: &AiSession,
        input: controlled_instance_ai_session::ProviderMessage,
    ) -> Result<
        controlled_instance_ai_session::ProviderAction,
        controlled_instance_ai_session::ProviderError,
    > {
        let mut calls = self.calls.lock().unwrap();
        let starts = calls
            .iter()
            .filter(|call| call["action"] == "start")
            .count()
            + 1;
        calls.push(json!({
            "action": "start",
            "sessionId": session.id,
            "message": input.message,
        }));
        drop(calls);
        if self.fail_start {
            return Err(controlled_instance_ai_session::ProviderError::new(
                "PROVIDER_START_REJECTED",
                "provider start rejected",
                502,
            ));
        }
        let turn_id = format!("turn-http-{starts}");
        Ok(controlled_instance_ai_session::ProviderAction {
            action: "send".to_string(),
            turn_id: Some(turn_id.clone()),
            provider_turn_id: Some(turn_id),
            decision: None,
            queue_id: None,
            completion_text: None,
        })
    }

    async fn steer_message(
        &self,
        session: &AiSession,
        input: controlled_instance_ai_session::ProviderMessage,
    ) -> Result<
        controlled_instance_ai_session::ProviderAction,
        controlled_instance_ai_session::ProviderError,
    > {
        self.calls.lock().unwrap().push(json!({
            "action": "steer",
            "sessionId": session.id,
            "message": input.message,
        }));
        if self.fail_steer {
            return Err(controlled_instance_ai_session::ProviderError::new(
                "PROVIDER_STEER_REJECTED",
                "provider steer rejected",
                502,
            ));
        }
        Ok(controlled_instance_ai_session::ProviderAction {
            action: "steer".to_string(),
            turn_id: Some("turn-steer-active".to_string()),
            provider_turn_id: Some("turn-steer-active".to_string()),
            decision: None,
            queue_id: None,
            completion_text: None,
        })
    }

    async fn delete_session(
        &self,
        provider_session_id: &str,
    ) -> Result<(), controlled_instance_ai_session::ProviderError> {
        self.calls.lock().unwrap().push(json!({
            "action": "delete",
            "providerSessionId": provider_session_id,
        }));
        Ok(())
    }

    async fn unsubscribe_session(
        &self,
        provider_session_id: &str,
    ) -> Result<(), controlled_instance_ai_session::ProviderError> {
        self.calls.lock().unwrap().push(json!({
            "action": "unsubscribe",
            "providerSessionId": provider_session_id,
        }));
        Ok(())
    }
}

async fn request_json(
    app: &Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, body)
}

fn response_body(status: StatusCode, body: Value) -> Value {
    json!({"status": status.as_u16(), "body": body})
}

fn project_state(status: StatusCode, body: &Value) -> Value {
    let data = &body["data"];
    let mut response = json!({
        "status": status.as_u16(),
        "body": {"data": {
            "streamId": data["streamId"],
            "revision": data["revision"],
            "lastEventAt": data["lastEventAt"],
            "snapshot": {
                "runningCount": data["snapshot"]["runningCount"],
                "waitingCount": data["snapshot"]["waitingCount"],
                "staleCount": data["snapshot"]["staleCount"],
                "updatedAt": data["snapshot"]["updatedAt"],
            },
        }},
    });
    let sessions = data["snapshot"]["sessions"]
        .as_array()
        .expect("state sessions")
        .iter()
        .map(|session| {
            let mut projected = serde_json::Map::new();
            for key in [
                "id",
                "creationSource",
                "providerSessionId",
                "cwd",
                "cwdFolderId",
                "status",
                "phase",
                "activeTurnId",
                "userPrompt",
                "unread",
                "queue",
            ] {
                if let Some(value) = session.get(key) {
                    projected.insert(key.to_string(), value.clone());
                }
            }
            Value::Object(projected)
        })
        .collect::<Vec<_>>();
    response["body"]["data"]["snapshot"]["sessions"] = json!(sessions);
    response
}

async fn state_response(app: &Router) -> Value {
    let (status, body) = request_json(app, Method::GET, "/api/ai-sessions/state", None).await;
    project_state(status, &body)
}

fn project_detail(status: StatusCode, body: &Value) -> Value {
    if body.get("error").is_some() {
        return response_body(status, body.clone());
    }
    let detail = &body["data"]["detail"];
    let mut projected = serde_json::Map::new();
    projected.insert("kind".to_string(), body["data"]["kind"].clone());
    let mut detail_projected = serde_json::Map::new();
    for key in [
        "id",
        "appBindingKeys",
        "cwd",
        "error",
        "providerMeta",
        "queue",
        "subAgents",
    ] {
        if let Some(value) = detail.get(key) {
            detail_projected.insert(key.to_string(), value.clone());
        }
    }
    projected.insert("detail".to_string(), Value::Object(detail_projected));
    response_body(status, json!({"data": Value::Object(projected)}))
}

async fn detail_response(app: &Router, id: &str) -> Value {
    let (status, body) = request_json(
        app,
        Method::GET,
        &format!("/api/ai-sessions/{id}"),
        None,
    )
    .await;
    project_detail(status, &body)
}

fn project_persisted_sessions(sessions: Vec<AiSession>) -> Value {
    json!(sessions
        .into_iter()
        .map(|session| {
            json!({
                "id": session.id,
                "providerSessionId": session.provider_session_id,
                "creationSource": session.creation_source,
                "status": session.status,
                "phase": session.phase,
                "activeTurnId": session.active_turn_id,
                "turns": session.turns.unwrap_or_default().into_iter().map(|turn| json!({
                    "id": turn["id"],
                    "providerTurnId": turn.get("providerTurnId").cloned().unwrap_or(Value::Null),
                    "status": turn["status"],
                    "phase": turn["phase"],
                    "userPrompt": turn.get("userPrompt").cloned().unwrap_or(Value::Null),
                    "userMessages": turn.get("userMessages").and_then(Value::as_array).map(|messages| messages.iter().map(|message| json!({
                        "id": message["id"],
                        "text": message["text"],
                    })).collect::<Vec<_>>()).unwrap_or_default(),
                })).collect::<Vec<_>>(),
                "queue": session.queue,
            })
        })
        .collect::<Vec<_>>())
}

struct Normalizer {
    root: String,
    ids: HashMap<String, String>,
}

impl Normalizer {
    fn new(root: &std::path::Path) -> Self {
        Self {
            root: root.display().to_string(),
            ids: HashMap::new(),
        }
    }

    fn normalize(&mut self, value: Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(
                items
                    .into_iter()
                    .map(|item| self.normalize(item))
                    .collect(),
            ),
            Value::Object(object) => {
                let mut normalized = serde_json::Map::new();
                let object_has_provider_session = object.contains_key("providerSessionId");
                let object_has_turn_marker = object.contains_key("providerTurnId")
                    || object.contains_key("userMessages");
                let object_is_queue_item =
                    object.contains_key("message") && object.contains_key("createdAt");
                for (key, item) in object {
                    let value = if [
                        "id",
                        "sessionId",
                        "aiSessionId",
                        "queueId",
                        "messageId",
                        "turnId",
                        "streamId",
                    ]
                    .contains(&key.as_str())
                        && item.is_string()
                    {
                        let original = item.as_str().unwrap().to_string();
                        let kind = match key.as_str() {
                            "sessionId" | "aiSessionId" => "session",
                            "queueId" => "queue",
                            "messageId" => "message",
                            "turnId" => "turn",
                            "streamId" => "stream",
                            "id" if object_has_provider_session => "session",
                            "id" if object_has_turn_marker => "turn",
                            "id" if object_is_queue_item => "queue",
                            _ => "id",
                        };
                        let identity = format!("{kind}:{original}");
                        let next = format!(
                            "<{kind}-{}>",
                            self.ids
                                .keys()
                                .filter(|candidate| candidate.starts_with(&format!("{kind}:")))
                                .count()
                                + 1
                        );
                        Value::String(
                            self.ids
                                .entry(identity)
                                .or_insert(next)
                                .clone(),
                        )
                    } else {
                        self.normalize(item)
                    };
                    normalized.insert(key, value);
                }
                Value::Object(normalized)
            }
            Value::String(value) => {
                if value == self.root || value.starts_with(&format!("{}{}", self.root, std::path::MAIN_SEPARATOR)) {
                    return Value::String(format!(
                        "<root>{}",
                        &value[self.root.len()..]
                    ));
                }
                if chrono::DateTime::parse_from_rfc3339(&value).is_ok() && value.ends_with('Z') {
                    return Value::String("<time>".to_string());
                }
                Value::String(value)
            }
            other => other,
        }
    }
}

fn seed_session(value: Value) -> AiSession {
    serde_json::from_value(value).expect("seeded AI session")
}

async fn observe_create(root: &std::path::Path, fail_start: bool) -> Value {
    let (state, _temp) = test_state();
    let persistence_dir = state.config.storage_paths.data_dir.join("ai-sessions");
    let calls = Arc::new(Mutex::new(Vec::new()));
    state.ai_session_controller.register_provider(Arc::new(SessionHttpProvider {
        calls: calls.clone(),
        fail_start,
        fail_steer: false,
    }));
    state.start_ai_session_services();
    state.publish_ai_session_snapshot("startup");
    let app = router(state.clone());
    let state_before = state_response(&app).await;
    let cwd = root.display().to_string();
    let payload = json!({
        "agent": "codex",
        "cwd": {"type": "runtime-path", "path": cwd},
        "cwdFolderId": "folder-session-http",
        "message": if fail_start { "Fail during materialization" } else { "Start over HTTP" },
        "clientRequestId": if fail_start { "request-create-failure-http" } else { "request-create-http" },
    });
    let (status, body) = request_json(&app, Method::POST, "/api/ai-sessions", Some(payload.clone())).await;
    let created = response_body(status, body);
    let state_after_create = state_response(&app).await;
    if fail_start {
        let state_response = state_response(&app).await;
        let persisted = project_persisted_sessions(state.ai_sessions.list());
        let reopened = project_persisted_sessions(
            controlled_instance_ai_session::AiSessionRuntime::new(
                "session-http-reopened",
                Some(persistence_dir.clone()),
            )
            .list(),
        );
        return json!({
            "stateBefore": state_before,
            "created": created,
            "state": state_response,
            "persisted": persisted,
            "reopened": reopened,
            "calls": calls.lock().unwrap().clone(),
        });
    }
    let (status, body) = request_json(&app, Method::POST, "/api/ai-sessions", Some(payload)).await;
    let replayed = response_body(status, body);
    let authoritative_state = state_response(&app).await;
    let persisted = project_persisted_sessions(state.ai_sessions.list());
    let reopened = project_persisted_sessions(
        controlled_instance_ai_session::AiSessionRuntime::new(
            "session-http-reopened",
            Some(persistence_dir.clone()),
        )
        .list(),
    );
    json!({
        "stateBefore": state_before,
        "created": created,
        "stateAfterCreate": state_after_create,
        "replayed": replayed,
        "state": authoritative_state,
        "persisted": persisted,
        "reopened": reopened,
        "calls": calls.lock().unwrap().clone(),
    })
}

async fn observe_send(root: &std::path::Path) -> Value {
    let (state, _temp) = test_state();
    let persistence_dir = state.config.storage_paths.data_dir.join("ai-sessions");
    let calls = Arc::new(Mutex::new(Vec::new()));
    state.ai_session_controller.register_provider(Arc::new(SessionHttpProvider {
        calls: calls.clone(),
        fail_start: false,
        fail_steer: false,
    }));
    let session = seed_session(json!({
        "id": "ses_0000000000101",
        "agent": "codex",
        "creationSource": "ai-session",
        "providerSessionId": "provider-send-http",
        "cwd": root,
        "status": "idle",
        "phase": "unknown",
        "startedAt": "2026-11-20T00:00:00.000Z",
        "updatedAt": "2026-11-20T00:00:00.000Z",
        "unread": false,
    }));
    state.ai_sessions.save(session.clone()).expect("seed send session");
    state.start_ai_session_services();
    state.publish_ai_session_snapshot("startup");
    let app = router(state.clone());
    let state_before = state_response(&app).await;
    let (status, body) = request_json(
        &app,
        Method::POST,
        &format!("/api/ai-sessions/{}/messages", session.id),
        Some(json!({"message": "Send over HTTP", "clientRequestId": "request-send-http"})),
    )
    .await;
    let sent = response_body(status, body);
    let detail = detail_response(&app, &session.id).await;
    let authoritative_state = state_response(&app).await;
    let persisted = project_persisted_sessions(state.ai_sessions.list());
    let reopened = project_persisted_sessions(
        controlled_instance_ai_session::AiSessionRuntime::new(
            "session-http-reopened",
            Some(persistence_dir),
        )
        .list(),
    );
    let (missing_status, missing_body) = request_json(
        &app,
        Method::POST,
        "/api/ai-sessions/ais_missing/messages",
        Some(json!({"message": "Missing session"})),
    )
    .await;
    json!({
        "stateBefore": state_before,
        "sent": sent,
        "detail": detail,
        "state": authoritative_state,
        "persisted": persisted,
        "reopened": reopened,
        "missing": response_body(missing_status, missing_body),
        "calls": calls.lock().unwrap().clone(),
    })
}

async fn observe_read(root: &std::path::Path) -> Value {
    let (state, _temp) = test_state();
    let session = seed_session(json!({
        "id": "ses_0000000000102",
        "agent": "codex",
        "creationSource": "ai-session",
        "providerSessionId": "provider-read-http",
        "cwd": root,
        "status": "idle",
        "phase": "responding",
        "startedAt": "2026-11-20T00:00:00.000Z",
        "updatedAt": "2026-11-20T00:00:00.000Z",
        "unread": true,
    }));
    state.ai_sessions.save(session.clone()).expect("seed read session");
    state.start_ai_session_services();
    state.publish_ai_session_snapshot("startup");
    let app = router(state.clone());
    let state_before = state_response(&app).await;
    let before = state.ai_sessions.get(&session.id).unwrap();
    let (first_status, first_body) = request_json(
        &app,
        Method::POST,
        &format!("/api/ai-sessions/{}/read", session.id),
        None,
    )
    .await;
    let after_first = state.ai_sessions.get(&session.id).unwrap();
    let (second_status, second_body) = request_json(
        &app,
        Method::POST,
        &format!("/api/ai-sessions/{}/read", session.id),
        None,
    )
    .await;
    let after_second = state.ai_sessions.get(&session.id).unwrap();
    let (missing_status, missing_body) = request_json(
        &app,
        Method::POST,
        "/api/ai-sessions/ais_missing/read",
        None,
    )
    .await;
    let (unread_first_status, unread_first_body) = request_json(
        &app,
        Method::POST,
        &format!("/api/ai-sessions/{}/unread", session.id),
        None,
    )
    .await;
    let after_unread_first = state.ai_sessions.get(&session.id).unwrap();
    let (unread_second_status, unread_second_body) = request_json(
        &app,
        Method::POST,
        &format!("/api/ai-sessions/{}/unread", session.id),
        None,
    )
    .await;
    let after_unread_second = state.ai_sessions.get(&session.id).unwrap();
    let (missing_unread_status, missing_unread_body) = request_json(
        &app,
        Method::POST,
        "/api/ai-sessions/ais_missing/unread",
        None,
    )
    .await;
    json!({
        "stateBefore": state_before,
        "first": response_body(first_status, first_body),
        "second": response_body(second_status, second_body),
        "missing": response_body(missing_status, missing_body),
        "unreadFirst": response_body(unread_first_status, unread_first_body),
        "unreadSecond": response_body(unread_second_status, unread_second_body),
        "missingUnread": response_body(missing_unread_status, missing_unread_body),
        "unread": [
            before.unread,
            after_first.unread,
            after_second.unread,
            after_unread_first.unread,
            after_unread_second.unread,
        ],
        "updatedAtPreserved": [
            after_first.updated_at == before.updated_at,
            after_second.updated_at == after_first.updated_at,
            after_unread_first.updated_at == after_second.updated_at,
            after_unread_second.updated_at == after_unread_first.updated_at,
        ],
        "state": state_response(&app).await,
    })
}

async fn observe_read_query_fallbacks(root: &std::path::Path) -> Value {
    let (state, _temp) = test_state();
    let transcript_path = root.join("transcript.jsonl");
    std::fs::write(&transcript_path, "first\nsecond\nthird").expect("transcript");
    let session = seed_session(json!({
        "id": "ses_0000000000104",
        "agent": "codex",
        "creationSource": "ai-session",
        "providerSessionId": "provider-read-query-http",
        "cwd": root,
        "status": "running",
        "phase": "thinking",
        "activeTurnId": "turn-read-query",
        "transcriptPath": transcript_path.display().to_string(),
        "userPrompt": "Read query fallback",
        "turns": [{
            "id": "turn-read-query",
            "providerTurnId": "turn-read-query",
            "status": "running",
            "phase": "thinking",
            "revision": 1,
            "source": "control",
            "sourcePriority": 90,
            "observedAt": "2026-11-20T00:00:00.000Z",
            "startedAt": "2026-11-20T00:00:00.000Z",
            "updatedAt": "2026-11-20T00:00:00.000Z",
            "userPrompt": "Read query fallback",
            "userMessages": [],
        }],
        "startedAt": "2026-11-20T00:00:00.000Z",
        "updatedAt": "2026-11-20T00:00:00.000Z",
        "unread": false,
    }));
    state.ai_sessions.save(session.clone()).expect("seed read query session");
    state.start_ai_session_services();
    state.publish_ai_session_snapshot("startup");
    let app = router(state);
    let state_before = state_response(&app).await;
    let (detail_status, detail_body) = request_json(
        &app,
        Method::GET,
        &format!("/api/ai-sessions/{}", session.id),
        None,
    )
    .await;
    assert_eq!(detail_status, StatusCode::OK, "{detail_body}");
    let detail_revision = detail_body["data"]["revision"]
        .as_str()
        .expect("detail revision")
        .to_string();
    let (turn_status, turn_body) = request_json(
        &app,
        Method::GET,
        &format!("/api/ai-sessions/{}/turns/turn-read-query", session.id),
        None,
    )
    .await;
    assert_eq!(turn_status, StatusCode::OK, "{turn_body}");
    let turn_revision = turn_body["data"]["revision"]
        .as_str()
        .expect("turn revision")
        .to_string();
    let (duplicate_detail_status, duplicate_detail_body) = request_json(
        &app,
        Method::GET,
        &format!(
            "/api/ai-sessions/{0}?revision={1}&revision={1}",
            session.id, detail_revision
        ),
        None,
    )
    .await;
    let (duplicate_turn_status, duplicate_turn_body) = request_json(
        &app,
        Method::GET,
        &format!(
            "/api/ai-sessions/{}/turns/turn-read-query?revision={1}&revision={1}",
            session.id, turn_revision
        ),
        None,
    )
    .await;
    let (transcript_status, transcript_body) = request_json(
        &app,
        Method::GET,
        &format!("/api/ai-sessions/{}/transcript?tail=1", session.id),
        None,
    )
    .await;
    let (duplicate_transcript_status, duplicate_transcript_body) = request_json(
        &app,
        Method::GET,
        &format!(
            "/api/ai-sessions/{}/transcript?tail=1&tail=1",
            session.id
        ),
        None,
    )
    .await;
    let label_revision = |value: Value, source: &str, label: &str| {
        serde_json::from_str::<Value>(&value.to_string().replace(source, label))
            .expect("labeled revision")
    };
    json!({
        "stateBefore": state_before,
        "detailRevision": "<detail-revision>",
        "duplicateDetailRevision": label_revision(
            response_body(duplicate_detail_status, duplicate_detail_body),
            &detail_revision,
            "<detail-revision>",
        ),
        "turnRevision": "<turn-revision>",
        "duplicateTurnRevision": label_revision(
            response_body(duplicate_turn_status, duplicate_turn_body),
            &turn_revision,
            "<turn-revision>",
        ),
        "turnsDuplicateProjection": get_response(
            &app,
            &format!(
                "/api/ai-sessions/{}/turns?projection=index&projection=index",
                session.id
            ),
        )
        .await,
        "turnsDuplicateAfterRevision": get_response(
            &app,
            &format!(
                "/api/ai-sessions/{}/turns?afterTurnId=turn-read-query&afterRevision=0&afterRevision=1",
                session.id
            ),
        )
        .await,
        "timelineDuplicateRevision": get_response(
            &app,
            "/api/ai-sessions/ais_missing/timeline?revision=a&revision=b",
        )
        .await,
        "turnTimelineDuplicateRevision": get_response(
            &app,
            "/api/ai-sessions/ais_missing/turns/turn-read-query/timeline?revision=a&revision=b",
        )
        .await,
        "transcript": response_body(transcript_status, transcript_body),
        "duplicateTranscriptTail": response_body(
            duplicate_transcript_status,
            duplicate_transcript_body,
        ),
    })
}

async fn get_response(app: &Router, uri: &str) -> Value {
    let (status, body) = request_json(app, Method::GET, uri, None).await;
    response_body(status, body)
}

async fn redirect_response(app: &Router, uri: &str) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(uri)
                .body(Body::empty())
                .expect("redirect request"),
        )
        .await
        .expect("redirect response");
    json!({
        "status": response.status().as_u16(),
        "location": response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok()),
    })
}

async fn observe_history_and_log_query_fallbacks(root: &std::path::Path) -> Value {
    let (state, _temp) = test_state();
    for (id, agent, title, minute) in [
        ("ai-query-codex", "codex", "Codex history", "00"),
        ("ai-query-claude", "claude", "Claude history", "01"),
    ] {
        let item = serde_json::from_value::<controlled_instance_protocol::AiSessionHistoryItem>(json!({
            "id": id,
            "agent": agent,
            "creationSource": "ai-session",
            "providerSessionId": format!("provider-{id}"),
            "title": title,
            "cwd": root,
            "lastActiveAt": format!("2026-11-20T00:{minute}:00.000Z"),
            "archivedAt": format!("2026-11-20T00:{minute}:00.000Z"),
        }))
        .expect("history item");
        state
            .ai_session_history
            .upsert(item, &[])
            .expect("history query fixture");
    }

    let app_session_id = "aps_query_logs";
    let log_dir = root.join("logs/app-sessions").join(app_session_id);
    std::fs::create_dir_all(&log_dir).expect("log dir");
    std::fs::write(log_dir.join("main.log"), "0123456789abcdef").expect("log file");
    let mut app_session = app_session_record(app_session_id, "terminal-tty", "running");
    app_session.workspace.cwd = root.display().to_string();
    app_session.paths.session_dir = root
        .join("sessions")
        .join(app_session_id)
        .display()
        .to_string();
    app_session.paths.log_dir = log_dir.display().to_string();
    state.app_runtime.insert_session(app_session);

    let app = router(state);
    let history_prefix = "/api/ai-sessions/history";
    let logs_prefix = format!("/api/apps/sessions/{app_session_id}/logs");
    json!({
        "history": {
            "default": get_response(&app, history_prefix).await,
            "codexOnly": get_response(&app, &format!("{history_prefix}?agents=codex")).await,
            "duplicateAgents": get_response(
                &app,
                &format!("{history_prefix}?agents=codex&agents=claude"),
            )
            .await,
            "duplicateHierarchy": get_response(
                &app,
                &format!("{history_prefix}?hierarchy=subagents&hierarchy=subagents"),
            )
            .await,
            "detailDuplicateHierarchy": get_response(
                &app,
                &format!("{history_prefix}/ai-query-codex?hierarchy=subagents&hierarchy=subagents"),
            )
            .await,
        },
        "logs": {
            "default": get_response(&app, &logs_prefix).await,
            "single": get_response(&app, &format!("{logs_prefix}?maxBytes=2048")).await,
            "duplicate": get_response(
                &app,
                &format!("{logs_prefix}?maxBytes=2048&maxBytes=4096"),
            )
            .await,
            "duplicateEmpty": get_response(
                &app,
                &format!("{logs_prefix}?maxBytes=&maxBytes="),
            )
            .await,
            "invalid": get_response(&app, &format!("{logs_prefix}?maxBytes=not-a-number")).await,
        },
    })
}

async fn observe_novnc_resize_query(root: &std::path::Path) -> Value {
    let (state, _temp) = test_state();
    let session_id = "aps_novnc_query";
    let mut app_session = app_session_record(session_id, "terminal-tty", "running");
    app_session.vnc = Some(controlled_instance_protocol::AppSessionVnc {
        backend: None,
        host: "127.0.0.1".to_string(),
        port: 6080,
        websockify_port: None,
        web_path: "/vnc/index.html".to_string(),
        no_vnc_path: root.join("missing-novnc").display().to_string(),
    });
    state.app_runtime.insert_session(app_session);
    let app = router(state);
    let prefix = format!("/api/apps/sessions/{session_id}/novnc/vnc.html");
    json!({
        "novnc": {
            "default": redirect_response(&app, &prefix).await,
            "remote": redirect_response(&app, &format!("{prefix}?resize=remote")).await,
            "duplicate": redirect_response(
                &app,
                &format!("{prefix}?resize=remote&resize=remote"),
            )
            .await,
            "duplicateMixed": redirect_response(
                &app,
                &format!("{prefix}?resize=remote&resize=scale"),
            )
            .await,
        },
    })
}

async fn observe_queue(root: &std::path::Path) -> Value {
    let (state, _temp) = test_state();
    let calls = Arc::new(Mutex::new(Vec::new()));
    state.ai_session_controller.register_provider(Arc::new(SessionHttpProvider {
        calls: calls.clone(),
        fail_start: false,
        fail_steer: false,
    }));
    let session = seed_session(json!({
        "id": "ses_0000000000103",
        "agent": "codex",
        "creationSource": "ai-session",
        "providerSessionId": "provider-queue-http",
        "cwd": root,
        "status": "running",
        "phase": "thinking",
        "activeTurnId": "turn-active",
        "startedAt": "2026-11-20T00:00:00.000Z",
        "updatedAt": "2026-11-20T00:00:00.000Z",
        "unread": false,
    }));
    state.ai_sessions.save(session.clone()).expect("seed queue session");
    state
        .ai_sessions
        .enqueue_message(&session.id, "Queued while paused", Vec::new(), Vec::new(), None, None)
        .expect("enqueue");
    state.start_ai_session_services();
    state.publish_ai_session_snapshot("startup");
    let app = router(state.clone());
    let state_before = state_response(&app).await;
    let queue_uri = format!("/api/ai-sessions/{}/queue", session.id);
    let (initial_status, initial_body) = request_json(&app, Method::GET, &queue_uri, None).await;
    let (pause_status, pause_body) = request_json(
        &app,
        Method::POST,
        &format!("/api/ai-sessions/{}/queue/pause", session.id),
        Some(json!({"paused": true})),
    )
    .await;
    let (paused_status, paused_body) = request_json(&app, Method::GET, &queue_uri, None).await;
    state
        .ai_sessions
        .update(&session.id, |session| {
            session.status = "idle".to_string();
            session.phase = "responding".to_string();
            session.active_turn_id = None;
            session.unread = true;
            Ok(true)
        })
        .expect("complete queue session");
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    let (completed_status, completed_body) = request_json(&app, Method::GET, &queue_uri, None).await;
    let sent_while_paused = calls
        .lock()
        .unwrap()
        .iter()
        .filter(|call| call["action"] == "start")
        .count();
    let (resume_status, resume_body) = request_json(
        &app,
        Method::POST,
        &format!("/api/ai-sessions/{}/queue/pause", session.id),
        Some(json!({"paused": false})),
    )
    .await;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline
        && calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call["action"] == "start")
            .count()
            != 1
    {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let (drained_status, drained_body) = request_json(&app, Method::GET, &queue_uri, None).await;
    let sent_messages = calls
        .lock()
        .unwrap()
        .iter()
        .filter(|call| call["action"] == "start")
        .map(|call| call["message"].clone())
        .collect::<Vec<_>>();
    let (missing_status, missing_body) = request_json(
        &app,
        Method::POST,
        "/api/ai-sessions/ais_missing/queue/pause",
        Some(json!({"paused": true})),
    )
    .await;
    json!({
        "stateBefore": state_before,
        "initialQueue": response_body(initial_status, initial_body),
        "paused": response_body(pause_status, pause_body),
        "pausedQueue": response_body(paused_status, paused_body),
        "completedQueue": response_body(completed_status, completed_body),
        "sentWhilePaused": sent_while_paused,
        "resumed": response_body(resume_status, resume_body),
        "drainedQueue": response_body(drained_status, drained_body),
        "sentMessages": sent_messages,
        "missing": response_body(missing_status, missing_body),
        "state": state_response(&app).await,
    })
}

async fn observe_queue_mutations(root: &std::path::Path) -> Value {
    let (state, _temp) = test_state();
    let persistence_dir = state.config.storage_paths.data_dir.join("ai-sessions");
    let session_id = "ses_0000000000100";
    let session: AiSession = serde_json::from_value(json!({
        "id": session_id,
        "agent": "codex",
        "creationSource": "ai-session",
        "providerSessionId": "provider-queue-mutations-http",
        "actions": {"interrupt": true},
        "activeTurnId": "turn-queue-mutations",
        "cwd": root.display().to_string(),
        "turns": [],
        "status": "running",
        "phase": "thinking",
        "toolCallsSinceLastMessage": 0,
        "subAgents": [],
        "startedAt": "2026-11-20T00:00:00.000Z",
        "updatedAt": "2026-11-20T00:00:00.000Z",
        "counters": {"toolCalls": 0, "edits": 0, "approvals": 0},
        "unread": false,
    }))
    .expect("queue mutation session");
    state.ai_sessions.save(session).expect("seed queue mutation session");
    let first = state
        .ai_sessions
        .enqueue_message(session_id, "first queued", Vec::new(), Vec::new(), None, None)
        .expect("enqueue first")
        .expect("first queued")
        .queue_id;
    let second = state
        .ai_sessions
        .enqueue_message(session_id, "second queued", Vec::new(), Vec::new(), None, None)
        .expect("enqueue second")
        .expect("second queued")
        .queue_id;
    let third = state
        .ai_sessions
        .enqueue_message(session_id, "third queued", Vec::new(), Vec::new(), None, None)
        .expect("enqueue third")
        .expect("third queued")
        .queue_id;
    state
        .ai_sessions
        .set_queue_item_status(session_id, &third, "failed", Some("temporary"))
        .expect("fail third queue item");
    state.start_ai_session_services();
    state.publish_ai_session_snapshot("startup");
    let app = router(state.clone());
    let state_before = state_response(&app).await;
    let queue_uri = format!("/api/ai-sessions/{session_id}/queue");
    let (initial_status, initial_body) = request_json(&app, Method::GET, &queue_uri, None).await;
    let initial_revision = state
        .ai_sessions
        .queue(session_id)
        .expect("initial queue")
        .revision;
    let (edit_status, edit_body) = request_json(
        &app,
        Method::PATCH,
        &format!("{queue_uri}/{second}"),
        Some(json!({"expectedRevision": initial_revision, "message": "edited second"})),
    )
    .await;
    let (stale_status, stale_body) = request_json(
        &app,
        Method::PATCH,
        &format!("{queue_uri}/{second}"),
        Some(json!({"expectedRevision": initial_revision, "message": "stale edit"})),
    )
    .await;
    let reorder_revision = state
        .ai_sessions
        .queue(session_id)
        .expect("queue after edit")
        .revision;
    let (reorder_status, reorder_body) = request_json(
        &app,
        Method::PATCH,
        &format!("{queue_uri}/reorder"),
        Some(json!({"expectedRevision": reorder_revision, "queueIds": [second.clone(), first.clone()]})),
    )
    .await;
    let (invalid_status, invalid_body) = request_json(
        &app,
        Method::PATCH,
        &format!("{queue_uri}/reorder"),
        Some(json!({
            "expectedRevision": state.ai_sessions.queue(session_id).expect("queue after reorder").revision,
            "queueIds": [second.clone(), second.clone()],
        })),
    )
    .await;
    let (failed_edit_status, failed_edit_body) = request_json(
        &app,
        Method::PATCH,
        &format!("{queue_uri}/{third}"),
        Some(json!({
            "expectedRevision": state.ai_sessions.queue(session_id).expect("queue before failed edit").revision,
            "message": "edit failed item",
        })),
    )
    .await;
    let (retry_status, retry_body) = request_json(
        &app,
        Method::POST,
        &format!("{queue_uri}/{third}/retry"),
        None,
    )
    .await;
    let (remove_status, remove_body) = request_json(
        &app,
        Method::DELETE,
        &format!("{queue_uri}/{first}"),
        None,
    )
    .await;
    let (missing_item_status, missing_item_body) = request_json(
        &app,
        Method::POST,
        &format!("{queue_uri}/queue-missing/retry"),
        None,
    )
    .await;
    let (missing_session_status, missing_session_body) = request_json(
        &app,
        Method::DELETE,
        "/api/ai-sessions/ais_missing/queue/queue-missing",
        None,
    )
    .await;
    let reopened = controlled_instance_ai_session::AiSessionRuntime::new(
        "session-http-reopened",
        Some(persistence_dir),
    );
    json!({
        "stateBefore": state_before,
        "initialQueue": response_body(initial_status, initial_body),
        "edited": response_body(edit_status, edit_body),
        "stale": response_body(stale_status, stale_body),
        "reordered": response_body(reorder_status, reorder_body),
        "invalid": response_body(invalid_status, invalid_body),
        "failedEdit": response_body(failed_edit_status, failed_edit_body),
        "retried": response_body(retry_status, retry_body),
        "removed": response_body(remove_status, remove_body),
        "missingItem": response_body(missing_item_status, missing_item_body),
        "missingSession": response_body(missing_session_status, missing_session_body),
        "state": state_response(&app).await,
        "persisted": project_persisted_sessions(state.ai_sessions.list()),
        "reopened": project_persisted_sessions(reopened.list()),
        "calls": [],
    })
}

async fn observe_queue_steer(root: &std::path::Path, fail_steer: bool) -> Value {
    let (state, _temp) = test_state();
    let persistence_dir = state.config.storage_paths.data_dir.join("ai-sessions");
    let calls = Arc::new(Mutex::new(Vec::new()));
    state.ai_session_controller.register_provider(Arc::new(SessionHttpProvider {
        calls: calls.clone(),
        fail_start: false,
        fail_steer,
    }));
    let session_id = "ses_0000000000102";
    let session = seed_session(json!({
        "id": session_id,
        "agent": "codex",
        "creationSource": "ai-session",
        "providerSessionId": "provider-queue-steer-http",
        "cwd": root,
        "status": "running",
        "phase": "thinking",
        "activeTurnId": "turn-steer-active",
        "userPrompt": "Initial steer target",
        "turns": [{
            "id": "turn-steer-active",
            "providerTurnId": "turn-steer-active",
            "status": "running",
            "phase": "thinking",
            "revision": 1,
            "startedAt": "2026-11-20T00:00:00.000Z",
            "updatedAt": "2026-11-20T00:00:00.000Z",
            "userPrompt": "Initial steer target",
            "userMessages": [{
                "id": "message-steer-initial",
                "text": "Initial steer target",
                "attachments": [],
            }],
        }],
        "startedAt": "2026-11-20T00:00:00.000Z",
        "updatedAt": "2026-11-20T00:00:00.000Z",
        "unread": false,
    }));
    state.ai_sessions.save(session).expect("seed steer session");
    let queued = state
        .ai_sessions
        .enqueue_message(
            session_id,
            "Steer this into the turn",
            Vec::new(),
            Vec::new(),
            None,
            Some("message-steer-queued"),
        )
        .expect("enqueue steer message")
        .expect("steer message queued");
    state.start_ai_session_services();
    state.publish_ai_session_snapshot("startup");
    let app = router(state.clone());
    let state_before = state_response(&app).await;
    let queue_uri = format!("/api/ai-sessions/{session_id}/queue");
    let (initial_status, initial_body) = request_json(&app, Method::GET, &queue_uri, None).await;
    let (steer_status, steer_body) = request_json(
        &app,
        Method::POST,
        &format!("{queue_uri}/{}/steer", queued.queue_id),
        None,
    )
    .await;
    let (queue_status, queue_body) = request_json(&app, Method::GET, &queue_uri, None).await;
    let state_after = state_response(&app).await;
    let reopened = controlled_instance_ai_session::AiSessionRuntime::new(
        "session-http-reopened",
        Some(persistence_dir),
    );
    json!({
        "stateBefore": state_before,
        "initialQueue": response_body(initial_status, initial_body),
        "steered": response_body(steer_status, steer_body),
        "queue": response_body(queue_status, queue_body),
        "state": state_after,
        "persisted": project_persisted_sessions(state.ai_sessions.list()),
        "reopened": project_persisted_sessions(reopened.list()),
        "calls": calls.lock().unwrap().clone(),
    })
}

#[tokio::test]
async fn session_http_routes_match_shared_node_fixtures() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/session-http-parity.json"
    ))
    .expect("Node session HTTP golden");
    let mut failures = Vec::new();
    for scenario in fixture["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().expect("scenario name");
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).expect("canonical scenario root");
        let actual = match name {
            "create-success-replay-restart" => observe_create(&root, false).await,
            "create-first-turn-failure" => observe_create(&root, true).await,
            "send-success-and-missing" => observe_send(&root).await,
            "read-clears-unread-and-unknown" => observe_read(&root).await,
            "queue-pause-resume-and-unknown" => observe_queue(&root).await,
            "queue-mutations-and-errors" => observe_queue_mutations(&root).await,
            "queue-steer-success" => observe_queue_steer(&root, false).await,
            "queue-steer-failure" => observe_queue_steer(&root, true).await,
            "read-query-fallbacks" => observe_read_query_fallbacks(&root).await,
            "history-and-log-query-fallbacks" => {
                observe_history_and_log_query_fallbacks(&root).await
            }
            "novnc-resize-query" => observe_novnc_resize_query(&root).await,
            _ => panic!("unknown session HTTP scenario {name}"),
        };
        let mut normalizer = Normalizer::new(&root);
        let actual = normalizer.normalize(actual);
        if actual != scenario["expected"] {
            std::fs::write(
                format!("/tmp/session-http-rust-{name}.json"),
                serde_json::to_vec_pretty(&actual).expect("actual JSON"),
            )
            .expect("write actual");
            std::fs::write(
                format!("/tmp/session-http-node-{name}.json"),
                serde_json::to_vec_pretty(&scenario["expected"]).expect("expected JSON"),
            )
            .expect("write expected");
            failures.push(name.to_string());
        }
    }
    assert!(
        failures.is_empty(),
        "session HTTP scenario mismatches: {failures:?}"
    );
}
