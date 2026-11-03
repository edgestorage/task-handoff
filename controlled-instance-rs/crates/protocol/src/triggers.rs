use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub const MAX_TRIGGER_RECENT_RUNS: usize = 100;
pub const TRIGGER_SNAPSHOT_RECENT_RUNS: usize = 20;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TriggerScheduleKind {
    #[default]
    Interval,
    Daily,
    Weekly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TriggerAiSessionStatus {
    Running,
    Waiting,
    Idle,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TriggerAiSessionPhase {
    Thinking,
    Tool,
    Editing,
    Approval,
    Responding,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TriggerSource {
    Schedule {
        #[serde(default)]
        schedule_kind: TriggerScheduleKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        interval_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        time_of_day: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timezone: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        weekdays: Option<Vec<u8>>,
    },
    FileChange {
        roots: Vec<String>,
        globs: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ignore: Option<Vec<String>>,
        #[serde(default = "default_file_debounce_ms")]
        debounce_ms: u64,
    },
    AiSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        statuses: Option<Vec<TriggerAiSessionStatus>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phases: Option<Vec<TriggerAiSessionPhase>>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TriggerScheduleWire {
    #[serde(rename = "type")]
    source_type: String,
    #[serde(default)]
    schedule_kind: TriggerScheduleKind,
    #[serde(
        default,
        deserialize_with = "crate::json_number::deserialize_optional_u64"
    )]
    interval_ms: Option<u64>,
    #[serde(default)]
    time_of_day: Option<String>,
    #[serde(default)]
    timezone: Option<String>,
    #[serde(default)]
    weekdays: Option<Vec<u8>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TriggerFileChangeWire {
    #[serde(rename = "type")]
    source_type: String,
    roots: Vec<String>,
    globs: Vec<String>,
    #[serde(default)]
    ignore: Option<Vec<String>>,
    #[serde(
        default = "default_file_debounce_ms",
        deserialize_with = "crate::json_number::deserialize_u64"
    )]
    debounce_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TriggerAiSessionWire {
    #[serde(rename = "type")]
    source_type: String,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    statuses: Option<Vec<TriggerAiSessionStatus>>,
    #[serde(default)]
    phases: Option<Vec<TriggerAiSessionPhase>>,
}

impl<'de> Deserialize<'de> for TriggerSource {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let source_type = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("trigger source type is required"))?;
        match source_type {
            "schedule" => {
                let wire =
                    TriggerScheduleWire::deserialize(value).map_err(serde::de::Error::custom)?;
                if wire.source_type != "schedule" {
                    return Err(serde::de::Error::custom("trigger source type is invalid"));
                }
                Ok(Self::Schedule {
                    schedule_kind: wire.schedule_kind,
                    interval_ms: wire.interval_ms,
                    time_of_day: wire.time_of_day,
                    timezone: wire.timezone,
                    weekdays: wire.weekdays,
                })
            }
            "file-change" => {
                let wire =
                    TriggerFileChangeWire::deserialize(value).map_err(serde::de::Error::custom)?;
                if wire.source_type != "file-change" {
                    return Err(serde::de::Error::custom("trigger source type is invalid"));
                }
                Ok(Self::FileChange {
                    roots: wire.roots,
                    globs: wire.globs,
                    ignore: wire.ignore,
                    debounce_ms: wire.debounce_ms,
                })
            }
            "ai-session" => {
                let wire =
                    TriggerAiSessionWire::deserialize(value).map_err(serde::de::Error::custom)?;
                if wire.source_type != "ai-session" {
                    return Err(serde::de::Error::custom("trigger source type is invalid"));
                }
                Ok(Self::AiSession {
                    agent: wire.agent,
                    statuses: wire.statuses,
                    phases: wire.phases,
                })
            }
            _ => Err(serde::de::Error::custom("trigger source type is invalid")),
        }
    }
}

fn default_file_debounce_ms() -> u64 {
    1_500
}

impl TriggerSource {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Schedule { .. } => "schedule",
            Self::FileChange { .. } => "file-change",
            Self::AiSession { .. } => "ai-session",
        }
    }

    pub fn schedule_summary(&self) -> Option<String> {
        let Self::Schedule {
            schedule_kind,
            interval_ms,
            time_of_day,
            timezone,
            weekdays,
        } = self
        else {
            return None;
        };
        Some(match schedule_kind {
            TriggerScheduleKind::Interval => {
                format!("Interval {}ms", interval_ms.unwrap_or_default())
            }
            TriggerScheduleKind::Daily => format!(
                "Daily at {} {}",
                time_of_day.as_deref().unwrap_or_default(),
                timezone.as_deref().unwrap_or_default()
            ),
            TriggerScheduleKind::Weekly => format!(
                "Weekly on {} at {} {}",
                weekdays
                    .as_ref()
                    .map(|values| values
                        .iter()
                        .map(u8::to_string)
                        .collect::<Vec<_>>()
                        .join(","))
                    .unwrap_or_default(),
                time_of_day.as_deref().unwrap_or_default(),
                timezone.as_deref().unwrap_or_default()
            ),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerAction {
    pub prompt_template: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TriggerWhenBusy {
    Skip,
    Queue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown_ms: Option<u64>,
    #[serde(default = "default_max_concurrent_runs")]
    pub max_concurrent_runs: u8,
    #[serde(default = "default_when_busy")]
    pub when_busy: TriggerWhenBusy,
}

impl Default for TriggerPolicy {
    fn default() -> Self {
        Self {
            cooldown_ms: None,
            max_concurrent_runs: default_max_concurrent_runs(),
            when_busy: default_when_busy(),
        }
    }
}

fn default_max_concurrent_runs() -> u8 {
    1
}

fn default_when_busy() -> TriggerWhenBusy {
    TriggerWhenBusy::Skip
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerConfig {
    pub config_hash: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: TriggerSource,
    pub action: TriggerAction,
    #[serde(default)]
    pub policy: TriggerPolicy,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerTarget {
    #[serde(rename = "type")]
    pub target_type: String,
    pub ai_session_id: String,
}

impl TriggerTarget {
    pub fn ai_session(ai_session_id: impl Into<String>) -> Self {
        Self {
            target_type: "ai-session".to_string(),
            ai_session_id: ai_session_id.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TriggerDeploymentOrigin {
    ControlPlane,
    #[default]
    ControlledInstance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerDeployment {
    pub config_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
    pub instance_id: String,
    #[serde(default)]
    pub origin: TriggerDeploymentOrigin,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub target: TriggerTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn default_enabled() -> bool {
    true
}

impl TriggerDeployment {
    pub fn key(&self) -> &str {
        self.deployment_id
            .as_deref()
            .unwrap_or(self.config_hash.as_str())
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TriggerRuntimeStatus {
    #[default]
    Idle,
    Running,
    Disabled,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerRuntimeState {
    pub config_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
    pub instance_id: String,
    #[serde(default)]
    pub status: TriggerRuntimeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_triggered_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_skipped_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub run_count: u64,
    #[serde(default)]
    pub skipped_count: u64,
}

impl TriggerRuntimeState {
    pub fn key(&self) -> &str {
        self.deployment_id
            .as_deref()
            .unwrap_or(self.config_hash.as_str())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TriggerEventType {
    Manual,
    Schedule,
    FileChange,
    AiSession,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TriggerRunStatus {
    Started,
    Completed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerRun {
    pub id: String,
    pub config_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
    pub instance_id: String,
    pub event_type: TriggerEventType,
    pub status: TriggerRunStatus,
    pub target: TriggerTarget,
    pub prompt_preview: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerIndex {
    #[serde(default = "default_schema_version")]
    pub schema_version: u8,
    #[serde(default)]
    pub configs: Vec<TriggerConfig>,
    #[serde(default)]
    pub deployments: Vec<TriggerDeployment>,
    #[serde(default)]
    pub runtime: Vec<TriggerRuntimeState>,
    #[serde(default)]
    pub recent_runs: Vec<TriggerRun>,
}

fn default_schema_version() -> u8 {
    1
}

impl Default for TriggerIndex {
    fn default() -> Self {
        Self {
            schema_version: default_schema_version(),
            configs: Vec::new(),
            deployments: Vec::new(),
            runtime: Vec::new(),
            recent_runs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerEntry {
    pub config: TriggerConfig,
    pub deployments: Vec<TriggerDeployment>,
    pub runtime: Vec<TriggerRuntimeState>,
    pub recent_runs: Vec<TriggerRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerMutationResult {
    pub config: TriggerConfig,
    pub deployment: TriggerDeployment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<TriggerRuntimeState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerSnapshotConfig {
    pub config_hash: String,
    pub config: TriggerConfig,
    pub deployments: Vec<TriggerDeployment>,
    pub runtime: Vec<TriggerRuntimeState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerSnapshot {
    pub enabled_count: usize,
    pub running_count: usize,
    pub error_count: usize,
    pub configs: Vec<TriggerSnapshotConfig>,
    pub recent_runs: Vec<TriggerRun>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerPolicyInput {
    #[serde(default)]
    pub cooldown_ms: Option<u64>,
    #[serde(default)]
    pub max_concurrent_runs: Option<u8>,
    #[serde(default)]
    pub when_busy: Option<TriggerWhenBusy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerDeploymentCreateInput {
    #[serde(default)]
    pub deployment_id: Option<String>,
    #[serde(default)]
    pub origin: Option<TriggerDeploymentOrigin>,
    #[serde(default)]
    pub enabled: Option<bool>,
    pub target: TriggerTarget,
    #[serde(default)]
    pub local_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerCreateInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub source: TriggerSource,
    pub action: TriggerAction,
    #[serde(default)]
    pub policy: Option<TriggerPolicyInput>,
    #[serde(default)]
    pub deployment: Option<TriggerDeploymentCreateInput>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerPatchInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable_string")]
    pub description: Option<Option<String>>,
}

fn deserialize_optional_nullable_string<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerRunInput {
    #[serde(default)]
    pub prompt_override: Option<String>,
    #[serde(default)]
    pub event_summary: Option<String>,
    #[serde(default)]
    pub deployment_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TriggerExecutionResult {
    pub run: TriggerRun,
    pub result: Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trigger_wire_models_keep_camel_case_defaults_and_discriminators() {
        let source: TriggerSource = serde_json::from_value(json!({
            "type": "schedule",
            "intervalMs": 5000
        }))
        .expect("interval source");
        assert_eq!(
            serde_json::to_value(source).expect("source json"),
            json!({
                "type": "schedule",
                "scheduleKind": "interval",
                "intervalMs": 5000
            })
        );

        let file_source: TriggerSource = serde_json::from_value(json!({
            "type": "file-change",
            "roots": ["/workspace"],
            "globs": ["**/*.rs"]
        }))
        .expect("file source");
        assert_eq!(
            serde_json::to_value(file_source).expect("file source json"),
            json!({
                "type": "file-change",
                "roots": ["/workspace"],
                "globs": ["**/*.rs"],
                "debounceMs": 1500
            })
        );
    }

    #[test]
    fn trigger_patch_distinguishes_absent_from_null_description() {
        let unchanged: TriggerPatchInput = serde_json::from_value(json!({})).expect("empty patch");
        assert_eq!(unchanged.description, None);
        let cleared: TriggerPatchInput =
            serde_json::from_value(json!({ "description": null })).expect("clear patch");
        assert_eq!(cleared.description, Some(None));
        let updated: TriggerPatchInput =
            serde_json::from_value(json!({ "description": "updated" })).expect("update patch");
        assert_eq!(updated.description, Some(Some("updated".to_string())));
    }
}
