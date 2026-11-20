use super::{
    executor::{trigger_event_type_name, TriggerExecuteInput, TriggerExecutor},
    matcher::{
        default_ignored, resolve_path, root_within_workspace, workspace_relative_path,
        FileTriggerMatcher,
    },
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
    RenameAny,
}

#[derive(Debug, Clone)]
struct PendingWrite {
    last_change: Instant,
    previous_size: Option<u64>,
}

#[derive(Debug)]
struct FileChangeBatch {
    debounce: Duration,
    stability_threshold: Duration,
    changed: BTreeSet<String>,
    pending: BTreeMap<String, PendingWrite>,
    materialized: BTreeSet<String>,
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
            materialized: BTreeSet::new(),
            deadline: None,
            poll_at: None,
        }
    }

    fn observe_write(&mut self, path: String, now: Instant) {
        match self.pending.get_mut(&path) {
            Some(pending) => pending.last_change = now,
            None => {
                self.pending.insert(
                    path,
                    PendingWrite {
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
        self.pending.remove(&path);
        let was_materialized = self.materialized.remove(&path);
        if was_materialized {
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
            self.materialized.insert(path.to_string());
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
        if !self.pending.is_empty() {
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

fn seed_materialized_files(
    batch: &mut FileChangeBatch,
    roots: &[PathBuf],
    workspace: &Path,
    matcher: &FileTriggerMatcher,
) {
    let mut directories = roots.to_vec();
    while let Some(directory) = directories.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let Some(relative) = workspace_relative_path(workspace, &path) else {
                continue;
            };
            if file_type.is_dir() {
                if !default_ignored(&format!("{relative}/")) {
                    directories.push(path);
                }
            } else if file_type.is_file() && matcher.matches(&relative).unwrap_or(false) {
                batch.materialized.insert(relative);
            }
        }
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
        for root in &roots {
            if let Err(error) = watcher.watch(root, RecursiveMode::Recursive) {
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
            seed_materialized_files(&mut batch, &roots, &workspace, &matcher);
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
                            let observed = match observed {
                                ObservedFileEvent::RenameAny => {
                                    if tokio::fs::metadata(&path).await.is_ok() {
                                        ObservedFileEvent::Add
                                    } else {
                                        ObservedFileEvent::Remove
                                    }
                                }
                                observed => observed,
                            };
                            match observed {
                                ObservedFileEvent::Add | ObservedFileEvent::Change => {
                                    batch.observe_write(relative, Instant::now())
                                }
                                ObservedFileEvent::Remove => {
                                    batch.observe_remove(relative, Instant::now())
                                }
                                ObservedFileEvent::RenameAny => {
                                    unreachable!("rename resolved above")
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
        EventKind::Modify(ModifyKind::Name(_)) => ObservedFileEvent::RenameAny,
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
    use std::{
        path::Path,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex as StdMutex,
        },
    };
    use tokio::sync::Notify;

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
                completion_text: None,
            })
        }
    }

    #[derive(Clone)]
    struct GatedRecordingProvider {
        messages: Arc<StdMutex<Vec<String>>>,
        gate: Arc<Notify>,
        released: Arc<AtomicBool>,
    }

    #[async_trait::async_trait]
    impl AiSessionControlProvider for GatedRecordingProvider {
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
            if !self.released.swap(true, Ordering::SeqCst) {
                self.gate.notified().await;
            }
            Ok(ProviderAction {
                action: "send".to_string(),
                turn_id: Some("trigger-turn".to_string()),
                provider_turn_id: Some("provider-trigger-turn".to_string()),
                decision: None,
                queue_id: None,
                completion_text: None,
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

    fn null_if_absent(value: Option<&Value>) -> Value {
        value.cloned().unwrap_or(Value::Null)
    }

    fn normalized_run_id(run: &Value, ids: &mut BTreeMap<String, String>) -> String {
        let id = run["id"].as_str().expect("run id").to_string();
        let next = ids.len() + 1;
        ids.entry(id)
            .or_insert_with(|| format!("run_{next}"))
            .clone()
    }

    fn normalize_trigger_run(run: &Value, ids: &mut BTreeMap<String, String>) -> Value {
        let started_at = run["startedAt"].as_str().unwrap_or_default();
        let completed_at = run.get("completedAt").and_then(Value::as_str);
        serde_json::json!({
            "id": normalized_run_id(run, ids),
            "configHash": run["configHash"],
            "deploymentId": null_if_absent(run.get("deploymentId")),
            "instanceId": run["instanceId"],
            "eventType": run["eventType"],
            "status": run["status"],
            "target": {
                "type": run["target"]["type"],
                "aiSessionId": run["target"]["aiSessionId"],
            },
            "promptPreview": run["promptPreview"],
            "eventSummary": null_if_absent(run.get("eventSummary")),
            "error": null_if_absent(run.get("error")),
            "hasStartedAt": !started_at.is_empty(),
            "hasCompletedAt": completed_at.is_some(),
            "completedNotBeforeStarted": completed_at.map(|completed| completed >= started_at),
        })
    }

    fn normalize_trigger_runtime(runtime: &Value) -> Value {
        serde_json::json!({
            "configHash": runtime["configHash"],
            "deploymentId": null_if_absent(runtime.get("deploymentId")),
            "instanceId": runtime["instanceId"],
            "status": runtime["status"],
            "runCount": runtime["runCount"],
            "skippedCount": runtime["skippedCount"],
            "hasLastTriggeredAt": runtime.get("lastTriggeredAt").and_then(Value::as_str).is_some(),
            "hasLastCompletedAt": runtime.get("lastCompletedAt").and_then(Value::as_str).is_some(),
            "hasLastSkippedAt": runtime.get("lastSkippedAt").and_then(Value::as_str).is_some(),
            "lastError": null_if_absent(runtime.get("lastError")),
        })
    }

    fn normalize_trigger_index(index: &Value, ids: &mut BTreeMap<String, String>) -> Value {
        let configs = index["configs"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .map(|config| {
                serde_json::json!({
                    "configHash": config["configHash"],
                    "name": config["name"],
                    "description": null_if_absent(config.get("description")),
                    "source": config["source"],
                    "action": config["action"],
                    "policy": {
                        "cooldownMs": null_if_absent(config["policy"].get("cooldownMs")),
                        "maxConcurrentRuns": config["policy"]["maxConcurrentRuns"],
                        "whenBusy": config["policy"]["whenBusy"],
                    },
                })
            })
            .collect::<Vec<_>>();
        let deployments = index["deployments"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .map(|deployment| {
                serde_json::json!({
                    "configHash": deployment["configHash"],
                    "deploymentId": null_if_absent(deployment.get("deploymentId")),
                    "instanceId": deployment["instanceId"],
                    "origin": deployment["origin"],
                    "enabled": deployment["enabled"],
                    "target": {
                        "type": deployment["target"]["type"],
                        "aiSessionId": deployment["target"]["aiSessionId"],
                    },
                    "localName": null_if_absent(deployment.get("localName")),
                })
            })
            .collect::<Vec<_>>();
        let runtime = index["runtime"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .map(normalize_trigger_runtime)
            .collect::<Vec<_>>();
        let recent_runs = index["recentRuns"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .map(|run| normalize_trigger_run(run, ids))
            .collect::<Vec<_>>();
        serde_json::json!({
            "configs": configs,
            "deployments": deployments,
            "runtime": runtime,
            "recentRuns": recent_runs,
        })
    }

    fn normalize_trigger_event(event: &Value, ids: &mut BTreeMap<String, String>) -> Value {
        match event["type"].as_str().unwrap_or_default() {
            "trigger.run.started" => serde_json::json!({
                "type": event["type"],
                "configHash": event["data"]["configHash"],
                "deploymentId": null_if_absent(event["data"].get("deploymentId")),
                "eventType": event["data"]["eventType"],
            }),
            "trigger.run.completed" => serde_json::json!({
                "type": event["type"],
                "run": normalize_trigger_run(&event["data"]["run"], ids),
                "result": {
                    "provider": event["data"]["result"]["provider"],
                    "action": event["data"]["result"]["action"],
                    "sessionId": event["data"]["result"]["session"]["id"],
                    "turnId": null_if_absent(event["data"]["result"].get("turnId")),
                    "providerTurnId": null_if_absent(event["data"]["result"].get("providerTurnId")),
                    "hasQueueId": event["data"]["result"].get("queueId").and_then(Value::as_str).is_some(),
                },
            }),
            "trigger.run.failed" => serde_json::json!({
                "type": event["type"],
                "configHash": event["data"]["configHash"],
                "error": event["data"]["error"],
            }),
            "trigger.updated" => serde_json::json!({
                "type": event["type"],
                "index": normalize_trigger_index(&event["data"], ids),
            }),
            _ => serde_json::json!({
                "type": event["type"],
                "data": event["data"],
            }),
        }
    }

    async fn wait_for_trigger_event(events: &Arc<StdMutex<Vec<Value>>>, event_type: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if events
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .iter()
                    .any(|event| event["type"] == event_type)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("trigger event timeout");
    }

    async fn wait_for_message_count(messages: &Arc<StdMutex<Vec<String>>>, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if messages
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .len()
                    >= count
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("provider message timeout");
    }

    async fn wait_for_completed_count(events: &Arc<StdMutex<Vec<Value>>>, completed_count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if events
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .iter()
                    .filter(|event| event["type"] == "trigger.run.completed")
                    .count()
                    >= completed_count
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("completed trigger run timeout");
    }

    async fn wait_for_skipped_count(events: &Arc<StdMutex<Vec<Value>>>, skipped_count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if events
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .iter()
                    .filter(|event| event["type"] == "trigger.run.skipped")
                    .count()
                    >= skipped_count
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("skipped trigger run timeout");
    }

    fn manager_gated_snapshots(scenario: &Value) -> Vec<Value> {
        let snapshots = scenario["snapshots"].as_array().expect("snapshots").clone();
        let transitions = scenario["busyTransitions"].as_u64().unwrap_or_default() as usize;
        if transitions == 0 {
            return snapshots;
        }
        let initial = snapshots[0].clone();
        let running = snapshots[1].clone();
        let mut expanded = vec![initial, running.clone()];
        for index in 0..transitions {
            let mut snapshot = running.clone();
            let seconds = 2 + index;
            let updated_at = format!("2026-11-20T00:{:02}:{:02}.000Z", seconds / 60, seconds % 60);
            let session = snapshot["sessions"]
                .as_array_mut()
                .and_then(|sessions| sessions.first_mut())
                .expect("snapshot session");
            session["phase"] = Value::String(if index % 2 == 0 {
                "tool".to_string()
            } else {
                "thinking".to_string()
            });
            session["updatedAt"] = Value::String(updated_at.clone());
            snapshot["updatedAt"] = Value::String(updated_at);
            expanded.push(snapshot);
        }
        expanded
    }

    async fn wait_for_file_run(
        store: &TriggerStore,
        events: &Arc<StdMutex<Vec<Value>>>,
        count: usize,
    ) {
        let result = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let runs = store
                    .load()
                    .map(|index| index.recent_runs.len())
                    .unwrap_or_default();
                let completed = events
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .iter()
                    .filter(|event| event["type"] == "trigger.run.completed")
                    .count();
                if runs >= count && completed >= count {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        if result.is_err() {
            let runs = store
                .load()
                .map(|index| index.recent_runs.len())
                .unwrap_or_default();
            let completed = events
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .filter(|event| event["type"] == "trigger.run.completed")
                .count();
            panic!(
                "file trigger run timeout: expected {count}, runs={runs}, completed={completed}"
            );
        }
    }

    async fn execute_file_watcher_steps(
        scenario: &Value,
        store: &TriggerStore,
        events: &Arc<StdMutex<Vec<Value>>>,
        workspace: &Path,
    ) {
        tokio::time::sleep(Duration::from_millis(300)).await;
        for step in scenario["steps"].as_array().expect("steps") {
            let operation = step["operation"].as_str().expect("file operation");
            match operation {
                "write" | "append" | "write-many" => {
                    let single;
                    let writes = if operation == "write-many" {
                        step["writes"].as_array().expect("writes")
                    } else {
                        single = vec![step.clone()];
                        &single
                    };
                    for write in writes {
                        let file = workspace.join(write["path"].as_str().expect("write path"));
                        std::fs::create_dir_all(file.parent().expect("write parent"))
                            .expect("create write parent");
                        let content = write["content"].as_str().unwrap_or_default();
                        let append =
                            operation == "append" || write["append"].as_bool().unwrap_or(false);
                        if append {
                            let mut current = std::fs::read_to_string(&file).unwrap_or_default();
                            current.push_str(content);
                            std::fs::write(&file, current).expect("append file");
                        } else {
                            std::fs::write(&file, content).expect("write file");
                        }
                    }
                }
                "unlink" => {
                    std::fs::remove_file(
                        workspace.join(step["path"].as_str().expect("unlink path")),
                    )
                    .expect("unlink file");
                }
                "rename" => {
                    let from = workspace.join(step["path"].as_str().expect("rename source"));
                    let to = workspace.join(step["to"].as_str().expect("rename destination"));
                    std::fs::create_dir_all(to.parent().expect("rename parent"))
                        .expect("create rename parent");
                    std::fs::rename(from, to).expect("rename file");
                }
                "wait" => {
                    tokio::time::sleep(Duration::from_millis(
                        step["waitMs"].as_u64().expect("waitMs"),
                    ))
                    .await;
                }
                _ => panic!("unknown file watcher operation: {operation}"),
            }
            wait_for_file_run(
                store,
                events,
                step["waitForRuns"].as_u64().expect("waitForRuns") as usize,
            )
            .await;
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }

    fn stabilize_workspace_observation(
        value: Value,
        workspace: &Path,
        config_hashes: &mut BTreeMap<String, String>,
    ) -> Value {
        match value {
            Value::String(value) => {
                Value::String(value.replace(&workspace.display().to_string(), "{{workspace}}"))
            }
            Value::Array(values) => Value::Array(
                values
                    .into_iter()
                    .map(|value| stabilize_workspace_observation(value, workspace, config_hashes))
                    .collect(),
            ),
            Value::Object(values) => Value::Object(
                values
                    .into_iter()
                    .map(|(key, value)| {
                        if key == "configHash" {
                            let config_hash = value.as_str().unwrap_or_default().to_string();
                            if !config_hashes.contains_key(&config_hash) {
                                config_hashes.insert(
                                    config_hash.clone(),
                                    format!("config_{}", config_hashes.len() + 1),
                                );
                            }
                            (
                                key,
                                Value::String(
                                    config_hashes
                                        .get(&config_hash)
                                        .expect("stabilized config hash")
                                        .clone(),
                                ),
                            )
                        } else {
                            (
                                key,
                                stabilize_workspace_observation(value, workspace, config_hashes),
                            )
                        }
                    })
                    .collect(),
            ),
            value => value,
        }
    }

    async fn observe_trigger_execution_scenario(scenario: &Value) -> Value {
        let root = tempfile::tempdir().expect("tempdir");
        let data = root.path().join("data");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&data).expect("data");
        std::fs::create_dir_all(&workspace).expect("workspace");
        if let Some(files) = scenario["initialFiles"].as_object() {
            for (relative, content) in files {
                let file = workspace.join(relative);
                std::fs::create_dir_all(file.parent().expect("initial file parent"))
                    .expect("initial file parent");
                std::fs::write(file, content.as_str().unwrap_or_default()).expect("initial file");
            }
        }
        let runtime = Arc::new(AiSessionRuntime::new(
            "instance",
            Some(data.join("ai-sessions")),
        ));
        if scenario["providerSessionExists"].as_bool().unwrap_or(false) {
            for seed in scenario["sessions"].as_array().expect("sessions") {
                let session: AiSession = serde_json::from_value(seed.clone()).expect("session");
                runtime.save(session).expect("save session");
            }
        }
        let attachments = Arc::new(AiSessionConversationAttachmentStore::new(&data));
        let streams = Arc::new(attachments.draft_streams());
        let controller = AiSessionController::new(runtime, attachments, streams, None);
        let messages = Arc::new(StdMutex::new(Vec::new()));
        let gated = scenario["mode"] == "manager-gated";
        let gate = Arc::new(Notify::new());
        let released = Arc::new(AtomicBool::new(false));
        if gated {
            controller.register_provider(Arc::new(GatedRecordingProvider {
                messages: messages.clone(),
                gate: gate.clone(),
                released: released.clone(),
            }));
        } else {
            controller.register_provider(Arc::new(RecordingProvider {
                messages: messages.clone(),
            }));
        }
        let store = Arc::new(TriggerStore::new(data.join("triggers"), "instance"));
        let mut trigger_value = scenario["trigger"].clone();
        if scenario["mode"] == "file-watcher" {
            if let Some(roots) = trigger_value["source"]["roots"].as_array_mut() {
                for root in roots {
                    if root.as_str() == Some("{{workspace}}") {
                        *root = Value::String(workspace.display().to_string());
                    }
                }
            }
        }
        let create_input: TriggerCreateInput =
            serde_json::from_value(trigger_value).expect("trigger input");
        let created = store.create(create_input).expect("create trigger");
        let executor = Arc::new(TriggerExecutor::new(store.clone(), controller));
        let published = Arc::new(StdMutex::new(Vec::<Value>::new()));
        let mut ids = BTreeMap::new();

        if scenario["mode"] == "executor-drain" {
            executor.begin_drain();
            let error = executor
                .execute(TriggerExecuteInput {
                    config: created.config,
                    deployment: created.deployment,
                    event_type: TriggerEventType::Manual,
                    event_summary: Some("draining".to_string()),
                    prompt_override: Some("blocked".to_string()),
                })
                .await
                .expect_err("draining executor rejected work");
            executor.end_drain();
            return serde_json::json!({
                "id": scenario["id"],
                "errorCode": error.code(),
                "errorMessage": error.to_string(),
                "messages": messages
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
                "events": [],
                "index": normalize_trigger_index(
                    &serde_json::to_value(store.load().expect("reopen triggers")).expect("index"),
                    &mut ids,
                ),
            });
        }

        let sink = published.clone();
        let manager = TriggerManager::new(
            store.clone(),
            executor,
            &workspace,
            Arc::new(move |event_type: &str, payload: Value| {
                sink.lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(serde_json::json!({ "type": event_type, "data": payload }));
            }),
        );
        manager.start().expect("start manager");
        if scenario["mode"] == "schedule-accelerated" {
            for _ in 0..4 {
                tokio::task::yield_now().await;
            }
            tokio::time::advance(Duration::from_secs(8 * 24 * 60 * 60)).await;
            wait_for_completed_count(&published, 1).await;
            tokio::time::sleep(Duration::from_millis(80)).await;
            manager.stop();
            let events = published
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .map(|event| normalize_trigger_event(event, &mut ids))
                .collect::<Vec<_>>();
            return serde_json::json!({
                "id": scenario["id"],
                "messages": messages
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
                "eventSummaries": events
                    .iter()
                    .filter(|event| event["type"] == "trigger.run.completed")
                    .map(|event| event["run"]["eventSummary"].clone())
                    .collect::<Vec<_>>(),
                "events": events,
                "index": normalize_trigger_index(
                    &serde_json::to_value(store.load().expect("reopen triggers")).expect("index"),
                    &mut ids,
                ),
            });
        }
        if scenario["mode"] == "file-watcher" {
            execute_file_watcher_steps(scenario, &store, &published, &workspace).await;
            manager.stop();
            let raw_published = published
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let events = raw_published
                .iter()
                .map(|event| normalize_trigger_event(event, &mut ids))
                .collect::<Vec<_>>();
            let index = normalize_trigger_index(
                &serde_json::to_value(store.load().expect("reopen triggers")).expect("index"),
                &mut ids,
            );
            let observation = serde_json::json!({
                "id": scenario["id"],
                "messages": messages
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
                "eventSummaries": events
                    .iter()
                    .filter(|event| event["type"] == "trigger.run.completed")
                    .map(|event| event["run"]["eventSummary"].clone())
                    .collect::<Vec<_>>(),
                "events": events,
                "index": index,
            });
            let mut config_hashes = BTreeMap::new();
            return stabilize_workspace_observation(observation, &workspace, &mut config_hashes);
        }
        if gated {
            let snapshots = manager_gated_snapshots(scenario);
            let first: AiSessionsSnapshot =
                serde_json::from_value(snapshots[0].clone()).expect("initial snapshot");
            let running: AiSessionsSnapshot =
                serde_json::from_value(snapshots[1].clone()).expect("running snapshot");
            manager.handle_ai_sessions(&first);
            manager.handle_ai_sessions(&running);
            wait_for_message_count(&messages, 1).await;
            for snapshot in snapshots.iter().skip(2) {
                let snapshot: AiSessionsSnapshot =
                    serde_json::from_value(snapshot.clone()).expect("busy snapshot");
                manager.handle_ai_sessions(&snapshot);
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
            let runs_while_first_in_flight = store.load().expect("triggers").recent_runs.len();
            let messages_while_first_in_flight = messages
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .len();
            let index_while_first_in_flight = scenario["captureInFlightIndex"]
                .as_bool()
                .unwrap_or(false)
                .then(|| serde_json::to_value(store.load().expect("triggers")).expect("index"));
            let stop_before_release = scenario["stopBeforeRelease"].as_bool().unwrap_or(false);
            if stop_before_release {
                manager.stop();
                wait_for_skipped_count(
                    &published,
                    scenario["busyTransitions"].as_u64().unwrap_or_default() as usize,
                )
                .await;
            }
            gate.notify_one();
            let completed_runs = scenario["completedRuns"].as_u64().unwrap_or_default() as usize;
            wait_for_completed_count(&published, completed_runs).await;
            tokio::time::sleep(Duration::from_millis(80)).await;
            if !stop_before_release {
                manager.stop();
            }
            let raw_published = published
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let index_while_first_in_flight = index_while_first_in_flight
                .as_ref()
                .map(|index| normalize_trigger_index(index, &mut ids));
            let events = raw_published
                .iter()
                .map(|event| normalize_trigger_event(event, &mut ids))
                .collect::<Vec<_>>();
            let index = normalize_trigger_index(
                &serde_json::to_value(store.load().expect("reopen triggers")).expect("index"),
                &mut ids,
            );
            let completed_runs = events
                .iter()
                .filter(|event| event["type"] == "trigger.run.completed")
                .count();
            let skipped_runs = events
                .iter()
                .filter(|event| event["type"] == "trigger.run.skipped")
                .count();
            if scenario["observation"] == "summary" {
                return serde_json::json!({
                    "id": scenario["id"],
                    "messages": messages
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone(),
                    "completedRuns": completed_runs,
                    "skippedRuns": skipped_runs,
                    "runsWhileFirstInFlight": runs_while_first_in_flight,
                    "messagesWhileFirstInFlight": messages_while_first_in_flight,
                    "indexWhileFirstInFlight": index_while_first_in_flight.unwrap_or(Value::Null),
                    "eventTypes": events
                        .iter()
                        .map(|event| event["type"].clone())
                        .collect::<Vec<_>>(),
                    "completedEventRunIds": events
                        .iter()
                        .filter(|event| event["type"] == "trigger.run.completed")
                        .map(|event| event["run"]["id"].clone())
                        .collect::<Vec<_>>(),
                    "skippedReasons": raw_published
                        .iter()
                        .filter(|event| event["type"] == "trigger.run.skipped")
                        .map(|event| event["data"]["reason"].clone())
                        .collect::<Vec<_>>(),
                    "updateEventCount": events
                        .iter()
                        .filter(|event| event["type"] == "trigger.updated")
                        .count(),
                    "index": index,
                });
            }
            return serde_json::json!({
                "id": scenario["id"],
                "messages": messages
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
                "completedRuns": completed_runs,
                "skippedRuns": skipped_runs,
                "runsWhileFirstInFlight": runs_while_first_in_flight,
                "messagesWhileFirstInFlight": messages_while_first_in_flight,
                "events": events,
                "index": index,
            });
        }
        let snapshots = scenario["snapshots"].as_array().expect("snapshots");
        let mut runs_after_non_final_snapshots = Vec::new();
        for (index, snapshot) in snapshots.iter().enumerate() {
            let snapshot: AiSessionsSnapshot =
                serde_json::from_value(snapshot.clone()).expect("snapshot");
            if scenario["stopBeforeFinalTransition"]
                .as_bool()
                .unwrap_or(false)
                && index == snapshots.len() - 1
            {
                manager.stop();
            }
            manager.handle_ai_sessions(&snapshot);
            if index < snapshots.len() - 1 {
                tokio::time::sleep(Duration::from_millis(80)).await;
                runs_after_non_final_snapshots
                    .push(store.load().expect("triggers").recent_runs.len());
            }
        }
        wait_for_trigger_event(
            &published,
            scenario["waitForEventType"]
                .as_str()
                .unwrap_or("trigger.updated"),
        )
        .await;
        manager.stop();
        let published = published
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        serde_json::json!({
            "id": scenario["id"],
            "messages": messages
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "runsAfterNonFinalSnapshots": runs_after_non_final_snapshots,
            "events": published
                .iter()
                .map(|event| normalize_trigger_event(event, &mut ids))
                .collect::<Vec<_>>(),
            "index": normalize_trigger_index(
                &serde_json::to_value(store.load().expect("reopen triggers")).expect("index"),
                &mut ids,
            ),
        })
    }

    #[tokio::test]
    async fn trigger_execution_matches_shared_node_fixtures() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../instance/tests/fixtures/trigger-execution-parity.json"
        ))
        .expect("trigger fixtures");
        for scenario in fixtures["scenarios"].as_array().expect("scenarios") {
            if scenario["mode"] == "schedule-accelerated" {
                continue;
            }
            let actual = observe_trigger_execution_scenario(scenario).await;
            assert_eq!(
                actual, scenario["expected"],
                "trigger parity mismatch: {}",
                scenario["id"]
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn trigger_schedule_fixtures_advance_real_timers() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../instance/tests/fixtures/trigger-execution-parity.json"
        ))
        .expect("trigger fixtures");
        for scenario in fixtures["scenarios"]
            .as_array()
            .expect("scenarios")
            .iter()
            .filter(|scenario| scenario["mode"] == "schedule-accelerated")
        {
            let actual = observe_trigger_execution_scenario(scenario).await;
            assert_eq!(
                actual, scenario["expected"],
                "trigger schedule mismatch: {}",
                scenario["id"]
            );
        }
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
        batch.observe_write("src/main.rs".to_string(), now);
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
        batch.observe_write("quick.txt".to_string(), now);
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
            batch.observe_write(path.to_string(), now);
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
    fn unlink_emits_only_for_materialized_paths() {
        let now = Instant::now();
        let mut transient = FileChangeBatch::new(100);
        transient.observe_write("new.txt".to_string(), now);
        transient.observe_remove("new.txt".to_string(), now + Duration::from_millis(10));
        assert!(transient.take_due(now + Duration::from_secs(10)).is_none());

        let mut materialized = FileChangeBatch::new(100);
        materialized.observe_write("stable.txt".to_string(), now);
        materialized.poll_path("stable.txt", Some(1), now + Duration::from_millis(110));
        assert_eq!(
            materialized.take_due(now + Duration::from_millis(220)),
            Some(vec!["stable.txt".to_string()])
        );
        materialized.observe_write("stable.txt".to_string(), now + Duration::from_millis(300));
        materialized.observe_remove("stable.txt".to_string(), now + Duration::from_millis(310));
        assert_eq!(
            materialized.take_due(now + Duration::from_millis(420)),
            Some(vec!["stable.txt".to_string()])
        );

        let mut changed = FileChangeBatch::new(100);
        changed.materialized.insert("old.txt".to_string());
        changed.observe_write("old.txt".to_string(), now);
        changed.observe_remove("old.txt".to_string(), now + Duration::from_millis(10));
        assert_eq!(
            changed.take_due(now + Duration::from_millis(110)),
            Some(vec!["old.txt".to_string()])
        );
    }

    #[test]
    fn pending_writes_hold_the_batch_until_the_whole_change_is_stable() {
        let now = Instant::now();
        let mut batch = FileChangeBatch::new(100);
        batch.materialized.insert("old.ts".to_string());
        batch.observe_remove("old.ts".to_string(), now);
        batch.observe_write("new.ts".to_string(), now);
        assert!(batch.take_due(now + Duration::from_millis(100)).is_none());
        batch.poll_path("new.ts", Some(1), now + Duration::from_millis(100));
        assert!(batch.take_due(now + Duration::from_millis(150)).is_none());
        assert_eq!(
            batch.take_due(now + Duration::from_millis(210)),
            Some(vec!["new.ts".to_string(), "old.ts".to_string()])
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
                (path.clone(), ObservedFileEvent::Remove),
                (
                    PathBuf::from("/workspace/src/renamed.rs"),
                    ObservedFileEvent::Add
                )
            ]
        );
        let renamed_any =
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any))).add_path(path.clone());
        assert_eq!(
            observed_file_events(&renamed_any),
            [(path, ObservedFileEvent::RenameAny)]
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
