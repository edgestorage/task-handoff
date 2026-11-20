use super::*;
use crate::attachments::tests::commit_parity::{
    capture, fixture, normalize, open, ReadOnlyDirectory,
};
use std::sync::Mutex as SyncMutex;

struct AcceptingProvider {
    action: &'static str,
    root: PathBuf,
    fail: bool,
    calls: Arc<SyncMutex<Vec<Value>>>,
    guard: Arc<SyncMutex<Option<ReadOnlyDirectory>>>,
}
impl AcceptingProvider {
    fn accept(&self, session: &AiSession, input: ProviderMessage) -> ProviderAction {
        assert_eq!(input.attachments.len(), 1);
        self.calls.lock().unwrap().push(json!({"action":self.action,"providerSessionId":session.provider_session_id,"message":input.message,"contentHex":hex::encode(std::fs::read(&input.attachments[0].path).unwrap())}));
        if self.fail {
            *self.guard.lock().unwrap() = Some(ReadOnlyDirectory::new(
                self.root.join("ai-session-attachments/manifests"),
            ));
        }
        ProviderAction {
            provider_turn_id: Some("turn-commit".into()),
            turn_id: Some("turn-commit".into()),
            ..ProviderAction::simple(if self.action == "start" {
                "send"
            } else {
                "steer"
            })
        }
    }
}
#[async_trait]
impl AiSessionControlProvider for AcceptingProvider {
    fn agent(&self) -> &str {
        "codex"
    }
    fn capability(&self) -> AiSessionProviderCapability {
        MaterializationProvider::default().capability()
    }
    async fn start_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        Ok(self.accept(session, input))
    }
    async fn steer_message(
        &self,
        session: &AiSession,
        input: ProviderMessage,
    ) -> Result<ProviderAction, ProviderError> {
        Ok(self.accept(session, input))
    }
}
pub(super) fn project(runtime: &AiSessionRuntime, id: &str) -> Value {
    let session = runtime.get(id).unwrap();
    let messages=session.turns.as_deref().unwrap_or_default().iter().flat_map(|turn| {
        turn["userMessages"].as_array().into_iter().flatten().map(|message|json!({"turnId":turn.get("providerTurnId").unwrap_or(&turn["id"]),"id":message["id"],"text":message["text"],"attachments":message["attachments"]})).collect::<Vec<_>>()
    }).collect::<Vec<_>>();
    json!({"status":session.status,"phase":session.phase,"activeTurnId":session.active_turn_id,"userPrompt":session.user_prompt,"messages":messages})
}
async fn observe(action: &'static str, fail: bool) -> Value {
    let root = tempfile::tempdir().unwrap();
    let owner = Arc::new(open(root.path()));
    let runtime = Arc::new(AiSessionRuntime::new(
        "commit",
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
    controller.register_provider(Arc::new(AcceptingProvider {
        action,
        root: root.path().to_path_buf(),
        fail,
        calls: calls.clone(),
        guard: guard.clone(),
    }));
    let mut changes = controller.subscribe_changes();
    let input:AiSessionMessageInput=serde_json::from_value(json!({"message":"Commit","mode":if action=="steer" {"steer"} else {"auto"},"attachments":[{"id":"input-commit","kind":"image","name":"input.png","mime":"image/png","size":12,"source":{"type":"inline","encoding":"base64","data":"Y29tbWl0IGJ5dGVz"}}]})).unwrap();
    let sent = controller
        .send_message(&session.id, ProviderMessageInput::from_wire(&input))
        .await;
    drop(guard.lock().unwrap().take());
    let outcome = match sent {
        Ok(sent) => json!({"ok":true,"action":sent.action.action}),
        Err(error) => {
            assert_eq!(error.code, "AI_SESSION_ATTACHMENT_IO_FAILED");
            assert_eq!(error.status_code, 500);
            assert_eq!(
                error.message,
                "AI session attachment manifest could not be persisted."
            );
            json!({"ok":false,"kind":"permission-denied"})
        }
    };
    let snapshot = capture(root.path(), &owner);
    let manifest = &snapshot["manifests"][0];
    let message_id = manifest["messageId"].as_str().unwrap().to_string();
    let attachment_id = manifest["id"].as_str().unwrap().to_string();
    let last_change = if changes.try_recv().is_ok() {
        project(&runtime, &session.id)
    } else {
        Value::Null
    };
    let mut output = json!({"outcome":outcome,"calls":calls.lock().unwrap().clone(),"session":project(&runtime,&session.id),"lastChange":last_change,"after":snapshot});
    eprintln!(
        "provider {action} fail={fail}: outcome={}, session={}, change={}",
        output["outcome"],
        output["session"],
        !output["lastChange"].is_null()
    );
    assert_eq!(
        output["outcome"],
        if fail {
            json!({"ok":false,"kind":"permission-denied"})
        } else {
            json!({"ok":true,"action":if action=="start" {"send"} else {"steer"}})
        },
        "attachment commit failure must escape accepted action"
    );
    if fail {
        let count = owner
            .commit_message(&session.id, &message_id, Some("turn-commit"))
            .unwrap();
        output["retry"] = json!({"ok":true,"count":count});
        output["afterRetry"] = capture(root.path(), &owner);
        output["sessionAfterRetry"] = project(&runtime, &session.id);
    }
    let reopened = open(root.path());
    output["reopened"] = capture(root.path(), &reopened);
    normalize(
        output,
        &[
            (&session.id, "<session>"),
            (&message_id, "<message>"),
            (&attachment_id, "<attachment>"),
        ],
    )
}
async fn compare(name: &str, action: &'static str) {
    let actual =
        json!({"success":observe(action,false).await,"failure":observe(action,true).await});
    assert_eq!(
        actual,
        fixture()["expected"][name],
        "real Node controller/Codex session control against Rust public controller"
    );
}
#[tokio::test]
async fn c04_accepted_start_commit_failure() {
    compare("C04", "start").await;
}
#[tokio::test]
async fn c05_accepted_steer_commit_failure() {
    compare("C05", "steer").await;
}
