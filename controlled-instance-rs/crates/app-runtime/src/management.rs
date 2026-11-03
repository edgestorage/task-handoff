use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chrono::{SecondsFormat, Utc};
use controlled_instance_core::atomic::{read_json, write_json_atomic};
use controlled_instance_protocol::{
    mint_entity_id, AppManagementCommand, AppManagementError, AppManagementEvent, AppManagementJob,
    AppManagementJobState, AppManagementOperation, AppManagementOperationRequest,
    AppManagementSnapshot, FinalComputerCapabilities, ManagedAppActionReason,
    ManagedAppActionReasonCode, ManagedAppManagementSource, ManagedAppProjection,
    ManagedAppUpdateState,
};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    builtin_managed_app_definitions, detect_final_computer_capabilities,
    detect_final_computer_capabilities_sync, detect_managed_app_ownership_with_context,
    detect_managed_app_with_managed_root, managed_app_projection, select_install_recipe,
    AppRecipeExecutionContext, AppRecipeExecutionError, AppRecipeExecutor, AppUpdateCheckResult,
    AppUpdateChecker, InstallRecipe, ManagedAppDefinition, ManagedAppDetectionResult,
    ManagedAppOwnershipContext,
};

const ACTIVE_STATES: [AppManagementJobState; 2] = [
    AppManagementJobState::Queued,
    AppManagementJobState::Running,
];
const JOB_LOG_LIMIT: usize = 32_768;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppManagementRequestError {
    pub code: String,
    pub message: String,
    pub status_code: u16,
    pub details: Option<Value>,
}

impl AppManagementRequestError {
    fn new(code: &str, message: impl Into<String>, status_code: u16) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            status_code,
            details: None,
        }
    }

    fn details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl std::fmt::Display for AppManagementRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AppManagementRequestError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppManagementSession {
    pub id: String,
    pub app_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredJobs {
    schema_version: u32,
    jobs: Vec<AppManagementJob>,
}

#[derive(Debug, Clone)]
struct OwnershipCache {
    fingerprint: String,
    source: ManagedAppManagementSource,
    recipe: Option<InstallRecipe>,
}

#[derive(Debug)]
struct ManagerState {
    jobs: BTreeMap<String, AppManagementJob>,
    capabilities: FinalComputerCapabilities,
    capabilities_observed_at: Instant,
    ownership: BTreeMap<String, OwnershipCache>,
    update_checks: BTreeMap<String, ManagedAppUpdateState>,
    stream_id: String,
    sequence: u64,
}

type Definitions = Arc<dyn Fn() -> Vec<ManagedAppDefinition> + Send + Sync>;
type Sessions = Arc<dyn Fn() -> Vec<AppManagementSession> + Send + Sync>;
type Publisher = Arc<dyn Fn(AppManagementEvent) + Send + Sync>;
type Warning = Arc<dyn Fn(&str) + Send + Sync>;
type RuntimeHook = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct AppManagementManager {
    inner: Arc<Mutex<ManagerState>>,
    state_dir: PathBuf,
    install_base_dir: PathBuf,
    definitions: Definitions,
    sessions: Sessions,
    publish: Publisher,
    warn: Warning,
    runtime_hook: RuntimeHook,
    executor: AppRecipeExecutor,
    update_checker: Arc<AppUpdateChecker>,
    queue: Arc<tokio::sync::Mutex<()>>,
}

impl AppManagementManager {
    pub fn new(
        state_dir: impl Into<PathBuf>,
        install_base_dir: impl Into<PathBuf>,
        sessions: impl Fn() -> Vec<AppManagementSession> + Send + Sync + 'static,
        publish: impl Fn(AppManagementEvent) + Send + Sync + 'static,
    ) -> Self {
        Self::with_parts(
            state_dir,
            install_base_dir,
            Arc::new(builtin_managed_app_definitions),
            Arc::new(sessions),
            Arc::new(publish),
            Arc::new(|message| tracing::warn!(message, "app management warning")),
            Arc::new(|_| {}),
        )
    }

    pub fn new_with_runtime_hook(
        state_dir: impl Into<PathBuf>,
        install_base_dir: impl Into<PathBuf>,
        sessions: impl Fn() -> Vec<AppManagementSession> + Send + Sync + 'static,
        publish: impl Fn(AppManagementEvent) + Send + Sync + 'static,
        runtime_hook: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        Self::with_parts(
            state_dir,
            install_base_dir,
            Arc::new(builtin_managed_app_definitions),
            Arc::new(sessions),
            Arc::new(publish),
            Arc::new(|message| tracing::warn!(message, "app management warning")),
            Arc::new(runtime_hook),
        )
    }

    fn with_parts(
        state_dir: impl Into<PathBuf>,
        install_base_dir: impl Into<PathBuf>,
        definitions: Definitions,
        sessions: Sessions,
        publish: Publisher,
        warn: Warning,
        runtime_hook: RuntimeHook,
    ) -> Self {
        let state_dir = state_dir.into();
        let install_base_dir = install_base_dir.into();
        let jobs = load_jobs(&state_dir, &warn);
        let capabilities = detect_final_computer_capabilities_sync();
        let state = ManagerState {
            jobs,
            capabilities,
            capabilities_observed_at: Instant::now(),
            ownership: BTreeMap::new(),
            update_checks: BTreeMap::new(),
            stream_id: format!("appstream_{}", uuid::Uuid::new_v4().simple()),
            sequence: 0,
        };
        let manager = Self {
            inner: Arc::new(Mutex::new(state)),
            state_dir: state_dir.clone(),
            install_base_dir: install_base_dir.clone(),
            definitions,
            sessions,
            publish,
            warn,
            runtime_hook,
            executor: AppRecipeExecutor::new(install_base_dir, state_dir),
            update_checker: Arc::new(AppUpdateChecker::new()),
            queue: Arc::new(tokio::sync::Mutex::new(())),
        };
        manager.recover_interrupted();
        manager
    }

    pub fn snapshot(&self) -> AppManagementSnapshot {
        let definitions = (self.definitions)();
        let mut state = self.lock();
        snapshot_locked(&definitions, &mut state, &self.install_base_dir)
    }

    pub async fn refresh_snapshot(&self, force_capabilities: bool) -> AppManagementSnapshot {
        let definitions = (self.definitions)();
        let stale = self.lock().capabilities_observed_at.elapsed() >= Duration::from_secs(10);
        if force_capabilities || stale {
            let capabilities = detect_final_computer_capabilities().await;
            let mut state = self.lock();
            state.capabilities = capabilities;
            state.capabilities_observed_at = Instant::now();
        }
        let detections = definitions
            .iter()
            .map(|definition| {
                (
                    definition.clone(),
                    detect_managed_app_with_managed_root(definition, Some(&self.install_base_dir)),
                )
            })
            .collect::<Vec<_>>();
        let capabilities = self.lock().capabilities.clone();
        let ownership_context = ManagedAppOwnershipContext {
            state_dir: &self.state_dir,
            install_base_dir: &self.install_base_dir,
        };
        let ownership = join_all(detections.iter().map(|(definition, detection)| {
            detect_managed_app_ownership_with_context(
                definition,
                detection,
                &capabilities,
                Some(&ownership_context),
            )
        }))
        .await;
        let mut state = self.lock();
        for ((definition, detection), ownership) in detections.into_iter().zip(ownership) {
            let fingerprint = ownership_fingerprint(&detection, &state.capabilities);
            state.ownership.insert(
                definition.launcher.id,
                OwnershipCache {
                    fingerprint,
                    source: ownership.source,
                    recipe: ownership.recipe,
                },
            );
        }
        snapshot_locked(&definitions, &mut state, &self.install_base_dir)
    }

    pub fn has_active_operation(&self, app_id: &str) -> bool {
        self.lock()
            .jobs
            .values()
            .any(|job| job.app_id == app_id && ACTIVE_STATES.contains(&job.state))
    }

    pub fn get_job(&self, job_id: &str) -> Result<AppManagementJob, AppManagementRequestError> {
        self.lock().jobs.get(job_id).cloned().ok_or_else(|| {
            AppManagementRequestError::new(
                "app_job_not_found",
                "App management job not found.",
                404,
            )
        })
    }

    pub async fn check_for_update(
        &self,
        app_id: &str,
    ) -> Result<controlled_instance_protocol::ManagedAppUpdateCheck, AppManagementRequestError>
    {
        self.refresh_snapshot(false).await;
        let definitions = (self.definitions)();
        let definition = definitions
            .iter()
            .find(|definition| definition.launcher.id == app_id)
            .cloned()
            .ok_or_else(|| {
                AppManagementRequestError::new(
                    "unknown_app",
                    "The requested built-in app does not exist.",
                    404,
                )
            })?;
        let (capabilities, detection, selected, source) = {
            let state = self.lock();
            let detection =
                detect_managed_app_with_managed_root(&definition, Some(&self.install_base_dir));
            let selected = select_install_recipe(&definition, &state.capabilities);
            let fingerprint = ownership_fingerprint(&detection, &state.capabilities);
            let cached = state.ownership.get(app_id);
            let source = management_source(&detection, &selected.recipe, cached, &fingerprint);
            (state.capabilities.clone(), detection, selected, source)
        };
        let projection =
            managed_app_projection(&definition, &detection, &capabilities, Some(source));
        if selected.recipe.is_none() || projection.can_update != Some(true) {
            let reason = projection
                .update_reason
                .clone()
                .unwrap_or(ManagedAppActionReason {
                    code: ManagedAppActionReasonCode::NotInstalled,
                    message: "The requested app update check is unavailable.".to_string(),
                });
            return Err(AppManagementRequestError::new(
                "app_operation_unavailable",
                projection
                    .update_reason
                    .as_ref()
                    .map(|reason| reason.message.clone())
                    .unwrap_or_else(|| {
                        "The requested app update check is unavailable.".to_string()
                    }),
                409,
            )
            .details(json!({ "reason": reason })));
        }
        let outcome = self
            .update_checker
            .check_with_install_root(
                selected.recipe.as_ref().expect("selected recipe"),
                &capabilities,
                Some((app_id, &self.install_base_dir)),
            )
            .await;
        let state_value = update_state(outcome);
        self.lock()
            .update_checks
            .insert(app_id.to_string(), state_value.clone());
        self.publish_snapshot();
        Ok(controlled_instance_protocol::ManagedAppUpdateCheck {
            app_id: app_id.to_string(),
            status: state_value.status,
            installed_version: state_value.installed_version,
            latest_version: state_value.latest_version,
            checked_at: state_value.checked_at,
            reason: state_value.reason,
        })
    }

    pub async fn request(
        &self,
        app_id: &str,
        operation: AppManagementOperation,
        input: AppManagementOperationRequest,
    ) -> Result<AppManagementJob, AppManagementRequestError> {
        if let Some(request_id) = input.request_id.as_deref() {
            validate_request_id(request_id)?;
        }
        self.refresh_snapshot(false).await;
        let definitions = (self.definitions)();
        let definition = definitions
            .iter()
            .find(|definition| definition.launcher.id == app_id)
            .cloned()
            .ok_or_else(|| {
                AppManagementRequestError::new(
                    "unknown_app",
                    "The requested built-in app does not exist.",
                    404,
                )
            })?;
        let mut state = self.lock();
        if let Some(request_id) = input.request_id.as_deref() {
            if let Some(prior) = state
                .jobs
                .values()
                .find(|job| job.request_id.as_deref() == Some(request_id))
            {
                if prior.app_id == app_id && prior.operation == operation {
                    return Ok(prior.clone());
                }
                return Err(AppManagementRequestError::new(
                    "app_request_id_conflict",
                    "The app management request id is already bound to a different operation.",
                    409,
                )
                .details(json!({
                    "jobId": prior.id,
                    "appId": prior.app_id,
                    "operation": operation_name(prior.operation),
                })));
            }
        }
        if let Some(active) = state
            .jobs
            .values()
            .find(|job| job.app_id == app_id && ACTIVE_STATES.contains(&job.state))
        {
            if active.operation == operation {
                return Ok(active.clone());
            }
            return Err(AppManagementRequestError::new(
                "app_operation_conflict",
                "A conflicting app operation is already active.",
                409,
            )
            .details(json!({ "activeJobId": active.id })));
        }
        if operation != AppManagementOperation::Install {
            let running = (self.sessions)()
                .into_iter()
                .filter(|session| {
                    session.app_id == app_id
                        && matches!(session.status.as_str(), "created" | "running" | "stopping")
                })
                .collect::<Vec<_>>();
            if !running.is_empty() {
                return Err(AppManagementRequestError::new(
                    "app_sessions_running",
                    "The app has running sessions and cannot be changed.",
                    409,
                )
                .details(json!({
                    "sessionIds": running.into_iter().map(|session| session.id).collect::<Vec<_>>()
                })));
            }
        }
        let detection =
            detect_managed_app_with_managed_root(&definition, Some(&self.install_base_dir));
        let selected = select_install_recipe(&definition, &state.capabilities);
        let fingerprint = ownership_fingerprint(&detection, &state.capabilities);
        let cached = state.ownership.get(app_id).cloned();
        let source = management_source(&detection, &selected.recipe, cached.as_ref(), &fingerprint);
        let projection =
            managed_app_projection(&definition, &detection, &state.capabilities, Some(source));
        let operation_recipe = if operation == AppManagementOperation::Uninstall
            && cached
                .as_ref()
                .is_some_and(|cached| cached.fingerprint == fingerprint)
        {
            cached
                .and_then(|cached| cached.recipe)
                .or(selected.recipe.clone())
        } else {
            selected.recipe.clone()
        };
        let availability = match operation {
            AppManagementOperation::Install => {
                (projection.can_install, projection.install_reason.clone())
            }
            AppManagementOperation::Uninstall => (
                projection.can_uninstall,
                projection.uninstall_reason.clone(),
            ),
            AppManagementOperation::Update => (
                projection.can_update == Some(true),
                projection.update_reason.clone(),
            ),
        };
        if operation_recipe.is_none() || !availability.0 {
            let reason = availability.1;
            return Err(AppManagementRequestError::new(
                "app_operation_unavailable",
                reason
                    .as_ref()
                    .map(|reason| reason.message.clone())
                    .unwrap_or_else(|| "The requested app operation is unavailable.".to_string()),
                409,
            )
            .details(json!({ "reason": reason })));
        }
        let timestamp = now();
        let job = AppManagementJob {
            id: mint_entity_id("appjob"),
            request_id: input.request_id,
            app_id: app_id.to_string(),
            operation,
            state: AppManagementJobState::Queued,
            phase: None,
            progress: None,
            command: None,
            log_tail: None,
            log_truncated: None,
            error: None,
            requested_at: timestamp.clone(),
            started_at: None,
            finished_at: None,
            updated_at: timestamp,
        };
        state.jobs.insert(job.id.clone(), job.clone());
        persist_jobs(&self.state_dir, &state.jobs, &self.warn);
        self.emit_locked(&mut state, Some(&job), true);
        drop(state);
        let manager = self.clone();
        let job_id = job.id.clone();
        let recipe = operation_recipe.expect("checked recipe");
        let operation = job.operation;
        tokio::spawn(async move {
            manager.run_job(job_id, definition, operation, recipe).await;
        });
        Ok(job)
    }

    pub fn snapshot_event(&self) -> AppManagementEvent {
        let snapshot = self.snapshot();
        AppManagementEvent {
            event_type: "app-management".to_string(),
            stream_id: snapshot.stream_id.clone(),
            sequence: snapshot.sequence,
            observed_at: snapshot.observed_at.clone(),
            job: None,
            snapshot: Some(snapshot),
        }
    }

    pub fn publish_snapshot(&self) -> AppManagementEvent {
        let definitions = (self.definitions)();
        let mut state = self.lock();
        state.sequence = state.sequence.saturating_add(1);
        let sequence = state.sequence;
        let observed_at = now();
        let snapshot = snapshot_locked(&definitions, &mut state, &self.install_base_dir);
        let event = AppManagementEvent {
            event_type: "app-management".to_string(),
            stream_id: snapshot.stream_id.clone(),
            sequence,
            observed_at,
            job: None,
            snapshot: Some(snapshot),
        };
        (self.publish)(event.clone());
        event
    }

    async fn run_job(
        &self,
        job_id: String,
        definition: ManagedAppDefinition,
        operation: AppManagementOperation,
        recipe: InstallRecipe,
    ) {
        let _queue = self.queue.lock().await;
        let pending_output = Arc::new(Mutex::new(String::new()));
        let stop_flush = Arc::new(tokio::sync::Notify::new());
        let flush_task = {
            let manager = self.clone();
            let job_id = job_id.clone();
            let pending_output = pending_output.clone();
            let stop_flush = stop_flush.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {
                            manager.flush_output(&job_id, &pending_output);
                        }
                        _ = stop_flush.notified() => {
                            manager.flush_output(&job_id, &pending_output);
                            break;
                        }
                    }
                }
            })
        };
        let timestamp = now();
        if let Some(job) = self.update_job(&job_id, |job| {
            job.state = AppManagementJobState::Running;
            job.phase = Some("starting".to_string());
            job.started_at = Some(timestamp.clone());
            job.updated_at = timestamp.clone();
        }) {
            self.emit(Some(&job), true);
        }
        let context = AppRecipeExecutionContext {
            app_id: definition.launcher.id.clone(),
            capabilities: self.lock().capabilities.clone(),
            on_phase: Some({
                let manager = self.clone();
                let job_id = job_id.clone();
                let pending_output = pending_output.clone();
                Arc::new(move |phase, progress| {
                    manager.flush_output(&job_id, &pending_output);
                    if let Some(job) = manager.update_job(&job_id, |job| {
                        job.phase = Some(phase.to_string());
                        job.progress = progress.clone();
                        job.updated_at = now();
                    }) {
                        manager.emit(Some(&job), false);
                    }
                })
            }),
            on_command: Some({
                let manager = self.clone();
                let job_id = job_id.clone();
                let pending_output = pending_output.clone();
                Arc::new(move |command: AppManagementCommand| {
                    manager.flush_output(&job_id, &pending_output);
                    if let Some(job) = manager.update_job(&job_id, |job| {
                        let prefix = job
                            .log_tail
                            .as_ref()
                            .filter(|value| !value.ends_with('\n'))
                            .map(|_| "\n")
                            .unwrap_or("");
                        append_job_log(job, &format!("{prefix}$ {}\n", command_line(&command)));
                        job.command = Some(command);
                        job.updated_at = now();
                    }) {
                        manager.emit(Some(&job), false);
                    }
                })
            }),
            on_output: Some({
                let pending_output = pending_output.clone();
                Arc::new(move |_stream, chunk| {
                    if let Ok(mut pending) = pending_output.lock() {
                        pending.push_str(chunk);
                    }
                })
            }),
        };
        let busy = operation != AppManagementOperation::Install
            && (self.sessions)().iter().any(|session| {
                session.app_id == definition.launcher.id
                    && matches!(session.status.as_str(), "created" | "running" | "stopping")
            });
        let result = if busy {
            Err(AppRecipeExecutionError::new(
                "app_sessions_running",
                "The app has running sessions and cannot be changed.",
                true,
            ))
        } else {
            if operation != AppManagementOperation::Install {
                (self.runtime_hook)(&definition.launcher.id);
            }
            self.executor.execute(operation, &recipe, &context).await
        };
        if result.is_ok() {
            (self.runtime_hook)(&definition.launcher.id);
        }
        stop_flush.notify_waiters();
        let _ = flush_task.await;
        let terminal = match result {
            Ok(_) => {
                let detection =
                    detect_managed_app_with_managed_root(&definition, Some(&self.install_base_dir));
                let satisfied = if operation == AppManagementOperation::Uninstall {
                    detection.state == controlled_instance_protocol::ManagedAppState::NotInstalled
                } else {
                    detection.state == controlled_instance_protocol::ManagedAppState::Installed
                };
                if !satisfied {
                    Err(AppRecipeExecutionError::new(
                        "postcondition_failed",
                        "App operation completed but detection did not confirm the required state.",
                        true,
                    ))
                } else {
                    let capabilities = detect_final_computer_capabilities().await;
                    let ownership = detect_managed_app_ownership_with_context(
                        &definition,
                        &detection,
                        &capabilities,
                        Some(&ManagedAppOwnershipContext {
                            state_dir: &self.state_dir,
                            install_base_dir: &self.install_base_dir,
                        }),
                    )
                    .await;
                    {
                        let mut state = self.lock();
                        state.capabilities = capabilities;
                        state.capabilities_observed_at = Instant::now();
                        let fingerprint = ownership_fingerprint(&detection, &state.capabilities);
                        state.ownership.insert(
                            definition.launcher.id.clone(),
                            OwnershipCache {
                                fingerprint,
                                source: ownership.source,
                                recipe: ownership.recipe,
                            },
                        );
                    }
                    Ok(())
                }
            }
            Err(error) => Err(error),
        };
        let finished_at = now();
        if let Some(job) = self.update_job(&job_id, |job| {
            job.finished_at = Some(finished_at.clone());
            job.updated_at = finished_at;
            job.progress = None;
            match &terminal {
                Ok(()) => {
                    job.state = AppManagementJobState::Succeeded;
                    job.phase = Some("verify".to_string());
                }
                Err(error) => {
                    job.state = AppManagementJobState::Failed;
                    job.error = Some(AppManagementError {
                        code: error.code.clone(),
                        message: error.message.clone(),
                        retryable: error.retryable,
                        session_ids: None,
                    });
                }
            }
        }) {
            self.lock().update_checks.remove(&job.app_id);
            self.emit(Some(&job), true);
        }
    }

    fn update_job(
        &self,
        job_id: &str,
        update: impl FnOnce(&mut AppManagementJob),
    ) -> Option<AppManagementJob> {
        let mut state = self.lock();
        let job = state.jobs.get_mut(job_id)?;
        update(job);
        let job = job.clone();
        persist_jobs(&self.state_dir, &state.jobs, &self.warn);
        Some(job)
    }

    fn flush_output(&self, job_id: &str, pending: &Arc<Mutex<String>>) {
        let output = pending
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default();
        if output.is_empty() {
            return;
        }
        if let Some(job) = self.update_job(job_id, |job| {
            append_job_log(job, &output);
            job.updated_at = now();
        }) {
            self.emit(Some(&job), false);
        }
    }

    fn emit(&self, job: Option<&AppManagementJob>, include_snapshot: bool) {
        let mut state = self.lock();
        self.emit_locked(&mut state, job, include_snapshot);
    }

    fn emit_locked(
        &self,
        state: &mut ManagerState,
        job: Option<&AppManagementJob>,
        include_snapshot: bool,
    ) {
        state.sequence = state.sequence.saturating_add(1);
        let sequence = state.sequence;
        let observed_at = now();
        let snapshot = include_snapshot.then(|| {
            let definitions = (self.definitions)();
            snapshot_locked(&definitions, state, &self.install_base_dir)
        });
        let event = AppManagementEvent {
            event_type: "app-management".to_string(),
            stream_id: state.stream_id.clone(),
            sequence,
            observed_at,
            job: job.cloned(),
            snapshot,
        };
        (self.publish)(event);
    }

    fn recover_interrupted(&self) {
        let active = self
            .lock()
            .jobs
            .values()
            .filter(|job| ACTIVE_STATES.contains(&job.state))
            .map(|job| job.id.clone())
            .collect::<Vec<_>>();
        if active.is_empty() {
            return;
        }
        let timestamp = now();
        let mut state = self.lock();
        for id in active {
            if let Some(job) = state.jobs.get_mut(&id) {
                job.state = AppManagementJobState::Interrupted;
                job.error = Some(AppManagementError {
                    code: "controlled_instance_restarted".to_string(),
                    message: "The controlled instance restarted before the operation completed."
                        .to_string(),
                    retryable: true,
                    session_ids: None,
                });
                job.finished_at = Some(timestamp.clone());
                job.updated_at = timestamp.clone();
            }
        }
        persist_jobs(&self.state_dir, &state.jobs, &self.warn);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ManagerState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn snapshot_locked(
    definitions: &[ManagedAppDefinition],
    state: &mut ManagerState,
    install_base_dir: &Path,
) -> AppManagementSnapshot {
    let mut jobs = state.jobs.values().cloned().collect::<Vec<_>>();
    jobs.sort_by(|left, right| right.requested_at.cmp(&left.requested_at));
    let active_jobs = jobs
        .iter()
        .filter(|job| ACTIVE_STATES.contains(&job.state))
        .cloned()
        .collect::<Vec<_>>();
    let active_by_app = active_jobs
        .iter()
        .map(|job| (job.app_id.as_str(), job))
        .collect::<BTreeMap<_, _>>();
    let apps = definitions
        .iter()
        .map(|definition| {
            let detection =
                detect_managed_app_with_managed_root(definition, Some(install_base_dir));
            let fingerprint = ownership_fingerprint(&detection, &state.capabilities);
            let selected = select_install_recipe(definition, &state.capabilities);
            let cached = state.ownership.get(&definition.launcher.id);
            let source = management_source(&detection, &selected.recipe, cached, &fingerprint);
            let projection =
                managed_app_projection(definition, &detection, &state.capabilities, Some(source));
            let mut projection = if let Some(check) = state.update_checks.get(&projection.id) {
                ManagedAppProjection {
                    update_check: Some(check.clone()),
                    ..projection
                }
            } else {
                projection
            };
            if let Some(active) = active_by_app.get(projection.id.as_str()) {
                projection.can_install = false;
                projection.can_uninstall = false;
                projection.can_update = Some(false);
                projection.install_reason = Some(progress_reason());
                projection.uninstall_reason = Some(progress_reason());
                projection.active_job_id = Some(active.id.clone());
            }
            projection
        })
        .collect::<Vec<_>>();
    AppManagementSnapshot {
        stream_id: state.stream_id.clone(),
        sequence: state.sequence,
        capabilities: state.capabilities.clone(),
        apps,
        active_jobs,
        recent_jobs: jobs
            .into_iter()
            .filter(|job| !ACTIVE_STATES.contains(&job.state))
            .take(50)
            .collect(),
        observed_at: now(),
    }
}

fn progress_reason() -> ManagedAppActionReason {
    ManagedAppActionReason {
        code: ManagedAppActionReasonCode::OperationInProgress,
        message: "An app management operation is already in progress.".to_string(),
    }
}

fn management_source(
    detection: &ManagedAppDetectionResult,
    selected: &Option<InstallRecipe>,
    cached: Option<&OwnershipCache>,
    fingerprint: &str,
) -> ManagedAppManagementSource {
    if detection.state == controlled_instance_protocol::ManagedAppState::NotInstalled {
        return ManagedAppManagementSource::None;
    }
    if matches!(selected, Some(InstallRecipe::Bundled { .. })) {
        return ManagedAppManagementSource::Bundled;
    }
    if cached.is_some_and(|cached| cached.fingerprint == fingerprint) {
        cached
            .map(|cached| cached.source)
            .unwrap_or(ManagedAppManagementSource::External)
    } else {
        ManagedAppManagementSource::External
    }
}

fn ownership_fingerprint(
    detection: &ManagedAppDetectionResult,
    capabilities: &FinalComputerCapabilities,
) -> String {
    serde_json::to_string(&json!({
        "state": detection.state,
        "executablePaths": detection.executable_paths,
        "platform": capabilities.platform,
        "arch": capabilities.arch,
        "privilege": capabilities.privilege,
    }))
    .unwrap_or_default()
}

fn append_job_log(job: &mut AppManagementJob, value: &str) {
    let combined = format!(
        "{}{}",
        job.log_tail.as_deref().unwrap_or_default(),
        sanitize_output(value)
    );
    let chars = combined.chars().collect::<Vec<_>>();
    let truncated = chars.len() > JOB_LOG_LIMIT;
    job.log_tail = Some(if truncated {
        chars[chars.len() - JOB_LOG_LIMIT..].iter().collect()
    } else {
        combined
    });
    if job.log_truncated == Some(true) || truncated {
        job.log_truncated = Some(true);
    }
}

fn sanitize_output(value: &str) -> String {
    let mut output = String::new();
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            if chars.next() != Some('[') {
                continue;
            }
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
            continue;
        }
        if character == '\r' && chars.peek() != Some(&'\n') {
            output.push('\n');
        } else {
            output.push(character);
        }
    }
    output
}

fn command_argument(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_./:@%+=,-".contains(&byte))
    {
        value.to_string()
    } else {
        serde_json::to_string(value).unwrap_or_else(|_| format!("{value:?}"))
    }
}

fn command_line(command: &AppManagementCommand) -> String {
    std::iter::once(command.executable.as_str())
        .chain(command.args.iter().map(String::as_str))
        .map(command_argument)
        .collect::<Vec<_>>()
        .join(" ")
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn operation_name(operation: AppManagementOperation) -> &'static str {
    match operation {
        AppManagementOperation::Install => "install",
        AppManagementOperation::Uninstall => "uninstall",
        AppManagementOperation::Update => "update",
    }
}

fn validate_request_id(value: &str) -> Result<(), AppManagementRequestError> {
    if value.len() < 3
        || value.len() > 160
        || !value.starts_with(|character: char| character.is_ascii_lowercase())
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
    {
        return Err(AppManagementRequestError::new(
            "app_management_input_invalid",
            "requestId is invalid.",
            400,
        ));
    }
    Ok(())
}

fn jobs_path(state_dir: &Path) -> PathBuf {
    state_dir.join("jobs.json")
}

fn load_jobs(state_dir: &Path, warn: &Warning) -> BTreeMap<String, AppManagementJob> {
    let path = jobs_path(state_dir);
    let Ok(stored) = read_json::<StoredJobs>(&path) else {
        if path.exists() {
            warn("App management job store could not be read; invalid jobs were ignored.");
        }
        return BTreeMap::new();
    };
    if stored.schema_version != 1 {
        warn("App management job store has an unsupported schema version.");
    }
    stored
        .jobs
        .into_iter()
        .map(|job| (job.id.clone(), job))
        .collect()
}

fn persist_jobs(state_dir: &Path, jobs: &BTreeMap<String, AppManagementJob>, warn: &Warning) {
    let mut values = jobs.values().cloned().collect::<Vec<_>>();
    values.sort_by(|left, right| right.requested_at.cmp(&left.requested_at));
    let stored = StoredJobs {
        schema_version: 1,
        jobs: values,
    };
    if let Err(error) = write_json_atomic(&jobs_path(state_dir), &stored, Some(0o600)) {
        warn(&format!(
            "App management job store could not be written: {error}"
        ));
    }
}

fn update_state(outcome: AppUpdateCheckResult) -> ManagedAppUpdateState {
    ManagedAppUpdateState {
        status: outcome.status,
        installed_version: outcome.installed_version,
        latest_version: outcome.latest_version,
        checked_at: now(),
        reason: outcome.reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_protocol::{AppKind, FinalComputerArch, FinalComputerPlatform};

    fn definition(id: &str) -> ManagedAppDefinition {
        ManagedAppDefinition {
            launcher: controlled_instance_protocol::AppCatalogItem {
                id: id.to_string(),
                name: id.to_string(),
                kind: AppKind::Tty,
                description: None,
                command: Some("/bin/sh".to_string()),
                args: None,
                cwd: None,
                env: None,
                display: None,
                default_display_target: None,
                automation: None,
                web: None,
            },
            launchable: true,
            detection: vec![crate::ManagedAppDetectionRule::LauncherExecutable {
                version_args: vec![],
            }],
            recipes: vec![InstallRecipe::Bundled {
                platforms: vec![FinalComputerPlatform::Linux],
                arches: Some(vec![FinalComputerArch::X64]),
                privilege: None,
            }],
        }
    }

    #[test]
    fn logs_are_bounded_and_escape_sequences_are_removed() {
        let mut job = AppManagementJob {
            id: "appjob_0000000000000".to_string(),
            request_id: None,
            app_id: "terminal-tty".to_string(),
            operation: AppManagementOperation::Install,
            state: AppManagementJobState::Running,
            phase: None,
            progress: None,
            command: None,
            log_tail: None,
            log_truncated: None,
            error: None,
            requested_at: now(),
            started_at: None,
            finished_at: None,
            updated_at: now(),
        };
        append_job_log(&mut job, "\u{1b}[31mred\u{1b}[0m\rnext");
        assert_eq!(job.log_tail.as_deref(), Some("red\nnext"));
        append_job_log(&mut job, &"x".repeat(JOB_LOG_LIMIT + 10));
        assert_eq!(
            job.log_tail.as_ref().map(|value| value.chars().count()),
            Some(JOB_LOG_LIMIT)
        );
        assert_eq!(job.log_truncated, Some(true));
    }

    #[test]
    fn no_builtin_definition_is_treated_as_bundled_by_accident() {
        let _ = definition("test");
        let definitions = builtin_managed_app_definitions();
        assert!(definitions.iter().any(|definition| {
            definition.launcher.id == "terminal-tty"
                && matches!(
                    definition.recipes.first(),
                    Some(InstallRecipe::Bundled { .. })
                )
        }));
    }

    #[tokio::test]
    async fn published_snapshots_increment_before_projection() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let events = Arc::new(Mutex::new(Vec::new()));
        let published = events.clone();
        let manager = AppManagementManager::with_parts(
            temporary.path().join("state"),
            temporary.path().join("apps"),
            Arc::new(|| vec![definition("test")]),
            Arc::new(Vec::new),
            Arc::new(move |event| published.lock().expect("events").push(event)),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        );

        let event = manager.publish_snapshot();
        assert_eq!(event.sequence, 1);
        assert_eq!(
            event.snapshot.as_ref().map(|snapshot| snapshot.sequence),
            Some(1)
        );
        assert_eq!(events.lock().expect("events").len(), 1);
    }
}
