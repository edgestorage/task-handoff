use serde::{Deserialize, Serialize};

use crate::AppKind;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FinalComputerPlatform {
    Linux,
    Darwin,
    Win32,
    Freebsd,
    Openbsd,
    Aix,
    Sunos,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FinalComputerArch {
    X64,
    Arm64,
    Arm,
    Ia32,
    Ppc64,
    S390x,
    Riscv64,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppInstaller {
    Apt,
    Dnf,
    Brew,
    Npm,
}

impl AppInstaller {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Apt => "apt",
            Self::Dnf => "dnf",
            Self::Brew => "brew",
            Self::Npm => "npm",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AppInstallPrivilege {
    User,
    PasswordlessSudo,
    Root,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppInstallerAccess {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub npm_global_writable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FinalComputerCapabilities {
    pub platform: FinalComputerPlatform,
    pub arch: FinalComputerArch,
    pub installers: Vec<AppInstaller>,
    pub privilege: AppInstallPrivilege,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer_access: Option<AppInstallerAccess>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ManagedAppState {
    Installed,
    NotInstalled,
    Broken,
    Unsupported,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ManagedAppManagementSource {
    Recipe,
    Bundled,
    External,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ManagedAppActionReasonCode {
    #[serde(rename = "BUNDLED")]
    Bundled,
    #[serde(rename = "EXTERNALLY_MANAGED")]
    ExternallyManaged,
    #[serde(rename = "ALREADY_INSTALLED")]
    AlreadyInstalled,
    #[serde(rename = "NOT_INSTALLED")]
    NotInstalled,
    #[serde(rename = "UNSUPPORTED_PLATFORM")]
    UnsupportedPlatform,
    #[serde(rename = "INSTALLER_UNAVAILABLE")]
    InstallerUnavailable,
    #[serde(rename = "INSTALLER_NOT_WRITABLE")]
    InstallerNotWritable,
    #[serde(rename = "INSUFFICIENT_PRIVILEGE")]
    InsufficientPrivilege,
    #[serde(rename = "OPERATION_IN_PROGRESS")]
    OperationInProgress,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedAppActionReason {
    pub code: ManagedAppActionReasonCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ManagedAppUpdateStatus {
    UpdateAvailable,
    UpToDate,
    Unknown,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAppUpdateState {
    pub status: ManagedAppUpdateStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    pub checked_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAppUpdateCheck {
    pub app_id: String,
    pub status: ManagedAppUpdateStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    pub checked_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAppProjection {
    pub id: String,
    pub name: String,
    pub kind: AppKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub state: ManagedAppState,
    pub management_source: ManagedAppManagementSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub can_install: bool,
    pub can_uninstall: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_update: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_reason: Option<ManagedAppActionReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uninstall_reason: Option<ManagedAppActionReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_reason: Option<ManagedAppActionReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_check: Option<ManagedAppUpdateState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_job_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppManagementOperation {
    Install,
    Uninstall,
    Update,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppManagementJobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

impl AppManagementJobState {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppManagementProgress {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppManagementCommand {
    pub executable: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppManagementError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppManagementJob {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub app_id: String,
    pub operation: AppManagementOperation,
    pub state: AppManagementJobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<AppManagementProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<AppManagementCommand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_tail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppManagementError>,
    pub requested_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppManagementSnapshot {
    pub stream_id: String,
    pub sequence: u64,
    pub capabilities: FinalComputerCapabilities,
    pub apps: Vec<ManagedAppProjection>,
    pub active_jobs: Vec<AppManagementJob>,
    pub recent_jobs: Vec<AppManagementJob>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppManagementOperationRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppManagementEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub stream_id: String,
    pub sequence: u64,
    pub observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<AppManagementJob>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<AppManagementSnapshot>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_management_wire_models_keep_the_node_discriminators() {
        let job = AppManagementJob {
            id: "appjob_0000000000000".to_string(),
            request_id: None,
            app_id: "codex".to_string(),
            operation: AppManagementOperation::Install,
            state: AppManagementJobState::Queued,
            phase: None,
            progress: None,
            command: None,
            log_tail: None,
            log_truncated: None,
            error: None,
            requested_at: "2026-11-02T00:00:00.000Z".to_string(),
            started_at: None,
            finished_at: None,
            updated_at: "2026-11-02T00:00:00.000Z".to_string(),
        };
        let value = serde_json::to_value(job).expect("job");
        assert_eq!(value["operation"], "install");
        assert_eq!(value["state"], "queued");
        assert!(value.get("requestId").is_none());

        let projection = ManagedAppProjection {
            id: "terminal-gui".to_string(),
            name: "GUI Terminal".to_string(),
            kind: AppKind::Gui,
            description: None,
            state: ManagedAppState::NotInstalled,
            management_source: ManagedAppManagementSource::None,
            version: None,
            can_install: true,
            can_uninstall: false,
            can_update: Some(false),
            install_reason: None,
            uninstall_reason: Some(ManagedAppActionReason {
                code: ManagedAppActionReasonCode::NotInstalled,
                message: "This app is not installed.".to_string(),
            }),
            update_reason: None,
            update_check: None,
            active_job_id: None,
        };
        let value = serde_json::to_value(projection).expect("projection");
        assert_eq!(value["managementSource"], "none");
        assert_eq!(value["uninstallReason"]["code"], "NOT_INSTALLED");
    }
}
