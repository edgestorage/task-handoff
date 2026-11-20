use controlled_instance_ai_session::{
    AiSessionPersistenceSettingsError, AiSessionPersistenceSettingsStore, AiSessionRuntime,
    AiSessionStoreError,
};
use controlled_instance_protocol::AiSessionPersistenceSettingsInput;
use serde_json::{json, Value};
use std::path::Path;

const INPUT_TIME: &str = "2026-11-02T00:00:00.000Z";
const ID: &str = "ais_persistence";

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/session-persistence-parity.json"))
        .expect("Node source")
}
fn json_value(value: impl serde::Serialize) -> Value {
    serde_json::to_value(value).expect("value")
}
fn read(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).expect("disk")).expect("json")
}
fn settings_input(value: &Value) -> AiSessionPersistenceSettingsInput {
    serde_json::from_value(value.clone()).expect("settings input")
}
fn normalize(value: &mut Value, queue_id: Option<&str>) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(|item| normalize(item, queue_id)),
        Value::Object(object) => {
            for (name, item) in object {
                if name == "id" && item.as_str() == queue_id && queue_id.is_some() {
                    *item = json!("<new-queue>");
                } else if matches!(name.as_str(), "createdAt" | "updatedAt") && item != INPUT_TIME {
                    chrono::DateTime::parse_from_rfc3339(item.as_str().expect("time"))
                        .expect("ISO time");
                    *item = json!("<operation-time>");
                } else {
                    normalize(item, queue_id);
                }
            }
        }
        _ => {}
    }
}
fn obstruct(path: &Path, run: impl FnOnce()) {
    let before = std::fs::read(path).expect("before");
    let backup = path.with_extension("json.before");
    std::fs::rename(path, &backup).expect("backup");
    std::fs::create_dir(path).expect("obstruct rename destination");
    run();
    assert_eq!(std::fs::read(&backup).unwrap(), before);
    std::fs::remove_dir(path).expect("remove obstruction");
    std::fs::rename(&backup, path).expect("restore");
    assert_eq!(std::fs::read(path).unwrap(), before);
}
fn observe(name: &str) -> Value {
    let input = fixture()["input"].clone();
    let root = tempfile::tempdir().expect("tempdir");
    let dir = root.path().join("ai-sessions");
    std::fs::create_dir(&dir).unwrap();
    let session_path = dir.join(format!("{ID}.json"));
    std::fs::write(
        &session_path,
        serde_json::to_vec(&input["session"]).unwrap(),
    )
    .unwrap();
    let runtime = || AiSessionRuntime::new("standalone", Some(dir.clone()));
    let settings = || AiSessionPersistenceSettingsStore::new(root.path());
    let mut queue_id = None;
    let mut result = match name {
        "C01" => {
            let owner = runtime();
            let queued = owner
                .enqueue_message(
                    ID,
                    "queued after restart",
                    vec![],
                    input["references"].as_array().unwrap().clone(),
                    Some("auto-review"),
                    Some("message-new"),
                )
                .unwrap()
                .expect("enqueued");
            assert!(queued.queue_id.starts_with("aiq_"));
            queue_id = Some(queued.queue_id);
            owner.set_queue_paused(ID, true).unwrap();
            let live = json_value(owner.get(ID).unwrap());
            let persisted = read(&session_path);
            assert_eq!(live, persisted);
            drop(owner);
            let reopened = json_value(runtime().get(ID).unwrap());
            assert_eq!(reopened, live);
            let owner = settings();
            let written = owner.put(settings_input(&input["settings"])).unwrap();
            drop(owner);
            assert_eq!(settings().get(), written);
            json!({"live":live,"persisted":persisted,"reopened":reopened,"settings":written})
        }
        "C02" => {
            let mut extended = input["session"].clone();
            extended["futureSession"] = json!({"opaque":true});
            extended["queue"]["futureQueue"] = json!(true);
            extended["queue"]["items"][0]["futureItem"] = json!(true);
            std::fs::write(&session_path, serde_json::to_vec(&extended).unwrap()).unwrap();
            let owner = runtime();
            let loaded = json_value(owner.get(ID).unwrap());
            assert!(loaded.get("futureSession").is_none());
            assert!(loaded["queue"].get("futureQueue").is_none());
            assert!(loaded["queue"]["items"][0].get("futureItem").is_none());
            owner.set_queue_paused(ID, true).unwrap();
            let persisted = read(&session_path);
            drop(owner);
            let reopened = json_value(runtime().get(ID).unwrap());
            assert_eq!(reopened, persisted);
            json!({"loaded":loaded,"persisted":persisted,"reopened":reopened})
        }
        "C03" => {
            let results = input["settingsVersions"].as_array().unwrap().iter().map(|raw| {
            let mut extended = raw.clone();
            extended["futureSetting"] = json!({"opaque":true});
            let owner = settings();
            std::fs::create_dir_all(owner.path().parent().unwrap()).unwrap();
            std::fs::write(owner.path(), serde_json::to_vec(&extended).unwrap()).unwrap();
            let loaded = owner.get();
            assert_eq!(loaded.history_limit as u64, raw["historyLimit"].as_u64().unwrap(), "unknown fields cannot reset valid stored settings");
            assert_eq!(loaded.attachment_retention_days as u64, raw["attachmentRetentionDays"].as_u64().unwrap_or(30));
            assert_eq!(loaded.max_file_attachment_bytes, raw["maxFileAttachmentBytes"].as_u64().unwrap_or(512000));
            let updated = owner.put(settings_input(&json!({"historyLimit":loaded.history_limit+1}))).unwrap();
            assert_eq!(updated.attachment_retention_days, loaded.attachment_retention_days);
            assert_eq!(updated.max_file_attachment_bytes, loaded.max_file_attachment_bytes);
            let persisted = read(owner.path());
            drop(owner);
            let reopened = settings().get();
            assert_eq!(reopened, updated);
            assert_eq!(persisted, json_value(updated.clone()));
            json!({"loaded":loaded,"updated":updated,"persisted":persisted,"reopened":reopened})
            }).collect();
            assert!(serde_json::from_value::<AiSessionPersistenceSettingsInput>(
                json!({"historyLimit":12,"futureRequest":true})
            )
            .is_err());
            for raw in [
                json!({"schemaVersion":3,"historyLimit":0,"attachmentRetentionDays":9,"maxFileAttachmentBytes":2048,"futureSetting":true}),
                json!({"schemaVersion":3,"historyLimit":17,"attachmentRetentionDays":"nine","maxFileAttachmentBytes":2048}),
                json!({"schemaVersion":3,"historyLimit":17,"attachmentRetentionDays":9}),
            ] {
                let owner = settings();
                std::fs::write(owner.path(), serde_json::to_vec(&raw).unwrap()).unwrap();
                assert_eq!(owner.get(), AiSessionPersistenceSettingsStore::defaults());
            }
            Value::Array(results)
        }
        "C04" => {
            let owner = runtime();
            let before = json_value(owner.get(ID).unwrap());
            let revision = owner.revision();
            let last_event_at = owner.last_event_at();
            obstruct(&session_path, || {
                assert!(matches!(
                    owner.set_queue_paused(ID, true),
                    Err(AiSessionStoreError::Io(_))
                ));
                assert_eq!(json_value(owner.get(ID).unwrap()), before);
                assert_eq!(owner.revision(), revision);
                assert_eq!(owner.last_event_at(), last_event_at);
            });
            drop(owner);
            let owner = runtime();
            let reopened_before_retry = json_value(owner.get(ID).unwrap());
            assert_eq!(reopened_before_retry, before);
            let retried = json_value(owner.set_queue_paused(ID, true).unwrap());
            assert_eq!(json_value(runtime().get(ID).unwrap()), retried);
            assert_eq!(
                std::fs::read_dir(&dir).unwrap().count(),
                1,
                "no leaked temporary files"
            );
            json!({"failed":true,"changes":[],"before":before,"reopenedBeforeRetry":reopened_before_retry,"retried":retried,"persisted":read(&session_path)})
        }
        "C05" => {
            let owner = settings();
            let before = owner.put(settings_input(&input["settings"])).unwrap();
            obstruct(owner.path(), || {
                assert!(matches!(
                    owner.put(settings_input(&json!({"historyLimit":23}))),
                    Err(AiSessionPersistenceSettingsError::Io(_))
                ));
            });
            drop(owner);
            let reopened = settings().get();
            assert_eq!(reopened, before);
            let retried = settings()
                .put(settings_input(&json!({"historyLimit":23})))
                .unwrap();
            let persisted = read(settings().path());
            assert_eq!(settings().get(), retried);
            assert_eq!(persisted, json_value(retried.clone()));
            assert_eq!(
                std::fs::read_dir(settings().path().parent().unwrap())
                    .unwrap()
                    .count(),
                1
            );
            json!({"failed":true,"before":before,"reopened":reopened,"retried":retried,"persisted":persisted})
        }
        _ => panic!("unknown case"),
    };
    normalize(&mut result, queue_id.as_deref());
    result
}

macro_rules! case {
    ($test:ident, $name:literal) => {
        #[test]
        fn $test() {
            let actual = observe($name);
            assert_eq!(actual, fixture()["expected"][$name]);
        }
    };
}
case!(c01_write_drop_reopen_matches_node, "C01");
case!(
    c02_n1_unknown_fields_sanitize_and_rewrite_matches_node,
    "C02"
);
case!(
    c03_settings_unknown_fields_preserve_known_values_matches_node,
    "C03"
);
case!(
    c04_queue_atomic_failure_preserves_authority_and_retry_matches_node,
    "C04"
);
case!(c05_settings_atomic_failure_and_retry_matches_node, "C05");
