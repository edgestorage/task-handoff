use super::settings_apply_parity::{files, ReadOnlyDirectory};
use super::*;
use sha2::{Digest, Sha256};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/attachment-read-gc-parity.json"
    ))
    .unwrap()
}
fn capture(state: &AppState, id: &str) -> Value {
    json!({"files":files(&state.config.storage_paths.data_dir),"rawTurns":state.ai_sessions.get(id).unwrap().turns})
}
async fn get(state: &AppState, path: &str, revision: Option<&str>) -> Value {
    let mut url = path.to_string();
    if let Some(revision) = revision {
        url.push(if path.contains('?') { '&' } else { '?' });
        url.push_str("revision=");
        url.push_str(revision);
    }
    let response = router(state.clone())
        .oneshot(Request::builder().uri(url).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    assert!(matches!(
        response.headers()[header::CONTENT_TYPE].to_str().unwrap(),
        "application/json" | "application/json; charset=utf-8"
    ));
    json!({"status":status,"contentType":"application/json","body":body_json(response).await})
}
fn normalize_clocks(
    value: &mut Value,
    seed: &str,
    start: i64,
    end: i64,
    deletion_time: &mut Option<String>,
) {
    match value {
        Value::Array(values) => {
            for value in values {
                normalize_clocks(value, seed, start, end, deletion_time)
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if (key == "createdAt" || key == "committedAt") && value.as_str() == Some(seed) {
                    *value = json!("<seed-time>");
                } else if key == "contentDeletedAt" {
                    let time = value.as_str().unwrap();
                    let ms = chrono::DateTime::parse_from_rfc3339(time)
                        .unwrap()
                        .timestamp_millis();
                    assert!(ms >= start && ms <= end);
                    if let Some(previous) = deletion_time {
                        assert_eq!(previous, time);
                    } else {
                        *deletion_time = Some(time.into());
                    }
                    *value = json!("<gc-time>");
                } else {
                    normalize_clocks(value, seed, start, end, deletion_time)
                }
            }
        }
        _ => {}
    }
}
async fn observe(name: &str, endpoint: &str) -> Value {
    assert_ne!(
        unsafe { libc::geteuid() },
        0,
        "non-root Unix permission fixture"
    );
    let start = chrono::Utc::now().timestamp_millis();
    let seed = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let input = fixture()["input"].clone();
    let id = input["session"]["id"].as_str().unwrap();
    let attachment = &input["attachment"];
    let (original, _root) = test_state_standalone();
    let config = (*original.config).clone();
    drop(original);
    let root = &config.storage_paths.data_dir;
    let hash = hex::encode(Sha256::digest(b"read bytes"));
    let manifest = json!({"schemaVersion":1,"id":attachment["id"],"inputId":"input-read","sessionId":id,"messageId":"message-read","turnId":"turn-read",
        "kind":attachment["kind"],"name":attachment["name"],"mime":attachment["mime"],"size":attachment["size"],"blobHash":hash,"sourceType":"inline","state":"committed","createdAt":seed,"committedAt":seed});
    std::fs::write(
        root.join("ai-session-attachments/blobs").join(&hash),
        b"read bytes",
    )
    .unwrap();
    std::fs::write(
        root.join("ai-session-attachments/manifests")
            .join(format!("{}.json", attachment["id"].as_str().unwrap())),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let state = AppState::new(config, WebAuthState::disabled(None));
    state
        .ai_sessions
        .save(serde_json::from_value(input["session"].clone()).unwrap())
        .unwrap();
    state
        .ai_session_history
        .upsert(
            serde_json::from_value(input["item"].clone()).unwrap(),
            &[input["historyTurn"].clone()],
        )
        .unwrap();
    let path = match endpoint {
        "history" => format!("/api/ai-sessions/history/{id}"),
        "detail" => format!("/api/ai-sessions/{id}"),
        "turns" => format!("/api/ai-sessions/{id}/turns"),
        "index" => format!("/api/ai-sessions/{id}/turns?projection=index"),
        "single" => format!("/api/ai-sessions/{id}/turns/turn-read"),
        _ => unreachable!(),
    };
    let mut output = json!({"before":capture(&state,id),"initial":get(&state,&path,None).await});
    assert_eq!(output["initial"]["status"], 200);
    let revision = output["initial"]["body"]["data"]["revision"]
        .as_str()
        .map(ToString::to_string);
    let mut guard = None;
    if name != "C01" {
        guard = Some(ReadOnlyDirectory::new(
            state
                .config
                .storage_paths
                .data_dir
                .join("ai-session-attachments/manifests"),
        ));
        let error = state
            .ai_session_attachments
            .set_retention_days(0)
            .unwrap_err();
        assert_eq!(error.code, "AI_SESSION_ATTACHMENT_IO_FAILED");
        assert_eq!(state.ai_session_attachments.retention_days(), 0);
        assert_eq!(
            capture(&state, id),
            output["before"],
            "setup GC failure must preserve owners/bytes"
        );
        if name == "C03" {
            drop(guard.take());
        }
    }
    output["response"] = get(&state, &path, revision.as_deref()).await;
    output["after"] = capture(&state, id);
    drop(guard);
    eprintln!("U03.10 {name}/{endpoint}: {}", output["response"]);
    output["retry"] = get(&state, &path, revision.as_deref()).await;
    output["afterRetry"] = capture(&state, id);
    output["repeated"] = get(
        &state,
        &path,
        output["retry"]["body"]["data"]["revision"].as_str(),
    )
    .await;
    output["afterRepeated"] = capture(&state, id);
    output["fresh"] = get(&state, &path, None).await;
    output["afterFresh"] = capture(&state, id);
    let reopened = controlled_instance_ai_session::AiSessionConversationAttachmentStore::new(
        &state.config.storage_paths.data_dir,
    );
    output["reopened"] = json!({"files":files(&state.config.storage_paths.data_dir),"attachments":reopened.attachments_for_message(id,"message-read")});
    normalize_clocks(
        &mut output,
        &seed,
        start,
        chrono::Utc::now().timestamp_millis(),
        &mut None,
    );
    output
}
async fn compare(name: &str) {
    let mut actual = serde_json::Map::new();
    for endpoint in ["history", "detail", "turns", "index", "single"] {
        actual.insert(endpoint.into(), observe(name, endpoint).await);
    }
    assert_eq!(
        Value::Object(actual),
        fixture()["expected"][name],
        "HTTP/cache revisions/manifest/blob observations must match Node"
    );
}
#[tokio::test]
async fn c01_normal_reads() {
    compare("C01").await;
}
#[tokio::test]
async fn c02_read_gc_failure_retry() {
    compare("C02").await;
}
#[tokio::test]
async fn c03_read_expiry_cache_and_reopen() {
    compare("C03").await;
}
