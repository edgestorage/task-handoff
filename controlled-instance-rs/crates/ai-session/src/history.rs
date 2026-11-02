use chrono::{DateTime, Utc};
use controlled_instance_core::atomic::write_atomic;
use controlled_instance_protocol::{
    AiSessionHistoryDetail, AiSessionHistoryIndex, AiSessionHistoryItem,
    AI_SESSION_HISTORY_DEFAULT_LIMIT, AI_SESSION_HISTORY_MAX_ITEMS, AI_SESSION_HISTORY_MAX_LIMIT,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};
use thiserror::Error;

use crate::AiSession;

const HISTORY_TURN_FIELDS: [&str; 12] = [
    "id",
    "providerTurnId",
    "userPrompt",
    "userMessages",
    "status",
    "phase",
    "summary",
    "lastMessage",
    "contextCompactions",
    "startedAt",
    "updatedAt",
    "completedAt",
];

#[derive(Debug, Error)]
pub enum AiSessionHistoryError {
    #[error("AI session history item is invalid.")]
    InvalidItem,
    #[error("AI session history limit must be between 1 and {AI_SESSION_HISTORY_MAX_LIMIT}.")]
    InvalidLimit,
    #[error("AI session history persistence failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("AI session history serialization failed: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug)]
pub struct AiSessionHistoryStore {
    directory: PathBuf,
    limit: AtomicUsize,
    items: Mutex<Vec<AiSessionHistoryItem>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiSessionHistoryRetentionResult {
    pub limit: usize,
    pub removed_ids: Vec<String>,
}

impl AiSessionHistoryStore {
    pub fn new(data_dir: &Path, limit: Option<usize>) -> Self {
        let directory = data_dir.join("ai-session-history");
        let limit = limit
            .filter(|value| (1..=AI_SESSION_HISTORY_MAX_ITEMS).contains(value))
            .unwrap_or(AI_SESSION_HISTORY_DEFAULT_LIMIT);
        let items = load_items(&directory.join("index.json"), limit);
        Self {
            directory,
            limit: AtomicUsize::new(limit),
            items: Mutex::new(items),
        }
    }

    pub fn retention_limit(&self) -> usize {
        self.limit.load(Ordering::SeqCst)
    }

    pub fn set_retention_limit(
        &self,
        limit: usize,
    ) -> Result<AiSessionHistoryRetentionResult, AiSessionHistoryError> {
        if !(1..=AI_SESSION_HISTORY_MAX_LIMIT).contains(&limit) {
            return Err(AiSessionHistoryError::InvalidLimit);
        }
        let mut items = self
            .items
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let retained = sort_and_limit(items.clone(), limit);
        let retained_ids = retained
            .iter()
            .map(|item| item.id.as_str())
            .collect::<HashSet<_>>();
        let removed_ids = items
            .iter()
            .filter(|item| !retained_ids.contains(item.id.as_str()))
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        if !removed_ids.is_empty() {
            self.write_index(&retained)?;
            for id in &removed_ids {
                let _ = std::fs::remove_file(self.detail_path(id));
            }
            *items = retained;
        }
        self.limit.store(limit, Ordering::SeqCst);
        Ok(AiSessionHistoryRetentionResult { limit, removed_ids })
    }

    pub fn list(&self, agents: Option<&HashSet<String>>) -> Vec<AiSessionHistoryItem> {
        let items = self
            .items
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        items
            .iter()
            .filter(|item| agents.is_none_or(|agents| agents.contains(&item.agent)))
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<AiSessionHistoryItem> {
        self.items
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|item| item.id == id)
            .cloned()
    }

    pub fn detail(&self, id: &str) -> Option<AiSessionHistoryDetail> {
        let item = self.get(id)?;
        let path = self.detail_path(id);
        let turns = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.get("turns").and_then(Value::as_array).cloned())
            .map(|turns| sanitize_turns(turns, 50))
            .unwrap_or_default();
        Some(AiSessionHistoryDetail { item, turns })
    }

    pub fn upsert(
        &self,
        item: AiSessionHistoryItem,
        turns: &[Value],
    ) -> Result<AiSessionHistoryItem, AiSessionHistoryError> {
        let item = sanitize_item(item).ok_or(AiSessionHistoryError::InvalidItem)?;
        self.write_detail(&item, &sanitize_turns(turns.to_vec(), 50))?;
        let previous = {
            let items = self
                .items
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            items.clone()
        };
        let mut next = previous
            .iter()
            .filter(|candidate| {
                candidate.id != item.id
                    && !(candidate.agent == item.agent
                        && candidate.provider_session_id == item.provider_session_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        next.push(item.clone());
        next = sort_and_limit(next, self.retention_limit());
        self.write_index(&next)?;
        let retained = next
            .iter()
            .map(|item| item.id.as_str())
            .collect::<HashSet<_>>();
        for removed in previous
            .iter()
            .filter(|candidate| !retained.contains(candidate.id.as_str()))
        {
            let _ = std::fs::remove_file(self.detail_path(&removed.id));
        }
        *self
            .items
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
        Ok(item)
    }

    pub fn remove(&self, id: &str) -> Result<bool, AiSessionHistoryError> {
        let mut items = self
            .items
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !items.iter().any(|item| item.id == id) {
            return Ok(false);
        }
        let removed = subtree_ids(&items, id);
        items.retain(|item| !removed.contains(&item.id));
        self.write_index(&items)?;
        for id in removed {
            let _ = std::fs::remove_file(self.detail_path(&id));
        }
        Ok(true)
    }

    pub fn activate(&self, id: &str) -> Result<bool, AiSessionHistoryError> {
        self.remove_by_ids(&[id.to_string()])
    }

    pub fn activate_identity(
        &self,
        agent: &str,
        provider_session_id: &str,
    ) -> Result<bool, AiSessionHistoryError> {
        let mut items = self
            .items
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = items.len();
        items.retain(|item| item.agent != agent || item.provider_session_id != provider_session_id);
        if items.len() == before {
            return Ok(false);
        }
        self.write_index(&items)?;
        Ok(true)
    }

    fn remove_by_ids(&self, ids: &[String]) -> Result<bool, AiSessionHistoryError> {
        let mut items = self
            .items
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let removed = ids.iter().cloned().collect::<HashSet<_>>();
        let before = items.len();
        items.retain(|item| !removed.contains(&item.id));
        if items.len() == before {
            return Ok(false);
        }
        self.write_index(&items)?;
        Ok(true)
    }

    pub fn from_session(session: &AiSession, archived_at: String) -> Option<AiSessionHistoryItem> {
        sanitize_item(AiSessionHistoryItem {
            id: session.id.clone(),
            agent: session.agent.clone(),
            creation_source: session.creation_source.clone(),
            provider_session_id: session.provider_session_id.clone()?,
            lineage: session.lineage.clone(),
            model_selection: session.model_selection.clone(),
            reasoning_effort: session.reasoning_effort.clone(),
            story_id: session.story_id.clone(),
            title: session.title.clone(),
            user_prompt: session.user_prompt.clone(),
            last_message: session.last_message.clone(),
            cwd: session.cwd.clone()?,
            cwd_folder_id: session.cwd_folder_id.clone(),
            last_active_at: session.updated_at.clone(),
            archived_at,
        })
    }

    pub fn turns_for_session(session: &AiSession) -> Vec<Value> {
        let mut turns = session
            .turns
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(history_turn)
            .collect::<Vec<_>>();
        if turns.is_empty() && (session.user_prompt.is_some() || session.last_message.is_some()) {
            let mut turn = Map::new();
            turn.insert(
                "id".to_string(),
                Value::String(
                    session
                        .active_turn_id
                        .clone()
                        .unwrap_or_else(|| format!("history:{}", session.id)),
                ),
            );
            insert_optional(&mut turn, "userPrompt", session.user_prompt.clone());
            turn.insert(
                "status".to_string(),
                Value::String(
                    match session.status.as_str() {
                        "failed" => "failed",
                        "waiting" => "waiting",
                        _ => "completed",
                    }
                    .to_string(),
                ),
            );
            turn.insert("phase".to_string(), Value::String(session.phase.clone()));
            insert_optional(&mut turn, "summary", session.summary.clone());
            insert_optional(&mut turn, "lastMessage", session.last_message.clone());
            turn.insert(
                "startedAt".to_string(),
                Value::String(session.started_at.clone()),
            );
            turn.insert(
                "updatedAt".to_string(),
                Value::String(session.updated_at.clone()),
            );
            turn.insert(
                "completedAt".to_string(),
                Value::String(
                    session
                        .completed_at
                        .clone()
                        .unwrap_or_else(|| session.updated_at.clone()),
                ),
            );
            turns.push(Value::Object(turn));
        }
        turns
            .into_iter()
            .rev()
            .take(50)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    fn write_index(&self, items: &[AiSessionHistoryItem]) -> Result<(), AiSessionHistoryError> {
        std::fs::create_dir_all(&self.directory)?;
        let index = AiSessionHistoryIndex {
            schema_version: 1,
            items: items.to_vec(),
        };
        let mut bytes = serde_json::to_vec_pretty(&index)?;
        bytes.push(b'\n');
        write_atomic(&self.directory.join("index.json"), &bytes, Some(0o600))?;
        Ok(())
    }

    fn write_detail(
        &self,
        item: &AiSessionHistoryItem,
        turns: &[Value],
    ) -> Result<(), AiSessionHistoryError> {
        let path = self.detail_path(&item.id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let detail = AiSessionHistoryDetail {
            item: item.clone(),
            turns: turns.to_vec(),
        };
        let mut bytes = serde_json::to_vec_pretty(&detail)?;
        bytes.push(b'\n');
        write_atomic(&path, &bytes, Some(0o600))?;
        Ok(())
    }

    fn detail_path(&self, id: &str) -> PathBuf {
        let digest = hex::encode(Sha256::digest(id.as_bytes()));
        self.directory
            .join("details")
            .join(format!("{digest}.json"))
    }
}

fn load_items(path: &Path, limit: usize) -> Vec<AiSessionHistoryItem> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        tracing::warn!(path = %path.display(), "ignoring unreadable AI session history index");
        return Vec::new();
    };
    let items = value
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|value| {
                    serde_json::from_value::<AiSessionHistoryItem>(value.clone()).ok()
                })
                .filter_map(sanitize_item)
                .collect()
        })
        .unwrap_or_default();
    sort_and_limit(items, limit)
}

fn sort_and_limit(mut items: Vec<AiSessionHistoryItem>, limit: usize) -> Vec<AiSessionHistoryItem> {
    items.sort_by(|left, right| {
        timestamp(&right.last_active_at)
            .cmp(&timestamp(&left.last_active_at))
            .then_with(|| timestamp(&right.archived_at).cmp(&timestamp(&left.archived_at)))
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut ids = HashSet::new();
    let mut providers = HashSet::new();
    let mut deduplicated = Vec::new();
    for item in items {
        let provider = format!("{}:{}", item.agent, item.provider_session_id);
        if !ids.insert(item.id.clone()) || !providers.insert(provider) {
            continue;
        }
        deduplicated.push(item);
    }
    let parents = history_parents(&deduplicated);
    let mut retained_ids = HashSet::new();
    let mut roots = 0;
    for item in retained_history_roots(&deduplicated, &parents) {
        let is_subagent = history_is_subagent(item);
        if !is_subagent {
            if roots >= limit {
                continue;
            }
            roots += 1;
        }
        retained_ids.extend(subtree_ids_with_parents(&deduplicated, &parents, &item.id));
    }
    deduplicated
        .into_iter()
        .filter(|item| retained_ids.contains(&item.id))
        .collect()
}

fn history_is_subagent(item: &AiSessionHistoryItem) -> bool {
    item.lineage
        .as_ref()
        .and_then(|lineage| lineage.get("kind"))
        .and_then(Value::as_str)
        == Some("subagent")
}

fn history_parents(items: &[AiSessionHistoryItem]) -> HashMap<String, String> {
    let mut parents = HashMap::new();
    for item in items {
        if !history_is_subagent(item) {
            continue;
        }
        let Some(parent_provider_session_id) = item
            .lineage
            .as_ref()
            .and_then(|lineage| lineage.get("parentProviderSessionId"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(parent) = items.iter().find(|candidate| {
            candidate.id != item.id
                && candidate.agent == item.agent
                && candidate.provider_session_id == parent_provider_session_id
        }) else {
            continue;
        };
        parents.insert(item.id.clone(), parent.id.clone());
    }
    // Match the Node hierarchy: self references and cycles become roots instead
    // of making corrupt history permanently invisible.
    let mut complete = HashSet::new();
    let mut cycle_members = HashSet::new();
    for item in items {
        if complete.contains(&item.id) {
            continue;
        }
        let mut path = Vec::new();
        let mut positions = HashMap::new();
        let mut current = Some(item.id.as_str());
        while let Some(id) = current {
            if complete.contains(id) {
                break;
            }
            if let Some(position) = positions.get(id) {
                cycle_members.extend(path[*position..].iter().cloned());
                break;
            }
            positions.insert(id, path.len());
            path.push(id.to_string());
            current = parents.get(id).map(String::as_str);
        }
        complete.extend(path);
    }
    for id in cycle_members {
        parents.remove(&id);
    }
    parents
}

fn subtree_ids(items: &[AiSessionHistoryItem], root_id: &str) -> HashSet<String> {
    let parents = history_parents(items);
    subtree_ids_with_parents(items, &parents, root_id)
}

fn subtree_ids_with_parents(
    items: &[AiSessionHistoryItem],
    parents: &HashMap<String, String>,
    root_id: &str,
) -> HashSet<String> {
    if !items.iter().any(|item| item.id == root_id) {
        return HashSet::new();
    }
    let mut children = HashMap::<String, Vec<String>>::new();
    for (child, parent) in parents {
        children
            .entry(parent.clone())
            .or_default()
            .push(child.clone());
    }
    let mut ids = HashSet::new();
    let mut stack = vec![root_id.to_string()];
    while let Some(id) = stack.pop() {
        if !ids.insert(id.clone()) {
            continue;
        }
        if let Some(next) = children.get(&id) {
            stack.extend(next.iter().cloned());
        }
    }
    ids
}

fn retained_history_roots<'a>(
    items: &'a [AiSessionHistoryItem],
    parents: &HashMap<String, String>,
) -> Vec<&'a AiSessionHistoryItem> {
    let mut roots = items
        .iter()
        .enumerate()
        .filter(|(_, item)| !parents.contains_key(&item.id))
        .collect::<Vec<_>>();
    let mut aggregates = HashMap::new();
    for (_, root) in &roots {
        aggregate_last_active(items, parents, &root.id, &mut aggregates);
    }
    roots.sort_by(|(left_index, left), (right_index, right)| {
        aggregates
            .get(&right.id)
            .copied()
            .unwrap_or_else(|| timestamp(&right.last_active_at))
            .cmp(
                &aggregates
                    .get(&left.id)
                    .copied()
                    .unwrap_or_else(|| timestamp(&left.last_active_at)),
            )
            .then_with(|| left_index.cmp(right_index))
    });
    roots.into_iter().map(|(_, item)| item).collect()
}

fn aggregate_last_active<'a>(
    items: &'a [AiSessionHistoryItem],
    parents: &HashMap<String, String>,
    id: &str,
    aggregates: &mut HashMap<String, i64>,
) -> i64 {
    if let Some(value) = aggregates.get(id) {
        return *value;
    }
    let Some(item) = items.iter().find(|candidate| candidate.id == id) else {
        return 0;
    };
    let mut latest = timestamp(&item.last_active_at);
    for (child, parent) in parents {
        if parent != id {
            continue;
        }
        latest = latest.max(aggregate_last_active(items, parents, child, aggregates));
    }
    aggregates.insert(id.to_string(), latest);
    latest
}

fn sanitize_item(mut item: AiSessionHistoryItem) -> Option<AiSessionHistoryItem> {
    if item.id.trim().is_empty()
        || item.agent.trim().is_empty()
        || item.provider_session_id.trim().is_empty()
        || item.cwd.trim().is_empty()
        || DateTime::parse_from_rfc3339(&item.last_active_at).is_err()
        || DateTime::parse_from_rfc3339(&item.archived_at).is_err()
    {
        return None;
    }
    item.creation_source = if item.creation_source == "ai-session" {
        "ai-session"
    } else {
        "app-session"
    }
    .to_string();
    let valid_lineage = item.lineage.as_ref().is_some_and(|lineage| {
        lineage
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| matches!(kind, "fork" | "subagent"))
    });
    if !valid_lineage {
        item.lineage = None;
    }
    Some(item)
}

fn sanitize_turns(turns: Vec<Value>, max: usize) -> Vec<Value> {
    turns
        .into_iter()
        .filter_map(|turn| {
            let object = turn.as_object()?;
            if object
                .get("id")
                .and_then(Value::as_str)
                .is_none_or(|id| id.trim().is_empty())
            {
                return None;
            }
            Some(Value::Object(
                HISTORY_TURN_FIELDS
                    .iter()
                    .filter_map(|field| {
                        object
                            .get(*field)
                            .cloned()
                            .map(|value| ((*field).to_string(), value))
                    })
                    .collect(),
            ))
        })
        .rev()
        .take(max)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn history_turn(turn: &Value) -> Value {
    let Some(object) = turn.as_object() else {
        return Value::Null;
    };
    Value::Object(
        HISTORY_TURN_FIELDS
            .iter()
            .filter_map(|field| {
                object
                    .get(*field)
                    .cloned()
                    .map(|value| ((*field).to_string(), value))
            })
            .collect(),
    )
}

fn timestamp(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc).timestamp_millis())
        .unwrap_or_default()
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.to_string(), Value::String(value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id: &str, provider: &str) -> AiSessionHistoryItem {
        AiSessionHistoryItem {
            id: id.to_string(),
            agent: "codex".to_string(),
            creation_source: "ai-session".to_string(),
            provider_session_id: provider.to_string(),
            lineage: None,
            model_selection: None,
            reasoning_effort: None,
            story_id: None,
            title: Some("Archived".to_string()),
            user_prompt: Some("Prompt".to_string()),
            last_message: Some("Answer".to_string()),
            cwd: "/workspace".to_string(),
            cwd_folder_id: None,
            last_active_at: "2026-11-02T00:00:00.000Z".to_string(),
            archived_at: "2026-11-02T00:01:00.000Z".to_string(),
        }
    }

    #[test]
    fn history_round_trips_the_node_index_and_detail_layout() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionHistoryStore::new(root.path(), Some(50));
        store
            .upsert(
                item("ses_0000000000001", "thread-1"),
                &[json!({
                    "id": "turn-1",
                    "providerTurnId": "provider-turn",
                    "userPrompt": "Prompt",
                    "status": "completed",
                    "phase": "responding",
                    "startedAt": "2026-11-02T00:00:00.000Z",
                    "updatedAt": "2026-11-02T00:01:00.000Z",
                    "futureField": true
                })],
            )
            .expect("upsert");

        let reloaded = AiSessionHistoryStore::new(root.path(), Some(50));
        assert_eq!(reloaded.list(None).len(), 1);
        let detail = reloaded.detail("ses_0000000000001").expect("detail");
        assert_eq!(detail.turns.len(), 1);
        assert!(detail.turns[0].get("futureField").is_none());
        assert!(root.path().join("ai-session-history/index.json").exists());
        assert!(reloaded.remove("ses_0000000000001").expect("remove"));
        assert!(reloaded.list(None).is_empty());
    }

    #[test]
    fn history_retention_counts_roots_and_keeps_the_whole_subtree() {
        let mut parent = item("ses_0000000000100", "provider-parent");
        parent.last_active_at = "2026-11-02T03:00:00.000Z".to_string();
        let mut child = item("ses_0000000000101", "provider-child");
        child.last_active_at = "2026-11-02T02:00:00.000Z".to_string();
        child.lineage = Some(json!({
            "kind": "subagent",
            "parentProviderSessionId": "provider-parent"
        }));
        let mut other = item("ses_0000000000102", "provider-other");
        other.last_active_at = "2026-11-02T01:00:00.000Z".to_string();

        let retained = sort_and_limit(vec![other, child.clone(), parent.clone()], 1);
        assert_eq!(
            retained
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec![parent.id.as_str(), child.id.as_str()]
        );
    }

    #[test]
    fn removing_a_history_root_removes_the_subtree_and_activating_only_unarchives() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionHistoryStore::new(root.path(), Some(10));
        let parent = item("ses_0000000000200", "provider-parent");
        let mut child = item("ses_0000000000201", "provider-child");
        child.lineage = Some(json!({
            "kind": "subagent",
            "parentProviderSessionId": "provider-parent"
        }));
        let other = item("ses_0000000000202", "provider-other");
        for entry in [parent.clone(), child.clone(), other.clone()] {
            store.upsert(entry, &[]).expect("upsert");
        }

        assert!(store.remove(&parent.id).expect("remove"));
        assert!(store.get(&parent.id).is_none());
        assert!(store.get(&child.id).is_none());
        assert!(store.get(&other.id).is_some());

        assert!(store.activate(&other.id).expect("activate"));
        assert!(store.get(&other.id).is_none());
        assert!(!store.activate(&other.id).expect("second activate"));
    }
}
