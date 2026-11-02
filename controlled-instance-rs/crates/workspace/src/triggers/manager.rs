use super::{
    executor::{trigger_event_type_name, TriggerExecuteInput, TriggerExecutor},
    matcher::{
        normalize_lexical, root_within_workspace, workspace_relative_path, FileTriggerMatcher,
    },
    schedule::{delay_until, next_schedule_time},
    scheduler::{Scheduler, SchedulerSkipReason, SubmitDecision},
    store::{source_matches_ai_session, TriggerStore, TriggerStoreError},
};
use controlled_instance_protocol::{
    AiSessionsSnapshot, TriggerConfig, TriggerDeployment, TriggerEventType, TriggerSource,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinHandle, time::Instant};

pub type TriggerPublisher = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct TriggerExecutionEvent {
    pub config: TriggerConfig,
    pub deployment: TriggerDeployment,
    pub event_type: TriggerEventType,
    pub event_summary: Option<String>,
}

struct WatchHandle {
    _watcher: RecommendedWatcher,
    task: JoinHandle<()>,
}

#[derive(Debug, Clone)]
struct AiSessionState {
    status: String,
    phase: String,
}

pub struct TriggerManager {
    store: Arc<TriggerStore>,
    executor: Arc<TriggerExecutor>,
    workspace: PathBuf,
    publisher: TriggerPublisher,
    scheduler: Scheduler<TriggerExecutionEvent>,
    timers: Mutex<HashMap<String, JoinHandle<()>>>,
    watches: Mutex<HashMap<String, WatchHandle>>,
    previous_ai_sessions: Mutex<HashMap<String, AiSessionState>>,
}

impl TriggerManager {
    pub fn new(
        store: Arc<TriggerStore>,
        executor: Arc<TriggerExecutor>,
        workspace: impl Into<PathBuf>,
        publish: TriggerPublisher,
    ) -> Arc<Self> {
        let workspace = workspace.into();
        let workspace = std::fs::canonicalize(&workspace).unwrap_or(workspace);
        Arc::new(Self {
            store,
            executor,
            workspace,
            publisher: publish,
            scheduler: Scheduler::new(),
            timers: Mutex::new(HashMap::new()),
            watches: Mutex::new(HashMap::new()),
            previous_ai_sessions: Mutex::new(HashMap::new()),
        })
    }

    pub fn start(self: &Arc<Self>) -> Result<(), TriggerStoreError> {
        self.stop();
        self.scheduler.start();
        let index = self.store.load()?;
        for deployment in index.deployments.iter().filter(|entry| entry.enabled) {
            let Some(config) = index
                .configs
                .iter()
                .find(|entry| entry.config_hash == deployment.config_hash)
                .cloned()
            else {
                continue;
            };
            match config.source {
                TriggerSource::Schedule { .. } => {
                    self.start_schedule(config, deployment.clone());
                }
                TriggerSource::FileChange { .. } => {
                    self.start_file_watch(config, deployment.clone());
                }
                TriggerSource::AiSession { .. } => {}
            }
        }
        Ok(())
    }

    pub fn restart(self: &Arc<Self>) -> Result<(), TriggerStoreError> {
        self.start()
    }

    pub fn stop(&self) {
        let queued = self.scheduler.stop();
        for (_, task) in self
            .timers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
        {
            task.abort();
        }
        for (_, handle) in self
            .watches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
        {
            handle.task.abort();
        }
        for execution in queued {
            self.skip(execution.event, SchedulerSkipReason::SchedulerStopped);
        }
    }

    pub fn set_draining(self: &Arc<Self>, draining: bool) -> Result<(), TriggerStoreError> {
        if draining {
            self.executor.begin_drain();
            self.stop();
            Ok(())
        } else {
            self.executor.end_drain();
            self.start()
        }
    }

    pub fn handle_ai_sessions(self: &Arc<Self>, snapshot: &AiSessionsSnapshot) {
        let current = snapshot
            .sessions
            .iter()
            .map(|session| {
                (
                    session.id.clone(),
                    AiSessionState {
                        status: session.status.clone(),
                        phase: session.phase.clone(),
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        let active_ids = current.keys().cloned().collect::<HashSet<_>>();
        match self.store.prune_missing_ai_session_deployments(&active_ids) {
            Ok(pruned) if !pruned.is_empty() => {
                if let Err(error) = self.restart() {
                    tracing::warn!(%error, "failed to restart triggers after pruning AI session deployments");
                }
                self.publish(
                    "trigger.deployment.pruned",
                    serde_json::json!({ "deployments": pruned }),
                );
                self.publish_index();
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(%error, "failed to prune missing AI session trigger deployments");
            }
        }
        let previous = self
            .previous_ai_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Ok(index) = self.store.load() else {
            return;
        };
        for deployment in index.deployments.iter().filter(|entry| entry.enabled) {
            let Some(config) = index
                .configs
                .iter()
                .find(|entry| entry.config_hash == deployment.config_hash)
                .cloned()
            else {
                continue;
            };
            if !matches!(config.source, TriggerSource::AiSession { .. }) {
                continue;
            }
            for session in &snapshot.sessions {
                let Some(before) = previous.get(&session.id) else {
                    continue;
                };
                if !source_matches_ai_session(&config.source, session) {
                    continue;
                }
                if before.status == session.status && before.phase == session.phase {
                    continue;
                }
                let summary = format!(
                    "AI session {}: {}/{} -> {}/{}",
                    session.id, before.status, before.phase, session.status, session.phase
                );
                self.submit(TriggerExecutionEvent {
                    config: config.clone(),
                    deployment: deployment.clone(),
                    event_type: TriggerEventType::AiSession,
                    event_summary: Some(summary),
                });
            }
        }
        *self
            .previous_ai_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = current;
    }

    fn start_schedule(self: &Arc<Self>, config: TriggerConfig, deployment: TriggerDeployment) {
        let key = deployment.key().to_string();
        let manager = Arc::downgrade(self);
        let task = match config.source.clone() {
            TriggerSource::Schedule {
                interval_ms: Some(interval_ms),
                ..
            } if interval_ms > 0 => tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(interval_ms));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let Some(manager) = manager.upgrade() else {
                        break;
                    };
                    manager.submit(TriggerExecutionEvent {
                        config: config.clone(),
                        deployment: deployment.clone(),
                        event_type: TriggerEventType::Schedule,
                        event_summary: Some(format!("Interval {interval_ms}ms")),
                    });
                }
            }),
            source @ TriggerSource::Schedule { .. } => tokio::spawn(async move {
                loop {
                    let Some(next) = next_schedule_time(&source, chrono::Utc::now()) else {
                        tracing::warn!(
                            "trigger schedule timezone could not be resolved; timer stopped"
                        );
                        break;
                    };
                    tokio::time::sleep(delay_until(next, chrono::Utc::now())).await;
                    let Some(manager) = manager.upgrade() else {
                        break;
                    };
                    manager.submit(TriggerExecutionEvent {
                        config: config.clone(),
                        deployment: deployment.clone(),
                        event_type: TriggerEventType::Schedule,
                        event_summary: source.schedule_summary(),
                    });
                }
            }),
            _ => return,
        };
        self.timers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, task);
    }

    fn start_file_watch(self: &Arc<Self>, config: TriggerConfig, deployment: TriggerDeployment) {
        let TriggerSource::FileChange {
            roots,
            globs,
            ignore,
            debounce_ms,
        } = config.source.clone()
        else {
            return;
        };
        let roots = roots
            .iter()
            .filter_map(|root| root_within_workspace(&self.workspace, root))
            .collect::<Vec<_>>();
        if roots.is_empty() {
            return;
        }
        let matcher = match FileTriggerMatcher::new(&globs, ignore.as_deref().unwrap_or_default()) {
            Ok(matcher) => matcher,
            Err(error) => {
                self.publish_watch_failed(&config, &deployment, &error);
                return;
            }
        };
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        });
        let mut watcher = match watcher {
            Ok(watcher) => watcher,
            Err(error) => {
                self.publish_watch_failed(&config, &deployment, &error.to_string());
                return;
            }
        };
        for root in roots {
            if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
                self.publish_watch_failed(&config, &deployment, &error.to_string());
                return;
            }
        }
        let workspace = normalize_lexical(&self.workspace);
        let manager = Arc::downgrade(self);
        let watch_key = deployment.key().to_string();
        let task = tokio::spawn(async move {
            let mut changed = BTreeSet::new();
            let mut deadline: Option<Instant> = None;
            loop {
                let wait = deadline
                    .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                    .unwrap_or_else(|| Duration::from_secs(3_600));
                match tokio::time::timeout(wait, receiver.recv()).await {
                    Ok(Some(Ok(event))) => {
                        for path in event.paths {
                            let Some(relative) = workspace_relative_path(&workspace, &path) else {
                                continue;
                            };
                            if !matches!(
                                event.kind,
                                notify::EventKind::Create(_)
                                    | notify::EventKind::Modify(_)
                                    | notify::EventKind::Remove(_)
                            ) || !matcher.matches(&relative)
                            {
                                continue;
                            }
                            changed.insert(relative);
                        }
                        if !changed.is_empty() {
                            deadline = Some(Instant::now() + Duration::from_millis(debounce_ms));
                        }
                    }
                    Ok(Some(Err(error))) => {
                        if let Some(manager) = manager.upgrade() {
                            manager.publish_watch_failed(&config, &deployment, &error.to_string());
                        }
                    }
                    Ok(None) => break,
                    Err(_) if !changed.is_empty() => {
                        let files = changed.iter().cloned().collect::<Vec<_>>();
                        changed.clear();
                        deadline = None;
                        let Some(manager) = manager.upgrade() else {
                            break;
                        };
                        manager.submit(TriggerExecutionEvent {
                            config: config.clone(),
                            deployment: deployment.clone(),
                            event_type: TriggerEventType::FileChange,
                            event_summary: Some(format!("Changed files:\n{}", files.join("\n"))),
                        });
                    }
                    Err(_) => {}
                }
            }
        });
        self.watches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                watch_key,
                WatchHandle {
                    _watcher: watcher,
                    task,
                },
            );
    }

    fn submit(self: &Arc<Self>, event: TriggerExecutionEvent) {
        let key = event.deployment.key().to_string();
        match self
            .scheduler
            .submit(key.clone(), event.clone(), event.config.policy.clone())
        {
            SubmitDecision::Started => self.spawn_execution(key, event),
            SubmitDecision::Queued => {}
            SubmitDecision::Skipped(reason) => self.skip(event, reason),
        }
    }

    fn spawn_execution(self: &Arc<Self>, key: String, event: TriggerExecutionEvent) {
        let manager = self.clone();
        tokio::spawn(async move {
            manager.execute_now(event).await;
            if let Some(next) = manager.scheduler.finish(&key) {
                manager.spawn_execution(key, next.event);
            }
        });
    }

    async fn execute_now(&self, event: TriggerExecutionEvent) {
        let mut started = Map::new();
        started.insert(
            "configHash".to_string(),
            Value::String(event.config.config_hash.clone()),
        );
        if let Some(deployment_id) = event.deployment.deployment_id.clone() {
            started.insert("deploymentId".to_string(), Value::String(deployment_id));
        }
        started.insert(
            "eventType".to_string(),
            Value::String(trigger_event_type_name(event.event_type).to_string()),
        );
        self.publish("trigger.run.started", Value::Object(started));
        match self
            .executor
            .execute(TriggerExecuteInput {
                config: event.config.clone(),
                deployment: event.deployment.clone(),
                event_type: event.event_type,
                event_summary: event.event_summary,
                prompt_override: None,
            })
            .await
        {
            Ok(result) => {
                self.publish(
                    "trigger.run.completed",
                    serde_json::to_value(result).unwrap_or(Value::Null),
                );
            }
            Err(error) => {
                self.publish(
                    "trigger.run.failed",
                    serde_json::json!({
                        "configHash": event.config.config_hash,
                        "error": error.to_string(),
                    }),
                );
            }
        }
        self.publish_index();
    }

    fn skip(&self, event: TriggerExecutionEvent, reason: SchedulerSkipReason) {
        if let Err(error) = self.store.skip_run(
            &event.config,
            &event.deployment,
            event.event_type,
            Some(reason.message().to_string()),
        ) {
            tracing::warn!(%error, "failed to persist a skipped trigger run");
        }
        let mut payload = Map::new();
        payload.insert(
            "configHash".to_string(),
            Value::String(event.config.config_hash.clone()),
        );
        if let Some(deployment_id) = event.deployment.deployment_id.clone() {
            payload.insert("deploymentId".to_string(), Value::String(deployment_id));
        }
        payload.insert(
            "reason".to_string(),
            Value::String(reason.as_str().to_string()),
        );
        self.publish("trigger.run.skipped", Value::Object(payload));
    }

    fn publish_index(&self) {
        match self.store.load() {
            Ok(index) => self.publish(
                "trigger.updated",
                serde_json::to_value(index).unwrap_or(Value::Null),
            ),
            Err(error) => tracing::warn!(%error, "failed to publish trigger index"),
        }
    }

    fn publish_watch_failed(
        &self,
        config: &TriggerConfig,
        deployment: &TriggerDeployment,
        error: &str,
    ) {
        let mut payload = Map::new();
        payload.insert(
            "configHash".to_string(),
            Value::String(config.config_hash.clone()),
        );
        if let Some(deployment_id) = deployment.deployment_id.clone() {
            payload.insert("deploymentId".to_string(), Value::String(deployment_id));
        }
        payload.insert("error".to_string(), Value::String(error.to_string()));
        self.publish("trigger.watch.failed", Value::Object(payload));
    }

    fn publish(&self, event_type: &str, payload: Value) {
        (self.publisher)(event_type, payload);
    }

    pub fn store(&self) -> &Arc<TriggerStore> {
        &self.store
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_ai_session::{
        AiSession, AiSessionControlProvider, AiSessionController,
        AiSessionConversationAttachmentStore, AiSessionRuntime, ProviderAction, ProviderError,
        ProviderMessage,
    };
    use controlled_instance_protocol::{
        AiSessionProviderActions, AiSessionProviderCapability,
        AiSessionProviderTimelineCapabilities, TriggerAction, TriggerCreateInput,
        TriggerDeploymentCreateInput, TriggerPolicyInput, TriggerRunStatus, TriggerRuntimeStatus,
        TriggerTarget,
    };
    use std::{path::Path, sync::Mutex as StdMutex};

    #[derive(Clone)]
    struct RecordingProvider {
        messages: Arc<StdMutex<Vec<String>>>,
    }

    #[async_trait::async_trait]
    impl AiSessionControlProvider for RecordingProvider {
        fn agent(&self) -> &str {
            "codex"
        }

        fn capability(&self) -> AiSessionProviderCapability {
            AiSessionProviderCapability {
                agent: "codex".to_string(),
                actions: AiSessionProviderActions {
                    send: true,
                    ..AiSessionProviderActions::default()
                },
                permission_modes: Vec::new(),
                timeline: AiSessionProviderTimelineCapabilities::default(),
                model_selection: None,
                reasoning_effort: None,
                hierarchy: None,
            }
        }

        async fn start_message(
            &self,
            _session: &AiSession,
            input: ProviderMessage,
        ) -> Result<ProviderAction, ProviderError> {
            self.messages
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(input.message);
            Ok(ProviderAction {
                action: "send".to_string(),
                turn_id: Some("trigger-turn".to_string()),
                provider_turn_id: Some("provider-trigger-turn".to_string()),
                decision: None,
                queue_id: None,
            })
        }
    }

    struct Fixture {
        _root: tempfile::TempDir,
        store: Arc<TriggerStore>,
        manager: Arc<TriggerManager>,
        messages: Arc<StdMutex<Vec<String>>>,
    }

    fn session(id: &str) -> AiSession {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "agent": "codex",
            "creationSource": "ai-session",
            "providerSessionId": "provider-thread",
            "title": "Trigger session",
            "cwd": "/workspace",
            "status": "idle",
            "phase": "unknown",
            "startedAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:00:00.000Z"
        }))
        .expect("session")
    }

    fn create_input(source: TriggerSource, target: &str, prompt: &str) -> TriggerCreateInput {
        TriggerCreateInput {
            name: "Trigger".to_string(),
            description: None,
            source,
            action: TriggerAction {
                prompt_template: prompt.to_string(),
            },
            policy: Some(TriggerPolicyInput::default()),
            deployment: Some(TriggerDeploymentCreateInput {
                deployment_id: None,
                origin: None,
                enabled: None,
                target: TriggerTarget::ai_session(target),
                local_name: None,
            }),
        }
    }

    async fn fixture(workspace: &Path) -> Fixture {
        let root = tempfile::tempdir().expect("tempdir");
        let data = root.path().join("data");
        std::fs::create_dir_all(&data).expect("data");
        let runtime = Arc::new(AiSessionRuntime::new(
            "instance",
            Some(data.join("ai-sessions")),
        ));
        runtime.save(session("ses_0000000000001")).expect("session");
        let attachments = Arc::new(AiSessionConversationAttachmentStore::new(&data));
        let streams = Arc::new(attachments.draft_streams());
        let controller = AiSessionController::new(runtime, attachments, streams, None);
        let messages = Arc::new(StdMutex::new(Vec::new()));
        controller.register_provider(Arc::new(RecordingProvider {
            messages: messages.clone(),
        }));
        let store = Arc::new(TriggerStore::new(data.join("triggers"), "instance"));
        let executor = Arc::new(TriggerExecutor::new(store.clone(), controller));
        let manager = TriggerManager::new(store.clone(), executor, workspace, Arc::new(|_, _| {}));
        manager.start().expect("start manager");
        Fixture {
            _root: root,
            store,
            manager,
            messages,
        }
    }

    async fn wait_for_runs(store: &TriggerStore, count: usize) {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if store.load().expect("store").recent_runs.len() >= count {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("trigger run timeout");
    }

    #[tokio::test]
    async fn file_watcher_uses_workspace_paths_globs_default_ignores_and_debounce() {
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::create_dir_all(workspace.path().join("src")).expect("src");
        let fixture = fixture(workspace.path()).await;
        fixture
            .store
            .create(create_input(
                TriggerSource::FileChange {
                    roots: vec![workspace.path().display().to_string()],
                    globs: vec!["**/*.rs".to_string()],
                    ignore: None,
                    debounce_ms: 100,
                },
                "ses_0000000000001",
                "Changed: {{event.summary}}",
            ))
            .expect("create trigger");
        fixture.manager.restart().expect("restart");
        std::fs::write(workspace.path().join("src/main.rs"), "fn main() {}\n").expect("write");
        wait_for_runs(&fixture.store, 1).await;
        let run = fixture.store.load().expect("store").recent_runs.remove(0);
        assert_eq!(run.event_type, TriggerEventType::FileChange);
        assert_eq!(run.status, TriggerRunStatus::Completed);
        assert_eq!(
            run.event_summary.as_deref(),
            Some("Changed files:\nsrc/main.rs")
        );
        assert!(fixture
            .messages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())[0]
            .contains("src/main.rs"));
        fixture.manager.stop();
    }

    #[tokio::test]
    async fn ai_session_filters_require_an_observed_status_or_phase_transition() {
        let workspace = tempfile::tempdir().expect("workspace");
        let fixture = fixture(workspace.path()).await;
        fixture
            .store
            .create(create_input(
                TriggerSource::AiSession {
                    agent: Some("codex".to_string()),
                    statuses: Some(vec![
                        controlled_instance_protocol::TriggerAiSessionStatus::Running,
                    ]),
                    phases: None,
                },
                "ses_0000000000001",
                "AI {{event.summary}}",
            ))
            .expect("create trigger");
        let idle = session("ses_0000000000001");
        let mut running = idle.clone();
        running.status = "running".to_string();
        running.phase = "thinking".to_string();
        fixture.manager.handle_ai_sessions(&snapshot(&idle));
        fixture.manager.handle_ai_sessions(&snapshot(&running));
        wait_for_runs(&fixture.store, 1).await;
        let run = fixture.store.load().expect("store").recent_runs.remove(0);
        assert_eq!(run.event_type, TriggerEventType::AiSession);
        assert!(run
            .event_summary
            .as_deref()
            .is_some_and(|value| value.contains("idle/unknown -> running/thinking")));
        fixture.manager.stop();
    }

    fn snapshot(session: &AiSession) -> AiSessionsSnapshot {
        AiSessionsSnapshot {
            running_count: u64::from(session.status == "running"),
            waiting_count: u64::from(session.status == "waiting"),
            stale_count: 0,
            sessions: vec![session.summary()],
            updated_at: "2026-11-02T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn runtime_status_and_run_filters_use_the_protocol_vocabulary() {
        assert_eq!(TriggerRuntimeStatus::default(), TriggerRuntimeStatus::Idle);
        assert_eq!(TriggerRunStatus::Started as u8, 0);
    }
}
