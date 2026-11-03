use chrono::{SecondsFormat, Utc};
use controlled_instance_ai_session::{
    AiSession, AiSessionController, AiSessionRuntime, AiSessionStoreError, ProviderError,
};
use controlled_instance_app_runtime::{AppRuntime, AppRuntimeError, AppSession};
use controlled_instance_core::{atomic::write_json_atomic, fs_permissions::restrict_path};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use thiserror::Error;
use tokio::sync::{broadcast, OwnedMutexGuard};
use uuid::Uuid;

const RENAME_RETRY_BASE: std::time::Duration = std::time::Duration::from_millis(1_000);
const RENAME_RETRY_MAX: std::time::Duration = std::time::Duration::from_millis(30_000);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameIntent {
    schema_version: u64,
    operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_request_id: Option<String>,
    ai_session_id: String,
    agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_session_id: Option<String>,
    app_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_title: Option<String>,
    target_title: String,
    authority: String,
    phase: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRenameIntents {
    schema_version: u64,
    intents: Vec<RenameIntent>,
}

struct RenameIntentStore {
    path: PathBuf,
    intents: Mutex<HashMap<String, RenameIntent>>,
}

impl RenameIntentStore {
    fn new(data_dir: &std::path::Path) -> Self {
        let store = Self {
            path: data_dir.join("ai-session-renames").join("intents.json"),
            intents: Mutex::new(HashMap::new()),
        };
        store.load();
        store
    }

    fn list(&self) -> Vec<RenameIntent> {
        let mut intents = self
            .intents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        intents.sort_by(|left, right| left.operation_id.cmp(&right.operation_id));
        intents
    }

    fn get(&self, operation_id: &str) -> Option<RenameIntent> {
        self.intents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(operation_id)
            .cloned()
    }

    fn find_by_client_request_id(&self, client_request_id: &str) -> Option<RenameIntent> {
        self.intents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .find(|intent| intent.client_request_id.as_deref() == Some(client_request_id))
            .cloned()
    }

    fn put(&self, intent: RenameIntent) -> std::io::Result<RenameIntent> {
        self.intents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(intent.operation_id.clone(), intent.clone());
        self.persist()?;
        Ok(intent)
    }

    fn remove(&self, operation_id: &str) {
        let removed = self
            .intents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(operation_id)
            .is_some();
        if removed {
            let _ = self.persist();
        }
    }

    fn load(&self) {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                tracing::warn!(%error, path = %self.path.display(), "failed to read AI Session rename intents");
                return;
            }
        };
        let Ok(raw) = serde_json::from_slice::<Value>(&bytes) else {
            tracing::warn!(path = %self.path.display(), "AI Session rename intent file is invalid");
            return;
        };
        if raw.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
            tracing::warn!(path = %self.path.display(), "AI Session rename intent schema is unsupported");
            return;
        }
        let entries = raw
            .get("intents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut intents = self
            .intents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for entry in entries.into_iter().take(1_000) {
            let Ok(intent) = serde_json::from_value::<RenameIntent>(entry) else {
                continue;
            };
            if let Some(normalized) = sanitize_intent(intent) {
                intents.insert(normalized.operation_id.clone(), normalized);
            }
        }
    }

    fn persist(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
            restrict_path(parent, 0o700)?;
        }
        let value = StoredRenameIntents {
            schema_version: 1,
            intents: self.list(),
        };
        write_json_atomic(&self.path, &value, Some(0o600))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRenameResult {
    pub disposition: String,
    pub ai_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_session_id: Option<String>,
    pub title: String,
}

#[derive(Debug, Error)]
pub enum SessionTitleError {
    #[error("AI Session was not found.")]
    AiSessionNotFound,
    #[error("App session not found.")]
    AppSessionNotFound,
    #[error("App session is associated with multiple AI sessions.")]
    BindingConflict,
    #[error("The client request id is already bound to another rename.")]
    RequestConflict,
    #[error("The session title changed before the rename was applied.")]
    TitleConflict,
    #[error("This AI session does not support renaming.")]
    Unsupported,
    #[error("Session title synchronization is still pending.")]
    Pending,
    #[error(transparent)]
    Provider(#[from] ProviderError),
    #[error(transparent)]
    Store(#[from] AiSessionStoreError),
    #[error(transparent)]
    App(#[from] AppRuntimeError),
    #[error("AI Session rename intent persistence failed: {0}")]
    Persistence(#[from] std::io::Error),
}

impl SessionTitleError {
    pub fn code(&self) -> &str {
        match self {
            Self::AiSessionNotFound => "AI_SESSION_NOT_FOUND",
            Self::AppSessionNotFound => "APP_SESSION_NOT_FOUND",
            Self::BindingConflict => "AI_SESSION_RENAME_BINDING_CONFLICT",
            Self::RequestConflict => "AI_SESSION_RENAME_REQUEST_CONFLICT",
            Self::TitleConflict => "AI_SESSION_RENAME_CONFLICT",
            Self::Unsupported => "AI_SESSION_RENAME_UNSUPPORTED",
            Self::Pending => "AI_SESSION_RENAME_PENDING",
            Self::Provider(error) => error.code.as_str(),
            Self::Store(AiSessionStoreError::NotFound) => "AI_SESSION_NOT_FOUND",
            Self::Store(AiSessionStoreError::TitleConflict) => "AI_SESSION_RENAME_CONFLICT",
            Self::Store(_) => "AI_SESSION_PERSISTENCE_FAILED",
            Self::App(error) => error.code(),
            Self::Persistence(_) => "AI_SESSION_RENAME_PERSISTENCE_FAILED",
        }
    }

    pub fn status_code(&self) -> u16 {
        match self {
            Self::AiSessionNotFound | Self::AppSessionNotFound => 404,
            Self::BindingConflict
            | Self::RequestConflict
            | Self::TitleConflict
            | Self::Unsupported => 409,
            Self::Pending => 503,
            Self::Provider(error) => error.status_code,
            Self::Store(AiSessionStoreError::TitleConflict) => 409,
            Self::Store(AiSessionStoreError::NotFound) => 404,
            Self::Store(_) => 500,
            Self::App(AppRuntimeError::SessionNotFound(_)) => 404,
            Self::App(_) => 400,
            Self::Persistence(_) => 500,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Provider(error) => &error.message,
            Self::App(error) => match error {
                AppRuntimeError::Invalid(message)
                | AppRuntimeError::NotFound(message)
                | AppRuntimeError::SessionNotFound(message)
                | AppRuntimeError::SessionTitleInvalid(message)
                | AppRuntimeError::Conflict(message)
                | AppRuntimeError::MissingCommand(message)
                | AppRuntimeError::Spawn(message)
                | AppRuntimeError::Storage(message)
                | AppRuntimeError::NotImplemented(message)
                | AppRuntimeError::Draining(message)
                | AppRuntimeError::CatalogInvalid(message)
                | AppRuntimeError::ProfileBusy { message, .. }
                | AppRuntimeError::ProfileNotFound { message, .. }
                | AppRuntimeError::ProfileUnsupported(message)
                | AppRuntimeError::ProfileNameInvalid(message)
                | AppRuntimeError::ProfileNameConflict(message)
                | AppRuntimeError::ProfileDefaultProtected { message, .. }
                | AppRuntimeError::DisplayNotFound(message)
                | AppRuntimeError::DisplayInvalid(message)
                | AppRuntimeError::DisplaySessionNotFound(message)
                | AppRuntimeError::DisplayStartFailed(message)
                | AppRuntimeError::DisplayResizeFailed(message)
                | AppRuntimeError::ScreenshotUnavailable(message)
                | AppRuntimeError::ScreenshotFailed(message)
                | AppRuntimeError::AutomationUnavailable(message)
                | AppRuntimeError::ResourceExhausted(message)
                | AppRuntimeError::ResumeInvalid(message)
                | AppRuntimeError::ResumeUnsupported(message)
                | AppRuntimeError::ProcessStopTimeout(message)
                | AppRuntimeError::CodexAppServerStartFailed(message)
                | AppRuntimeError::OpenCodeServerStartFailed(message)
                | AppRuntimeError::LogsFailed(message) => message,
            },
            other => match other {
                Self::AiSessionNotFound => "AI Session was not found.",
                Self::AppSessionNotFound => "App session not found.",
                Self::BindingConflict => "App session is associated with multiple AI sessions.",
                Self::RequestConflict => {
                    "The client request id is already bound to another rename."
                }
                Self::TitleConflict => "The session title changed before the rename was applied.",
                Self::Unsupported => "This AI session does not support renaming.",
                Self::Pending => "Session title synchronization is still pending.",
                Self::Persistence(_) => "AI Session rename intent persistence failed.",
                _ => "AI Session rename failed.",
            },
        }
    }
}

pub struct SessionTitleCoordinator {
    sessions: Arc<AiSessionRuntime>,
    controller: Arc<AiSessionController>,
    app_runtime: Arc<AppRuntime>,
    store: RenameIntentStore,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    retry_attempts: Mutex<HashMap<String, u32>>,
    retry_tasks: Mutex<HashSet<String>>,
    changes: broadcast::Sender<()>,
    self_weak: std::sync::OnceLock<std::sync::Weak<Self>>,
}

impl SessionTitleCoordinator {
    pub fn new(
        data_dir: &std::path::Path,
        sessions: Arc<AiSessionRuntime>,
        controller: Arc<AiSessionController>,
        app_runtime: Arc<AppRuntime>,
    ) -> Arc<Self> {
        let (changes, _) = broadcast::channel(64);
        let coordinator = Arc::new(Self {
            sessions,
            controller,
            app_runtime,
            store: RenameIntentStore::new(data_dir),
            locks: Mutex::new(HashMap::new()),
            retry_attempts: Mutex::new(HashMap::new()),
            retry_tasks: Mutex::new(HashSet::new()),
            changes,
            self_weak: std::sync::OnceLock::new(),
        });
        let _ = coordinator.self_weak.set(Arc::downgrade(&coordinator));
        coordinator
    }

    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.changes.subscribe()
    }

    pub async fn rename_ai_session(
        &self,
        session_id: &str,
        title: &str,
        expected_title: Option<&str>,
        client_request_id: &str,
    ) -> Result<SessionRenameResult, SessionTitleError> {
        let title = normalize_title(title);
        let session = self
            .sessions
            .get(session_id)
            .ok_or(SessionTitleError::AiSessionNotFound)?;
        if let Some(existing) = self.store.find_by_client_request_id(client_request_id) {
            if existing.ai_session_id != session_id || existing.target_title != title {
                return Err(SessionTitleError::RequestConflict);
            }
            return self
                .resume_locked(&existing.operation_id, Some(&existing))
                .await;
        }
        let key = self.operation_key(&session);
        let _guard = self.lock_for(&key).await;
        self.rename_locked(session, title, expected_title, Some(client_request_id))
            .await
    }

    pub async fn rename_app_session(
        &self,
        app_session_id: &str,
        title: &str,
        expected_title: Option<&str>,
    ) -> Result<AppSession, SessionTitleError> {
        let title = normalize_title(title);
        let linked = self.sessions_for_app(app_session_id);
        if linked.len() > 1 {
            return Err(SessionTitleError::BindingConflict);
        }
        let Some(session) = linked.into_iter().next() else {
            return Ok(self.app_runtime.rename(app_session_id, &title)?);
        };
        if self.is_independent(&session) {
            return Ok(self.app_runtime.rename(app_session_id, &title)?);
        }
        let client_request_id = format!("legacy_app_rename_{}", Uuid::new_v4());
        self.rename_ai_session(&session.id, &title, expected_title, &client_request_id)
            .await?;
        self.app_runtime
            .get_session(app_session_id)
            .ok_or(SessionTitleError::AppSessionNotFound)
    }

    pub async fn observe_provider_title(&self, session_id: &str) -> Result<(), SessionTitleError> {
        let Some(session) = self.sessions.get(session_id) else {
            return Ok(());
        };
        let Some(app_session_id) = session.app_session_id.as_deref() else {
            return Ok(());
        };
        if session.title.is_none() || self.is_app_derived(&session) || self.is_independent(&session)
        {
            return Ok(());
        }
        let key = self.operation_key(&session);
        let _guard = self.lock_for(&key).await;
        let Some(current) = self.sessions.get(session_id) else {
            return Ok(());
        };
        let Some(title) = current.title.clone() else {
            return Ok(());
        };
        let Some(app_session) = self.app_runtime.get_session(app_session_id) else {
            return Ok(());
        };
        if app_session.title == title {
            return Ok(());
        }
        if let Some(active) = self
            .store
            .list()
            .into_iter()
            .find(|intent| intent.ai_session_id == current.id)
        {
            if active.target_title == title {
                self.resume_locked(&active.operation_id, Some(&active))
                    .await?;
                return Ok(());
            }
            self.complete(&active.operation_id);
        }
        let now = now_iso();
        let intent = RenameIntent {
            schema_version: 1,
            operation_id: format!("rename_{}", Uuid::new_v4()),
            client_request_id: None,
            ai_session_id: current.id.clone(),
            agent: current.agent.clone(),
            provider_session_id: current.provider_session_id.clone(),
            app_session_id: app_session.id.clone(),
            previous_title: Some(app_session.title.clone()),
            target_title: title,
            authority: "provider".to_string(),
            phase: "authority-confirmed".to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        let intent = self.store.put(intent)?;
        self.resume_locked(&intent.operation_id, Some(&intent))
            .await?;
        Ok(())
    }

    pub async fn observe_app_session_title(
        &self,
        app_session_id: &str,
    ) -> Result<(), SessionTitleError> {
        let linked = self.sessions_for_app(app_session_id);
        if linked.len() > 1 {
            return Err(SessionTitleError::BindingConflict);
        }
        let Some(session) = linked.into_iter().next() else {
            return Ok(());
        };
        if self.is_independent(&session) {
            return Ok(());
        }
        let Some(app_session) = self.app_runtime.get_session(app_session_id) else {
            return Ok(());
        };
        if session.title.as_deref() == Some(app_session.title.as_str()) {
            return Ok(());
        }
        if self.is_app_derived(&session) {
            let _ = self
                .sessions
                .rename_with_disposition(&session.id, &app_session.title, None)?;
            self.notify_changed();
            return Ok(());
        }
        let expected_title = session.title.clone().unwrap_or_default();
        self.rename_ai_session(
            &session.id,
            &app_session.title,
            Some(&expected_title),
            &format!("observed_app_rename_{app_session_id}_{}", app_session.title),
        )
        .await?;
        Ok(())
    }

    pub async fn recover(self: &Arc<Self>) {
        for intent in self.store.list() {
            if let Err(error) = self.resume_operation(&intent.operation_id).await {
                tracing::warn!(
                    code = error.code(),
                    operation_id = %intent.operation_id,
                    ai_session_id = %intent.ai_session_id,
                    app_session_id = %intent.app_session_id,
                    %error,
                    "failed to recover AI Session rename intent"
                );
                self.schedule_retry(&intent.operation_id);
            }
        }
        self.notify_changed();
    }

    async fn rename_locked(
        &self,
        session: AiSession,
        title: String,
        expected_title: Option<&str>,
        client_request_id: Option<&str>,
    ) -> Result<SessionRenameResult, SessionTitleError> {
        let Some(current) = self.sessions.get(&session.id) else {
            return Err(SessionTitleError::AiSessionNotFound);
        };
        if !supports_rename(&current) {
            return Err(SessionTitleError::Unsupported);
        }
        if self.is_independent(&current) {
            let current_title = current.title.clone().unwrap_or_default();
            if expected_title.is_some_and(|expected| expected != current_title) {
                return Err(SessionTitleError::TitleConflict);
            }
            if current_title == title {
                return Ok(result("already-named", &current, title));
            }
            self.controller.rename(&current.id, &title).await?;
            self.notify_changed();
            let updated = self
                .sessions
                .get(&current.id)
                .ok_or(SessionTitleError::AiSessionNotFound)?;
            return Ok(result("renamed", &updated, title));
        }
        let Some(app_session_id) = current.app_session_id.clone() else {
            let current_title = current.title.clone().unwrap_or_default();
            if expected_title.is_some_and(|expected| expected != current_title) {
                return Err(SessionTitleError::TitleConflict);
            }
            if current_title == title {
                return Ok(result("already-named", &current, title));
            }
            self.controller.rename(&current.id, &title).await?;
            self.notify_changed();
            let updated = self
                .sessions
                .get(&current.id)
                .ok_or(SessionTitleError::AiSessionNotFound)?;
            return Ok(result("renamed", &updated, title));
        };
        let Some(app_session) = self.app_runtime.get_session(&app_session_id) else {
            let current_title = current.title.clone().unwrap_or_default();
            if expected_title.is_some_and(|expected| expected != current_title) {
                return Err(SessionTitleError::TitleConflict);
            }
            if current_title == title {
                return Ok(result("already-named", &current, title));
            }
            self.controller.rename(&current.id, &title).await?;
            self.notify_changed();
            let updated = self
                .sessions
                .get(&current.id)
                .ok_or(SessionTitleError::AiSessionNotFound)?;
            return Ok(result("renamed", &updated, title));
        };
        let authority = if self.is_app_derived(&current) {
            "app-session"
        } else {
            "provider"
        };
        let current_title = if authority == "app-session" {
            app_session.title.clone()
        } else {
            current.title.clone().unwrap_or_default()
        };
        if expected_title.is_some_and(|expected| expected != current_title) {
            return Err(SessionTitleError::TitleConflict);
        }
        if current_title == title
            && app_session.title == title
            && current.title.as_deref() == Some(&title)
        {
            return Ok(result("already-named", &current, title));
        }
        let now = now_iso();
        let intent = RenameIntent {
            schema_version: 1,
            operation_id: format!("rename_{}", Uuid::new_v4()),
            client_request_id: client_request_id.map(str::to_string),
            ai_session_id: current.id.clone(),
            agent: current.agent.clone(),
            provider_session_id: current.provider_session_id.clone(),
            app_session_id,
            previous_title: Some(current_title),
            target_title: title,
            authority: authority.to_string(),
            phase: "prepared".to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        let intent = self.store.put(intent)?;
        self.resume_locked(&intent.operation_id, Some(&intent))
            .await
    }

    async fn resume_operation(
        &self,
        operation_id: &str,
    ) -> Result<SessionRenameResult, SessionTitleError> {
        let key = format!("intent:{operation_id}");
        let _guard = self.lock_for(&key).await;
        self.resume_locked(operation_id, None).await
    }

    async fn resume_locked(
        &self,
        operation_id: &str,
        fallback: Option<&RenameIntent>,
    ) -> Result<SessionRenameResult, SessionTitleError> {
        let Some(current) = self.store.get(operation_id).or_else(|| fallback.cloned()) else {
            return Err(SessionTitleError::Pending);
        };
        let mut progress = current.clone();
        let result = async {
            let session = self
                .sessions
                .get(&current.ai_session_id)
                .ok_or(SessionTitleError::AiSessionNotFound)?;
            let app_session = self
                .app_runtime
                .get_session(&current.app_session_id)
                .ok_or(SessionTitleError::AppSessionNotFound)?;
            let authority_title = if current.authority == "provider" {
                session.title.clone()
            } else {
                Some(app_session.title.clone())
            }
            .filter(|title| !title.is_empty());
            if authority_title.as_deref().is_some_and(|title| {
                title != current.target_title && Some(title) != current.previous_title.as_deref()
            }) {
                if current.authority == "provider"
                    && app_session.title != authority_title.clone().unwrap_or_default()
                {
                    self.app_runtime.rename(
                        &app_session.id,
                        authority_title.as_deref().unwrap_or_default(),
                    )?;
                }
                if current.authority == "app-session" {
                    if let Some(title) = authority_title.as_deref() {
                        self.sessions
                            .rename_with_disposition(&session.id, title, None)?;
                    }
                }
                self.complete(operation_id);
                self.notify_changed();
                let confirmed = self
                    .sessions
                    .get(&session.id)
                    .ok_or(SessionTitleError::AiSessionNotFound)?;
                return Ok(result(
                    "renamed",
                    &confirmed,
                    authority_title.unwrap_or_default(),
                ));
            }
            if current.authority == "provider" {
                if session.title.as_deref() != Some(current.target_title.as_str()) {
                    self.controller
                        .rename(&session.id, &current.target_title)
                        .await?;
                }
                self.update_phase(&current, "authority-confirmed")?;
                progress.phase = "authority-confirmed".to_string();
                if app_session.title != current.target_title {
                    self.app_runtime
                        .rename(&app_session.id, &current.target_title)?;
                }
            } else {
                if app_session.title != current.target_title {
                    self.app_runtime
                        .rename(&app_session.id, &current.target_title)?;
                }
                self.update_phase(&current, "authority-confirmed")?;
                progress.phase = "authority-confirmed".to_string();
                if session.title.as_deref() != Some(current.target_title.as_str()) {
                    self.sessions.rename_with_disposition(
                        &session.id,
                        &current.target_title,
                        None,
                    )?;
                }
            }
            let confirmed = self
                .sessions
                .get(&session.id)
                .ok_or(SessionTitleError::AiSessionNotFound)?;
            let confirmed_app = self
                .app_runtime
                .get_session(&current.app_session_id)
                .ok_or(SessionTitleError::AppSessionNotFound)?;
            if confirmed.title.as_deref() != Some(current.target_title.as_str())
                || confirmed_app.title != current.target_title
            {
                return Err(SessionTitleError::Pending);
            }
            self.update_phase(&current, "replica-confirmed")?;
            self.complete(operation_id);
            self.notify_changed();
            Ok(result("renamed", &confirmed, current.target_title.clone()))
        }
        .await;
        if let Err(error) = &result {
            if progress.phase == "prepared" && !uncertain(error) {
                self.store.remove(operation_id);
            } else if self.store.get(operation_id).is_some() {
                self.schedule_retry(operation_id);
            }
        }
        result
    }

    fn update_phase(&self, intent: &RenameIntent, phase: &str) -> Result<(), SessionTitleError> {
        self.store.put(RenameIntent {
            phase: phase.to_string(),
            updated_at: now_iso(),
            ..intent.clone()
        })?;
        Ok(())
    }

    fn complete(&self, operation_id: &str) {
        self.store.remove(operation_id);
        self.retry_attempts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(operation_id);
        self.retry_tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(operation_id);
    }

    fn schedule_retry(&self, operation_id: &str) {
        if self.store.get(operation_id).is_none() {
            return;
        }
        let Some(coordinator) = self.self_weak.get().and_then(std::sync::Weak::upgrade) else {
            return;
        };
        {
            let mut tasks = self
                .retry_tasks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !tasks.insert(operation_id.to_string()) {
                return;
            }
        }
        let attempt = {
            let mut attempts = self
                .retry_attempts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let attempt = attempts.get(operation_id).copied().unwrap_or(0);
            attempts.insert(operation_id.to_string(), attempt.saturating_add(1));
            attempt
        };
        let delay = RENAME_RETRY_BASE
            .saturating_mul(1u32 << attempt.min(8))
            .min(RENAME_RETRY_MAX);
        let operation_id = operation_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            coordinator
                .retry_tasks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&operation_id);
            if coordinator.store.get(&operation_id).is_none() {
                return;
            }
            if let Err(error) = coordinator.resume_operation(&operation_id).await {
                tracing::warn!(
                    code = error.code(),
                    %operation_id,
                    %error,
                    "AI Session rename retry failed"
                );
                coordinator.schedule_retry(&operation_id);
            }
        });
    }

    fn notify_changed(&self) {
        let _ = self.changes.send(());
    }

    fn sessions_for_app(&self, app_session_id: &str) -> Vec<AiSession> {
        self.sessions
            .list()
            .into_iter()
            .filter(|session| session.app_session_id.as_deref() == Some(app_session_id))
            .collect()
    }

    fn operation_key(&self, session: &AiSession) -> String {
        session
            .app_session_id
            .clone()
            .unwrap_or_else(|| session.id.clone())
    }

    async fn lock_for(&self, key: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self
                .locks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            locks
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }

    fn is_app_derived(&self, session: &AiSession) -> bool {
        session.agent == "claude" && session.app_session_id.is_some()
    }

    fn is_independent(&self, session: &AiSession) -> bool {
        session.agent == "codex"
    }
}

fn result(disposition: &str, session: &AiSession, title: String) -> SessionRenameResult {
    SessionRenameResult {
        disposition: disposition.to_string(),
        ai_session_id: session.id.clone(),
        app_session_id: session.app_session_id.clone(),
        title,
    }
}

fn supports_rename(session: &AiSession) -> bool {
    session
        .actions
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|actions| actions.get("rename"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn uncertain(error: &SessionTitleError) -> bool {
    matches!(
        error,
        SessionTitleError::Pending | SessionTitleError::Persistence(_)
    ) || error.status_code() >= 500
}

fn normalize_title(title: &str) -> String {
    title.trim().to_string()
}

fn sanitize_intent(mut intent: RenameIntent) -> Option<RenameIntent> {
    if intent.schema_version != 1
        || intent.operation_id.trim().is_empty()
        || intent.ai_session_id.trim().is_empty()
        || intent.app_session_id.trim().is_empty()
    {
        return None;
    }
    intent.operation_id = intent.operation_id.trim().to_string();
    intent.ai_session_id = intent.ai_session_id.trim().to_string();
    intent.app_session_id = intent.app_session_id.trim().to_string();
    intent.agent = intent.agent.trim().to_string();
    intent.target_title = normalize_title(&intent.target_title);
    intent.authority = intent.authority.trim().to_string();
    intent.phase = intent.phase.trim().to_string();
    if intent.agent.is_empty()
        || !matches!(intent.authority.as_str(), "provider" | "app-session")
        || !matches!(
            intent.phase.as_str(),
            "prepared" | "authority-confirmed" | "replica-confirmed" | "conflicted"
        )
    {
        return None;
    }
    Some(intent)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_ai_session::{
        AiSessionControlProvider, AiSessionConversationAttachmentStore,
    };
    use controlled_instance_app_runtime::AppSession;
    use controlled_instance_core::paths::StoragePaths;
    use controlled_instance_protocol::{
        AiSessionProviderActions, AiSessionProviderCapability,
        AiSessionProviderTimelineCapabilities,
    };
    use serde_json::json;

    #[derive(Default)]
    struct RenameProvider {
        renames: Mutex<Vec<(String, String)>>,
    }

    #[async_trait::async_trait]
    impl AiSessionControlProvider for RenameProvider {
        fn agent(&self) -> &str {
            "opencode"
        }

        fn capability(&self) -> AiSessionProviderCapability {
            AiSessionProviderCapability {
                agent: "opencode".to_string(),
                actions: AiSessionProviderActions::default(),
                permission_modes: Vec::new(),
                timeline: AiSessionProviderTimelineCapabilities::default(),
                model_selection: None,
                reasoning_effort: None,
                hierarchy: None,
            }
        }

        async fn rename_session(
            &self,
            session: &AiSession,
            title: &str,
        ) -> Result<(), ProviderError> {
            self.renames
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((session.id.clone(), title.to_string()));
            Ok(())
        }
    }

    fn storage_paths(root: &std::path::Path) -> StoragePaths {
        let data = root.join("data");
        StoragePaths {
            config_path: data.join("config.json"),
            data_dir: data.clone(),
            app_catalog_dir: data.join("app-catalog"),
            app_sessions_dir: data.join("app-sessions"),
            triggers_dir: data.join("triggers"),
            runtime_dir: data.join("runtime"),
            events_dir: data.join("events"),
            artifact_dir: data.join("artifacts"),
            log_dir: data.join("logs"),
            web_token_path: data.join("web-token"),
        }
    }

    fn session(agent: &str, title: &str) -> AiSession {
        serde_json::from_value(json!({
            "id": "ses_0000000000400",
            "agent": agent,
            "creationSource": "app-session",
            "appSessionId": "aps_0000000000400",
            "appId": agent,
            "providerSessionId": "provider-thread",
            "title": title,
            "actions": { "rename": true },
            "status": "idle",
            "startedAt": now_iso(),
            "updatedAt": now_iso()
        }))
        .expect("AI session")
    }

    fn app_session(title: &str) -> AppSession {
        serde_json::from_value(json!({
            "id": "aps_0000000000400",
            "appId": "codex",
            "title": title,
            "kind": "tty",
            "status": "running",
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "workspace": { "cwd": "/tmp/workspace" },
            "paths": { "sessionDir": "/tmp/session", "logDir": "/tmp/log" }
        }))
        .expect("App session")
    }

    struct Fixture {
        _root: tempfile::TempDir,
        sessions: Arc<AiSessionRuntime>,
        app_runtime: Arc<AppRuntime>,
        provider: Arc<RenameProvider>,
        coordinator: Arc<SessionTitleCoordinator>,
    }

    fn fixture(session: AiSession, app_session: AppSession) -> Fixture {
        let root = tempfile::tempdir().expect("tempdir");
        let paths = storage_paths(root.path());
        let app_runtime = Arc::new(AppRuntime::new(
            paths.clone(),
            root.path().join("workspace"),
        ));
        app_runtime.insert_session(app_session);
        let sessions = Arc::new(AiSessionRuntime::new("inst_test", None));
        sessions.save(session).expect("save session");
        let attachments = Arc::new(AiSessionConversationAttachmentStore::new(&paths.data_dir));
        let streams = Arc::new(attachments.draft_streams());
        let controller = AiSessionController::new(
            sessions.clone(),
            attachments,
            streams,
            Some(paths.runtime_dir.join("creates.json")),
        );
        let provider = Arc::new(RenameProvider::default());
        controller.register_provider(provider.clone());
        let coordinator = SessionTitleCoordinator::new(
            &paths.data_dir,
            sessions.clone(),
            controller.clone(),
            app_runtime.clone(),
        );
        Fixture {
            _root: root,
            sessions,
            app_runtime,
            provider,
            coordinator,
        }
    }

    #[test]
    fn rename_intent_store_sanitizes_and_persists() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = RenameIntentStore::new(root.path());
        let now = now_iso();
        store
            .put(RenameIntent {
                schema_version: 1,
                operation_id: " rename_1 ".to_string(),
                client_request_id: Some("client-1".to_string()),
                ai_session_id: " ses_1 ".to_string(),
                agent: "codex".to_string(),
                provider_session_id: None,
                app_session_id: " aps_1 ".to_string(),
                previous_title: Some("Old".to_string()),
                target_title: " New ".to_string(),
                authority: "provider".to_string(),
                phase: "prepared".to_string(),
                created_at: now.clone(),
                updated_at: now,
            })
            .expect("put");
        assert_eq!(store.list().len(), 1);
        let reloaded = RenameIntentStore::new(root.path());
        let intent = reloaded.get("rename_1").expect("reloaded");
        assert_eq!(intent.ai_session_id, "ses_1");
        assert_eq!(intent.app_session_id, "aps_1");
        assert_eq!(intent.target_title, "New");
    }

    #[tokio::test]
    async fn provider_authority_rename_converges_provider_registry_and_app() {
        let fixture = fixture(session("opencode", "Old"), app_session("Old"));
        let result = fixture
            .coordinator
            .rename_ai_session("ses_0000000000400", "New", Some("Old"), "client-rename")
            .await
            .expect("rename");
        assert_eq!(result.disposition, "renamed");
        assert_eq!(result.title, "New");
        assert_eq!(
            fixture
                .sessions
                .get("ses_0000000000400")
                .expect("session")
                .title
                .as_deref(),
            Some("New")
        );
        assert_eq!(
            fixture
                .app_runtime
                .get_session("aps_0000000000400")
                .expect("app")
                .title,
            "New"
        );
        assert_eq!(
            fixture
                .provider
                .renames
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_slice(),
            &[("ses_0000000000400".to_string(), "New".to_string())]
        );

        let retried = fixture
            .coordinator
            .rename_ai_session("ses_0000000000400", "New", None, "client-rename")
            .await
            .expect("idempotent retry");
        assert_eq!(retried.disposition, "already-named");
        assert_eq!(
            fixture
                .provider
                .renames
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .len(),
            1
        );

        fixture
            .sessions
            .rename_with_disposition("ses_0000000000400", "Provider Observed", None)
            .expect("provider title");
        fixture
            .coordinator
            .observe_provider_title("ses_0000000000400")
            .await
            .expect("observe provider");
        assert_eq!(
            fixture
                .app_runtime
                .get_session("aps_0000000000400")
                .expect("app")
                .title,
            "Provider Observed"
        );
    }

    #[tokio::test]
    async fn app_authority_rename_and_observations_converge_both_replicas() {
        let fixture = fixture(session("claude", "Session Old"), app_session("App Old"));
        fixture
            .coordinator
            .rename_ai_session(
                "ses_0000000000400",
                "App Renamed",
                Some("App Old"),
                "client-app",
            )
            .await
            .expect("app-authority rename");
        assert_eq!(
            fixture
                .app_runtime
                .get_session("aps_0000000000400")
                .expect("app")
                .title,
            "App Renamed"
        );
        assert_eq!(
            fixture
                .sessions
                .get("ses_0000000000400")
                .expect("session")
                .title
                .as_deref(),
            Some("App Renamed")
        );
        assert!(fixture
            .provider
            .renames
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty());

        fixture
            .app_runtime
            .rename("aps_0000000000400", "App Observed")
            .expect("observed app title");
        fixture
            .coordinator
            .observe_app_session_title("aps_0000000000400")
            .await
            .expect("observe app");
        assert_eq!(
            fixture
                .sessions
                .get("ses_0000000000400")
                .expect("session")
                .title
                .as_deref(),
            Some("App Observed")
        );
    }
}
