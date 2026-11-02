mod attachments;
mod claude_control_sock;
mod codex_app_server;
mod history;
mod opencode;
mod persistence_settings;
mod provider;
mod timeline;
mod title;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{SecondsFormat, Utc};
use controlled_instance_core::atomic::write_atomic;
use controlled_instance_protocol::{
    AiSessionCounters, AiSessionLatestTurnRef, AiSessionQueue, AiSessionSummary,
    AiSessionsSnapshot, AI_SESSION_SNAPSHOT_LIMIT,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, RwLock,
    },
};
use thiserror::Error;
use uuid::Uuid;

pub use attachments::{
    AiSessionAttachmentContent, AiSessionAttachmentDraftInput, AiSessionAttachmentDraftStreamBegin,
    AiSessionAttachmentDraftStreams, AiSessionAttachmentError,
    AiSessionConversationAttachmentStore, AiSessionMessageAttachmentInput,
    RetainedAiSessionMessageAttachment, StageMessageAttachmentsInput,
    StagedAiSessionMessageAttachments,
};
pub use claude_control_sock::{
    claude_control_socket_path, claude_control_socket_path_from_env, ClaudeControlClient,
    ClaudeControlError, ClaudeControlSockProvider, ClaudeDaemonJob, ClaudeSubscription,
};
pub use codex_app_server::{
    CodexAppServerClient, CodexAppServerProvider, CodexAppServerTarget,
    CodexAppServerTargetResolver, CodexThreadSnapshot,
};
pub use history::{AiSessionHistoryError, AiSessionHistoryRetentionResult, AiSessionHistoryStore};
pub use opencode::{
    OpenCodeConnection, OpenCodeConnectionProvider, OpenCodeModelSelectionProjector,
    OpenCodeSessionProvider,
};
pub use persistence_settings::{
    AiSessionPersistenceSettingsError, AiSessionPersistenceSettingsStore,
};
pub use provider::{
    AiSessionActionResult, AiSessionAttachmentInput, AiSessionAttachmentSourceInput,
    AiSessionControlProvider, AiSessionController, AiSessionCreateInput, AiSessionCreateResult,
    AiSessionForkResult, AiSessionManagedCreateOptions, AiSessionMessageInput,
    AiSessionModelSelection, AiSessionModelSelectionIntent, AiSessionModelSelectionResolver,
    AiSessionPermissionMode, AiSessionReference, AiSessionResumeResult, AiSessionRuntimePathInput,
    AiSessionSendMode, AiSessionStoryAgentToolResolver, ProviderAction, ProviderAttachment,
    ProviderCreateInput, ProviderCreateResult, ProviderError, ProviderEvent, ProviderForkInput,
    ProviderMessage, ProviderMessageInput, ProviderResumeResult,
};
pub use timeline::{
    ai_session_timeline_item_revision, ai_session_timeline_revision,
    sync_ai_session_timeline_items, validate_known_timeline_items, AiSessionTimelineError,
    AiSessionTimelineStore,
};
pub use title::{
    ai_session_title_output_schema, ai_session_title_prompt, parse_ai_session_title,
    AiSessionTitleGenerator, AiSessionTitleInput, AI_SESSION_TITLE_MAX_CHARS,
    AI_SESSION_TITLE_PROMPT_MAX_BYTES,
};

#[derive(Debug, Error)]
pub enum AiSessionStoreError {
    #[error("AI Session id is invalid.")]
    InvalidId,
    #[error("AI Session was not found.")]
    NotFound,
    #[error("AI Session title changed before the rename was applied.")]
    TitleConflict,
    #[error("AI Session queue changed at revision {current_revision}.")]
    QueueRevisionConflict { current_revision: u64 },
    #[error("Queued message was not found.")]
    QueueItemNotFound,
    #[error("Only queued messages can be edited.")]
    QueueItemNotEditable,
    #[error("Queue order must contain every currently queued message exactly once.")]
    QueueOrderInvalid,
    #[error("AI Session persistence failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("AI Session serialization failed: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSession {
    pub id: String,
    pub agent: String,
    #[serde(default = "default_creation_source")]
    pub creation_source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_meta: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub story_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_binding_keys: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd_folder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<Value>>,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_phase")]
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_tool: Option<Value>,
    #[serde(default)]
    pub tool_calls_since_last_message: u64,
    #[serde(default)]
    pub sub_agents: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_size: Option<u64>,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub counters: AiSessionCounters,
    #[serde(default)]
    pub queue: AiSessionQueue,
    #[serde(default)]
    pub unread: bool,
}

impl AiSession {
    fn summary_actions(&self) -> Value {
        let configured = self.actions.as_ref().and_then(Value::as_object);
        let configured_bool = |field: &str| {
            configured
                .and_then(|actions| actions.get(field))
                .and_then(Value::as_bool)
        };
        let active = matches!(self.status.as_str(), "running" | "waiting");
        let has_provider_session = self
            .provider_session_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        let has_app_session = self
            .app_session_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        serde_json::json!({
            "send": configured_bool("send").unwrap_or(true),
            "interrupt": active && configured_bool("interrupt").unwrap_or(true),
            "approval": self.status == "waiting"
                && self.phase == "approval"
                && configured_bool("approval").unwrap_or(true),
            "fork": configured_bool("fork").unwrap_or(false),
            "rename": configured_bool("rename").unwrap_or(false),
            "openApp": configured_bool("openApp")
                .unwrap_or(has_provider_session && !has_app_session),
            "close": configured_bool("close").unwrap_or(has_provider_session),
        })
    }

    pub fn summary(&self) -> AiSessionSummary {
        let meaningful_turns = self.conversation_turns();
        let latest_turn_ref = meaningful_turns.last().and_then(|turn| {
            Some(AiSessionLatestTurnRef {
                id: turn.get("id")?.as_str()?.to_string(),
                body_revision: turn_body_revision(turn),
            })
        });
        let last_user_message_at = meaningful_turns
            .iter()
            .rev()
            .find(|turn| {
                turn.get("userPrompt")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
            })
            .and_then(|turn| {
                turn.get("startedAt")
                    .or_else(|| turn.get("updatedAt"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .or_else(|| {
                self.user_prompt
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .map(|_| self.started_at.clone())
            });
        let current_tool = self.current_tool.as_ref().map(|tool| {
            let mut tool = tool.clone();
            if let Some(object) = tool.as_object_mut() {
                object.remove("inputPreview");
            }
            tool
        });
        AiSessionSummary {
            id: self.id.clone(),
            agent: self.agent.clone(),
            creation_source: self.creation_source.clone(),
            app_session_id: self.app_session_id.clone(),
            app_id: self.app_id.clone(),
            provider_session_id: self.provider_session_id.clone(),
            lineage: self.lineage.clone(),
            provider_meta: None,
            model_selection: self.model_selection.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            story_id: self.story_id.clone(),
            app_binding_keys: self.app_binding_keys.as_ref().map(|keys| {
                keys.iter()
                    .take(3)
                    .map(|value| compact_text(value, 120))
                    .collect()
            }),
            actions: Some(self.summary_actions()),
            active_turn_id: self.active_turn_id.clone(),
            title: self.title.clone(),
            cwd: self.cwd.as_deref().map(|value| compact_text(value, 512)),
            cwd_folder_id: self.cwd_folder_id.clone(),
            user_prompt: self
                .user_prompt
                .as_deref()
                .map(|value| compact_text(value, 400)),
            detail_revision: Some(self.detail_revision()),
            turns_revision: Some(self.turns_revision()),
            latest_turn_ref,
            turn_count: Some(meaningful_turns.len() as u64),
            last_user_message_at,
            turns: None,
            status: self.status.clone(),
            phase: self.phase.clone(),
            summary: self
                .summary
                .as_deref()
                .map(|value| compact_text(value, 300)),
            last_message: self
                .last_message
                .as_deref()
                .map(|value| compact_text(value, 800)),
            last_message_item_id: self.last_message_item_id.clone(),
            current_tool,
            tool_calls_since_last_message: self.tool_calls_since_last_message,
            sub_agents: Vec::new(),
            sub_agent_count: Some(self.sub_agents.len() as u64),
            started_at: self.started_at.clone(),
            updated_at: self.updated_at.clone(),
            error: self.error.as_deref().map(|value| compact_text(value, 300)),
            queue: AiSessionQueue {
                revision: self.queue.revision,
                pending_count: self.queue.pending_count,
                paused: self.queue.paused.unwrap_or(false).then_some(true),
                items: Vec::new(),
            },
            unread: self.unread,
        }
    }

    pub fn is_bound(&self, running_app_sessions: &HashSet<String>) -> bool {
        match self.app_session_id.as_deref() {
            Some(app_session_id) => running_app_sessions.contains(app_session_id),
            None => self.creation_source == "ai-session" && self.provider_session_id.is_some(),
        }
    }

    pub fn detail(&self) -> Value {
        let mut detail = Map::new();
        insert_optional(&mut detail, "appBindingKeys", self.app_binding_keys.clone());
        insert_optional(&mut detail, "cwd", self.cwd.clone());
        insert_optional(&mut detail, "error", self.error.clone());
        insert_optional(&mut detail, "providerMeta", self.provider_meta.clone());
        insert_optional(&mut detail, "modelSelection", self.model_selection.clone());
        insert_optional(
            &mut detail,
            "reasoningEffort",
            self.reasoning_effort.clone(),
        );
        detail.insert(
            "queue".to_string(),
            serde_json::to_value(&self.queue).unwrap_or(Value::Null),
        );
        detail.insert(
            "subAgents".to_string(),
            Value::Array(self.sub_agents.clone()),
        );
        Value::Object(detail)
    }

    pub fn detail_revision(&self) -> String {
        revision_hash(&self.detail())
    }

    pub fn conversation_turns(&self) -> Vec<&Value> {
        self.turns
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter(|turn| is_meaningful_turn(turn))
            .collect()
    }

    pub fn turns_revision(&self) -> String {
        let index = self
            .conversation_turns()
            .into_iter()
            .map(|turn| {
                let mut entry = Map::new();
                if let Some(id) = turn.get("id") {
                    entry.insert("id".to_string(), id.clone());
                }
                if let Some(provider_turn_id) = turn.get("providerTurnId") {
                    entry.insert("providerTurnId".to_string(), provider_turn_id.clone());
                }
                Value::Object(entry)
            })
            .collect::<Vec<_>>();
        revision_hash(&Value::Array(index))
    }

    fn sanitize(mut self) -> Self {
        self.creation_source = if self.creation_source == "ai-session" {
            "ai-session"
        } else {
            "app-session"
        }
        .to_string();
        self.status = normalize_status(&self.status);
        self.phase = normalize_phase(&self.phase);
        self.queue.pending_count = self
            .queue
            .items
            .iter()
            .filter(|item| {
                matches!(
                    item.get("status").and_then(Value::as_str),
                    Some("queued" | "sending")
                )
            })
            .count() as u64;
        if self.queue.paused == Some(false) {
            self.queue.paused = None;
        }
        if self
            .provider_meta
            .as_ref()
            .is_some_and(|value| !value.is_object())
        {
            self.provider_meta = None;
        }
        self
    }
}

pub fn ai_session_turn_body_revision(turn: &Value) -> String {
    turn_body_revision(turn)
}

#[derive(Debug)]
pub struct AiSessionRuntime {
    sessions: RwLock<BTreeMap<String, AiSession>>,
    stream_id: String,
    revision: AtomicU64,
    last_event_at: RwLock<String>,
    persistence_dir: Option<PathBuf>,
    mutation: Mutex<()>,
}

#[derive(Debug, Clone)]
pub struct EnqueuedAiSessionMessage {
    pub session: AiSession,
    pub queue_id: String,
}

impl Default for AiSessionRuntime {
    fn default() -> Self {
        Self::new("standalone", None)
    }
}

impl AiSessionRuntime {
    pub fn new(instance_id: &str, persistence_dir: Option<PathBuf>) -> Self {
        let runtime = Self {
            sessions: RwLock::new(BTreeMap::new()),
            stream_id: format!("ais_{instance_id}_{}", Uuid::new_v4()),
            revision: AtomicU64::new(0),
            last_event_at: RwLock::new(now_iso()),
            persistence_dir,
            mutation: Mutex::new(()),
        };
        if let Some(directory) = runtime.persistence_dir.as_deref() {
            runtime.load(directory);
        }
        runtime
    }

    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    pub fn last_event_at(&self) -> String {
        self.last_event_at
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn get(&self, id: &str) -> Option<AiSession> {
        if !is_safe_session_id(id) {
            return None;
        }
        self.sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
    }

    pub fn get_by_provider_session_id(
        &self,
        agent: &str,
        provider_session_id: &str,
    ) -> Option<AiSession> {
        if provider_session_id.trim().is_empty() {
            return None;
        }
        self.sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .find(|session| {
                session.agent == agent
                    && session.provider_session_id.as_deref() == Some(provider_session_id)
            })
            .cloned()
    }

    pub fn list(&self) -> Vec<AiSession> {
        let mut sessions = self
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        sessions
    }

    pub fn save(&self, mut session: AiSession) -> Result<AiSession, AiSessionStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.save_locked(&mut session)
    }

    fn save_locked(&self, session: &mut AiSession) -> Result<AiSession, AiSessionStoreError> {
        if !is_safe_session_id(&session.id) {
            return Err(AiSessionStoreError::InvalidId);
        }
        if session.started_at.is_empty() {
            session.started_at = now_iso();
        }
        if session.updated_at.is_empty() {
            session.updated_at = now_iso();
        }
        let sanitized = session.clone().sanitize();
        *session = sanitized;
        self.write_session(session)?;
        self.sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session.id.clone(), session.clone());
        self.bump_revision();
        Ok(session.clone())
    }

    pub fn remove(&self, id: &str) -> Result<Option<AiSession>, AiSessionStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !is_safe_session_id(id) {
            return Ok(None);
        }
        let removed = self
            .sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
        if removed.is_some() {
            if let Some(directory) = self.persistence_dir.as_deref() {
                match std::fs::remove_file(directory.join(format!("{id}.json"))) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(AiSessionStoreError::Io(error)),
                }
            }
            self.bump_revision();
        }
        Ok(removed)
    }

    pub fn rename(
        &self,
        id: &str,
        title: &str,
        expected_title: Option<&str>,
    ) -> Result<AiSession, AiSessionStoreError> {
        self.rename_with_disposition(id, title, expected_title)
            .map(|(session, _)| session)
    }

    pub fn rename_with_disposition(
        &self,
        id: &str,
        title: &str,
        expected_title: Option<&str>,
    ) -> Result<(AiSession, bool), AiSessionStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut session = self.get(id).ok_or(AiSessionStoreError::NotFound)?;
        let current_title = session.title.as_deref().unwrap_or_default();
        if expected_title.is_some_and(|expected| current_title != expected) {
            return Err(AiSessionStoreError::TitleConflict);
        }
        let title = title.trim().chars().take(120).collect::<String>();
        if current_title == title {
            return Ok((session, false));
        }
        session.title = Some(title);
        session.updated_at = now_iso();
        self.save_locked(&mut session)
            .map(|session| (session, true))
    }

    pub fn mark_read(&self, id: &str) -> Result<AiSession, AiSessionStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut session = self.get(id).ok_or(AiSessionStoreError::NotFound)?;
        if !session.unread {
            return Ok(session);
        }
        session.unread = false;
        self.save_locked(&mut session)
    }

    pub fn update<F>(&self, id: &str, mutate: F) -> Result<AiSession, AiSessionStoreError>
    where
        F: FnOnce(&mut AiSession) -> Result<bool, AiSessionStoreError>,
    {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut session = self.get(id).ok_or(AiSessionStoreError::NotFound)?;
        let changed = mutate(&mut session)?;
        if !changed {
            return Ok(session);
        }
        session.updated_at = now_iso();
        self.save_locked(&mut session)
    }

    pub fn queue(&self, id: &str) -> Option<AiSessionQueue> {
        self.get(id).map(|session| session.queue)
    }

    pub fn enqueue_message(
        &self,
        id: &str,
        message: &str,
        attachments: Vec<Value>,
        references: Vec<Value>,
        permission_mode: Option<&str>,
        message_id: Option<&str>,
    ) -> Result<Option<EnqueuedAiSessionMessage>, AiSessionStoreError> {
        let message = message.trim();
        if message.is_empty() || message.chars().count() > 20_000 {
            return Err(AiSessionStoreError::QueueItemNotEditable);
        }
        let queue_id = format!("aiq_{}", &Uuid::new_v4().simple().to_string()[..20]);
        let queued_id = queue_id.clone();
        let mut queued_item = false;
        let session = self.update(id, |session| {
            normalize_queue(session);
            if session.queue.items.len() >= 100 {
                return Ok(false);
            }
            let timestamp = now_iso();
            let mut item = Map::new();
            item.insert("id".to_string(), Value::String(queued_id.clone()));
            if let Some(message_id) = message_id {
                item.insert(
                    "messageId".to_string(),
                    Value::String(message_id.to_string()),
                );
            }
            item.insert("message".to_string(), Value::String(message.to_string()));
            item.insert("attachments".to_string(), Value::Array(attachments));
            item.insert("references".to_string(), Value::Array(references));
            if let Some(permission_mode) = permission_mode {
                item.insert(
                    "permissionMode".to_string(),
                    Value::String(permission_mode.to_string()),
                );
            }
            item.insert("status".to_string(), Value::String("queued".to_string()));
            item.insert("createdAt".to_string(), Value::String(timestamp.clone()));
            item.insert("updatedAt".to_string(), Value::String(timestamp));
            session.queue.items.push(Value::Object(item));
            self.bump_queue(session, None);
            queued_item = true;
            Ok(true)
        })?;
        Ok(queued_item.then_some(EnqueuedAiSessionMessage { session, queue_id }))
    }

    pub fn next_queued_item(&self, id: &str) -> Option<Value> {
        self.get(id)?
            .queue
            .items
            .into_iter()
            .find(|item| item.get("status").and_then(Value::as_str) == Some("queued"))
    }

    pub fn set_queue_item_status(
        &self,
        id: &str,
        queue_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<AiSession, AiSessionStoreError> {
        self.update(id, |session| {
            let Some(item) = session
                .queue
                .items
                .iter_mut()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(queue_id))
            else {
                return Err(AiSessionStoreError::QueueItemNotFound);
            };
            let Some(object) = item.as_object_mut() else {
                return Err(AiSessionStoreError::QueueItemNotFound);
            };
            object.insert("status".to_string(), Value::String(status.to_string()));
            match error {
                Some(error) => {
                    object.insert("error".to_string(), Value::String(error.to_string()));
                }
                None => {
                    object.remove("error");
                }
            }
            object.insert("updatedAt".to_string(), Value::String(now_iso()));
            self.bump_queue(session, None);
            Ok(true)
        })
    }

    pub fn remove_queue_item(
        &self,
        id: &str,
        queue_id: &str,
    ) -> Result<AiSession, AiSessionStoreError> {
        self.update(id, |session| {
            let before = session.queue.items.len();
            session
                .queue
                .items
                .retain(|item| item.get("id").and_then(Value::as_str) != Some(queue_id));
            if session.queue.items.len() == before {
                return Err(AiSessionStoreError::QueueItemNotFound);
            }
            self.bump_queue(session, None);
            Ok(true)
        })
    }

    pub fn retry_queue_item(
        &self,
        id: &str,
        queue_id: &str,
    ) -> Result<AiSession, AiSessionStoreError> {
        self.update(id, |session| {
            let Some(item) = session
                .queue
                .items
                .iter_mut()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(queue_id))
            else {
                return Err(AiSessionStoreError::QueueItemNotFound);
            };
            let Some(object) = item.as_object_mut() else {
                return Err(AiSessionStoreError::QueueItemNotFound);
            };
            object.insert("status".to_string(), Value::String("queued".to_string()));
            object.remove("error");
            object.insert("updatedAt".to_string(), Value::String(now_iso()));
            self.bump_queue(session, None);
            Ok(true)
        })
    }

    pub fn edit_queue_item(
        &self,
        id: &str,
        queue_id: &str,
        expected_revision: u64,
        message: &str,
    ) -> Result<AiSession, AiSessionStoreError> {
        self.edit_queue_item_details(id, queue_id, expected_revision, message, None, None)
    }

    pub fn edit_queue_item_details(
        &self,
        id: &str,
        queue_id: &str,
        expected_revision: u64,
        message: &str,
        message_id: Option<&str>,
        attachments: Option<Vec<Value>>,
    ) -> Result<AiSession, AiSessionStoreError> {
        let message = message.trim();
        if message.is_empty() || message.chars().count() > 20_000 {
            return Err(AiSessionStoreError::QueueItemNotEditable);
        }
        self.update(id, |session| {
            if session.queue.revision != expected_revision {
                return Err(AiSessionStoreError::QueueRevisionConflict {
                    current_revision: session.queue.revision,
                });
            }
            let Some(item) = session
                .queue
                .items
                .iter_mut()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(queue_id))
            else {
                return Err(AiSessionStoreError::QueueItemNotFound);
            };
            if item.get("status").and_then(Value::as_str) != Some("queued") {
                return Err(AiSessionStoreError::QueueItemNotEditable);
            }
            if item.get("message").and_then(Value::as_str) == Some(message)
                && message_id.is_none_or(|message_id| {
                    item.get("messageId").and_then(Value::as_str) == Some(message_id)
                })
                && attachments.as_ref().is_none_or(|attachments| {
                    item.get("attachments") == Some(&Value::Array(attachments.clone()))
                })
            {
                return Ok(false);
            }
            let Some(object) = item.as_object_mut() else {
                return Err(AiSessionStoreError::QueueItemNotFound);
            };
            object.insert("message".to_string(), Value::String(message.to_string()));
            if let Some(message_id) = message_id {
                object.insert(
                    "messageId".to_string(),
                    Value::String(message_id.to_string()),
                );
            }
            if let Some(attachments) = attachments {
                object.insert("attachments".to_string(), Value::Array(attachments));
            }
            object.insert("updatedAt".to_string(), Value::String(now_iso()));
            self.bump_queue(session, None);
            Ok(true)
        })
    }

    pub fn reorder_queue_items(
        &self,
        id: &str,
        expected_revision: u64,
        queue_ids: &[String],
    ) -> Result<AiSession, AiSessionStoreError> {
        self.update(id, |session| {
            if session.queue.revision != expected_revision {
                return Err(AiSessionStoreError::QueueRevisionConflict {
                    current_revision: session.queue.revision,
                });
            }
            let queued = session
                .queue
                .items
                .iter()
                .filter(|item| item.get("status").and_then(Value::as_str) == Some("queued"))
                .cloned()
                .collect::<Vec<_>>();
            let requested = queue_ids.iter().collect::<HashSet<_>>();
            if requested.len() != queue_ids.len()
                || queue_ids.len() != queued.len()
                || queued.iter().any(|item| {
                    !item
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| requested.contains(&id.to_string()))
                })
            {
                return Err(AiSessionStoreError::QueueOrderInvalid);
            }
            if queued
                .iter()
                .zip(queue_ids)
                .all(|(item, id)| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
            {
                return Ok(false);
            }
            let by_id = queued
                .into_iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_str)?.to_string();
                    Some((id, item))
                })
                .collect::<BTreeMap<_, _>>();
            session
                .queue
                .items
                .retain(|item| item.get("status").and_then(Value::as_str) != Some("queued"));
            session
                .queue
                .items
                .extend(queue_ids.iter().filter_map(|id| by_id.get(id).cloned()));
            self.bump_queue(session, None);
            Ok(true)
        })
    }

    pub fn set_queue_paused(
        &self,
        id: &str,
        paused: bool,
    ) -> Result<AiSession, AiSessionStoreError> {
        self.update(id, |session| {
            if session.queue.paused.unwrap_or(false) == paused {
                return Ok(false);
            }
            session.queue.paused = paused.then_some(true);
            Ok(true)
        })
    }

    fn bump_queue(&self, session: &mut AiSession, paused: Option<bool>) {
        normalize_queue(session);
        session.queue.revision = session.queue.revision.saturating_add(1);
        if let Some(paused) = paused {
            session.queue.paused = paused.then_some(true);
        }
        session.queue.pending_count = session
            .queue
            .items
            .iter()
            .filter(|item| {
                matches!(
                    item.get("status").and_then(Value::as_str),
                    Some("queued" | "sending")
                )
            })
            .count() as u64;
    }

    pub fn bound_snapshot(&self, running_app_session_ids: &[String]) -> AiSessionsSnapshot {
        self.bound_snapshot_with_limit(running_app_session_ids, AI_SESSION_SNAPSHOT_LIMIT)
    }

    pub fn bound_snapshot_with_limit(
        &self,
        running_app_session_ids: &[String],
        limit: usize,
    ) -> AiSessionsSnapshot {
        let running = running_app_session_ids
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        let sessions = self
            .list()
            .into_iter()
            .filter(|session| session.is_bound(&running))
            .take(limit)
            .collect::<Vec<_>>();
        AiSessionsSnapshot {
            running_count: sessions
                .iter()
                .filter(|session| session.status == "running")
                .count() as u64,
            waiting_count: sessions
                .iter()
                .filter(|session| session.status == "waiting")
                .count() as u64,
            stale_count: 0,
            sessions: sessions
                .into_iter()
                .map(|session| session.summary())
                .collect(),
            updated_at: now_iso(),
        }
    }

    fn bump_revision(&self) {
        self.revision.fetch_add(1, Ordering::SeqCst);
        *self
            .last_event_at
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = now_iso();
    }

    fn write_session(&self, session: &AiSession) -> Result<(), AiSessionStoreError> {
        let Some(directory) = self.persistence_dir.as_deref() else {
            return Ok(());
        };
        std::fs::create_dir_all(directory)?;
        let bytes = serde_json::to_vec_pretty(session)?;
        let mut file = bytes;
        file.push(b'\n');
        write_atomic(
            &directory.join(format!("{}.json", session.id)),
            &file,
            Some(0o600),
        )?;
        Ok(())
    }

    fn load(&self, directory: &Path) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        let mut sessions = self
            .sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let expected_id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(session) = serde_json::from_slice::<AiSession>(&bytes) else {
                tracing::warn!(path = %path.display(), "ignoring invalid persisted AI Session");
                continue;
            };
            if session.id != expected_id || !is_safe_session_id(&session.id) {
                continue;
            }
            let session = session.sanitize();
            sessions.insert(session.id.clone(), session);
        }
    }
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<impl Serialize>) {
    if let Some(value) = value {
        if let Ok(value) = serde_json::to_value(value) {
            map.insert(key.to_string(), value);
        }
    }
}

fn normalize_queue(session: &mut AiSession) {
    session.queue.items.retain(queue_item_is_valid);
    session.queue.items.truncate(100);
    session
        .queue
        .items
        .sort_by_key(|item| queue_status_rank(item));
}

fn queue_item_is_valid(item: &Value) -> bool {
    ["id", "message", "createdAt", "updatedAt"]
        .iter()
        .all(|field| item.get(field).and_then(Value::as_str).is_some())
}

fn queue_status_rank(item: &Value) -> u8 {
    match item.get("status").and_then(Value::as_str) {
        Some("sending") => 0,
        Some("queued") => 1,
        _ => 2,
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn compact_text(value: &str, max: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        return text;
    }
    let mut truncated = text.chars().take(max.saturating_sub(3)).collect::<String>();
    truncated.push_str("...");
    truncated
}

fn is_meaningful_turn(turn: &Value) -> bool {
    ["userPrompt", "lastMessage", "summary"]
        .iter()
        .any(|field| {
            turn.get(*field)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
        })
        || turn
            .get("contextCompactions")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
}

fn turn_body_revision(turn: &Value) -> String {
    let mut body = turn.clone();
    if let Some(object) = body.as_object_mut() {
        object.remove("observedAt");
        object.remove("snapshotVersion");
        object.remove("revision");
    }
    revision_hash(&body)
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

fn normalize_status(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "waiting" => "waiting",
        "failed" => "failed",
        "idle" | "completed" | "stale" | "stopped" | "exited" => "idle",
        _ => "running",
    }
    .to_string()
}

fn normalize_phase(value: &str) -> String {
    match value {
        "thinking" | "tool" | "editing" | "approval" | "responding" => value,
        _ => "unknown",
    }
    .to_string()
}

fn default_creation_source() -> String {
    "app-session".to_string()
}

fn default_status() -> String {
    "running".to_string()
}

fn default_phase() -> String {
    "unknown".to_string()
}

fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains('\0')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(id: &str, app_session_id: Option<&str>, status: &str) -> AiSession {
        AiSession {
            id: id.to_string(),
            agent: "codex".to_string(),
            creation_source: if app_session_id.is_some() {
                "app-session"
            } else {
                "ai-session"
            }
            .to_string(),
            app_session_id: app_session_id.map(ToString::to_string),
            app_id: None,
            provider_session_id: Some(format!("provider-{id}")),
            lineage: None,
            provider_meta: None,
            model_selection: None,
            reasoning_effort: None,
            story_id: None,
            app_binding_keys: None,
            actions: None,
            active_turn_id: None,
            title: Some("Example".to_string()),
            cwd: Some("/workspace".to_string()),
            cwd_folder_id: None,
            user_prompt: None,
            turns: None,
            status: status.to_string(),
            phase: "thinking".to_string(),
            summary: None,
            last_message: None,
            last_message_item_id: None,
            current_tool: None,
            tool_calls_since_last_message: 0,
            sub_agents: Vec::new(),
            transcript_path: None,
            transcript_size: None,
            started_at: "2026-11-02T00:00:00.000Z".to_string(),
            updated_at: "2026-11-02T00:00:00.000Z".to_string(),
            completed_at: None,
            error: None,
            counters: AiSessionCounters::default(),
            queue: AiSessionQueue::default(),
            unread: false,
        }
    }

    #[test]
    fn bound_snapshot_counts_authoritative_sessions() {
        let runtime = AiSessionRuntime::default();
        runtime
            .save(session("ses_0000000000001", None, "running"))
            .expect("save");
        runtime
            .save(session(
                "ses_0000000000002",
                Some("aps_0000000000001"),
                "waiting",
            ))
            .expect("save");
        let snapshot = runtime.bound_snapshot(&["aps_0000000000001".to_string()]);
        assert_eq!(snapshot.running_count, 1);
        assert_eq!(snapshot.waiting_count, 1);
        assert_eq!(snapshot.sessions.len(), 2);

        let unbound = runtime.bound_snapshot(&[]);
        assert_eq!(unbound.sessions.len(), 1);
        assert_eq!(unbound.sessions[0].id, "ses_0000000000001");
    }

    #[test]
    fn summary_actions_fill_the_node_defaults_from_the_effective_session_state() {
        let mut session = session("ses_0000000000004", None, "waiting");
        session.phase = "approval".to_string();
        session.actions = Some(json!({ "fork": false, "close": true }));

        let actions = session.summary().actions.expect("actions");
        assert_eq!(actions["send"], true);
        assert_eq!(actions["interrupt"], true);
        assert_eq!(actions["approval"], true);
        assert_eq!(actions["fork"], false);
        assert_eq!(actions["rename"], false);
        assert_eq!(actions["openApp"], true);
        assert_eq!(actions["close"], true);

        session.app_session_id = Some("aps_0000000000004".to_string());
        session.actions = Some(json!({ "send": false, "interrupt": false }));
        session.status = "idle".to_string();
        let actions = session.summary().actions.expect("actions");
        assert_eq!(actions["send"], false);
        assert_eq!(actions["interrupt"], false);
        assert_eq!(actions["approval"], false);
        assert_eq!(actions["openApp"], false);
        assert_eq!(actions["close"], true);
    }

    #[test]
    fn persisted_node_records_are_sanitized_without_leaking_unknown_fields() {
        let root = tempfile::tempdir().expect("tempdir");
        let record = json!({
            "id": "ses_0000000000003",
            "agent": "codex",
            "creationSource": "ai-session",
            "providerSessionId": "thread-1",
            "status": "idle",
            "phase": "unknown",
            "startedAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:01:00.000Z",
            "counters": { "toolCalls": 2, "edits": 1, "approvals": 0 },
            "queue": { "revision": 0, "pendingCount": 0, "items": [] },
            "transcriptPath": "/tmp/transcript.jsonl",
            "futureField": { "opaque": true }
        });
        std::fs::write(
            root.path().join("ses_0000000000003.json"),
            serde_json::to_vec_pretty(&record).expect("json"),
        )
        .expect("write");
        let runtime = AiSessionRuntime::new("ins_1", Some(root.path().to_path_buf()));
        let loaded = runtime.get("ses_0000000000003").expect("session");
        let summary = serde_json::to_value(loaded.summary()).expect("summary");
        assert!(summary.get("futureField").is_none());
        assert!(summary.get("transcriptPath").is_none());
        assert!(summary.get("counters").is_none());
        assert!(summary.get("completedAt").is_none());

        runtime
            .rename("ses_0000000000003", "Renamed", None)
            .expect("rename");
        let persisted: Value = serde_json::from_slice(
            &std::fs::read(root.path().join("ses_0000000000003.json")).expect("read"),
        )
        .expect("persisted json");
        assert_eq!(persisted["title"], "Renamed");
        assert!(persisted.get("futureField").is_none());
        assert_eq!(persisted["transcriptPath"], "/tmp/transcript.jsonl");
    }

    #[test]
    fn heartbeat_summary_is_bounded_and_revisioned() {
        let runtime = AiSessionRuntime::default();
        let mut initial = session("ses_0000000000005", None, "waiting");
        initial.app_binding_keys = Some(vec![
            "one".to_string(),
            "two".to_string(),
            "three".to_string(),
            "four".to_string(),
        ]);
        initial.turns = Some(vec![
            json!({
                "id": "turn-1",
                "userPrompt": "first prompt",
                "startedAt": "2026-11-02T00:00:00.000Z",
                "status": "completed"
            }),
            json!({
                "id": "turn-2",
                "userPrompt": "latest prompt",
                "userMessages": [{ "text": "not in the summary" }],
                "startedAt": "2026-11-02T00:01:00.000Z",
                "status": "running"
            }),
        ]);
        initial.queue.items = vec![json!({
            "id": "queue-1",
            "message": "queued",
            "status": "queued",
            "createdAt": "2026-11-02T00:01:00.000Z",
            "updatedAt": "2026-11-02T00:01:00.000Z"
        })];
        let saved = runtime.save(initial).expect("save");
        let summary = saved.summary();
        assert_eq!(summary.turns, None);
        assert_eq!(summary.turn_count, Some(2));
        assert_eq!(summary.sub_agent_count, Some(0));
        assert_eq!(summary.app_binding_keys.as_ref().map(Vec::len), Some(3));
        assert!(summary
            .detail_revision
            .as_deref()
            .is_some_and(|value| value.len() == 22));
        assert!(summary
            .turns_revision
            .as_deref()
            .is_some_and(|value| value.len() == 22));
        assert_eq!(
            summary
                .latest_turn_ref
                .as_ref()
                .map(|value| value.id.as_str()),
            Some("turn-2")
        );
        assert!(summary
            .latest_turn_ref
            .as_ref()
            .is_some_and(|value| value.body_revision.len() == 22));
        assert_eq!(
            summary.last_user_message_at.as_deref(),
            Some("2026-11-02T00:01:00.000Z")
        );
        assert_eq!(summary.queue.pending_count, 1);
        assert!(summary.queue.items.is_empty());
    }

    #[test]
    fn queue_normalization_enforces_the_protocol_limit_and_status_order() {
        let runtime = AiSessionRuntime::default();
        let mut initial = session("ses_0000000000006", None, "running");
        initial.queue.items = (0..100)
            .map(|index| {
                json!({
                    "id": format!("aiq_{index:020}"),
                    "message": format!("queued {index}"),
                    "status": if index == 99 { "sending" } else { "queued" },
                    "createdAt": "2026-11-02T00:00:00.000Z",
                    "updatedAt": "2026-11-02T00:00:00.000Z"
                })
            })
            .collect();
        runtime.save(initial).expect("save");
        let revision = runtime.queue("ses_0000000000006").expect("queue").revision;
        assert!(runtime
            .enqueue_message(
                "ses_0000000000006",
                "one too many",
                Vec::new(),
                Vec::new(),
                None,
                None,
            )
            .expect("queue result")
            .is_none());
        let queue = runtime.queue("ses_0000000000006").expect("queue");
        assert_eq!(queue.items.len(), 100);
        assert_eq!(queue.revision, revision);

        let mut ordering = session("ses_0000000000007", None, "running");
        ordering.queue.items = vec![
            json!({
                "id": "aiq_failed",
                "message": "failed",
                "status": "failed",
                "createdAt": "2026-11-02T00:00:00.000Z",
                "updatedAt": "2026-11-02T00:00:00.000Z"
            }),
            json!({
                "id": "aiq_queued",
                "message": "queued",
                "status": "queued",
                "createdAt": "2026-11-02T00:00:00.000Z",
                "updatedAt": "2026-11-02T00:00:00.000Z"
            }),
            json!({ "id": "invalid" }),
        ];
        runtime.save(ordering).expect("save ordering");
        let queued = runtime
            .enqueue_message(
                "ses_0000000000007",
                "new",
                Vec::new(),
                Vec::new(),
                None,
                None,
            )
            .expect("queue")
            .expect("queued");
        let statuses = queued
            .session
            .queue
            .items
            .iter()
            .filter_map(|item| item["status"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(statuses, vec!["queued", "queued", "failed"]);
    }

    #[test]
    fn read_and_rename_use_the_single_writer_revision() {
        let runtime = AiSessionRuntime::default();
        let mut initial = session("ses_0000000000004", None, "idle");
        initial.unread = true;
        runtime.save(initial).expect("save");
        assert_eq!(runtime.revision(), 1);
        let read = runtime.mark_read("ses_0000000000004").expect("read");
        assert!(!read.unread);
        assert_eq!(runtime.revision(), 2);
        let renamed = runtime
            .rename("ses_0000000000004", "New title", Some("Example"))
            .expect("rename");
        assert_eq!(renamed.title.as_deref(), Some("New title"));
        assert_eq!(runtime.revision(), 3);
        assert!(matches!(
            runtime.rename("ses_0000000000004", "Blocked", Some("stale")),
            Err(AiSessionStoreError::TitleConflict)
        ));
    }
}
