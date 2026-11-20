use super::*;

pub(super) fn seeded_history_state() -> (AppState, tempfile::TempDir) {
    seeded_history_state_with_commit_time(None)
}

pub(super) fn seeded_history_state_with_commit_time(
    committed_at: Option<&str>,
) -> (AppState, tempfile::TempDir) {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../ai-session/tests/fixtures/history-retention-parity.json"
    )))
    .unwrap();
    let (bootstrap, root) = test_state();
    let config = (*bootstrap.config).clone();
    let models = bootstrap.controlled_models.clone();
    let environment = bootstrap.config_sync_environment.clone();
    drop(bootstrap);
    let data = &config.storage_paths.data_dir;
    for (relative, value) in fixture["input"]["files"].as_object().unwrap() {
        let file = data.join(relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let bytes = hex::decode(value.as_str().unwrap()).unwrap();
        if let Some(committed_at) = committed_at.filter(|_| relative.starts_with("ai-session-attachments/manifests/")) {
            let mut record: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(record["committedAt"], "2026-11-05T00:00:00.000Z");
            record["committedAt"] = json!(committed_at);
            std::fs::write(file, serde_json::to_vec(&record).unwrap()).unwrap();
        } else {
            std::fs::write(file, bytes).unwrap();
        }
    }
    // Construct after restoring the source files so the real AppState owns
    // the loaded attachment manifests and its real history release wiring.
    let mut state = AppState::new(config.clone(), WebAuthState::disabled(None));
    state.controlled_models = models;
    state.config_sync_environment = environment;
    (state, root)
}

#[tokio::test]
async fn history_retention_settings_release_evicted_resources_through_production_owner() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../ai-session/tests/fixtures/history-retention-parity.json"
    )))
    .unwrap();
    let (state, _root) = seeded_history_state();
    let data = state.config.storage_paths.data_dir.clone();
    let app = router(state.clone());
    let response = app.oneshot(Request::builder().method("PUT")
        .uri("/api/internal/ai-session-persistence-settings")
        .header(header::CONTENT_TYPE,"application/json")
        .header(header::AUTHORIZATION,"Bearer test-registration-token")
        .body(Body::from(r#"{"historyLimit":1,"attachmentRetentionDays":30,"maxFileAttachmentBytes":512000}"#)).unwrap())
        .await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result = body_json(response).await;
    assert_eq!(result["data"]["removedHistoryCount"], 2);
    assert_eq!(state.ai_session_history.retention_limit(), 1);
    let expected = &fixture["expected"]["C01"]["limit"]["after"]["files"];
    let manifests = data.join("ai-session-attachments/manifests");
    let actual = std::fs::read_dir(&manifests)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let record: Value =
                serde_json::from_slice(&std::fs::read(entry.path()).unwrap()).unwrap();
            (
                format!(
                    "ai-session-attachments/manifests/{}",
                    entry.file_name().to_str().unwrap()
                ),
                record,
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let expected_manifests = expected
        .as_object()
        .unwrap()
        .iter()
        .filter(|(name, _)| name.starts_with("ai-session-attachments/manifests/"))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    assert_eq!(
        actual, expected_manifests,
        "production settings apply must release every evicted owner"
    );
    let blobs = std::fs::read_dir(data.join("ai-session-attachments/blobs"))
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                format!(
                    "ai-session-attachments/blobs/{}",
                    entry.file_name().to_str().unwrap()
                ),
                json!(hex::encode(std::fs::read(entry.path()).unwrap())),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let expected_blobs = expected
        .as_object()
        .unwrap()
        .iter()
        .filter(|(name, _)| name.starts_with("ai-session-attachments/blobs/"))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    assert_eq!(
        blobs, expected_blobs,
        "shared survivor content must stay available"
    );
    drop(state);
}

#[tokio::test]
async fn history_settings_cleanup_failure_keeps_disk_attachment_owner_and_content_retryable() {
    let (state, _root) = seeded_history_state();
    let data = state.config.storage_paths.data_dir.clone();
    let manifests = data.join("ai-session-attachments/manifests");
    let (target, record) = std::fs::read_dir(manifests)
        .unwrap()
        .map(|entry| {
            let file = entry.unwrap().path();
            let record: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
            (file, record)
        })
        .find(|(_, record)| record["sessionId"] == "history-old-child")
        .unwrap();
    let bytes = std::fs::read(&target).unwrap();
    let backup = target.with_extension("json.before");
    std::fs::rename(&target, &backup).unwrap();
    std::fs::create_dir(&target).unwrap();
    let app = router(state.clone());
    let response = app.clone().oneshot(Request::builder().method("PUT")
        .uri("/api/internal/ai-session-persistence-settings")
        .header(header::CONTENT_TYPE,"application/json")
        .header(header::AUTHORIZATION,"Bearer test-registration-token")
        .body(Body::from(r#"{"historyLimit":1,"attachmentRetentionDays":30,"maxFileAttachmentBytes":512000}"#)).unwrap())
        .await.unwrap();
    std::fs::remove_dir(&target).unwrap();
    std::fs::rename(&backup, &target).unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        body_json(response).await["data"],
        json!({"applied":true,"historyLimit":1,
        "attachmentRetentionDays":30,"maxFileAttachmentBytes":512000,"removedHistoryCount":2})
    );
    assert_eq!(
        state
            .ai_session_history
            .list(None)
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["history-new-root"]
    );
    assert_eq!(
        std::fs::read(&target).unwrap(),
        bytes,
        "failed cleanup cannot alter its disk owner"
    );
    let content_url = format!("/api/ai-sessions/history-old-child/messages/message-history-old-child/attachments/{}/content",record["id"].as_str().unwrap());
    let response = get_json(&app, &content_url).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .as_ref(),
        b"child bytes"
    );
    let config = (*state.config).clone();
    drop(app);
    drop(state);
    let state = AppState::new(config, WebAuthState::disabled(None));
    assert_eq!(state.ai_session_history.list(None).len(), 1);
    assert_eq!(
        state
            .ai_session_attachments
            .content(
                "history-old-child",
                "message-history-old-child",
                record["id"].as_str().unwrap()
            )
            .unwrap()
            .attachment
            .content_state,
        controlled_instance_protocol::AiSessionAttachmentContentState::Available
    );
    assert_eq!(
        state
            .ai_session_attachments
            .release_session("history-old-child"),
        1
    );
    assert_eq!(
        state
            .ai_session_attachments
            .release_session("history-old-child"),
        0
    );
    assert!(!target.exists());
    assert!(!data
        .join("ai-session-attachments/blobs")
        .join(record["blobHash"].as_str().unwrap())
        .exists());
    assert_eq!(
        std::fs::read_dir(data.join("ai-session-attachments/blobs"))
            .unwrap()
            .count(),
        1,
        "new-root still owns the shared blob"
    );
}
