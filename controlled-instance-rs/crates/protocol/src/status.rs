use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    AiSessionsSnapshot, ControlledInstanceAppInstallEnvironmentCapabilities,
    InstanceShellCapabilities, CONTROL_PLANE_PROTOCOL_VERSION,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoragePaths {
    pub config_path: String,
    pub data_dir: String,
    pub app_catalog_dir: String,
    pub app_sessions_dir: String,
    pub triggers_dir: String,
    pub runtime_dir: String,
    pub events_dir: String,
    pub artifact_dir: String,
    pub log_dir: String,
    pub web_token_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub component: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub built_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_digest: Option<String>,
}

impl BuildInfo {
    pub fn for_controlled_instance(package_version: impl Into<String>) -> Self {
        Self {
            component: "controlled-instance".to_string(),
            package_name: Some("@task-handoff/controlled-instance".to_string()),
            package_version: Some(package_version.into()),
            protocol_version: Some(CONTROL_PLANE_PROTOCOL_VERSION.to_string()),
            build_id: env_optional("TASK_HANDOFF_BUILD_ID"),
            built_at: env_optional("TASK_HANDOFF_BUILT_AT"),
            git_commit: env_optional("TASK_HANDOFF_GIT_COMMIT"),
            image_ref: env_optional("TASK_HANDOFF_IMAGE_REF"),
            image_digest: env_optional("TASK_HANDOFF_IMAGE_DIGEST"),
        }
    }
}

fn env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStorageStatus {
    pub data_dir: String,
    pub log_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub mode: String,
    pub status: String,
    pub path: String,
    pub exists: bool,
    pub git: WorkspaceGitStatus,
    pub storage: WorkspaceStorageStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppInventorySnapshot {
    pub items: Vec<Value>,
    pub observed_at: String,
    pub issues: Vec<Value>,
}

impl Default for AppInventorySnapshot {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            observed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            issues: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppCounts {
    pub running_count: u64,
    pub problem_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceStatusSnapshot {
    pub status: String,
    pub health: String,
    pub instance_version: String,
    pub protocol_version: String,
    pub build: BuildInfo,
    pub control_mode: String,
    pub capabilities: ControlledInstanceCapabilities,
    pub app_inventory: AppInventorySnapshot,
    pub apps: AppCounts,
    pub ai_sessions: AiSessionsSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Value>,
    pub workspace: WorkspaceStatus,
    pub target: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControlledInstanceCapabilities {
    pub features: FeatureCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeatureCapabilities {
    pub app_runtime: bool,
    pub tty: bool,
    pub gui: bool,
    pub browser: bool,
    pub browser_tunnel: bool,
    pub screenshots: bool,
    pub logs: bool,
    pub ai_session_workspace_selection: bool,
    pub ai_session_workspace_checkout: bool,
    pub ai_session_persistence_settings: bool,
    pub private_model_catalog: bool,
    pub codex_managed_settings: bool,
    pub node_agent_connection_update: bool,
    pub git_cli_credential_broker: bool,
    pub git_credential_proxy: bool,
    pub repository_path_search: bool,
    #[serde(default)]
    pub repository_file_content: bool,
    pub repository_worktree_move_to_main: bool,
    pub ai_session_send_idempotency: bool,
    pub ai_session_queue_pause: bool,
    pub model_relay: ModelRelayCapabilities,
    pub managed_model_environment: ManagedModelEnvironmentCapabilities,
    pub app_install_environment: ControlledInstanceAppInstallEnvironmentCapabilities,
    pub ai_session_timeline: AiSessionTimelineCapabilities,
    pub ai_session_conversation_attachments: AiSessionConversationAttachmentCapabilities,
    pub ai_session_providers: Vec<AiSessionProviderCapability>,
    pub instance_shell: InstanceShellCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRelayCapabilities {
    pub protocols: Vec<String>,
    pub streaming: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedModelEnvironmentCapabilities {
    pub open_code_config: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionTimelineCapabilities {
    pub session_read_agents: Vec<String>,
    pub turn_read_agents: Vec<String>,
    pub live_item_agents: Vec<String>,
    #[serde(default)]
    pub tool_activity_agents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionConversationAttachmentCapabilities {
    pub metadata_agents: Vec<String>,
    pub content_agents: Vec<String>,
    pub upload_agents: Vec<String>,
    pub retention_settings: bool,
    pub file_size_limit_settings: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionProviderCapability {
    pub agent: String,
    pub actions: AiSessionProviderActions,
    pub permission_modes: Vec<String>,
    pub timeline: AiSessionProviderTimelineCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<AiSessionModelSelectionCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<AiSessionReasoningEffortCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hierarchy: Option<AiSessionHierarchyCapabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionProviderActions {
    pub create: bool,
    pub send: bool,
    pub queue: bool,
    pub steer: bool,
    pub interrupt: bool,
    pub archive: bool,
    pub delete: bool,
    pub fork: bool,
    pub rename: bool,
    pub approval_decisions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionProviderTimelineCapabilities {
    pub session_read: bool,
    pub turn_read: bool,
    pub live_items: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionModelSelectionCapabilities {
    pub select_model_at_create: bool,
    pub select_provider_at_create: bool,
    pub select_model_at_resume: bool,
    pub select_provider_at_resume: bool,
    pub switch_model_within_provider: bool,
    pub switch_provider_during_session: bool,
    pub stable_identity: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionReasoningEffortCapabilities {
    pub select_at_create: bool,
    pub update_during_session: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionHierarchyCapabilities {
    pub subagents: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvelope<T> {
    pub data: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiErrorEnvelope {
    pub error: ApiError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_document_uses_camel_case_and_existing_protocol_version() {
        let value =
            serde_json::to_value(ControlledInstanceCapabilities::default()).expect("serializes");
        assert_eq!(value["features"]["appRuntime"], false);
        assert_eq!(
            value["features"]["instanceShell"]["protocolVersion"],
            crate::INSTANCE_SHELL_PROTOCOL_VERSION
        );
        assert!(value["features"].get("aiSessionTimeline").is_some());
    }

    #[test]
    fn build_info_omits_unset_optional_fields() {
        let value =
            serde_json::to_value(BuildInfo::for_controlled_instance("0.0.46")).expect("serializes");
        assert_eq!(value["component"], "controlled-instance");
        assert_eq!(value["protocolVersion"], CONTROL_PLANE_PROTOCOL_VERSION);
        assert!(value.get("imageRef").is_none());
    }
}
