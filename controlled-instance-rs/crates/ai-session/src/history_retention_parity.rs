use super::*;
use crate::AiSessionConversationAttachmentStore;
use std::sync::{atomic::AtomicBool, Arc};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../tests/fixtures/history-retention-parity.json"
    ))
    .unwrap()
}
fn files(root: &Path, raw: bool) -> Value {
    fn walk(root: &Path, relative: &Path, raw: bool, output: &mut Map<String, Value>) {
        let path = root.join(relative);
        if !path.exists() {
            return;
        }
        if path.is_dir() {
            let mut children = std::fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>();
            children.sort();
            for child in children {
                walk(root, &relative.join(child), raw, output);
            }
        } else {
            let bytes = std::fs::read(&path).unwrap();
            let value = if raw || path.extension().is_none_or(|extension| extension != "json") {
                json!(hex::encode(bytes))
            } else {
                serde_json::from_slice(&bytes).unwrap()
            };
            output.insert(relative.to_str().unwrap().replace('\\', "/"), value);
        }
    }
    let mut output = Map::new();
    for directory in ["ai-session-history", "ai-session-attachments"] {
        walk(root, Path::new(directory), raw, &mut output);
    }
    Value::Object(output)
}
fn capture(root: &Path, owner: &AiSessionHistoryStore) -> Value {
    json!({"limit":owner.retention_limit(),"items":owner.list(None),"files":files(root,false)})
}
fn obstruct<T>(path: &Path, run: impl FnOnce() -> T) -> T {
    let before = std::fs::read(path).unwrap();
    let backup = path.with_extension("json.before");
    std::fs::rename(path, &backup).unwrap();
    std::fs::create_dir(path).unwrap();
    let result = run();
    std::fs::remove_dir(path).unwrap();
    std::fs::rename(backup, path).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), before);
    result
}
fn owner(
    root: &Path,
    limit: usize,
    resources: &Arc<AiSessionConversationAttachmentStore>,
) -> AiSessionHistoryStore {
    let resources = resources.clone();
    AiSessionHistoryStore::with_resource_releaser(root, Some(limit), move |id| {
        resources.release_session(id);
    })
}
fn remove(owner: &AiSessionHistoryStore, variant: &str) -> bool {
    match variant {
        "remove" => owner.remove("history-old-root"),
        "activate" => owner.activate("history-old-root"),
        "identity" => owner.activate_identity("codex", "provider-old-root"),
        _ => panic!("variant"),
    }
    .unwrap()
}

// Capture the production warning at the filesystem boundary; a failed unlink
// must not become silent or turn an already committed removal into a rollback.
struct Warnings(Arc<AtomicBool>);
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
        struct Visitor(bool);
        impl tracing::field::Visit for Visitor {
            fn record_debug(&mut self, _: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                self.0 |= format!("{value:?}").contains("history detail cleanup failed");
            }
        }
        let mut visitor = Visitor(false);
        event.record(&mut visitor);
        if visitor.0 {
            self.0.store(true, Ordering::SeqCst);
        }
    }
}

fn observe(name: &str) -> Value {
    if name == "C01" || name == "C02" || name == "C04" {
        let variants: &[&str] = if name == "C01" {
            &["limit", "upsert"]
        } else {
            &["remove", "activate", "identity"]
        };
        return Value::Object(
            variants
                .iter()
                .map(|variant| (variant.to_string(), observe(&format!("{name}-{variant}"))))
                .collect(),
        );
    }
    let input = fixture()["input"].clone();
    let root = tempfile::tempdir().unwrap();
    for (relative, value) in input["files"].as_object().unwrap() {
        let file = root.path().join(relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, hex::decode(value.as_str().unwrap()).unwrap()).unwrap();
    }
    let index = root.path().join("ai-session-history/index.json");
    let mut resources = Arc::new(AiSessionConversationAttachmentStore::new(root.path()));
    let mut store = owner(root.path(), 10, &resources);
    let result = if name.starts_with("C01-") {
        if name == "C01-limit" {
            let applied = store.set_retention_limit(1).unwrap();
            json!({"limit":applied.limit,"removedIds":applied.removed_ids})
        } else {
            store.set_retention_limit(2).unwrap();
            json!(store
                .upsert(
                    serde_json::from_value(input["items"][3].clone()).unwrap(),
                    &[]
                )
                .unwrap())
        }
    } else if let Some(variant) = name.strip_prefix("C02-") {
        json!(remove(&store, variant))
    } else if name == "C03" || name.starts_with("C04-") {
        let before = files(root.path(), true);
        let mut attempted = false;
        let mut writer = |items: &[AiSessionHistoryItem]| {
            attempted = true;
            obstruct(&index, || store.write_index(items))
        };
        let failed = if name == "C03" {
            store
                .set_retention_limit_with_index_writer(1, &mut writer)
                .map(|_| ())
        } else {
            store
                .remove_selected_with_index_writer(
                    |items| match &name[4..] {
                        "remove" => subtree_ids(items, "history-old-root"),
                        "activate" => HashSet::from(["history-old-root".to_string()]),
                        "identity" => items
                            .iter()
                            .filter(|item| {
                                item.agent == "codex"
                                    && item.provider_session_id == "provider-old-root"
                            })
                            .map(|item| item.id.clone())
                            .collect(),
                        _ => unreachable!(),
                    },
                    name.ends_with("-remove"),
                    &mut writer,
                )
                .map(|_| ())
        };
        assert!(attempted);
        assert!(matches!(failed, Err(AiSessionHistoryError::Io(_))));
        assert_eq!(
            store.retention_limit(),
            10,
            "failed commit must preserve active retention limit"
        );
        assert_eq!(files(root.path(), true), before);
        let after_failure = capture(root.path(), &store);
        assert_eq!(
            files(root.path(), true),
            before,
            "reads must not silently evict after failure"
        );
        drop(store);
        drop(resources);
        resources = Arc::new(AiSessionConversationAttachmentStore::new(root.path()));
        store = owner(root.path(), 10, &resources);
        let reopened = capture(root.path(), &store);
        let retry = if name == "C03" {
            let applied = store.set_retention_limit(1).unwrap();
            json!({"limit":applied.limit,"removedIds":applied.removed_ids})
        } else {
            json!(remove(&store, &name[4..]))
        };
        json!({"failed":true,"afterFailure":after_failure,"reopened":reopened,"retry":retry})
    } else {
        assert_eq!(name, "C05");
        let target = store.detail_path("history-old-child");
        let warned = Arc::new(AtomicBool::new(false));
        let removed = tracing::subscriber::with_default(Warnings(warned.clone()), || {
            obstruct(&target, || store.remove("history-old-root"))
        })
        .unwrap();
        assert!(
            warned.load(Ordering::SeqCst),
            "failed detail unlink must be diagnosed"
        );
        assert!(target.exists());
        json!({"removed":removed,"cleanupWarned":true,"repeated":store.remove("history-old-root").unwrap()})
    };
    let after = capture(root.path(), &store);
    let limit = store.retention_limit();
    drop(store);
    drop(resources);
    let resources = Arc::new(AiSessionConversationAttachmentStore::new(root.path()));
    let reopened = capture(root.path(), &owner(root.path(), limit, &resources));
    assert_eq!(after, reopened);
    json!({"result":result,"after":after,"reopened":reopened})
}
macro_rules! case {
    ($test:ident, $name:literal) => {
        #[test]
        fn $test() {
            assert_eq!(observe($name), fixture()["expected"][$name]);
        }
    };
}
case!(
    c01_retention_and_insert_evict_whole_trees_and_release_resources,
    "C01"
);
case!(
    c02_delete_releases_subtree_but_activation_preserves_resources,
    "C02"
);
case!(
    c03_failed_retention_commit_preserves_policy_data_and_retry,
    "C03"
);
case!(
    c04_failed_removal_or_activation_preserves_data_and_retry,
    "C04"
);
case!(
    c05_detail_cleanup_failure_is_diagnosed_without_revival,
    "C05"
);
