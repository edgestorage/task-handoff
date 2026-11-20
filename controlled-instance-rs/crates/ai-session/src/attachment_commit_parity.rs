use super::cleanup_parity::files;
use super::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

pub(crate) fn open(root: &Path) -> AiSessionConversationAttachmentStore {
    AiSessionConversationAttachmentStore::with_test_clock(root, || 1_793_923_200_000)
}
pub(crate) fn open_with_writer(
    root: &Path,
    writer: impl Fn(&Path, &[u8]) -> std::io::Result<()> + Send + Sync + 'static,
) -> AiSessionConversationAttachmentStore {
    let mut owner = open(root);
    owner.test_manifest_writer = Some(Box::new(writer));
    owner
}
pub(crate) fn capture(root: &Path, owner: &AiSessionConversationAttachmentStore) -> Value {
    let state = owner.lock();
    let mut manifests = state.manifests.values().cloned().collect::<Vec<_>>();
    let mut drafts = state.drafts.values().cloned().collect::<Vec<_>>();
    manifests.sort_by(|a, b| a.id.cmp(&b.id));
    drafts.sort_by(|a, b| a.id.cmp(&b.id));
    json!({"files":files(root),"manifests":manifests,"drafts":drafts})
}
pub(crate) struct ReadOnlyDirectory(PathBuf, std::fs::Permissions);
impl ReadOnlyDirectory {
    pub(crate) fn new(path: PathBuf) -> Self {
        assert_ne!(unsafe { libc::geteuid() }, 0, "non-root permission fixture");
        let permissions = std::fs::metadata(&path).unwrap().permissions();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o500)).unwrap();
        let guard = Self(path, permissions);
        assert_eq!(
            std::fs::write(guard.0.join("fault-probe"), b"")
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );
        guard
    }
}
impl Drop for ReadOnlyDirectory {
    fn drop(&mut self) {
        std::fs::set_permissions(&self.0, self.1.clone()).unwrap();
    }
}
pub(crate) fn normalize(value: Value, identities: &[(&str, &str)]) -> Value {
    match value {
        Value::String(mut text) => {
            for (id, label) in identities {
                text = text.replace(id, label);
            }
            json!(text)
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|v| normalize(v, identities))
                .collect(),
        ),
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, v)| {
                    let key = normalize(json!(key), identities)
                        .as_str()
                        .unwrap()
                        .to_string();
                    (key, normalize(v, identities))
                })
                .collect(),
        ),
        other => other,
    }
}
pub(crate) fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../tests/fixtures/attachment-commit-parity.json"
    ))
    .unwrap()
}
fn commit(owner: &AiSessionConversationAttachmentStore) -> Value {
    match owner.commit_message("session-commit", "message-commit", Some("turn-commit")) {
        Ok(count) => json!({"ok":true,"count":count}),
        Err(error) => {
            assert_eq!(error.code, "AI_SESSION_ATTACHMENT_IO_FAILED");
            assert_eq!(error.status_code, 500);
            assert_eq!(
                error.message,
                "AI session attachment manifest could not be persisted."
            );
            json!({"ok":false,"kind":"permission-denied"})
        }
    }
}
fn observe(name: &str) -> Value {
    let root = tempfile::tempdir().unwrap();
    let mut owner = open(root.path());
    let staged = owner
        .stage_message(StageMessageAttachmentsInput {
            session_id: "session-commit".into(),
            message_id: "message-commit".into(),
            attachments: vec![AiSessionMessageAttachmentInput::Inline {
                id: "input-commit".into(),
                kind: AiSessionAttachmentKind::Image,
                name: "input.png".into(),
                mime: "image/png".into(),
                size: 12,
                data: b"commit bytes".to_vec(),
            }],
            retained_attachment_ids: Vec::new(),
            runtime_path_root: None,
            draft_scope_type: None,
            draft_scope_id: None,
            draft_attachment_ids: Vec::new(),
        })
        .unwrap();
    let id = staged.attachments[0].id.clone();
    let mut output = json!({"before":capture(root.path(),&owner)});
    if name == "C01" {
        output["result"] = commit(&owner);
    } else {
        {
            let _readonly =
                ReadOnlyDirectory::new(root.path().join("ai-session-attachments/manifests"));
            output["failure"] = commit(&owner);
            output["afterFailure"] = capture(root.path(), &owner);
        }
        eprintln!("{name} commit failure result={}", output["failure"]);
        assert_eq!(
            output["failure"],
            json!({"ok":false,"kind":"permission-denied"}),
            "failed commit cannot acknowledge success"
        );
        assert_eq!(output["afterFailure"], output["before"]);
        if name == "C03" {
            drop(owner);
            owner = open(root.path());
            output["reopenedFailure"] = capture(root.path(), &owner);
        }
        output["retry"] = commit(&owner);
    }
    output["after"] = capture(root.path(), &owner);
    owner.now = || 1_793_926_800_000;
    output["repeated"] = commit(&owner);
    drop(owner);
    owner = open(root.path());
    output["reopened"] = capture(root.path(), &owner);
    normalize(output, &[(&id, "<attachment>")])
}
fn compare(name: &str) {
    assert_eq!(
        observe(name),
        fixture()["expected"][name],
        "complete Node disk/live owner"
    );
}
#[test]
fn c01_commit_repeat_reopen() {
    compare("C01");
}
#[test]
fn c02_commit_write_failure_retry() {
    compare("C02");
}
#[test]
fn c03_commit_write_failure_reopen_retry() {
    compare("C03");
}
