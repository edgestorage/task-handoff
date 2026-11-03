use chrono::{SecondsFormat, Utc};
use controlled_instance_ai_session::{
    AiSession, AiSessionAttachmentDraftStreams, AiSessionController,
    AiSessionConversationAttachmentStore, AiSessionHistoryStore, AiSessionModelSelection,
    AiSessionPersistenceSettingsStore, AiSessionRuntime, AiSessionTimelineStore,
    ClaudeControlClient, ClaudeControlSockProvider, CodexAppServerClient, CodexAppServerProvider,
    CodexAppServerTarget, CodexAppServerTargetResolver, OpenCodeConnection,
    OpenCodeConnectionProvider, OpenCodeSessionProvider, ProviderError, ProviderEvent,
};
use controlled_instance_app_runtime::{
    AppManagementManager, AppManagementSession, AppRuntime, AppRuntimeError,
};
use controlled_instance_core::process::process_start_identity;
use controlled_instance_protocol::{
    project_ai_sessions_snapshot_for_consumer, AiSessionHistoryItem, AiSessionsSnapshot,
    AiSessionsState, AppCounts, ControlledInstanceCapabilities, EventEnvelope,
    InstanceStatusSnapshot, WorkspaceGitStatus, WorkspaceStatus, WorkspaceStorageStatus,
};
use controlled_instance_workspace::{
    triggers::{local_instance_id, TriggerExecutor, TriggerManager, TriggerStore},
    ConfigSyncEnvironment, RepositoryService,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

use crate::{
    agent_run_bindings::AgentRunMemberBindingStore,
    ai_session_authority::AiSessionAuthority,
    ai_session_delta_coalescer::{AiSessionDeltaCoalescer, AiSessionDeltaKey, FlushReason},
    ai_session_hierarchy::{
        derive_retention_candidates, derive_subtree, AiSessionHierarchyRecord,
        AiSessionRetentionCandidate,
    },
    app_session_authority::AppSessionAuthority,
    auth::WebAuthState,
    codex_discovery::{
        app_thread_bindings, merge_codex_session, project_new_codex_session,
        recoverable_session_threads,
    },
    config::InstanceConfig,
    events::EventBus,
    instance_shell::InstanceShellRuntime,
    node_agent_client::NodeAgentClient,
    private_model::ControlledModelConfig,
    story_tools::StoryToolService,
};

#[derive(Clone)]
struct AppRuntimeOpenCodeConnectionProvider {
    app_runtime: Arc<AppRuntime>,
    repository_service: RepositoryService,
    fallback_root: PathBuf,
}

#[async_trait::async_trait]
impl OpenCodeConnectionProvider for AppRuntimeOpenCodeConnectionProvider {
    async fn connection(&self) -> Result<OpenCodeConnection, ProviderError> {
        let connection = self
            .app_runtime
            .ensure_shared_opencode()
            .await
            .map_err(|error| opencode_connection_error(&error))?;
        Ok(OpenCodeConnection {
            endpoint: connection.endpoint,
            headers: connection.headers,
        })
    }

    fn workspace_roots(&self) -> Vec<PathBuf> {
        let roots = self.repository_service.workspace_roots();
        if roots.is_empty() {
            vec![self.fallback_root.clone()]
        } else {
            roots.to_vec()
        }
    }
}

fn opencode_connection_error(error: &AppRuntimeError) -> ProviderError {
    match error {
        AppRuntimeError::NotFound(_) => ProviderError::new("APP_NOT_FOUND", error.to_string(), 404),
        AppRuntimeError::MissingCommand(_) => {
            ProviderError::new("APP_DEPENDENCY_MISSING", error.to_string(), 503)
        }
        _ => ProviderError::new("OPENCODE_SERVER_START_FAILED", error.to_string(), 503),
    }
}

fn opencode_story_plugin_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("TASK_HANDOFF_OPENCODE_STORY_PLUGIN")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    let executable = std::env::current_exe().ok()?;
    let mut directory = executable.parent()?.to_path_buf();
    for _ in 0..3 {
        let candidate = directory.join("opencode-story-plugin.mjs");
        if candidate.is_file() {
            return Some(candidate);
        }
        directory = directory.parent()?.to_path_buf();
    }
    None
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<InstanceConfig>,
    pub auth: Arc<WebAuthState>,
    pub started_at: String,
    pub events: EventBus,
    pub app_runtime: Arc<AppRuntime>,
    pub app_management: Arc<AppManagementManager>,
    app_session_authority: Arc<Mutex<AppSessionAuthority>>,
    pub ai_sessions: Arc<AiSessionRuntime>,
    pub ai_session_controller: Arc<AiSessionController>,
    pub ai_session_codex: Arc<CodexAppServerProvider>,
    pub ai_session_claude: Arc<ClaudeControlSockProvider>,
    pub ai_session_opencode: Arc<OpenCodeSessionProvider>,
    pub ai_session_history: Arc<AiSessionHistoryStore>,
    pub ai_session_persistence_settings: Arc<AiSessionPersistenceSettingsStore>,
    pub ai_session_timeline: Arc<AiSessionTimelineStore>,
    pub ai_session_attachments: Arc<AiSessionConversationAttachmentStore>,
    pub ai_session_attachment_streams: Arc<AiSessionAttachmentDraftStreams>,
    pub ai_session_message_deltas: Arc<AiSessionDeltaCoalescer>,
    pub ai_session_timeline_item_deltas: Arc<AiSessionDeltaCoalescer>,
    ai_session_authority: Arc<Mutex<AiSessionAuthority>>,
    pub node_agent_client: NodeAgentClient,
    pub story_tools: StoryToolService,
    pub instance_shell: InstanceShellRuntime,
    pub agent_run_bindings: Arc<AgentRunMemberBindingStore>,
    pub repository_service: RepositoryService,
    pub trigger_store: Arc<TriggerStore>,
    pub trigger_executor: Arc<TriggerExecutor>,
    pub trigger_manager: Arc<TriggerManager>,
    pub config_sync_environment: ConfigSyncEnvironment,
    pub controlled_models: Arc<ControlledModelConfig>,
    pub open_app_operations: Arc<tokio::sync::Mutex<()>>,
    codex_discovery_lock: Arc<tokio::sync::Mutex<()>>,
    ai_session_orphaned_app_sessions: Arc<Mutex<BTreeMap<String, Instant>>>,
    ai_session_orphan_retention: Duration,
    git_credential_broker_installed: Arc<AtomicBool>,
    ai_session_event_projection_started: Arc<AtomicBool>,
    draining: Arc<AtomicBool>,
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
}

impl AppState {
    pub fn new(config: InstanceConfig, auth: WebAuthState) -> Self {
        Self::try_new(config, auth)
            .unwrap_or_else(|error| panic!("failed to initialize controlled instance: {error:#}"))
    }

    pub fn try_new(config: InstanceConfig, auth: WebAuthState) -> anyhow::Result<Self> {
        let node_agent_client = NodeAgentClient::from_instance_config(&config);
        Self::try_new_with_node_agent_client(config, auth, node_agent_client)
    }

    pub fn try_new_with_node_agent_client(
        config: InstanceConfig,
        auth: WebAuthState,
        node_agent_client: NodeAgentClient,
    ) -> anyhow::Result<Self> {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let ai_session_orphan_retention =
            std::env::var("TASK_HANDOFF_AI_SESSION_ORPHAN_RETENTION_MS")
                .ok()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .filter(|value| *value > 0)
                .map(Duration::from_millis)
                .unwrap_or(Duration::from_secs(5 * 60));
        let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let story_tools = StoryToolService::new(
            node_agent_client.clone(),
            format!("http://127.0.0.1:{}/api/internal/agent-tools", config.port),
        );
        let agent_run_bindings = Arc::new(AgentRunMemberBindingStore::load(
            &config.storage_paths.runtime_dir,
        )?);
        let ai_session_dir = std::env::var("TASK_HANDOFF_AI_SESSION_DIR")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| config.storage_paths.data_dir.join("ai-sessions"));
        let ai_sessions = Arc::new(AiSessionRuntime::new(
            &config.instance_id,
            Some(ai_session_dir),
        ));
        let ai_session_persistence_settings = Arc::new(AiSessionPersistenceSettingsStore::new(
            &config.storage_paths.data_dir,
        ));
        let initial_persistence_settings = ai_session_persistence_settings.get();
        let ai_session_history = Arc::new(AiSessionHistoryStore::new(
            &config.storage_paths.data_dir,
            Some(initial_persistence_settings.history_limit),
        ));
        let ai_session_timeline =
            Arc::new(AiSessionTimelineStore::new(&config.storage_paths.data_dir));
        let ai_session_attachments = Arc::new(AiSessionConversationAttachmentStore::new(
            &config.storage_paths.data_dir,
        ));
        ai_session_attachments
            .set_max_file_attachment_bytes(initial_persistence_settings.max_file_attachment_bytes)
            .map_err(|error| anyhow::anyhow!(error))?;
        let _ = ai_session_attachments
            .set_retention_days(initial_persistence_settings.attachment_retention_days);
        let ai_session_attachment_streams = Arc::new(ai_session_attachments.draft_streams());
        let managed_app_root = std::env::var_os("TASK_HANDOFF_MANAGED_APP_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| config.storage_paths.data_dir.join("managed-apps"));
        let app_runtime = Arc::new(AppRuntime::new_with_managed_root(
            config.storage_paths.clone(),
            config.workspace_path.clone(),
            Some(managed_app_root.clone()),
        ));
        let instance_shell = InstanceShellRuntime::new(config.workspace_path.clone())
            .with_app_runtime(app_runtime.clone());
        if node_agent_client.enabled() {
            app_runtime.set_shared_resource_private_environment(
                "codex",
                story_tools.runtime_environment(),
            );
            app_runtime.set_shared_resource_private_environment(
                "opencode",
                story_tools.opencode_runtime_environment(opencode_story_plugin_path().as_deref()),
            );
        }
        let repository_service = RepositoryService::from_env();
        let codex_client = CodexAppServerClient::new();
        let codex_client = if node_agent_client.enabled() {
            codex_client
                .with_story_agent_tool_bridge(&story_tools.mcp_endpoint(), story_tools.token())
        } else {
            codex_client
        };
        let ai_session_codex = Arc::new(CodexAppServerProvider::new(
            codex_client,
            Some((*ai_session_timeline).clone()),
        ));
        ai_session_codex
            .client()
            .set_external_target_resolver(Some(Arc::new(AppRuntimeCodexTargetResolver {
                app_runtime: app_runtime.clone(),
            })));
        let ai_session_claude =
            Arc::new(ClaudeControlSockProvider::new(ClaudeControlClient::new()));
        let ai_session_opencode =
            OpenCodeSessionProvider::new(Arc::new(AppRuntimeOpenCodeConnectionProvider {
                app_runtime: app_runtime.clone(),
                repository_service: repository_service.clone(),
                fallback_root: config.workspace_path.clone(),
            }));
        let ai_session_controller = AiSessionController::new(
            ai_sessions.clone(),
            ai_session_attachments.clone(),
            ai_session_attachment_streams.clone(),
            Some(
                config
                    .storage_paths
                    .runtime_dir
                    .join("ai-session-create-operations.json"),
            ),
        );
        ai_session_controller.register_provider(ai_session_codex.clone());
        ai_session_controller.register_provider(ai_session_claude.clone());
        ai_session_controller.register_provider(ai_session_opencode.clone());
        ai_session_controller.set_story_agent_tool_resolver(Arc::new(story_tools.clone()));
        let events = EventBus::default();
        let delta_window_ms = std::env::var("TASK_HANDOFF_AI_SESSION_DELTA_COALESCE_MS")
            .ok()
            .map(|value| {
                value.trim().parse::<f64>().map_err(|error| {
                    anyhow::anyhow!(
                        "TASK_HANDOFF_AI_SESSION_DELTA_COALESCE_MS must be numeric: {error}"
                    )
                })
            })
            .transpose()?;
        let ai_session_message_deltas = Arc::new(
            AiSessionDeltaCoalescer::new(
                events.clone(),
                "ai-session.message-delta",
                delta_window_ms,
            )
            .map_err(anyhow::Error::msg)?,
        );
        let ai_session_timeline_item_deltas = Arc::new(
            AiSessionDeltaCoalescer::new(
                events.clone(),
                "ai-session.timeline-item-delta",
                delta_window_ms,
            )
            .map_err(anyhow::Error::msg)?,
        );
        let config_sync_environment =
            ConfigSyncEnvironment::from_storage_paths(&config.storage_paths);
        let trigger_store = Arc::new(TriggerStore::new(
            &config.storage_paths.triggers_dir,
            local_instance_id(),
        ));
        let trigger_executor = Arc::new(TriggerExecutor::new(
            trigger_store.clone(),
            ai_session_controller.clone(),
        ));
        let trigger_events = events.clone();
        let trigger_manager = TriggerManager::new(
            trigger_store.clone(),
            trigger_executor.clone(),
            config.workspace_path.clone(),
            Arc::new(move |event_type, payload| {
                trigger_events.publish(event_type, payload);
            }),
        );
        let ai_session_authority = Arc::new(Mutex::new(AiSessionAuthority::new(
            &config.instance_id,
            ai_sessions.stream_id(),
            started_at.clone(),
        )));
        let app_stream_id = format!("aps_{}_{}", config.instance_id, uuid::Uuid::new_v4());
        let app_session_authority = Arc::new(Mutex::new(AppSessionAuthority::new(
            &config.instance_id,
            app_stream_id,
            started_at.clone(),
        )));
        let app_management_events = events.clone();
        let app_management_sessions = app_runtime.clone();
        let app_management_runtime = app_runtime.clone();
        let app_management_ai_sessions = ai_sessions.clone();
        let app_management = Arc::new(AppManagementManager::new_with_runtime_hook(
            config.storage_paths.runtime_dir.join("app-management"),
            managed_app_root,
            move || {
                let mut sessions = app_management_sessions
                    .list_sessions()
                    .into_iter()
                    .map(|session| AppManagementSession {
                        id: session.id,
                        app_id: session.app_id,
                        status: session.status,
                    })
                    .collect::<Vec<_>>();
                sessions.extend(
                    app_management_ai_sessions
                        .list()
                        .into_iter()
                        .filter(|session| session.active_turn_id.is_some())
                        .map(|session| AppManagementSession {
                            id: session.id,
                            app_id: session.agent,
                            status: "running".into(),
                        }),
                );
                sessions
            },
            move |event| {
                if let Ok(payload) = serde_json::to_value(event) {
                    let _ = app_management_events.publish("app.management", payload);
                }
            },
            move |app_id| {
                app_management_runtime.stop_shared_resource(app_id);
                app_management_runtime.invalidate_catalog();
            },
        ));
        let management_admission = Arc::downgrade(&app_management);
        app_runtime.set_app_launch_admission(move |app_id| {
            management_admission
                .upgrade()
                .is_none_or(|manager| !manager.has_active_operation(app_id))
        });
        // Node publishes the initial app-management snapshot once during
        // startup. That establishes sequence 1 for both the HTTP snapshot and
        // the first WebSocket projection.
        app_management.publish_snapshot();
        let controlled_models = Arc::new(ControlledModelConfig::load(
            &config.instance_id,
            config.control_mode,
            &config_sync_environment,
            std::env::vars().collect(),
            &started_at,
        )?);
        ai_session_codex
            .client()
            .replace_managed_environment(controlled_models.runtime_environment());
        controlled_models.sync_app_environment(&app_runtime);
        ai_session_controller.set_model_selection_resolver(controlled_models.clone());
        ai_session_opencode.set_model_selection_projector(controlled_models.clone());
        ai_session_opencode.set_title_generator(controlled_models.clone());
        Ok(Self {
            config: Arc::new(config),
            auth: Arc::new(auth),
            started_at,
            events,
            app_runtime,
            app_management,
            app_session_authority,
            ai_sessions,
            ai_session_controller,
            ai_session_codex,
            ai_session_claude,
            ai_session_opencode,
            ai_session_history,
            ai_session_persistence_settings,
            ai_session_timeline,
            ai_session_attachments,
            ai_session_attachment_streams,
            ai_session_message_deltas,
            ai_session_timeline_item_deltas,
            ai_session_authority,
            node_agent_client,
            story_tools,
            instance_shell,
            agent_run_bindings,
            repository_service,
            trigger_store,
            trigger_executor,
            trigger_manager,
            config_sync_environment,
            controlled_models,
            open_app_operations: Arc::new(tokio::sync::Mutex::new(())),
            codex_discovery_lock: Arc::new(tokio::sync::Mutex::new(())),
            ai_session_orphaned_app_sessions: Arc::new(Mutex::new(BTreeMap::new())),
            ai_session_orphan_retention,
            git_credential_broker_installed: Arc::new(AtomicBool::new(false)),
            ai_session_event_projection_started: Arc::new(AtomicBool::new(false)),
            draining: Arc::new(AtomicBool::new(false)),
            shutdown_tx,
            shutdown_rx,
        })
    }

    pub async fn refresh_managed_model_environment(&self) {
        self.controlled_models
            .sync_app_environment(&self.app_runtime);
        self.ai_session_codex
            .replace_managed_environment(self.controlled_models.runtime_environment())
            .await;
    }

    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    pub fn set_draining(&self, draining: bool) {
        self.draining.store(draining, Ordering::SeqCst);
        if draining {
            self.app_runtime.begin_drain();
        } else {
            self.app_runtime.end_drain();
        }
        if let Err(error) = self.trigger_manager.set_draining(draining) {
            tracing::warn!(%error, draining, "failed to update trigger runtime drain state");
        }
        let _ = self.events.publish(
            if draining {
                "instance.draining"
            } else {
                "instance.resumed"
            },
            json!({ "instanceId": self.config.instance_id, "draining": draining }),
        );
    }

    pub fn request_shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    pub fn diagnostics(&self) -> Value {
        let ai_sessions = self
            .ai_session_authority
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let app_sessions = self
            .app_session_authority
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        crate::diagnostics::instance_diagnostics(
            &self.config,
            &self.started_at,
            &ai_sessions,
            &app_sessions,
            self.ai_session_message_deltas.diagnostic_value(),
        )
    }

    pub fn start_node_agent(&self) {
        let config = self.config.clone();
        let app_runtime = self.app_runtime.clone();
        let ai_sessions = self.ai_sessions.clone();
        let ai_session_controller = self.ai_session_controller.clone();
        let trigger_store = self.trigger_store.clone();
        let git_credential_broker_installed = self.git_credential_broker_installed.clone();
        self.node_agent_client.start(move || {
            build_status_snapshot(
                &config,
                &app_runtime,
                &ai_sessions,
                &ai_session_controller,
                trigger_store.snapshot().ok(),
                git_credential_broker_installed.load(Ordering::SeqCst),
            )
        });
    }

    pub async fn stop_node_agent(&self) {
        self.node_agent_client.stop().await;
    }

    pub async fn heartbeat_node_agent(&self) {
        if !self.node_agent_client.enabled() {
            return;
        }
        if let Err(error) = self
            .node_agent_client
            .heartbeat(&self.status_snapshot())
            .await
        {
            tracing::warn!(%error, "failed to publish controlled instance heartbeat");
        }
    }

    pub fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.shutdown_rx.clone()
    }

    pub fn process_start_identity(&self) -> Option<String> {
        process_start_identity(std::process::id())
    }

    pub fn capabilities(&self) -> ControlledInstanceCapabilities {
        controlled_instance_capabilities(
            &self.app_runtime,
            &self.ai_session_controller,
            self.git_credential_broker_installed.load(Ordering::SeqCst),
        )
    }

    pub fn set_git_credential_broker_installed(&self, installed: bool) {
        self.git_credential_broker_installed
            .store(installed, Ordering::SeqCst);
    }

    pub fn start_ai_session_services(&self) {
        self.start_ai_session_event_projection();
        let mut changes = self.ai_session_controller.subscribe_changes();
        let state = self.clone();
        tokio::spawn(async move {
            while changes.recv().await.is_ok() {
                state.publish_ai_session_snapshot("provider-event");
            }
        });
        self.refresh_codex_ai_sessions_in_background();
        let state = self.clone();
        tokio::spawn(async move {
            let configured = std::env::var("TASK_HANDOFF_AI_SESSION_SCAN_INTERVAL_MS")
                .ok()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(30_000);
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(configured));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            interval.tick().await;
            loop {
                interval.tick().await;
                state.refresh_codex_ai_sessions_in_background();
            }
        });
    }

    fn refresh_codex_ai_sessions_in_background(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            if let Err(error) = state.refresh_codex_ai_sessions().await {
                tracing::warn!(%error, "Codex AI Session discovery failed");
            }
        });
    }

    pub async fn refresh_codex_ai_sessions(&self) -> Result<usize, ProviderError> {
        let _guard = self.codex_discovery_lock.lock().await;
        let app_sessions = self.app_runtime.list_sessions();
        let active_app_session_ids = self
            .running_app_session_ids()
            .into_iter()
            .collect::<HashSet<_>>();
        let mut changed = 0;
        let lost_app_sessions = self
            .ai_sessions
            .list()
            .into_iter()
            .filter(|session| {
                session.creation_source == "app-session"
                    && session
                        .app_session_id
                        .as_deref()
                        .is_some_and(|id| !active_app_session_ids.contains(id))
            })
            .collect::<Vec<_>>();
        for session in lost_app_sessions {
            match self.close_ai_session_subtree(&session.id).await {
                Ok(Some(_)) => {
                    self.ai_session_orphaned_app_sessions
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&session.id);
                    changed += 1;
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(
                        ai_session_id = %session.id,
                        app_session_id = ?session.app_session_id,
                        %error,
                        "failed to close AI Session after App exit"
                    );
                }
            }
        }
        changed += self.reconcile_orphaned_ai_sessions(&active_app_session_ids);
        let (bindings, mut recoverable) = app_thread_bindings(&app_sessions);
        for thread_id in recoverable_session_threads(&self.ai_sessions.list()) {
            if !recoverable.iter().any(|known| known == &thread_id) {
                recoverable.push(thread_id);
            }
        }
        let snapshots = self
            .ai_session_codex
            .client()
            .discover_thread_snapshots(&recoverable)
            .await?;
        for snapshot in snapshots {
            let binding = bindings.get(&snapshot.provider_session_id);
            let model_selection = self.project_codex_model_selection(&snapshot);
            if let Some(existing) = self
                .ai_sessions
                .get_by_provider_session_id("codex", &snapshot.provider_session_id)
            {
                let updated = self
                    .ai_sessions
                    .update(&existing.id, |session| {
                        Ok(merge_codex_session(
                            session,
                            &snapshot,
                            binding,
                            model_selection.clone(),
                        ))
                    })
                    .map_err(|error| {
                        ProviderError::new(
                            "AI_SESSION_DISCOVERY_PERSIST_FAILED",
                            error.to_string(),
                            500,
                        )
                    })?;
                if updated != existing {
                    changed += 1;
                }
            } else if let Some(binding) = binding {
                self.ai_sessions
                    .save(project_new_codex_session(
                        &snapshot,
                        binding,
                        model_selection,
                    ))
                    .map_err(|error| {
                        ProviderError::new(
                            "AI_SESSION_DISCOVERY_PERSIST_FAILED",
                            error.to_string(),
                            500,
                        )
                    })?;
                changed += 1;
            }
        }
        self.activate_history_for_running_sessions(&active_app_session_ids);
        if changed > 0 {
            self.publish_ai_session_snapshot("discovery-scan");
        }
        Ok(changed)
    }

    fn activate_history_for_running_sessions(&self, active_app_session_ids: &HashSet<String>) {
        for session in self.ai_sessions.list() {
            if !matches!(session.agent.as_str(), "codex" | "claude")
                || session.provider_session_id.is_none()
                || !session
                    .app_session_id
                    .as_deref()
                    .is_some_and(|id| active_app_session_ids.contains(id))
            {
                continue;
            }
            if let Err(error) = self.ai_session_history.activate(&session.id) {
                tracing::warn!(ai_session_id = %session.id, %error, "failed to activate AI Session history");
            }
            if let Some(provider_session_id) = session.provider_session_id.as_deref() {
                if let Err(error) = self
                    .ai_session_history
                    .activate_identity(&session.agent, provider_session_id)
                {
                    tracing::warn!(ai_session_id = %session.id, %error, "failed to activate AI Session history identity");
                }
            }
        }
    }

    fn reconcile_orphaned_ai_sessions(&self, active_app_session_ids: &HashSet<String>) -> usize {
        let now = Instant::now();
        let mut orphaned = self
            .ai_session_orphaned_app_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut remove = Vec::new();
        let mut changed = 0;
        for session in self.ai_sessions.list() {
            let Some(app_session_id) = session.app_session_id.as_deref() else {
                orphaned.remove(&session.id);
                // Compatibility for v0.0.28: old discovery could persist an
                // App-owned session without the identity needed to reconcile it.
                if session.creation_source == "app-session" {
                    match self.ai_sessions.remove(&session.id) {
                        Ok(Some(_)) => changed += 1,
                        Ok(None) => {}
                        Err(error) => {
                            tracing::warn!(ai_session_id = %session.id, %error, "failed to remove orphaned App AI Session")
                        }
                    }
                }
                continue;
            };
            if active_app_session_ids.contains(app_session_id) {
                orphaned.remove(&session.id);
                continue;
            }
            let orphaned_at = *orphaned.entry(session.id.clone()).or_insert(now);
            if now.duration_since(orphaned_at) >= self.ai_session_orphan_retention {
                remove.push(session.id.clone());
            }
        }
        for session_id in remove {
            match self.ai_sessions.remove(&session_id) {
                Ok(Some(_)) => changed += 1,
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(%session_id, %error, "failed to expire orphaned App AI Session")
                }
            }
            orphaned.remove(&session_id);
        }
        changed
    }

    fn project_codex_model_selection(
        &self,
        snapshot: &controlled_instance_ai_session::CodexThreadSnapshot,
    ) -> Option<AiSessionModelSelection> {
        snapshot
            .model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .zip(
                snapshot
                    .model_provider
                    .as_deref()
                    .filter(|value| !value.trim().is_empty()),
            )
            .and_then(|(model, provider)| {
                self.ai_session_controller
                    .project_observed_model_selection("codex", provider, model)
            })
            .flatten()
    }

    fn start_ai_session_event_projection(&self) {
        if self
            .ai_session_event_projection_started
            .swap(true, Ordering::SeqCst)
        {
            return;
        }
        for agent in ["codex", "opencode"] {
            let Ok(provider) = self.ai_session_controller.provider(agent) else {
                continue;
            };
            let Some(mut events) = provider.subscribe_events() else {
                continue;
            };
            let state = self.clone();
            tokio::spawn(async move {
                while let Ok(event) = events.recv().await {
                    state.publish_ai_session_transient_event(event);
                }
                state
                    .ai_session_message_deltas
                    .flush_all(FlushReason::EventSourceClose);
                state
                    .ai_session_timeline_item_deltas
                    .flush_all(FlushReason::EventSourceClose);
            });
        }
    }

    pub(crate) fn publish_ai_session_transient_event(&self, event: ProviderEvent) {
        match event {
            ProviderEvent::AgentMessageDelta {
                provider_session_id,
                turn_id,
                item_id,
                delta,
            } => {
                let Some(session) = self.ai_session_for_provider(&provider_session_id) else {
                    return;
                };
                let mut payload = self.ai_session_event_payload(&session, &provider_session_id);
                insert_event_fields(
                    &mut payload,
                    json!({
                        "turnId": turn_id.clone(),
                        "itemId": item_id.clone(),
                        "delta": delta.clone(),
                    }),
                );
                let key = AiSessionDeltaKey::new(
                    self.config.instance_id.clone(),
                    session.id.clone(),
                    Some(turn_id),
                    Some(item_id),
                );
                if let Err(error) = self.ai_session_message_deltas.push(key, payload, delta) {
                    tracing::warn!(%error, "failed to queue AI session message delta");
                }
            }
            ProviderEvent::TimelineItem {
                provider_session_id,
                item,
            } => {
                let Some(session) = self.ai_session_for_provider(&provider_session_id) else {
                    return;
                };
                let key = AiSessionDeltaKey::new(
                    self.config.instance_id.clone(),
                    session.id.clone(),
                    Some(item.turn_id().to_string()),
                    Some(item.id().to_string()),
                );
                self.ai_session_timeline_item_deltas
                    .flush(&key, FlushReason::AuthoritativeEvent);
                let mut payload = self.ai_session_event_payload(&session, &provider_session_id);
                insert_event_fields(&mut payload, json!({ "item": item }));
                self.events.publish("ai-session.timeline-item", payload);
            }
            ProviderEvent::TimelineItemDelta {
                provider_session_id,
                turn_id,
                item_id,
                field,
                delta,
            } => {
                if field != "output" || delta.is_empty() {
                    return;
                }
                let Some(session) = self.ai_session_for_provider(&provider_session_id) else {
                    return;
                };
                let mut payload = self.ai_session_event_payload(&session, &provider_session_id);
                insert_event_fields(
                    &mut payload,
                    json!({
                        "turnId": turn_id.clone(),
                        "itemId": item_id.clone(),
                        "field": field,
                        "delta": delta.clone(),
                    }),
                );
                let key = AiSessionDeltaKey::new(
                    self.config.instance_id.clone(),
                    session.id.clone(),
                    Some(turn_id),
                    Some(item_id),
                );
                if let Err(error) = self
                    .ai_session_timeline_item_deltas
                    .push(key, payload, delta)
                {
                    tracing::warn!(%error, "failed to queue AI session timeline delta");
                }
            }
            _ => {}
        }
    }

    fn ai_session_for_provider(&self, provider_session_id: &str) -> Option<AiSession> {
        self.ai_sessions
            .list()
            .into_iter()
            .find(|session| session.provider_session_id.as_deref() == Some(provider_session_id))
    }

    fn ai_session_event_payload(&self, session: &AiSession, provider_session_id: &str) -> Value {
        let mut payload = json!({
            "instanceId": self.config.instance_id,
            "sessionId": session.id,
            "providerSessionId": provider_session_id,
            "generatedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        });
        if let Some(node_id) = self.config.node_id.as_deref() {
            payload["nodeId"] = json!(node_id);
        }
        payload
    }

    pub fn start_app_session_services(&self) {
        let mut changes = self.app_runtime.subscribe();
        let state = self.clone();
        tokio::spawn(async move {
            while let Ok(change) = changes.recv().await {
                let reason = match change.kind {
                    controlled_instance_app_runtime::AppRuntimeChangeKind::Created => {
                        "app-session-created"
                    }
                    controlled_instance_app_runtime::AppRuntimeChangeKind::Updated => {
                        "app-session-updated"
                    }
                    controlled_instance_app_runtime::AppRuntimeChangeKind::Deleted => {
                        "app-session-deleted"
                    }
                };
                state.publish_app_session_snapshot(reason);
                if change.session.app_id == "codex" {
                    state.refresh_codex_ai_sessions_in_background();
                }
            }
        });
    }

    pub async fn stop_ai_session_services(&self) {
        self.ai_session_codex.client().stop().await;
        self.ai_session_opencode.close();
        self.app_runtime.stop_shared_opencode();
        self.ai_session_message_deltas
            .close(FlushReason::ServiceClose);
        self.ai_session_timeline_item_deltas
            .close(FlushReason::ServiceClose);
    }

    pub fn workspace_status(&self) -> WorkspaceStatus {
        workspace_status(&self.config)
    }

    pub fn status_snapshot(&self) -> InstanceStatusSnapshot {
        build_status_snapshot(
            &self.config,
            &self.app_runtime,
            &self.ai_sessions,
            &self.ai_session_controller,
            self.trigger_store.snapshot().ok(),
            self.git_credential_broker_installed.load(Ordering::SeqCst),
        )
    }

    pub fn target(&self) -> serde_json::Value {
        target_status()
    }

    pub fn app_counts(&self) -> AppCounts {
        AppCounts {
            running_count: self.app_runtime.running_session_count(),
            problem_count: self.app_runtime.problem_session_count(),
        }
    }

    pub fn app_sessions_state(&self) -> controlled_instance_protocol::AppSessionsState {
        let snapshot = self.app_runtime.snapshot();
        self.app_session_authority
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .state(snapshot)
    }

    pub fn app_sessions_delta(&self, stream_id: &str, since_revision: u64) -> Value {
        self.app_session_authority
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .delta(stream_id, since_revision)
    }

    pub fn app_session_stream_info(&self) -> (String, u64, u64) {
        let authority = self
            .app_session_authority
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (
            authority.stream_id().to_string(),
            authority.revision(),
            authority.earliest_retained_revision(),
        )
    }

    pub fn publish_app_session_snapshot(&self, reason: &str) -> Option<EventEnvelope<Value>> {
        let snapshot = self.app_runtime.snapshot();
        let prepared = self
            .app_session_authority
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .prepare(snapshot, reason)?;
        Some(self.events.publish(prepared.event_type, prepared.payload))
    }

    pub fn ai_sessions_snapshot(&self) -> AiSessionsSnapshot {
        let snapshot = self
            .ai_sessions
            .bound_snapshot(&self.running_app_session_ids());
        self.without_agent_run_member_sessions(snapshot)
    }

    pub fn ai_session_startup_snapshot_event(&self, subagents: bool) -> EventEnvelope<Value> {
        let state = self.ai_sessions_state();
        let snapshot = project_ai_sessions_snapshot_for_consumer(state.snapshot, subagents);
        let payload = self
            .ai_session_authority
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .snapshot_payload(snapshot, "startup");
        self.events.new_event("ai-session.snapshot", payload)
    }

    pub fn is_agent_run_member_session(&self, session_id: &str) -> bool {
        self.agent_run_bindings.get_by_session(session_id).is_some()
    }

    fn without_agent_run_member_sessions(
        &self,
        snapshot: AiSessionsSnapshot,
    ) -> AiSessionsSnapshot {
        let member_ids = self
            .agent_run_bindings
            .list()
            .into_iter()
            .map(|binding| binding.ai_session_id)
            .collect::<HashSet<_>>();
        let sessions = snapshot
            .sessions
            .into_iter()
            .filter(|session| !member_ids.contains(&session.id))
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
            sessions,
            updated_at: snapshot.updated_at,
        }
    }

    pub fn bound_ai_sessions(&self) -> Vec<controlled_instance_ai_session::AiSession> {
        let running_app_session_ids = self
            .running_app_session_ids()
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        self.ai_sessions
            .list()
            .into_iter()
            .filter(|session| session.is_bound(&running_app_session_ids))
            .collect()
    }

    fn running_app_session_ids(&self) -> Vec<String> {
        let mut ids = self
            .app_runtime
            .list_sessions()
            .into_iter()
            .filter(|session| session.status == "running")
            .map(|session| session.id)
            .collect::<Vec<_>>();
        if self.app_runtime.running_shared_codex_app_server() {
            ids.push(controlled_instance_app_runtime::SHARED_CODEX_APP_SESSION_ID.to_string());
        }
        ids
    }

    pub fn ai_session_retention_candidates(&self) -> Vec<AiSessionRetentionCandidate> {
        let sessions = self.bound_ai_sessions();
        let records = sessions
            .iter()
            .map(hierarchy_record_for_session)
            .collect::<Vec<_>>();
        let statuses = sessions
            .iter()
            .map(|session| (session.id.clone(), session.status.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let last_active = sessions
            .iter()
            .map(|session| (session.id.clone(), session.updated_at.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        derive_retention_candidates(&records, &statuses, &last_active)
    }

    pub fn ai_sessions_state(&self) -> AiSessionsState {
        let snapshot = self.ai_sessions_snapshot();
        self.ai_session_authority
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .state(snapshot)
    }

    pub fn ai_sessions_delta(&self, stream_id: &str, since_revision: u64) -> serde_json::Value {
        self.ai_session_authority
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .delta(stream_id, since_revision)
    }

    pub fn ai_session_stream_info(&self) -> (String, u64, u64) {
        let authority = self
            .ai_session_authority
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (
            authority.stream_id().to_string(),
            authority.revision(),
            authority.earliest_retained_revision(),
        )
    }

    pub fn publish_ai_session_snapshot(
        &self,
        reason: &str,
    ) -> Option<EventEnvelope<serde_json::Value>> {
        self.ai_session_message_deltas
            .flush_all(FlushReason::AuthoritativeEvent);
        let snapshot = self.ai_sessions_snapshot();
        let prepared = self
            .ai_session_authority
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .prepare(snapshot.clone(), reason)?;
        self.trigger_manager.handle_ai_sessions(&snapshot);
        Some(self.events.publish(prepared.event_type, prepared.payload))
    }

    pub fn archive_ai_session(
        &self,
        id: &str,
    ) -> Result<bool, controlled_instance_ai_session::AiSessionHistoryError> {
        let Some(session) = self.ai_sessions.get(id) else {
            return Ok(false);
        };
        let Some(item) = AiSessionHistoryStore::from_session(
            &session,
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        ) else {
            return Ok(false);
        };
        self.ai_session_history
            .upsert(item, &AiSessionHistoryStore::turns_for_session(&session))?;
        Ok(true)
    }

    pub async fn close_ai_session_subtree(
        &self,
        target_id: &str,
    ) -> Result<Option<controlled_instance_ai_session::AiSession>, ProviderError> {
        let sessions = self.ai_sessions.list();
        let records = sessions
            .iter()
            .map(hierarchy_record_for_session)
            .collect::<Vec<_>>();
        let Some(subtree) = derive_subtree(&records, target_id) else {
            return Ok(None);
        };
        let originals = sessions
            .iter()
            .map(|session| (session.id.clone(), session.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        for session_id in &subtree.postorder {
            let _ = self.ai_sessions.update(session_id, |session| {
                session.actions = Some(serde_json::json!({
                    "send": false,
                    "interrupt": false,
                    "approval": false,
                    "openApp": false,
                    "close": false
                }));
                session.queue = Default::default();
                Ok(true)
            });
        }

        let mut blocked = std::collections::HashSet::new();
        let mut first_error = None;
        let mut removed_target = None;
        for session_id in &subtree.postorder {
            if blocked.contains(session_id) {
                if let Some(original) = originals.get(session_id) {
                    let _ = self.ai_sessions.save(original.clone());
                }
                continue;
            }
            let Some(original) = originals.get(session_id).cloned() else {
                continue;
            };
            match self.archive_one_ai_session(&original, false).await {
                Ok(()) => {
                    if session_id == target_id {
                        removed_target = Some(original);
                    }
                }
                Err(error) => {
                    block_ancestors(&subtree.parent_by_id, session_id, &mut blocked);
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if let Some(error) = first_error {
            return Err(ProviderError::new(
                "AI_SESSION_CLOSE_FAILED",
                error.message,
                409,
            ));
        }
        Ok(removed_target)
    }

    pub async fn close_ai_session_for_app_session(
        &self,
        app_session_id: &str,
    ) -> Result<Option<controlled_instance_ai_session::AiSession>, ProviderError> {
        let session = self.ai_sessions.list().into_iter().find(|session| {
            session.app_session_id.as_deref() == Some(app_session_id)
                && session.creation_source == "app-session"
        });
        match session {
            Some(session) => self.close_ai_session_subtree(&session.id).await,
            None => Ok(None),
        }
    }

    pub async fn close_ai_session_subtree_if_idle(
        &self,
        target_id: &str,
    ) -> Result<Option<controlled_instance_ai_session::AiSession>, ProviderError> {
        if let Some(session) = self.ai_sessions.get(target_id) {
            let sessions = self.ai_sessions.list();
            let records = sessions
                .iter()
                .map(hierarchy_record_for_session)
                .collect::<Vec<_>>();
            if derive_subtree(&records, &session.id).is_some_and(|subtree| {
                subtree
                    .postorder
                    .iter()
                    .filter_map(|id| self.ai_sessions.get(id))
                    .any(|session| session.status != "idle")
            }) {
                return Ok(None);
            }
        }
        self.close_ai_session_subtree(target_id).await
    }

    pub async fn clear_ai_session_subtree(
        &self,
        target_id: &str,
    ) -> Result<Vec<String>, ProviderError> {
        let sessions = self.ai_sessions.list();
        let live_ids = sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let history = self
            .ai_session_history
            .list(None)
            .into_iter()
            .filter(|item| !live_ids.contains(item.id.as_str()))
            .collect::<Vec<_>>();
        let mut records = sessions
            .iter()
            .map(hierarchy_record_for_session)
            .collect::<Vec<_>>();
        records.extend(history.iter().map(hierarchy_record_for_history));
        let subtree = match derive_subtree(&records, target_id) {
            Some(subtree) => subtree,
            None => return Ok(Vec::new()),
        };
        let originals = sessions
            .iter()
            .map(|session| (session.id.clone(), session.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let history_by_id = history
            .into_iter()
            .map(|item| (item.id.clone(), item))
            .collect::<std::collections::HashMap<_, _>>();
        let mut blocked = std::collections::HashSet::new();
        let mut first_error = None;
        let mut cleared = Vec::new();
        for session_id in &subtree.postorder {
            if blocked.contains(session_id) {
                if let Some(original) = originals.get(session_id) {
                    let _ = self.ai_sessions.save(original.clone());
                }
                continue;
            }
            let active = originals.get(session_id).cloned();
            let archived = history_by_id.get(session_id).cloned();
            match self
                .delete_one_ai_session(active.as_ref(), archived.as_ref())
                .await
            {
                Ok(()) => cleared.push(session_id.clone()),
                Err(error) => {
                    block_ancestors(&subtree.parent_by_id, session_id, &mut blocked);
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if let Some(error) = first_error {
            return Err(ProviderError::new(
                "AI_SESSION_DELETE_FAILED",
                error.message,
                409,
            ));
        }
        Ok(cleared)
    }

    async fn archive_one_ai_session(
        &self,
        original: &controlled_instance_ai_session::AiSession,
        delete: bool,
    ) -> Result<(), ProviderError> {
        let provider_session_id = original.provider_session_id.clone().ok_or_else(|| {
            ProviderError::new(
                if delete {
                    "AI_SESSION_DELETE_UNAVAILABLE"
                } else {
                    "AI_SESSION_CLOSE_UNAVAILABLE"
                },
                "AI session has no provider identity.",
                409,
            )
        })?;
        let provider = self.ai_session_controller.provider(&original.agent)?;
        let mut provider_touched = false;
        let result = async {
            if is_ai_session_busy(original) && original.active_turn_id.is_some() {
                self.ai_session_controller.interrupt(&original.id).await?;
            }
            provider_touched = true;
            if delete {
                provider.delete_session(&provider_session_id).await?;
            } else if provider.close_detaches_provider_session() {
                // OpenCode cannot restore an archived session, so closing only
                // detaches it from this instance and keeps it resumable.
            } else {
                provider.archive_session(&provider_session_id).await?;
            }
            if let Some(app_session_id) = original.app_session_id.as_deref() {
                self.app_runtime.stop_session(app_session_id).await;
            }
            provider.unsubscribe_session(&provider_session_id).await?;
            if delete {
                self.ai_session_history
                    .remove(&original.id)
                    .map_err(|error| {
                        ProviderError::new("AI_SESSION_DELETE_FAILED", error.to_string(), 500)
                    })?;
                self.ai_session_attachments.release_session(&original.id);
            } else {
                let item =
                    AiSessionHistoryStore::from_session(original, now_iso()).ok_or_else(|| {
                        ProviderError::new(
                            "AI_SESSION_CLOSE_FAILED",
                            "AI session could not be converted to resumable history.",
                            500,
                        )
                    })?;
                self.ai_session_history
                    .upsert(item, &AiSessionHistoryStore::turns_for_session(original))
                    .map_err(|error| {
                        ProviderError::new("AI_SESSION_CLOSE_FAILED", error.to_string(), 500)
                    })?;
            }
            self.ai_sessions.remove(&original.id).map_err(|error| {
                ProviderError::new("AI_SESSION_STORE_FAILED", error.to_string(), 500)
            })?;
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = self.ai_sessions.save(original.clone());
            if provider_touched {
                let _ = provider.resume_session(original).await;
            }
        }
        result
    }

    async fn delete_one_ai_session(
        &self,
        active: Option<&controlled_instance_ai_session::AiSession>,
        archived: Option<&AiSessionHistoryItem>,
    ) -> Result<(), ProviderError> {
        let session_id = active
            .map(|session| session.id.as_str())
            .or_else(|| archived.map(|item| item.id.as_str()))
            .ok_or_else(|| {
                ProviderError::new("AI_SESSION_NOT_FOUND", "AI Session was not found.", 404)
            })?;
        let agent = active
            .map(|session| session.agent.as_str())
            .or_else(|| archived.map(|item| item.agent.as_str()))
            .unwrap_or_default();
        let provider_session_id = active
            .and_then(|session| session.provider_session_id.clone())
            .or_else(|| archived.map(|item| item.provider_session_id.clone()))
            .ok_or_else(|| {
                ProviderError::new(
                    "AI_SESSION_DELETE_UNAVAILABLE",
                    "AI session has no provider identity.",
                    409,
                )
            })?;
        let provider = self.ai_session_controller.provider(agent)?;
        let result = async {
            if let Some(active) = active {
                if is_ai_session_busy(active) && active.active_turn_id.is_some() {
                    self.ai_session_controller.interrupt(&active.id).await?;
                }
            }
            provider.delete_session(&provider_session_id).await?;
            if let Some(app_session_id) =
                active.and_then(|session| session.app_session_id.as_deref())
            {
                self.app_runtime.stop_session(app_session_id).await;
            }
            provider.unsubscribe_session(&provider_session_id).await?;
            if let Some(active) = active {
                self.ai_sessions.remove(&active.id).map_err(|error| {
                    ProviderError::new("AI_SESSION_STORE_FAILED", error.to_string(), 500)
                })?;
            }
            self.ai_session_history
                .remove(session_id)
                .map_err(|error| {
                    ProviderError::new("AI_SESSION_DELETE_FAILED", error.to_string(), 500)
                })?;
            self.ai_session_attachments.release_session(session_id);
            Ok(())
        }
        .await;
        if result.is_err() {
            if let Some(active) = active {
                let _ = self.ai_sessions.save(active.clone());
            }
        }
        result
    }
}

fn hierarchy_record_for_session(
    session: &controlled_instance_ai_session::AiSession,
) -> AiSessionHierarchyRecord {
    AiSessionHierarchyRecord {
        id: session.id.clone(),
        agent: session.agent.clone(),
        provider_session_id: session.provider_session_id.clone(),
        lineage: session.lineage.clone(),
        updated_at: session.updated_at.clone(),
    }
}

fn hierarchy_record_for_history(item: &AiSessionHistoryItem) -> AiSessionHierarchyRecord {
    AiSessionHierarchyRecord {
        id: item.id.clone(),
        agent: item.agent.clone(),
        provider_session_id: Some(item.provider_session_id.clone()),
        lineage: item.lineage.clone(),
        updated_at: item.last_active_at.clone(),
    }
}

fn block_ancestors(
    parent_by_id: &std::collections::HashMap<String, String>,
    session_id: &str,
    blocked: &mut std::collections::HashSet<String>,
) {
    let mut current = parent_by_id.get(session_id);
    while let Some(parent_id) = current {
        blocked.insert(parent_id.clone());
        current = parent_by_id.get(parent_id);
    }
}

fn is_ai_session_busy(session: &controlled_instance_ai_session::AiSession) -> bool {
    matches!(session.status.as_str(), "running" | "waiting")
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn insert_event_fields(payload: &mut Value, fields: Value) {
    let (Some(payload), Some(fields)) = (payload.as_object_mut(), fields.as_object()) else {
        return;
    };
    payload.extend(fields.clone());
}

fn build_status_snapshot(
    config: &InstanceConfig,
    app_runtime: &AppRuntime,
    ai_sessions: &AiSessionRuntime,
    ai_session_controller: &AiSessionController,
    triggers: Option<controlled_instance_protocol::TriggerSnapshot>,
    git_credential_broker_installed: bool,
) -> InstanceStatusSnapshot {
    let running_app_session_ids = app_runtime
        .list_sessions()
        .into_iter()
        .filter(|session| session.status == "running")
        .map(|session| session.id)
        .collect::<Vec<_>>();
    let capabilities = controlled_instance_capabilities(
        app_runtime,
        ai_session_controller,
        git_credential_broker_installed,
    );
    InstanceStatusSnapshot {
        // Node reports the controlled-instance lifecycle status independently
        // from the drain flag. Keeping a separate "draining" value here is not
        // part of the node-agent wire enum and makes its strict schema reject
        // otherwise valid heartbeats.
        status: "running".to_string(),
        health: "ok".to_string(),
        instance_version: config.package_version.clone(),
        protocol_version: controlled_instance_protocol::CONTROL_PLANE_PROTOCOL_VERSION.to_string(),
        build: config.build_info.clone(),
        control_mode: config.control_mode.as_str().to_string(),
        capabilities,
        app_inventory: app_runtime.app_inventory(),
        apps: AppCounts {
            running_count: app_runtime.running_session_count(),
            problem_count: app_runtime.problem_session_count(),
        },
        ai_sessions: ai_sessions.bound_snapshot(&running_app_session_ids),
        triggers: triggers.and_then(|value| serde_json::to_value(value).ok()),
        workspace: workspace_status(config),
        target: target_status(),
    }
}

fn controlled_instance_capabilities(
    app_runtime: &AppRuntime,
    ai_session_controller: &AiSessionController,
    git_credential_broker_installed: bool,
) -> ControlledInstanceCapabilities {
    let mut capabilities = ControlledInstanceCapabilities::default();
    let inventory = app_runtime.app_inventory();
    let available = inventory
        .items
        .iter()
        .filter(|item| item.get("availability").and_then(Value::as_str) == Some("available"))
        .collect::<Vec<_>>();
    let available_ids = available
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let has_kind = |kind: &str| {
        available
            .iter()
            .any(|item| item.get("kind").and_then(Value::as_str) == Some(kind))
    };
    capabilities.features.app_runtime = true;
    capabilities.features.tty = has_kind("tty");
    capabilities.features.gui = has_kind("gui");
    capabilities.features.browser =
        available_ids.contains("browser") || available_ids.contains("chromium");
    capabilities.features.browser_tunnel = true;
    capabilities.features.screenshots = capabilities.features.gui
        && controlled_instance_app_runtime::resolve_executable("import", &BTreeMap::new(), None)
            .is_some();
    capabilities.features.logs = true;
    capabilities.features.ai_session_workspace_selection = true;
    capabilities.features.ai_session_workspace_checkout = true;
    capabilities.features.ai_session_persistence_settings = true;
    capabilities.features.node_agent_connection_update = true;
    capabilities.features.ai_session_send_idempotency = true;
    capabilities.features.ai_session_queue_pause = true;
    capabilities.features.private_model_catalog = true;
    capabilities.features.codex_managed_settings = true;
    capabilities.features.git_cli_credential_broker = git_credential_broker_installed;
    capabilities.features.git_credential_proxy = git_credential_broker_installed;
    capabilities.features.repository_path_search = true;
    capabilities.features.repository_worktree_move_to_main = true;
    capabilities.features.model_relay.protocols = vec![
        "openai-responses".to_string(),
        "openai-chat-completions".to_string(),
        "anthropic-messages".to_string(),
    ];
    capabilities.features.model_relay.streaming = true;
    capabilities
        .features
        .managed_model_environment
        .open_code_config = true;
    let mut providers = ai_session_controller
        .provider_capabilities()
        .into_iter()
        .filter(|provider| available_ids.contains(provider.agent.as_str()))
        .collect::<Vec<_>>();
    providers.sort_by_key(|provider| match provider.agent.as_str() {
        "codex" => 0,
        "claude" => 1,
        "opencode" => 2,
        _ => 3,
    });
    // Timeline reads depend on the live provider connection, not only on the
    // provider's declared capability document. Node projects the controller's
    // current capability set here so a disconnected Codex app-server does not
    // advertise reads the UI cannot perform.
    let timeline = ai_session_controller.timeline_capabilities();
    let available_agent = |agent: &str| available_ids.contains(agent);
    capabilities.features.ai_session_timeline =
        controlled_instance_protocol::AiSessionTimelineCapabilities {
            session_read_agents: timeline
                .session_read_agents
                .into_iter()
                .filter(|agent| available_agent(agent))
                .collect(),
            turn_read_agents: timeline
                .turn_read_agents
                .into_iter()
                .filter(|agent| available_agent(agent))
                .collect(),
            live_item_agents: timeline
                .live_item_agents
                .into_iter()
                .filter(|agent| available_agent(agent))
                .collect(),
        };
    capabilities.features.ai_session_providers = providers;
    let agents = capabilities
        .features
        .ai_session_providers
        .iter()
        .filter(|provider| provider.actions.send)
        .map(|provider| provider.agent.clone())
        .collect::<Vec<_>>();
    capabilities
        .features
        .ai_session_conversation_attachments
        .metadata_agents = agents.clone();
    capabilities
        .features
        .ai_session_conversation_attachments
        .content_agents = agents.clone();
    capabilities
        .features
        .ai_session_conversation_attachments
        .upload_agents = agents;
    capabilities
        .features
        .ai_session_conversation_attachments
        .retention_settings = true;
    capabilities
        .features
        .ai_session_conversation_attachments
        .file_size_limit_settings = true;
    capabilities.features.instance_shell =
        controlled_instance_protocol::InstanceShellCapabilities::supported();
    capabilities
}

fn workspace_status(config: &InstanceConfig) -> WorkspaceStatus {
    let exists = config.workspace_path.exists();
    let git_url = workspace_git_env("TASK_HANDOFF_WORKSPACE_GIT_URL", "TASK_HANDOFF_GIT_URL");
    WorkspaceStatus {
        mode: std::env::var("TASK_HANDOFF_WORKSPACE_MODE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                if git_url.is_some() {
                    "git-clone"
                } else {
                    "local-bind"
                }
                .to_string()
            }),
        status: if exists { "ready" } else { "unknown" }.to_string(),
        path: config.workspace_path.display().to_string(),
        exists,
        git: WorkspaceGitStatus {
            url: git_url,
            git_ref: workspace_git_env("TASK_HANDOFF_WORKSPACE_GIT_REF", "TASK_HANDOFF_GIT_REF"),
            resolved_commit: env_optional("TASK_HANDOFF_WORKSPACE_GIT_COMMIT"),
        },
        storage: WorkspaceStorageStatus {
            data_dir: config.storage_paths.data_dir.display().to_string(),
            log_dir: config.storage_paths.log_dir.display().to_string(),
        },
    }
}

fn target_status() -> serde_json::Value {
    let web = env_optional("TASK_HANDOFF_INSTANCE_WEB_URL")
        .or_else(|| env_optional("TASK_HANDOFF_PUBLIC_WEB_URL"));
    let api = env_optional("TASK_HANDOFF_INSTANCE_API_URL").or_else(|| {
        web.as_ref()
            .map(|web| format!("{}/api", web.trim_end_matches('/')))
    });
    let reachable = web.is_some() || api.is_some();
    let mut target = serde_json::Map::new();
    target.insert(
        "strategy".to_string(),
        Value::String(
            env_optional("TASK_HANDOFF_INSTANCE_ENDPOINT_STRATEGY")
                .unwrap_or_else(|| "direct-port".to_string()),
        ),
    );
    if let Some(web) = web {
        target.insert("web".to_string(), Value::String(web));
    }
    if let Some(api) = api {
        target.insert("api".to_string(), Value::String(api));
    }
    target.insert(
        "status".to_string(),
        Value::String(if reachable { "reachable" } else { "unknown" }.to_string()),
    );
    Value::Object(target)
}

fn workspace_git_env(primary: &str, legacy: &str) -> Option<String> {
    env_optional(primary).or_else(|| env_optional(legacy))
}

fn env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Clone)]
struct AppRuntimeCodexTargetResolver {
    app_runtime: Arc<AppRuntime>,
}

#[async_trait::async_trait]
impl CodexAppServerTargetResolver for AppRuntimeCodexTargetResolver {
    async fn resolve_codex_app_server_target(
        &self,
    ) -> Result<Option<CodexAppServerTarget>, ProviderError> {
        let connection = self
            .app_runtime
            .ensure_shared_codex()
            .await
            .map_err(|error| {
                ProviderError::new(
                    "AI_SESSION_PROVIDER_UNAVAILABLE",
                    format!("Codex app-server could not be started: {error}"),
                    503,
                )
            })?;
        Ok(Some(match connection.upstream {
            controlled_instance_app_runtime::codex_app_server::CodexAppServerUpstream::Unix {
                socket_path,
            } => CodexAppServerTarget::Unix { socket_path },
            controlled_instance_app_runtime::codex_app_server::CodexAppServerUpstream::WebSocket {
                endpoint,
                token_file,
            } => CodexAppServerTarget::WebSocket {
                endpoint,
                token_file,
            },
        }))
    }
}
