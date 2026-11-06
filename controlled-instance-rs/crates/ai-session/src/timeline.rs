use crate::AiSession;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{SecondsFormat, Utc};
use controlled_instance_core::atomic::write_json_atomic;
use controlled_instance_protocol::{
    AiSessionConversationAttachment, AiSessionTimeline, AiSessionTimelineItem,
    AiSessionTimelineItemRevision, AiSessionTimelineSyncRead, AiSessionTimelineVersionedItem,
    AiSessionToolActivityWindow, AiSessionTurnTimeline, AI_SESSION_MAX_TIMELINE_ATTACHMENTS,
    AI_SESSION_TIMELINE_SYNC_MAX_ITEMS, AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AiSessionTimelineError {
    #[error("AI session Turn was not found.")]
    TurnNotFound,
    #[error("{0} sessions do not expose Timeline reads.")]
    Unsupported(String),
    #[error("AI session has no provider session identity.")]
    ProviderSessionMissing,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCodexTimeline {
    schema_version: u64,
    provider_session_id: String,
    items: Vec<AiSessionTimelineItem>,
}

#[derive(Debug, Clone)]
pub struct AiSessionTimelineStore {
    directory: PathBuf,
    write_lock: std::sync::Arc<Mutex<()>>,
}

impl AiSessionTimelineStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            directory: data_dir.join("ai-session-timeline").join("codex"),
            write_lock: Default::default(),
        }
    }

    pub fn from_directory(directory: PathBuf) -> Self {
        Self {
            directory,
            write_lock: Default::default(),
        }
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn items(&self, provider_session_id: &str) -> Vec<AiSessionTimelineItem> {
        let bytes = std::fs::read(self.file_path(provider_session_id));
        let Ok(bytes) = bytes else {
            return Vec::new();
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            return Vec::new();
        };
        let Some(record) = value.as_object() else {
            return Vec::new();
        };
        if record.get("schemaVersion").and_then(Value::as_u64) != Some(1)
            || record.get("providerSessionId").and_then(Value::as_str) != Some(provider_session_id)
        {
            return Vec::new();
        }
        let Some(raw_items) = record.get("items").and_then(Value::as_array) else {
            return Vec::new();
        };
        let mut items = Vec::<AiSessionTimelineItem>::new();
        let mut indexes = HashMap::<String, usize>::new();
        for raw in raw_items {
            let Ok(item) = serde_json::from_value::<AiSessionTimelineItem>(raw.clone()) else {
                continue;
            };
            let Some(item) = sanitize_item(item) else {
                continue;
            };
            let id = item.id().to_string();
            if let Some(index) = indexes.get(&id).copied() {
                items[index] = item;
            } else {
                indexes.insert(id, items.len());
                items.push(item);
            }
        }
        items
    }

    pub fn upsert(
        &self,
        provider_session_id: &str,
        item: AiSessionTimelineItem,
    ) -> std::io::Result<()> {
        let Some(item) = sanitize_item(item) else {
            return Ok(());
        };
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut items = self.items(provider_session_id);
        if let Some(index) = items
            .iter()
            .position(|candidate| candidate.id() == item.id())
        {
            items[index] = item;
        } else {
            items.push(item);
        }
        write_json_atomic(
            &self.file_path(provider_session_id),
            &StoredCodexTimeline {
                schema_version: 1,
                provider_session_id: provider_session_id.to_string(),
                items,
            },
            Some(0o600),
        )
    }

    pub fn retain(&self, provider_session_ids: &HashSet<String>) -> std::io::Result<usize> {
        let retained = provider_session_ids
            .iter()
            .map(|id| id.trim())
            .filter(|id| !id.is_empty())
            .collect::<HashSet<_>>();
        let entries = match std::fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error),
        };
        let mut removed = 0;
        for entry in entries {
            let entry = entry?;
            let file_name = entry.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            if !is_timeline_file_name(file_name) || !entry.file_type()?.is_file() {
                continue;
            }
            let path = entry.path();
            let provider_session_id = std::fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|value| {
                    value
                        .get("providerSessionId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .map(str::to_string)
                });
            if provider_session_id
                .as_deref()
                .is_some_and(|id| retained.contains(id))
            {
                continue;
            }
            std::fs::remove_file(path)?;
            removed += 1;
        }
        Ok(removed)
    }

    pub fn timeline(
        &self,
        session: &AiSession,
    ) -> Result<AiSessionTimeline, AiSessionTimelineError> {
        if session.agent != "codex" {
            return Err(AiSessionTimelineError::Unsupported(session.agent.clone()));
        }
        let provider_session_id = session
            .provider_session_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or(AiSessionTimelineError::ProviderSessionMissing)?;
        Ok(AiSessionTimeline {
            session_id: session.id.clone(),
            provider_session_id: provider_session_id.to_string(),
            items: self.items(provider_session_id),
            generated_at: now_iso(),
        })
    }

    pub fn turn_timeline(
        &self,
        session: &AiSession,
        turn_id: &str,
    ) -> Result<AiSessionTurnTimeline, AiSessionTimelineError> {
        let turn = session
            .turns
            .as_deref()
            .unwrap_or_default()
            .iter()
            .find(|turn| {
                turn.get("id").and_then(Value::as_str) == Some(turn_id)
                    || turn.get("providerTurnId").and_then(Value::as_str) == Some(turn_id)
            })
            .ok_or(AiSessionTimelineError::TurnNotFound)?;
        let canonical_turn_id = turn.get("id").and_then(Value::as_str).unwrap_or(turn_id);
        let provider_turn_id = turn
            .get("providerTurnId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(canonical_turn_id);
        let timeline = self.timeline(session)?;
        Ok(AiSessionTurnTimeline {
            session_id: session.id.clone(),
            turn_id: canonical_turn_id.to_string(),
            items: timeline
                .items
                .into_iter()
                .filter(|item| {
                    item.turn_id() == provider_turn_id || item.turn_id() == canonical_turn_id
                })
                .collect(),
            generated_at: timeline.generated_at,
        })
    }

    fn file_path(&self, provider_session_id: &str) -> PathBuf {
        let key = hex::encode(Sha256::digest(provider_session_id.as_bytes()));
        self.directory.join(format!("{key}.json"))
    }
}

fn is_timeline_file_name(value: &str) -> bool {
    let Some(key) = value.strip_suffix(".json") else {
        return false;
    };
    key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn ai_session_timeline_revision(items: &[AiSessionTimelineItem]) -> String {
    revision_hash(&serde_json::to_value(items).unwrap_or(Value::Array(Vec::new())))
}

pub fn ai_session_timeline_item_revision(item: &AiSessionTimelineItem) -> String {
    revision_hash(&serde_json::to_value(item).unwrap_or(Value::Null))
}

pub fn ai_session_tool_activity_window(
    timeline: &AiSessionTurnTimeline,
) -> AiSessionToolActivityWindow {
    let boundary_index = timeline
        .items
        .iter()
        .rposition(|item| matches!(item, AiSessionTimelineItem::AiMessage { .. }));
    let boundary = boundary_index.map(|index| &timeline.items[index]);
    let activities = timeline
        .items
        .iter()
        .skip(boundary_index.map(|index| index + 1).unwrap_or(0))
        .filter(|item| matches!(item, AiSessionTimelineItem::Activity { .. }))
        .cloned()
        .collect::<Vec<_>>();
    let total = activities.len();
    let items = activities
        .into_iter()
        .skip(total.saturating_sub(AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS))
        .collect::<Vec<_>>();
    let truncated = items.len() < total;
    let revision = revision_hash(&serde_json::json!({
        "boundaryItemId": boundary.map(AiSessionTimelineItem::id),
        "items": items,
    }));
    AiSessionToolActivityWindow {
        session_id: timeline.session_id.clone(),
        turn_id: timeline.turn_id.clone(),
        revision,
        boundary_item_id: boundary.map(|item| item.id().to_string()),
        items,
        total,
        truncated,
        generated_at: timeline.generated_at.clone(),
    }
}

pub fn sync_ai_session_timeline_items(
    items: &[AiSessionTimelineItem],
    known_items: &[AiSessionTimelineItemRevision],
) -> AiSessionTimelineSyncRead {
    let revision = ai_session_timeline_revision(items);
    if known_items.is_empty() {
        return AiSessionTimelineSyncRead::Snapshot {
            revision,
            items: items
                .iter()
                .map(|item| AiSessionTimelineVersionedItem {
                    revision: ai_session_timeline_item_revision(item),
                    item: item.clone(),
                })
                .collect(),
        };
    }
    let versioned = items
        .iter()
        .map(|item| AiSessionTimelineVersionedItem {
            revision: ai_session_timeline_item_revision(item),
            item: item.clone(),
        })
        .collect::<Vec<_>>();
    if known_items.len() == versioned.len()
        && known_items.iter().zip(&versioned).all(|(known, current)| {
            known.id == current.item.id() && known.revision == current.revision
        })
    {
        return AiSessionTimelineSyncRead::NotModified { revision };
    }

    let known_revisions = known_items
        .iter()
        .map(|item| (item.id.as_str(), item.revision.as_str()))
        .collect::<HashMap<_, _>>();
    let current_ids = versioned
        .iter()
        .map(|entry| entry.item.id())
        .collect::<HashSet<_>>();
    let removed = known_items
        .iter()
        .filter(|item| !current_ids.contains(item.id.as_str()))
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    let removed_ids = removed.iter().map(String::as_str).collect::<HashSet<_>>();
    let known_ids = known_items
        .iter()
        .map(|item| item.id.as_str())
        .collect::<HashSet<_>>();
    let surviving_known_order = known_items
        .iter()
        .filter(|item| !removed_ids.contains(item.id.as_str()))
        .map(|item| item.id.as_str())
        .collect::<Vec<_>>();
    let current_known_order = versioned
        .iter()
        .filter(|entry| known_ids.contains(entry.item.id()))
        .map(|entry| entry.item.id())
        .collect::<Vec<_>>();
    let mut seen_new_item = false;
    let appends_only = versioned.iter().all(|entry| {
        if !known_ids.contains(entry.item.id()) {
            seen_new_item = true;
            return true;
        }
        !seen_new_item
    });
    let order_derivable = appends_only
        && surviving_known_order.len() == current_known_order.len()
        && surviving_known_order
            .iter()
            .zip(&current_known_order)
            .all(|(known, current)| known == current);
    AiSessionTimelineSyncRead::Delta {
        revision,
        upserted: versioned
            .into_iter()
            .filter(|entry| known_revisions.get(entry.item.id()) != Some(&entry.revision.as_str()))
            .collect(),
        removed,
        order: (!order_derivable).then(|| items.iter().map(|item| item.id().to_string()).collect()),
    }
}

pub fn validate_known_timeline_items(
    known_items: &[AiSessionTimelineItemRevision],
) -> Result<(), String> {
    if known_items.len() > AI_SESSION_TIMELINE_SYNC_MAX_ITEMS {
        return Err(format!(
            "knownItems must contain at most {AI_SESSION_TIMELINE_SYNC_MAX_ITEMS} entries."
        ));
    }
    for (index, item) in known_items.iter().enumerate() {
        if item.id.trim().is_empty() || zod_string_len(&item.id) > 240 {
            return Err(format!("knownItems.{index}.id is invalid."));
        }
        if item.revision.trim().is_empty() || zod_string_len(&item.revision) > 64 {
            return Err(format!("knownItems.{index}.revision is invalid."));
        }
    }
    Ok(())
}

fn sanitize_item(mut item: AiSessionTimelineItem) -> Option<AiSessionTimelineItem> {
    match &mut item {
        AiSessionTimelineItem::UserMessage {
            id,
            turn_id,
            attachments,
            ..
        } => {
            sanitize_identifier(id, 240)?;
            sanitize_identifier(turn_id, 240)?;
            if let Some(values) = attachments {
                if values.len() > AI_SESSION_MAX_TIMELINE_ATTACHMENTS {
                    return None;
                }
                for attachment in values {
                    sanitize_attachment(attachment)?;
                }
            }
        }
        AiSessionTimelineItem::AiMessage { id, turn_id, .. } => {
            sanitize_identifier(id, 240)?;
            sanitize_identifier(turn_id, 240)?;
        }
        AiSessionTimelineItem::Activity {
            id,
            turn_id,
            activity_kind,
            title,
            summary,
            input,
            output,
            paths,
            ..
        } => {
            sanitize_identifier(id, 240)?;
            sanitize_identifier(turn_id, 240)?;
            sanitize_identifier(activity_kind, 120)?;
            sanitize_identifier(title, 240)?;
            if activity_kind == "reasoning" || activity_kind == "codexRetry" {
                return None;
            }
            if summary
                .as_deref()
                .is_some_and(|value| zod_string_len(value) > 4_000)
                || input
                    .as_deref()
                    .is_some_and(|value| zod_string_len(value) > 100_000)
                || output
                    .as_deref()
                    .is_some_and(|value| zod_string_len(value) > 1_000_000)
            {
                return None;
            }
            if let Some(paths) = paths {
                if paths.len() > 500 {
                    return None;
                }
                for path in paths {
                    if path.trim().is_empty() || zod_string_len(path) > 4_096 {
                        return None;
                    }
                    *path = path.trim().to_string();
                }
            }
        }
    }
    Some(item)
}

fn sanitize_attachment(attachment: &mut AiSessionConversationAttachment) -> Option<()> {
    sanitize_identifier(&mut attachment.id, 120)?;
    sanitize_identifier(&mut attachment.name, 240)?;
    sanitize_identifier(&mut attachment.mime, 120)?;
    (attachment.size <= 9_007_199_254_740_991).then_some(())
}

fn sanitize_identifier(value: &mut String, max: usize) -> Option<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() || zod_string_len(trimmed) > max {
        return None;
    }
    if trimmed.len() != value.len() {
        *value = trimmed.to_string();
    }
    Some(())
}

fn zod_string_len(value: &str) -> usize {
    value.chars().count()
}

fn revision_hash(value: &Value) -> String {
    let canonical = serde_json::to_vec(&canonical_value(value)).unwrap_or_default();
    URL_SAFE_NO_PAD.encode(Sha256::digest(canonical))[..22].to_string()
}

fn canonical_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_value).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), canonical_value(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_protocol::AiSessionAttachmentContentState;
    use serde_json::json;

    fn item(id: &str, turn_id: &str, text: &str) -> AiSessionTimelineItem {
        AiSessionTimelineItem::AiMessage {
            id: id.to_string(),
            turn_id: turn_id.to_string(),
            text: text.to_string(),
        }
    }

    fn activity(id: &str, turn_id: &str) -> AiSessionTimelineItem {
        AiSessionTimelineItem::Activity {
            id: id.to_string(),
            turn_id: turn_id.to_string(),
            activity_kind: "commandExecution".to_string(),
            title: "Command".to_string(),
            status: None,
            summary: None,
            input: None,
            output: None,
            paths: None,
            exit_code: None,
            duration_ms: None,
        }
    }

    #[test]
    fn tool_activity_window_keeps_only_the_latest_message_tail() {
        let timeline = AiSessionTurnTimeline {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            items: vec![
                activity("before", "turn-1"),
                item("message-1", "turn-1", "First"),
                activity("first-tail", "turn-1"),
                item("message-2", "turn-1", "Second"),
                activity("tail-1", "turn-1"),
                activity("tail-2", "turn-1"),
            ],
            generated_at: "2026-11-06T00:00:00.000Z".to_string(),
        };
        let window = ai_session_tool_activity_window(&timeline);
        assert_eq!(window.boundary_item_id.as_deref(), Some("message-2"));
        assert_eq!(
            window
                .items
                .iter()
                .map(AiSessionTimelineItem::id)
                .collect::<Vec<_>>(),
            vec!["tail-1", "tail-2"]
        );
        assert_eq!(window.total, 2);
        assert!(!window.truncated);
        assert_eq!(
            window.revision,
            ai_session_tool_activity_window(&timeline).revision
        );
    }

    #[test]
    fn tool_activity_window_is_bounded_and_reports_the_complete_total() {
        let mut items = vec![item("message-1", "turn-1", "Done")];
        items.extend((0..55).map(|index| activity(&format!("tail-{index}"), "turn-1")));
        let window = ai_session_tool_activity_window(&AiSessionTurnTimeline {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            items,
            generated_at: "2026-11-06T00:00:00.000Z".to_string(),
        });
        assert_eq!(
            window.items.len(),
            AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS
        );
        assert_eq!(window.items[0].id(), "tail-5");
        assert_eq!(window.total, 55);
        assert!(window.truncated);
    }

    #[test]
    fn timeline_store_reads_the_node_layout_and_sanitizes_items() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionTimelineStore::from_directory(root.path().to_path_buf());
        std::fs::create_dir_all(store.directory()).expect("directory");
        let provider_session_id = "provider-thread";
        let key = hex::encode(Sha256::digest(provider_session_id.as_bytes()));
        std::fs::write(
            store.directory().join(format!("{key}.json")),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "providerSessionId": provider_session_id,
                "items": [
                    {
                        "id": "item-1",
                        "turnId": "turn-1",
                        "type": "ai-message",
                        "text": "first"
                    },
                    {
                        "id": "item-1",
                        "turnId": "turn-1",
                        "type": "ai-message",
                        "text": "replacement"
                    },
                    {
                        "id": "transient",
                        "turnId": "turn-1",
                        "type": "activity",
                        "activityKind": "reasoning",
                        "title": "Reasoning"
                    },
                    {
                        "id": "download",
                        "turnId": "turn-1",
                        "type": "user-message",
                        "text": "file",
                        "attachments": [{
                            "id": "att_1",
                            "kind": "file",
                            "name": "notes.txt",
                            "mime": "text/plain",
                            "size": 12
                        }]
                    }
                ]
            }))
            .expect("json"),
        )
        .expect("fixture");
        let items = store.items(provider_session_id);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id(), "item-1");
        assert_eq!(items[0].turn_id(), "turn-1");
        match &items[1] {
            AiSessionTimelineItem::UserMessage { attachments, .. } => {
                assert_eq!(
                    attachments.as_ref().expect("attachments")[0].content_state,
                    AiSessionAttachmentContentState::Available
                );
            }
            other => panic!("unexpected item: {other:?}"),
        }
    }

    #[test]
    fn timeline_store_preserves_provider_session_ids_without_trimming() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionTimelineStore::from_directory(root.path().to_path_buf());
        store
            .upsert(" thread-with-space ", item("item-1", "turn-1", "one"))
            .expect("whitespace id");
        store
            .upsert("", item("item-2", "turn-1", "two"))
            .expect("empty id");

        assert_eq!(store.items(" thread-with-space ").len(), 1);
        assert!(store.items("thread-with-space").is_empty());
        assert_eq!(store.items("").len(), 1);
    }

    #[test]
    fn sync_returns_snapshot_delta_and_not_modified_like_node() {
        let first = item("item-1", "turn-1", "one");
        let second = item("item-2", "turn-1", "two");
        let known = vec![AiSessionTimelineItemRevision {
            id: "item-1".to_string(),
            revision: ai_session_timeline_item_revision(&first),
        }];
        let snapshot = sync_ai_session_timeline_items(&[first.clone(), second.clone()], &[]);
        assert!(matches!(
            snapshot,
            AiSessionTimelineSyncRead::Snapshot { .. }
        ));
        let delta = sync_ai_session_timeline_items(&[first.clone(), second.clone()], &known);
        match delta {
            AiSessionTimelineSyncRead::Delta {
                upserted,
                removed,
                order,
                ..
            } => {
                assert_eq!(upserted.len(), 1);
                assert_eq!(upserted[0].item.id(), "item-2");
                assert!(removed.is_empty());
                assert!(order.is_none(), "tail append order is derivable");
            }
            other => panic!("unexpected sync: {other:?}"),
        }
        let unchanged_known = vec![
            AiSessionTimelineItemRevision {
                id: "item-1".to_string(),
                revision: ai_session_timeline_item_revision(&first),
            },
            AiSessionTimelineItemRevision {
                id: "item-2".to_string(),
                revision: ai_session_timeline_item_revision(&second),
            },
        ];
        assert!(matches!(
            sync_ai_session_timeline_items(&[first, second], &unchanged_known),
            AiSessionTimelineSyncRead::NotModified { .. }
        ));
    }

    #[test]
    fn timeline_store_upserts_replaces_and_skips_transient_items() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionTimelineStore::from_directory(root.path().join("codex"));
        let provider_session_id = "provider-thread";

        store
            .upsert(provider_session_id, item("item-1", "turn-1", "first"))
            .expect("upsert");
        store
            .upsert(provider_session_id, item("item-1", "turn-1", "replacement"))
            .expect("replace");
        store
            .upsert(
                provider_session_id,
                AiSessionTimelineItem::Activity {
                    id: "reasoning".to_string(),
                    turn_id: "turn-1".to_string(),
                    activity_kind: "reasoning".to_string(),
                    title: "Reasoning".to_string(),
                    status: None,
                    summary: None,
                    input: None,
                    output: None,
                    paths: None,
                    exit_code: None,
                    duration_ms: None,
                },
            )
            .expect("skip transient");
        store
            .upsert(provider_session_id, item("item-2", "turn-1", "second"))
            .expect("append");

        let items = store.items(provider_session_id);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id(), "item-1");
        match &items[0] {
            AiSessionTimelineItem::AiMessage { text, .. } => {
                assert_eq!(text, "replacement");
            }
            other => panic!("unexpected item: {other:?}"),
        }
        let raw = std::fs::read_to_string(store.file_path(provider_session_id)).expect("stored");
        let value: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["providerSessionId"], provider_session_id);
        assert_eq!(value["items"].as_array().expect("items").len(), 2);
    }

    #[test]
    fn timeline_store_retains_only_owned_and_valid_records() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionTimelineStore::from_directory(root.path().to_path_buf());
        std::fs::create_dir_all(store.directory()).expect("directory");
        store
            .upsert("retained-thread", item("item-1", "turn-1", "retained"))
            .expect("retained");
        store
            .upsert("orphaned-thread", item("item-2", "turn-1", "orphaned"))
            .expect("orphaned");
        let malformed_path = store.directory().join(format!("{}.json", "a".repeat(64)));
        std::fs::write(&malformed_path, "{not-json").expect("malformed");
        let unrelated_path = store.directory().join("notes.txt");
        std::fs::write(&unrelated_path, "keep").expect("unrelated");

        let removed = store
            .retain(&HashSet::from(["retained-thread".to_string()]))
            .expect("retain");

        assert_eq!(removed, 2);
        assert_eq!(store.items("retained-thread").len(), 1);
        assert!(store.items("orphaned-thread").is_empty());
        assert!(!malformed_path.exists());
        assert!(unrelated_path.exists());
    }

    #[test]
    fn timeline_schema_limits_count_unicode_code_points_like_zod() {
        let activity = AiSessionTimelineItem::Activity {
            id: "activity-1".to_string(),
            turn_id: "turn-1".to_string(),
            activity_kind: "tool".to_string(),
            title: "😀".repeat(240),
            status: None,
            summary: Some("😀".repeat(4_000)),
            input: None,
            output: None,
            paths: None,
            exit_code: None,
            duration_ms: None,
        };
        assert!(sanitize_item(activity.clone()).is_some());

        let too_long = AiSessionTimelineItem::Activity {
            id: "activity-1".to_string(),
            turn_id: "turn-1".to_string(),
            activity_kind: "tool".to_string(),
            title: "😀".repeat(241),
            status: None,
            summary: Some("😀".repeat(4_000)),
            input: None,
            output: None,
            paths: None,
            exit_code: None,
            duration_ms: None,
        };
        assert!(sanitize_item(too_long).is_none());
    }
}
