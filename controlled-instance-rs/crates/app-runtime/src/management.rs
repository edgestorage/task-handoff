use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chrono::{SecondsFormat, Utc};
use controlled_instance_core::{
    atomic::{read_json, write_json_atomic},
    text::truncate_utf16_tail,
};
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
    detect_managed_app_recipe_target, detect_managed_app_with_managed_root_for_target,
    install_environment::{AppInstallEnvironmentManager, AppInstallExecutionPolicy},
    managed_app_projection, resolve_registry_native_package, select_install_recipe,
    AppRecipeExecutionContext, AppRecipeExecutionError, AppRecipeExecutor, AppRecipeRunner,
    AppUpdateCheckResult, AppUpdateChecker, InstallRecipe, ManagedAppDefinition,
    ManagedAppDetectionResult, ManagedAppOwnershipContext,
};

const ACTIVE_STATES: [AppManagementJobState; 2] = [
    AppManagementJobState::Queued,
    AppManagementJobState::Running,
];
const JOB_LOG_LIMIT: usize = 32_768;
const JOB_FIELDS: [&str; 16] = [
    "id",
    "requestId",
    "installSourceRevision",
    "appId",
    "operation",
    "state",
    "phase",
    "progress",
    "command",
    "logTail",
    "logTruncated",
    "error",
    "requestedAt",
    "startedAt",
    "finishedAt",
    "updatedAt",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppManagementRequestError {
    pub code: String,
    pub message: String,
    pub status_code: u16,
    pub details: Option<Box<Value>>,
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
        self.details = Some(Box::new(details));
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

/// Provider-owned package hooks run under the existing serialized App queue.
/// They must complete before publishing a terminal job or admitting new work.
#[async_trait::async_trait]
pub trait AppPackageLifecycle: Send + Sync {
    async fn before_change(
        &self,
        operation: AppManagementOperation,
    ) -> Result<(), AppRecipeExecutionError>;
    async fn changed(
        &self,
        operation: AppManagementOperation,
        succeeded: bool,
    ) -> Result<(), AppRecipeExecutionError>;
}
type PackageLifecycles = Arc<dyn Fn(&str) -> Option<Arc<dyn AppPackageLifecycle>> + Send + Sync>;

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
    executor: Arc<dyn AppRecipeRunner>,
    update_checker: Arc<AppUpdateChecker>,
    install_environment: Option<AppInstallEnvironmentManager>,
    queue: Arc<tokio::sync::Mutex<()>>,
    package_lifecycles: PackageLifecycles,
}

impl AppManagementManager {
    pub fn with_package_lifecycles(
        mut self,
        hooks: impl Fn(&str) -> Option<Arc<dyn AppPackageLifecycle>> + Send + Sync + 'static,
    ) -> Self {
        self.package_lifecycles = Arc::new(hooks);
        self
    }

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
            None,
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
            None,
        )
    }

    pub fn new_with_runtime_hook_and_install_environment(
        state_dir: impl Into<PathBuf>,
        install_base_dir: impl Into<PathBuf>,
        sessions: impl Fn() -> Vec<AppManagementSession> + Send + Sync + 'static,
        publish: impl Fn(AppManagementEvent) + Send + Sync + 'static,
        runtime_hook: impl Fn(&str) + Send + Sync + 'static,
        install_environment: AppInstallEnvironmentManager,
    ) -> Self {
        Self::with_parts(
            state_dir,
            install_base_dir,
            Arc::new(builtin_managed_app_definitions),
            Arc::new(sessions),
            Arc::new(publish),
            Arc::new(|message| tracing::warn!(message, "app management warning")),
            Arc::new(runtime_hook),
            Some(install_environment),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_parts(
        state_dir: impl Into<PathBuf>,
        install_base_dir: impl Into<PathBuf>,
        definitions: Definitions,
        sessions: Sessions,
        publish: Publisher,
        warn: Warning,
        runtime_hook: RuntimeHook,
        install_environment: Option<AppInstallEnvironmentManager>,
    ) -> Self {
        let state_dir = state_dir.into();
        let install_base_dir = install_base_dir.into();
        if !crate::archive_transaction::recover_all(&state_dir, &install_base_dir).is_empty() {
            warn("Some archive transactions require recovery; affected apps remain unavailable.");
        }
        let jobs = load_jobs(&state_dir, &warn);
        let capabilities = install_environment
            .as_ref()
            .map(|environment| {
                environment.augment_capabilities(detect_final_computer_capabilities_sync())
            })
            .unwrap_or_else(detect_final_computer_capabilities_sync);
        let state = ManagerState {
            jobs,
            capabilities,
            capabilities_observed_at: Instant::now(),
            ownership: BTreeMap::new(),
            update_checks: BTreeMap::new(),
            stream_id: format!("appstream_{}", uuid::Uuid::new_v4().simple()),
            sequence: 0,
        };
        let executor = if let Some(environment) = install_environment.as_ref() {
            AppRecipeExecutor::new(install_base_dir.clone(), state_dir.clone())
                .with_install_environment(environment.clone())
        } else {
            AppRecipeExecutor::new(install_base_dir.clone(), state_dir.clone())
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
            package_lifecycles: Arc::new(|_| None),
            executor: Arc::new(executor),
            update_checker: Arc::new(
                install_environment
                    .as_ref()
                    .map(|environment| {
                        AppUpdateChecker::new()
                            .with_install_environment(state_dir.clone(), environment.clone())
                    })
                    .unwrap_or_default(),
            ),
            install_environment,
            queue: Arc::new(tokio::sync::Mutex::new(())),
        };
        manager.recover_interrupted();
        manager
    }

    pub fn snapshot(&self) -> AppManagementSnapshot {
        let definitions = (self.definitions)();
        let mut state = self.lock();
        snapshot_locked(
            &definitions,
            &mut state,
            &self.install_base_dir,
            &self.state_dir,
            self.install_environment.as_ref(),
        )
    }

    pub async fn refresh_snapshot(&self, force_capabilities: bool) -> AppManagementSnapshot {
        let definitions = (self.definitions)();
        let stale = self.lock().capabilities_observed_at.elapsed() >= Duration::from_secs(10);
        if force_capabilities || stale {
            let capabilities = detect_final_computer_capabilities().await;
            let capabilities = self
                .install_environment
                .as_ref()
                .map(|environment| environment.augment_capabilities(capabilities.clone()))
                .unwrap_or(capabilities);
            let mut state = self.lock();
            state.capabilities = capabilities;
            state.capabilities_observed_at = Instant::now();
        }
        let capabilities = self.lock().capabilities.clone();
        let target = detect_managed_app_recipe_target(capabilities.platform);
        let detections = definitions
            .iter()
            .map(|definition| {
                (
                    definition.clone(),
                    detect_managed_app_with_managed_root_for_target(
                        definition,
                        Some(&self.install_base_dir),
                        capabilities.platform,
                        capabilities.arch,
                        target,
                    ),
                )
            })
            .collect::<Vec<_>>();
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
        snapshot_locked(
            &definitions,
            &mut state,
            &self.install_base_dir,
            &self.state_dir,
            self.install_environment.as_ref(),
        )
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
            let target = detect_managed_app_recipe_target(state.capabilities.platform);
            let detection = detect_managed_app_with_managed_root_for_target(
                &definition,
                Some(&self.install_base_dir),
                state.capabilities.platform,
                state.capabilities.arch,
                target,
            );
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
        let selected_recipe = selected.recipe.as_ref().expect("selected recipe");
        let install_policy = self
            .install_environment
            .as_ref()
            .map(AppInstallEnvironmentManager::create_execution_policy);
        let registry = install_policy
            .as_ref()
            .and_then(|policy| policy.effective.npm_registry.as_deref());
        let outcome = if matches!(selected_recipe, InstallRecipe::RegistryNativePackage { .. }) {
            match resolve_registry_native_package(selected_recipe, &capabilities, registry).await {
                Ok(recipe) => {
                    self.update_checker
                        .check_with_install_root(
                            &recipe,
                            &capabilities,
                            Some((app_id, &self.install_base_dir)),
                        )
                        .await
                }
                Err(error) => AppUpdateCheckResult::new(
                    controlled_instance_protocol::ManagedAppUpdateStatus::Unknown,
                )
                .reason(error.to_string()),
            }
        } else {
            self.update_checker
                .check_with_install_root(
                    selected_recipe,
                    &capabilities,
                    Some((app_id, &self.install_base_dir)),
                )
                .await
        };
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
        // An active job owns its journal until it reaches a terminal state. Only
        // an idle manager may declare the journal unrecoverable.
        let idle = !self
            .lock()
            .jobs
            .values()
            .any(|job| ACTIVE_STATES.contains(&job.state));
        if idle {
            if let Ok(_queue) = self.queue.try_lock() {
                crate::archive_transaction::recover_all(&self.state_dir, &self.install_base_dir);
            }
            if crate::archive_transaction::pending(&self.state_dir, app_id) {
                return Err(AppManagementRequestError::new(
                    "app_recovery_failed",
                    "The prior archive transaction could not be recovered.",
                    409,
                ));
            }
        }
        let request_id = input
            .request_id
            .as_deref()
            .map(normalize_request_id)
            .transpose()?;
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
        if let Some(request_id) = request_id.as_deref() {
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
        let target = detect_managed_app_recipe_target(state.capabilities.platform);
        let detection = detect_managed_app_with_managed_root_for_target(
            &definition,
            Some(&self.install_base_dir),
            state.capabilities.platform,
            state.capabilities.arch,
            target,
        );
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
        let install_policy = self
            .install_environment
            .as_ref()
            .map(AppInstallEnvironmentManager::create_execution_policy);
        let job = AppManagementJob {
            id: mint_entity_id("appjob"),
            request_id,
            install_source_revision: install_policy.as_ref().map(|policy| policy.revision),
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
            manager
                .run_job(job_id, definition, operation, recipe, install_policy)
                .await;
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
        let snapshot = snapshot_locked(
            &definitions,
            &mut state,
            &self.install_base_dir,
            &self.state_dir,
            self.install_environment.as_ref(),
        );
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
        install_policy: Option<AppInstallExecutionPolicy>,
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
        let resolved_recipe = if busy {
            Err(AppRecipeExecutionError::new(
                "app_sessions_running",
                "The app has running sessions and cannot be changed.",
                true,
            ))
        } else if operation != AppManagementOperation::Uninstall
            && matches!(recipe, InstallRecipe::RegistryNativePackage { .. })
        {
            let registry = install_policy
                .as_ref()
                .and_then(|policy| policy.effective.npm_registry.as_deref());
            resolve_registry_native_package(&recipe, &context.capabilities, registry)
                .await
                .map_err(|error| {
                    AppRecipeExecutionError::new(
                        "npm_registry_unavailable",
                        error.to_string(),
                        true,
                    )
                })
        } else {
            Ok(recipe)
        };
        let lifecycle = (self.package_lifecycles)(&definition.launcher.id);
        let result = match resolved_recipe {
            Err(error) => Err(error),
            Ok(recipe) => {
                let preparation = if let Some(hook) = &lifecycle {
                    hook.before_change(operation).await
                } else {
                    Ok(())
                };
                match preparation {
                    Err(error) => Err(error),
                    Ok(()) => {
                        if operation != AppManagementOperation::Install {
                            (self.runtime_hook)(&definition.launcher.id);
                        }
                        self.executor
                            .execute_with_policy(
                                operation,
                                &recipe,
                                &context,
                                install_policy.as_ref(),
                            )
                            .await
                    }
                }
            }
        };
        if result.is_ok() {
            (self.runtime_hook)(&definition.launcher.id);
        }
        // Keep a permit when a fast archive operation finishes before the
        // output task first polls; notify_waiters would lose that wakeup.
        stop_flush.notify_one();
        let _ = flush_task.await;
        let mut terminal = match result {
            Ok(_) => {
                let target = detect_managed_app_recipe_target(context.capabilities.platform);
                let detection = detect_managed_app_with_managed_root_for_target(
                    &definition,
                    Some(&self.install_base_dir),
                    context.capabilities.platform,
                    context.capabilities.arch,
                    target,
                );
                let satisfied = if operation == AppManagementOperation::Uninstall {
                    detection.state == controlled_instance_protocol::ManagedAppState::NotInstalled
                } else {
                    detection.state == controlled_instance_protocol::ManagedAppState::Installed
                };
                if !satisfied {
                    Err(AppRecipeExecutionError::new(
                        "postcondition_failed",
                        format!(
                            "App {} completed but detection did not confirm the required state.",
                            operation_name(operation)
                        ),
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
        if let Some(hook) = &lifecycle {
            let succeeded = terminal.is_ok();
            if let Err(error) = hook.changed(operation, succeeded).await {
                if succeeded {
                    if hook.changed(operation, false).await.is_err() {
                        (self.warn)("App failure cleanup did not complete.");
                    }
                    terminal = Err(error);
                } else {
                    (self.warn)("App failure cleanup did not complete.");
                }
            }
        }
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
            snapshot_locked(
                &definitions,
                state,
                &self.install_base_dir,
                &self.state_dir,
                self.install_environment.as_ref(),
            )
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
    state_dir: &Path,
    install_environment: Option<&AppInstallEnvironmentManager>,
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
        .filter(|definition| !definition.hidden_from_app_management)
        .map(|definition| {
            let target = detect_managed_app_recipe_target(state.capabilities.platform);
            let detection = detect_managed_app_with_managed_root_for_target(
                definition,
                Some(install_base_dir),
                state.capabilities.platform,
                state.capabilities.arch,
                target,
            );
            let detection =
                if crate::archive_transaction::pending(state_dir, &definition.launcher.id) {
                    ManagedAppDetectionResult {
                        state: controlled_instance_protocol::ManagedAppState::Broken,
                        executable_paths: vec![],
                        version: None,
                    }
                } else {
                    detection
                };
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
        install_environment: install_environment.map(AppInstallEnvironmentManager::snapshot),
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
    let truncated = combined.encode_utf16().count() > JOB_LOG_LIMIT;
    job.log_tail = Some(if truncated {
        truncate_utf16_tail(&combined, JOB_LOG_LIMIT)
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

fn normalize_request_id(value: &str) -> Result<String, AppManagementRequestError> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 120
        || !value.starts_with(|character: char| character.is_ascii_alphanumeric())
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-')
        })
    {
        return Err(AppManagementRequestError::new(
            "app_management_input_invalid",
            "requestId is invalid.",
            400,
        ));
    }
    Ok(value.to_string())
}

fn jobs_path(state_dir: &Path) -> PathBuf {
    state_dir.join("jobs.json")
}

fn load_jobs(state_dir: &Path, warn: &Warning) -> BTreeMap<String, AppManagementJob> {
    let path = jobs_path(state_dir);
    let stored = match read_json::<Value>(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return BTreeMap::new(),
        Err(error) => {
            warn(&format!(
                "App management job store could not be read: {error}"
            ));
            return BTreeMap::new();
        }
    };
    let Some(source) = stored.as_object() else {
        return BTreeMap::new();
    };
    if source
        .keys()
        .any(|key| !matches!(key.as_str(), "schemaVersion" | "jobs"))
    {
        warn("App management job store contains unknown top-level fields; they were ignored.");
    }
    let Some(candidates) = source.get("jobs").and_then(Value::as_array) else {
        return BTreeMap::new();
    };
    let mut jobs = BTreeMap::new();
    for candidate in candidates {
        let Some(record) = candidate.as_object() else {
            warn("An invalid app management job was ignored.");
            continue;
        };
        let id = record
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .unwrap_or("unknown");
        if record.keys().any(|key| !JOB_FIELDS.contains(&key.as_str())) {
            warn(&format!(
                "App management job {id} contains unknown fields; they were ignored."
            ));
        }
        let sanitized = JOB_FIELDS
            .iter()
            .filter_map(|field| {
                record
                    .get(*field)
                    .map(|value| ((*field).to_string(), value.clone()))
            })
            .collect::<serde_json::Map<_, _>>();
        let parsed = serde_json::from_value::<AppManagementJob>(Value::Object(sanitized));
        match parsed {
            Ok(job) => {
                jobs.insert(job.id.clone(), job);
            }
            Err(_) => warn(&format!(
                "App management job {id} is invalid and was ignored."
            )),
        }
    }
    jobs
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
    use std::sync::atomic::{AtomicUsize, Ordering};

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
            hidden_from_app_management: false,
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

    struct RetryRecipeRunner {
        executions: Arc<AtomicUsize>,
        install_root: PathBuf,
        state_dir: PathBuf,
    }

    #[async_trait::async_trait]
    impl AppRecipeRunner for RetryRecipeRunner {
        async fn execute_with_policy(
            &self,
            _operation: AppManagementOperation,
            _recipe: &InstallRecipe,
            context: &AppRecipeExecutionContext,
            _frozen_policy: Option<&AppInstallExecutionPolicy>,
        ) -> Result<String, AppRecipeExecutionError> {
            let execution = self.executions.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some(on_phase) = &context.on_phase {
                on_phase("install-package", None);
            }
            if execution == 2 {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let launcher = self.install_root.join("bin/tool");
                    std::fs::create_dir_all(launcher.parent().expect("launcher directory"))
                        .expect("launcher directory");
                    std::fs::write(&launcher, "#!/bin/sh\nexit 0\n").expect("launcher");
                    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700))
                        .expect("launcher permissions");
                    let manifest = self.state_dir.join("manifests/tool.json");
                    std::fs::create_dir_all(manifest.parent().expect("manifest directory"))
                        .expect("manifest directory");
                    std::fs::write(
                        manifest,
                        serde_json::json!({
                            "schemaVersion": 1,
                            "appId": "tool",
                            "installRoot": self.install_root,
                            "files": ["bin/tool"]
                        })
                        .to_string(),
                    )
                    .expect("ownership manifest");
                }
            }
            Ok(String::new())
        }
    }

    struct UpdateRetryRecipeRunner {
        executions: Arc<AtomicUsize>,
        launcher: PathBuf,
    }

    #[async_trait::async_trait]
    impl AppRecipeRunner for UpdateRetryRecipeRunner {
        async fn execute_with_policy(
            &self,
            _operation: AppManagementOperation,
            _recipe: &InstallRecipe,
            context: &AppRecipeExecutionContext,
            _frozen_policy: Option<&AppInstallExecutionPolicy>,
        ) -> Result<String, AppRecipeExecutionError> {
            let execution = self.executions.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some(on_phase) = &context.on_phase {
                on_phase("update-package", None);
            }
            if execution == 1 {
                return Err(AppRecipeExecutionError::new(
                    "update_failed",
                    "simulated update failure",
                    true,
                ));
            }
            std::fs::write(&self.launcher, "#!/bin/sh\necho 2.0.0\n").expect("updated launcher");
            Ok(String::new())
        }
    }

    struct TerminalLifecycle {
        name: String,
        order: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait::async_trait]
    impl AppPackageLifecycle for TerminalLifecycle {
        async fn before_change(
            &self,
            _: AppManagementOperation,
        ) -> Result<(), AppRecipeExecutionError> {
            self.order.lock().unwrap().push("drain".to_string());
            if matches!(self.name.as_str(), "drain-failure" | "rollback-failure") {
                return Err(AppRecipeExecutionError::new(
                    "drain_failed",
                    "simulated drain failure",
                    true,
                ));
            }
            Ok(())
        }

        async fn changed(
            &self,
            _: AppManagementOperation,
            succeeded: bool,
        ) -> Result<(), AppRecipeExecutionError> {
            self.order
                .lock()
                .unwrap()
                .push(format!("cleanup:{succeeded}"));
            if matches!(self.name.as_str(), "cleanup-failure" | "rollback-failure") {
                return Err(AppRecipeExecutionError::new(
                    "cleanup_failed",
                    "simulated cleanup failure",
                    false,
                ));
            }
            Ok(())
        }
    }

    struct TerminalRecipeRunner {
        state_dir: PathBuf,
        install_base_dir: PathBuf,
        order: Arc<Mutex<Vec<String>>>,
        executions: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl AppRecipeRunner for TerminalRecipeRunner {
        async fn execute_with_policy(
            &self,
            _: AppManagementOperation,
            _: &InstallRecipe,
            _: &AppRecipeExecutionContext,
            _: Option<&AppInstallExecutionPolicy>,
        ) -> Result<String, AppRecipeExecutionError> {
            self.order.lock().unwrap().push("execute".to_string());
            self.executions.fetch_add(1, Ordering::SeqCst);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;

                let launcher = self.install_base_dir.join("tool/bin/tool");
                std::fs::create_dir_all(launcher.parent().expect("launcher directory"))
                    .expect("launcher directory");
                std::fs::write(&launcher, "#!/bin/sh\nexit 0\n").expect("launcher");
                std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700))
                    .expect("launcher permissions");
                let manifest = self.state_dir.join("manifests/tool.json");
                std::fs::create_dir_all(manifest.parent().expect("manifest directory"))
                    .expect("manifest directory");
                std::fs::write(
                    manifest,
                    serde_json::json!({
                        "schemaVersion": 1,
                        "appId": "tool",
                        "installRoot": self.install_base_dir.join("tool"),
                        "files": ["bin/tool"]
                    })
                    .to_string(),
                )
                .expect("ownership manifest");
            }
            Ok(String::new())
        }
    }

    fn terminal_lifecycle_definition() -> ManagedAppDefinition {
        let mut app = definition("tool");
        app.launcher.command = Some("bin/tool".to_string());
        app.recipes = vec![InstallRecipe::Archive {
            platforms: vec![
                FinalComputerPlatform::Linux,
                FinalComputerPlatform::Darwin,
                FinalComputerPlatform::Win32,
                FinalComputerPlatform::Freebsd,
                FinalComputerPlatform::Openbsd,
                FinalComputerPlatform::Aix,
                FinalComputerPlatform::Sunos,
            ],
            arches: None,
            privilege: Some(controlled_instance_protocol::AppInstallPrivilege::User),
            url: "https://example.invalid/tool.tar.gz".to_string(),
            sha256: "0".repeat(64),
            format: "tar.gz".to_string(),
            install_root: "tool".to_string(),
        }];
        app
    }

    fn terminal_lifecycle_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../instance/tests/fixtures/app-management-terminal-parity.json"
        ))
        .expect("Node terminal fixture")
    }

    async fn observe_terminal_lifecycle(name: &'static str) -> Value {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let state_dir = temporary.path().join("state");
        let install_base_dir = temporary.path().join("apps");
        let app = terminal_lifecycle_definition();
        let order = Arc::new(Mutex::new(Vec::new()));
        let publish_order = order.clone();
        let executions = Arc::new(AtomicUsize::new(0));
        let event_states = Arc::new(Mutex::new(Vec::new()));
        let published_states = event_states.clone();
        let warnings = Arc::new(Mutex::new(Vec::new()));
        let published_warnings = warnings.clone();
        let manager = AppManagementManager::with_parts(
            state_dir.clone(),
            install_base_dir.clone(),
            Arc::new(move || vec![app.clone()]),
            Arc::new(Vec::new),
            Arc::new(move |event| {
                let Some(job) = event.job else {
                    return;
                };
                let state = serde_json::to_value(job.state).expect("job state");
                let state = state.as_str().expect("state string").to_string();
                publish_order.lock().unwrap().push(format!("event:{state}"));
                if !job.state.is_active() {
                    published_states.lock().unwrap().push(state.clone());
                    publish_order
                        .lock()
                        .unwrap()
                        .push(format!("notify:{state}"));
                }
            }),
            Arc::new(move |message| {
                published_warnings.lock().unwrap().push(message.to_string());
            }),
            Arc::new(|_| {}),
            None,
        )
        .with_package_lifecycles({
            let order = order.clone();
            move |_| {
                Some(Arc::new(TerminalLifecycle {
                    name: name.to_string(),
                    order: order.clone(),
                }) as Arc<dyn AppPackageLifecycle>)
            }
        });
        let mut manager = manager;
        manager.executor = Arc::new(TerminalRecipeRunner {
            state_dir: state_dir.clone(),
            install_base_dir: install_base_dir.clone(),
            order: order.clone(),
            executions: executions.clone(),
        });
        let queued = manager
            .request(
                "tool",
                AppManagementOperation::Install,
                AppManagementOperationRequest { request_id: None },
            )
            .await
            .expect("terminal lifecycle request");
        let terminal = wait_for_terminal(&manager, &queued.id).await;
        let reopen_app = terminal_lifecycle_definition();
        let reopened = AppManagementManager::with_parts(
            state_dir,
            install_base_dir,
            Arc::new(move || vec![reopen_app.clone()]),
            Arc::new(Vec::new),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
            None,
        );
        reopened.refresh_snapshot(false).await;
        let reopened_job = job_projection(&reopened.get_job(&queued.id).expect("reopened job"));
        let reopened_app = app_projection_complete(&reopened);
        let job_value = job_projection(&terminal);
        let app_value = app_projection_complete(&manager);
        let order_value = order.lock().unwrap().clone();
        let event_states_value = event_states.lock().unwrap().clone();
        let executions_value = executions.load(Ordering::SeqCst);
        let warnings_value = warnings.lock().unwrap().clone();
        let reopened_value = json!({
            "job": reopened_job,
            "app": reopened_app,
        });
        json!({
            "name": name,
            "job": job_value,
            "app": app_value,
            "order": order_value,
            "eventStates": event_states_value,
            "executions": executions_value,
            "warnings": warnings_value,
            "reopened": reopened_value,
        })
    }

    #[tokio::test]
    async fn terminal_lifecycle_matches_node_fixture() {
        let fixture = terminal_lifecycle_fixture();
        for scenario in fixture["scenarios"].as_array().expect("scenarios") {
            let name = scenario["name"].as_str().expect("scenario name");
            let actual = observe_terminal_lifecycle(match name {
                "success" => "success",
                "drain-failure" => "drain-failure",
                "cleanup-failure" => "cleanup-failure",
                "rollback-failure" => "rollback-failure",
                other => panic!("unknown scenario {other}"),
            })
            .await;
            assert_eq!(actual, scenario["expected"], "{name}");
        }
    }

    async fn wait_for_terminal(manager: &AppManagementManager, job_id: &str) -> AppManagementJob {
        for _ in 0..500 {
            let job = manager.get_job(job_id).expect("job");
            if !job.state.is_active() {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("job {job_id} did not reach a terminal state");
    }

    fn job_projection(job: &AppManagementJob) -> Value {
        serde_json::json!({
            "operation": job.operation,
            "state": job.state,
            "phase": job.phase,
            "hasStartedAt": job.started_at.is_some(),
            "hasFinishedAt": job.finished_at.is_some(),
            "error": job.error,
        })
    }

    fn app_projection(manager: &AppManagementManager) -> Value {
        let app = manager.snapshot().apps.into_iter().next().expect("app");
        serde_json::json!({
            "state": app.state,
            "managementSource": app.management_source,
            "canInstall": app.can_install,
            "canUninstall": app.can_uninstall,
            "canUpdate": app.can_update.unwrap_or(false),
            "installReason": app.install_reason.map(|reason| reason.code),
            "updateReason": app.update_reason.map(|reason| reason.code),
        })
    }

    fn app_projection_complete(manager: &AppManagementManager) -> Value {
        let app = manager.snapshot().apps.into_iter().next().expect("app");
        serde_json::json!({
            "state": app.state,
            "managementSource": app.management_source,
            "canInstall": app.can_install,
            "canUninstall": app.can_uninstall,
            "canUpdate": app.can_update.unwrap_or(false),
            "installReason": app.install_reason.map(|reason| reason.code),
            "uninstallReason": app.uninstall_reason.map(|reason| reason.code),
            "updateReason": app.update_reason.map(|reason| reason.code),
        })
    }

    fn archive_manifest_projection(state_dir: &Path) -> Value {
        let path = state_dir.join("manifests/tool.json");
        let Ok(raw) = std::fs::read_to_string(path) else {
            return Value::Null;
        };
        let manifest: Value = serde_json::from_str(&raw).expect("archive manifest");
        serde_json::json!({
            "schemaVersion": manifest["schemaVersion"],
            "appId": manifest["appId"],
            "files": manifest["files"],
        })
    }

    #[cfg(unix)]
    fn archive_tree(root: &Path) -> Value {
        use std::os::unix::fs::PermissionsExt;

        fn visit(root: &Path, current: &Path, files: &mut Vec<Value>) {
            let mut entries = std::fs::read_dir(current)
                .expect("archive directory")
                .collect::<Result<Vec<_>, _>>()
                .expect("archive entries");
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let absolute = entry.path();
                let relative = absolute
                    .strip_prefix(root)
                    .expect("relative archive path")
                    .to_string_lossy()
                    .replace('\\', "/");
                let metadata = std::fs::symlink_metadata(&absolute).expect("archive metadata");
                if metadata.is_dir() {
                    visit(root, &absolute, files);
                } else if metadata.is_file() {
                    files.push(serde_json::json!({
                        "path": relative,
                        "contents": std::fs::read_to_string(&absolute).expect("archive contents"),
                        "executable": metadata.permissions().mode() & 0o111 != 0,
                    }));
                } else {
                    files.push(serde_json::json!({
                        "path": relative,
                        "kind": if metadata.file_type().is_symlink() { "other:symlink" } else { "other:unknown" },
                        "executable": false,
                    }));
                }
            }
        }

        if !root.exists() {
            return serde_json::json!([]);
        }
        let mut files = Vec::new();
        visit(root, root, &mut files);
        files.sort_by(|left, right| {
            left["path"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["path"].as_str().unwrap_or_default())
        });
        Value::Array(files)
    }

    fn archive_lifecycle_definition(
        artifact: &[u8],
        capabilities: &FinalComputerCapabilities,
    ) -> ManagedAppDefinition {
        use sha2::{Digest, Sha256};

        let mut app = definition("tool");
        app.launcher.command = Some("bin/tool".to_string());
        app.recipes = vec![InstallRecipe::Archive {
            platforms: vec![capabilities.platform],
            arches: Some(vec![capabilities.arch]),
            privilege: Some(controlled_instance_protocol::AppInstallPrivilege::User),
            url: "https://fixtures.invalid/tool.tar.gz".to_string(),
            sha256: hex::encode(Sha256::digest(artifact)),
            format: "tar.gz".to_string(),
            install_root: "tool".to_string(),
        }];
        app
    }

    struct ArchiveFixtureRunner {
        install_base_dir: PathBuf,
        state_dir: PathBuf,
        artifact: Arc<Mutex<Vec<u8>>>,
    }

    #[async_trait::async_trait]
    impl AppRecipeRunner for ArchiveFixtureRunner {
        async fn execute_with_policy(
            &self,
            operation: AppManagementOperation,
            recipe: &InstallRecipe,
            context: &AppRecipeExecutionContext,
            frozen_policy: Option<&AppInstallExecutionPolicy>,
        ) -> Result<String, AppRecipeExecutionError> {
            let executor = AppRecipeExecutor::new(&self.install_base_dir, &self.state_dir)
                .with_archive_fixture(self.artifact.lock().expect("archive fixture").clone());
            executor
                .execute_with_policy(operation, recipe, context, frozen_policy)
                .await
        }
    }

    fn archive_lifecycle_manager(
        state_dir: &Path,
        install_base_dir: &Path,
        capabilities: FinalComputerCapabilities,
        selected: Arc<Mutex<Vec<u8>>>,
        device: Arc<Mutex<Vec<u8>>>,
        event_states: Option<Arc<Mutex<Vec<String>>>>,
    ) -> AppManagementManager {
        let definitions = {
            let selected = selected.clone();
            let capabilities = capabilities.clone();
            Arc::new(move || {
                vec![archive_lifecycle_definition(
                    &selected.lock().expect("selected archive"),
                    &capabilities,
                )]
            })
        };
        let published = event_states;
        let mut manager = AppManagementManager::with_parts(
            state_dir.to_path_buf(),
            install_base_dir.to_path_buf(),
            definitions,
            Arc::new(Vec::new),
            Arc::new(move |event| {
                if let (Some(states), Some(job)) = (&published, event.job) {
                    let state = serde_json::to_value(job.state).expect("job state");
                    states
                        .lock()
                        .expect("event states")
                        .push(state.as_str().expect("state string").to_string());
                }
            }),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
            None,
        );
        manager.executor = Arc::new(ArchiveFixtureRunner {
            install_base_dir: install_base_dir.to_path_buf(),
            state_dir: state_dir.to_path_buf(),
            artifact: device,
        });
        manager
    }

    #[cfg(unix)]
    async fn archive_lifecycle_step(
        manager: &AppManagementManager,
        state_dir: &Path,
        install_root: &Path,
        name: &str,
        operation: AppManagementOperation,
        job_ids: &mut Vec<String>,
    ) -> Value {
        let queued = manager
            .request(
                "tool",
                operation,
                AppManagementOperationRequest { request_id: None },
            )
            .await
            .expect("archive lifecycle request");
        let terminal = wait_for_terminal(manager, &queued.id).await;
        job_ids.push(terminal.id.clone());
        serde_json::json!({
            "name": name,
            "job": job_projection(&terminal),
            "app": app_projection_complete(manager),
            "tree": archive_tree(install_root),
            "manifest": archive_manifest_projection(state_dir),
        })
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn postcondition_failure_then_retry_matches_node_fixture() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let state_dir = temporary.path().join("state");
        let install_base_dir = temporary.path().join("apps");
        let install_root = install_base_dir.join("tool");
        let launcher = install_root.join("bin/tool");
        let manifest = state_dir.join("manifests/tool.json");
        let mut app = definition("tool");
        app.launcher.command = Some("bin/tool".to_string());
        app.recipes = vec![InstallRecipe::Archive {
            platforms: vec![
                FinalComputerPlatform::Linux,
                FinalComputerPlatform::Darwin,
                FinalComputerPlatform::Win32,
                FinalComputerPlatform::Freebsd,
                FinalComputerPlatform::Openbsd,
                FinalComputerPlatform::Aix,
                FinalComputerPlatform::Sunos,
            ],
            arches: None,
            privilege: Some(controlled_instance_protocol::AppInstallPrivilege::User),
            url: "https://example.invalid/tool.tar.gz".to_string(),
            sha256: "0".repeat(64),
            format: "tar.gz".to_string(),
            install_root: "tool".to_string(),
        }];
        let executions = Arc::new(AtomicUsize::new(0));
        let event_states = Arc::new(Mutex::new(Vec::new()));
        let published = event_states.clone();
        let mut manager = AppManagementManager::with_parts(
            state_dir.clone(),
            install_base_dir,
            Arc::new(move || vec![app.clone()]),
            Arc::new(Vec::new),
            Arc::new(move |event| {
                if let Some(job) = event.job {
                    let state = serde_json::to_value(job.state).expect("job state");
                    published
                        .lock()
                        .expect("event states")
                        .push(state.as_str().expect("state string").to_string());
                }
            }),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
            None,
        );
        manager.executor = Arc::new(RetryRecipeRunner {
            executions: executions.clone(),
            install_root: install_root.clone(),
            state_dir,
        });

        let first = manager
            .request(
                "tool",
                AppManagementOperation::Install,
                AppManagementOperationRequest { request_id: None },
            )
            .await
            .expect("first request");
        let first = wait_for_terminal(&manager, &first.id).await;
        let first_step = serde_json::json!({
            "name": "first-install",
            "job": job_projection(&first),
            "app": app_projection(&manager),
            "executions": executions.load(Ordering::SeqCst),
            "launcherExists": launcher.exists(),
            "manifestExists": manifest.exists(),
        });

        let second = manager
            .request(
                "tool",
                AppManagementOperation::Install,
                AppManagementOperationRequest { request_id: None },
            )
            .await
            .expect("retry request");
        let second = wait_for_terminal(&manager, &second.id).await;
        assert_ne!(first.id, second.id);
        let actual = serde_json::json!({
            "scenario": "postcondition-failure-then-retry",
            "steps": [
                first_step,
                {
                    "name": "retry-install",
                    "job": job_projection(&second),
                    "app": app_projection(&manager),
                    "executions": executions.load(Ordering::SeqCst),
                    "launcherExists": launcher.exists(),
                    "manifestExists": manifest.exists(),
                }
            ],
            "jobIdsDiffer": true,
            "eventStates": *event_states.lock().expect("event states"),
        });
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../instance/tests/fixtures/app-management-retry-parity.json"
            ))
            .expect("fixture"),
        )
        .expect("fixture json");
        assert_eq!(actual, expected);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_failure_then_retry_matches_node_fixture() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().expect("temporary directory");
        let state_dir = temporary.path().join("state");
        let install_base_dir = temporary.path().join("apps");
        let install_root = install_base_dir.join("tool");
        let launcher = install_root.join("bin/tool");
        let manifest = state_dir.join("manifests/tool.json");
        std::fs::create_dir_all(launcher.parent().expect("launcher directory"))
            .expect("launcher directory");
        std::fs::create_dir_all(manifest.parent().expect("manifest directory"))
            .expect("manifest directory");
        std::fs::write(&launcher, "#!/bin/sh\necho 1.0.0\n").expect("launcher");
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700))
            .expect("launcher permissions");
        std::fs::write(
            &manifest,
            serde_json::json!({
                "schemaVersion": 1,
                "appId": "tool",
                "installRoot": install_root,
                "files": ["bin/tool"]
            })
            .to_string(),
        )
        .expect("ownership manifest");
        let mut app = definition("tool");
        app.launcher.command = Some("bin/tool".to_string());
        app.recipes = vec![InstallRecipe::Archive {
            platforms: vec![
                FinalComputerPlatform::Linux,
                FinalComputerPlatform::Darwin,
                FinalComputerPlatform::Win32,
                FinalComputerPlatform::Freebsd,
                FinalComputerPlatform::Openbsd,
                FinalComputerPlatform::Aix,
                FinalComputerPlatform::Sunos,
            ],
            arches: None,
            privilege: Some(controlled_instance_protocol::AppInstallPrivilege::User),
            url: "https://example.invalid/tool.tar.gz".to_string(),
            sha256: "0".repeat(64),
            format: "tar.gz".to_string(),
            install_root: "tool".to_string(),
        }];
        let executions = Arc::new(AtomicUsize::new(0));
        let event_states = Arc::new(Mutex::new(Vec::new()));
        let published = event_states.clone();
        let mut manager = AppManagementManager::with_parts(
            state_dir,
            install_base_dir,
            Arc::new(move || vec![app.clone()]),
            Arc::new(Vec::new),
            Arc::new(move |event| {
                if let Some(job) = event.job {
                    let state = serde_json::to_value(job.state).expect("job state");
                    published
                        .lock()
                        .expect("event states")
                        .push(state.as_str().expect("state string").to_string());
                }
            }),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
            None,
        );
        manager.executor = Arc::new(UpdateRetryRecipeRunner {
            executions: executions.clone(),
            launcher: launcher.clone(),
        });

        manager.refresh_snapshot(false).await;
        let initial = serde_json::json!({
            "app": app_projection(&manager),
            "launcherContents": std::fs::read_to_string(&launcher).expect("initial launcher"),
        });
        let first = manager
            .request(
                "tool",
                AppManagementOperation::Update,
                AppManagementOperationRequest { request_id: None },
            )
            .await
            .expect("first update");
        let first = wait_for_terminal(&manager, &first.id).await;
        let first_step = serde_json::json!({
            "name": "first-update",
            "job": job_projection(&first),
            "app": app_projection(&manager),
            "executions": executions.load(Ordering::SeqCst),
            "launcherContents": std::fs::read_to_string(&launcher).expect("failed launcher"),
            "manifestExists": manifest.exists(),
        });
        let second = manager
            .request(
                "tool",
                AppManagementOperation::Update,
                AppManagementOperationRequest { request_id: None },
            )
            .await
            .expect("retry update");
        let second = wait_for_terminal(&manager, &second.id).await;
        assert_ne!(first.id, second.id);
        let actual = serde_json::json!({
            "scenario": "update-failure-then-retry",
            "initial": initial,
            "steps": [
                first_step,
                {
                    "name": "retry-update",
                    "job": job_projection(&second),
                    "app": app_projection(&manager),
                    "executions": executions.load(Ordering::SeqCst),
                    "launcherContents": std::fs::read_to_string(&launcher).expect("updated launcher"),
                    "manifestExists": manifest.exists(),
                }
            ],
            "jobIdsDiffer": true,
            "eventStates": *event_states.lock().expect("event states"),
        });
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../instance/tests/fixtures/app-management-update-retry-parity.json"
            ))
            .expect("fixture"),
        )
        .expect("fixture json");
        assert_eq!(actual, expected);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn archive_install_update_failure_uninstall_reinstall_matches_node_fixture() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let fixture: Value = serde_json::from_str(include_str!(
            "../../instance/tests/fixtures/archive-lifecycle-parity.json"
        ))
        .expect("archive lifecycle fixture");
        let first = STANDARD
            .decode(fixture["artifacts"]["v1"].as_str().expect("v1 artifact"))
            .expect("v1 archive");
        let next = STANDARD
            .decode(fixture["artifacts"]["v2"].as_str().expect("v2 artifact"))
            .expect("v2 archive");
        let temporary = tempfile::tempdir().expect("temporary directory");
        let state_dir = temporary.path().join("state");
        let install_base_dir = temporary.path().join("apps");
        let install_root = install_base_dir.join("tool");
        let selected = Arc::new(Mutex::new(first.clone()));
        let device = Arc::new(Mutex::new(first.clone()));
        let event_states = Arc::new(Mutex::new(Vec::new()));
        let capabilities = crate::detect_final_computer_capabilities_sync();
        let manager = archive_lifecycle_manager(
            &state_dir,
            &install_base_dir,
            capabilities,
            selected.clone(),
            device.clone(),
            Some(event_states.clone()),
        );
        manager.refresh_snapshot(false).await;
        let mut job_ids = Vec::new();
        let mut steps = vec![
            archive_lifecycle_step(
                &manager,
                &state_dir,
                &install_root,
                "install-v1",
                AppManagementOperation::Install,
                &mut job_ids,
            )
            .await,
        ];

        std::fs::write(install_root.join("user-config.json"), "{}\n").expect("user config");
        *device.lock().expect("device archive") = next.clone();
        steps.push(
            archive_lifecycle_step(
                &manager,
                &state_dir,
                &install_root,
                "failed-update-to-v2",
                AppManagementOperation::Update,
                &mut job_ids,
            )
            .await,
        );
        *device.lock().expect("device archive") = first.clone();
        steps.push(
            archive_lifecycle_step(
                &manager,
                &state_dir,
                &install_root,
                "uninstall-v1",
                AppManagementOperation::Uninstall,
                &mut job_ids,
            )
            .await,
        );
        *selected.lock().expect("selected archive") = next.clone();
        *device.lock().expect("device archive") = next.clone();
        steps.push(
            archive_lifecycle_step(
                &manager,
                &state_dir,
                &install_root,
                "reinstall-v2",
                AppManagementOperation::Install,
                &mut job_ids,
            )
            .await,
        );

        let restarted = archive_lifecycle_manager(
            &state_dir,
            &install_base_dir,
            crate::detect_final_computer_capabilities_sync(),
            selected,
            device,
            None,
        );
        restarted.refresh_snapshot(false).await;
        let mut recent_jobs = restarted
            .snapshot()
            .recent_jobs
            .into_iter()
            .map(|job| {
                serde_json::json!({
                    "operation": job.operation,
                    "state": job.state,
                    "phase": job.phase,
                    "error": job.error.map(|error| error.code),
                })
            })
            .collect::<Vec<_>>();
        recent_jobs.sort_by_key(|job| {
            format!(
                "{}:{}:{}:{}",
                job["operation"].as_str().unwrap_or_default(),
                job["state"].as_str().unwrap_or_default(),
                job["phase"].as_str().unwrap_or_default(),
                job["error"].as_str().unwrap_or_default(),
            )
        });
        let job_ids_distinct = job_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == job_ids.len();
        let event_states = event_states.lock().expect("event states").clone();
        let actual = serde_json::json!({
            "scenario": "archive-install-update-failure-uninstall-reinstall",
            "artifacts": {
                "v1": STANDARD.encode(&first),
                "v2": STANDARD.encode(&next),
            },
            "steps": steps,
            "jobIdsDistinct": job_ids_distinct,
            "eventStates": event_states,
            "restart": {
                "app": app_projection_complete(&restarted),
                "tree": archive_tree(&install_root),
                "manifest": archive_manifest_projection(&state_dir),
                "recentJobs": recent_jobs,
            },
        });
        let persisted: Value = serde_json::from_str(
            &std::fs::read_to_string(state_dir.join("manifests/tool.json"))
                .expect("restarted ownership manifest"),
        )
        .expect("restarted manifest JSON");
        assert_eq!(
            persisted["installRoot"],
            serde_json::json!(install_root.to_string_lossy())
        );
        assert_eq!(actual, fixture);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn archive_uninstall_queue_runs_drain_and_clear_before_terminal_and_preserves_user_files()
    {
        use std::os::unix::fs::PermissionsExt;
        struct Lifecycle {
            root: PathBuf,
            phases: Arc<Mutex<Vec<&'static str>>>,
        }
        #[async_trait::async_trait]
        impl AppPackageLifecycle for Lifecycle {
            async fn before_change(
                &self,
                _: AppManagementOperation,
            ) -> Result<(), AppRecipeExecutionError> {
                assert!(self.root.join("bin/tool").exists());
                self.phases.lock().unwrap().push("drained");
                Ok(())
            }
            async fn changed(
                &self,
                _: AppManagementOperation,
                succeeded: bool,
            ) -> Result<(), AppRecipeExecutionError> {
                if succeeded {
                    assert!(!self.root.join("bin/tool").exists());
                }
                self.phases.lock().unwrap().push("cleared");
                Ok(())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let base = dir.path().join("apps");
        let root = base.join("tool");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(state.join("manifests")).unwrap();
        std::fs::write(root.join("bin/tool"), "#!/bin/sh\necho 1\n").unwrap();
        std::fs::set_permissions(
            root.join("bin/tool"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        std::fs::write(root.join("user"), "preserved").unwrap();
        std::fs::write(
            state.join("manifests/tool.json"),
            serde_json::json!({
                "schemaVersion":1,"appId":"tool","installRoot":root,"files":["bin/tool"]
            })
            .to_string(),
        )
        .unwrap();
        let mut app = definition("tool");
        app.launcher.command = Some("bin/tool".into());
        app.detection = vec![crate::ManagedAppDetectionRule::LauncherExecutable {
            version_args: vec!["--version".into()],
        }];
        let capabilities = detect_final_computer_capabilities_sync();
        app.recipes = vec![InstallRecipe::ArchiveOwnership {
            platforms: vec![capabilities.platform],
            arches: Some(vec![capabilities.arch]),
            privilege: Some(controlled_instance_protocol::AppInstallPrivilege::User),
            install_root: "tool".into(),
        }];
        let phases = Arc::new(Mutex::new(Vec::new()));
        let published = phases.clone();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let hook: Arc<dyn AppPackageLifecycle> = Arc::new(Lifecycle {
            root: root.clone(),
            phases: phases.clone(),
        });
        let manager = AppManagementManager::with_parts(
            state.clone(),
            base,
            Arc::new(move || vec![app.clone()]),
            Arc::new(Vec::new),
            Arc::new(move |event| {
                if let Some(job) = event.job {
                    if !matches!(
                        job.state,
                        AppManagementJobState::Queued | AppManagementJobState::Running
                    ) {
                        assert_eq!(*published.lock().unwrap(), vec!["drained", "cleared"]);
                        let _ = tx.send(job);
                    }
                }
            }),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
            None,
        )
        .with_package_lifecycles(move |_| Some(hook.clone()));
        let snapshot = manager.refresh_snapshot(false).await;
        assert!(snapshot.apps[0].can_uninstall);
        assert_eq!(snapshot.apps[0].can_update, Some(false));
        manager
            .request(
                "tool",
                AppManagementOperation::Uninstall,
                AppManagementOperationRequest { request_id: None },
            )
            .await
            .unwrap();
        let job = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            job.state,
            AppManagementJobState::Succeeded,
            "{:?}",
            job.error
        );
        assert!(!state.join("manifests/tool.json").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("user")).unwrap(),
            "preserved"
        );
    }
    #[test]
    fn logs_are_bounded_and_escape_sequences_are_removed() {
        let mut job = AppManagementJob {
            id: "appjob_0000000000000".to_string(),
            request_id: None,
            install_source_revision: None,
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

    #[test]
    fn hidden_builtin_apps_are_omitted_from_management_snapshots() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let claude = crate::find_builtin_managed_app("claude").expect("claude");
        let manager = AppManagementManager::with_parts(
            temporary.path().join("state"),
            temporary.path().join("apps"),
            Arc::new(move || vec![claude.clone()]),
            Arc::new(Vec::new),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
            None,
        );

        assert!(manager.snapshot().apps.is_empty());
    }

    #[test]
    fn request_ids_use_the_node_trimmed_wire_contract() {
        assert_eq!(
            normalize_request_id("  Install-1.v2:retry  ").expect("valid request id"),
            "Install-1.v2:retry"
        );
        for invalid in ["", " ", "-leading", "contains space", &"a".repeat(121)] {
            let error = normalize_request_id(invalid).expect_err("invalid request id");
            assert_eq!(error.code, "app_management_input_invalid");
        }
    }

    #[test]
    fn job_store_sanitizes_each_entry_and_keeps_valid_jobs() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let valid = serde_json::json!({
            "id": "appjob_valid_00000000000",
            "appId": "terminal-tty",
            "operation": "install",
            "state": "running",
            "requestedAt": "2026-11-03T00:00:00.000Z",
            "updatedAt": "2026-11-03T00:00:01.000Z"
        });
        let unknown_field = serde_json::json!({
            "id": "appjob_unknown_00000000",
            "appId": "terminal-tty",
            "operation": "install",
            "state": "queued",
            "requestedAt": "2026-11-03T00:00:00.000Z",
            "updatedAt": "2026-11-03T00:00:00.000Z",
            "ignoredField": true
        });
        let invalid = serde_json::json!({
            "id": "appjob_invalid_00000000",
            "appId": "terminal-tty",
            "operation": "install",
            "state": "finished",
            "requestedAt": "2026-11-03T00:00:00.000Z",
            "updatedAt": "2026-11-03T00:00:00.000Z"
        });
        std::fs::write(
            jobs_path(temporary.path()),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 2,
                "ignoredTopLevelField": true,
                "jobs": [valid, unknown_field, invalid, 7]
            }))
            .expect("jobs json"),
        )
        .expect("jobs file");
        let warnings = Arc::new(Mutex::new(Vec::new()));
        let collected = warnings.clone();
        let warn: Warning = Arc::new(move |message| {
            collected
                .lock()
                .expect("warnings")
                .push(message.to_string());
        });

        let jobs = load_jobs(temporary.path(), &warn);

        assert_eq!(
            jobs.keys().cloned().collect::<Vec<_>>(),
            vec![
                "appjob_unknown_00000000".to_string(),
                "appjob_valid_00000000000".to_string()
            ]
        );
        let warnings = warnings.lock().expect("warnings").join("\n");
        assert!(warnings.contains("unknown top-level fields"));
        assert!(warnings.contains("appjob_unknown_00000000 contains unknown fields"));
        assert!(warnings.contains("appjob_invalid_00000000 is invalid"));
        assert!(warnings.contains("An invalid app management job was ignored."));
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
            None,
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
