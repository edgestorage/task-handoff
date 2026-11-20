use super::*;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn desired() -> Value {
    json!({"historyLimit":1,"attachmentRetentionDays":14,"maxFileAttachmentBytes":2048})
}
fn initial_state(committed_at: &str) -> (AppState, tempfile::TempDir) {
    assert_ne!(
        unsafe { libc::geteuid() },
        0,
        "permission fixture requires a non-root Unix user"
    );
    let (state, root) = super::history_retention_parity::seeded_history_state_with_commit_time(Some(committed_at));
    state
        .ai_session_persistence_settings
        .put(
            serde_json::from_value(json!({
                "historyLimit":10,"attachmentRetentionDays":30,"maxFileAttachmentBytes":512000
            }))
            .unwrap(),
        )
        .unwrap();
    let config = (*state.config).clone();
    drop(state);
    (AppState::new(config, WebAuthState::disabled(None)), root)
}
pub(super) fn files(root: &Path) -> Value {
    fn walk(root: &Path, relative: &Path, result: &mut serde_json::Map<String, Value>) {
        let file = root.join(relative);
        if file.is_dir() {
            for entry in std::fs::read_dir(file).unwrap() {
                walk(root, &relative.join(entry.unwrap().file_name()), result);
            }
        } else if file.is_file() {
            let bytes = std::fs::read(&file).unwrap();
            result.insert(
                relative.to_str().unwrap().replace('\\', "/"),
                if file.extension().is_some_and(|ext| ext == "json") {
                    serde_json::from_slice(&bytes).unwrap()
                } else {
                    json!(hex::encode(bytes))
                },
            );
        }
    }
    let mut result = serde_json::Map::new();
    for directory in ["ai-session-history", "ai-session-attachments"] {
        walk(root, Path::new(directory), &mut result);
    }
    Value::Object(result)
}
fn capture(state: &AppState) -> Value {
    json!({"settings":state.ai_session_persistence_settings.get(),
        "live":{"historyLimit":state.ai_session_history.retention_limit(),
            "attachmentRetentionDays":state.ai_session_attachments.retention_days(),
            "maxFileAttachmentBytes":state.ai_session_attachments.max_file_attachment_bytes()},
        "items":state.ai_session_history.list(None),
        "files":files(&state.config.storage_paths.data_dir)})
}
async fn put(state: &AppState, payload: Value) -> Value {
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/internal/ai-session-persistence-settings")
                .header(header::AUTHORIZATION, "Bearer test-registration-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let content_type = response.headers()[header::CONTENT_TYPE].to_str().unwrap();
    assert!(matches!(
        content_type,
        "application/json" | "application/json; charset=utf-8"
    ));
    json!({"status":status,"contentType":"application/json","body":body_json(response).await})
}
pub(super) struct ReadOnlyDirectory {
    path: std::path::PathBuf,
    permissions: std::fs::Permissions,
}
impl ReadOnlyDirectory {
    pub(super) fn new(path: std::path::PathBuf) -> Self {
        let permissions = std::fs::metadata(&path).unwrap().permissions();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o500)).unwrap();
        let guard = Self { path, permissions };
        let error = std::fs::write(guard.path.join("fault-probe"), b"").unwrap_err();
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::PermissionDenied,
            "real temporary-file write must fail"
        );
        guard
    }
}
impl Drop for ReadOnlyDirectory {
    fn drop(&mut self) {
        std::fs::set_permissions(&self.path, self.permissions.clone()).unwrap();
    }
}
struct BlockedFile {
    path: std::path::PathBuf,
    backup: std::path::PathBuf,
    bytes: Vec<u8>,
}
impl BlockedFile {
    fn new(path: std::path::PathBuf) -> Self {
        let bytes = std::fs::read(&path).unwrap();
        let backup = path.with_extension("json.before");
        std::fs::rename(&path, &backup).unwrap();
        std::fs::create_dir(&path).unwrap();
        Self {
            path,
            backup,
            bytes,
        }
    }
}
impl Drop for BlockedFile {
    fn drop(&mut self) {
        std::fs::remove_dir(&self.path).unwrap();
        std::fs::rename(&self.backup, &self.path).unwrap();
        assert_eq!(std::fs::read(&self.path).unwrap(), self.bytes);
    }
}
async fn observe(name: &str) -> Value {
    let clock_start = chrono::Utc::now().timestamp_millis();
    let target = if name == "C05" {
        json!({"historyLimit":1,"attachmentRetentionDays":0,"maxFileAttachmentBytes":2048})
    } else {
        desired()
    };
    let committed_at = (chrono::Utc::now() - chrono::Duration::days(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (mut state, _root) = initial_state(&committed_at);
    let config = (*state.config).clone();
    let mut output = json!({"before":capture(&state)});
    if name == "C01" {
        output["response"] = put(&state, target.clone()).await;
        output["after"] = capture(&state);
        output["repeated"] = put(&state, target.clone()).await;
        output["afterRepeated"] = capture(&state);
        output["legacy"] = put(&state, json!({"historyLimit":2})).await;
        output["afterLegacy"] = capture(&state);
    } else {
        output["response"] = if name == "C02" {
            let _blocked =
                BlockedFile::new(state.ai_session_persistence_settings.path().to_path_buf());
            put(&state, target.clone()).await
        } else {
            let _readonly =
                ReadOnlyDirectory::new(config.storage_paths.data_dir.join(if name == "C05" {
                    "ai-session-attachments/manifests"
                } else {
                    "ai-session-history"
                }));
            put(&state, target.clone()).await
        };
        output["afterFailure"] = capture(&state);
        eprintln!(
            "{name} apply failure: response={}, settings={}, live={}, items={}",
            output["response"],
            output["afterFailure"]["settings"],
            output["afterFailure"]["live"],
            output["afterFailure"]["items"].as_array().unwrap().len()
        );
        assert_eq!(
            output["response"]["status"], 500,
            "valid desired policy failing disk apply is not invalid input"
        );
        assert_eq!(
            output["response"]["body"],
            json!({"error":{
                "code":"AI_SESSION_PERSISTENCE_SETTINGS_APPLY_FAILED",
                "message":"AI session persistence settings could not be applied."
            }})
        );
        if name == "C02" {
            assert_eq!(output["afterFailure"], output["before"]);
        } else {
            assert_eq!(
                output["afterFailure"]["settings"],
                json!({"schemaVersion":3,"historyLimit":1,"attachmentRetentionDays":if name=="C05" {0} else {14},"maxFileAttachmentBytes":2048})
            );
            assert_eq!(
                output["afterFailure"]["live"],
                json!({"historyLimit":10,"attachmentRetentionDays":if name=="C05" {0} else {14},"maxFileAttachmentBytes":if name=="C05" {512000} else {2048}})
            );
            assert_eq!(output["afterFailure"]["items"], output["before"]["items"]);
            assert_eq!(output["afterFailure"]["files"], output["before"]["files"]);
        }
        if name == "C04" {
            drop(state);
            state = AppState::new(config.clone(), WebAuthState::disabled(None));
            output["reopenedFailure"] = capture(&state);
        }
        output["retry"] = put(&state, target.clone()).await;
        output["after"] = capture(&state);
    }
    drop(state);
    state = AppState::new(config, WebAuthState::disabled(None));
    output["reopened"] = capture(&state);
    assert_eq!(
        output["reopened"],
        output[if name == "C01" {
            "afterLegacy"
        } else {
            "after"
        }]
    );
    if name == "C05" {
        fn normalize(value: &mut Value, start: i64, end: i64, deletion_time: &mut Option<String>) {
            match value {
                Value::Object(fields) => {
                    for (key, child) in fields {
                        if key == "contentDeletedAt" {
                            let timestamp = child.as_str().unwrap().to_string();
                            let millis = chrono::DateTime::parse_from_rfc3339(&timestamp)
                                .unwrap()
                                .timestamp_millis();
                            assert!(
                                (start..=end).contains(&millis),
                                "GC time must belong to this request window"
                            );
                            assert_eq!(deletion_time.get_or_insert(timestamp.clone()), &timestamp);
                            *child = json!("<gc-time>");
                        } else {
                            normalize(child, start, end, deletion_time);
                        }
                    }
                }
                Value::Array(items) => {
                    for child in items {
                        normalize(child, start, end, deletion_time);
                    }
                }
                _ => (),
            }
        }
        let mut deletion_time = None;
        normalize(
            &mut output,
            clock_start,
            chrono::Utc::now().timestamp_millis(),
            &mut deletion_time,
        );
        assert!(deletion_time.is_some());
    }
    for snapshot in output.as_object_mut().unwrap().values_mut() {
        if let Some(files) = snapshot.get_mut("files").and_then(Value::as_object_mut) {
            for (name, manifest) in files {
                if name.starts_with("ai-session-attachments/manifests/") {
                    assert_eq!(manifest["committedAt"], committed_at);
                    manifest["committedAt"] = json!("2026-11-05T00:00:00.000Z");
                }
            }
        }
    }
    output
}
async fn compare(name: &str) {
    let actual = observe(name).await;
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(root.join("tests/fixtures/settings-apply-parity.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        actual, fixture["expected"][name],
        "full Node HTTP/policy/files observation"
    );
}
#[tokio::test]
async fn c01_success_repeat_and_legacy_input() {
    compare("C01").await;
}
#[tokio::test]
async fn c02_settings_write_failure_retry() {
    compare("C02").await;
}
#[tokio::test]
async fn c03_history_apply_failure_retry() {
    compare("C03").await;
}
#[tokio::test]
async fn c04_history_apply_failure_reopen_retry() {
    compare("C04").await;
}

#[tokio::test]
async fn c05_gc_manifest_failure_settings_retry() {
    let actual = observe("C05").await;
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../ai-session/tests/fixtures/attachment-gc-parity.json"
    )))
    .unwrap();
    assert_eq!(
        actual, fixture["expected"]["C04"],
        "complete Node settings GC failure observation"
    );
}
