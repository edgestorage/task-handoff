use super::settings_apply_parity::{files, ReadOnlyDirectory};
use super::*;
use controlled_instance_ai_session::{
    AiSessionControlProvider, ProviderAction, ProviderError, ProviderMessage,
};
use std::sync::Mutex;

struct HttpProvider {
    accepted: bool,
    fault: bool,
    root: PathBuf,
    calls: Arc<Mutex<Vec<Value>>>,
    guard: Arc<Mutex<Option<ReadOnlyDirectory>>>,
}
impl HttpProvider {
    fn attempt(
        &self,
        action: &str,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        self.calls.lock().unwrap().push(json!({"action":action,"providerSessionId":session.provider_session_id,
            "message":input.message,"contentHex":hex::encode(std::fs::read(&input.attachments[0].path).unwrap())}));
        if self.fault {
            *self.guard.lock().unwrap() = Some(ReadOnlyDirectory::new(
                self.root.join("ai-session-attachments/manifests"),
            ));
        }
        if !self.accepted {
            return Err(ProviderError::new(
                "PROVIDER_REJECTED",
                "provider rejected",
                503,
            ));
        }
        Ok(ProviderAction {
            turn_id: Some("turn-commit".into()),
            provider_turn_id: Some("turn-commit".into()),
            ..ProviderAction::simple(if action == "start" { "send" } else { "steer" })
        })
    }
}
#[async_trait::async_trait]
impl AiSessionControlProvider for HttpProvider {
    fn agent(&self) -> &str {
        "codex"
    }
    fn capability(&self) -> AiSessionProviderCapability {
        AiSessionProviderCapability {
            agent: "codex".into(),
            actions: AiSessionProviderActions::default(),
            permission_modes: Vec::new(),
            timeline: AiSessionProviderTimelineCapabilities::default(),
            model_selection: None,
            reasoning_effort: None,
            hierarchy: None,
        }
    }
    async fn start_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        self.attempt("start", session, input)
    }
    async fn steer_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        self.attempt("steer", session, input)
    }
}
fn project(state: &AppState, id: &str) -> Value {
    let session = state.ai_sessions.get(id).unwrap();
    let messages=session.turns.as_deref().unwrap_or_default().iter().flat_map(|turn| {
        turn["userMessages"].as_array().into_iter().flatten().map(|message|json!({"turnId":turn.get("providerTurnId").unwrap_or(&turn["id"]),"id":message["id"],"text":message["text"],"attachments":message["attachments"]})).collect::<Vec<_>>()
    }).collect::<Vec<_>>();
    json!({"status":session.status,"phase":session.phase,"activeTurnId":session.active_turn_id,"userPrompt":session.user_prompt,"messages":messages})
}
fn capture(state: &AppState, session: &str, message: &str) -> Value {
    let mut disk = files(&state.config.storage_paths.data_dir);
    disk.as_object_mut()
        .unwrap()
        .retain(|key, _| key.starts_with("ai-session-attachments/"));
    json!({"files":disk,"attachments":state.ai_session_attachments.attachments_for_message(session,message)})
}
fn normalize(
    value: Value,
    ids: &[(&str, &str)],
    started: i64,
    times: &mut std::collections::BTreeMap<String, String>,
) -> Value {
    match value {
        Value::String(mut value) => {
            for (id, label) in ids {
                value = value.replace(id, label);
            }
            json!(value)
        }
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|v| normalize(v, ids, started, times))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    let normalized_key = normalize(json!(key.clone()), ids, started, times)
                        .as_str()
                        .unwrap()
                        .to_string();
                    let value = if key == "createdAt" || key == "committedAt" {
                        let time = value.as_str().unwrap();
                        let ms = chrono::DateTime::parse_from_rfc3339(time)
                            .unwrap()
                            .timestamp_millis();
                        assert!(ms >= started && ms <= chrono::Utc::now().timestamp_millis());
                        if let Some(previous) = times.get(&key) {
                            assert_eq!(previous, time);
                        } else {
                            times.insert(key.clone(), time.into());
                        }
                        json!(format!("<{key}>"))
                    } else {
                        normalize(value, ids, started, times)
                    };
                    (normalized_key, value)
                })
                .collect(),
        ),
        value => value,
    }
}
async fn observe(action: &str, name: &str) -> Value {
    assert_ne!(
        unsafe { libc::geteuid() },
        0,
        "real permission fault requires non-root Unix"
    );
    let started = chrono::Utc::now().timestamp_millis();
    let (state, _root) = test_state_standalone();
    let queued = name == "C04";
    let accepted = name == "C02" || (queued && action == "accept");
    let busy = queued || action == "steer";
    let mut session = ai_session_record("ses_0000000000390", "unused");
    session.creation_source = "ai-session".into();
    session.app_session_id = None;
    session.provider_session_id = Some("thread-commit".into());
    session.cwd = Some(state.config.storage_paths.data_dir.display().to_string());
    session.status = if busy { "running" } else { "idle" }.into();
    session.phase = if busy { "thinking" } else { "unknown" }.into();
    session.active_turn_id = busy.then(|| "turn-commit".into());
    session.user_prompt = None;
    session.turns = None;
    state.ai_sessions.save(session.clone()).unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let guard = Arc::new(Mutex::new(None));
    state
        .ai_session_controller
        .register_provider(Arc::new(HttpProvider {
            accepted,
            fault: accepted || name == "C03",
            root: state.config.storage_paths.data_dir.clone(),
            calls: calls.clone(),
            guard: guard.clone(),
        }));
    let app = router(state.clone());
    let input = json!({"message":"Commit","mode":if queued{"queue"}else if action=="steer"{"steer"}else{"auto"},"attachments":[{"id":"input-commit","kind":"image","name":"input.png","mime":"image/png","size":12,"source":{"type":"inline","encoding":"base64","data":"Y29tbWl0IGJ5dGVz"}}]});
    let make_request = || {
        Request::builder()
            .method("POST")
            .uri(format!("/api/ai-sessions/{}/messages", session.id))
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-task-handoff-trace-id", "u039-trace")
            .body(Body::from(input.to_string()))
            .unwrap()
    };
    let response = if queued {
        let response = app.clone().oneshot(make_request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        let id = body["data"]["queueId"].as_str().unwrap();
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/ai-sessions/{}/queue/{id}/steer", session.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    } else {
        app.oneshot(make_request()).await.unwrap()
    };
    drop(guard.lock().unwrap().take());
    let status = response.status().as_u16();
    let headers = response.headers();
    assert!(matches!(
        headers[header::CONTENT_TYPE].to_str().unwrap(),
        "application/json" | "application/json; charset=utf-8"
    ));
    let trace = headers
        .get("x-task-handoff-trace-id")
        .map(|v| v.to_str().unwrap().to_string());
    let timed = headers.contains_key("server-timing");
    if !queued {
        assert_eq!(trace.as_deref(), Some("u039-trace"));
        let timing = headers["server-timing"].to_str().unwrap();
        assert!(regex::Regex::new(r"^instance_action;dur=\d+\.\d$")
            .unwrap()
            .is_match(timing));
    }
    let response = json!({"status":status,"contentType":"application/json","body":body_json(response).await,"traceId":trace,"timed":timed});
    eprintln!("U03.9 {name}/{action} raw response: {response}");
    let disk = files(&state.config.storage_paths.data_dir);
    let manifest = disk
        .as_object()
        .unwrap()
        .iter()
        .find(|(key, _)| key.starts_with("ai-session-attachments/manifests/"))
        .unwrap()
        .1;
    let message = manifest["messageId"].as_str().unwrap();
    let attachment = manifest["id"].as_str().unwrap();
    let queue=state.ai_sessions.get(&session.id).unwrap().queue.items.iter().map(|item|json!({"status":item["status"],"attachments":item["attachments"],"error":item.get("error").unwrap_or(&Value::Null)})).collect::<Vec<_>>();
    let mut output = json!({"response":response,"calls":calls.lock().unwrap().clone(),"session":project(&state,&session.id),"after":capture(&state,&session.id,message),"queue":queue});
    output["retry"] = json!(if accepted {
        state
            .ai_session_attachments
            .commit_message(&session.id, message, Some("turn-commit"))
            .unwrap()
    } else {
        state
            .ai_session_attachments
            .rollback_message(&session.id, message)
            .unwrap()
    });
    output["afterRetry"] = capture(&state, &session.id, message);
    normalize(
        output,
        &[
            (&session.id, "<session>"),
            (message, "<message>"),
            (attachment, "<attachment>"),
        ],
        started,
        &mut Default::default(),
    )
}
async fn compare(name: &str) {
    let variants = if name == "C04" {
        ["reject", "accept"]
    } else {
        ["start", "steer"]
    };
    let mut actual = serde_json::Map::new();
    for variant in variants {
        actual.insert(variant.into(), observe(variant, name).await);
    }
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/attachment-control-http-parity.json"
    ))
    .unwrap();
    assert_eq!(
        Value::Object(actual),
        fixture["expected"][name],
        "actual public HTTP and attachment authority must match Node"
    );
}
#[tokio::test]
async fn c01_provider_rejection_http() {
    compare("C01").await;
}
#[tokio::test]
async fn c02_accepted_commit_failure_http() {
    compare("C02").await;
}
#[tokio::test]
async fn c03_rollback_failure_http() {
    compare("C03").await;
}
#[tokio::test]
async fn c04_queue_steer_failure_http() {
    compare("C04").await;
}
