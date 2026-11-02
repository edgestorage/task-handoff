use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use controlled_instance_protocol::{
    AppInstallPrivilege, AppInstaller, FinalComputerCapabilities, ManagedAppUpdateStatus,
};
use serde_json::Value;

use crate::{
    resolve_executable, run_app_recipe_command, AppRecipeCommand, AppRecipeCommandResult,
    AppRecipeHooks, InstallRecipe,
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_VERSION_CHARS: usize = 120;

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
        self.reason = (!value.trim().is_empty()).then(|| value.trim().chars().take(500).collect());
        self
    }
}

fn version(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(MAX_VERSION_CHARS).collect())
}

fn first_line(value: &str) -> Option<&str> {
    value.lines().map(str::trim).find(|line| !line.is_empty())
}

pub fn parse_apt_policy(stdout: &str) -> AppUpdateCheckResult {
    let mut installed_version = None;
    let mut latest_version = None;
    for block in stdout.split("\n\n") {
        let installed = block.lines().find_map(|line| {
            line.trim()
                .strip_prefix("Installed:")
                .map(str::trim)
                .filter(|value| !value.is_empty() && *value != "(none)")
        });
        let candidate = block.lines().find_map(|line| {
            line.trim()
                .strip_prefix("Candidate:")
                .map(str::trim)
                .filter(|value| !value.is_empty() && *value != "(none)")
        });
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

pub fn parse_brew_outdated(stdout: &str) -> AppUpdateCheckResult {
    let Ok(Value::Object(source)) = serde_json::from_str::<Value>(stdout) else {
        return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
            .reason("brew outdated output could not be parsed.");
    };
    let entries = ["formulae", "casks"]
        .into_iter()
        .filter_map(|name| source.get(name).and_then(Value::as_array))
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
        if let Some(latest) = latest {
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
        }
    }

    pub async fn check(
        &self,
        recipe: &InstallRecipe,
        capabilities: &FinalComputerCapabilities,
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
            } => self.check_system(*installer, packages, capabilities).await,
            InstallRecipe::NodePackage {
                installer,
                packages,
                privilege,
                ..
            } => {
                self.check_node(
                    *installer,
                    packages,
                    privilege.unwrap_or(AppInstallPrivilege::User),
                    capabilities,
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
    ) -> AppUpdateCheckResult {
        if packages.is_empty()
            || packages
                .iter()
                .any(|package| package.is_empty() || package.len() > 200)
        {
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
                let response = self.run("apt-cache", &["policy"], packages, false).await;
                if response.exit_code != 0 {
                    return AppUpdateCheckResult::new(ManagedAppUpdateStatus::Unknown)
                        .reason(first_line(&response.stderr).unwrap_or("apt-cache failed."));
                }
                parse_apt_policy(&response.stdout)
            }
            AppInstaller::Dnf => {
                let response = self
                    .run("dnf", &["-q", "check-update"], packages, false)
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
                    .run("brew", &["outdated", "--json=v2"], packages, false)
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
        recipe_privilege: AppInstallPrivilege,
        capabilities: &FinalComputerCapabilities,
    ) -> AppUpdateCheckResult {
        if packages.is_empty()
            || packages
                .iter()
                .any(|package| package.is_empty() || package.len() > 201)
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
        let response = self
            .run(
                "npm",
                &["outdated", "--global", "--json", "--depth=0"],
                packages,
                elevate,
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

    async fn run(
        &self,
        executable: &str,
        prefix_args: &[&str],
        packages: &[String],
        elevate: bool,
    ) -> AppRecipeCommandResult {
        let resolution_path = resolve_executable(executable, &self.env, None)
            .unwrap_or_else(|| PathBuf::from(executable));
        let args = prefix_args
            .iter()
            .map(ToString::to_string)
            .chain(packages.iter().cloned())
            .collect::<Vec<_>>();
        let command = if elevate {
            AppRecipeCommand {
                executable: "sudo".to_string(),
                args: ["-n".to_string(), resolution_path.display().to_string()]
                    .into_iter()
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
                env: self.env.clone(),
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
}
