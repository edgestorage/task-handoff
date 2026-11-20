use super::commit_parity::project;
use super::*;
use crate::attachments::tests::commit_parity::{
    capture, normalize, open, open_with_writer, ReadOnlyDirectory,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex as SyncMutex,
};
struct RefusingProvider {
    action: &'static str,
    name: &'static str,
    root: PathBuf,
    calls: Arc<SyncMutex<Vec<Value>>>,
    guard: Arc<SyncMutex<Option<ReadOnlyDirectory>>>,
}
impl RefusingProvider {
    fn call(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        self.calls.lock().unwrap().push(json!({"action":self.action,"providerSessionId":session.provider_session_id,"message":input.message,"contentHex":hex::encode(std::fs::read(&input.attachments[0].path).unwrap())}));
        if self.name == "C02" {
            return Ok(ProviderAction {
                turn_id: Some("turn-commit".into()),
                provider_turn_id: Some("turn-commit".into()),
                ..ProviderAction::simple(if self.action == "start" {
                    "send"
                } else {
                    "steer"
                })
            });
        }
        if self.name == "C03" {
            *self.guard.lock().unwrap() = Some(ReadOnlyDirectory::new(
                self.root.join("ai-session-attachments/manifests"),
            ));
        }
        Err(ProviderError::new(
            "PROVIDER_REJECTED",
            "provider rejected",
            503,
        ))
    }
}
#[async_trait]
impl AiSessionControlProvider for RefusingProvider {
    fn agent(&self) -> &str {
        "codex"
    }
    fn capability(&self) -> AiSessionProviderCapability {
        MaterializationProvider::default().capability()
    }
    async fn start_message(
        &self,
        s: &AiSession,
        i: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        self.call(s, i)
    }
    async fn steer_message(
        &self,
        s: &AiSession,
        i: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        self.call(s, i)
    }
}
async fn observe(action: &'static str, name: &'static str) -> Value {
    let root = tempfile::tempdir().unwrap();
    let faults = Arc::new(AtomicUsize::new(0));
    let fault_count = faults.clone();
    let owner = Arc::new(open_with_writer(root.path(), move |file, bytes| {
        let record: Value = serde_json::from_slice(bytes).unwrap();
        if name == "C02"
            && record["state"] == "committed"
            && fault_count.fetch_add(1, Ordering::SeqCst) == 0
        {
            let _readonly = ReadOnlyDirectory::new(file.parent().unwrap().to_path_buf());
            return controlled_instance_core::atomic::write_atomic(file, bytes, Some(0o600));
        }
        controlled_instance_core::atomic::write_atomic(file, bytes, Some(0o600))
    }));
    let runtime = Arc::new(AiSessionRuntime::new(
        "rollback",
        Some(root.path().join("sessions")),
    ));
    let mut session = test_session();
    session.provider_session_id = Some("thread-commit".into());
    session.cwd = Some(root.path().display().to_string());
    session.status = if action == "steer" { "running" } else { "idle" }.into();
    session.phase = if action == "steer" {
        "thinking"
    } else {
        "unknown"
    }
    .into();
    session.active_turn_id = (action == "steer").then(|| "turn-commit".into());
    runtime.save(session.clone()).unwrap();
    let controller = AiSessionController::new(
        runtime.clone(),
        owner.clone(),
        Arc::new(owner.draft_streams()),
        None,
    );
    let calls = Arc::new(SyncMutex::new(Vec::new()));
    let guard = Arc::new(SyncMutex::new(None));
    controller.register_provider(Arc::new(RefusingProvider {
        action,
        name,
        root: root.path().to_path_buf(),
        calls: calls.clone(),
        guard: guard.clone(),
    }));
    let input:AiSessionMessageInput=serde_json::from_value(json!({"message":"Commit","mode":if name=="C04"{"queue"}else if action=="steer"{"steer"}else{"auto"},"attachments":[{"id":"input-commit","kind":"image","name":"input.png","mime":"image/png","size":12,"source":{"type":"inline","encoding":"base64","data":"Y29tbWl0IGJ5dGVz"}}]})).unwrap();
    let queue_id = if name == "C04" {
        controller
            .send_message(&session.id, ProviderMessageInput::from_wire(&input))
            .await
            .unwrap()
            .action
            .queue_id
    } else {
        None
    };
    let mut changes = controller.subscribe_changes();
    let sent = if let Some(queue_id) = queue_id {
        if action == "start" {
            controller
                .send_next_queued_message(&session.id)
                .await
                .map(|result| result.unwrap())
        } else {
            controller
                .steer_queued_message(&session.id, &queue_id)
                .await
        }
    } else {
        controller
            .send_message(&session.id, ProviderMessageInput::from_wire(&input))
            .await
    };
    drop(guard.lock().unwrap().take());
    let error = sent.expect_err("fault must fail");
    let outcome = if error.code == "AI_SESSION_ATTACHMENT_IO_FAILED" {
        assert_eq!(error.status_code, 500);
        assert_eq!(
            error.message,
            "AI session attachment manifest could not be persisted."
        );
        json!({"ok":false,"kind":"permission-denied"})
    } else {
        json!({"ok":false,"code":error.code,"message":error.message,"statusCode":error.status_code})
    };
    let snapshot = capture(root.path(), &owner);
    let id = snapshot["manifests"][0]["id"].as_str().unwrap().to_string();
    let message_id = snapshot["manifests"][0]["messageId"]
        .as_str()
        .unwrap()
        .to_string();
    let last_change = if changes.try_recv().is_ok() {
        project(&runtime, &session.id)
    } else {
        Value::Null
    };
    let mut output = json!({"outcome":outcome,"calls":calls.lock().unwrap().clone(),"session":project(&runtime,&session.id),"lastChange":last_change,"after":snapshot,"faultCount":faults.load(Ordering::SeqCst)});
    eprintln!(
        "{name}/{action}: outcome={}, owner={}, change={}",
        output["outcome"],
        output["after"]["manifests"][0]["state"],
        !output["lastChange"].is_null()
    );
    if name == "C04" {
        output["queue"]=json!(runtime.get(&session.id).unwrap().queue.items.iter().map(|item|json!({"status":item["status"],"messageId":item["messageId"],"message":item["message"],"attachments":item["attachments"],"error":item.get("error").unwrap_or(&Value::Null)})).collect::<Vec<_>>());
    } else {
        output["rollbackRetry"] = json!(owner.rollback_message(&session.id, &message_id).unwrap());
        output["afterRetry"] = capture(root.path(), &owner);
    }
    output["reopened"] = capture(root.path(), &open(root.path()));
    normalize(
        output,
        &[
            (&session.id, "<session>"),
            (&message_id, "<message>"),
            (&id, "<attachment>"),
        ],
    )
}
async fn compare(name: &'static str) {
    let actual = json!({"start":observe("start",name).await,"steer":observe("steer",name).await});
    let fixture: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/attachment-rollback-parity.json"
    ))
    .unwrap();
    assert_eq!(
        actual, fixture["expected"][name],
        "full Node compensation/authority observations"
    );
}
#[tokio::test]
async fn c01_provider_rejection_rolls_back() {
    compare("C01").await;
}
#[tokio::test]
async fn c02_one_shot_commit_failure_rolls_back() {
    compare("C02").await;
}
#[tokio::test]
async fn c03_rollback_failure_remains_retryable() {
    compare("C03").await;
}
#[tokio::test]
async fn c04_queue_rejection_keeps_owner() {
    compare("C04").await;
}
