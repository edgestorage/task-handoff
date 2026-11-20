use async_trait::async_trait;
use controlled_instance_ai_session::{
    AiSession, AiSessionControlProvider, AiSessionController, AiSessionConversationAttachmentStore,
    AiSessionCreateInput, AiSessionCreateResult, AiSessionManagedCreateOptions, AiSessionRuntime,
    ProviderAction, ProviderCreateInput, ProviderCreateResult, ProviderError, ProviderMessage,
};
use controlled_instance_protocol::AiSessionProviderCapability;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

// Match the explicit coordinator projection in test/fixtures/ai-session-create-parity.js.
// Map random IDs bijectively; retain every reference to them across provider input,
// authority, reopened persistence and completed-operation replay. This does not
// compare intermediate event revisions or HTTP/WS framing (tracked separately).
#[derive(Default)]
struct Observations {
    ids: BTreeMap<String, String>,
    calls: Vec<Value>,
}
impl Observations {
    fn identity(&mut self, kind: &str, id: &str) -> String {
        assert!(!id.is_empty());
        if let Some(mapped) = self.ids.get(id) {
            return mapped.clone();
        }
        let prefix = format!("${kind}");
        let count = self.ids.values().filter(|v| v.starts_with(&prefix)).count();
        let mapped = format!("{prefix}{}", count + 1);
        self.ids.insert(id.to_string(), mapped.clone());
        mapped
    }
    fn result(&mut self, result: &AiSessionCreateResult) -> Value {
        json!({"disposition": result.disposition, "aiSessionId": self.identity("session", &result.ai_session_id),
            "providerSessionId": result.provider_session_id, "creationSource": result.creation_source})
    }
    fn sessions(&mut self, runtime: &AiSessionRuntime) -> Value {
        Value::Array(runtime.list().iter().map(|session| {
            let id = self.identity("session", &session.id);
            let messages = session.turns.iter().flatten().flat_map(|turn| {
                turn.get("userMessages").and_then(Value::as_array).into_iter().flatten()
            }).map(|message| json!({"id": self.identity("message", message["id"].as_str().expect("message id")), "text": message["text"]})).collect::<Vec<_>>();
            json!({"id": id, "providerSessionId": session.provider_session_id, "creationSource": session.creation_source,
                "cwdFolderId": session.cwd_folder_id, "status": session.status, "phase": session.phase,
                "reasoningEffort": session.reasoning_effort, "userPrompt": session.user_prompt,
                "activeTurnId": session.active_turn_id, "messages": messages})
        }).collect())
    }
}

struct MockProvider {
    scenario: Value,
    observations: Arc<Mutex<Observations>>,
}
#[async_trait]
impl AiSessionControlProvider for MockProvider {
    fn agent(&self) -> &str {
        "codex"
    }
    fn capability(&self) -> AiSessionProviderCapability {
        AiSessionProviderCapability {
            agent: "codex".into(),
            actions: Default::default(),
            permission_modes: Vec::new(),
            timeline: Default::default(),
            model_selection: None,
            reasoning_effort: self.scenario.get("selectAtCreate").map(|value| {
                controlled_instance_protocol::AiSessionReasoningEffortCapabilities {
                    select_at_create: value.as_bool().expect("boolean capability"),
                    update_during_session: false,
                }
            }),
            hierarchy: None,
        }
    }
    async fn create_session(
        &self,
        input: ProviderCreateInput,
    ) -> Result<ProviderCreateResult, ProviderError> {
        self.observations
            .lock()
            .unwrap()
            .calls
            .push(json!({"action":"create", "reasoningEffort":input.reasoning_effort}));
        if self.scenario["failure"] == "create" {
            return Err(ProviderError::new(
                "PROVIDER_REJECTED",
                "provider create rejected",
                409,
            ));
        }
        Ok(ProviderCreateResult {
            provider_session_id: "thread-create-parity".into(),
            cwd: input.cwd,
            model_selection: input.model_selection,
            reasoning_effort: input.reasoning_effort,
        })
    }
    async fn start_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        {
            let mut observations = self.observations.lock().unwrap();
            let session_id = observations.identity("session", &session.id);
            let message_id = observations.identity(
                "message",
                input.message_id.as_deref().expect("provider message id"),
            );
            observations.calls.push(json!({"action":"start", "sessionId":session_id, "providerSessionId":session.provider_session_id,
                "messageId":message_id, "message":input.message}));
        }
        if self.scenario["failure"] == "start" {
            return Err(ProviderError::new(
                "UPSTREAM_FAILED",
                "provider start rejected",
                500,
            ));
        }
        if self.scenario["failure"] == "timeout" {
            return std::future::pending().await;
        }
        Ok(ProviderAction {
            provider_turn_id: Some("turn-create-parity".into()),
            ..ProviderAction::simple("send")
        })
    }
    async fn delete_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.observations
            .lock()
            .unwrap()
            .calls
            .push(json!({"action":"delete", "providerSessionId":provider_session_id}));
        Ok(())
    }
    async fn unsubscribe_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.observations
            .lock()
            .unwrap()
            .calls
            .push(json!({"action":"unsubscribe", "providerSessionId":provider_session_id}));
        Ok(())
    }
}

async fn assert_scenario(name: &str) {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/session-create-parity.json")).unwrap();
    let scenario = fixture["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == name)
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let sessions_dir = directory.path().join("sessions");
    let runtime = Arc::new(AiSessionRuntime::new(
        "create-parity",
        Some(sessions_dir.clone()),
    ));
    let attachments = Arc::new(AiSessionConversationAttachmentStore::new(directory.path()));
    let operations_path = directory.path().join("operations.json");
    let controller = AiSessionController::new(
        runtime.clone(),
        attachments.clone(),
        Arc::new(attachments.draft_streams()),
        Some(operations_path.clone()),
    );
    let observations = Arc::new(Mutex::new(Observations::default()));
    controller.register_provider(Arc::new(MockProvider {
        scenario: scenario.clone(),
        observations: observations.clone(),
    }));
    let mut changes = controller.subscribe_changes();
    let input = AiSessionCreateInput {
        agent: "codex".into(),
        cwd: controlled_instance_ai_session::AiSessionRuntimePathInput {
            runtime_path_type: "runtime-path".into(),
            path: directory.path().display().to_string(),
        },
        cwd_folder_id: Some("folder-create-parity".into()),
        git_selection: None,
        workspace_selection: None,
        model_selection: None,
        reasoning_effort: scenario["reasoningEffort"].as_str().map(str::to_string),
        story_id: None,
        message: controlled_instance_ai_session::AiSessionMessageInput {
            message: "Start".into(),
            client_request_id: Some("request-create-parity".into()),
            ..Default::default()
        },
    };
    let outcome = controller
        .create_managed_session(
            input.clone(),
            AiSessionManagedCreateOptions {
                materialization_timeout: Some(Duration::from_millis(10)),
                ..Default::default()
            },
        )
        .await;
    let (result, error) = match outcome {
        Ok(result) => (observations.lock().unwrap().result(&result), Value::Null),
        Err(error) => (
            Value::Null,
            json!({"code":error.code, "message":error.message, "statusCode":error.status_code}),
        ),
    };
    let authoritative = observations.lock().unwrap().sessions(&runtime);
    let revision = runtime.revision();
    assert_eq!(
        revision > 0,
        !observations.lock().unwrap().ids.is_empty(),
        "mutation revision reflects whether a session was created"
    );
    let restored_runtime = AiSessionRuntime::new("create-parity-restored", Some(sessions_dir));
    let restored = observations.lock().unwrap().sessions(&restored_runtime);
    // The channel is an invalidation signal. Only compare the final authoritative
    // projection when notified, not the number/coalescing of intermediate signals.
    let mut notified = false;
    while changes.try_recv().is_ok() {
        notified = true;
    }
    let last_change = if notified {
        authoritative.clone()
    } else {
        Value::Null
    };
    let mut completed = Vec::new();
    if operations_path.exists() {
        let store: Value =
            serde_json::from_slice(&std::fs::read(&operations_path).unwrap()).unwrap();
        for record in store["completed"].as_array().unwrap() {
            let result: AiSessionCreateResult =
                serde_json::from_value(record["result"].clone()).unwrap();
            completed.push(json!({"clientRequestId":record["clientRequestId"], "result":observations.lock().unwrap().result(&result)}));
        }
    }
    let replay = if !result.is_null() {
        let reopened = AiSessionController::new(
            Arc::new(restored_runtime),
            attachments.clone(),
            Arc::new(attachments.draft_streams()),
            Some(operations_path),
        );
        let result = reopened
            .create_session(input)
            .await
            .expect("replay must not call an absent provider");
        observations.lock().unwrap().result(&result)
    } else {
        Value::Null
    };
    let actual = json!({"result":result, "error":error, "calls":observations.lock().unwrap().calls,
        "sessions":authoritative, "restored":restored, "completed":completed, "replay":replay, "lastChange":last_change});
    println!("{name} actual={actual}");
    assert_eq!(actual, scenario["expected"], "{name}");
}

macro_rules! scenario_test {
    ($test:ident, $name:literal) => {
        #[tokio::test]
        async fn $test() {
            assert_scenario($name).await;
        }
    };
}
scenario_test!(success, "U01.1-C01-success");
scenario_test!(provider_rejected, "U01.1-C02-provider-rejected");
scenario_test!(first_turn_rejected, "U01.1-C03-first-turn-rejected");
scenario_test!(first_turn_timeout, "U01.1-C04-first-turn-timeout");
scenario_test!(
    effort_capability_missing,
    "U01.1-C05-effort-capability-missing"
);
scenario_test!(effort_capability_false, "U01.1-C06-effort-capability-false");
scenario_test!(effort_capability_true, "U01.1-C07-effort-capability-true");

struct LifecycleProvider {
    kind: String,
    runtime: Arc<AiSessionRuntime>,
    observations: Arc<Mutex<Observations>>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
    upstream_done: Arc<tokio::sync::Notify>,
}
#[async_trait]
impl AiSessionControlProvider for LifecycleProvider {
    fn agent(&self) -> &str {
        "codex"
    }
    fn capability(&self) -> AiSessionProviderCapability {
        AiSessionProviderCapability {
            agent: "codex".into(),
            actions: Default::default(),
            permission_modes: Vec::new(),
            timeline: Default::default(),
            model_selection: None,
            reasoning_effort: None,
            hierarchy: None,
        }
    }
    async fn create_session(
        &self,
        input: ProviderCreateInput,
    ) -> Result<ProviderCreateResult, ProviderError> {
        self.observations
            .lock()
            .unwrap()
            .calls
            .push(json!({"action":"create", "reasoningEffort":null}));
        if self.kind == "drop-create" {
            self.entered.notify_one();
            self.release.acquire().await.unwrap().forget();
        }
        Ok(ProviderCreateResult {
            provider_session_id: "thread-create-parity".into(),
            cwd: input.cwd,
            model_selection: None,
            reasoning_effort: None,
        })
    }
    async fn start_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        {
            let mut observations = self.observations.lock().unwrap();
            let session_id = observations.identity("session", &session.id);
            let message_id = observations.identity("message", input.message_id.as_deref().unwrap());
            observations.calls.push(json!({"action":"start", "sessionId":session_id, "providerSessionId":session.provider_session_id,
                "messageId":message_id, "message":input.message}));
        }
        if self.kind == "interrupt-active" {
            self.runtime
                .update(&session.id, |session| {
                    session.status = "running".into();
                    session.phase = "thinking".into();
                    session.active_turn_id = Some("turn-create-parity".into());
                    Ok(true)
                })
                .unwrap();
        }
        if self.kind != "drop-create" {
            // Simulate a real upstream RPC finishing independently from its Rust
            // waiter: dropping the receiver cannot prevent a late server ack.
            let release = self.release.clone();
            let done = self.upstream_done.clone();
            let (sender, receiver) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                release.acquire().await.unwrap().forget();
                let _ = sender.send(());
                done.notify_one();
            });
            self.entered.notify_one();
            receiver.await.unwrap();
        }
        Ok(ProviderAction {
            provider_turn_id: Some("turn-create-parity".into()),
            ..ProviderAction::simple("send")
        })
    }
    async fn interrupt(&self, session: &AiSession) -> Result<ProviderAction, ProviderError> {
        self.observations
            .lock()
            .unwrap()
            .calls
            .push(json!({"action":"interrupt", "providerSessionId":session.provider_session_id}));
        Err(ProviderError::new(
            "PROVIDER_INTERRUPT_REJECTED",
            "provider interrupt rejected",
            503,
        ))
    }
    async fn delete_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.observations
            .lock()
            .unwrap()
            .calls
            .push(json!({"action":"delete", "providerSessionId":provider_session_id}));
        Ok(())
    }
    async fn unsubscribe_session(&self, provider_session_id: &str) -> Result<(), ProviderError> {
        self.observations
            .lock()
            .unwrap()
            .calls
            .push(json!({"action":"unsubscribe", "providerSessionId":provider_session_id}));
        Ok(())
    }
}

fn projected_outcome(
    observations: &Arc<Mutex<Observations>>,
    outcome: Result<AiSessionCreateResult, ProviderError>,
) -> Value {
    match outcome {
        Ok(result) => json!({"result":observations.lock().unwrap().result(&result), "error":null}),
        Err(error) => {
            json!({"result":null, "error":{"code":error.code, "message":error.message, "statusCode":error.status_code}})
        }
    }
}

async fn assert_lifecycle(kind: &str) {
    let fixture: Value = serde_json::from_str(include_str!(
        "fixtures/session-create-lifecycle-parity.json"
    ))
    .unwrap();
    let scenario = fixture["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["kind"] == kind)
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let sessions_dir = directory.path().join("sessions");
    let runtime = Arc::new(AiSessionRuntime::new(
        "lifecycle-parity",
        Some(sessions_dir.clone()),
    ));
    let attachments = Arc::new(AiSessionConversationAttachmentStore::new(directory.path()));
    let operations_path = directory.path().join("operations.json");
    let controller = AiSessionController::new(
        runtime.clone(),
        attachments.clone(),
        Arc::new(attachments.draft_streams()),
        Some(operations_path.clone()),
    );
    let observations = Arc::new(Mutex::new(Observations::default()));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let upstream_done = Arc::new(tokio::sync::Notify::new());
    controller.register_provider(Arc::new(LifecycleProvider {
        kind: kind.into(),
        runtime: runtime.clone(),
        observations: observations.clone(),
        entered: entered.clone(),
        release: release.clone(),
        upstream_done: upstream_done.clone(),
    }));
    let mut changes = controller.subscribe_changes();
    let input = AiSessionCreateInput {
        agent: "codex".into(),
        cwd: controlled_instance_ai_session::AiSessionRuntimePathInput {
            runtime_path_type: "runtime-path".into(),
            path: directory.path().display().to_string(),
        },
        cwd_folder_id: Some("folder-create-parity".into()),
        git_selection: None,
        workspace_selection: None,
        model_selection: None,
        reasoning_effort: None,
        story_id: None,
        message: controlled_instance_ai_session::AiSessionMessageInput {
            message: "Start".into(),
            client_request_id: Some("request-create-parity".into()),
            ..Default::default()
        },
    };
    let timed_out = kind.contains("timeout");
    let options = AiSessionManagedCreateOptions {
        materialization_timeout: Some(Duration::from_millis(if timed_out { 20 } else { 1000 })),
        ..Default::default()
    };
    let caller = {
        let controller = controller.clone();
        let input = input.clone();
        let options = options.clone();
        tokio::spawn(async move { controller.create_managed_session(input, options).await })
    };
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .expect("provider entered");
    let mut interrupt_error = Value::Null;
    if kind.starts_with("interrupt") {
        let id = runtime.list()[0].id.clone();
        let error = controller
            .interrupt(&id)
            .await
            .expect_err("interrupt rejection");
        interrupt_error =
            json!({"code":error.code, "message":error.message, "statusCode":error.status_code});
    }
    let dropped = kind.starts_with("drop");
    let mut outcome = Value::Null;
    let finished_without_waiter;
    if dropped {
        caller.abort();
        assert!(
            caller.await.unwrap_err().is_cancelled(),
            "only the request waiter is dropped"
        );
        if !timed_out {
            release.add_permits(1);
        }
        // Do not call create or poll its Shared future here: the owner must make
        // durable progress and publish completion without any request waiter.
        finished_without_waiter = matches!(
            tokio::time::timeout(Duration::from_secs(1), changes.recv()).await,
            Ok(Ok(()))
        );
    } else {
        if !timed_out {
            release.add_permits(1);
        }
        let result = tokio::time::timeout(Duration::from_secs(2), caller)
            .await
            .unwrap()
            .unwrap();
        outcome = projected_outcome(&observations, result);
        finished_without_waiter = true;
    }
    let authoritative = observations.lock().unwrap().sessions(&runtime);
    let restored_runtime = AiSessionRuntime::new("lifecycle-reopened", Some(sessions_dir));
    let restored = observations.lock().unwrap().sessions(&restored_runtime);
    let mut notified = dropped && finished_without_waiter;
    while changes.try_recv().is_ok() {
        notified = true;
    }
    let last_change = if notified {
        authoritative.clone()
    } else {
        Value::Null
    };
    let mut completed = Vec::new();
    if operations_path.exists() {
        let store: Value =
            serde_json::from_slice(&std::fs::read(&operations_path).unwrap()).unwrap();
        for record in store["completed"].as_array().unwrap() {
            let result: AiSessionCreateResult =
                serde_json::from_value(record["result"].clone()).unwrap();
            completed.push(json!({"clientRequestId":record["clientRequestId"], "result":observations.lock().unwrap().result(&result)}));
        }
    }
    let before_retry = json!({"sessions":authoritative, "restored":restored, "completed":completed, "lastChange":last_change});
    let replay = if kind == "drop-create" || kind == "drop-start" {
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            controller.create_managed_session(input.clone(), options.clone()),
        )
        .await
        .unwrap()
        .unwrap();
        observations.lock().unwrap().result(&result)
    } else {
        Value::Null
    };
    let after_late_ack = if timed_out {
        release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(2), upstream_done.notified())
            .await
            .unwrap();
        // In the broken case, clean up by finally polling the abandoned operation
        // only after saving the failed checkpoint. Do not contaminate that evidence.
        if dropped && !finished_without_waiter {
            let _ = controller
                .create_managed_session(input.clone(), options)
                .await;
        }
        let mut late_notified = notified;
        while changes.try_recv().is_ok() {
            late_notified = true;
        }
        let sessions = observations.lock().unwrap().sessions(&runtime);
        json!({"sessions":sessions, "operationFileExists":operations_path.exists(), "lastChange":if late_notified {sessions.clone()} else {Value::Null}})
    } else {
        Value::Null
    };
    let actual = json!({"finishedWithoutWaiter":finished_without_waiter, "interruptError":interrupt_error, "outcome":outcome,
        "calls":observations.lock().unwrap().calls, "beforeRetry":before_retry, "replay":replay, "afterLateAck":after_late_ack});
    println!("{} actual={actual}", scenario["name"]);
    let owner = Arc::downgrade(&controller);
    drop(controller);
    assert!(
        owner.upgrade().is_none(),
        "completed operation must release its coordinator owner"
    );
    assert_eq!(actual, scenario["expected"], "{kind}");
}
macro_rules! lifecycle_test {
    ($test:ident, $kind:literal) => {
        #[tokio::test]
        async fn $test() {
            assert_lifecycle($kind).await;
        }
    };
}
lifecycle_test!(caller_drop_during_provider_create, "drop-create");
lifecycle_test!(caller_drop_during_first_turn, "drop-start");
lifecycle_test!(caller_drop_does_not_suspend_timeout, "drop-start-timeout");
lifecycle_test!(interrupt_before_active_is_rejected, "interrupt-idle");
lifecycle_test!(
    interrupt_rejection_does_not_replace_first_turn_result,
    "interrupt-active"
);
lifecycle_test!(
    late_ack_does_not_restore_compensated_session,
    "late-ack-timeout"
);

struct SendLifecycleProvider {
    fail_first: bool,
    observations: Arc<Mutex<Observations>>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
    returned: Arc<tokio::sync::Notify>,
}
#[async_trait]
impl AiSessionControlProvider for SendLifecycleProvider {
    fn agent(&self) -> &str {
        "codex"
    }
    fn capability(&self) -> AiSessionProviderCapability {
        AiSessionProviderCapability {
            agent: "codex".into(),
            actions: Default::default(),
            permission_modes: Vec::new(),
            timeline: Default::default(),
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
        let attempt = {
            let mut observations = self.observations.lock().unwrap();
            let session_id = observations.identity("session", &session.id);
            let message_id = observations.identity("message", input.message_id.as_deref().unwrap());
            observations.calls.push(json!({"action":"start", "sessionId":session_id, "providerSessionId":session.provider_session_id,
                "messageId":message_id, "message":input.message}));
            observations.calls.len()
        };
        if attempt == 1 {
            self.entered.notify_one();
            self.release.acquire().await.unwrap().forget();
            self.returned.notify_one();
        }
        if attempt == 1 && self.fail_first {
            return Err(ProviderError::new(
                "PROVIDER_SEND_REJECTED",
                "provider send rejected",
                503,
            ));
        }
        Ok(ProviderAction {
            provider_turn_id: Some(format!("turn-send-{attempt}")),
            ..ProviderAction::simple("send")
        })
    }
}
fn send_outcome(
    observations: &Arc<Mutex<Observations>>,
    result: Result<controlled_instance_ai_session::AiSessionActionResult, ProviderError>,
) -> Value {
    match result {
        Ok(result) => {
            json!({"result":{"action":result.action.action, "sessionId":observations.lock().unwrap().identity("session",&result.session.id),
            "providerSessionId":result.session.provider_session_id, "turnId":result.action.provider_turn_id}, "error":null})
        }
        Err(error) => {
            json!({"result":null, "error":{"code":error.code, "message":error.message, "statusCode":error.status_code}})
        }
    }
}
async fn assert_send_lifecycle(name: &str) {
    use controlled_instance_ai_session::{AiSessionMessageInput, ProviderMessageInput};
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/session-send-lifecycle-parity.json")).unwrap();
    let scenario = fixture["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap();
    let no_key = scenario["noKey"].as_bool().unwrap_or(false);
    let directory = tempfile::tempdir().unwrap();
    let sessions_dir = directory.path().join("sessions");
    let runtime = Arc::new(AiSessionRuntime::new(
        "send-lifecycle",
        Some(sessions_dir.clone()),
    ));
    let session:AiSession=serde_json::from_value(json!({"id":"ses_0000000000001", "agent":"codex", "creationSource":"ai-session",
        "providerSessionId":"thread-send-parity", "appId":"codex-app-server", "cwd":directory.path(),
        "cwdFolderId":"folder-create-parity", "status":"idle", "phase":"unknown"})).unwrap();
    runtime.save(session.clone()).unwrap();
    let attachments = Arc::new(AiSessionConversationAttachmentStore::new(directory.path()));
    let controller = AiSessionController::new(
        runtime.clone(),
        attachments.clone(),
        Arc::new(attachments.draft_streams()),
        None,
    );
    let observations = Arc::new(Mutex::new(Observations::default()));
    observations
        .lock()
        .unwrap()
        .identity("session", &session.id);
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let returned = Arc::new(tokio::sync::Notify::new());
    controller.register_provider(Arc::new(SendLifecycleProvider {
        fail_first: scenario["failFirst"].as_bool().unwrap(),
        observations: observations.clone(),
        entered: entered.clone(),
        release: release.clone(),
        returned: returned.clone(),
    }));
    let mut changes = controller.subscribe_changes();
    let input = AiSessionMessageInput {
        message: "Start".into(),
        client_request_id: (!no_key).then(|| "request-send-parity".into()),
        ..Default::default()
    };
    let caller = {
        let controller = controller.clone();
        let id = session.id.clone();
        let input = input.clone();
        tokio::spawn(async move {
            controller
                .send_message(&id, ProviderMessageInput::from_wire(&input))
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    release.add_permits(1);
    // This checkpoint must not submit a retry or poll the suspended Shared.
    // The event is emitted after the test provider receives its released result.
    let finished_without_waiter = tokio::time::timeout(Duration::from_secs(1), returned.notified())
        .await
        .is_ok();
    let authoritative = observations.lock().unwrap().sessions(&runtime);
    let restored = observations
        .lock()
        .unwrap()
        .sessions(&AiSessionRuntime::new(
            "send-reopened",
            Some(sessions_dir.clone()),
        ));
    let before_retry = json!({"sessions":authoritative,"restored":restored});
    let retry = if no_key {
        Value::Null
    } else {
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            controller.send_message(&session.id, ProviderMessageInput::from_wire(&input)),
        )
        .await
        .unwrap();
        send_outcome(&observations, result)
    };
    // Simulate the provider's authoritative idle state before the next new key.
    runtime
        .update(&session.id, |session| {
            session.status = "idle".into();
            session.phase = "unknown".into();
            session.active_turn_id = None;
            Ok(true)
        })
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        controller.send_message(
            &session.id,
            ProviderMessageInput::from_wire(&AiSessionMessageInput {
                message: "Follow up".into(),
                client_request_id: Some("request-send-next".into()),
                ..Default::default()
            }),
        ),
    )
    .await
    .unwrap();
    let follow_up = send_outcome(&observations, result);
    let authoritative = observations.lock().unwrap().sessions(&runtime);
    let restored = observations
        .lock()
        .unwrap()
        .sessions(&AiSessionRuntime::new(
            "send-final-reopened",
            Some(sessions_dir),
        ));
    let mut notified = false;
    while changes.try_recv().is_ok() {
        notified = true;
    }
    let actual = json!({"finishedWithoutWaiter":finished_without_waiter,"beforeRetry":before_retry,"retry":retry,"followUp":follow_up,
        "calls":observations.lock().unwrap().calls,"sessions":authoritative,"restored":restored,
        "lastChange":if notified {authoritative.clone()}else{Value::Null}});
    println!("{name} actual={actual}");
    let owner = Arc::downgrade(&controller);
    drop(controller);
    assert!(
        owner.upgrade().is_none(),
        "completed send must release its coordinator owner"
    );
    assert_eq!(actual, scenario["expected"], "{name}");
}
macro_rules! send_lifecycle_test {
    ($test:ident,$name:literal) => {
        #[tokio::test]
        async fn $test() {
            assert_send_lifecycle($name).await;
        }
    };
}
send_lifecycle_test!(send_drop_success, "U01.3-C01-drop-success");
send_lifecycle_test!(send_drop_rejection, "U01.3-C02-drop-rejection");
send_lifecycle_test!(send_no_key_drop_success, "U01.3-C03-no-key-drop-success");
send_lifecycle_test!(
    send_no_key_drop_rejection,
    "U01.3-C04-no-key-drop-rejection"
);
