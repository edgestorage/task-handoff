use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chrono::{SecondsFormat, Utc};
use controlled_instance_core::atomic::{read_json, write_atomic, write_json_atomic};
use controlled_instance_protocol::{
    AppInstallEffectiveSources, AppInstallEnvironment, AppInstallEnvironmentTestCheck,
    AppInstallEnvironmentTestCheckId, AppInstallEnvironmentTestResponse, AppInstallNodeToolchain,
    AppInstallNodeToolchainState, AppInstallSourceCustom, AppInstallSourceProfile,
    AppInstallSourceSettings, AppInstallSourceUpdate,
    ControlledInstanceAppInstallEnvironmentCapabilities, FinalComputerArch,
    FinalComputerCapabilities, FinalComputerPlatform, APP_INSTALL_ENVIRONMENT_PROTOCOL_VERSION,
};
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tar::Archive;
use tokio::io::AsyncWriteExt;

use crate::{
    current_arch, current_platform,
    executable_resolver::{resolve_executable, ExecutableResolverOptions, Platform},
};

pub const MANAGED_NODE_VERSION: &str = "24.19.0";
pub const MINIMUM_NODE_VERSION: &str = "24.15.0";
pub const APP_INSTALL_SOURCE_PROFILES: [AppInstallSourceProfile; 4] = [
    AppInstallSourceProfile::Environment,
    AppInstallSourceProfile::Official,
    AppInstallSourceProfile::China,
    AppInstallSourceProfile::Custom,
];

const SOURCE_FILE: &str = "app-install-sources.json";
const MAX_NODE_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DOWNLOAD_TIME: Duration = Duration::from_secs(10 * 60);
const VERSION_PROBE_TIME: Duration = Duration::from_secs(5);
const SOURCE_TEST_TIME: Duration = Duration::from_secs(8);
const NODE_STATUS_CACHE_TIME: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy)]
struct NodeArtifact {
    name: &'static str,
    sha256: &'static str,
}

fn node_artifact(platform: FinalComputerPlatform, arch: FinalComputerArch) -> Option<NodeArtifact> {
    match (platform, arch) {
        (FinalComputerPlatform::Linux, FinalComputerArch::X64) => Some(NodeArtifact {
            name: "linux-x64",
            sha256: "f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4",
        }),
        (FinalComputerPlatform::Linux, FinalComputerArch::Arm64) => Some(NodeArtifact {
            name: "linux-arm64",
            sha256: "d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f",
        }),
        (FinalComputerPlatform::Darwin, FinalComputerArch::X64) => Some(NodeArtifact {
            name: "darwin-x64",
            sha256: "d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316",
        }),
        (FinalComputerPlatform::Darwin, FinalComputerArch::Arm64) => Some(NodeArtifact {
            name: "darwin-arm64",
            sha256: "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
        }),
        _ => None,
    }
}

fn platform_node_name(platform: FinalComputerPlatform) -> Option<&'static str> {
    match platform {
        FinalComputerPlatform::Linux => Some("linux"),
        FinalComputerPlatform::Darwin => Some("darwin"),
        _ => None,
    }
}

fn platform_arch_name(arch: FinalComputerArch) -> Option<&'static str> {
    match arch {
        FinalComputerArch::X64 => Some("x64"),
        FinalComputerArch::Arm64 => Some("arm64"),
        _ => None,
    }
}

fn resolver_platform(platform: FinalComputerPlatform) -> Platform {
    match platform {
        FinalComputerPlatform::Linux => Platform::Linux,
        FinalComputerPlatform::Darwin => Platform::MacOs,
        FinalComputerPlatform::Win32 => Platform::Windows,
        FinalComputerPlatform::Freebsd
        | FinalComputerPlatform::Openbsd
        | FinalComputerPlatform::Aix
        | FinalComputerPlatform::Sunos => Platform::OtherUnix,
        FinalComputerPlatform::Unknown => Platform::current(),
    }
}

#[derive(Debug, Clone)]
pub struct AppInstallEnvironmentError {
    pub code: String,
    pub message: String,
    pub status_code: u16,
}

impl AppInstallEnvironmentError {
    fn new(code: &str, message: impl Into<String>, status_code: u16) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            status_code,
        }
    }

    fn storage(error: impl std::fmt::Display) -> Self {
        Self::new("install_environment_storage_failed", error.to_string(), 500)
    }
}

impl std::fmt::Display for AppInstallEnvironmentError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AppInstallEnvironmentError {}

#[derive(Debug, Clone, Default)]
struct StoredInstallSources {
    revision: u64,
    settings: AppInstallSourceSettings,
}

#[derive(Debug, Clone)]
pub(crate) struct NodeRuntime {
    pub node_executable: PathBuf,
    pub npm_executable: PathBuf,
    pub version: String,
    pub npm_version: String,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct AptSourceConfiguration {
    pub sources_file: PathBuf,
    pub lists_dir: PathBuf,
    pub options: Vec<String>,
    pub main_mirror: String,
    pub security_mirror: String,
    pub codename: String,
    pub distro: String,
}

#[derive(Debug, Clone)]
struct OsRelease {
    id: String,
    codename: Option<String>,
    id_like: Vec<String>,
}

#[derive(Debug, Clone)]
struct AptDistro {
    distro: String,
    codename: Option<String>,
}

#[derive(Debug, Clone)]
struct CachedNodeStatus {
    expires_at: Instant,
    value: AppInstallNodeToolchain,
}

#[derive(Debug, Default)]
struct InstallEnvironmentState {
    stored: StoredInstallSources,
    cached_node_status: Option<CachedNodeStatus>,
    cached_private_runtime: Option<NodeRuntime>,
}

type ChangeListener = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub struct AppInstallEnvironmentOptions {
    pub data_dir: PathBuf,
    pub state_dir: PathBuf,
    pub env: BTreeMap<String, String>,
    pub platform: FinalComputerPlatform,
    pub arch: FinalComputerArch,
    pub os_release_path: PathBuf,
    pub client: reqwest::Client,
}

impl AppInstallEnvironmentOptions {
    pub fn new(data_dir: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            state_dir: state_dir.into(),
            env: std::env::vars().collect(),
            platform: current_platform(),
            arch: current_arch(),
            os_release_path: PathBuf::from("/etc/os-release"),
            client: reqwest::Client::new(),
        }
    }
}

struct InstallEnvironmentInner {
    data_dir: PathBuf,
    state_dir: PathBuf,
    env: BTreeMap<String, String>,
    platform: FinalComputerPlatform,
    arch: FinalComputerArch,
    os_release_path: PathBuf,
    client: reqwest::Client,
    state: Mutex<InstallEnvironmentState>,
    listeners: Mutex<Vec<ChangeListener>>,
    prepare_lock: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct AppInstallEnvironmentManager {
    inner: Arc<InstallEnvironmentInner>,
}

#[derive(Clone)]
pub struct AppInstallExecutionPolicy {
    manager: AppInstallEnvironmentManager,
    pub revision: u64,
    pub effective: AppInstallEffectiveSources,
}

impl AppInstallExecutionPolicy {
    pub(crate) async fn prepare_node_runtime(
        &self,
    ) -> Result<NodeRuntime, AppInstallEnvironmentError> {
        self.manager.prepare_node_runtime(&self.effective).await
    }

    pub(crate) fn node_environment(
        &self,
        base: &BTreeMap<String, String>,
    ) -> BTreeMap<String, String> {
        let mut env = self.manager.runtime_environment_from(base);
        apply_npm_registry(&mut env, self.effective.npm_registry.as_deref());
        env
    }

    pub(crate) fn apt_source_configuration(
        &self,
    ) -> Result<Option<AptSourceConfiguration>, AppInstallEnvironmentError> {
        self.manager.apt_source_configuration(&self.effective)
    }
}

impl AppInstallEnvironmentManager {
    pub fn new(data_dir: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Self {
        Self::with_options(AppInstallEnvironmentOptions::new(data_dir, state_dir))
    }

    pub fn with_options(options: AppInstallEnvironmentOptions) -> Self {
        let stored = read_stored_sources(&options.data_dir.join(SOURCE_FILE));
        Self {
            inner: Arc::new(InstallEnvironmentInner {
                data_dir: options.data_dir,
                state_dir: options.state_dir,
                env: options.env,
                platform: options.platform,
                arch: options.arch,
                os_release_path: options.os_release_path,
                client: options.client,
                state: Mutex::new(InstallEnvironmentState {
                    stored,
                    ..InstallEnvironmentState::default()
                }),
                listeners: Mutex::new(Vec::new()),
                prepare_lock: tokio::sync::Mutex::new(()),
            }),
        }
    }

    pub fn on_change(&self, listener: impl Fn() + Send + Sync + 'static) {
        self.inner
            .listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(Arc::new(listener));
    }

    fn notify(&self) {
        let listeners = self
            .inner
            .listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        for listener in listeners {
            listener();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, InstallEnvironmentState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn revision(&self) -> u64 {
        self.lock().stored.revision
    }

    pub fn settings(&self) -> AppInstallSourceSettings {
        self.lock().stored.settings.clone()
    }

    pub fn supports_node_toolchain(&self) -> bool {
        node_artifact(self.inner.platform, self.inner.arch).is_some()
    }

    pub fn supports_apt_sources(&self) -> bool {
        self.inner.platform == FinalComputerPlatform::Linux
            && self
                .apt_distro()
                .is_some_and(|distro| distro.codename.is_some())
    }

    pub fn capabilities(&self) -> ControlledInstanceAppInstallEnvironmentCapabilities {
        ControlledInstanceAppInstallEnvironmentCapabilities {
            protocol_version: Some(APP_INSTALL_ENVIRONMENT_PROTOCOL_VERSION.to_string()),
            source_profiles: APP_INSTALL_SOURCE_PROFILES.to_vec(),
            node_toolchain: self.supports_node_toolchain(),
            npm_sources: true,
            apt_sources: self.supports_apt_sources(),
        }
    }

    pub fn augment_capabilities(
        &self,
        mut capabilities: FinalComputerCapabilities,
    ) -> FinalComputerCapabilities {
        let node = self.node_status();
        if (node.state != AppInstallNodeToolchainState::Missing
            || node_artifact(self.inner.platform, self.inner.arch).is_some())
            && !capabilities
                .installers
                .contains(&controlled_instance_protocol::AppInstaller::Npm)
        {
            capabilities
                .installers
                .push(controlled_instance_protocol::AppInstaller::Npm);
        }
        capabilities
    }

    pub fn update(
        &self,
        update: AppInstallSourceUpdate,
    ) -> Result<AppInstallEnvironment, AppInstallEnvironmentError> {
        let current_revision = self.revision();
        if update
            .expected_revision
            .is_some_and(|expected| expected != current_revision)
        {
            return Err(AppInstallEnvironmentError::new(
                "install_sources_revision_conflict",
                format!(
                    "Install source settings changed from revision {} to {current_revision}.",
                    update.expected_revision.unwrap_or_default()
                ),
                409,
            ));
        }
        let settings = normalize_settings(update.settings)?;
        let next_revision = current_revision.saturating_add(1);
        let stored = StoredInstallSources {
            revision: next_revision,
            settings,
        };
        let payload = StoredInstallSourcesFile {
            version: 1,
            revision: stored.revision,
            settings: stored.settings.clone(),
            updated_at: Some(now()),
        };
        write_json_atomic(
            &self.inner.data_dir.join(SOURCE_FILE),
            &payload,
            Some(0o600),
        )
        .map_err(AppInstallEnvironmentError::storage)?;
        {
            let mut state = self.lock();
            state.stored = stored;
            state.cached_node_status = None;
        }
        self.notify();
        Ok(self.snapshot())
    }

    pub fn snapshot(&self) -> AppInstallEnvironment {
        AppInstallEnvironment {
            revision: self.revision(),
            settings: self.settings(),
            effective: self.effective_sources(),
            node: self.node_status(),
            observed_at: now(),
        }
    }

    pub fn runtime_environment(&self) -> BTreeMap<String, String> {
        self.runtime_environment_from(&self.inner.env)
    }

    pub fn runtime_overrides(&self) -> BTreeMap<String, String> {
        self.runtime_environment()
            .into_iter()
            .filter(|(key, value)| self.inner.env.get(key) != Some(value))
            .collect()
    }

    pub async fn prepare_node_toolchain(
        &self,
    ) -> Result<AppInstallEnvironment, AppInstallEnvironmentError> {
        let policy = self.create_execution_policy();
        policy.prepare_node_runtime().await?;
        Ok(self.snapshot())
    }

    fn runtime_environment_from(
        &self,
        base: &BTreeMap<String, String>,
    ) -> BTreeMap<String, String> {
        let mut env = base.clone();
        if let Some(runtime) = self.private_runtime() {
            if let Some(bin_dir) = runtime.node_executable.parent() {
                env = with_path(&env, bin_dir);
            }
        }
        apply_npm_registry(&mut env, self.effective_sources().npm_registry.as_deref());
        env
    }

    pub fn create_execution_policy(&self) -> AppInstallExecutionPolicy {
        AppInstallExecutionPolicy {
            manager: self.clone(),
            revision: self.revision(),
            effective: self.effective_sources(),
        }
    }

    fn stored_settings(&self) -> AppInstallSourceSettings {
        self.lock().stored.settings.clone()
    }

    fn effective_sources(&self) -> AppInstallEffectiveSources {
        let settings = self.stored_settings();
        if settings.profile == AppInstallSourceProfile::Environment {
            return AppInstallEffectiveSources::default();
        }
        let official_apt = self
            .supports_apt_sources()
            .then(|| self.official_apt_mirrors());
        match settings.profile {
            AppInstallSourceProfile::Environment => AppInstallEffectiveSources::default(),
            AppInstallSourceProfile::Official => AppInstallEffectiveSources {
                npm_registry: Some("https://registry.npmjs.org".to_string()),
                node_dist_url: Some("https://nodejs.org/dist".to_string()),
                apt_main_mirror: official_apt.as_ref().map(|mirrors| mirrors.0.clone()),
                apt_security_mirror: official_apt.as_ref().map(|mirrors| mirrors.1.clone()),
            },
            AppInstallSourceProfile::China => {
                let china_apt = self
                    .supports_apt_sources()
                    .then(|| self.china_apt_mirrors());
                AppInstallEffectiveSources {
                    npm_registry: Some("https://registry.npmmirror.com".to_string()),
                    node_dist_url: Some(
                        "https://mirrors.cloud.tencent.com/nodejs-release".to_string(),
                    ),
                    apt_main_mirror: china_apt.as_ref().map(|mirrors| mirrors.0.clone()),
                    apt_security_mirror: china_apt.as_ref().map(|mirrors| mirrors.1.clone()),
                }
            }
            AppInstallSourceProfile::Custom => AppInstallEffectiveSources {
                npm_registry: settings
                    .custom
                    .npm_registry
                    .clone()
                    .or_else(|| Some("https://registry.npmjs.org".to_string())),
                node_dist_url: settings
                    .custom
                    .node_dist_url
                    .clone()
                    .or_else(|| Some("https://nodejs.org/dist".to_string())),
                apt_main_mirror: official_apt.as_ref().map(|mirrors| {
                    settings
                        .custom
                        .apt_main_mirror
                        .clone()
                        .unwrap_or_else(|| mirrors.0.clone())
                }),
                apt_security_mirror: official_apt.as_ref().map(|mirrors| {
                    settings
                        .custom
                        .apt_security_mirror
                        .clone()
                        .unwrap_or_else(|| mirrors.1.clone())
                }),
            },
        }
    }

    fn os_release(&self) -> Option<OsRelease> {
        let contents = fs::read_to_string(&self.inner.os_release_path).ok()?;
        let mut values = BTreeMap::new();
        for line in contents.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            if key.is_empty()
                || !key
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
            {
                continue;
            }
            let value = value
                .trim()
                .trim_matches(|character| character == '\'' || character == '"')
                .trim();
            values.insert(key.to_string(), value.to_string());
        }
        Some(OsRelease {
            id: values
                .get("ID")
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_else(|| "unknown".to_string()),
            codename: values
                .get("VERSION_CODENAME")
                .or_else(|| values.get("UBUNTU_CODENAME"))
                .filter(|value| !value.is_empty())
                .cloned(),
            id_like: values
                .get("ID_LIKE")
                .map(|value| {
                    value
                        .split_whitespace()
                        .map(|item| item.to_ascii_lowercase())
                        .collect()
                })
                .unwrap_or_default(),
        })
    }

    fn apt_distro(&self) -> Option<AptDistro> {
        let release = self.os_release()?;
        let family = std::iter::once(release.id.as_str())
            .chain(release.id_like.iter().map(String::as_str))
            .collect::<Vec<_>>();
        if family.contains(&"ubuntu") {
            return Some(AptDistro {
                distro: "ubuntu".to_string(),
                codename: release.codename,
            });
        }
        if family.contains(&"debian") {
            return Some(AptDistro {
                distro: "debian".to_string(),
                codename: release.codename,
            });
        }
        None
    }

    fn official_apt_mirrors(&self) -> (String, String) {
        if self
            .apt_distro()
            .is_some_and(|distro| distro.distro == "ubuntu")
        {
            let ports = matches!(
                self.inner.arch,
                FinalComputerArch::Arm64
                    | FinalComputerArch::Arm
                    | FinalComputerArch::Riscv64
                    | FinalComputerArch::Ppc64
                    | FinalComputerArch::S390x
            );
            if ports {
                return (
                    "https://ports.ubuntu.com/ubuntu-ports".to_string(),
                    "https://ports.ubuntu.com/ubuntu-ports".to_string(),
                );
            }
            return (
                "https://archive.ubuntu.com/ubuntu".to_string(),
                "https://security.ubuntu.com/ubuntu".to_string(),
            );
        }
        (
            "https://deb.debian.org/debian".to_string(),
            "https://security.debian.org/debian-security".to_string(),
        )
    }

    fn china_apt_mirrors(&self) -> (String, String) {
        if self
            .apt_distro()
            .is_some_and(|distro| distro.distro == "ubuntu")
        {
            let ports = matches!(
                self.inner.arch,
                FinalComputerArch::Arm64
                    | FinalComputerArch::Arm
                    | FinalComputerArch::Riscv64
                    | FinalComputerArch::Ppc64
                    | FinalComputerArch::S390x
            );
            let base = if ports {
                "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports"
            } else {
                "https://mirrors.tuna.tsinghua.edu.cn/ubuntu"
            };
            return (base.to_string(), base.to_string());
        }
        (
            "https://mirrors.tuna.tsinghua.edu.cn/debian".to_string(),
            "https://mirrors.tuna.tsinghua.edu.cn/debian-security".to_string(),
        )
    }

    fn private_runtime(&self) -> Option<NodeRuntime> {
        if let Some(runtime) = self.lock().cached_private_runtime.clone() {
            return Some(runtime);
        }
        let manifest_path = self
            .inner
            .data_dir
            .join("toolchains")
            .join("node")
            .join("current.json");
        let value = read_json::<Value>(&manifest_path).ok()?;
        if value.get("version").and_then(Value::as_str) != Some(MANAGED_NODE_VERSION) {
            return None;
        }
        let root = PathBuf::from(value.get("root")?.as_str()?);
        let expected = self
            .inner
            .data_dir
            .join("toolchains")
            .join("node")
            .join(format!("v{MANAGED_NODE_VERSION}"));
        if fs::canonicalize(&root).ok() != fs::canonicalize(&expected).ok() {
            return None;
        }
        let node_executable = root.join("bin").join("node");
        let npm_executable = root.join("bin").join("npm");
        if !node_executable.is_file() || !npm_executable.is_file() {
            return None;
        }
        let runtime = NodeRuntime {
            node_executable,
            npm_executable,
            version: MANAGED_NODE_VERSION.to_string(),
            npm_version: String::new(),
            environment: with_path(&self.inner.env, &root.join("bin")),
        };
        self.lock().cached_private_runtime = Some(runtime.clone());
        Some(runtime)
    }

    fn host_runtime(&self) -> Option<NodeRuntime> {
        let options = ExecutableResolverOptions {
            env: self.inner.env.clone(),
            platform: resolver_platform(self.inner.platform),
            ..ExecutableResolverOptions::default()
        };
        let node = resolve_executable("node", &options)?;
        let npm = resolve_executable("npm", &options)?;
        let mut environment = self.inner.env.clone();
        environment.extend(node.env);
        environment.extend(npm.env);
        Some(NodeRuntime {
            node_executable: node.executable,
            npm_executable: npm.executable,
            version: String::new(),
            npm_version: String::new(),
            environment,
        })
    }

    fn probe_runtime_sync(&self, runtime: &NodeRuntime) -> Option<NodeRuntime> {
        let version = command_version(&runtime.node_executable, &runtime.environment)?;
        let npm_version = command_version(&runtime.npm_executable, &runtime.environment)?;
        Some(NodeRuntime {
            version: version.trim_start_matches('v').trim().to_string(),
            npm_version: npm_version.trim().to_string(),
            ..runtime.clone()
        })
    }

    async fn probe_runtime(&self, runtime: &NodeRuntime) -> Option<NodeRuntime> {
        let version = command_version_async(&runtime.node_executable, &runtime.environment).await?;
        let npm_version =
            command_version_async(&runtime.npm_executable, &runtime.environment).await?;
        Some(NodeRuntime {
            version: version.trim_start_matches('v').trim().to_string(),
            npm_version: npm_version.trim().to_string(),
            ..runtime.clone()
        })
    }

    pub fn node_status(&self) -> AppInstallNodeToolchain {
        if let Some(cached) = self.lock().cached_node_status.clone() {
            if cached.expires_at > Instant::now() {
                return cached.value;
            }
        }
        let value = if let Some(runtime) = self.private_runtime() {
            if let Some(probed) = self.probe_runtime_sync(&runtime) {
                self.lock().cached_private_runtime = Some(probed.clone());
                AppInstallNodeToolchain {
                    state: AppInstallNodeToolchainState::Private,
                    version: Some(probed.version),
                    npm_version: Some(probed.npm_version),
                    minimum_version: MINIMUM_NODE_VERSION.to_string(),
                    managed_version: MANAGED_NODE_VERSION.to_string(),
                    reason: None,
                }
            } else {
                self.missing_node_status()
            }
        } else if let Some(runtime) = self.host_runtime() {
            if let Some(probed) = self.probe_runtime_sync(&runtime) {
                if node_version_at_least(&probed.version, MINIMUM_NODE_VERSION) {
                    AppInstallNodeToolchain {
                        state: AppInstallNodeToolchainState::Host,
                        version: Some(probed.version),
                        npm_version: Some(probed.npm_version),
                        minimum_version: MINIMUM_NODE_VERSION.to_string(),
                        managed_version: MANAGED_NODE_VERSION.to_string(),
                        reason: None,
                    }
                } else {
                    self.missing_node_status()
                }
            } else {
                self.missing_node_status()
            }
        } else {
            self.missing_node_status()
        };
        self.lock().cached_node_status = Some(CachedNodeStatus {
            expires_at: Instant::now() + NODE_STATUS_CACHE_TIME,
            value: value.clone(),
        });
        value
    }

    fn missing_node_status(&self) -> AppInstallNodeToolchain {
        AppInstallNodeToolchain {
            state: AppInstallNodeToolchainState::Missing,
            version: None,
            npm_version: None,
            minimum_version: MINIMUM_NODE_VERSION.to_string(),
            managed_version: MANAGED_NODE_VERSION.to_string(),
            reason: node_artifact(self.inner.platform, self.inner.arch)
                .is_none()
                .then(|| {
                    "A private Node.js toolchain is not available for this platform.".to_string()
                }),
        }
    }

    async fn prepare_node_runtime(
        &self,
        effective: &AppInstallEffectiveSources,
    ) -> Result<NodeRuntime, AppInstallEnvironmentError> {
        if let Some(runtime) = self.private_runtime() {
            if let Some(probed) = self.probe_runtime(&runtime).await {
                return Ok(probed);
            }
            self.lock().cached_private_runtime = None;
        }
        if let Some(runtime) = self.host_runtime() {
            if let Some(probed) = self.probe_runtime(&runtime).await {
                if node_version_at_least(&probed.version, MINIMUM_NODE_VERSION) {
                    return Ok(probed);
                }
            }
        }
        let _guard = self.inner.prepare_lock.lock().await;
        if let Some(runtime) = self.private_runtime() {
            if let Some(probed) = self.probe_runtime(&runtime).await {
                return Ok(probed);
            }
        }
        self.install_private_node_runtime(effective).await
    }

    async fn install_private_node_runtime(
        &self,
        effective: &AppInstallEffectiveSources,
    ) -> Result<NodeRuntime, AppInstallEnvironmentError> {
        let artifact = node_artifact(self.inner.platform, self.inner.arch).ok_or_else(|| {
            AppInstallEnvironmentError::new(
                "node_toolchain_unsupported",
                "A private Node.js toolchain is not available for this platform.",
                409,
            )
        })?;
        let platform_name = platform_node_name(self.inner.platform).ok_or_else(|| {
            AppInstallEnvironmentError::new(
                "node_toolchain_unsupported",
                "A private Node.js toolchain is not available for this platform.",
                409,
            )
        })?;
        let arch_name = platform_arch_name(self.inner.arch).ok_or_else(|| {
            AppInstallEnvironmentError::new(
                "node_toolchain_unsupported",
                "A private Node.js toolchain is not available for this platform.",
                409,
            )
        })?;
        let base = effective
            .node_dist_url
            .as_deref()
            .unwrap_or("https://nodejs.org/dist")
            .trim_end_matches('/');
        let archive_name =
            format!("node-v{MANAGED_NODE_VERSION}-{platform_name}-{arch_name}.tar.gz");
        let url = format!("{base}/v{MANAGED_NODE_VERSION}/{archive_name}");
        let toolchain_root = self.inner.data_dir.join("toolchains").join("node");
        let downloads = self.inner.state_dir.join("downloads");
        fs::create_dir_all(&downloads).map_err(AppInstallEnvironmentError::storage)?;
        restrict_directory(&downloads, 0o700);
        let download = downloads.join(format!("{}-{archive_name}", uuid::Uuid::new_v4()));
        let staging = toolchain_root.join(format!(".staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&staging).map_err(AppInstallEnvironmentError::storage)?;
        restrict_directory(&staging, 0o700);
        let result = async {
            self.download_node_artifact(&url, &download).await?;
            verify_file_sha256(&download, artifact.sha256)?;
            let extracted = staging.join("extracted");
            let download_for_extract = download.clone();
            let extracted_for_task = extracted.clone();
            tokio::task::spawn_blocking(move || {
                extract_node_archive(&download_for_extract, &extracted_for_task)
            })
            .await
            .map_err(|error| {
                AppInstallEnvironmentError::new(
                    "node_archive_invalid",
                    format!("Node.js archive extraction task failed: {error}"),
                    502,
                )
            })??;
            let top = only_directory(&extracted).map_err(|error| {
                AppInstallEnvironmentError::new("node_archive_invalid", error, 502)
            })?;
            let node_executable = top.join("bin").join("node");
            let npm_executable = top.join("bin").join("npm");
            if !node_executable.is_file() || !npm_executable.is_file() {
                return Err(AppInstallEnvironmentError::new(
                    "node_archive_invalid",
                    "The Node.js archive did not contain a usable node and npm executable.",
                    502,
                ));
            }
            fs::create_dir_all(&toolchain_root).map_err(AppInstallEnvironmentError::storage)?;
            restrict_directory(&toolchain_root, 0o700);
            let target = toolchain_root.join(format!("v{MANAGED_NODE_VERSION}"));
            if target.exists() {
                fs::remove_dir_all(&target).map_err(AppInstallEnvironmentError::storage)?;
            }
            fs::rename(&top, &target).map_err(AppInstallEnvironmentError::storage)?;
            let runtime = NodeRuntime {
                node_executable: target.join("bin").join("node"),
                npm_executable: target.join("bin").join("npm"),
                version: MANAGED_NODE_VERSION.to_string(),
                npm_version: String::new(),
                environment: with_path(&self.inner.env, &target.join("bin")),
            };
            let probed = self.probe_runtime(&runtime).await.ok_or_else(|| {
                let _ = fs::remove_dir_all(&target);
                AppInstallEnvironmentError::new(
                    "node_toolchain_verification_failed",
                    "The downloaded Node.js toolchain could not be verified.",
                    502,
                )
            })?;
            if !node_version_at_least(&probed.version, MINIMUM_NODE_VERSION) {
                let _ = fs::remove_dir_all(&target);
                return Err(AppInstallEnvironmentError::new(
                    "node_toolchain_verification_failed",
                    "The downloaded Node.js toolchain does not meet the minimum version.",
                    502,
                ));
            }
            write_json_atomic(
                &toolchain_root.join("current.json"),
                &serde_json::json!({
                    "version": MANAGED_NODE_VERSION,
                    "root": target.display().to_string(),
                    "sha256": artifact.sha256,
                    "sourceUrl": url,
                    "installedAt": now(),
                }),
                Some(0o600),
            )
            .map_err(AppInstallEnvironmentError::storage)?;
            {
                let mut state = self.lock();
                state.cached_private_runtime = Some(probed.clone());
                state.cached_node_status = None;
            }
            self.notify();
            Ok(probed)
        }
        .await;
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(&download);
        result
    }

    async fn download_node_artifact(
        &self,
        url: &str,
        destination: &Path,
    ) -> Result<(), AppInstallEnvironmentError> {
        let response = self
            .inner
            .client
            .get(url)
            .timeout(MAX_DOWNLOAD_TIME)
            .send()
            .await
            .map_err(|error| {
                AppInstallEnvironmentError::new(
                    "node_download_failed",
                    format!("Node.js archive download failed: {error}"),
                    502,
                )
            })?;
        if !response.status().is_success() {
            return Err(AppInstallEnvironmentError::new(
                "node_download_failed",
                format!(
                    "Node.js archive download failed with HTTP {}.",
                    response.status().as_u16()
                ),
                502,
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_NODE_ARCHIVE_BYTES)
        {
            return Err(AppInstallEnvironmentError::new(
                "node_archive_too_large",
                "The Node.js archive exceeds the managed download limit.",
                413,
            ));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(AppInstallEnvironmentError::storage)?;
            restrict_directory(parent, 0o700);
        }
        let mut output = tokio::fs::File::create(destination)
            .await
            .map_err(AppInstallEnvironmentError::storage)?;
        let mut stream = response.bytes_stream();
        let mut received = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                AppInstallEnvironmentError::new(
                    "node_download_failed",
                    format!("Node.js archive download failed: {error}"),
                    502,
                )
            })?;
            received = received.saturating_add(chunk.len() as u64);
            if received > MAX_NODE_ARCHIVE_BYTES {
                return Err(AppInstallEnvironmentError::new(
                    "node_archive_too_large",
                    "The Node.js archive exceeds the managed download limit.",
                    413,
                ));
            }
            output
                .write_all(&chunk)
                .await
                .map_err(AppInstallEnvironmentError::storage)?;
        }
        output
            .flush()
            .await
            .map_err(AppInstallEnvironmentError::storage)?;
        Ok(())
    }

    pub fn apt_source_configuration(
        &self,
        effective: &AppInstallEffectiveSources,
    ) -> Result<Option<AptSourceConfiguration>, AppInstallEnvironmentError> {
        if self.stored_settings().profile == AppInstallSourceProfile::Environment {
            return Ok(None);
        }
        if self.inner.platform != FinalComputerPlatform::Linux {
            return Err(AppInstallEnvironmentError::new(
                "apt_source_unsupported",
                "Custom apt sources are only supported on Linux.",
                409,
            ));
        }
        let distro = self.apt_distro().ok_or_else(|| {
            AppInstallEnvironmentError::new(
                "apt_source_unsupported",
                "The Linux distribution could not be determined for apt source selection.",
                409,
            )
        })?;
        let codename = distro.codename.clone().ok_or_else(|| {
            AppInstallEnvironmentError::new(
                "apt_source_unsupported",
                "The Linux distribution codename could not be determined for apt source selection.",
                409,
            )
        })?;
        let main_mirror = effective
            .apt_main_mirror
            .as_deref()
            .map(|value| value.trim_end_matches('/'))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppInstallEnvironmentError::new(
                    "apt_source_unsupported",
                    "An apt main mirror is required.",
                    409,
                )
            })?;
        let security_mirror = effective
            .apt_security_mirror
            .as_deref()
            .map(|value| value.trim_end_matches('/'))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppInstallEnvironmentError::new(
                    "apt_source_unsupported",
                    "An apt security mirror is required.",
                    409,
                )
            })?;
        let apt_dir = self.inner.state_dir.join("apt");
        let sources_file = apt_dir.join("sources.list");
        let lists_dir = apt_dir.join("lists");
        fs::create_dir_all(&lists_dir).map_err(AppInstallEnvironmentError::storage)?;
        let components = if distro.distro == "ubuntu" {
            "main restricted universe multiverse"
        } else {
            "main contrib non-free"
        };
        let lines = if distro.distro == "ubuntu" {
            vec![
                format!("deb {main_mirror}/ {codename} {components}"),
                format!("deb {main_mirror}/ {codename}-updates {components}"),
                format!("deb {main_mirror}/ {codename}-backports {components}"),
                format!("deb {security_mirror}/ {codename}-security {components}"),
            ]
        } else {
            vec![
                format!("deb {main_mirror}/ {codename} {components}"),
                format!("deb {main_mirror}/ {codename}-updates {components}"),
                format!("deb {security_mirror}/ {codename}-security {components}"),
            ]
        };
        write_atomic(
            &sources_file,
            format!("{}\n", lines.join("\n")).as_bytes(),
            Some(0o644),
        )
        .map_err(AppInstallEnvironmentError::storage)?;
        Ok(Some(AptSourceConfiguration {
            sources_file: sources_file.clone(),
            lists_dir: lists_dir.clone(),
            options: vec![
                "-o".to_string(),
                format!("Dir::Etc::sourcelist={}", sources_file.display()),
                "-o".to_string(),
                "Dir::Etc::sourceparts=-".to_string(),
                "-o".to_string(),
                format!("Dir::State::lists={}", lists_dir.display()),
                "-o".to_string(),
                "APT::Get::List-Cleanup=0".to_string(),
            ],
            main_mirror: main_mirror.to_string(),
            security_mirror: security_mirror.to_string(),
            codename,
            distro: distro.distro,
        }))
    }

    pub async fn test_sources(
        &self,
    ) -> Result<AppInstallEnvironmentTestResponse, AppInstallEnvironmentError> {
        let effective = self.effective_sources();
        let mut urls = Vec::<(AppInstallEnvironmentTestCheckId, String)>::new();
        if let Some(npm) = effective.npm_registry.as_deref() {
            urls.push((
                AppInstallEnvironmentTestCheckId::Npm,
                format!("{}/-/ping", npm.trim_end_matches('/')),
            ));
        }
        if let (Some(node), Some(artifact)) = (
            effective.node_dist_url.as_deref(),
            node_artifact(self.inner.platform, self.inner.arch),
        ) {
            urls.push((
                AppInstallEnvironmentTestCheckId::Node,
                format!(
                    "{}/v{MANAGED_NODE_VERSION}/node-v{MANAGED_NODE_VERSION}-{}.tar.gz",
                    node.trim_end_matches('/'),
                    artifact.name
                ),
            ));
        }
        if let Some(apt) = self.apt_distro() {
            if let Some(codename) = apt.codename.as_deref() {
                if let Some(main) = effective.apt_main_mirror.as_deref() {
                    urls.push((
                        AppInstallEnvironmentTestCheckId::AptMain,
                        format!("{}/dists/{codename}/Release", main.trim_end_matches('/')),
                    ));
                }
                if let Some(security) = effective.apt_security_mirror.as_deref() {
                    urls.push((
                        AppInstallEnvironmentTestCheckId::AptSecurity,
                        format!(
                            "{}/dists/{codename}-security/Release",
                            security.trim_end_matches('/')
                        ),
                    ));
                }
            }
        }
        let mut checks = Vec::with_capacity(urls.len());
        for (id, url) in urls {
            let mut response = self
                .inner
                .client
                .head(&url)
                .timeout(SOURCE_TEST_TIME)
                .send()
                .await;
            if !response
                .as_ref()
                .is_ok_and(|response| response.status().is_success())
            {
                response = self
                    .inner
                    .client
                    .get(&url)
                    .header(reqwest::header::RANGE, "bytes=0-0")
                    .timeout(SOURCE_TEST_TIME)
                    .send()
                    .await;
            }
            let check = match response {
                Ok(response) => {
                    let ok = response.status().is_success();
                    AppInstallEnvironmentTestCheck {
                        id,
                        url,
                        ok,
                        status_code: Some(response.status().as_u16()),
                        message: (!ok).then(|| format!("HTTP {}", response.status().as_u16())),
                    }
                }
                Err(error) => AppInstallEnvironmentTestCheck {
                    id,
                    url,
                    ok: false,
                    status_code: None,
                    message: Some(truncate_message(&error.to_string())),
                },
            };
            checks.push(check);
        }
        Ok(AppInstallEnvironmentTestResponse {
            checks,
            tested_at: now(),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredInstallSourcesFile {
    version: u32,
    revision: u64,
    settings: AppInstallSourceSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
}

fn read_stored_sources(path: &Path) -> StoredInstallSources {
    let value = match read_json::<Value>(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return StoredInstallSources::default()
        }
        Err(error) => {
            tracing::warn!(%error, "Install source settings could not be read");
            return StoredInstallSources::default();
        }
    };
    let revision = value.get("revision").and_then(Value::as_u64).unwrap_or(0);
    let settings = sanitize_settings(value.get("settings"));
    StoredInstallSources { revision, settings }
}

fn sanitize_settings(value: Option<&Value>) -> AppInstallSourceSettings {
    let Some(source) = value.and_then(Value::as_object) else {
        return AppInstallSourceSettings::default();
    };
    let profile = match source.get("profile").and_then(Value::as_str) {
        Some("official") => AppInstallSourceProfile::Official,
        Some("china") => AppInstallSourceProfile::China,
        Some("custom") => AppInstallSourceProfile::Custom,
        _ => AppInstallSourceProfile::Environment,
    };
    let custom = source.get("custom").and_then(Value::as_object);
    let field = |name: &str| {
        custom
            .and_then(|custom| custom.get(name))
            .and_then(Value::as_str)
            .and_then(|value| normalize_source_url(value).ok())
    };
    AppInstallSourceSettings {
        profile,
        custom: AppInstallSourceCustom {
            npm_registry: field("npmRegistry"),
            node_dist_url: field("nodeDistUrl"),
            apt_main_mirror: field("aptMainMirror"),
            apt_security_mirror: field("aptSecurityMirror"),
        },
    }
}

fn normalize_settings(
    settings: AppInstallSourceSettings,
) -> Result<AppInstallSourceSettings, AppInstallEnvironmentError> {
    let normalize =
        |value: Option<String>| value.map(|value| normalize_source_url(&value)).transpose();
    Ok(AppInstallSourceSettings {
        profile: settings.profile,
        custom: AppInstallSourceCustom {
            npm_registry: normalize(settings.custom.npm_registry)?,
            node_dist_url: normalize(settings.custom.node_dist_url)?,
            apt_main_mirror: normalize(settings.custom.apt_main_mirror)?,
            apt_security_mirror: normalize(settings.custom.apt_security_mirror)?,
        },
    })
}

fn normalize_source_url(value: &str) -> Result<String, AppInstallEnvironmentError> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(AppInstallEnvironmentError::new(
            "install_sources_input_invalid",
            "Install source URLs must be non-empty HTTPS URLs.",
            400,
        ));
    }
    let url = Url::parse(value).map_err(|_| {
        AppInstallEnvironmentError::new(
            "install_sources_input_invalid",
            "Install source URLs must be valid HTTPS URLs.",
            400,
        )
    })?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppInstallEnvironmentError::new(
            "install_sources_input_invalid",
            "Install source URLs must use HTTPS without credentials, query strings, or fragments.",
            400,
        ));
    }
    Ok(value.to_string())
}

fn apply_npm_registry(env: &mut BTreeMap<String, String>, registry: Option<&str>) {
    if let Some(registry) = registry {
        env.insert("npm_config_registry".to_string(), registry.to_string());
        env.insert("NPM_CONFIG_REGISTRY".to_string(), registry.to_string());
    }
}

fn path_value(env: &BTreeMap<String, String>) -> Option<&String> {
    env.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value)
}

fn with_path(base: &BTreeMap<String, String>, bin_dir: &Path) -> BTreeMap<String, String> {
    let mut env = base.clone();
    let separator = if cfg!(windows) { ';' } else { ':' };
    let current = path_value(base).map(String::as_str).unwrap_or_default();
    let value = if current.is_empty() {
        bin_dir.display().to_string()
    } else {
        format!("{}{separator}{current}", bin_dir.display())
    };
    env.insert("PATH".to_string(), value);
    env
}

fn command_version(executable: &Path, env: &BTreeMap<String, String>) -> Option<String> {
    let mut command = version_command(executable);
    let output = command
        .envs(env)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

async fn command_version_async(
    executable: &Path,
    env: &BTreeMap<String, String>,
) -> Option<String> {
    let mut command = if cfg!(windows)
        && executable
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| {
                value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat")
            }) {
        let mut command = tokio::process::Command::new("cmd.exe");
        command.args([
            "/d",
            "/s",
            "/c",
            &executable.display().to_string(),
            "--version",
        ]);
        command
    } else {
        let mut command = tokio::process::Command::new(executable);
        command.arg("--version");
        command
    };
    let output = tokio::time::timeout(
        VERSION_PROBE_TIME,
        command
            .envs(env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(windows)]
fn version_command(executable: &Path) -> Command {
    if executable
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat"))
    {
        let mut command = Command::new("cmd.exe");
        command.args([
            "/d",
            "/s",
            "/c",
            &executable.display().to_string(),
            "--version",
        ]);
        command
    } else {
        let mut command = Command::new(executable);
        command.arg("--version");
        command
    }
}

#[cfg(not(windows))]
fn version_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command.arg("--version");
    command
}

fn node_version_at_least(actual: &str, minimum: &str) -> bool {
    fn parse(value: &str) -> Option<[u64; 3]> {
        let value = value.trim().trim_start_matches('v');
        let mut parts = value.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts
            .next()?
            .split(|character: char| !character.is_ascii_digit())
            .next()?
            .parse()
            .ok()?;
        Some([major, minor, patch])
    }
    let Some(actual) = parse(actual) else {
        return false;
    };
    let Some(minimum) = parse(minimum) else {
        return false;
    };
    actual >= minimum
}

fn verify_file_sha256(path: &Path, expected: &str) -> Result<(), AppInstallEnvironmentError> {
    let mut file = File::open(path).map_err(AppInstallEnvironmentError::storage)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(AppInstallEnvironmentError::storage)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    let digest = hex::encode(hash.finalize());
    if !digest.eq_ignore_ascii_case(expected) {
        return Err(AppInstallEnvironmentError::new(
            "node_archive_checksum_mismatch",
            "Node.js archive checksum verification failed.",
            502,
        ));
    }
    Ok(())
}

fn extract_node_archive(
    archive_path: &Path,
    destination: &Path,
) -> Result<(), AppInstallEnvironmentError> {
    fs::create_dir_all(destination).map_err(AppInstallEnvironmentError::storage)?;
    let file = File::open(archive_path).map_err(AppInstallEnvironmentError::storage)?;
    let mut archive = Archive::new(GzDecoder::new(file));
    let entries = archive.entries().map_err(|error| {
        AppInstallEnvironmentError::new("node_archive_invalid", error.to_string(), 502)
    })?;
    for entry in entries {
        let mut entry = entry.map_err(|error| {
            AppInstallEnvironmentError::new("node_archive_invalid", error.to_string(), 502)
        })?;
        let path = entry.path().map_err(|error| {
            AppInstallEnvironmentError::new("node_archive_invalid", error.to_string(), 502)
        })?;
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(AppInstallEnvironmentError::new(
                "node_archive_invalid",
                "The Node.js archive contains an unsafe path.",
                502,
            ));
        }
        if !entry.unpack_in(destination).map_err(|error| {
            AppInstallEnvironmentError::new("node_archive_invalid", error.to_string(), 502)
        })? {
            return Err(AppInstallEnvironmentError::new(
                "node_archive_invalid",
                "The Node.js archive contains a path outside the extraction root.",
                502,
            ));
        }
    }
    Ok(())
}

fn only_directory(root: &Path) -> Result<PathBuf, String> {
    let mut directories = fs::read_dir(root)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    if directories.len() != 1 {
        return Err(
            "The Node.js archive did not contain exactly one top-level directory.".to_string(),
        );
    }
    Ok(directories.remove(0))
}

fn truncate_message(value: &str) -> String {
    let mut value = value.chars().take(500).collect::<String>();
    if value.is_empty() {
        value = "Source connection failed.".to_string();
    }
    value
}

fn restrict_directory(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager(root: &Path) -> AppInstallEnvironmentManager {
        let os_release = root.join("os-release");
        std::fs::write(
            &os_release,
            "ID=ubuntu\nVERSION_CODENAME=noble\nID_LIKE=debian\n",
        )
        .expect("os release");
        let mut options = AppInstallEnvironmentOptions::new(root.join("data"), root.join("state"));
        options.os_release_path = os_release;
        options.platform = FinalComputerPlatform::Linux;
        options.arch = FinalComputerArch::X64;
        AppInstallEnvironmentManager::with_options(options)
    }

    fn update(profile: AppInstallSourceProfile) -> AppInstallSourceUpdate {
        AppInstallSourceUpdate {
            expected_revision: None,
            settings: AppInstallSourceSettings {
                profile,
                custom: AppInstallSourceCustom::default(),
            },
        }
    }

    #[test]
    fn source_profiles_resolve_expected_effective_urls() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let environment = manager(temporary.path());
        assert!(environment.effective_sources().npm_registry.is_none());

        environment
            .update(update(AppInstallSourceProfile::Official))
            .expect("official");
        let official = environment.effective_sources();
        assert_eq!(
            official.npm_registry.as_deref(),
            Some("https://registry.npmjs.org")
        );
        assert_eq!(
            official.node_dist_url.as_deref(),
            Some("https://nodejs.org/dist")
        );

        environment
            .update(update(AppInstallSourceProfile::China))
            .expect("china");
        let china = environment.effective_sources();
        assert_eq!(
            china.npm_registry.as_deref(),
            Some("https://registry.npmmirror.com")
        );
        assert_eq!(
            china.apt_main_mirror.as_deref(),
            Some("https://mirrors.tuna.tsinghua.edu.cn/ubuntu")
        );
    }

    #[test]
    fn non_linux_profiles_do_not_project_unsupported_apt_sources() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let mut options = AppInstallEnvironmentOptions::new(
            temporary.path().join("data"),
            temporary.path().join("state"),
        );
        options.platform = FinalComputerPlatform::Darwin;
        options.arch = FinalComputerArch::Arm64;
        let environment = AppInstallEnvironmentManager::with_options(options);

        environment
            .update(update(AppInstallSourceProfile::China))
            .expect("china");
        let effective = environment.effective_sources();
        assert_eq!(
            effective.npm_registry.as_deref(),
            Some("https://registry.npmmirror.com")
        );
        assert_eq!(
            effective.node_dist_url.as_deref(),
            Some("https://mirrors.cloud.tencent.com/nodejs-release")
        );
        assert!(effective.apt_main_mirror.is_none());
        assert!(effective.apt_security_mirror.is_none());
        assert!(!environment.supports_apt_sources());
    }

    #[test]
    fn update_rejects_stale_revisions_and_unsafe_urls() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let environment = manager(temporary.path());
        let first = update(AppInstallSourceProfile::Official);
        environment.update(first.clone()).expect("first update");
        let mut stale = first;
        stale.expected_revision = Some(0);
        assert_eq!(
            environment.update(stale).unwrap_err().code,
            "install_sources_revision_conflict"
        );

        let mut insecure = update(AppInstallSourceProfile::Custom);
        insecure.settings.custom.npm_registry = Some("http://registry.example.test".to_string());
        assert_eq!(
            environment.update(insecure).unwrap_err().code,
            "install_sources_input_invalid"
        );
        let mut credentials = update(AppInstallSourceProfile::Custom);
        credentials.settings.custom.apt_main_mirror =
            Some("https://user:secret@example.test/debian".to_string());
        assert_eq!(
            environment.update(credentials).unwrap_err().code,
            "install_sources_input_invalid"
        );
    }

    #[test]
    fn stored_settings_ignore_unknown_fields_and_invalid_urls() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let data = temporary.path().join("data");
        std::fs::create_dir_all(&data).expect("data directory");
        std::fs::write(
            data.join(SOURCE_FILE),
            serde_json::json!({
                "revision": 7,
                "unknown": true,
                "settings": {
                    "profile": "custom",
                    "custom": {
                        "npmRegistry": "https://registry.example.test/",
                        "nodeDistUrl": "http://insecure.example.test",
                        "futureField": "ignored"
                    }
                }
            })
            .to_string(),
        )
        .expect("settings file");
        let environment = manager(temporary.path());
        assert_eq!(environment.revision(), 7);
        assert_eq!(
            environment.settings().custom.npm_registry.as_deref(),
            Some("https://registry.example.test")
        );
        assert!(environment.settings().custom.node_dist_url.is_none());
    }

    #[test]
    fn apt_sources_are_written_to_an_isolated_task_file() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let environment = manager(temporary.path());
        environment
            .update(update(AppInstallSourceProfile::China))
            .expect("update");
        let apt = environment
            .apt_source_configuration(&environment.effective_sources())
            .expect("apt configuration")
            .expect("apt sources");
        assert_eq!(apt.codename, "noble");
        assert_eq!(apt.distro, "ubuntu");
        assert!(apt
            .sources_file
            .starts_with(temporary.path().join("state").join("apt")));
        assert!(apt
            .options
            .iter()
            .any(|value| value.starts_with("Dir::Etc::sourcelist=")));
        let sources = std::fs::read_to_string(&apt.sources_file).expect("sources list");
        assert!(sources.contains("mirrors.tuna.tsinghua.edu.cn/ubuntu/ noble"));
        assert!(!Path::new("/etc/apt/sources.list").starts_with(temporary.path()));
    }

    #[test]
    fn node_archive_checksum_mismatch_is_rejected() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let archive = temporary.path().join("node.tar.gz");
        std::fs::write(&archive, b"not the expected archive").expect("archive");
        let error = verify_file_sha256(&archive, &"0".repeat(64)).expect_err("checksum mismatch");
        assert_eq!(error.code, "node_archive_checksum_mismatch");
    }
}
