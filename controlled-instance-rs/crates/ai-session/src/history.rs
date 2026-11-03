use chrono::{DateTime, Utc};
use controlled_instance_core::atomic::write_atomic;
use controlled_instance_protocol::{
    AiSessionHistoryDetail, AiSessionHistoryIndex, AiSessionHistoryItem,
    AI_SESSION_HISTORY_DEFAULT_LIMIT, AI_SESSION_HISTORY_MAX_LIMIT,
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
    io: Mutex<()>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiSessionHistoryRetentionResult {
    pub limit: usize,
    pub removed_ids: Vec<String>,
}

#[derive(Debug)]
struct LoadedHistory {
    items: Vec<AiSessionHistoryItem>,
    rewrite: bool,
    removed_ids: Vec<String>,
}

impl AiSessionHistoryStore {
    pub fn new(data_dir: &Path, limit: Option<usize>) -> Self {
        let directory = data_dir.join("ai-session-history");
        let limit = limit
            .filter(|value| (1..=AI_SESSION_HISTORY_MAX_LIMIT).contains(value))
            .unwrap_or(AI_SESSION_HISTORY_DEFAULT_LIMIT);
        Self {
            directory,
            limit: AtomicUsize::new(limit),
            io: Mutex::new(()),
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
        let _guard = self
            .io
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = self.reload_locked()?.items;
        self.limit.store(limit, Ordering::SeqCst);
        let retained = sort_and_limit(current.clone(), limit);
        let retained_ids = retained
            .iter()
            .map(|item| item.id.as_str())
            .collect::<HashSet<_>>();
        let removed_ids = current
            .iter()
            .filter(|item| !retained_ids.contains(item.id.as_str()))
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        if !removed_ids.is_empty() {
            self.write_index(&retained)?;
            self.remove_details(&removed_ids);
        }
        Ok(AiSessionHistoryRetentionResult { limit, removed_ids })
    }

    pub fn list(&self, agents: Option<&HashSet<String>>) -> Vec<AiSessionHistoryItem> {
        let _guard = self
            .io
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let loaded = match self.reload_locked() {
            Ok(loaded) => loaded,
            Err(error) => {
                tracing::warn!(error = %error, "failed to rewrite AI session history index");
                self.load_locked()
            }
        };
        loaded
            .items
            .iter()
            .filter(|item| agents.is_none_or(|agents| agents.contains(&item.agent)))
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<AiSessionHistoryItem> {
        self.list(None).into_iter().find(|item| item.id == id)
    }

    pub fn detail(&self, id: &str) -> Option<AiSessionHistoryDetail> {
        let item = self.get(id)?;
        let path = self.detail_path(id);
        let raw = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(raw) = raw else {
            return Some(AiSessionHistoryDetail {
                item,
                turns: Vec::new(),
            });
        };
        let (detail, rewrite) = sanitize_detail(&item, &raw);
        if rewrite {
            let _guard = self
                .io
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Err(error) = self.write_detail(&detail.item, &detail.turns) {
                tracing::warn!(error = %error, id = %id, "failed to rewrite AI session history detail");
            }
        }
        Some(detail)
    }

    pub fn upsert(
        &self,
        item: AiSessionHistoryItem,
        turns: &[Value],
    ) -> Result<AiSessionHistoryItem, AiSessionHistoryError> {
        let _guard = self
            .io
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let item = sanitize_item(item).ok_or(AiSessionHistoryError::InvalidItem)?;
        let previous = self.reload_locked()?.items;
        self.write_detail(&item, &sanitize_turns(turns.to_vec(), 50))?;
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
        if next != previous {
            self.write_index(&next)?;
        }
        let retained = next
            .iter()
            .map(|item| item.id.as_str())
            .collect::<HashSet<_>>();
        let removed_ids = previous
            .iter()
            .filter(|candidate| !retained.contains(candidate.id.as_str()))
            .map(|candidate| candidate.id.clone())
            .collect::<Vec<_>>();
        self.remove_details(&removed_ids);
        Ok(item)
    }

    pub fn remove(&self, id: &str) -> Result<bool, AiSessionHistoryError> {
        let _guard = self
            .io
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut items = self.reload_locked()?.items;
        if !items.iter().any(|item| item.id == id) {
            return Ok(false);
        }
        let removed = subtree_ids(&items, id);
        items.retain(|item| !removed.contains(&item.id));
        self.write_index(&items)?;
        self.remove_details(&removed.into_iter().collect::<Vec<_>>());
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
        let _guard = self
            .io
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut items = self.reload_locked()?.items;
        let before = items.len();
        let removed = items
            .iter()
            .filter(|item| item.agent == agent && item.provider_session_id == provider_session_id)
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        items.retain(|item| item.agent != agent || item.provider_session_id != provider_session_id);
        if items.len() == before {
            return Ok(false);
        }
        self.write_index(&items)?;
        self.remove_details(&removed);
        Ok(true)
    }

    fn remove_by_ids(&self, ids: &[String]) -> Result<bool, AiSessionHistoryError> {
        let _guard = self
            .io
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut items = self.reload_locked()?.items;
        let removed = ids.iter().cloned().collect::<HashSet<_>>();
        let removed_ids = items
            .iter()
            .filter(|item| removed.contains(&item.id))
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        let before = items.len();
        items.retain(|item| !removed.contains(&item.id));
        if items.len() == before {
            return Ok(false);
        }
        self.write_index(&items)?;
        self.remove_details(&removed_ids);
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

    fn load_locked(&self) -> LoadedHistory {
        let path = self.directory.join("index.json");
        let Ok(bytes) = std::fs::read(&path) else {
            return LoadedHistory {
                items: Vec::new(),
                rewrite: false,
                removed_ids: Vec::new(),
            };
        };
        let Ok(raw) = serde_json::from_slice::<Value>(&bytes) else {
            tracing::warn!(path = %path.display(), "ignoring unreadable AI session history index");
            return LoadedHistory {
                items: Vec::new(),
                rewrite: false,
                removed_ids: Vec::new(),
            };
        };
        let items = sanitize_index(&raw, self.retention_limit());
        let normalized = serde_json::to_value(AiSessionHistoryIndex {
            schema_version: 1,
            items: items.clone(),
        })
        .unwrap_or(Value::Null);
        LoadedHistory {
            removed_ids: removed_history_ids(&raw, &items),
            rewrite: raw != normalized,
            items,
        }
    }

    fn reload_locked(&self) -> Result<LoadedHistory, AiSessionHistoryError> {
        let loaded = self.load_locked();
        if loaded.rewrite {
            self.write_index(&loaded.items)?;
            self.remove_details(&loaded.removed_ids);
        }
        Ok(loaded)
    }

    fn remove_details(&self, ids: &[String]) {
        for id in ids {
            let _ = std::fs::remove_file(self.detail_path(id));
        }
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
        let items = sort_and_limit(items.to_vec(), self.retention_limit());
        let index = AiSessionHistoryIndex {
            schema_version: 1,
            items,
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

fn aggregate_last_active(
    items: &[AiSessionHistoryItem],
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

fn sanitize_index(value: &Value, limit: usize) -> Vec<AiSessionHistoryItem> {
    let Some(record) = value.as_object() else {
        return Vec::new();
    };
    let items = record
        .get("items")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(sanitize_item_value).collect())
        .unwrap_or_default();
    sort_and_limit(items, limit)
}

fn removed_history_ids(raw: &Value, retained: &[AiSessionHistoryItem]) -> Vec<String> {
    let retained = retained
        .iter()
        .map(|item| item.id.as_str())
        .collect::<HashSet<_>>();
    raw.as_object()
        .and_then(|record| record.get("items"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.as_object()?.get("id")?.as_str()?.trim();
                    (!id.is_empty() && !retained.contains(id)).then(|| id.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn sanitize_item(item: AiSessionHistoryItem) -> Option<AiSessionHistoryItem> {
    sanitize_item_value(&serde_json::to_value(item).ok()?)
}

fn sanitize_item_value(value: &Value) -> Option<AiSessionHistoryItem> {
    let record = value.as_object()?;
    let id = required_trimmed(record.get("id"), 120)?;
    let agent = required_trimmed(record.get("agent"), 80)?;
    let creation_source =
        if record.get("creationSource").and_then(Value::as_str) == Some("ai-session") {
            "ai-session"
        } else {
            "app-session"
        };
    let provider_session_id = required_trimmed(record.get("providerSessionId"), 240)?;
    let lineage = record.get("lineage").and_then(normalize_lineage);
    let model_selection = match record.get("modelSelection") {
        None => None,
        Some(value) => Some(sanitize_model_selection(value)?),
    };
    let reasoning_effort = match record.get("reasoningEffort") {
        None => None,
        Some(value) => Some(sanitize_reasoning_effort(value)?),
    };
    let story_id = optional_trimmed(record.get("storyId"), Some(120), true)?;
    let title = optional_trimmed(record.get("title"), Some(240), false)?;
    let user_prompt = optional_trimmed(record.get("userPrompt"), None, false)?;
    let last_message = optional_trimmed(record.get("lastMessage"), None, false)?;
    let cwd = required_trimmed(record.get("cwd"), 4096)?;
    let cwd_folder_id = optional_trimmed(record.get("cwdFolderId"), Some(120), true)?;
    let last_active_at = required_datetime(record.get("lastActiveAt"))?;
    let archived_at = required_datetime(record.get("archivedAt"))?;
    Some(AiSessionHistoryItem {
        id,
        agent,
        creation_source: creation_source.to_string(),
        provider_session_id,
        lineage,
        model_selection,
        reasoning_effort,
        story_id,
        title,
        user_prompt,
        last_message,
        cwd,
        cwd_folder_id,
        last_active_at,
        archived_at,
    })
}

fn sanitize_model_selection(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    if record.keys().any(|key| {
        !matches!(
            key.as_str(),
            "modelEntityId" | "modelName" | "modelUpstreamName"
        )
    }) {
        return None;
    }
    let model_entity_id = required_trimmed(record.get("modelEntityId"), 120)?;
    let model_name = required_trimmed(record.get("modelName"), 240)?;
    let model_upstream_name = match record.get("modelUpstreamName") {
        None => None,
        Some(_) => Some(required_trimmed(record.get("modelUpstreamName"), 240)?),
    };
    let mut selection = Map::new();
    selection.insert("modelEntityId".to_string(), Value::String(model_entity_id));
    selection.insert("modelName".to_string(), Value::String(model_name));
    if let Some(value) = model_upstream_name {
        selection.insert("modelUpstreamName".to_string(), Value::String(value));
    }
    Some(Value::Object(selection))
}

fn sanitize_reasoning_effort(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    matches!(
        value,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
    .then(|| value.to_string())
}

fn normalize_lineage(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    let kind = record.get("kind").and_then(Value::as_str)?;
    let parent = required_trimmed(record.get("parentProviderSessionId"), 240)?;
    let mut lineage = Map::new();
    lineage.insert("kind".to_string(), Value::String(kind.to_string()));
    lineage.insert("parentProviderSessionId".to_string(), Value::String(parent));
    match kind {
        "fork" => {
            if matches!(record.get("throughTurnId"), Some(Value::String(_))) {
                let through_turn_id = required_trimmed(record.get("throughTurnId"), 240)?;
                lineage.insert("throughTurnId".to_string(), Value::String(through_turn_id));
            }
        }
        "subagent" => {}
        _ => return None,
    }
    Some(Value::Object(lineage))
}

fn sanitize_turns(turns: Vec<Value>, max: usize) -> Vec<Value> {
    turns
        .into_iter()
        .filter_map(|turn| sanitize_turn(&turn))
        .rev()
        .take(max)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn sanitize_turn(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    let id = required_trimmed(record.get("id"), 240)?;
    let provider_turn_id = optional_trimmed(record.get("providerTurnId"), Some(240), false)?;
    let user_prompt = optional_trimmed(record.get("userPrompt"), None, false)?;
    let user_messages = match record.get("userMessages") {
        None => None,
        Some(value) => {
            let messages = value.as_array()?;
            if messages.len() > 100 {
                return None;
            }
            Some(Value::Array(
                messages
                    .iter()
                    .map(sanitize_user_message)
                    .collect::<Option<Vec<_>>>()?,
            ))
        }
    };
    let status = match record.get("status") {
        None => "running".to_string(),
        Some(value) => {
            let value = value.as_str()?;
            matches!(
                value,
                "queued" | "running" | "waiting" | "completed" | "failed"
            )
            .then(|| value.to_string())?
        }
    };
    let phase = match record.get("phase") {
        None => None,
        Some(value) => {
            let value = value.as_str()?;
            Some(
                matches!(
                    value,
                    "thinking" | "tool" | "editing" | "approval" | "responding" | "unknown"
                )
                .then(|| value.to_string())?,
            )
        }
    };
    let summary = optional_trimmed(record.get("summary"), Some(1000), false)?;
    let last_message = optional_trimmed(record.get("lastMessage"), None, false)?;
    let context_compactions = match record.get("contextCompactions") {
        None => None,
        Some(value) => {
            let compactions = value.as_array()?;
            if compactions.len() > 20 {
                return None;
            }
            Some(Value::Array(
                compactions
                    .iter()
                    .map(sanitize_context_compaction)
                    .collect::<Option<Vec<_>>>()?,
            ))
        }
    };
    let started_at = optional_datetime(record.get("startedAt"))?;
    let updated_at = optional_datetime(record.get("updatedAt"))?;
    let completed_at = optional_datetime(record.get("completedAt"))?;

    let mut turn = Map::new();
    turn.insert("id".to_string(), Value::String(id));
    insert_optional(&mut turn, "providerTurnId", provider_turn_id);
    insert_optional(&mut turn, "userPrompt", user_prompt);
    if let Some(value) = user_messages {
        turn.insert("userMessages".to_string(), value);
    }
    turn.insert("status".to_string(), Value::String(status));
    insert_optional(&mut turn, "phase", phase);
    insert_optional(&mut turn, "summary", summary);
    insert_optional(&mut turn, "lastMessage", last_message);
    if let Some(value) = context_compactions {
        turn.insert("contextCompactions".to_string(), value);
    }
    insert_optional(&mut turn, "startedAt", started_at);
    insert_optional(&mut turn, "updatedAt", updated_at);
    insert_optional(&mut turn, "completedAt", completed_at);
    Some(Value::Object(turn))
}

fn sanitize_user_message(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    if record
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "text" | "attachments"))
    {
        return None;
    }
    let id = required_trimmed(record.get("id"), 240)?;
    let text = record.get("text")?.as_str()?.to_string();
    let attachments = match record.get("attachments") {
        None => Vec::new(),
        Some(value) => {
            let attachments = value.as_array()?;
            if attachments.len() > 6 {
                return None;
            }
            attachments
                .iter()
                .map(sanitize_attachment)
                .collect::<Option<Vec<_>>>()?
        }
    };
    let mut message = Map::new();
    message.insert("id".to_string(), Value::String(id));
    message.insert("text".to_string(), Value::String(text));
    message.insert("attachments".to_string(), Value::Array(attachments));
    Some(Value::Object(message))
}

fn sanitize_attachment(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    if record.keys().any(|key| {
        !matches!(
            key.as_str(),
            "id" | "kind" | "name" | "mime" | "size" | "contentState"
        )
    }) {
        return None;
    }
    let id = required_trimmed(record.get("id"), 120)?;
    let kind = record.get("kind")?.as_str()?;
    if !matches!(kind, "image" | "file") {
        return None;
    }
    let name = required_trimmed(record.get("name"), 240)?;
    let mime = required_trimmed(record.get("mime"), 120)?;
    let size = safe_non_negative_integer(record.get("size")?)?;
    let content_state = match record.get("contentState") {
        None => "available",
        Some(value) => match value.as_str()? {
            "available" | "expired" | "missing" => value.as_str()?,
            _ => return None,
        },
    };
    let mut attachment = Map::new();
    attachment.insert("id".to_string(), Value::String(id));
    attachment.insert("kind".to_string(), Value::String(kind.to_string()));
    attachment.insert("name".to_string(), Value::String(name));
    attachment.insert("mime".to_string(), Value::String(mime));
    attachment.insert("size".to_string(), Value::Number(size.into()));
    attachment.insert(
        "contentState".to_string(),
        Value::String(content_state.to_string()),
    );
    Some(Value::Object(attachment))
}

fn sanitize_context_compaction(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    if record
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "status" | "startedAt" | "completedAt"))
    {
        return None;
    }
    let id = required_trimmed(record.get("id"), 240)?;
    let status = record.get("status")?.as_str()?;
    if !matches!(status, "running" | "completed") {
        return None;
    }
    let started_at = optional_datetime(record.get("startedAt"))?;
    let completed_at = optional_datetime(record.get("completedAt"))?;
    let mut compaction = Map::new();
    compaction.insert("id".to_string(), Value::String(id));
    compaction.insert("status".to_string(), Value::String(status.to_string()));
    insert_optional(&mut compaction, "startedAt", started_at);
    insert_optional(&mut compaction, "completedAt", completed_at);
    Some(Value::Object(compaction))
}

fn sanitize_detail(item: &AiSessionHistoryItem, value: &Value) -> (AiSessionHistoryDetail, bool) {
    let empty = || AiSessionHistoryDetail {
        item: item.clone(),
        turns: Vec::new(),
    };
    let Some(record) = value.as_object() else {
        return (empty(), true);
    };
    let id_matches = record
        .get("item")
        .and_then(Value::as_object)
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
        == Some(item.id.as_str());
    let Some(turns) = record.get("turns").and_then(Value::as_array) else {
        return (empty(), true);
    };
    if !id_matches {
        return (empty(), true);
    }
    let detail = AiSessionHistoryDetail {
        item: item.clone(),
        turns: sanitize_turns(turns.clone(), 50),
    };
    let normalized = serde_json::to_value(&detail).unwrap_or(Value::Null);
    (detail, value != &normalized)
}

fn safe_non_negative_integer(value: &Value) -> Option<u64> {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    let number = value.as_number()?;
    if let Some(value) = number.as_u64() {
        return (value as f64 <= MAX_SAFE_INTEGER).then_some(value);
    }
    let value = number.as_f64()?;
    (value.is_finite() && value.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&value))
        .then_some(value as u64)
}

fn required_trimmed(value: Option<&Value>, max: usize) -> Option<String> {
    let value = value?.as_str()?.trim();
    (!value.is_empty() && schema_len(value) <= max).then(|| value.to_string())
}

fn optional_trimmed(
    value: Option<&Value>,
    max: Option<usize>,
    non_empty: bool,
) -> Option<Option<String>> {
    let Some(value) = value else {
        return Some(None);
    };
    let value = value.as_str()?.trim();
    if non_empty && value.is_empty() {
        return None;
    }
    if max.is_some_and(|max| schema_len(value) > max) {
        return None;
    }
    Some(Some(value.to_string()))
}

fn required_datetime(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    valid_datetime(value).then(|| value.to_string())
}

fn optional_datetime(value: Option<&Value>) -> Option<Option<String>> {
    let Some(value) = value else {
        return Some(None);
    };
    let value = value.as_str()?;
    valid_datetime(value).then(|| Some(value.to_string()))
}

fn schema_len(value: &str) -> usize {
    value.chars().count()
}

fn valid_datetime(value: &str) -> bool {
    let Some(date_time) = value.strip_suffix('Z') else {
        return false;
    };
    let Some((date, time)) = date_time.split_once('T') else {
        return false;
    };
    if date.len() != 10
        || date.as_bytes().get(4) != Some(&b'-')
        || date.as_bytes().get(7) != Some(&b'-')
        || !date[..4].bytes().all(|value| value.is_ascii_digit())
        || !date[5..7].bytes().all(|value| value.is_ascii_digit())
        || !date[8..10].bytes().all(|value| value.is_ascii_digit())
    {
        return false;
    }
    let year = date[..4].parse::<u32>().unwrap_or_default();
    let month = date[5..7].parse::<u32>().unwrap_or_default();
    let day = date[8..10].parse::<u32>().unwrap_or_default();
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100)) => {
            29
        }
        2 => 28,
        _ => return false,
    };
    if day == 0 || day > days {
        return false;
    }
    let clock = match time.split_once('.') {
        Some((clock, fraction))
            if !fraction.is_empty() && fraction.bytes().all(|value| value.is_ascii_digit()) =>
        {
            clock
        }
        Some(_) => return false,
        None => time,
    };
    if clock.len() != 8 {
        return false;
    }
    if clock.as_bytes().get(2) != Some(&b':') || clock.as_bytes().get(5) != Some(&b':') {
        return false;
    }
    if !clock[..2].bytes().all(|value| value.is_ascii_digit())
        || !clock[3..5].bytes().all(|value| value.is_ascii_digit())
        || !clock[6..8].bytes().all(|value| value.is_ascii_digit())
    {
        return false;
    }
    let hour = clock[..2].parse::<u32>().unwrap_or_default();
    let minute = clock[3..5].parse::<u32>().unwrap_or_default();
    let second = clock[6..8].parse::<u32>().unwrap_or_default();
    hour <= 23 && minute <= 59 && second <= 59
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
    let normalized = value
        .strip_suffix('Z')
        .and_then(|date_time| date_time.split_once('T'))
        .map(|(date, time)| match time.split_once('.') {
            Some((clock, fraction)) => {
                format!("{date}T{clock}.{}Z", &fraction[..fraction.len().min(9)])
            }
            None => format!("{date}T{time}Z"),
        })
        .unwrap_or_else(|| value.to_string());
    DateTime::parse_from_rfc3339(&normalized)
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

    fn write_index(root: &Path, items: Vec<Value>) {
        let directory = root.join("ai-session-history");
        std::fs::create_dir_all(&directory).expect("history directory");
        let mut bytes = serde_json::to_vec_pretty(&json!({
            "schemaVersion": 1,
            "items": items,
        }))
        .expect("index json");
        bytes.push(b'\n');
        std::fs::write(directory.join("index.json"), bytes).expect("write index");
    }

    fn read_index(root: &Path) -> Value {
        serde_json::from_slice(
            &std::fs::read(root.join("ai-session-history/index.json")).expect("read index"),
        )
        .expect("parse index")
    }

    fn detail_path_for(root: &Path, id: &str) -> PathBuf {
        let digest = hex::encode(Sha256::digest(id.as_bytes()));
        root.join("ai-session-history")
            .join("details")
            .join(format!("{digest}.json"))
    }

    fn write_detail(root: &Path, id: &str, value: Value) {
        let path = detail_path_for(root, id);
        std::fs::create_dir_all(path.parent().expect("detail parent")).expect("details directory");
        let mut bytes = serde_json::to_vec_pretty(&value).expect("detail json");
        bytes.push(b'\n');
        std::fs::write(path, bytes).expect("write detail");
    }

    fn read_detail(root: &Path, id: &str) -> Value {
        serde_json::from_slice(&std::fs::read(detail_path_for(root, id)).expect("read detail"))
            .expect("parse detail")
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

    #[test]
    fn history_schema_limits_count_unicode_code_points_like_zod() {
        let accepted = Value::String("😀".repeat(240));
        assert!(optional_trimmed(Some(&accepted), Some(240), true).is_some());

        let rejected = Value::String("😀".repeat(241));
        assert!(optional_trimmed(Some(&rejected), Some(240), true).is_none());
    }

    #[test]
    fn history_reloads_runtime_index_changes_and_rewrites_cleaned_items() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionHistoryStore::new(root.path(), Some(50));
        store
            .upsert(item("ses_0000000000300", "provider-old"), &[])
            .expect("upsert");

        let mut replacement =
            serde_json::to_value(item("ses_0000000000301", "provider-new")).expect("item json");
        let replacement = replacement.as_object_mut().expect("item object");
        replacement.insert(
            "title".to_string(),
            Value::String("  Renamed  ".to_string()),
        );
        replacement.insert("futureField".to_string(), Value::Bool(true));
        write_index(root.path(), vec![Value::Object(replacement.clone())]);

        let listed = store.list(None);
        assert_eq!(
            listed
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["ses_0000000000301"]
        );
        assert_eq!(listed[0].title.as_deref(), Some("Renamed"));
        assert!(store.get("ses_0000000000300").is_none());
        assert!(store.get("ses_0000000000301").is_some());

        let index = read_index(root.path());
        let items = index["items"].as_array().expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["title"], "Renamed");
        assert!(items[0].get("futureField").is_none());
    }

    #[test]
    fn history_removes_invalid_index_items_and_their_details() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionHistoryStore::new(root.path(), Some(50));

        let mut valid =
            serde_json::to_value(item("ses_0000000000400", "provider-valid")).expect("valid item");
        valid
            .as_object_mut()
            .expect("valid object")
            .insert("futureField".to_string(), Value::Bool(true));

        let mut empty_agent =
            serde_json::to_value(item("ses_0000000000401", "provider-agent")).expect("agent item");
        empty_agent["agent"] = Value::String("  ".to_string());

        let mut offset_time =
            serde_json::to_value(item("ses_0000000000402", "provider-time")).expect("time item");
        offset_time["lastActiveAt"] = Value::String("2026-11-02T00:00:00+08:00".to_string());

        let mut bad_model =
            serde_json::to_value(item("ses_0000000000403", "provider-model")).expect("model item");
        bad_model["modelSelection"] = json!({
            "modelEntityId": "model-1",
            "modelName": "Model",
            "futureField": true,
        });

        let mut bad_effort = serde_json::to_value(item("ses_0000000000404", "provider-effort"))
            .expect("effort item");
        bad_effort["reasoningEffort"] = Value::String("extreme".to_string());

        let mut long_id =
            serde_json::to_value(item("placeholder", "provider-long")).expect("long item");
        long_id["id"] = Value::String("x".repeat(121));

        let invalid = [empty_agent, offset_time, bad_model, bad_effort, long_id];
        for value in &invalid {
            let id = value["id"].as_str().expect("invalid id");
            write_detail(root.path(), id, json!({"item": value, "turns": []}));
        }
        write_index(
            root.path(),
            vec![
                valid,
                invalid[0].clone(),
                invalid[1].clone(),
                invalid[2].clone(),
                invalid[3].clone(),
                invalid[4].clone(),
            ],
        );

        let listed = store.list(None);
        assert_eq!(
            listed
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["ses_0000000000400"]
        );
        let index = read_index(root.path());
        let items = index["items"].as_array().expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "ses_0000000000400");
        assert!(items[0].get("futureField").is_none());
        for value in &invalid {
            let id = value["id"].as_str().expect("invalid id");
            assert!(!detail_path_for(root.path(), id).exists());
        }
    }

    #[test]
    fn history_detail_with_mismatched_item_or_non_array_turns_is_replaced() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionHistoryStore::new(root.path(), Some(50));
        let entry = item("ses_0000000000500", "provider-detail");
        store.upsert(entry.clone(), &[]).expect("upsert");
        let other = item("ses_0000000000501", "provider-other");
        write_detail(
            root.path(),
            &entry.id,
            json!({
                "item": serde_json::to_value(other).expect("other json"),
                "turns": [{"id": "turn-1", "status": "completed"}],
            }),
        );

        let detail = store.detail(&entry.id).expect("detail");
        assert!(detail.turns.is_empty());
        assert_eq!(detail.item.id, entry.id);

        let persisted = read_detail(root.path(), &entry.id);
        assert_eq!(persisted["item"]["id"], entry.id);
        assert_eq!(persisted["turns"], json!([]));

        write_detail(
            root.path(),
            &entry.id,
            json!({
                "item": serde_json::to_value(entry.clone()).expect("entry json"),
                "turns": "invalid",
            }),
        );
        let detail = store.detail(&entry.id).expect("detail");
        assert!(detail.turns.is_empty());
        assert_eq!(read_detail(root.path(), &entry.id)["turns"], json!([]));
    }

    #[test]
    fn history_detail_drops_invalid_turns_and_keeps_the_last_fifty() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionHistoryStore::new(root.path(), Some(50));
        let entry = item("ses_0000000000600", "provider-turns");
        store.upsert(entry.clone(), &[]).expect("upsert");

        let mut turns = Vec::new();
        for index in 0..55 {
            let mut turn = json!({
                "id": format!("turn-{index}"),
                "status": "completed",
                "futureField": true,
            });
            if index == 54 {
                turn.as_object_mut().expect("turn object").remove("status");
            }
            turns.push(turn);
        }
        turns.push(json!({"id": "turn-invalid-status", "status": "bogus"}));
        turns.push(json!({"id": "turn-invalid-phase", "status": "completed", "phase": "bogus"}));
        turns.push(json!({"status": "completed"}));
        turns.push(json!({
            "id": "turn-invalid-time",
            "status": "completed",
            "startedAt": "2026-11-02T00:00:00+08:00",
        }));
        turns.push(json!({
            "id": "turn-invalid-attachment",
            "status": "completed",
            "userMessages": [{
                "id": "message-1",
                "text": "hello",
                "attachments": [{
                    "id": "attachment-1",
                    "kind": "file",
                    "name": "file.txt",
                    "mime": "text/plain",
                    "size": 1,
                    "futureField": true,
                }],
            }],
        }));
        turns.push(Value::String("not-an-object".to_string()));
        write_detail(
            root.path(),
            &entry.id,
            json!({
                "item": serde_json::to_value(entry.clone()).expect("entry json"),
                "turns": turns,
            }),
        );

        let detail = store.detail(&entry.id).expect("detail");
        assert_eq!(detail.turns.len(), 50);
        assert_eq!(detail.turns[0]["id"], "turn-5");
        assert_eq!(detail.turns[49]["id"], "turn-54");
        assert_eq!(detail.turns[49]["status"], "running");
        assert!(detail.turns[49].get("futureField").is_none());
        for invalid in [
            "turn-invalid-status",
            "turn-invalid-phase",
            "turn-invalid-time",
            "turn-invalid-attachment",
        ] {
            assert!(!detail
                .turns
                .iter()
                .any(|turn| turn.get("id").and_then(Value::as_str) == Some(invalid)));
        }

        let persisted = read_detail(root.path(), &entry.id);
        let persisted_turns = persisted["turns"].as_array().expect("persisted turns");
        assert_eq!(persisted_turns.len(), 50);
        assert_eq!(persisted_turns[0]["id"], "turn-5");
        assert_eq!(persisted_turns[49]["status"], "running");
        assert!(persisted_turns[49].get("futureField").is_none());
    }
}
