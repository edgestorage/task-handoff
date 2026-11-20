use super::cleanup_parity::{files, input, open};
use super::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

fn capture(root: &Path, owner: &AiSessionConversationAttachmentStore) -> Value {
    let mut manifests = owner.lock().manifests.values().cloned().collect::<Vec<_>>();
    manifests.sort_by(|a, b| a.id.cmp(&b.id));
    json!({"retentionDays":owner.retention_days(),"manifests":manifests,"files":files(root)})
}
fn apply(owner: &AiSessionConversationAttachmentStore) -> Value {
    match owner.set_retention_days(0) {
        Ok(result) => json!({"ok":true,"removedDrafts":result.0,"expiredContent":result.1}),
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
struct ReadOnlyDirectory(PathBuf, std::fs::Permissions);
impl ReadOnlyDirectory {
    fn new(path: PathBuf) -> Self {
        assert_ne!(
            unsafe { libc::geteuid() },
            0,
            "non-root Unix permission fixture"
        );
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
fn observe(name: &str) -> Value {
    let root = tempfile::tempdir().unwrap();
    for (relative, hex) in input()["files"].as_object().unwrap() {
        let file = root.path().join(relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, hex::decode(hex.as_str().unwrap()).unwrap()).unwrap();
    }
    let mut owner = open(root.path());
    let mut output = json!({"before":capture(root.path(),&owner)});
    if name == "C01" {
        output["result"] = apply(&owner);
    } else {
        {
            let _readonly =
                ReadOnlyDirectory::new(root.path().join("ai-session-attachments/manifests"));
            output["failure"] = apply(&owner);
            output["afterFailure"] = capture(root.path(), &owner);
        }
        eprintln!("{name} GC failure result={}", output["failure"]);
        assert_eq!(
            output["failure"],
            json!({"ok":false,"kind":"permission-denied"}),
            "failed manifest write must not report expired content success"
        );
        assert_eq!(output["afterFailure"]["files"], output["before"]["files"]);
        assert_eq!(
            output["afterFailure"]["manifests"],
            output["before"]["manifests"]
        );
        if name == "C03" {
            drop(owner);
            owner = open(root.path());
            output["reopenedFailure"] = capture(root.path(), &owner);
        }
        output["retry"] = apply(&owner);
    }
    output["after"] = capture(root.path(), &owner);
    let repeated = owner.gc().unwrap();
    output["repeated"] = json!({"removedDrafts":repeated.0,"expiredContent":repeated.1});
    drop(owner);
    owner = open(root.path());
    output["reopened"] = capture(root.path(), &owner);
    output
}
fn compare(name: &str) {
    let actual = observe(name);
    let fixture: Value =
        serde_json::from_str(include_str!("../tests/fixtures/attachment-gc-parity.json")).unwrap();
    assert_eq!(
        actual, fixture["expected"][name],
        "complete Node owner observation"
    );
}
#[test]
fn c01_expiry_repeat_reopen() {
    compare("C01");
}
#[test]
fn c02_manifest_failure_retry() {
    compare("C02");
}
#[test]
fn c03_manifest_failure_reopen_retry() {
    compare("C03");
}
