use chrono::DateTime;
use controlled_instance_core::atomic::{read_json, write_json_atomic};
use controlled_instance_protocol::{
    mint_entity_id, TriggerAiSessionPhase, TriggerAiSessionStatus, TriggerConfig,
    TriggerCreateInput, TriggerDeployment, TriggerDeploymentOrigin, TriggerEntry, TriggerIndex,
    TriggerMutationResult, TriggerPatchInput, TriggerPolicy, TriggerPolicyInput, TriggerRun,
    TriggerRunStatus, TriggerRuntimeState, TriggerRuntimeStatus, TriggerScheduleKind,
    TriggerSnapshot, TriggerSnapshotConfig, TriggerSource, TriggerTarget, TriggerWhenBusy,
    MAX_TRIGGER_RECENT_RUNS, TRIGGER_SNAPSHOT_RECENT_RUNS,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TriggerStoreError {
    #[error("{0}")]
    Invalid(String),
    #[error("Trigger persistence failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Trigger persistence failed: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct TriggerStore {
    path: Arc<PathBuf>,
    instance_id: Arc<String>,
    mutation: Arc<Mutex<()>>,
}

impl TriggerStore {
    pub fn new(triggers_dir: impl AsRef<Path>, instance_id: impl Into<String>) -> Self {
        Self {
            path: Arc::new(triggers_dir.as_ref().join("index.json")),
            instance_id: Arc::new(instance_id.into()),
            mutation: Arc::new(Mutex::new(())),
        }
    }

    pub fn path(&self) -> &Path {
        self.path.as_path()
    }

    pub fn load(&self) -> Result<TriggerIndex, TriggerStoreError> {
        let raw = match read_json::<Value>(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(TriggerIndex::default());
            }
            Err(error) => return Err(error.into()),
        };
        Ok(sanitize_stored_trigger_index(raw))
    }

    pub fn snapshot(&self) -> Result<TriggerSnapshot, TriggerStoreError> {
        Ok(trigger_snapshot(self.load()?))
    }

    pub fn get(&self, config_hash: &str) -> Result<Option<TriggerEntry>, TriggerStoreError> {
        Ok(trigger_entry(&self.load()?, config_hash))
    }

    pub fn create(
        &self,
        input: TriggerCreateInput,
    ) -> Result<TriggerMutationResult, TriggerStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let timestamp = now_iso();
        let policy = normalize_policy(input.policy.clone().unwrap_or_default())?;
        let source = normalize_source(input.source)?;
        let action = normalize_action(input.action)?;
        let config_hash = trigger_config_hash(&source, &action, &policy);
        let config = normalize_config(TriggerConfig {
            config_hash: config_hash.clone(),
            name: input.name,
            description: input.description,
            source,
            action,
            policy,
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
        })?;
        let deployment_input = input.deployment.ok_or_else(|| {
            TriggerStoreError::Invalid("A trigger deployment is required.".to_string())
        })?;
        let deployment = normalize_deployment(TriggerDeployment {
            config_hash: config_hash.clone(),
            deployment_id: deployment_input.deployment_id,
            instance_id: self.instance_id.as_ref().clone(),
            origin: deployment_input
                .origin
                .unwrap_or(TriggerDeploymentOrigin::ControlledInstance),
            enabled: deployment_input.enabled.unwrap_or(true),
            target: deployment_input.target,
            local_name: deployment_input.local_name,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        })?;
        let runtime = runtime_for(&deployment);
        let mut index = self.load()?;
        if !index
            .configs
            .iter()
            .any(|entry| entry.config_hash == config_hash)
        {
            index.configs.push(config.clone());
        }
        index
            .deployments
            .retain(|entry| entry.key() != deployment.key());
        index.deployments.push(deployment.clone());
        index.runtime.retain(|entry| entry.key() != runtime.key());
        index.runtime.push(runtime.clone());
        self.save(index)?;
        Ok(TriggerMutationResult {
            config,
            deployment,
            runtime: Some(runtime),
        })
    }

    pub fn patch(
        &self,
        config_hash: &str,
        patch: TriggerPatchInput,
    ) -> Result<Option<TriggerConfig>, TriggerStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut index = self.load()?;
        let Some(existing) = index
            .configs
            .iter()
            .find(|entry| entry.config_hash == config_hash)
            .cloned()
        else {
            return Ok(None);
        };
        let mut updated = existing;
        if let Some(name) = patch.name {
            updated.name = name;
        }
        if let Some(description) = patch.description {
            updated.description = description;
        }
        updated.updated_at = now_iso();
        let updated = normalize_config(updated)?;
        for entry in &mut index.configs {
            if entry.config_hash == config_hash {
                *entry = updated.clone();
            }
        }
        self.save(index)?;
        Ok(Some(updated))
    }

    pub fn set_enabled(
        &self,
        config_hash: &str,
        enabled: bool,
    ) -> Result<Option<TriggerEntry>, TriggerStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut index = self.load()?;
        let timestamp = now_iso();
        let mut changed = false;
        for deployment in &mut index.deployments {
            if deployment.config_hash == config_hash {
                deployment.enabled = enabled;
                deployment.updated_at = timestamp.clone();
                changed = true;
            }
        }
        if !changed {
            return Ok(None);
        }
        for runtime in &mut index.runtime {
            if runtime.config_hash == config_hash {
                runtime.status = if enabled {
                    TriggerRuntimeStatus::Idle
                } else {
                    TriggerRuntimeStatus::Disabled
                };
            }
        }
        self.save(index.clone())?;
        Ok(trigger_entry(&index, config_hash))
    }

    pub fn delete(&self, config_hash: &str) -> Result<bool, TriggerStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut index = self.load()?;
        if !index
            .configs
            .iter()
            .any(|entry| entry.config_hash == config_hash)
        {
            return Ok(false);
        }
        index
            .configs
            .retain(|entry| entry.config_hash != config_hash);
        index
            .deployments
            .retain(|entry| entry.config_hash != config_hash);
        index
            .runtime
            .retain(|entry| entry.config_hash != config_hash);
        index
            .recent_runs
            .retain(|entry| entry.config_hash != config_hash);
        self.save(index)?;
        Ok(true)
    }

    pub fn delete_deployment(
        &self,
        config_hash: &str,
        deployment_id: &str,
    ) -> Result<bool, TriggerStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut index = self.load()?;
        if !index
            .deployments
            .iter()
            .any(|entry| entry.config_hash == config_hash && entry.key() == deployment_id)
        {
            return Ok(false);
        }
        index
            .deployments
            .retain(|entry| !(entry.config_hash == config_hash && entry.key() == deployment_id));
        let has_remaining = index
            .deployments
            .iter()
            .any(|entry| entry.config_hash == config_hash);
        if !has_remaining {
            index
                .configs
                .retain(|entry| entry.config_hash != config_hash);
        }
        index
            .runtime
            .retain(|entry| !(entry.config_hash == config_hash && entry.key() == deployment_id));
        self.save(index)?;
        Ok(true)
    }

    pub fn prune_missing_ai_session_deployments(
        &self,
        active_session_ids: &std::collections::HashSet<String>,
    ) -> Result<Vec<TriggerDeployment>, TriggerStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut index = self.load()?;
        let stale = index
            .deployments
            .iter()
            .filter(|entry| {
                entry.target.target_type == "ai-session"
                    && !active_session_ids.contains(&entry.target.ai_session_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        if stale.is_empty() {
            return Ok(stale);
        }
        let stale_keys = stale
            .iter()
            .map(|entry| entry.key().to_string())
            .collect::<std::collections::HashSet<_>>();
        index
            .deployments
            .retain(|entry| !stale_keys.contains(entry.key()));
        let remaining_configs = index
            .deployments
            .iter()
            .map(|entry| entry.config_hash.clone())
            .collect::<std::collections::HashSet<_>>();
        index
            .configs
            .retain(|entry| remaining_configs.contains(&entry.config_hash));
        index
            .runtime
            .retain(|entry| !stale_keys.contains(entry.key()));
        self.save(index)?;
        Ok(stale)
    }

    pub fn start_run(
        &self,
        config: &TriggerConfig,
        deployment: &TriggerDeployment,
        event_type: controlled_instance_protocol::TriggerEventType,
        event_summary: Option<String>,
    ) -> Result<TriggerRun, TriggerStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let started_at = now_iso();
        let run = normalize_run(TriggerRun {
            id: mint_entity_id("run"),
            config_hash: config.config_hash.clone(),
            deployment_id: deployment.deployment_id.clone(),
            instance_id: deployment.instance_id.clone(),
            event_type,
            status: TriggerRunStatus::Started,
            target: deployment.target.clone(),
            prompt_preview: prompt_preview(&config.action.prompt_template),
            event_summary,
            error: None,
            started_at: started_at.clone(),
            completed_at: None,
        })?;
        let mut index = self.load()?;
        let runtime = upsert_runtime(
            &index,
            deployment,
            RuntimePatch {
                status: Some(TriggerRuntimeStatus::Running),
                last_triggered_at: Some(Some(started_at)),
                ..RuntimePatch::default()
            },
        );
        index.runtime = runtime;
        index.recent_runs.insert(0, run.clone());
        index.recent_runs.truncate(MAX_TRIGGER_RECENT_RUNS);
        self.save(index)?;
        Ok(run)
    }

    pub fn complete_run(
        &self,
        run: &TriggerRun,
        error: Option<&str>,
    ) -> Result<Option<TriggerRun>, TriggerStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let completed_at = now_iso();
        let mut index = self.load()?;
        let mut completed = None;
        for entry in &mut index.recent_runs {
            if entry.id != run.id {
                continue;
            }
            entry.status = if error.is_some() {
                TriggerRunStatus::Failed
            } else {
                TriggerRunStatus::Completed
            };
            entry.error = error.map(ToString::to_string);
            entry.completed_at = Some(completed_at.clone());
            *entry = normalize_run(entry.clone())?;
            completed = Some(entry.clone());
        }
        let deployment = index.deployments.iter().find(|entry| {
            entry.config_hash == run.config_hash
                && entry.key() == run.deployment_id.as_deref().unwrap_or(&run.config_hash)
        });
        if let Some(deployment) = deployment.cloned() {
            let run_count = index
                .runtime
                .iter()
                .find(|entry| entry.key() == deployment.key())
                .map(|entry| entry.run_count)
                .unwrap_or_default()
                + 1;
            index.runtime = upsert_runtime(
                &index,
                &deployment,
                RuntimePatch {
                    status: Some(if error.is_some() {
                        TriggerRuntimeStatus::Error
                    } else if deployment.enabled {
                        TriggerRuntimeStatus::Idle
                    } else {
                        TriggerRuntimeStatus::Disabled
                    }),
                    last_completed_at: Some(Some(completed_at)),
                    last_error: Some(error.map(ToString::to_string)),
                    run_count: Some(run_count),
                    ..RuntimePatch::default()
                },
            );
        }
        self.save(index)?;
        Ok(completed)
    }

    pub fn skip_run(
        &self,
        config: &TriggerConfig,
        deployment: &TriggerDeployment,
        event_type: controlled_instance_protocol::TriggerEventType,
        event_summary: Option<String>,
    ) -> Result<TriggerRun, TriggerStoreError> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let skipped_at = now_iso();
        let run = normalize_run(TriggerRun {
            id: mint_entity_id("run"),
            config_hash: config.config_hash.clone(),
            deployment_id: deployment.deployment_id.clone(),
            instance_id: deployment.instance_id.clone(),
            event_type,
            status: TriggerRunStatus::Skipped,
            target: deployment.target.clone(),
            prompt_preview: prompt_preview(&config.action.prompt_template),
            event_summary,
            error: None,
            started_at: skipped_at.clone(),
            completed_at: Some(skipped_at.clone()),
        })?;
        let mut index = self.load()?;
        let skipped_count = index
            .runtime
            .iter()
            .find(|entry| entry.key() == deployment.key())
            .map(|entry| entry.skipped_count)
            .unwrap_or_default()
            + 1;
        index.runtime = upsert_runtime(
            &index,
            deployment,
            RuntimePatch {
                status: Some(if deployment.enabled {
                    TriggerRuntimeStatus::Idle
                } else {
                    TriggerRuntimeStatus::Disabled
                }),
                last_skipped_at: Some(Some(skipped_at)),
                skipped_count: Some(skipped_count),
                ..RuntimePatch::default()
            },
        );
        index.recent_runs.insert(0, run.clone());
        index.recent_runs.truncate(MAX_TRIGGER_RECENT_RUNS);
        self.save(index)?;
        Ok(run)
    }

    pub fn primary_deployment(
        &self,
        config_hash: &str,
    ) -> Result<Option<TriggerDeployment>, TriggerStoreError> {
        Ok(self
            .load()?
            .deployments
            .into_iter()
            .find(|entry| entry.config_hash == config_hash))
    }

    fn save(&self, index: TriggerIndex) -> Result<(), TriggerStoreError> {
        let index = validate_index(index)?;
        write_json_atomic(&self.path, &index, Some(0o600))?;
        Ok(())
    }
}

pub fn trigger_entry(index: &TriggerIndex, config_hash: &str) -> Option<TriggerEntry> {
    let config = index
        .configs
        .iter()
        .find(|entry| entry.config_hash == config_hash)?
        .clone();
    Some(TriggerEntry {
        config,
        deployments: index
            .deployments
            .iter()
            .filter(|entry| entry.config_hash == config_hash)
            .cloned()
            .collect(),
        runtime: index
            .runtime
            .iter()
            .filter(|entry| entry.config_hash == config_hash)
            .cloned()
            .collect(),
        recent_runs: index
            .recent_runs
            .iter()
            .filter(|entry| entry.config_hash == config_hash)
            .cloned()
            .collect(),
    })
}

pub fn trigger_snapshot(index: TriggerIndex) -> TriggerSnapshot {
    TriggerSnapshot {
        enabled_count: index
            .deployments
            .iter()
            .filter(|entry| entry.enabled)
            .count(),
        running_count: index
            .runtime
            .iter()
            .filter(|entry| entry.status == TriggerRuntimeStatus::Running)
            .count(),
        error_count: index
            .runtime
            .iter()
            .filter(|entry| entry.status == TriggerRuntimeStatus::Error)
            .count(),
        configs: index
            .configs
            .iter()
            .map(|config| TriggerSnapshotConfig {
                config_hash: config.config_hash.clone(),
                config: config.clone(),
                deployments: index
                    .deployments
                    .iter()
                    .filter(|entry| entry.config_hash == config.config_hash)
                    .cloned()
                    .collect(),
                runtime: index
                    .runtime
                    .iter()
                    .filter(|entry| entry.config_hash == config.config_hash)
                    .cloned()
                    .collect(),
            })
            .collect(),
        recent_runs: index
            .recent_runs
            .into_iter()
            .take(TRIGGER_SNAPSHOT_RECENT_RUNS)
            .collect(),
    }
}

pub fn trigger_config_hash(
    source: &TriggerSource,
    action: &controlled_instance_protocol::TriggerAction,
    policy: &TriggerPolicy,
) -> String {
    let value = serde_json::json!({
        "source": source,
        "action": action,
        "policy": policy,
    });
    let canonical = canonicalize(value);
    let encoded = serde_json::to_vec(&canonical).expect("canonical trigger hash input serializes");
    let hash = Sha256::digest(encoded);
    format!("trg_{}", &hex::encode(hash)[..24])
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, canonicalize(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect::<Map<_, _>>(),
        ),
        other => other,
    }
}

pub fn sanitize_stored_trigger_index(input: Value) -> TriggerIndex {
    let Some(source) = input.as_object() else {
        tracing::warn!("historical trigger index was invalid and was replaced with an empty index");
        return TriggerIndex::default();
    };
    let configs = source
        .get("configs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            serde_json::from_value::<TriggerConfig>(sanitize_config_value(entry))
                .ok()
                .and_then(|config| normalize_config(config).ok())
        })
        .collect::<Vec<_>>();
    let deployments = source
        .get("deployments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry.pointer("/target/type").and_then(Value::as_str) != Some("conversation")
        })
        .filter_map(|entry| {
            serde_json::from_value::<TriggerDeployment>(sanitize_deployment_value(entry))
                .ok()
                .and_then(|deployment| normalize_deployment(deployment).ok())
        })
        .collect::<Vec<_>>();
    let deployment_keys = deployments
        .iter()
        .map(|entry| entry.key().to_string())
        .collect::<std::collections::HashSet<_>>();
    let runtime = source
        .get("runtime")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = prune_object(
                entry,
                &[
                    "configHash",
                    "deploymentId",
                    "instanceId",
                    "status",
                    "lastTriggeredAt",
                    "lastCompletedAt",
                    "lastSkippedAt",
                    "lastError",
                    "runCount",
                    "skippedCount",
                ],
            );
            serde_json::from_value::<TriggerRuntimeState>(Value::Object(entry))
                .ok()
                .and_then(|runtime| {
                    deployment_keys
                        .contains(runtime.key())
                        .then(|| normalize_runtime(runtime).ok())
                        .flatten()
                })
        })
        .collect::<Vec<_>>();
    let recent_runs = source
        .get("recentRuns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry.pointer("/target/type").and_then(Value::as_str) != Some("conversation")
        })
        .filter_map(|entry| {
            serde_json::from_value::<TriggerRun>(sanitize_run_value(entry))
                .ok()
                .and_then(|run| normalize_run(run).ok())
        })
        .collect::<Vec<_>>();
    let known = [
        "schemaVersion",
        "configs",
        "deployments",
        "runtime",
        "recentRuns",
    ];
    if source.keys().any(|key| !known.contains(&key.as_str())) {
        tracing::warn!("historical trigger index contained unknown fields; they were ignored");
    }
    TriggerIndex {
        schema_version: 1,
        configs,
        deployments,
        runtime,
        recent_runs,
    }
}

fn sanitize_config_value(value: &Value) -> Value {
    let mut config = prune_object(
        value,
        &[
            "configHash",
            "name",
            "description",
            "createdAt",
            "updatedAt",
        ],
    );
    let source = value.get("source").map(sanitize_source_value);
    let action = value
        .get("action")
        .map(|action| prune_object(action, &["promptTemplate"]));
    let policy = value
        .get("policy")
        .map(|policy| prune_object(policy, &["cooldownMs", "maxConcurrentRuns", "whenBusy"]));
    if let Some(source) = source {
        config.insert("source".to_string(), source);
    }
    if let Some(action) = action {
        config.insert("action".to_string(), Value::Object(action));
    }
    if let Some(policy) = policy {
        config.insert("policy".to_string(), Value::Object(policy));
    }
    Value::Object(config)
}

fn sanitize_source_value(value: &Value) -> Value {
    match value.get("type").and_then(Value::as_str) {
        Some("schedule") => Value::Object(prune_object(
            value,
            &[
                "type",
                "scheduleKind",
                "intervalMs",
                "timeOfDay",
                "timezone",
                "weekdays",
            ],
        )),
        Some("file-change") => Value::Object(prune_object(
            value,
            &["type", "roots", "globs", "ignore", "debounceMs"],
        )),
        Some("ai-session") => Value::Object(prune_object(
            value,
            &["type", "agent", "statuses", "phases"],
        )),
        _ => value.clone(),
    }
}

fn sanitize_deployment_value(value: &Value) -> Value {
    let mut deployment = prune_object(
        value,
        &[
            "configHash",
            "deploymentId",
            "instanceId",
            "origin",
            "enabled",
            "localName",
            "createdAt",
            "updatedAt",
        ],
    );
    if let Some(target) = value.get("target") {
        deployment.insert(
            "target".to_string(),
            Value::Object(prune_object(target, &["type", "aiSessionId"])),
        );
    }
    Value::Object(deployment)
}

fn sanitize_run_value(value: &Value) -> Value {
    let mut run = prune_object(
        value,
        &[
            "id",
            "configHash",
            "deploymentId",
            "instanceId",
            "eventType",
            "status",
            "promptPreview",
            "eventSummary",
            "error",
            "startedAt",
            "completedAt",
        ],
    );
    if let Some(target) = value.get("target") {
        run.insert(
            "target".to_string(),
            Value::Object(prune_object(target, &["type", "aiSessionId"])),
        );
    }
    Value::Object(run)
}

fn prune_object(value: &Value, keys: &[&str]) -> Map<String, Value> {
    let Some(object) = value.as_object() else {
        return Map::new();
    };
    keys.iter()
        .filter_map(|key| {
            object
                .get(*key)
                .cloned()
                .map(|value| ((*key).to_string(), value))
        })
        .collect()
}

fn validate_index(index: TriggerIndex) -> Result<TriggerIndex, TriggerStoreError> {
    Ok(TriggerIndex {
        schema_version: 1,
        configs: index
            .configs
            .into_iter()
            .map(normalize_config)
            .collect::<Result<_, _>>()?,
        deployments: index
            .deployments
            .into_iter()
            .map(normalize_deployment)
            .collect::<Result<_, _>>()?,
        runtime: index
            .runtime
            .into_iter()
            .map(normalize_runtime)
            .collect::<Result<_, _>>()?,
        recent_runs: index
            .recent_runs
            .into_iter()
            .map(normalize_run)
            .collect::<Result<_, _>>()?,
    })
}

fn normalize_policy(input: TriggerPolicyInput) -> Result<TriggerPolicy, TriggerStoreError> {
    let policy = TriggerPolicy {
        cooldown_ms: input.cooldown_ms,
        max_concurrent_runs: input.max_concurrent_runs.unwrap_or(1),
        when_busy: input.when_busy.unwrap_or(TriggerWhenBusy::Skip),
    };
    if !(1..=20).contains(&policy.max_concurrent_runs) {
        return Err(invalid(
            "policy.maxConcurrentRuns must be between 1 and 20.",
        ));
    }
    if policy.cooldown_ms.is_some_and(|value| value > 86_400_000) {
        return Err(invalid("policy.cooldownMs must be at most 86400000."));
    }
    Ok(policy)
}

pub fn normalize_config(mut config: TriggerConfig) -> Result<TriggerConfig, TriggerStoreError> {
    config.config_hash = required_text(&config.config_hash, 8, 80, "configHash")?;
    config.name = required_text(&config.name, 1, 160, "name")?;
    config.description = config
        .description
        .map(|value| trimmed_text(&value, 1_000, "description"))
        .transpose()?;
    config.source = normalize_source(config.source)?;
    config.action = normalize_action(config.action)?;
    if !(1..=20).contains(&config.policy.max_concurrent_runs) {
        return Err(invalid(
            "policy.maxConcurrentRuns must be between 1 and 20.",
        ));
    }
    if config
        .policy
        .cooldown_ms
        .is_some_and(|value| value > 86_400_000)
    {
        return Err(invalid("policy.cooldownMs must be at most 86400000."));
    }
    validate_datetime(&config.created_at, "createdAt")?;
    validate_datetime(&config.updated_at, "updatedAt")?;
    Ok(config)
}

pub fn normalize_source(source: TriggerSource) -> Result<TriggerSource, TriggerStoreError> {
    match source {
        TriggerSource::Schedule {
            schedule_kind,
            interval_ms,
            time_of_day,
            timezone,
            weekdays,
        } => match schedule_kind {
            TriggerScheduleKind::Interval => {
                if time_of_day.is_some() || timezone.is_some() || weekdays.is_some() {
                    return Err(invalid(
                        "source contains fields that are invalid for an interval schedule.",
                    ));
                }
                let interval_ms =
                    interval_ms.ok_or_else(|| invalid("source.intervalMs is required."))?;
                if interval_ms < 1_000 {
                    return Err(invalid("source.intervalMs must be at least 1000."));
                }
                Ok(TriggerSource::Schedule {
                    schedule_kind,
                    interval_ms: Some(interval_ms),
                    time_of_day: None,
                    timezone: None,
                    weekdays: None,
                })
            }
            TriggerScheduleKind::Daily => {
                if interval_ms.is_some() || weekdays.is_some() {
                    return Err(invalid(
                        "source contains fields that are invalid for a daily schedule.",
                    ));
                }
                let time_of_day = normalize_time_of_day(time_of_day)?;
                let timezone = required_text(
                    timezone.as_deref().unwrap_or_default(),
                    1,
                    120,
                    "source.timezone",
                )?;
                Ok(TriggerSource::Schedule {
                    schedule_kind,
                    interval_ms: None,
                    time_of_day: Some(time_of_day),
                    timezone: Some(timezone),
                    weekdays: None,
                })
            }
            TriggerScheduleKind::Weekly => {
                if interval_ms.is_some() {
                    return Err(invalid(
                        "source contains fields that are invalid for a weekly schedule.",
                    ));
                }
                let time_of_day = normalize_time_of_day(time_of_day)?;
                let timezone = required_text(
                    timezone.as_deref().unwrap_or_default(),
                    1,
                    120,
                    "source.timezone",
                )?;
                let weekdays = weekdays.ok_or_else(|| invalid("source.weekdays is required."))?;
                if weekdays.is_empty() || weekdays.len() > 7 || weekdays.iter().any(|day| *day > 6)
                {
                    return Err(invalid(
                        "source.weekdays must contain 1 to 7 values from 0 to 6.",
                    ));
                }
                Ok(TriggerSource::Schedule {
                    schedule_kind,
                    interval_ms: None,
                    time_of_day: Some(time_of_day),
                    timezone: Some(timezone),
                    weekdays: Some(weekdays),
                })
            }
        },
        TriggerSource::FileChange {
            roots,
            globs,
            ignore,
            debounce_ms,
        } => {
            if roots.is_empty() || roots.len() > 50 {
                return Err(invalid("source.roots must contain 1 to 50 paths."));
            }
            if globs.is_empty() || globs.len() > 100 {
                return Err(invalid("source.globs must contain 1 to 100 patterns."));
            }
            if !(100..=60_000).contains(&debounce_ms) {
                return Err(invalid("source.debounceMs must be between 100 and 60000."));
            }
            let roots = roots
                .iter()
                .map(|value| required_text(value, 1, 4_096, "source.roots"))
                .collect::<Result<Vec<_>, _>>()?;
            let globs = globs
                .iter()
                .map(|value| required_text(value, 1, 500, "source.globs"))
                .collect::<Result<Vec<_>, _>>()?;
            let ignore = ignore
                .map(|values| {
                    if values.len() > 100 {
                        return Err(invalid("source.ignore must contain at most 100 patterns."));
                    }
                    values
                        .iter()
                        .map(|value| required_text(value, 1, 500, "source.ignore"))
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?;
            Ok(TriggerSource::FileChange {
                roots,
                globs,
                ignore,
                debounce_ms,
            })
        }
        TriggerSource::AiSession {
            agent,
            statuses,
            phases,
        } => {
            if statuses.as_ref().is_some_and(|values| values.len() > 20)
                || phases.as_ref().is_some_and(|values| values.len() > 20)
            {
                return Err(invalid(
                    "AI session trigger filters must contain at most 20 values.",
                ));
            }
            Ok(TriggerSource::AiSession {
                agent: agent
                    .map(|value| required_text(&value, 1, 80, "source.agent"))
                    .transpose()?,
                statuses,
                phases,
            })
        }
    }
}

fn normalize_action(
    mut action: controlled_instance_protocol::TriggerAction,
) -> Result<controlled_instance_protocol::TriggerAction, TriggerStoreError> {
    action.prompt_template =
        required_text(&action.prompt_template, 1, 20_000, "action.promptTemplate")?;
    Ok(action)
}

fn normalize_deployment(
    mut deployment: TriggerDeployment,
) -> Result<TriggerDeployment, TriggerStoreError> {
    deployment.config_hash = required_text(&deployment.config_hash, 8, 80, "configHash")?;
    deployment.deployment_id = deployment
        .deployment_id
        .map(|value| required_text(&value, 1, 240, "deploymentId"))
        .transpose()?;
    deployment.instance_id = required_text(&deployment.instance_id, 1, 160, "instanceId")?;
    deployment.local_name = deployment
        .local_name
        .map(|value| required_text(&value, 1, 160, "localName"))
        .transpose()?;
    deployment.target = normalize_target(deployment.target)?;
    validate_datetime(&deployment.created_at, "createdAt")?;
    validate_datetime(&deployment.updated_at, "updatedAt")?;
    Ok(deployment)
}

fn normalize_target(mut target: TriggerTarget) -> Result<TriggerTarget, TriggerStoreError> {
    if target.target_type != "ai-session" {
        return Err(invalid("target.type must be ai-session."));
    }
    target.ai_session_id = required_text(&target.ai_session_id, 1, 160, "target.aiSessionId")?;
    Ok(target)
}

fn normalize_runtime(
    mut runtime: TriggerRuntimeState,
) -> Result<TriggerRuntimeState, TriggerStoreError> {
    runtime.config_hash = required_text(&runtime.config_hash, 8, 80, "configHash")?;
    runtime.deployment_id = runtime
        .deployment_id
        .map(|value| required_text(&value, 1, 240, "deploymentId"))
        .transpose()?;
    runtime.instance_id = required_text(&runtime.instance_id, 1, 160, "instanceId")?;
    for (value, field) in [
        (runtime.last_triggered_at.as_deref(), "lastTriggeredAt"),
        (runtime.last_completed_at.as_deref(), "lastCompletedAt"),
        (runtime.last_skipped_at.as_deref(), "lastSkippedAt"),
    ] {
        if let Some(value) = value {
            validate_datetime(value, field)?;
        }
    }
    runtime.last_error = runtime
        .last_error
        .map(|value| trimmed_text(&value, 4_000, "lastError"))
        .transpose()?;
    Ok(runtime)
}

fn normalize_run(mut run: TriggerRun) -> Result<TriggerRun, TriggerStoreError> {
    run.id = required_text(&run.id, 1, 160, "id")?;
    run.config_hash = required_text(&run.config_hash, 8, 80, "configHash")?;
    run.deployment_id = run
        .deployment_id
        .map(|value| required_text(&value, 1, 240, "deploymentId"))
        .transpose()?;
    run.instance_id = required_text(&run.instance_id, 1, 160, "instanceId")?;
    run.target = normalize_target(run.target)?;
    run.prompt_preview = trimmed_text(&run.prompt_preview, 500, "promptPreview")?;
    run.event_summary = run
        .event_summary
        .map(|value| trimmed_text(&value, 1_000, "eventSummary"))
        .transpose()?;
    run.error = run
        .error
        .map(|value| trimmed_text(&value, 4_000, "error"))
        .transpose()?;
    validate_datetime(&run.started_at, "startedAt")?;
    if let Some(value) = run.completed_at.as_deref() {
        validate_datetime(value, "completedAt")?;
    }
    Ok(run)
}

#[derive(Default)]
struct RuntimePatch {
    status: Option<TriggerRuntimeStatus>,
    last_triggered_at: Option<Option<String>>,
    last_completed_at: Option<Option<String>>,
    last_skipped_at: Option<Option<String>>,
    last_error: Option<Option<String>>,
    run_count: Option<u64>,
    skipped_count: Option<u64>,
}

fn upsert_runtime(
    index: &TriggerIndex,
    deployment: &TriggerDeployment,
    patch: RuntimePatch,
) -> Vec<TriggerRuntimeState> {
    let key = deployment.key();
    let mut current = index
        .runtime
        .iter()
        .find(|entry| entry.key() == key)
        .cloned()
        .unwrap_or_else(|| runtime_for(deployment));
    if let Some(status) = patch.status {
        current.status = status;
    }
    if let Some(value) = patch.last_triggered_at {
        current.last_triggered_at = value;
    }
    if let Some(value) = patch.last_completed_at {
        current.last_completed_at = value;
    }
    if let Some(value) = patch.last_skipped_at {
        current.last_skipped_at = value;
    }
    if let Some(value) = patch.last_error {
        current.last_error = value;
    }
    if let Some(value) = patch.run_count {
        current.run_count = value;
    }
    if let Some(value) = patch.skipped_count {
        current.skipped_count = value;
    }
    let mut runtime = index
        .runtime
        .iter()
        .filter(|entry| entry.key() != key)
        .cloned()
        .collect::<Vec<_>>();
    runtime.push(current);
    runtime
}

fn runtime_for(deployment: &TriggerDeployment) -> TriggerRuntimeState {
    TriggerRuntimeState {
        config_hash: deployment.config_hash.clone(),
        deployment_id: deployment.deployment_id.clone(),
        instance_id: deployment.instance_id.clone(),
        status: if deployment.enabled {
            TriggerRuntimeStatus::Idle
        } else {
            TriggerRuntimeStatus::Disabled
        },
        last_triggered_at: None,
        last_completed_at: None,
        last_skipped_at: None,
        last_error: None,
        run_count: 0,
        skipped_count: 0,
    }
}

fn prompt_preview(value: &str) -> String {
    let value = value.trim();
    let mut units = 0;
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let width = character.len_utf16();
        if units + width > 500 {
            break;
        }
        units += width;
        end = index + character.len_utf8();
    }
    value[..end].to_string()
}

fn normalize_time_of_day(value: Option<String>) -> Result<String, TriggerStoreError> {
    let value = required_text(
        value.as_deref().unwrap_or_default(),
        5,
        5,
        "source.timeOfDay",
    )?;
    let bytes = value.as_bytes();
    let valid = bytes.len() == 5
        && bytes[2] == b':'
        && bytes[..2].iter().all(u8::is_ascii_digit)
        && bytes[3..].iter().all(u8::is_ascii_digit)
        && value[..2].parse::<u8>().is_ok_and(|hour| hour <= 23)
        && value[3..].parse::<u8>().is_ok_and(|minute| minute <= 59);
    if !valid {
        return Err(invalid("source.timeOfDay must use HH:mm."));
    }
    Ok(value)
}

fn required_text(
    value: &str,
    minimum: usize,
    maximum: usize,
    field: &str,
) -> Result<String, TriggerStoreError> {
    let value = value.trim();
    let length = value.chars().count();
    if length < minimum || length > maximum {
        return Err(invalid(format!(
            "{field} must contain between {minimum} and {maximum} characters."
        )));
    }
    Ok(value.to_string())
}

fn trimmed_text(value: &str, maximum: usize, field: &str) -> Result<String, TriggerStoreError> {
    let value = value.trim();
    if value.chars().count() > maximum {
        return Err(invalid(format!(
            "{field} must contain at most {maximum} characters."
        )));
    }
    Ok(value.to_string())
}

fn validate_datetime(value: &str, field: &str) -> Result<(), TriggerStoreError> {
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| invalid(format!("{field} must be an ISO 8601 datetime.")))
}

fn invalid(message: impl Into<String>) -> TriggerStoreError {
    TriggerStoreError::Invalid(message.into())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn local_instance_id() -> String {
    std::env::var("TASK_HANDOFF_INSTANCE_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "local".to_string())
}

pub fn source_matches_ai_session(
    source: &TriggerSource,
    session: &controlled_instance_protocol::AiSessionSummary,
) -> bool {
    let TriggerSource::AiSession {
        agent,
        statuses,
        phases,
    } = source
    else {
        return false;
    };
    if agent.as_ref().is_some_and(|agent| agent != &session.agent) {
        return false;
    }
    if statuses.as_ref().is_some_and(|values| {
        !values.is_empty()
            && !values
                .iter()
                .any(|value| ai_status_matches(*value, &session.status))
    }) {
        return false;
    }
    if phases.as_ref().is_some_and(|values| {
        !values.is_empty()
            && !values
                .iter()
                .any(|value| ai_phase_matches(*value, &session.phase))
    }) {
        return false;
    }
    true
}

fn ai_status_matches(value: TriggerAiSessionStatus, status: &str) -> bool {
    matches!(
        (value, status),
        (TriggerAiSessionStatus::Running, "running")
            | (TriggerAiSessionStatus::Waiting, "waiting")
            | (TriggerAiSessionStatus::Idle, "idle")
            | (TriggerAiSessionStatus::Failed, "failed")
    )
}

fn ai_phase_matches(value: TriggerAiSessionPhase, phase: &str) -> bool {
    matches!(
        (value, phase),
        (TriggerAiSessionPhase::Thinking, "thinking")
            | (TriggerAiSessionPhase::Tool, "tool")
            | (TriggerAiSessionPhase::Editing, "editing")
            | (TriggerAiSessionPhase::Approval, "approval")
            | (TriggerAiSessionPhase::Responding, "responding")
            | (TriggerAiSessionPhase::Unknown, "unknown")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_protocol::{
        TriggerAction, TriggerDeploymentCreateInput, TriggerEventType, TriggerPolicyInput,
        TriggerRunStatus, TriggerSource,
    };
    use serde_json::json;

    fn interval_input(name: &str, prompt: &str) -> TriggerCreateInput {
        TriggerCreateInput {
            name: name.to_string(),
            description: None,
            source: TriggerSource::Schedule {
                schedule_kind: TriggerScheduleKind::Interval,
                interval_ms: Some(5_000),
                time_of_day: None,
                timezone: None,
                weekdays: None,
            },
            action: TriggerAction {
                prompt_template: prompt.to_string(),
            },
            policy: Some(TriggerPolicyInput::default()),
            deployment: Some(TriggerDeploymentCreateInput {
                deployment_id: None,
                origin: None,
                enabled: None,
                target: TriggerTarget::ai_session("ses_0000000000001"),
                local_name: None,
            }),
        }
    }

    #[test]
    fn config_hash_matches_the_node_compatibility_fixture() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = TriggerStore::new(directory.path(), "instance");
        let created = store
            .create(interval_input(
                "Interval",
                "Run {{trigger.name}} for {{event.type}}",
            ))
            .expect("create");
        assert_eq!(created.config.config_hash, "trg_4dcf4a5401ad5efc668988f9");

        let file_input = TriggerCreateInput {
            name: "Files".to_string(),
            description: None,
            source: TriggerSource::FileChange {
                roots: vec!["./src".to_string()],
                globs: vec!["**/*.rs".to_string()],
                ignore: None,
                debounce_ms: 1_500,
            },
            action: TriggerAction {
                prompt_template: "Changed".to_string(),
            },
            policy: Some(TriggerPolicyInput::default()),
            deployment: Some(TriggerDeploymentCreateInput {
                deployment_id: Some("dep-files".to_string()),
                origin: None,
                enabled: None,
                target: TriggerTarget::ai_session("ses_0000000000002"),
                local_name: None,
            }),
        };
        let created = store.create(file_input).expect("file create");
        assert_eq!(created.config.config_hash, "trg_45ab1ebe62045d5d95de3b14");
        let persisted = store.load().expect("persisted index");
        assert_eq!(persisted.schema_version, 1);
        assert_eq!(persisted.configs.len(), 2);
        assert_eq!(persisted.deployments[1].instance_id, "instance");
    }

    #[test]
    fn store_lifecycle_sanitizes_legacy_entries_and_prunes_orphans() {
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            directory.path().join("index.json"),
            serde_json::to_vec_pretty(&json!({
                "schemaVersion": 99,
                "unknownRoot": true,
                "configs": [{
                    "configHash": "trg_12345678",
                    "name": "Legacy",
                    "description": "  retained  ",
                    "source": {
                        "type": "schedule",
                        "intervalMs": 1000,
                        "unknownSource": true
                    },
                    "action": { "promptTemplate": "Run", "unknownAction": true },
                    "policy": { "maxConcurrentRuns": 1, "whenBusy": "skip", "unknownPolicy": true },
                    "createdAt": "2026-11-02T00:00:00.000Z",
                    "updatedAt": "2026-11-02T00:00:00.000Z",
                    "unknownConfig": true
                }],
                "deployments": [
                    {
                        "configHash": "trg_12345678",
                        "instanceId": "local",
                        "target": { "type": "ai-session", "aiSessionId": "ses_ready", "extra": true },
                        "createdAt": "2026-11-02T00:00:00.000Z",
                        "updatedAt": "2026-11-02T00:00:00.000Z"
                    },
                    {
                        "configHash": "trg_12345678",
                        "instanceId": "local",
                        "target": { "type": "conversation", "conversationId": "old" },
                        "createdAt": "2026-11-02T00:00:00.000Z",
                        "updatedAt": "2026-11-02T00:00:00.000Z"
                    }
                ],
                "runtime": [
                    {
                        "configHash": "trg_12345678",
                        "instanceId": "local",
                        "status": "idle"
                    },
                    {
                        "configHash": "trg_12345678",
                        "deploymentId": "conversation-old",
                        "instanceId": "local",
                        "status": "idle"
                    }
                ],
                "recentRuns": [{
                    "id": "run_legacy",
                    "configHash": "trg_12345678",
                    "instanceId": "local",
                    "eventType": "manual",
                    "status": "completed",
                    "target": { "type": "ai-session", "aiSessionId": "ses_ready", "extra": true },
                    "promptPreview": "Run",
                    "startedAt": "2026-11-02T00:00:00.000Z",
                    "completedAt": "2026-11-02T00:00:01.000Z",
                    "unknownRun": true
                }]
            }))
            .expect("json"),
        )
        .expect("fixture");
        let store = TriggerStore::new(directory.path(), "local");
        let index = store.load().expect("load");
        assert_eq!(index.configs.len(), 1);
        assert_eq!(index.configs[0].description.as_deref(), Some("retained"));
        assert_eq!(index.deployments.len(), 1);
        assert_eq!(index.runtime.len(), 1);
        assert_eq!(index.recent_runs.len(), 1);

        let created = store
            .create(interval_input("Lifecycle", "Run"))
            .expect("create");
        let run = store
            .start_run(
                &created.config,
                &created.deployment,
                TriggerEventType::Manual,
                Some("manual".to_string()),
            )
            .expect("start");
        let completed = store
            .complete_run(&run, None)
            .expect("complete")
            .expect("completed run");
        assert_eq!(completed.status, TriggerRunStatus::Completed);
        let entry = store
            .get(&created.config.config_hash)
            .expect("get")
            .expect("entry");
        assert_eq!(entry.runtime[0].run_count, 1);
        assert_eq!(entry.runtime[0].status, TriggerRuntimeStatus::Idle);

        let disabled = store
            .set_enabled(&created.config.config_hash, false)
            .expect("disable")
            .expect("entry");
        assert!(!disabled.deployments[0].enabled);
        assert_eq!(disabled.runtime[0].status, TriggerRuntimeStatus::Disabled);
        assert!(store
            .delete_deployment(&created.config.config_hash, created.deployment.key())
            .expect("delete deployment"));
        assert!(store
            .get(&created.config.config_hash)
            .expect("get after delete")
            .is_none());
    }

    #[test]
    fn recent_runs_are_newest_first_and_capped_at_one_hundred() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = TriggerStore::new(directory.path(), "local");
        let created = store.create(interval_input("Runs", "Run")).expect("create");
        for index in 0..101 {
            store
                .start_run(
                    &created.config,
                    &created.deployment,
                    TriggerEventType::Schedule,
                    Some(format!("run-{index}")),
                )
                .expect("start run");
        }
        let runs = store.load().expect("runs").recent_runs;
        assert_eq!(runs.len(), 100);
        assert_eq!(runs[0].event_summary.as_deref(), Some("run-100"));
        assert_eq!(runs[99].event_summary.as_deref(), Some("run-1"));
    }

    #[test]
    fn missing_ai_sessions_prune_matching_deployments_and_empty_configs() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = TriggerStore::new(directory.path(), "local");
        let created = store
            .create(interval_input("Prune", "Run"))
            .expect("create");
        let stale = store
            .prune_missing_ai_session_deployments(&std::collections::HashSet::new())
            .expect("prune");
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].target.ai_session_id, "ses_0000000000001");
        assert!(store
            .get(&created.config.config_hash)
            .expect("get")
            .is_none());
    }
}
