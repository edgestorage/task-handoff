use controlled_instance_ai_session::{
    AiSession, AiSessionForkResult, AiSessionModelSelection, AiSessionModelSelectionIntent,
    AiSessionResumeResult, ProviderError, ProviderForkInput,
};
use controlled_instance_protocol::{
    AiSessionHistoryItem, RepositoryRemoveWorktreeRequest, RepositorySessionKind,
};
use controlled_instance_workspace::{
    RepositoryOperationError, RepositorySessionInventory, RepositorySessionTarget,
    RepositoryWorktreeRef,
};
use futures_util::{future::Shared, FutureExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};
use tokio::sync::Mutex;

use crate::AppState;

type SharedOperation<T> =
    Arc<Shared<Pin<Box<dyn Future<Output = Result<T, ProviderError>> + Send>>>>;
type SharedClose = SharedOperation<Option<AiSession>>;

#[derive(Clone)]
struct PendingAiSessionClose {
    target_id: String,
    session_ids: HashSet<String>,
    operation: SharedClose,
}

#[derive(Default)]
pub struct AiSessionCloseCoordinator {
    pending: Mutex<HashMap<String, PendingAiSessionClose>>,
}

impl AiSessionCloseCoordinator {
    pub async fn close(
        self: &Arc<Self>,
        state: AppState,
        target_id: &str,
    ) -> Result<Option<AiSession>, ProviderError> {
        loop {
            let Some((session_ids, keys)) = state.ai_session_close_scope(target_id) else {
                return Ok(None);
            };
            let active = {
                let pending = self.pending.lock().await;
                let mut active = Vec::<PendingAiSessionClose>::new();
                for key in &keys {
                    let Some(operation) = pending.get(key) else {
                        continue;
                    };
                    if !active
                        .iter()
                        .any(|candidate| Arc::ptr_eq(&candidate.operation, &operation.operation))
                    {
                        active.push(operation.clone());
                    }
                }
                active
            };
            if active.is_empty() {
                let operation_target = target_id.to_string();
                let operation: SharedClose = Arc::new(
                    async move {
                        state
                            .close_ai_session_subtree_inner(&operation_target, false)
                            .await
                    }
                    .boxed()
                    .shared(),
                );
                {
                    let mut pending = self.pending.lock().await;
                    for key in &keys {
                        pending.insert(
                            key.clone(),
                            PendingAiSessionClose {
                                target_id: target_id.to_string(),
                                session_ids: session_ids.clone(),
                                operation: operation.clone(),
                            },
                        );
                    }
                }
                let coordinator = self.clone();
                let cleanup_operation = operation.clone();
                let cleanup_keys = keys.clone();
                tokio::spawn(async move {
                    let _ = cleanup_operation.as_ref().clone().await;
                    let mut pending = coordinator.pending.lock().await;
                    for key in cleanup_keys {
                        if pending.get(&key).is_some_and(|active| {
                            Arc::ptr_eq(&active.operation, &cleanup_operation)
                        }) {
                            pending.remove(&key);
                        }
                    }
                });
                return operation.as_ref().clone().await;
            }
            if active.len() == 1 {
                let operation = &active[0];
                if operation.target_id == target_id {
                    return operation.operation.as_ref().clone().await;
                }
                if session_ids
                    .iter()
                    .all(|session_id| operation.session_ids.contains(session_id))
                {
                    operation.operation.as_ref().clone().await?;
                    return Ok(None);
                }
            }
            for operation in active {
                let _ = operation.operation.as_ref().clone().await;
            }
        }
    }
}

pub struct AiSessionResumeCoordinator {
    pending: Mutex<HashMap<String, SharedOperation<AiSessionResumeResult>>>,
}

impl Default for AiSessionResumeCoordinator {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }
}

impl AiSessionResumeCoordinator {
    pub async fn resume(
        self: &Arc<Self>,
        state: AppState,
        item: AiSessionHistoryItem,
        model_selection: Option<AiSessionModelSelection>,
        model_selection_intent: AiSessionModelSelectionIntent,
        reasoning_effort: Option<String>,
    ) -> Result<AiSessionResumeResult, ProviderError> {
        let keys = vec![
            format!("ai:{}", item.id),
            format!("provider:{}:{}", item.agent, item.provider_session_id),
        ];
        let active = {
            let pending = self.pending.lock().await;
            keys.iter().find_map(|key| pending.get(key).cloned())
        };
        if let Some(operation) = active {
            return operation.as_ref().clone().await;
        }

        let coordinator = self.clone();
        let cleanup_keys = keys.clone();
        let operation: SharedOperation<AiSessionResumeResult> = Arc::new(
            async move {
                perform_resume(
                    &state,
                    item,
                    model_selection,
                    model_selection_intent,
                    reasoning_effort,
                )
                .await
            }
            .boxed()
            .shared(),
        );
        let active = {
            let mut pending = self.pending.lock().await;
            let active = keys.iter().find_map(|key| pending.get(key).cloned());
            if active.is_none() {
                for key in &keys {
                    pending.insert(key.clone(), operation.clone());
                }
            }
            active
        };
        if let Some(active) = active {
            return active.as_ref().clone().await;
        }
        let cleanup_operation = operation.clone();
        tokio::spawn(async move {
            let _ = cleanup_operation.as_ref().clone().await;
            let mut pending = coordinator.pending.lock().await;
            for key in cleanup_keys {
                if pending
                    .get(&key)
                    .is_some_and(|active| Arc::ptr_eq(active, &cleanup_operation))
                {
                    pending.remove(&key);
                }
            }
        });
        operation.as_ref().clone().await
    }
}

async fn perform_resume(
    state: &AppState,
    item: AiSessionHistoryItem,
    model_selection: Option<AiSessionModelSelection>,
    model_selection_intent: AiSessionModelSelectionIntent,
    reasoning_effort: Option<String>,
) -> Result<AiSessionResumeResult, ProviderError> {
    let running_app_ids = state
        .app_runtime
        .list_sessions()
        .into_iter()
        .filter(|session| session.status == "running")
        .map(|session| session.id)
        .collect::<HashSet<_>>();
    let provider_session = state.ai_sessions.list().into_iter().find(|session| {
        session.id == item.id
            || (session.agent == item.agent
                && session.provider_session_id.as_deref()
                    == Some(item.provider_session_id.as_str()))
    });
    if let Some(session) = provider_session.as_ref() {
        if let Some(app_session_id) = session
            .app_session_id
            .as_ref()
            .filter(|app_session_id| running_app_ids.contains(*app_session_id))
        {
            return Ok(AiSessionResumeResult {
                disposition: "already-open".to_string(),
                ai_session_id: session.id.clone(),
                provider_session_id: item.provider_session_id,
                app_session_id: Some(app_session_id.clone()),
                creation_source: item.creation_source,
            });
        }
    }

    let previous = state.ai_sessions.get(&item.id);
    let previous_provider = provider_session
        .as_ref()
        .filter(|session| session.id != item.id)
        .cloned();
    if let Some(provider_session) = previous_provider.as_ref() {
        let _ = state.ai_sessions.remove(&provider_session.id);
    }

    let item_id = item.id.clone();
    let item_agent = item.agent.clone();
    let item_provider_session_id = item.provider_session_id.clone();
    let item_creation_source = item.creation_source.clone();
    let item_cwd = item.cwd.clone();
    let result = async {
        if item_creation_source == "ai-session" {
            let result = state
                .ai_session_controller
                .resume_archived(
                    item.clone(),
                    previous.as_ref(),
                    model_selection,
                    model_selection_intent,
                    reasoning_effort,
                )
                .await
                .map_err(|error| {
                    ProviderError::new(
                        "AI_SESSION_RESUME_UNAVAILABLE",
                        error.message,
                        409,
                    )
                })?;
            if state.ai_sessions.get(&item_id).is_none() {
                return Err(ProviderError::new(
                    "AI_SESSION_RESUME_UNAVAILABLE",
                    "Provider resume did not keep the AI session active.",
                    409,
                ));
            }
            state
                .ai_session_history
                .activate(&item_id)
                .map_err(|error| {
                    tracing::warn!(%error, ai_session_id = %item_id, "failed to activate AI Session history")
                })
                .ok();
            Ok(result)
        } else {
            let restored = AiSession::from_history_item(
                &item,
                previous.as_ref(),
                item.model_selection.clone(),
                item.reasoning_effort.clone(),
            );
            state.ai_sessions.save(restored).map_err(|error| {
                ProviderError::new(
                    "AI_SESSION_RESUME_UNAVAILABLE",
                    error.to_string(),
                    409,
                )
            })?;
            let app = state
                .app_runtime
                .start_resume(&item_agent, &item_cwd, &item_id, &item_provider_session_id)
                .await
                .map_err(|error| {
                    ProviderError::new(
                        "AI_SESSION_RESUME_UNAVAILABLE",
                        error.to_string(),
                        409,
                    )
                })?;
            if app.status != "running" {
                return Err(ProviderError::new(
                    "AI_SESSION_RESUME_UNAVAILABLE",
                    "Provider resume did not create a running app session.",
                    409,
                ));
            }
            Ok(AiSessionResumeResult {
                disposition: "resumed".to_string(),
                ai_session_id: item_id,
                provider_session_id: item_provider_session_id,
                app_session_id: Some(app.id),
                creation_source: item_creation_source,
            })
        }
    }
    .await;

    if result.is_err() {
        if let Some(previous) = previous {
            let _ = state.ai_sessions.save(previous);
        } else {
            let _ = state.ai_sessions.remove(&item.id);
        }
        if let Some(previous_provider) = previous_provider {
            let _ = state.ai_sessions.save(previous_provider);
        }
    }
    result
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ForkStage {
    Validated,
    WorkspacePrepared,
    ProviderCreated,
    Materialized,
    Completed,
}

#[derive(Debug, Clone)]
struct ForkOperation {
    client_request_id: String,
    fingerprint: String,
    source_session_id: String,
    through_turn_id: Option<String>,
    workspace_mode: String,
    stage: ForkStage,
    cwd: Option<PathBuf>,
    worktree_id: Option<String>,
    provider_session_id: Option<String>,
    ai_session_id: Option<String>,
    result: Option<AiSessionForkResult>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkOperationStore {
    #[serde(default = "default_fork_operation_version")]
    version: u8,
    #[serde(default)]
    operations: Vec<StoredForkOperation>,
}

fn default_fork_operation_version() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredForkOperation {
    client_request_id: String,
    fingerprint: String,
    source_session_id: String,
    input: StoredForkInput,
    stage: ForkStage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktree_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ai_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<StoredForkResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredForkInput {
    client_request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    through_turn_id: Option<String>,
    #[serde(default)]
    workspace: StoredForkWorkspace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredForkWorkspace {
    mode: String,
}

impl Default for StoredForkWorkspace {
    fn default() -> Self {
        Self {
            mode: "current".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredForkResult {
    disposition: String,
    ai_session_id: String,
    provider_session_id: String,
    creation_source: String,
}

impl From<&ForkOperation> for StoredForkOperation {
    fn from(operation: &ForkOperation) -> Self {
        Self {
            client_request_id: operation.client_request_id.clone(),
            fingerprint: operation.fingerprint.clone(),
            source_session_id: operation.source_session_id.clone(),
            input: StoredForkInput {
                client_request_id: operation.client_request_id.clone(),
                through_turn_id: operation.through_turn_id.clone(),
                workspace: StoredForkWorkspace {
                    mode: operation.workspace_mode.clone(),
                },
            },
            stage: operation.stage,
            cwd: operation.cwd.clone(),
            worktree_id: operation.worktree_id.clone(),
            provider_session_id: operation.provider_session_id.clone(),
            ai_session_id: operation.ai_session_id.clone(),
            result: operation.result.as_ref().map(|result| StoredForkResult {
                disposition: result.disposition.clone(),
                ai_session_id: result.ai_session_id.clone(),
                provider_session_id: result.provider_session_id.clone(),
                creation_source: result.creation_source.clone(),
            }),
        }
    }
}

pub struct AiSessionForkCoordinator {
    operations: Mutex<HashMap<String, ForkOperation>>,
    pending: Mutex<HashMap<String, SharedOperation<AiSessionForkResult>>>,
    store_path: PathBuf,
}

impl AiSessionForkCoordinator {
    pub fn new(store_path: PathBuf) -> Self {
        let operations = restore_fork_operations(&store_path);
        Self {
            operations: Mutex::new(operations),
            pending: Mutex::new(HashMap::new()),
            store_path,
        }
    }

    pub async fn fork(
        self: &Arc<Self>,
        state: AppState,
        source_session_id: String,
        client_request_id: String,
        through_turn_id: Option<String>,
        workspace_mode: String,
    ) -> Result<AiSessionForkResult, ProviderError> {
        if !matches!(workspace_mode.as_str(), "current" | "managed-worktree") {
            return Err(ProviderError::new(
                "AI_SESSION_CONTROL_INVALID",
                "workspace.mode is invalid.",
                400,
            ));
        }
        let fingerprint = fork_fingerprint(
            &source_session_id,
            &client_request_id,
            through_turn_id.as_deref(),
            &workspace_mode,
        );
        let restored = self
            .operations
            .lock()
            .await
            .get(&client_request_id)
            .cloned();
        if let Some(restored) = restored {
            if restored.fingerprint != fingerprint {
                return Err(ProviderError::conflict(
                    "AI_SESSION_FORK_IDEMPOTENCY_CONFLICT",
                    "The client request ID was already used with different Fork input.",
                ));
            }
            if let Some(result) = restored.result {
                return Ok(AiSessionForkResult {
                    disposition: "already-created".to_string(),
                    ..result
                });
            }
        }
        let active = self.pending.lock().await.get(&client_request_id).cloned();
        if let Some(operation) = active {
            return operation.as_ref().clone().await;
        }

        let operation = {
            let mut operations = self.operations.lock().await;
            operations
                .entry(client_request_id.clone())
                .or_insert_with(|| ForkOperation {
                    client_request_id: client_request_id.clone(),
                    fingerprint,
                    source_session_id,
                    through_turn_id,
                    workspace_mode,
                    stage: ForkStage::Validated,
                    cwd: None,
                    worktree_id: None,
                    provider_session_id: None,
                    ai_session_id: None,
                    result: None,
                })
                .clone()
        };
        self.persist().await;

        let coordinator = self.clone();
        let cleanup_id = client_request_id.clone();
        let operation_future: SharedOperation<AiSessionForkResult> = Arc::new(
            async move { coordinator.perform_operation(state, operation).await }
                .boxed()
                .shared(),
        );
        let active = {
            let mut pending = self.pending.lock().await;
            let active = pending.get(&client_request_id).cloned();
            if active.is_none() {
                pending.insert(client_request_id, operation_future.clone());
            }
            active
        };
        if let Some(active) = active {
            return active.as_ref().clone().await;
        }
        let cleanup_coordinator = self.clone();
        let cleanup_operation = operation_future.clone();
        tokio::spawn(async move {
            let _ = cleanup_operation.as_ref().clone().await;
            let mut pending = cleanup_coordinator.pending.lock().await;
            if pending
                .get(&cleanup_id)
                .is_some_and(|active| Arc::ptr_eq(active, &cleanup_operation))
            {
                pending.remove(&cleanup_id);
            }
        });
        operation_future.as_ref().clone().await
    }

    async fn perform_operation(
        &self,
        state: AppState,
        mut operation: ForkOperation,
    ) -> Result<AiSessionForkResult, ProviderError> {
        let source = state
            .ai_sessions
            .get(&operation.source_session_id)
            .ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_NOT_FOUND",
                    "Fork source AI session was not found.",
                    404,
                )
            })?;
        let source_provider_session_id = source.provider_session_id.clone().ok_or_else(|| {
            ProviderError::conflict(
                "AI_SESSION_FORK_UNSUPPORTED",
                "Fork source does not expose a verified provider capability.",
            )
        })?;
        if source
            .actions
            .as_ref()
            .and_then(|actions| actions.get("fork"))
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err(ProviderError::conflict(
                "AI_SESSION_FORK_UNSUPPORTED",
                "Fork source does not expose a verified provider capability.",
            ));
        }
        let source_cwd = source.cwd.clone().ok_or_else(|| {
            ProviderError::conflict(
                "AI_SESSION_FORK_SOURCE_INVALID",
                "Fork source has no working directory.",
            )
        })?;
        if operation.workspace_mode == "managed-worktree" && operation.through_turn_id.is_some() {
            return Err(ProviderError::conflict(
                "AI_SESSION_FORK_WORKTREE_UNAVAILABLE",
                "A historical-turn Fork cannot prepare a managed worktree.",
            ));
        }

        let result = async {
            if operation.cwd.is_none() {
                if operation.workspace_mode == "managed-worktree" {
                    let (cwd, worktree_id) =
                        prepare_managed_worktree(&state, &source, &operation.client_request_id)
                            .await?;
                    operation.cwd = Some(cwd);
                    operation.worktree_id = Some(worktree_id);
                } else {
                    operation.cwd = Some(PathBuf::from(&source_cwd));
                }
                operation.stage = ForkStage::WorkspacePrepared;
                self.update_operation(&operation).await;
            }

            if operation.workspace_mode == "managed-worktree" {
                let worktree_id = operation.worktree_id.as_deref().ok_or_else(|| {
                    ProviderError::conflict(
                        "AI_SESSION_FORK_WORKTREE_UNAVAILABLE",
                        "Managed Fork worktree validation is unavailable.",
                    )
                })?;
                let cwd = operation.cwd.as_deref().ok_or_else(|| {
                    ProviderError::conflict(
                        "AI_SESSION_FORK_WORKTREE_UNAVAILABLE",
                        "Managed Fork worktree validation is unavailable.",
                    )
                })?;
                if !validate_managed_worktree(&state, &source, worktree_id, cwd).await? {
                    return Err(ProviderError::conflict(
                        "AI_SESSION_FORK_WORKTREE_UNAVAILABLE",
                        "Managed Fork worktree changed before the provider session was created.",
                    ));
                }
            }

            if operation.provider_session_id.is_none() {
                let creation = state
                    .ai_session_controller
                    .fork_provider_session(
                        &operation.source_session_id,
                        ProviderForkInput {
                            through_turn_id: operation.through_turn_id.clone(),
                            cwd: (operation.workspace_mode == "managed-worktree")
                                .then(|| operation.cwd.clone())
                                .flatten(),
                            story_agent_tools: None,
                        },
                    )
                    .await?;
                operation.provider_session_id = Some(creation.created.provider_session_id.clone());
                operation.stage = ForkStage::ProviderCreated;
                self.update_operation(&operation).await;
                state
                    .ai_session_controller
                    .read_session(&source.agent, &creation.created.provider_session_id)
                    .await?;
                let result = state
                    .ai_session_controller
                    .materialize_fork_session(&creation)?;
                operation.ai_session_id = Some(result.ai_session_id.clone());
                operation.stage = ForkStage::Materialized;
                self.update_operation(&operation).await;
                operation.result = Some(AiSessionForkResult {
                    disposition: "created".to_string(),
                    ..result
                });
            } else {
                let cwd = operation.cwd.clone().ok_or_else(|| {
                    ProviderError::conflict(
                        "AI_SESSION_FORK_WORKTREE_UNAVAILABLE",
                        "Managed Fork worktree validation is unavailable.",
                    )
                })?;
                state
                    .ai_session_controller
                    .read_session(
                        &source.agent,
                        operation.provider_session_id.as_deref().unwrap_or_default(),
                    )
                    .await?;
                let result = state
                    .ai_session_controller
                    .materialize_forked_provider_session(
                        &operation.source_session_id,
                        operation.provider_session_id.as_deref().unwrap_or_default(),
                        operation.through_turn_id.clone(),
                        cwd,
                    )?;
                operation.ai_session_id = Some(result.ai_session_id.clone());
                operation.stage = ForkStage::Materialized;
                self.update_operation(&operation).await;
                operation.result = Some(AiSessionForkResult {
                    disposition: "created".to_string(),
                    ..result
                });
            }
            let result = operation.result.clone().ok_or_else(|| {
                ProviderError::bad_gateway(
                    "AI_SESSION_FORK_PROJECTION_FAILED",
                    "Fork did not materialize an AI session.",
                )
            })?;
            operation.result = Some(result.clone());
            operation.stage = ForkStage::Completed;
            self.update_operation(&operation).await;
            Ok(result)
        }
        .await;

        match result {
            Ok(result) => Ok(result),
            Err(error) => {
                self.compensate(&state, &operation, &source, &source_provider_session_id)
                    .await;
                Err(error)
            }
        }
    }

    async fn compensate(
        &self,
        state: &AppState,
        operation: &ForkOperation,
        source: &AiSession,
        source_provider_session_id: &str,
    ) {
        let mut cleanup_failures = Vec::new();
        if let Some(provider_session_id) = operation.provider_session_id.as_deref() {
            if provider_session_id != source_provider_session_id {
                if let Some(session) = state.ai_sessions.list().into_iter().find(|session| {
                    session.provider_session_id.as_deref() == Some(provider_session_id)
                }) {
                    let _ = state.ai_sessions.remove(&session.id);
                }
                if let Ok(provider) = state.ai_session_controller.provider(&source.agent) {
                    if provider.delete_session(provider_session_id).await.is_err()
                        && provider.archive_session(provider_session_id).await.is_err()
                    {
                        cleanup_failures.push("provider session retained");
                    }
                    let _ = provider.unsubscribe_session(provider_session_id).await;
                }
            }
        }
        if let Some(worktree_id) = operation.worktree_id.as_deref() {
            if !compensate_worktree_launch(state, source, worktree_id).await {
                cleanup_failures.push("managed worktree retained");
            }
        }
        self.operations
            .lock()
            .await
            .remove(&operation.client_request_id);
        self.persist().await;
        tracing::warn!(
            client_request_id = %operation.client_request_id,
            provider_session_id = operation.provider_session_id.as_deref(),
            worktree_id = operation.worktree_id.as_deref(),
            cleanup_failures = ?cleanup_failures,
            "AI Session Fork compensated"
        );
    }

    async fn update_operation(&self, operation: &ForkOperation) {
        self.operations
            .lock()
            .await
            .insert(operation.client_request_id.clone(), operation.clone());
        self.persist().await;
    }

    async fn persist(&self) {
        let store = ForkOperationStore {
            version: default_fork_operation_version(),
            operations: self
                .operations
                .lock()
                .await
                .values()
                .map(StoredForkOperation::from)
                .collect(),
        };
        let Ok(bytes) = serde_json::to_vec_pretty(&store) else {
            return;
        };
        if let Some(parent) = self.store_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(error) =
            controlled_instance_core::atomic::write_atomic(&self.store_path, &bytes, Some(0o600))
        {
            tracing::warn!(path = %self.store_path.display(), %error, "failed to persist AI Session Fork operations");
        }
    }
}

fn restore_fork_operations(path: &Path) -> HashMap<String, ForkOperation> {
    let Ok(bytes) = std::fs::read(path) else {
        return HashMap::new();
    };
    let Ok(store) = serde_json::from_slice::<ForkOperationStore>(&bytes) else {
        tracing::warn!(path = %path.display(), "ignoring invalid AI Session Fork operation store");
        return HashMap::new();
    };
    if store.version != default_fork_operation_version() {
        tracing::warn!(path = %path.display(), version = store.version, "ignoring unsupported AI Session Fork operation store");
        return HashMap::new();
    }
    store
        .operations
        .into_iter()
        .filter_map(|stored| {
            let operation = sanitize_stored_fork_operation(stored)?;
            Some((operation.client_request_id.clone(), operation))
        })
        .collect()
}

fn fork_fingerprint(
    source_session_id: &str,
    client_request_id: &str,
    through_turn_id: Option<&str>,
    workspace_mode: &str,
) -> String {
    let mut value = json!({
        "sourceSessionId": source_session_id,
        "clientRequestId": client_request_id,
        "workspace": { "mode": workspace_mode },
    });
    if let Some(through_turn_id) = through_turn_id {
        value["throughTurnId"] = Value::String(through_turn_id.to_string());
    }
    hex::encode(Sha256::digest(
        serde_json::to_vec(&value).unwrap_or_default(),
    ))
}

fn sanitize_stored_fork_operation(stored: StoredForkOperation) -> Option<ForkOperation> {
    let client_request_id = bounded_stored_string(&stored.client_request_id, 160)?;
    let source_session_id = bounded_stored_string(&stored.source_session_id, 120)?;
    if stored.fingerprint.len() != 64
        || !stored
            .fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let input_client_request_id = bounded_stored_string(&stored.input.client_request_id, 160)?;
    if input_client_request_id != client_request_id {
        return None;
    }
    let through_turn_id = match stored.input.through_turn_id.as_deref() {
        Some(value) => Some(bounded_stored_string(value, 240)?),
        None => None,
    };
    let workspace_mode = match stored.input.workspace.mode.as_str() {
        mode @ ("current" | "managed-worktree") => mode.to_string(),
        _ => return None,
    };
    if stored.fingerprint
        != fork_fingerprint(
            &source_session_id,
            &client_request_id,
            through_turn_id.as_deref(),
            &workspace_mode,
        )
    {
        return None;
    }

    let cwd = match stored.cwd.as_ref() {
        Some(cwd) => Some(bounded_stored_path(cwd, 4096)?),
        None => None,
    };
    let worktree_id = match stored.worktree_id.as_deref() {
        Some(value) => Some(bounded_stored_string(value, 240)?),
        None => None,
    };
    let provider_session_id = match stored.provider_session_id.as_deref() {
        Some(value) => Some(bounded_stored_string(value, 240)?),
        None => None,
    };
    let ai_session_id = match stored.ai_session_id.as_deref() {
        Some(value) => Some(bounded_stored_string(value, 120)?),
        None => None,
    };
    let result = match stored.result.as_ref() {
        Some(result) => Some(sanitize_stored_fork_result(result)?),
        None => None,
    };

    if stored.stage == ForkStage::Validated
        && (cwd.is_some()
            || worktree_id.is_some()
            || provider_session_id.is_some()
            || ai_session_id.is_some()
            || result.is_some())
    {
        return None;
    }
    if stored.stage != ForkStage::Validated && cwd.is_none() {
        return None;
    }
    if workspace_mode == "managed-worktree"
        && stored.stage != ForkStage::Validated
        && worktree_id.is_none()
    {
        return None;
    }
    if workspace_mode == "current" && worktree_id.is_some() {
        return None;
    }
    if matches!(
        stored.stage,
        ForkStage::ProviderCreated | ForkStage::Materialized | ForkStage::Completed
    ) && provider_session_id.is_none()
    {
        return None;
    }
    if stored.stage == ForkStage::WorkspacePrepared
        && (provider_session_id.is_some() || ai_session_id.is_some() || result.is_some())
    {
        return None;
    }
    if matches!(stored.stage, ForkStage::Materialized | ForkStage::Completed)
        && ai_session_id.is_none()
    {
        return None;
    }
    if stored.stage == ForkStage::ProviderCreated && (ai_session_id.is_some() || result.is_some()) {
        return None;
    }
    if stored.stage == ForkStage::Completed {
        let result = result.as_ref()?;
        if result.disposition != "created"
            || Some(result.ai_session_id.as_str()) != ai_session_id.as_deref()
            || Some(result.provider_session_id.as_str()) != provider_session_id.as_deref()
        {
            return None;
        }
    } else if result.is_some() {
        return None;
    }

    Some(ForkOperation {
        client_request_id,
        fingerprint: stored.fingerprint,
        source_session_id,
        through_turn_id,
        workspace_mode,
        stage: stored.stage,
        cwd,
        worktree_id,
        provider_session_id,
        ai_session_id,
        result,
    })
}

fn sanitize_stored_fork_result(result: &StoredForkResult) -> Option<AiSessionForkResult> {
    if !matches!(result.disposition.as_str(), "created" | "already-created")
        || result.creation_source != "ai-session"
    {
        return None;
    }
    Some(AiSessionForkResult {
        disposition: result.disposition.clone(),
        ai_session_id: bounded_stored_string(&result.ai_session_id, 120)?,
        provider_session_id: bounded_stored_string(&result.provider_session_id, 240)?,
        creation_source: result.creation_source.clone(),
    })
}

fn bounded_stored_string(value: &str, max_length: usize) -> Option<String> {
    let normalized = value.trim();
    (!normalized.is_empty() && normalized.chars().count() <= max_length)
        .then(|| normalized.to_string())
}

fn bounded_stored_path(path: &Path, max_length: usize) -> Option<PathBuf> {
    let value = bounded_stored_string(path.to_str()?, max_length)?;
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path)
}

async fn prepare_managed_worktree(
    state: &AppState,
    source: &AiSession,
    client_request_id: &str,
) -> Result<(PathBuf, String), ProviderError> {
    let target = repository_target(source);
    let sessions = repository_session_inventory(state);
    let resolved = state.repository_service.resolve(&target).await;
    let resolved = require_repository(resolved)?;
    if resolved.context.availability
        != controlled_instance_protocol::RepositoryAvailability::Available
        || resolved.worktree_root.is_none()
        || resolved.changes.is_none()
    {
        return Err(worktree_unavailable(
            "Fork source is not an available Git worktree.",
        ));
    }
    let changes = resolved.changes.as_ref().expect("changes");
    let dirty = changes.summary.staged
        + changes.summary.unstaged
        + changes.summary.untracked
        + changes.summary.conflicts;
    if dirty > 0 {
        return Err(worktree_unavailable(
            "Managed-worktree Fork requires a clean source worktree.",
        ));
    }
    let created = state
        .repository_service
        .create_worktree_for_ai_session(
            &target,
            &sessions,
            RepositoryWorktreeRef::Head,
            client_request_id,
        )
        .await
        .map_err(repository_provider_error)?;
    let Some(item) = created
        .worktrees
        .items
        .iter()
        .find(|item| item.summary.id == created.worktree_id)
    else {
        let _ = compensate_worktree_launch(state, source, &created.worktree_id).await;
        return Err(worktree_unavailable(
            "Managed Fork worktree is unavailable.",
        ));
    };
    let root = state
        .repository_service
        .resolve_worktree_workspace(
            &target,
            &sessions,
            &created.worktrees.repository_context_id,
            &item.summary.id,
        )
        .await
        .map_err(repository_provider_error)?;
    let cwd = worktree_workspace_cwd(&root, &resolved);
    if !cwd.is_dir() {
        let _ = compensate_worktree_launch(state, source, &created.worktree_id).await;
        return Err(worktree_unavailable(
            "Fork source folder does not exist in the managed worktree.",
        ));
    }
    Ok((cwd, created.worktree_id))
}

async fn validate_managed_worktree(
    state: &AppState,
    source: &AiSession,
    worktree_id: &str,
    expected_cwd: &Path,
) -> Result<bool, ProviderError> {
    let target = repository_target(source);
    let sessions = repository_session_inventory(state);
    let resolved = require_repository(state.repository_service.resolve(&target).await)?;
    let worktrees = state
        .repository_service
        .list_worktrees(&target, &sessions)
        .await
        .map_err(repository_provider_error)?;
    let Some(item) = worktrees
        .items
        .iter()
        .find(|item| item.summary.id == worktree_id)
    else {
        return Ok(false);
    };
    if !item.summary.managed || !item.can_create_ai_session {
        return Ok(false);
    }
    let root = state
        .repository_service
        .resolve_worktree_workspace(
            &target,
            &sessions,
            &worktrees.repository_context_id,
            worktree_id,
        )
        .await
        .map_err(repository_provider_error)?;
    let cwd = worktree_workspace_cwd(&root, &resolved);
    let actual = std::fs::canonicalize(cwd).ok();
    let expected = std::fs::canonicalize(expected_cwd).ok();
    Ok(
        matches!((actual, expected), (Some(actual), Some(expected)) if actual == expected)
            && expected_cwd.is_dir(),
    )
}

async fn compensate_worktree_launch(
    state: &AppState,
    source: &AiSession,
    worktree_id: &str,
) -> bool {
    let target = repository_target(source);
    let sessions = repository_session_inventory(state);
    let Ok(current) = state
        .repository_service
        .list_worktrees(&target, &sessions)
        .await
    else {
        return false;
    };
    let Some(item) = current
        .items
        .iter()
        .find(|item| item.summary.id == worktree_id)
    else {
        return false;
    };
    if !item.can_remove {
        return false;
    }
    state
        .repository_service
        .remove_worktree(
            &target,
            &sessions,
            RepositoryRemoveWorktreeRequest {
                worktree_id: worktree_id.to_string(),
                expected_snapshot_id: current.snapshot_id,
                confirm: true,
            },
        )
        .await
        .is_ok()
}

fn repository_target(source: &AiSession) -> RepositorySessionTarget {
    RepositorySessionTarget {
        kind: RepositorySessionKind::AiSession,
        id: source.id.clone(),
        session_found: true,
        cwd: source.cwd.clone(),
        status: Some(source.status.clone()),
    }
}

fn repository_session_inventory(state: &AppState) -> RepositorySessionInventory {
    let app_sessions = state.app_runtime.list_session_workspaces();
    let running_app_session_ids = app_sessions
        .iter()
        .filter(|session| session.status == "running")
        .map(|session| session.id.clone())
        .collect::<Vec<_>>();
    let ai_sessions = state
        .ai_sessions
        .bound_snapshot_with_limit(&running_app_session_ids, 10_000)
        .sessions
        .into_iter()
        .map(
            |session| controlled_instance_workspace::RepositoryAiSessionPresence {
                id: session.id,
                app_session_id: session.app_session_id,
                cwd: session.cwd,
                status: Some(session.status),
            },
        )
        .collect();
    RepositorySessionInventory {
        ai_sessions,
        app_sessions: app_sessions
            .into_iter()
            .map(
                |session| controlled_instance_workspace::RepositoryAppSessionPresence {
                    id: session.id,
                    cwd: session.cwd,
                    status: Some(session.status),
                },
            )
            .collect(),
    }
}

fn worktree_workspace_cwd(
    root: &Path,
    source: &controlled_instance_workspace::ResolvedRepository,
) -> PathBuf {
    match source
        .context
        .cwd_relative_path
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(relative) => {
            let mut path = root.to_path_buf();
            for segment in relative.split('/') {
                path.push(segment);
            }
            path
        }
        None => root.to_path_buf(),
    }
}

fn require_repository(
    resolved: controlled_instance_workspace::ResolvedRepository,
) -> Result<controlled_instance_workspace::ResolvedRepository, ProviderError> {
    if resolved.context.availability
        == controlled_instance_protocol::RepositoryAvailability::Available
    {
        Ok(resolved)
    } else {
        Err(worktree_unavailable(
            "Fork source is not an available Git worktree.",
        ))
    }
}

fn repository_provider_error(error: RepositoryOperationError) -> ProviderError {
    let status = if matches!(
        error.code.as_str(),
        "AI_SESSION_FORK_WORKTREE_UNAVAILABLE" | "REPOSITORY_WORKTREE_UNSAFE"
    ) {
        409
    } else {
        400
    };
    ProviderError::new(error.code, error.message, status)
}

fn worktree_unavailable(message: &str) -> ProviderError {
    ProviderError::conflict("AI_SESSION_FORK_WORKTREE_UNAVAILABLE", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node_fork_operation(
        path: &Path,
        client_request_id: &str,
        through_turn_id: Option<&str>,
        workspace_mode: &str,
    ) -> Value {
        let fingerprint =
            fork_fingerprint("ses_1", client_request_id, through_turn_id, workspace_mode);
        json!({
            "clientRequestId": client_request_id,
            "fingerprint": fingerprint,
            "sourceSessionId": "ses_1",
            "input": {
                "clientRequestId": client_request_id,
                "throughTurnId": through_turn_id,
                "workspace": { "mode": workspace_mode }
            },
            "stage": "workspace-prepared",
            "cwd": path,
            "worktreeId": (workspace_mode == "managed-worktree").then_some("wt_1")
        })
    }

    #[test]
    fn fork_fingerprint_matches_node_canonical_json() {
        assert_eq!(
            fork_fingerprint("ses_1", "req-1", None, "current"),
            "9a465ccfc08fe3c34af7cc054b092080673dd2e51666453365981223348b76ea"
        );
    }

    #[test]
    fn restores_node_shaped_fork_operations_and_rejects_invalid_stages() {
        let root = tempfile::tempdir().expect("tempdir");
        let path = root.path().join("ai-session-fork-operations.json");
        let mut valid = node_fork_operation(root.path(), "req-valid", Some("turn-1"), "current");
        valid["stage"] = json!("validated");
        valid.as_object_mut().expect("object").remove("cwd");
        let mut invalid = node_fork_operation(root.path(), "req-invalid", None, "current");
        invalid["stage"] = json!("provider-created");
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "version": 1,
                "operations": [valid, invalid]
            }))
            .expect("store"),
        )
        .expect("write");

        let restored = restore_fork_operations(&path);
        assert_eq!(restored.len(), 1);
        let operation = restored.get("req-valid").expect("valid operation");
        assert_eq!(operation.through_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(operation.workspace_mode, "current");
        assert_eq!(operation.stage, ForkStage::Validated);
    }

    #[tokio::test]
    async fn persists_fork_operations_in_the_node_wire_shape() {
        let root = tempfile::tempdir().expect("tempdir");
        let path = root.path().join("ai-session-fork-operations.json");
        let coordinator = AiSessionForkCoordinator::new(path.clone());
        coordinator.operations.lock().await.insert(
            "req-round-trip".to_string(),
            ForkOperation {
                client_request_id: "req-round-trip".to_string(),
                fingerprint: fork_fingerprint("ses_1", "req-round-trip", None, "managed-worktree"),
                source_session_id: "ses_1".to_string(),
                through_turn_id: None,
                workspace_mode: "managed-worktree".to_string(),
                stage: ForkStage::WorkspacePrepared,
                cwd: Some(root.path().to_path_buf()),
                worktree_id: Some("wt_1".to_string()),
                provider_session_id: None,
                ai_session_id: None,
                result: None,
            },
        );
        coordinator.persist().await;

        let stored: Value = serde_json::from_slice(&std::fs::read(&path).expect("read store"))
            .expect("parse store");
        assert_eq!(stored["version"], 1);
        assert_eq!(
            stored["operations"][0]["input"]["clientRequestId"],
            "req-round-trip"
        );
        assert_eq!(
            stored["operations"][0]["input"]["workspace"]["mode"],
            "managed-worktree"
        );
        assert!(stored["operations"][0].get("workspaceMode").is_none());
        let restored = restore_fork_operations(&path);
        assert!(restored.contains_key("req-round-trip"));
    }
}
