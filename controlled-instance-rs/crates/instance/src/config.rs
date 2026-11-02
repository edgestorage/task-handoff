use controlled_instance_core::{paths::StoragePaths, process::hostname};
use controlled_instance_protocol::BuildInfo;
use std::path::{Path, PathBuf};
use std::time::Duration;

const CONTROLLED_INSTANCE_PACKAGE_NAME: &str = "@task-handoff/controlled-instance";
const DEFAULT_INSTANCE_RUNTIME_ROOT: &str = "/opt/task-handoff/instance-runtime";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlMode {
    Standalone,
    Controlled,
}

impl ControlMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standalone => "standalone",
            Self::Controlled => "controlled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    Docker,
    Local,
    Unknown,
}

impl RuntimeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Local => "local",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServerOptions {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub static_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct InstanceConfig {
    pub host: String,
    pub port: u16,
    pub static_dir: PathBuf,
    pub instance_id: String,
    pub configured_instance_id: Option<String>,
    pub instance_name: String,
    pub package_version: String,
    pub control_mode: ControlMode,
    pub runtime_kind: RuntimeKind,
    pub workspace_path: PathBuf,
    pub registration_token: Option<String>,
    pub node_agent_url: Option<String>,
    pub project_id: Option<String>,
    pub node_id: Option<String>,
    pub runtime_id: Option<String>,
    pub image_id: Option<String>,
    pub image_tag: Option<String>,
    pub heartbeat_interval: Duration,
    pub storage_paths: StoragePaths,
    pub build_info: BuildInfo,
}

impl InstanceConfig {
    pub fn from_env(options: ServerOptions) -> Self {
        let storage_paths = StoragePaths::resolve();
        let package_version = resolve_package_version();
        let configured_instance_id = env_optional("TASK_HANDOFF_INSTANCE_ID");
        Self {
            host: options
                .host
                .or_else(|| env_optional("TASK_HANDOFF_WEB_HOST"))
                .unwrap_or_else(|| "127.0.0.1".to_string()),
            port: options
                .port
                .or_else(|| {
                    env_optional("TASK_HANDOFF_WEB_PORT").and_then(|value| value.parse().ok())
                })
                .unwrap_or(8080),
            static_dir: options
                .static_dir
                .or_else(|| env_optional("TASK_HANDOFF_WEB_STATIC_DIR").map(PathBuf::from))
                .unwrap_or_else(default_static_dir),
            instance_id: configured_instance_id
                .clone()
                .unwrap_or_else(|| "standalone".to_string()),
            configured_instance_id,
            instance_name: env_optional("TASK_HANDOFF_INSTANCE_NAME")
                .unwrap_or_else(default_instance_name),
            package_version: package_version.clone(),
            control_mode: if env_optional("TASK_HANDOFF_CONTROL_MODE").as_deref()
                == Some("controlled")
            {
                ControlMode::Controlled
            } else {
                ControlMode::Standalone
            },
            runtime_kind: match env_optional("TASK_HANDOFF_RUNTIME_KIND").as_deref() {
                Some("local") => RuntimeKind::Local,
                Some("docker") => RuntimeKind::Docker,
                _ => RuntimeKind::Unknown,
            },
            workspace_path: PathBuf::from(
                env_optional("TASK_HANDOFF_WORKSPACE")
                    .or_else(|| env_optional("WORKSPACE"))
                    .unwrap_or_else(|| "/workspace".to_string()),
            ),
            registration_token: env_optional("TASK_HANDOFF_REGISTRATION_TOKEN"),
            node_agent_url: env_optional("TASK_HANDOFF_NODE_AGENT_URL"),
            project_id: env_optional("TASK_HANDOFF_PROJECT_ID"),
            node_id: env_optional("TASK_HANDOFF_NODE_ID"),
            runtime_id: env_optional("TASK_HANDOFF_RUNTIME_ID"),
            image_id: env_optional("TASK_HANDOFF_IMAGE_ID"),
            image_tag: env_optional("TASK_HANDOFF_IMAGE_TAG"),
            heartbeat_interval: env_optional("TASK_HANDOFF_HEARTBEAT_INTERVAL_MS")
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
                .map(Duration::from_millis)
                .unwrap_or(Duration::from_secs(10)),
            build_info: BuildInfo::for_controlled_instance(package_version),
            storage_paths,
        }
    }

    pub fn for_test(static_dir: PathBuf, storage_paths: StoragePaths) -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 0,
            static_dir,
            instance_id: "ins_0000000000000".to_string(),
            configured_instance_id: Some("ins_0000000000000".to_string()),
            instance_name: "test-instance".to_string(),
            package_version: "0.0.46".to_string(),
            control_mode: ControlMode::Controlled,
            runtime_kind: RuntimeKind::Docker,
            workspace_path: storage_paths.data_dir.clone(),
            registration_token: Some("test-registration-token".to_string()),
            node_agent_url: Some("http://127.0.0.1:9000".to_string()),
            project_id: None,
            node_id: None,
            runtime_id: None,
            image_id: None,
            image_tag: None,
            heartbeat_interval: Duration::from_secs(10),
            storage_paths,
            build_info: BuildInfo::for_controlled_instance("0.0.46"),
        }
    }
}

/// Resolve the version reported to the node agent.
///
/// Local runtimes inject the desired version through the environment. Docker
/// runtimes install an independently versioned artifact, so the active runtime
/// manifest is authoritative after installation and across container restarts.
pub fn resolve_package_version() -> String {
    env_optional("TASK_HANDOFF_CONTROLLED_INSTANCE_VERSION")
        .or_else(runtime_manifest_version)
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

fn runtime_manifest_version() -> Option<String> {
    let runtime_root = env_optional("TASK_HANDOFF_INSTANCE_RUNTIME_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_INSTANCE_RUNTIME_ROOT));
    package_version_from_runtime_manifest(&runtime_root.join("current/runtime-manifest.json"))
}

fn package_version_from_runtime_manifest(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if manifest.get("packageName")?.as_str()? != CONTROLLED_INSTANCE_PACKAGE_NAME {
        return None;
    }
    manifest
        .get("version")?
        .as_str()
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(ToString::to_string)
}

fn default_static_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .and_then(|path| path.parent().map(|root| root.join("ui")))
        .unwrap_or_else(|| PathBuf::from("ui"))
}

fn default_instance_name() -> String {
    hostname()
}

fn env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_preserves_the_v046_wire_version() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = StoragePaths::resolve();
        let config = InstanceConfig::for_test(temp.path().join("ui"), paths);
        assert_eq!(config.package_version, "0.0.46");
        assert_eq!(config.control_mode.as_str(), "controlled");
    }

    #[test]
    fn runtime_manifest_is_the_artifact_version_source() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manifest = temp.path().join("runtime-manifest.json");
        std::fs::write(
            &manifest,
            r#"{"packageName":"@task-handoff/controlled-instance","version":"0.0.25-local.20261102.1"}"#,
        )
        .expect("manifest");
        assert_eq!(
            package_version_from_runtime_manifest(&manifest).as_deref(),
            Some("0.0.25-local.20261102.1")
        );
    }

    #[test]
    fn unrelated_or_invalid_runtime_manifests_do_not_override_the_binary_version() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manifest = temp.path().join("runtime-manifest.json");
        std::fs::write(
            &manifest,
            r#"{"packageName":"@task-handoff/something-else","version":"9.9.9"}"#,
        )
        .expect("manifest");
        assert_eq!(package_version_from_runtime_manifest(&manifest), None);
        std::fs::write(&manifest, "not json").expect("manifest");
        assert_eq!(package_version_from_runtime_manifest(&manifest), None);
    }
}
