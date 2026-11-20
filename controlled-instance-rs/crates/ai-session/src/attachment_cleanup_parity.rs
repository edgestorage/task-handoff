use super::*;
use crate::AiSessionHistoryStore;
use serde_json::{json, Map};

pub(super) fn input() -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/history-retention-parity.json"
    ))
    .unwrap();
    fixture["input"].clone()
}

pub(super) fn files(root: &Path) -> Value {
    fn walk(root: &Path, relative: &Path, output: &mut Map<String, Value>) {
        let file = root.join(relative);
        if file.is_dir() {
            for entry in std::fs::read_dir(file).unwrap() {
                walk(root, &relative.join(entry.unwrap().file_name()), output);
            }
        } else if file.is_file() {
            let bytes = std::fs::read(&file).unwrap();
            output.insert(
                relative.to_str().unwrap().replace('\\', "/"),
                if file.extension().is_some_and(|ext| ext == "json") {
                    serde_json::from_slice(&bytes).unwrap()
                } else {
                    json!(hex::encode(bytes))
                },
            );
        }
    }
    let mut result = Map::new();
    for directory in ["ai-session-history", "ai-session-attachments"] {
        walk(root, Path::new(directory), &mut result);
    }
    Value::Object(result)
}

pub(super) fn open(root: &Path) -> Arc<AiSessionConversationAttachmentStore> {
    let mut owner = AiSessionConversationAttachmentStore::new(root);
    owner.now = || 1_793_836_800_000;
    Arc::new(owner)
}

fn history(
    root: &Path,
    resources: &Arc<AiSessionConversationAttachmentStore>,
) -> AiSessionHistoryStore {
    let resources = Arc::clone(resources);
    AiSessionHistoryStore::with_resource_releaser(root, Some(10), move |id| {
        resources.release_session(id);
    })
}

fn capture(root: &Path, owner: &Arc<AiSessionConversationAttachmentStore>) -> Value {
    let source = input();
    let mut messages = Map::new();
    for role in ["old-child", "old-root", "new-root"] {
        let session = format!("history-{role}");
        let message = format!("message-{session}");
        let id = source["files"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(name, _)| name.contains("/manifests/"))
            .map(|(_, bytes)| {
                serde_json::from_slice::<Value>(&hex::decode(bytes.as_str().unwrap()).unwrap())
                    .unwrap()
            })
            .find(|record| record["sessionId"] == session)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let attachments = owner.attachments_for_message(&session, &message);
        let content = match owner.content(&session, &message, &id) {
            Ok(result) => json!({"attachment":result.attachment,
                "path":result.path.strip_prefix(root).unwrap().to_str().unwrap().replace('\\',"/"),
                "bytes":hex::encode(std::fs::read(result.path).unwrap()),
                "etag":result.etag,"cacheUntil":result.cache_until}),
            Err(error) => {
                json!({"code":error.code,"statusCode":error.status_code,"message":error.message})
            }
        };
        messages.insert(
            role.to_string(),
            json!({"attachments":attachments,"content":content}),
        );
    }
    json!({"items":history(root,owner).list(None),"messages":messages,"files":files(root)})
}

#[derive(Clone, Default)]
struct Warnings(Arc<Mutex<Vec<String>>>);
impl tracing::Subscriber for Warnings {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        #[derive(Default)]
        struct Visitor {
            id: Option<String>,
            cleanup: bool,
        }
        impl tracing::field::Visit for Visitor {
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                if field.name() == "id" {
                    self.id = Some(value.to_string());
                }
            }
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                if field.name() == "message" {
                    self.cleanup |=
                        format!("{value:?}").contains("attachment manifest cleanup failed");
                }
            }
        }
        let mut visitor = Visitor::default();
        event.record(&mut visitor);
        if visitor.cleanup {
            self.0.lock().unwrap().push(format!(
                "attachment manifest cleanup failed for {}",
                visitor.id.expect("cleanup owner ID")
            ));
        }
    }
}

fn observe(name: &str) -> Value {
    if name == "C02" {
        return json!({"live":observe("C02-live"),"reopen":observe("C02-reopen")});
    }
    let source = input();
    let root = tempfile::tempdir().unwrap();
    for (file, bytes) in source["files"].as_object().unwrap() {
        let file = root.path().join(file);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, hex::decode(bytes.as_str().unwrap()).unwrap()).unwrap();
    }
    let target = source["files"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(file, _)| file.contains("/manifests/"))
        .find(|(_, bytes)| {
            serde_json::from_slice::<Value>(&hex::decode(bytes.as_str().unwrap()).unwrap()).unwrap()
                ["sessionId"]
                == "history-old-child"
        })
        .unwrap()
        .0;
    let target = root.path().join(target);
    let warnings = Warnings::default();
    let _subscriber = tracing::subscriber::set_default(warnings.clone());
    let mut owner = open(root.path());
    let mut output = json!({});
    if name.starts_with("C02-") || name == "C04" {
        let backup = target.with_extension("json.before");
        std::fs::rename(&target, &backup).unwrap();
        std::fs::create_dir(&target).unwrap();
        output["result"] = if name == "C04" {
            json!(history(root.path(), &owner)
                .remove("history-old-root")
                .unwrap())
        } else {
            json!(owner.release_session("history-old-child"))
        };
        std::fs::remove_dir(&target).unwrap();
        std::fs::rename(&backup, &target).unwrap();
        output["afterFailure"] = capture(root.path(), &owner);
        assert_eq!(
            output["afterFailure"]["messages"]["old-child"]["content"]["attachment"]
                ["contentState"],
            "available",
            "failed unlink must retain durable ownership and content"
        );
        assert_eq!(
            output["result"],
            if name == "C04" { json!(true) } else { json!(0) }
        );
        if name == "C02-reopen" || name == "C04" {
            owner = open(root.path());
            output["reopenedFailure"] = capture(root.path(), &owner);
            assert_eq!(output["reopenedFailure"], output["afterFailure"]);
        }
        output["retry"] = json!(owner.release_session("history-old-child"));
    } else {
        if name == "C03" {
            std::fs::remove_file(&target).unwrap();
        }
        output["result"] = json!(owner.release_session("history-old-child"));
    }
    output["after"] = capture(root.path(), &owner);
    output["repeated"] = json!(owner.release_session("history-old-child"));
    owner = open(root.path());
    output["reopened"] = capture(root.path(), &owner);
    assert_eq!(output["reopened"], output["after"]);
    output["warnings"] = json!(*warnings.0.lock().unwrap());
    output
}

fn compare(name: &str) {
    let actual = observe(name);
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(root.join("tests/fixtures/attachment-cleanup-parity.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        actual, fixture["expected"][name],
        "complete fixed Node owner/files/content observation"
    );
}
#[test]
fn c01_successful_release() {
    compare("C01");
}
#[test]
fn c02_failed_manifest_unlink() {
    compare("C02");
}
#[test]
fn c03_missing_manifest() {
    compare("C03");
}
#[test]
fn c04_history_commit_then_cleanup_failure() {
    compare("C04");
}
