use super::{
    executor::{trigger_event_type_name, TriggerExecuteInput, TriggerExecutor},
    matcher::{resolve_path, root_within_workspace, workspace_relative_path, FileTriggerMatcher},
    schedule::{delay_until, next_schedule_time},
    scheduler::{Scheduler, SchedulerSkipReason, SubmitDecision},
    store::{source_matches_ai_session, TriggerStore, TriggerStoreError},
};
use controlled_instance_core::text::cmp_utf16;
use controlled_instance_protocol::{
    AiSessionsSnapshot, TriggerConfig, TriggerDeployment, TriggerEventType, TriggerSource,
};
use notify::{
    event::{CreateKind, ModifyKind, RemoveKind, RenameMode},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinHandle, time::Instant};

pub type TriggerPublisher = Arc<dyn Fn(&str, Value) + Send + Sync>;

const AWAIT_WRITE_FINISH_MAX_STABILITY: Duration = Duration::from_millis(500);
const AWAIT_WRITE_FINISH_POLL_INTERVAL: Duration = Duration::from_millis(50);
const IDLE_WATCH_WAIT: Duration = Duration::from_secs(3_600);

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ObservedFileEvent {
    Add,
    Change,
    Remove,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingWriteKind {
    Add,
    Change,
}

#[derive(Debug, Clone)]
struct PendingWrite {
    kind: PendingWriteKind,
    last_change: Instant,
    previous_size: Option<u64>,
}

#[derive(Debug)]
struct FileChangeBatch {
    debounce: Duration,
    stability_threshold: Duration,
    changed: BTreeSet<String>,
    pending: BTreeMap<String, PendingWrite>,
    deadline: Option<Instant>,
    poll_at: Option<Instant>,
}

impl FileChangeBatch {
    fn new(debounce_ms: u64) -> Self {
        Self {
            debounce: Duration::from_millis(debounce_ms),
            stability_threshold: Duration::from_millis(debounce_ms)
                .min(AWAIT_WRITE_FINISH_MAX_STABILITY),
            changed: BTreeSet::new(),
            pending: BTreeMap::new(),
            deadline: None,
            poll_at: None,
        }
    }

    fn observe_write(&mut self, path: String, kind: PendingWriteKind, now: Instant) {
        match self.pending.get_mut(&path) {
            Some(pending) => pending.last_change = now,
            None => {
                self.pending.insert(
                    path,
                    PendingWrite {
                        kind,
                        last_change: now,
                        previous_size: None,
                    },
                );
            }
        }
        if self.poll_at.is_none() {
            self.poll_at = Some(now + AWAIT_WRITE_FINISH_POLL_INTERVAL);
        }
    }

    fn observe_remove(&mut self, path: String, now: Instant) {
        let pending_kind = self.pending.remove(&path).map(|pending| pending.kind);
        if pending_kind != Some(PendingWriteKind::Add) {
            self.changed.insert(path);
            self.deadline = Some(now + self.debounce);
        }
        if self.pending.is_empty() {
            self.poll_at = None;
        }
    }

    fn pending_paths_due(&mut self, now: Instant) -> Vec<String> {
        if self.pending.is_empty() {
            self.poll_at = None;
            return Vec::new();
        }
        if self.poll_at.is_some_and(|poll_at| poll_at <= now) {
            self.poll_at = Some(now + AWAIT_WRITE_FINISH_POLL_INTERVAL);
            self.pending.keys().cloned().collect()
        } else {
            Vec::new()
        }
    }

    fn poll_path(&mut self, path: &str, size: Option<u64>, now: Instant) {
        let Some(pending) = self.pending.get_mut(path) else {
            return;
        };
        let Some(size) = size else {
            self.pending.remove(path);
            if self.pending.is_empty() {
                self.poll_at = None;
            }
            return;
        };
        if pending
            .previous_size
            .is_some_and(|previous| previous != size)
        {
            pending.last_change = now;
        }
        pending.previous_size = Some(size);
        if now.saturating_duration_since(pending.last_change) >= self.stability_threshold {
            self.pending.remove(path);
            self.changed.insert(path.to_string());
            self.deadline = Some(now + self.debounce);
            if self.pending.is_empty() {
                self.poll_at = None;
            }
        }
    }

    fn wait_duration(&self, now: Instant) -> Duration {
        self.deadline
            .into_iter()
            .chain(self.poll_at.filter(|_| !self.pending.is_empty()))
            .min()
            .map(|wake| wake.saturating_duration_since(now))
            .unwrap_or(IDLE_WATCH_WAIT)
    }

    fn take_due(&mut self, now: Instant) -> Option<Vec<String>> {
        if self.deadline.is_none_or(|deadline| deadline > now) {
            return None;
        }
        self.deadline = None;
        if self.changed.is_empty() {
            return None;
        }
        let mut changed = std::mem::take(&mut self.changed)
            .into_iter()
            .collect::<Vec<_>>();
        changed.sort_by(|left, right| cmp_utf16(left, right));
        Some(changed)
    }
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
        let workspace = resolve_path(&workspace).unwrap_or(workspace);
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
                    self.start_schedule(config, deployment.clone())?;
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

    fn start_schedule(
        self: &Arc<Self>,
        config: TriggerConfig,
        deployment: TriggerDeployment,
    ) -> Result<(), TriggerStoreError> {
        let key = deployment.key().to_string();
        let manager = Arc::downgrade(self);
        let task = match config.source.clone() {
            TriggerSource::Schedule {
                interval_ms: Some(interval_ms),
                ..
            } if interval_ms > 0 => tokio::spawn(async move {
                let mut interval = interval_schedule(interval_ms);
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
            source @ TriggerSource::Schedule { .. } => {
                let mut next =
                    next_schedule_time(&source, chrono::Utc::now()).map_err(|error| {
                        TriggerStoreError::Invalid(format!(
                            "Invalid trigger schedule {}: {error}",
                            config.config_hash
                        ))
                    })?;
                tokio::spawn(async move {
                    loop {
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
                        next = match next_schedule_time(&source, chrono::Utc::now()) {
                            Ok(next) => next,
                            Err(error) => {
                                tracing::error!(%error, "trigger schedule became invalid; timer stopped");
                                break;
                            }
                        };
                    }
                })
            }
            _ => return Ok(()),
        };
        self.timers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, task);
        Ok(())
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
        // notify may report canonical backend paths (for example /private/var) while
        // Node/chokidar keeps the path.resolve root spelling. Translate only at this
        // adapter boundary; root acceptance above remains lexical/pathWithin.
        let root_aliases = roots
            .iter()
            .map(|root| {
                (
                    std::fs::canonicalize(root).unwrap_or_else(|_| root.clone()),
                    root.clone(),
                )
            })
            .collect::<Vec<_>>();
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
                // Node's chokidar reports a per-root watch error and keeps the
                // remaining roots active instead of failing the deployment.
                self.publish_watch_failed(&config, &deployment, &error.to_string());
            }
        }
        let workspace = self.workspace.clone();
        let manager = Arc::downgrade(self);
        let watch_key = deployment.key().to_string();
        let task = tokio::spawn(async move {
            let mut batch = FileChangeBatch::new(debounce_ms);
            loop {
                let wait = batch.wait_duration(Instant::now());
                match tokio::time::timeout(wait, receiver.recv()).await {
                    Ok(Some(Ok(event))) => {
                        for (path, observed) in observed_file_events(&event) {
                            let path = remap_watched_path(&root_aliases, path);
                            let Some(relative) = workspace_relative_path(&workspace, &path) else {
                                continue;
                            };
                            if path_is_directory(&path).await {
                                continue;
                            }
                            match matcher.matches(&relative) {
                                Ok(true) => {}
                                Ok(false) => continue,
                                Err(error) => {
                                    if let Some(manager) = manager.upgrade() {
                                        manager.publish_watch_failed(&config, &deployment, &error);
                                    }
                                    continue;
                                }
                            }
                            match observed {
                                ObservedFileEvent::Add => batch.observe_write(
                                    relative,
                                    PendingWriteKind::Add,
                                    Instant::now(),
                                ),
                                ObservedFileEvent::Change => batch.observe_write(
                                    relative,
                                    PendingWriteKind::Change,
                                    Instant::now(),
                                ),
                                ObservedFileEvent::Remove => {
                                    batch.observe_remove(relative, Instant::now())
                                }
                            }
                        }
                    }
                    Ok(Some(Err(error))) => {
                        if let Some(manager) = manager.upgrade() {
                            manager.publish_watch_failed(&config, &deployment, &error.to_string());
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {}
                }
                let now = Instant::now();
                for relative in batch.pending_paths_due(now) {
                    let size = tokio::fs::metadata(workspace.join(&relative))
                        .await
                        .ok()
                        .filter(|metadata| metadata.is_file())
                        .map(|metadata| metadata.len());
                    batch.poll_path(&relative, size, Instant::now());
                }
                if let Some(files) = batch.take_due(Instant::now()) {
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

fn observed_file_events(event: &Event) -> Vec<(PathBuf, ObservedFileEvent)> {
    let kind = match &event.kind {
        EventKind::Create(CreateKind::Folder) => return Vec::new(),
        EventKind::Create(_) => ObservedFileEvent::Add,
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => ObservedFileEvent::Remove,
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => ObservedFileEvent::Add,
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            return event
                .paths
                .iter()
                .enumerate()
                .map(|(index, path)| {
                    (
                        path.clone(),
                        if index == 0 {
                            ObservedFileEvent::Remove
                        } else {
                            ObservedFileEvent::Add
                        },
                    )
                })
                .collect();
        }
        EventKind::Modify(_) => ObservedFileEvent::Change,
        EventKind::Remove(RemoveKind::Folder) => return Vec::new(),
        EventKind::Remove(_) => ObservedFileEvent::Remove,
        _ => return Vec::new(),
    };
    event
        .paths
        .iter()
        .cloned()
        .map(|path| (path, kind))
        .collect()
}

fn remap_watched_path(root_aliases: &[(PathBuf, PathBuf)], path: PathBuf) -> PathBuf {
    root_aliases
        .iter()
        .filter(|(physical, _)| path.starts_with(physical))
        .max_by_key(|(physical, _)| physical.components().count())
        .and_then(|(physical, lexical)| {
            path.strip_prefix(physical)
                .ok()
                .map(|relative| lexical.join(relative))
        })
        .unwrap_or(path)
}

fn interval_schedule(interval_ms: u64) -> tokio::time::Interval {
    let mut interval = tokio::time::interval(Duration::from_millis(interval_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval
}

async fn path_is_directory(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|metadata| metadata.is_dir())
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

    #[tokio::test]
    async fn interval_schedules_delay_instead_of_bursting_missed_ticks() {
        let interval = interval_schedule(1_000);
        assert_eq!(
            interval.missed_tick_behavior(),
            tokio::time::MissedTickBehavior::Delay
        );
    }

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

    #[tokio::test]
    async fn invalid_schedule_timezone_surfaces_an_error_and_does_not_start_a_fallback_timer() {
        let workspace = tempfile::tempdir().expect("workspace");
        let fixture = fixture(workspace.path()).await;
        fixture
            .store
            .create(create_input(
                TriggerSource::Schedule {
                    schedule_kind: controlled_instance_protocol::TriggerScheduleKind::Daily,
                    interval_ms: None,
                    time_of_day: Some("09:00".to_string()),
                    timezone: Some("Not/A_Timezone".to_string()),
                    weekdays: None,
                },
                "ses_0000000000001",
                "Scheduled run",
            ))
            .expect("create trigger");
        let error = fixture.manager.restart().expect_err("invalid timezone");
        assert!(error.to_string().contains("unknown timezone"));
        assert!(fixture.store.load().expect("store").recent_runs.is_empty());
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
    fn await_write_finish_waits_for_size_stability_before_debouncing() {
        let now = Instant::now();
        let mut batch = FileChangeBatch::new(1_500);
        assert_eq!(batch.stability_threshold, AWAIT_WRITE_FINISH_MAX_STABILITY);
        batch.observe_write("src/main.rs".to_string(), PendingWriteKind::Add, now);
        assert!(batch.take_due(now + Duration::from_secs(10)).is_none());

        assert!(batch
            .pending_paths_due(now + Duration::from_millis(49))
            .is_empty());
        assert_eq!(
            batch.pending_paths_due(now + Duration::from_millis(50)),
            ["src/main.rs"]
        );
        batch.poll_path("src/main.rs", Some(10), now + Duration::from_millis(50));
        batch.poll_path("src/main.rs", Some(10), now + Duration::from_millis(100));
        batch.poll_path("src/main.rs", Some(20), now + Duration::from_millis(150));
        batch.poll_path("src/main.rs", Some(20), now + Duration::from_millis(600));
        assert!(batch.take_due(now + Duration::from_millis(649)).is_none());

        batch.poll_path("src/main.rs", Some(20), now + Duration::from_millis(650));
        assert!(batch.take_due(now + Duration::from_millis(2_149)).is_none());
        assert_eq!(
            batch.take_due(now + Duration::from_millis(2_150)),
            Some(vec!["src/main.rs".to_string()])
        );
    }

    #[test]
    fn await_write_finish_uses_short_debounce_as_the_stability_threshold() {
        let now = Instant::now();
        let mut batch = FileChangeBatch::new(100);
        assert_eq!(batch.stability_threshold, Duration::from_millis(100));
        batch.observe_write("quick.txt".to_string(), PendingWriteKind::Change, now);
        batch.poll_path("quick.txt", Some(1), now + Duration::from_millis(50));
        batch.poll_path("quick.txt", Some(1), now + Duration::from_millis(100));
        assert_eq!(
            batch.take_due(now + Duration::from_millis(200)),
            Some(vec!["quick.txt".to_string()])
        );
    }

    #[test]
    fn due_paths_follow_javascript_utf16_sort_order() {
        let now = Instant::now();
        let mut batch = FileChangeBatch::new(0);
        for path in ["😀.txt", "\u{e000}.txt", "z.txt", "a.txt"] {
            batch.observe_write(path.to_string(), PendingWriteKind::Change, now);
        }
        for path in ["😀.txt", "\u{e000}.txt", "z.txt", "a.txt"] {
            batch.poll_path(path, Some(1), now);
        }
        assert_eq!(
            batch.take_due(now),
            Some(vec![
                "a.txt".to_string(),
                "z.txt".to_string(),
                "😀.txt".to_string(),
                "\u{e000}.txt".to_string(),
            ])
        );
    }

    #[test]
    fn unlink_cancels_pending_add_but_emits_for_pending_change() {
        let now = Instant::now();
        let mut added = FileChangeBatch::new(100);
        added.observe_write("new.txt".to_string(), PendingWriteKind::Add, now);
        added.observe_remove("new.txt".to_string(), now + Duration::from_millis(10));
        assert!(added.take_due(now + Duration::from_secs(10)).is_none());

        let mut changed = FileChangeBatch::new(100);
        changed.observe_write("old.txt".to_string(), PendingWriteKind::Change, now);
        changed.observe_remove("old.txt".to_string(), now + Duration::from_millis(10));
        assert_eq!(
            changed.take_due(now + Duration::from_millis(110)),
            Some(vec!["old.txt".to_string()])
        );
    }

    #[test]
    fn notify_events_match_chokidar_add_change_unlink_filtering() {
        let path = PathBuf::from("/workspace/src/main.rs");
        let add = Event::new(EventKind::Create(CreateKind::File)).add_path(path.clone());
        assert_eq!(
            observed_file_events(&add),
            [(path.clone(), ObservedFileEvent::Add)]
        );
        let folder = Event::new(EventKind::Create(CreateKind::Folder)).add_path(path.clone());
        assert!(observed_file_events(&folder).is_empty());
        let unlink = Event::new(EventKind::Remove(RemoveKind::File)).add_path(path.clone());
        assert_eq!(
            observed_file_events(&unlink),
            [(path.clone(), ObservedFileEvent::Remove)]
        );
        let access =
            Event::new(EventKind::Access(notify::event::AccessKind::Any)).add_path(path.clone());
        assert!(observed_file_events(&access).is_empty());

        let renamed = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(path.clone())
            .add_path(PathBuf::from("/workspace/src/renamed.rs"));
        assert_eq!(
            observed_file_events(&renamed),
            [
                (path, ObservedFileEvent::Remove),
                (
                    PathBuf::from("/workspace/src/renamed.rs"),
                    ObservedFileEvent::Add
                )
            ]
        );
    }

    #[test]
    fn canonical_watcher_paths_are_remapped_to_the_longest_lexical_root() {
        let aliases = [
            (
                PathBuf::from("/private/workspace"),
                PathBuf::from("/workspace"),
            ),
            (
                PathBuf::from("/private/workspace/project"),
                PathBuf::from("/workspace/project"),
            ),
        ];
        assert_eq!(
            remap_watched_path(
                &aliases,
                PathBuf::from("/private/workspace/project/src/main.rs")
            ),
            PathBuf::from("/workspace/project/src/main.rs")
        );
        assert_eq!(
            remap_watched_path(&aliases, PathBuf::from("/physical/other/main.rs")),
            PathBuf::from("/physical/other/main.rs")
        );
    }

    #[test]
    fn runtime_status_and_run_filters_use_the_protocol_vocabulary() {
        assert_eq!(TriggerRuntimeStatus::default(), TriggerRuntimeStatus::Idle);
        assert_eq!(TriggerRunStatus::Started as u8, 0);
    }
}
