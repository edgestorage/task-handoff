use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use controlled_instance_protocol::{
    AppInstallPrivilege, AppInstaller, AppManagementCommand, AppManagementOperation,
    AppManagementProgress, FinalComputerCapabilities, FinalComputerPlatform,
};
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
use xz2::read::XzDecoder;

use crate::{resolve_executable, InstallRecipe};

const MAX_LOG_CHARS: usize = 8_192;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PACKAGE_COMMAND_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppRecipeExecutionError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl AppRecipeExecutionError {
    pub fn new(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable,
        }
    }
}

impl std::fmt::Display for AppRecipeExecutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AppRecipeExecutionError {}

#[derive(Debug, Clone)]
pub struct AppRecipeCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub timeout: Duration,
    pub termination_grace: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct AppRecipeCommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

type RecipeOutputHook = Arc<dyn Fn(&str, &str) + Send + Sync>;
type RecipePhaseHook = Arc<dyn Fn(&str, Option<AppManagementProgress>) + Send + Sync>;
type RecipeCommandHook = Arc<dyn Fn(AppManagementCommand) + Send + Sync>;

#[derive(Clone, Default)]
pub struct AppRecipeHooks {
    pub on_output: Option<RecipeOutputHook>,
}

#[derive(Clone)]
pub struct AppRecipeExecutionContext {
    pub app_id: String,
    pub capabilities: FinalComputerCapabilities,
    pub on_phase: Option<RecipePhaseHook>,
    pub on_command: Option<RecipeCommandHook>,
    pub on_output: Option<RecipeOutputHook>,
}

#[derive(Clone)]
pub struct AppRecipeExecutor {
    install_base_dir: PathBuf,
    state_dir: PathBuf,
    env: BTreeMap<String, String>,
}

impl AppRecipeExecutor {
    pub fn new(install_base_dir: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Self {
        Self {
            install_base_dir: install_base_dir.into(),
            state_dir: state_dir.into(),
            env: std::env::vars().collect(),
        }
    }

    pub async fn execute(
        &self,
        operation: AppManagementOperation,
        recipe: &InstallRecipe,
        context: &AppRecipeExecutionContext,
    ) -> Result<String, AppRecipeExecutionError> {
        match recipe {
            InstallRecipe::Bundled { .. } => Err(AppRecipeExecutionError::new(
                "bundled_app",
                "Bundled apps do not support managed installation, update, or removal.",
                false,
            )),
            InstallRecipe::SystemPackage {
                installer,
                packages,
                privilege,
                ..
            } => {
                self.system_package(
                    operation,
                    *installer,
                    packages,
                    privilege.unwrap_or(AppInstallPrivilege::User),
                    context,
                )
                .await
            }
            InstallRecipe::NodePackage {
                installer,
                packages,
                privilege,
                ..
            } => {
                self.node_package(
                    operation,
                    *installer,
                    packages,
                    privilege.unwrap_or(AppInstallPrivilege::User),
                    context,
                )
                .await
            }
            InstallRecipe::Archive {
                url,
                sha256,
                format,
                install_root,
                ..
            } => {
                self.archive(operation, url, sha256, format, install_root, context)
                    .await
            }
        }
    }

    async fn system_package(
        &self,
        operation: AppManagementOperation,
        installer: AppInstaller,
        packages: &[String],
        recipe_privilege: AppInstallPrivilege,
        context: &AppRecipeExecutionContext,
    ) -> Result<String, AppRecipeExecutionError> {
        if packages.is_empty()
            || packages
                .iter()
                .any(|package| !valid_system_package(package))
        {
            return Err(AppRecipeExecutionError::new(
                "invalid_builtin_recipe",
                "The built-in system package recipe contains an invalid package name.",
                false,
            ));
        }
        if !context.capabilities.installers.contains(&installer) {
            return Err(AppRecipeExecutionError::new(
                "installer_unavailable",
                format!("The {} installer is unavailable.", installer.as_str()),
                false,
            ));
        }
        phase(
            context,
            match operation {
                AppManagementOperation::Install => "install-package",
                AppManagementOperation::Update => "update-package",
                AppManagementOperation::Uninstall => "uninstall-package",
            },
        );
        let command = system_package_command(
            operation,
            installer,
            packages,
            recipe_privilege,
            &context.capabilities,
            &self.env,
        )?;
        if operation != AppManagementOperation::Uninstall && installer == AppInstaller::Apt {
            let refresh = apt_refresh_command(recipe_privilege, &context.capabilities).await?;
            let result = self.run_command(refresh, context).await?;
            if result.exit_code != 0 {
                return Err(AppRecipeExecutionError::new(
                    "package_manager_failed",
                    bounded(if result.stderr.is_empty() {
                        "The apt package index could not be refreshed."
                    } else {
                        &result.stderr
                    }),
                    true,
                ));
            }
        }
        let result = self.run_command(command, context).await?;
        if result.exit_code != 0 {
            return Err(AppRecipeExecutionError::new(
                "package_manager_failed",
                bounded(if result.stderr.is_empty() {
                    "The system package manager failed."
                } else {
                    &result.stderr
                }),
                true,
            ));
        }
        Ok(bounded(if result.stdout.is_empty() {
            &result.stderr
        } else {
            &result.stdout
        }))
    }

    async fn node_package(
        &self,
        operation: AppManagementOperation,
        installer: AppInstaller,
        packages: &[String],
        recipe_privilege: AppInstallPrivilege,
        context: &AppRecipeExecutionContext,
    ) -> Result<String, AppRecipeExecutionError> {
        if packages.is_empty() || packages.iter().any(|package| !valid_node_package(package)) {
            return Err(AppRecipeExecutionError::new(
                "invalid_builtin_recipe",
                "The built-in Node package recipe contains an invalid package name.",
                false,
            ));
        }
        if !context.capabilities.installers.contains(&installer) {
            return Err(AppRecipeExecutionError::new(
                "installer_unavailable",
                format!("The {} installer is unavailable.", installer.as_str()),
                false,
            ));
        }
        phase(
            context,
            match operation {
                AppManagementOperation::Install => "install-node-package",
                AppManagementOperation::Update => "update-node-package",
                AppManagementOperation::Uninstall => "uninstall-node-package",
            },
        );
        let command = node_package_command(
            operation,
            packages,
            recipe_privilege,
            &context.capabilities,
            &self.env,
        )?;
        let mut result = self.run_command(command.clone(), context).await?;
        if result.exit_code != 0 {
            if let Some(directory) = npm_retirement_directory(&result.stderr, packages) {
                phase(context, "cleanup-node-package");
                let cleanup =
                    npm_retirement_cleanup_command(&command, &directory, &context.capabilities);
                let cleanup_result = self.run_command(cleanup, context).await?;
                if cleanup_result.exit_code != 0 {
                    return Err(AppRecipeExecutionError::new(
                        "package_cleanup_failed",
                        bounded(if cleanup_result.stderr.is_empty() {
                            "The stale Node package directory could not be removed."
                        } else {
                            &cleanup_result.stderr
                        }),
                        true,
                    ));
                }
                result = self.run_command(command, context).await?;
            }
        }
        if result.exit_code != 0 {
            return Err(AppRecipeExecutionError::new(
                "package_manager_failed",
                bounded(if result.stderr.is_empty() {
                    "The Node package manager failed."
                } else {
                    &result.stderr
                }),
                true,
            ));
        }
        Ok(bounded(if result.stdout.is_empty() {
            &result.stderr
        } else {
            &result.stdout
        }))
    }

    async fn archive(
        &self,
        operation: AppManagementOperation,
        url: &str,
        sha256: &str,
        format: &str,
        install_root: &str,
        context: &AppRecipeExecutionContext,
    ) -> Result<String, AppRecipeExecutionError> {
        if format == "zip" {
            return Err(AppRecipeExecutionError::new(
                "unsupported_archive_format",
                "ZIP managed artifacts are not enabled by this controlled instance.",
                false,
            ));
        }
        if !matches!(format, "tar.gz" | "tar.xz") {
            return Err(AppRecipeExecutionError::new(
                "invalid_builtin_recipe",
                "The built-in archive recipe has an unsupported format.",
                false,
            ));
        }
        let root = controlled_path(&self.install_base_dir, install_root)?;
        if operation == AppManagementOperation::Uninstall {
            uninstall_archive(&self.state_dir, context, &root)?;
            return Ok(String::new());
        }
        let staged = self
            .stage_archive(url, sha256, format, &root, context)
            .await?;
        let manifest_path = manifest_path(&self.state_dir, &context.app_id);
        if operation == AppManagementOperation::Update {
            let manifest = read_manifest(&manifest_path, &root)?;
            remove_owned_files(&manifest.install_root, &manifest.files)?;
            copy_tree(&staged.extracted, &manifest.install_root)?;
            write_manifest(
                &manifest_path,
                &context.app_id,
                &manifest.install_root,
                &staged.files,
            )?;
            let _ = fs::remove_dir_all(&staged.staging);
            return Ok(String::new());
        }
        if root.exists() {
            let _ = fs::remove_dir_all(&staged.staging);
            return Err(AppRecipeExecutionError::new(
                "install_target_exists",
                "The managed install target already exists.",
                false,
            ));
        }
        if let Some(parent) = root.parent() {
            fs::create_dir_all(parent).map_err(storage_error)?;
        }
        write_manifest(&manifest_path, &context.app_id, &root, &staged.files)?;
        if let Err(error) = fs::rename(&staged.extracted, &root) {
            let _ = fs::remove_file(&manifest_path);
            let _ = fs::remove_dir_all(&staged.staging);
            return Err(storage_error(error));
        }
        let _ = fs::remove_dir_all(&staged.staging);
        Ok(String::new())
    }

    async fn stage_archive(
        &self,
        url: &str,
        expected_sha256: &str,
        format: &str,
        install_root: &Path,
        context: &AppRecipeExecutionContext,
    ) -> Result<StagedArchive, AppRecipeExecutionError> {
        if !url.starts_with("https://")
            || expected_sha256.len() != 64
            || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(AppRecipeExecutionError::new(
                "invalid_builtin_recipe",
                "Archive recipes require HTTPS and a SHA-256 checksum.",
                false,
            ));
        }
        let staging = create_archive_staging(install_root, &context.app_id)?;
        let artifact = staging.join(format!("artifact.{}", format.replace('.', "-")));
        let extracted = staging.join("root");
        let result = async {
            phase(context, "download");
            self.download(url, &artifact, expected_sha256, context)
                .await?;
            phase(context, "inspect");
            inspect_archive(format, &artifact).map_err(|error| {
                AppRecipeExecutionError::new("archive_inspection_failed", error.message, false)
            })?;
            fs::create_dir_all(&extracted).map_err(storage_error)?;
            phase(context, "extract");
            extract_archive(format, &artifact, &extracted).map_err(|error| {
                AppRecipeExecutionError::new("archive_extraction_failed", error.message, false)
            })?;
            let files = walk_owned_files(&extracted)?;
            Ok(StagedArchive {
                extracted,
                staging: staging.clone(),
                files,
            })
        }
        .await;
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    async fn download(
        &self,
        url: &str,
        destination: &Path,
        expected_sha256: &str,
        context: &AppRecipeExecutionContext,
    ) -> Result<(), AppRecipeExecutionError> {
        let response = reqwest::Client::new()
            .get(url)
            .send()
            .await
            .map_err(|error| {
                AppRecipeExecutionError::new("download_failed", error.to_string(), true)
            })?;
        if !response.status().is_success() {
            return Err(AppRecipeExecutionError::new(
                "download_failed",
                format!("Artifact download failed with HTTP {}.", response.status()),
                true,
            ));
        }
        let declared = response.content_length();
        if declared.is_some_and(|length| length > MAX_ARCHIVE_BYTES) {
            return Err(AppRecipeExecutionError::new(
                "artifact_too_large",
                "Artifact exceeds the managed download limit.",
                false,
            ));
        }
        let mut file = tokio::fs::File::create(destination)
            .await
            .map_err(storage_error)?;
        let mut stream = response.bytes_stream();
        let mut hash = Sha256::new();
        let mut received = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                AppRecipeExecutionError::new("download_failed", error.to_string(), true)
            })?;
            received = received.saturating_add(chunk.len() as u64);
            if received > MAX_ARCHIVE_BYTES {
                return Err(AppRecipeExecutionError::new(
                    "artifact_too_large",
                    "Artifact exceeds the managed download limit.",
                    false,
                ));
            }
            hash.update(&chunk);
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                .await
                .map_err(storage_error)?;
            phase_with_progress(
                context,
                "download",
                Some(AppManagementProgress {
                    current: Some(received),
                    total: declared.filter(|total| *total > 0),
                    unit: Some("bytes".to_string()),
                }),
            );
        }
        tokio::io::AsyncWriteExt::flush(&mut file)
            .await
            .map_err(storage_error)?;
        let digest = hex::encode(hash.finalize());
        if !digest.eq_ignore_ascii_case(expected_sha256) {
            return Err(AppRecipeExecutionError::new(
                "checksum_mismatch",
                "Artifact checksum does not match the built-in recipe.",
                false,
            ));
        }
        Ok(())
    }

    async fn run_command(
        &self,
        command: AppRecipeCommand,
        context: &AppRecipeExecutionContext,
    ) -> Result<AppRecipeCommandResult, AppRecipeExecutionError> {
        if let Some(on_command) = &context.on_command {
            on_command(AppManagementCommand {
                executable: command.executable.clone(),
                args: command.args.clone(),
            });
        }
        run_app_recipe_command(
            command,
            AppRecipeHooks {
                on_output: context.on_output.clone(),
            },
        )
        .await
    }
}

struct StagedArchive {
    staging: PathBuf,
    extracted: PathBuf,
    files: Vec<String>,
}

fn create_archive_staging(
    install_root: &Path,
    app_id: &str,
) -> Result<PathBuf, AppRecipeExecutionError> {
    let parent = install_root.parent().ok_or_else(|| {
        AppRecipeExecutionError::new(
            "invalid_builtin_recipe",
            "Archive installRoot must have a parent directory.",
            false,
        )
    })?;
    fs::create_dir_all(parent).map_err(storage_error)?;
    let staging = parent.join(format!(".install-{app_id}-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(storage_error)?;
    Ok(staging)
}

struct ArchiveManifest {
    install_root: PathBuf,
    files: Vec<String>,
}

fn storage_error(error: std::io::Error) -> AppRecipeExecutionError {
    AppRecipeExecutionError::new("app_operation_failed", error.to_string(), true)
}

fn bounded(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    chars[chars.len().saturating_sub(MAX_LOG_CHARS)..]
        .iter()
        .collect()
}

fn phase(context: &AppRecipeExecutionContext, value: &str) {
    phase_with_progress(context, value, None);
}

fn phase_with_progress(
    context: &AppRecipeExecutionContext,
    value: &str,
    progress: Option<AppManagementProgress>,
) {
    if let Some(on_phase) = &context.on_phase {
        on_phase(value, progress);
    }
}

fn valid_system_package(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'+' | b'.' | b'_' | b':' | b'@' | b'/' | b'-')
        })
}

fn valid_node_package(value: &str) -> bool {
    fn segment(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 100
            && value
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    }

    if let Some(scoped) = value.strip_prefix('@') {
        let Some((scope, name)) = scoped.split_once('/') else {
            return false;
        };
        !name.contains('/') && segment(scope) && segment(name)
    } else {
        !value.contains('/') && segment(value)
    }
}

fn resolved_command(
    executable: &str,
    args: Vec<String>,
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> AppRecipeCommand {
    let overrides = env.clone();
    let path = resolve_executable(executable, &overrides, None);
    AppRecipeCommand {
        executable: path
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| executable.to_string()),
        args,
        env: BTreeMap::new(),
        timeout,
        termination_grace: Duration::from_secs(5),
    }
}

fn system_package_command(
    operation: AppManagementOperation,
    installer: AppInstaller,
    packages: &[String],
    recipe_privilege: AppInstallPrivilege,
    capabilities: &FinalComputerCapabilities,
    env: &BTreeMap<String, String>,
) -> Result<AppRecipeCommand, AppRecipeExecutionError> {
    let (executable, action): (&str, &[&str]) = match installer {
        AppInstaller::Apt => (
            "apt-get",
            match operation {
                AppManagementOperation::Install => &["install", "-y", "--no-install-recommends"],
                AppManagementOperation::Update => {
                    &["install", "-y", "--only-upgrade", "--no-install-recommends"]
                }
                AppManagementOperation::Uninstall => &["remove", "-y"],
            },
        ),
        AppInstaller::Dnf => (
            "dnf",
            match operation {
                AppManagementOperation::Install => &["install", "-y"],
                AppManagementOperation::Update => &["upgrade", "-y"],
                AppManagementOperation::Uninstall => &["remove", "-y"],
            },
        ),
        AppInstaller::Brew => (
            "brew",
            match operation {
                AppManagementOperation::Install => &["install"],
                AppManagementOperation::Update => &["upgrade"],
                AppManagementOperation::Uninstall => &["uninstall"],
            },
        ),
        AppInstaller::Npm => unreachable!("npm is not a system package installer"),
    };
    let args = action
        .iter()
        .map(ToString::to_string)
        .chain(packages.iter().cloned())
        .collect::<Vec<_>>();
    if capabilities.privilege == AppInstallPrivilege::Root
        || recipe_privilege == AppInstallPrivilege::User
    {
        return Ok(resolved_command(
            executable,
            args,
            env,
            PACKAGE_COMMAND_TIMEOUT,
        ));
    }
    if capabilities.privilege == AppInstallPrivilege::PasswordlessSudo {
        return Ok(AppRecipeCommand {
            executable: "sudo".to_string(),
            args: ["-n".to_string(), executable.to_string()]
                .into_iter()
                .chain(args)
                .collect(),
            env: BTreeMap::new(),
            timeout: PACKAGE_COMMAND_TIMEOUT,
            termination_grace: Duration::from_secs(5),
        });
    }
    Err(AppRecipeExecutionError::new(
        "insufficient_privilege",
        "The controlled instance cannot run this system package recipe.",
        false,
    ))
}

async fn apt_refresh_command(
    recipe_privilege: AppInstallPrivilege,
    capabilities: &FinalComputerCapabilities,
) -> Result<AppRecipeCommand, AppRecipeExecutionError> {
    if capabilities.privilege == AppInstallPrivilege::Root
        || recipe_privilege == AppInstallPrivilege::User
    {
        return Ok(AppRecipeCommand {
            executable: "apt-get".to_string(),
            args: vec!["update".to_string()],
            env: BTreeMap::new(),
            timeout: PACKAGE_COMMAND_TIMEOUT,
            termination_grace: Duration::from_secs(5),
        });
    }
    if capabilities.privilege == AppInstallPrivilege::PasswordlessSudo {
        return Ok(AppRecipeCommand {
            executable: "sudo".to_string(),
            args: vec![
                "-n".to_string(),
                "apt-get".to_string(),
                "update".to_string(),
            ],
            env: BTreeMap::new(),
            timeout: PACKAGE_COMMAND_TIMEOUT,
            termination_grace: Duration::from_secs(5),
        });
    }
    Err(AppRecipeExecutionError::new(
        "insufficient_privilege",
        "The controlled instance cannot refresh the apt package index.",
        false,
    ))
}

fn node_package_command(
    operation: AppManagementOperation,
    packages: &[String],
    recipe_privilege: AppInstallPrivilege,
    capabilities: &FinalComputerCapabilities,
    env: &BTreeMap<String, String>,
) -> Result<AppRecipeCommand, AppRecipeExecutionError> {
    let args = if operation == AppManagementOperation::Uninstall {
        ["uninstall", "--global"]
            .into_iter()
            .map(ToString::to_string)
            .chain(packages.iter().cloned())
            .collect::<Vec<_>>()
    } else {
        [
            "install",
            "--global",
            "--include=optional",
            "--no-audit",
            "--no-fund",
        ]
        .into_iter()
        .map(ToString::to_string)
        .chain(packages.iter().cloned())
        .collect::<Vec<_>>()
    };
    if capabilities.privilege == AppInstallPrivilege::Root
        || recipe_privilege == AppInstallPrivilege::User
    {
        return Ok(resolved_command("npm", args, env, PACKAGE_COMMAND_TIMEOUT));
    }
    if capabilities.privilege == AppInstallPrivilege::PasswordlessSudo {
        return Ok(AppRecipeCommand {
            executable: "sudo".to_string(),
            args: ["-n".to_string(), "npm".to_string()]
                .into_iter()
                .chain(args)
                .collect(),
            env: BTreeMap::new(),
            timeout: PACKAGE_COMMAND_TIMEOUT,
            termination_grace: Duration::from_secs(5),
        });
    }
    Err(AppRecipeExecutionError::new(
        "insufficient_privilege",
        "The controlled instance cannot run this Node package recipe.",
        false,
    ))
}

fn npm_retirement_directory(stderr: &str, packages: &[String]) -> Option<PathBuf> {
    if !stderr
        .lines()
        .any(|line| line.trim() == "npm ERR! code ENOTEMPTY")
    {
        return None;
    }
    let field = |prefix: &str| {
        stderr
            .lines()
            .find_map(|line| line.strip_prefix(prefix).map(str::trim))
            .filter(|value| !value.is_empty())
    };
    let source = PathBuf::from(field("npm ERR! path ")?);
    let destination = PathBuf::from(field("npm ERR! dest ")?);
    if !source.is_absolute() || !destination.is_absolute() || packages.len() != 1 {
        return None;
    }
    let segments = packages[0]
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let leaf = segments.last()?;
    if !source.ends_with(Path::new("node_modules").join(segments.iter().collect::<PathBuf>()))
        || source.parent() != destination.parent()
    {
        return None;
    }
    let name = destination.file_name()?.to_str()?;
    let prefix = format!(".{leaf}-");
    (name.starts_with(&prefix)
        && name[prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
    .then_some(destination)
}

fn npm_retirement_cleanup_command(
    command: &AppRecipeCommand,
    destination: &Path,
    capabilities: &FinalComputerCapabilities,
) -> AppRecipeCommand {
    if capabilities.platform == FinalComputerPlatform::Win32 {
        return AppRecipeCommand {
            executable: std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()),
            args: vec![
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                "rmdir".to_string(),
                "/s".to_string(),
                "/q".to_string(),
                destination.display().to_string(),
            ],
            env: BTreeMap::new(),
            timeout: Duration::from_secs(60),
            termination_grace: Duration::from_secs(5),
        };
    }
    if command.executable == "sudo" {
        AppRecipeCommand {
            executable: "sudo".to_string(),
            args: vec![
                "-n".to_string(),
                "rm".to_string(),
                "-rf".to_string(),
                "--".to_string(),
                destination.display().to_string(),
            ],
            env: BTreeMap::new(),
            timeout: Duration::from_secs(60),
            termination_grace: Duration::from_secs(5),
        }
    } else {
        AppRecipeCommand {
            executable: "rm".to_string(),
            args: vec![
                "-rf".to_string(),
                "--".to_string(),
                destination.display().to_string(),
            ],
            env: BTreeMap::new(),
            timeout: Duration::from_secs(60),
            termination_grace: Duration::from_secs(5),
        }
    }
}

pub async fn run_app_recipe_command(
    command: AppRecipeCommand,
    hooks: AppRecipeHooks,
) -> Result<AppRecipeCommandResult, AppRecipeExecutionError> {
    let mut process = Command::new(&command.executable);
    process
        .args(&command.args)
        .envs(&command.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);
    let mut child = process.spawn().map_err(|error| {
        AppRecipeExecutionError::new("command_start_failed", error.to_string(), true)
    })?;
    let stdout = child.stdout.take().expect("stdout pipe");
    let stderr = child.stderr.take().expect("stderr pipe");
    let stdout_hook = hooks.on_output.clone();
    let stderr_hook = hooks.on_output.clone();
    let stdout_task = tokio::spawn(read_stream(stdout, "stdout", stdout_hook));
    let stderr_task = tokio::spawn(read_stream(stderr, "stderr", stderr_hook));
    let status = match tokio::time::timeout(command.timeout, child.wait()).await {
        Ok(result) => result.map_err(|error| {
            AppRecipeExecutionError::new("command_start_failed", error.to_string(), true)
        })?,
        Err(_) => {
            terminate_child(&mut child, false).await;
            tokio::time::sleep(command.termination_grace).await;
            terminate_child(&mut child, true).await;
            let _ = child.wait().await;
            return Err(AppRecipeExecutionError::new(
                "command_timeout",
                format!(
                    "App installer command timed out after {}ms.",
                    command.timeout.as_millis()
                ),
                true,
            ));
        }
    };
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    Ok(AppRecipeCommandResult {
        exit_code: status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

async fn terminate_child(child: &mut tokio::process::Child, force: bool) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(
                -(pid as libc::pid_t),
                if force { libc::SIGKILL } else { libc::SIGTERM },
            );
        }
    }
    if force || !cfg!(unix) {
        let _ = child.kill().await;
    }
}

async fn read_stream(
    mut stream: impl AsyncRead + Unpin,
    name: &'static str,
    hook: Option<RecipeOutputHook>,
) -> String {
    let mut output = String::new();
    let mut buffer = [0_u8; 8192];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
                output.push_str(&chunk);
                trim_log(&mut output);
                if let Some(hook) = &hook {
                    hook(name, &chunk);
                }
            }
        }
    }
    output
}

fn trim_log(value: &mut String) {
    let excess = value.chars().count().saturating_sub(MAX_LOG_CHARS);
    if excess == 0 {
        return;
    }
    let byte_offset = value
        .char_indices()
        .nth(excess)
        .map(|(offset, _)| offset)
        .unwrap_or(value.len());
    value.drain(..byte_offset);
}

fn controlled_path(
    base_dir: &Path,
    relative_path: &str,
) -> Result<PathBuf, AppRecipeExecutionError> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(AppRecipeExecutionError::new(
            "invalid_builtin_recipe",
            "Archive installRoot escapes the managed app root.",
            false,
        ));
    }
    let base = fs::canonicalize(base_dir).unwrap_or_else(|_| base_dir.to_path_buf());
    let resolved = base.join(relative);
    if resolved == base {
        return Err(AppRecipeExecutionError::new(
            "invalid_builtin_recipe",
            "Archive installRoot escapes the managed app root.",
            false,
        ));
    }
    Ok(resolved)
}

fn manifest_path(state_dir: &Path, app_id: &str) -> PathBuf {
    state_dir.join("manifests").join(format!("{app_id}.json"))
}

fn write_manifest(
    path: &Path,
    app_id: &str,
    install_root: &Path,
    files: &[String],
) -> Result<(), AppRecipeExecutionError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(storage_error)?;
    }
    let payload = json!({
        "schemaVersion": 1,
        "appId": app_id,
        "installRoot": install_root,
        "files": files,
    });
    let bytes = serde_json::to_vec(&payload).map_err(|error| {
        AppRecipeExecutionError::new("app_operation_failed", error.to_string(), true)
    })?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).map_err(storage_error)?;
    fs::rename(&temporary, path).map_err(storage_error)
}

fn read_manifest(
    path: &Path,
    expected_root: &Path,
) -> Result<ArchiveManifest, AppRecipeExecutionError> {
    let raw = fs::read_to_string(path).map_err(|_| {
        AppRecipeExecutionError::new(
            "ownership_manifest_missing",
            "The archive ownership manifest is missing.",
            false,
        )
    })?;
    let value: Value = serde_json::from_str(&raw).map_err(|_| {
        AppRecipeExecutionError::new(
            "ownership_manifest_invalid",
            "The archive ownership manifest is invalid.",
            false,
        )
    })?;
    let install_root = value.get("installRoot").and_then(Value::as_str);
    let files = value.get("files").and_then(Value::as_array);
    if install_root != Some(expected_root.to_string_lossy().as_ref()) || files.is_none() {
        return Err(AppRecipeExecutionError::new(
            "ownership_manifest_invalid",
            "The archive ownership manifest is invalid.",
            false,
        ));
    }
    let files = files
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap_or_default().to_string())
        .collect::<Vec<_>>();
    validate_archive_paths(files.iter().map(|path| (path.as_str(), false)))?;
    Ok(ArchiveManifest {
        install_root: expected_root.to_path_buf(),
        files,
    })
}

fn remove_owned_files(
    install_root: &Path,
    files: &[String],
) -> Result<(), AppRecipeExecutionError> {
    for relative in files {
        let path = install_root.join(relative);
        if !path.starts_with(install_root) {
            return Err(AppRecipeExecutionError::new(
                "ownership_manifest_invalid",
                "An owned path escapes the managed install root.",
                false,
            ));
        }
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(storage_error(error)),
        }
    }
    let mut directories = files
        .iter()
        .filter_map(|file| install_root.join(file).parent().map(Path::to_path_buf))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        let _ = fs::remove_dir(directory);
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), AppRecipeExecutionError> {
    fs::create_dir_all(destination).map_err(storage_error)?;
    for entry in fs::read_dir(source).map_err(storage_error)? {
        let entry = entry.map_err(storage_error)?;
        let target = destination.join(entry.file_name());
        if entry.file_type().map_err(storage_error)?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(storage_error)?;
        }
    }
    Ok(())
}

fn walk_owned_files(root: &Path) -> Result<Vec<String>, AppRecipeExecutionError> {
    fn visit(
        root: &Path,
        current: &Path,
        values: &mut Vec<String>,
    ) -> Result<(), AppRecipeExecutionError> {
        for entry in fs::read_dir(current).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(storage_error)?;
            if metadata.file_type().is_symlink() {
                return Err(AppRecipeExecutionError::new(
                    "unsafe_archive",
                    "Extracted archive contains a symbolic link.",
                    false,
                ));
            }
            if metadata.is_dir() {
                visit(root, &entry.path(), values)?;
            } else if metadata.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| storage_error(std::io::Error::other("relative path")))?
                    .to_string_lossy()
                    .replace('\\', "/");
                values.push(relative);
            } else {
                return Err(AppRecipeExecutionError::new(
                    "unsafe_archive",
                    "Extracted archive contains an unsupported file type.",
                    false,
                ));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

fn validate_archive_paths<'a>(
    paths: impl IntoIterator<Item = (&'a str, bool)>,
) -> Result<Vec<String>, AppRecipeExecutionError> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for (path, link) in paths {
        if link || path.contains('\\') || path.contains('\0') {
            return Err(AppRecipeExecutionError::new(
                "unsafe_archive",
                "The built-in artifact contains an unsafe path or link.",
                false,
            ));
        }
        let value = path.trim_start_matches("./").trim_end_matches('/');
        if value.is_empty()
            || value.starts_with('/')
            || value.as_bytes().get(1) == Some(&b':')
            || value
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        {
            return Err(AppRecipeExecutionError::new(
                "unsafe_archive",
                "The built-in artifact contains an unsafe path or link.",
                false,
            ));
        }
        if !seen.insert(value.to_string()) {
            return Err(AppRecipeExecutionError::new(
                "unsafe_archive",
                format!("Archive contains duplicate path: {value}"),
                false,
            ));
        }
        normalized.push(value.to_string());
    }
    Ok(normalized)
}

fn archive_reader(format: &str, path: &Path) -> Result<Box<dyn Read>, AppRecipeExecutionError> {
    let file = fs::File::open(path).map_err(storage_error)?;
    Ok(match format {
        "tar.gz" => Box::new(GzDecoder::new(file)),
        "tar.xz" => Box::new(XzDecoder::new(file)),
        _ => {
            return Err(AppRecipeExecutionError::new(
                "unsupported_archive_format",
                "Archive format is not supported.",
                false,
            ))
        }
    })
}

fn inspect_archive(format: &str, path: &Path) -> Result<(), AppRecipeExecutionError> {
    let reader = archive_reader(format, path)?;
    let mut archive = tar::Archive::new(reader);
    let mut paths = Vec::new();
    let mut total = 0_u64;
    let entries = archive.entries().map_err(storage_error)?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_ARCHIVE_ENTRIES {
            return Err(AppRecipeExecutionError::new(
                "archive_too_large",
                "Artifact contains too many entries.",
                false,
            ));
        }
        let entry = entry.map_err(storage_error)?;
        let header = entry.header();
        let kind = header.entry_type();
        let link = kind.is_symlink() || kind.is_hard_link();
        let path = entry
            .path()
            .map_err(storage_error)?
            .to_string_lossy()
            .to_string();
        if !kind.is_file() && !kind.is_dir() && !link {
            return Err(AppRecipeExecutionError::new(
                "unsafe_archive",
                "Archive contains an unsupported entry type.",
                false,
            ));
        }
        total = total.saturating_add(header.size().unwrap_or(0));
        if total > MAX_EXTRACTED_BYTES {
            return Err(AppRecipeExecutionError::new(
                "archive_too_large",
                "Extracted artifact exceeds the managed size limit.",
                false,
            ));
        }
        paths.push((path, link));
    }
    validate_archive_paths(paths.iter().map(|(path, link)| (path.as_str(), *link)))?;
    Ok(())
}

fn extract_archive(
    format: &str,
    path: &Path,
    destination: &Path,
) -> Result<(), AppRecipeExecutionError> {
    let reader = archive_reader(format, path)?;
    let mut archive = tar::Archive::new(reader);
    let mut total = 0_u64;
    for (index, entry) in archive.entries().map_err(storage_error)?.enumerate() {
        if index >= MAX_ARCHIVE_ENTRIES {
            return Err(AppRecipeExecutionError::new(
                "archive_too_large",
                "Artifact contains too many entries.",
                false,
            ));
        }
        let mut entry = entry.map_err(storage_error)?;
        let header = entry.header();
        let kind = header.entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            return Err(AppRecipeExecutionError::new(
                "unsafe_archive",
                "The built-in artifact contains an unsafe path or link.",
                false,
            ));
        }
        let relative = entry
            .path()
            .map_err(storage_error)?
            .to_string_lossy()
            .to_string();
        let validated = validate_archive_paths([(relative.as_str(), false)])?;
        let [relative] = validated.as_slice() else {
            unreachable!()
        };
        let target = destination.join(relative);
        if kind.is_dir() {
            fs::create_dir_all(&target).map_err(storage_error)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(storage_error)?;
        }
        let mut output = fs::File::create(&target).map_err(storage_error)?;
        let copied = std::io::copy(&mut entry, &mut output).map_err(storage_error)?;
        total = total.saturating_add(copied);
        if total > MAX_EXTRACTED_BYTES {
            return Err(AppRecipeExecutionError::new(
                "archive_too_large",
                "Extracted artifact exceeds the managed size limit.",
                false,
            ));
        }
        output.flush().map_err(storage_error)?;
    }
    Ok(())
}

fn uninstall_archive(
    state_dir: &Path,
    context: &AppRecipeExecutionContext,
    root: &Path,
) -> Result<(), AppRecipeExecutionError> {
    let manifest_file = manifest_path(state_dir, &context.app_id);
    let manifest = read_manifest(&manifest_file, root)?;
    remove_owned_files(&manifest.install_root, &manifest.files)?;
    let _ = fs::remove_dir(&manifest.install_root);
    fs::remove_file(manifest_file).map_err(storage_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_package_names_and_archive_paths_reject_unsafe_values() {
        assert!(valid_node_package("@task-handoff/thctl"));
        assert!(valid_node_package("OpenAI.Codex"));
        assert!(!valid_node_package("@scope"));
        assert!(!valid_node_package("@scope/"));
        assert!(!valid_node_package("@scope/.hidden"));
        assert!(!valid_node_package("package/extra"));
        assert!(!valid_node_package("../thctl"));
        assert!(validate_archive_paths([("bin/thctl", false)]).is_ok());
        assert!(validate_archive_paths([("../escape", false)]).is_err());
        assert!(validate_archive_paths([("link", true)]).is_err());
    }

    #[test]
    fn archive_staging_is_created_beside_the_install_root() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let install_root = temporary.path().join("apps").join("example");
        let staging = create_archive_staging(&install_root, "example").expect("staging directory");
        assert_eq!(staging.parent(), install_root.parent());
        assert!(staging.is_dir());
    }

    #[test]
    fn npm_retirement_detection_matches_the_node_diagnostics() {
        let stderr = "npm ERR! code ENOTEMPTY\nnpm ERR! path /usr/lib/node_modules/@task-handoff/thctl\nnpm ERR! dest /usr/lib/node_modules/@task-handoff/.thctl-AbC123\n";
        let directory = npm_retirement_directory(stderr, &["@task-handoff/thctl".to_string()]);
        assert_eq!(
            directory.as_deref(),
            Some(Path::new(
                "/usr/lib/node_modules/@task-handoff/.thctl-AbC123"
            ))
        );
    }
}
