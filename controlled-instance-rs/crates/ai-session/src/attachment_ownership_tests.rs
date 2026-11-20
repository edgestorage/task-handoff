use super::*;
use serde_json::json;

fn fixed_now() -> i64 {
    static START: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *START.get_or_init(now_millis)
}

fn observe_upload_ownership(scenario: &Value) -> Value {
    let root = tempfile::tempdir().expect("isolated store");
    let mut store = AiSessionConversationAttachmentStore::new(root.path());
    store.now = fixed_now;
    let store = Arc::new(store);
    let streams = store.draft_streams();
    let first_id = "cia_000000000000000000000001";
    let same_id = scenario["sameId"].as_bool().expect("same ID flag");
    let survivor_id = if same_id {
        first_id
    } else {
        "cia_000000000000000000000002"
    };
    let input = |id: &str| AiSessionAttachmentDraftStreamBegin {
        attachment_id: id.to_string(),
        scope_type: AiSessionAttachmentScopeType::CreateRequest,
        scope_id: "source-test".to_string(),
        kind: AiSessionAttachmentKind::File,
        name: "notes.txt".to_string(),
        mime: "text/plain".to_string(),
        size: 3,
    };
    streams.begin(input(first_id)).expect("first begin");
    if !same_id {
        streams.begin(input(survivor_id)).expect("survivor begin");
    }
    let error_value = |error: AiSessionAttachmentError| {
        json!({
            "code": error.code, "message": error.message, "statusCode": error.status_code
        })
    };
    let mut owned_completion = None;
    let mut first = match scenario["action"].as_str().expect("action") {
        "fail" => {
            let failure = streams
                .append(first_id, 0, b"TOOLONG")
                .expect_err("first append must fail");
            assert_eq!(failure.code, "AI_SESSION_ATTACHMENT_SIZE_MISMATCH");
            let completion = streams
                .complete(first_id)
                .expect_err("failed upload cannot complete");
            assert_eq!(completion.code, failure.code);
            error_value(completion)
        }
        "cancel" => streams.cancel(first_id).expect("cancel first"),
        "complete" => {
            // Stop at complete()'s ownership handoff after removing the map
            // entry/releasing its lock. Resume the exact production completion
            // owner after a new request registers the same wire ID. No I/O
            // result is mocked and no scheduler timing or sleep is required.
            owned_completion = streams.streams.lock().expect("streams").remove(first_id);
            assert!(owned_completion.is_some());
            Value::Null
        }
        other => panic!("unknown action {other}"),
    };
    if same_id {
        streams
            .begin(input(survivor_id))
            .expect("replacement begin");
    }
    if let Some(old) = owned_completion {
        first = error_value(
            streams
                .complete_owned_stream(old)
                .expect_err("old short upload must fail"),
        );
    }
    let offset = streams
        .append(survivor_id, 0, b"ABC")
        .expect("survivor must retain its own upload file");
    let draft = streams
        .complete(survivor_id)
        .expect("surviving upload completes");
    assert_eq!(draft.id, survivor_id);
    let manifest: DraftManifest = serde_json::from_slice(
        &std::fs::read(store.draft_path(survivor_id)).expect("durable draft"),
    )
    .expect("draft manifest");
    let bytes = std::fs::read(store.blob_path(&manifest.blob_hash)).expect("surviving bytes");
    assert_eq!(bytes, b"ABC");
    let sha256 = hex::encode(Sha256::digest(b"ABC"));
    assert_eq!(manifest.blob_hash, sha256);
    let reopened = AiSessionConversationAttachmentStore::new(root.path());
    let staged = reopened
        .stage_message(StageMessageAttachmentsInput {
            session_id: "ses_upload".to_string(),
            message_id: "msg_upload".to_string(),
            attachments: Vec::new(),
            retained_attachment_ids: Vec::new(),
            runtime_path_root: None,
            draft_scope_type: Some(AiSessionAttachmentScopeType::CreateRequest),
            draft_scope_id: Some("source-test".to_string()),
            draft_attachment_ids: vec![survivor_id.to_string()],
        })
        .expect("stage reopened draft");
    assert_eq!(staged.attachments[0].id, survivor_id);
    let reopened_bytes =
        std::fs::read(&staged.provider_attachments[0].retained_path).expect("reopened bytes");
    let mut remaining_blobs = std::fs::read_dir(&store.blob_dir)
        .expect("blobs")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    remaining_blobs.sort();
    assert_eq!(
        std::fs::read_dir(&streams.upload_dir)
            .expect("uploads")
            .count(),
        0
    );
    json!({"first": first, "offset": offset,
        "survivor": {"id": draft.id, "size": draft.size, "hex": hex::encode(bytes), "sha256": sha256,
            "scopeType": manifest.scope_type, "scopeId": manifest.scope_id,
            "ttlMs": parse_iso(&manifest.expires_at).expect("expiry") - parse_iso(&manifest.created_at).expect("created")},
        "reopenedHex": hex::encode(reopened_bytes), "remainingBlobs": remaining_blobs})
}

fn run_case(name: &str) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/attachment-upload-ownership.json"
    ))
    .expect("fixed corrected Node output");
    let scenario = fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|scenario| scenario["name"] == name)
        .expect("named scenario");
    assert_eq!(
        observe_upload_ownership(scenario),
        scenario["expected"],
        "{name}: ownership contract"
    );
}

#[test]
fn different_id_failure() {
    run_case("different-id-failure");
}
#[test]
fn different_id_cancel() {
    run_case("different-id-cancel");
}
#[test]
fn same_id_cancel_replacement() {
    run_case("same-id-cancel-replacement");
}
#[test]
fn same_id_short_complete_replacement() {
    run_case("same-id-short-complete-replacement");
}
