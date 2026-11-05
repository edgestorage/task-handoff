use std::{collections::BTreeMap, path::PathBuf, sync::LazyLock, time::Duration};

use controlled_instance_core::text::truncate_utf16;
use controlled_instance_protocol::{
    AppInstallPrivilege, AppInstaller, FinalComputerCapabilities, ManagedAppUpdateStatus,
};
use regex::Regex;
use serde_json::Value;

use crate::{
    install_environment::{AppInstallEnvironmentManager, AppInstallExecutionPolicy},
    run_app_recipe_command, AppRecipeCommand, AppRecipeCommandResult, AppRecipeHooks,
    InstallRecipe,
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_VERSION_CHARS: usize = 120;

static PACKAGE_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9][A-Za-z0-9+._:@/-]{0,199}$")
        .expect("the system package name pattern is valid")
});
static NODE_PACKAGE_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:@[a-z0-9][a-z0-9._-]{0,99}/)?[a-z0-9][a-z0-9._-]{0,99}$")
        .expect("the Node package name pattern is valid")
});
static POLICY_BLOCK_SEPARATOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n\s*\n").expect("the apt policy block separator is valid"));

#[derive(Clone, Copy)]
struct NodeUpdateCheckOptions<'a> {
    managed: bool,
    version: Option<&'a str>,
    privilege: AppInstallPrivilege,
    managed_context: Option<(&'a str, &'a std::path::Path)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppUpdateCheckResult {
    pub status: ManagedAppUpdateStatus,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub reason: Option<String>,
}

impl AppUpdateCheckResult {
    fn new(status: ManagedAppUpdateStatus) -> Self {
        Self {
            status,
            installed_version: None,
            latest_version: None,
            reason: None,
        }
    }

    fn installed(mut self, value: Option<&str>) -> Self {
        self.installed_version = version(value);
        self
    }

    fn latest(mut self, value: Option<&str>) -> Self {
        self.latest_version = version(value);
        self
    }

    fn reason(mut self, value: impl Into<String>) -> Self {
        let value = value.into();
        self.reason =
            (!value.trim().is_empty()).then(|| truncate_utf16(value.trim(), MAX_VERSION_CHARS));
        self
    }
}

fn version(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_utf16(value, MAX_VERSION_CHARS))
}

fn first_line(value: &str) -> Option<&str> {
    value.lines().map(str::trim).find(|line| !line.is_empty())
}

fn package_name_valid(value: &str) -> bool {
    PACKAGE_NAME.is_match(value)
}

fn node_package_name_valid(value: &str) -> bool {
    NODE_PACKAGE_NAME.is_match(value)
}

pub fn parse_apt_policy(stdout: &str) -> AppUpdateCheckResult {
    let mut installed_version = None;
    let mut latest_version = None;
    for block in POLICY_BLOCK_SEPARATOR.split(stdout) {
        let installed = block
            .lines()
            .find_map(|line| policy_value(line, "Installed:"));
        let candidate = block
            .lines()
            .find_map(|line| policy_value(line, "Candidate:"));
        if installed_version.is_none() {
            installed_version = installed.map(ToString::to_string);
        }
        if latest_version.is_none() {
            latest_version = candidate.map(ToString::to_string);
        }
        if let (Some(installed), Some(candidate)) = (installed, candidate) {
            if installed != candidate {
                return AppUpdateCheckResult::new(ManagedAppUpdateStatus::UpdateAvailable)
                    .installed(Some(installed))
                    .latest(Some(candidate));
            }
        }
    }
    AppUpdateCheckResult::new(ManagedAppUpdateStatus::UpToDate)
        .installed(installed_version.as_deref())
        .latest(latest_version.as_deref())
}

fn policy_value<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    line.trim()
        .strip_prefix(prefix)?
        .split_whitespace()
        .next()
        .filter(|value| !value.is_empty() && *value != "(none)")
}

pub fn parse_brew_outdated(stdout: &str) -> AppUpdateCheckResult {
    let Ok(parsed) = serde_json::from_str::<Value>(stdout) else {
        return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
            .reason("brew outdated output could not be parsed.");
    };
    let source = parsed.as_object();
    let entries = ["formulae", "casks"]
        .into_iter()
        .filter_map(|name| {
            source
                .and_then(|source| source.get(name))
                .and_then(Value::as_array)
        })
        .flatten()
        .collect::<Vec<_>>();
    for entry in entries {
        let Some(record) = entry.as_object() else {
            continue;
        };
        let installed = record
            .get("installed")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("version").and_then(Value::as_str))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        let latest = record.get("current_version").and_then(Value::as_str);
        if let Some(latest) = latest.filter(|latest| !latest.is_empty()) {
            if installed.is_empty() || installed.iter().any(|value| *value != latest) {
                return AppUpdateCheckResult::new(ManagedAppUpdateStatus::UpdateAvailable)
                    .installed(installed.first().copied())
                    .latest(Some(latest));
            }
        }
    }
    AppUpdateCheckResult::new(ManagedAppUpdateStatus::UpToDate)
}

fn parse_dnf_update(stdout: &str, packages: &[String]) -> Option<String> {
    for line in stdout.lines() {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 2 {
            continue;
        }
        let (name, latest) = (parts[0], parts[1]);
        if packages
            .iter()
            .any(|package| name == package || name.starts_with(&format!("{package}.")))
        {
            return version(Some(latest));
        }
    }
    None
}

fn parse_npm_outdated(stdout: &str) -> AppUpdateCheckResult {
    let Ok(parsed) = serde_json::from_str::<Value>(stdout) else {
        return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
            .reason("npm outdated output could not be parsed.");
    };
    let entries = match parsed {
        Value::Object(entries) => entries.into_values().collect::<Vec<_>>(),
        Value::Array(entries) => entries,
        _ => {
            return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                .reason("npm outdated returned an unexpected payload.");
        }
    };
    for entry in entries {
        let Some(record) = entry.as_object() else {
            continue;
        };
        let current = version(record.get("current").and_then(Value::as_str));
        let latest = version(record.get("latest").and_then(Value::as_str));
        if latest.is_some() && latest != current {
            return AppUpdateCheckResult::new(ManagedAppUpdateStatus::UpdateAvailable)
                .installed(current.as_deref())
                .latest(latest.as_deref());
        }
    }
    AppUpdateCheckResult::new(ManagedAppUpdateStatus::UpToDate)
}

pub struct AppUpdateChecker {
    env: BTreeMap<String, String>,
    timeout: Duration,
    state_dir: Option<PathBuf>,
    install_environment: Option<AppInstallEnvironmentManager>,
}

impl Default for AppUpdateChecker {
    fn default() -> Self {
        Self::new()
    }
}

impl AppUpdateChecker {
    pub fn new() -> Self {
        let mut env = std::env::vars().collect::<BTreeMap<_, _>>();
        env.insert("LC_ALL".to_string(), "C".to_string());
        env.insert("LANG".to_string(), "C".to_string());
        Self {
            env,
            timeout: DEFAULT_TIMEOUT,
            state_dir: None,
            install_environment: None,
        }
    }

    pub fn with_install_environment(
        mut self,
        state_dir: impl Into<PathBuf>,
        install_environment: AppInstallEnvironmentManager,
    ) -> Self {
        self.state_dir = Some(state_dir.into());
        self.install_environment = Some(install_environment);
        self
    }

    pub async fn check(
        &self,
        recipe: &InstallRecipe,
        capabilities: &FinalComputerCapabilities,
    ) -> AppUpdateCheckResult {
        self.check_with_install_root(recipe, capabilities, None)
            .await
    }

    pub async fn check_with_install_root(
        &self,
        recipe: &InstallRecipe,
        capabilities: &FinalComputerCapabilities,
        managed_context: Option<(&str, &std::path::Path)>,
    ) -> AppUpdateCheckResult {
        let policy = self
            .install_environment
            .as_ref()
            .map(|environment| environment.create_execution_policy());
        self.check_with_install_root_and_policy(
            recipe,
            capabilities,
            managed_context,
            policy.as_ref(),
        )
        .await
    }

    async fn check_with_install_root_and_policy(
        &self,
        recipe: &InstallRecipe,
        capabilities: &FinalComputerCapabilities,
        managed_context: Option<(&str, &std::path::Path)>,
        source_policy: Option<&AppInstallExecutionPolicy>,
    ) -> AppUpdateCheckResult {
        match recipe {
            InstallRecipe::Bundled { .. } => AppUpdateCheckResult::new(
                ManagedAppUpdateStatus::Unsupported,
            )
            .reason("Bundled apps ship with the controlled computer and have no update source."),
            InstallRecipe::Archive { .. } => {
                AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unsupported)
                    .reason("Archive updates are delivered with the built-in app definition.")
            }
            InstallRecipe::SystemPackage {
                installer,
                packages,
                ..
            } => {
                self.check_system(*installer, packages, capabilities, source_policy)
                    .await
            }
            InstallRecipe::NodePackage {
                installer,
                packages,
                managed,
                version,
                privilege,
                ..
            } => {
                self.check_node(
                    *installer,
                    packages,
                    NodeUpdateCheckOptions {
                        managed: *managed,
                        version: version.as_deref(),
                        privilege: privilege.unwrap_or(AppInstallPrivilege::User),
                        managed_context,
                    },
                    capabilities,
                    source_policy,
                )
                .await
            }
        }
    }

    async fn check_system(
        &self,
        installer: AppInstaller,
        packages: &[String],
        capabilities: &FinalComputerCapabilities,
        source_policy: Option<&AppInstallExecutionPolicy>,
    ) -> AppUpdateCheckResult {
        if packages.is_empty() || packages.iter().any(|package| !package_name_valid(package)) {
            return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                .reason("The built-in system package recipe contains an invalid package name.");
        }
        if !capabilities.installers.contains(&installer) {
            return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown).reason(format!(
                "The {} installer is unavailable.",
                installer.as_str()
            ));
        }
        match installer {
            AppInstaller::Apt => {
                let apt_options = match source_policy
                    .map(AppInstallExecutionPolicy::apt_source_configuration)
                    .transpose()
                {
                    Ok(configuration) => configuration
                        .flatten()
                        .map(|configuration| configuration.options)
                        .unwrap_or_default(),
                    Err(error) => {
                        return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                            .reason(error.message)
                    }
                };
                let mut args = apt_options;
                args.push("policy".to_string());
                let response = self
                    .run(
                        "apt-cache",
                        &args,
                        packages,
                        false,
                        capabilities.platform,
                        &self.env,
                    )
                    .await;
                if response.exit_code != 0 {
                    return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                        .reason(first_line(&response.stderr).unwrap_or("apt-cache failed."));
                }
                parse_apt_policy(&response.stdout)
            }
            AppInstaller::Dnf => {
                let response = self
                    .run(
                        "dnf",
                        &["-q", "check-update"],
                        packages,
                        false,
                        capabilities.platform,
                        &self.env,
                    )
                    .await;
                if response.exit_code == 100 {
                    return AppUpdateCheckResult::new(ManagedAppUpdateStatus::UpdateAvailable)
                        .latest(parse_dnf_update(&response.stdout, packages).as_deref());
                }
                if response.exit_code == 0 {
                    return AppUpdateCheckResult::new(ManagedAppUpdateStatus::UpToDate);
                }
                AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                    .reason(first_line(&response.stderr).unwrap_or("dnf check-update failed."))
            }
            AppInstaller::Brew => {
                let response = self
                    .run(
                        "brew",
                        &["outdated", "--json=v2"],
                        packages,
                        false,
                        capabilities.platform,
                        &self.env,
                    )
                    .await;
                if response.exit_code != 0 && response.stdout.trim().is_empty() {
                    return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                        .reason(first_line(&response.stderr).unwrap_or("brew outdated failed."));
                }
                parse_brew_outdated(&response.stdout)
            }
            AppInstaller::Npm => unreachable!(),
        }
    }

    async fn check_node(
        &self,
        installer: AppInstaller,
        packages: &[String],
        options: NodeUpdateCheckOptions<'_>,
        capabilities: &FinalComputerCapabilities,
        source_policy: Option<&AppInstallExecutionPolicy>,
    ) -> AppUpdateCheckResult {
        let NodeUpdateCheckOptions {
            managed,
            version,
            privilege: recipe_privilege,
            managed_context,
        } = options;
        if managed {
            let Some(version) = version else {
                return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                    .reason("The managed Node package recipe has no pinned version.");
            };
            let Some((app_id, install_base_dir)) = managed_context else {
                return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                    .reason("The managed app install root is unavailable.");
            };
            let manifest_path = install_base_dir
                .join("node-package")
                .join(app_id)
                .join("managed-app.json");
            let mut installed = BTreeMap::<String, String>::new();
            if let Ok(raw) = std::fs::read_to_string(manifest_path) {
                if let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&raw) {
                    if let Some(Value::Object(packages)) = record.get("packages") {
                        for (package, value) in packages {
                            if let Some(value) = value.as_str() {
                                installed.insert(package.clone(), value.to_string());
                            }
                        }
                    }
                }
            }
            let versions = packages
                .iter()
                .map(|package| installed.get(package).cloned())
                .collect::<Vec<_>>();
            if versions
                .iter()
                .all(|value| value.as_deref() == Some(version))
            {
                return AppUpdateCheckResult::new(ManagedAppUpdateStatus::UpToDate)
                    .installed(Some(version))
                    .latest(Some(version));
            }
            return AppUpdateCheckResult::new(ManagedAppUpdateStatus::UpdateAvailable)
                .installed(versions.iter().find_map(|value| value.as_deref()))
                .latest(Some(version));
        }
        if packages.is_empty()
            || packages
                .iter()
                .any(|package| !node_package_name_valid(package))
        {
            return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                .reason("The built-in Node package recipe contains an invalid package name.");
        }
        if !capabilities.installers.contains(&installer) {
            return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown).reason(format!(
                "The {} installer is unavailable.",
                installer.as_str()
            ));
        }
        let elevate = capabilities.privilege == AppInstallPrivilege::PasswordlessSudo
            && recipe_privilege != AppInstallPrivilege::User;
        let mut env = self.env.clone();
        if let Some(policy) = source_policy {
            if let Err(error) = policy.prepare_node_runtime().await {
                return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                    .reason(error.message);
            }
            env = policy.node_environment(&env);
        }
        if let Some(state_dir) = self.state_dir.as_ref() {
            env.insert(
                "npm_config_cache".to_string(),
                state_dir.join("npm-cache").display().to_string(),
            );
        }
        let response = self
            .run(
                "npm",
                &[
                    "outdated".to_string(),
                    "--global".to_string(),
                    "--json".to_string(),
                    "--depth=0".to_string(),
                ],
                packages,
                elevate,
                capabilities.platform,
                &env,
            )
            .await;
        if response.stdout.trim().is_empty() {
            if matches!(response.exit_code, 0 | 1) {
                return AppUpdateCheckResult::new(ManagedAppUpdateStatus::UpToDate);
            }
            return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                .reason(first_line(&response.stderr).unwrap_or("npm outdated failed."));
        }
        parse_npm_outdated(&response.stdout)
    }

    async fn run<S: AsRef<str>>(
        &self,
        executable: &str,
        prefix_args: &[S],
        packages: &[String],
        elevate: bool,
        platform: controlled_instance_protocol::FinalComputerPlatform,
        env: &BTreeMap<String, String>,
    ) -> AppRecipeCommandResult {
        let platform = match platform {
            controlled_instance_protocol::FinalComputerPlatform::Linux => {
                crate::executable_resolver::Platform::Linux
            }
            controlled_instance_protocol::FinalComputerPlatform::Darwin => {
                crate::executable_resolver::Platform::MacOs
            }
            controlled_instance_protocol::FinalComputerPlatform::Win32 => {
                crate::executable_resolver::Platform::Windows
            }
            _ => crate::executable_resolver::Platform::OtherUnix,
        };
        let defaults = crate::executable_resolver::ExecutableResolverOptions::default();
        let mut resolver_env = defaults.env.clone();
        resolver_env.extend(env.clone());
        let resolver_options = crate::executable_resolver::ExecutableResolverOptions {
            platform,
            env: resolver_env,
            ..defaults
        };
        let resolution_path =
            crate::executable_resolver::resolve_executable(executable, &resolver_options)
                .map(|resolution| resolution.executable)
                .unwrap_or_else(|| PathBuf::from(executable));
        let args = prefix_args
            .iter()
            .map(|value| value.as_ref().to_string())
            .chain(packages.iter().cloned())
            .collect::<Vec<_>>();
        let command = if elevate {
            let mut forwarded = Vec::new();
            for key in [
                "PATH",
                "npm_config_registry",
                "NPM_CONFIG_REGISTRY",
                "npm_config_cache",
            ] {
                if let Some((name, value)) =
                    env.iter().find(|(name, _)| name.eq_ignore_ascii_case(key))
                {
                    forwarded.push(format!("{name}={value}"));
                }
            }
            AppRecipeCommand {
                executable: "sudo".to_string(),
                args: ["-n".to_string(), "env".to_string()]
                    .into_iter()
                    .chain(forwarded)
                    .chain(std::iter::once(resolution_path.display().to_string()))
                    .chain(args)
                    .collect(),
                env: BTreeMap::new(),
                timeout: self.timeout,
                termination_grace: Duration::from_secs(5),
            }
        } else {
            AppRecipeCommand {
                executable: resolution_path.display().to_string(),
                args,
                env: env.clone(),
                timeout: self.timeout,
                termination_grace: Duration::from_secs(5),
            }
        };
        run_app_recipe_command(command, AppRecipeHooks::default())
            .await
            .unwrap_or_else(|error| AppRecipeCommandResult {
                exit_code: -1,
                stdout: String::new(),
                stderr: error.message,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_protocol::{FinalComputerArch, FinalComputerPlatform};

    #[test]
    fn parsers_match_the_node_update_check_contract() {
        let apt = parse_apt_policy("thctl:\n  Installed: 0.0.45\n  Candidate: 0.0.46\n");
        assert_eq!(apt.status, ManagedAppUpdateStatus::UpdateAvailable);
        assert_eq!(apt.installed_version.as_deref(), Some("0.0.45"));
        assert_eq!(apt.latest_version.as_deref(), Some("0.0.46"));

        let brew = parse_brew_outdated(
            r#"{"formulae":[{"installed":[{"version":"1.0.0"}],"current_version":"1.1.0"}],"casks":[]}"#,
        );
        assert_eq!(brew.status, ManagedAppUpdateStatus::UpdateAvailable);
        assert_eq!(brew.latest_version.as_deref(), Some("1.1.0"));
    }

    #[tokio::test]
    async fn managed_node_updates_compare_the_manifest_with_the_pinned_version() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let manifest_dir = temporary.path().join("node-package").join("codex");
        std::fs::create_dir_all(&manifest_dir).expect("manifest directory");
        std::fs::write(
            manifest_dir.join("managed-app.json"),
            r#"{"appId":"codex","packages":{"@openai/codex":"0.165.0"}}"#,
        )
        .expect("manifest");
        let recipe = InstallRecipe::NodePackage {
            platforms: vec![FinalComputerPlatform::Linux],
            arches: Some(vec![FinalComputerArch::X64]),
            privilege: Some(AppInstallPrivilege::User),
            installer: AppInstaller::Npm,
            packages: vec!["@openai/codex".to_string()],
            managed: true,
            version: Some("0.165.0".to_string()),
        };
        let capabilities = FinalComputerCapabilities {
            platform: FinalComputerPlatform::Linux,
            arch: FinalComputerArch::X64,
            installers: vec![AppInstaller::Npm],
            privilege: AppInstallPrivilege::User,
            installer_access: None,
        };
        let check = AppUpdateChecker::new()
            .check_with_install_root(&recipe, &capabilities, Some(("codex", temporary.path())))
            .await;
        assert_eq!(check.status, ManagedAppUpdateStatus::UpToDate);

        std::fs::write(
            manifest_dir.join("managed-app.json"),
            r#"{"appId":"codex","packages":{"@openai/codex":"0.166.0"}}"#,
        )
        .expect("manifest");
        let check = AppUpdateChecker::new()
            .check_with_install_root(&recipe, &capabilities, Some(("codex", temporary.path())))
            .await;
        assert_eq!(check.status, ManagedAppUpdateStatus::UpdateAvailable);
        assert_eq!(check.installed_version.as_deref(), Some("0.166.0"));
        assert_eq!(check.latest_version.as_deref(), Some("0.165.0"));
    }

    #[test]
    fn malformed_outputs_become_unknown_instead_of_claiming_an_update() {
        assert_eq!(
            parse_brew_outdated("not json").status,
            ManagedAppUpdateStatus::Unknown
        );
        assert_eq!(
            parse_npm_outdated("[]").status,
            ManagedAppUpdateStatus::UpToDate
        );
        assert_eq!(
            parse_npm_outdated("null").status,
            ManagedAppUpdateStatus::Unknown
        );
    }

    #[test]
    fn update_check_package_names_match_the_node_patterns() {
        assert!(package_name_valid("codex"));
        assert!(!package_name_valid("@openai/codex"));
        assert!(package_name_valid("libssl1.1:amd64"));
        assert!(!package_name_valid("-invalid"));
        assert!(!package_name_valid("has space"));
        assert!(!package_name_valid(&"a".repeat(201)));

        assert!(node_package_name_valid("codex"));
        assert!(node_package_name_valid("@openai/codex"));
        assert!(node_package_name_valid("Codex"));
        assert!(!node_package_name_valid("@openai/"));
        assert!(!node_package_name_valid("has space"));
        assert!(!node_package_name_valid(&format!("@{}", "a".repeat(101))));
    }

    #[test]
    fn update_check_output_accepts_the_same_valid_json_shapes_as_node() {
        assert_eq!(
            parse_brew_outdated("[]").status,
            ManagedAppUpdateStatus::UpToDate
        );
        assert_eq!(
            parse_brew_outdated("\"not-an-object\"").status,
            ManagedAppUpdateStatus::UpToDate
        );
        assert_eq!(
            parse_brew_outdated("not json").status,
            ManagedAppUpdateStatus::Unknown
        );
        assert_eq!(
            parse_brew_outdated(r#"{"formulae":[{"installed":[],"current_version":""}]}"#).status,
            ManagedAppUpdateStatus::UpToDate
        );
    }

    #[test]
    fn update_check_reasons_use_the_node_character_limit() {
        let result =
            AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown).reason("x".repeat(500));
        assert_eq!(result.reason.as_deref(), Some("x".repeat(120).as_str()));
    }

    #[test]
    fn apt_policy_blocks_allow_whitespace_only_separator_lines() {
        let result = parse_apt_policy(
            "one:\n  Installed: 1.0\n  Candidate: 1.0\n   \ntwo:\n  Installed: 2.0\n  Candidate: 2.1\n",
        );
        assert_eq!(result.status, ManagedAppUpdateStatus::UpdateAvailable);
        assert_eq!(result.installed_version.as_deref(), Some("2.0"));
        assert_eq!(result.latest_version.as_deref(), Some("2.1"));
    }
}
