use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use controlled_instance_core::text::truncate_utf16_tail;
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

use crate::{
    command_invocation::{command_invocation, CommandInvocationOptions},
    executable_resolver::{ExecutableResolverOptions, Platform},
    resolve_executable, InstallRecipe,
};

const MAX_LOG_CHARS: usize = 8_192;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PACKAGE_COMMAND_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MANAGED_NODE_PACKAGE_DIR: &str = "node-package";

#[derive(Clone, Copy)]
struct NodePackageOptions<'a> {
    managed: bool,
    version: Option<&'a str>,
    privilege: AppInstallPrivilege,
}

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
                managed,
                version,
                privilege,
                ..
            } => {
                self.node_package(
                    operation,
                    *installer,
                    packages,
                    NodePackageOptions {
                        managed: *managed,
                        version: version.as_deref(),
                        privilege: privilege.unwrap_or(AppInstallPrivilege::User),
                    },
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
        options: NodePackageOptions<'_>,
        context: &AppRecipeExecutionContext,
    ) -> Result<String, AppRecipeExecutionError> {
        let NodePackageOptions {
            managed,
            version,
            privilege: recipe_privilege,
        } = options;
        if packages.is_empty() || packages.iter().any(|package| !valid_node_package(package)) {
            return Err(AppRecipeExecutionError::new(
                "invalid_builtin_recipe",
                "The built-in Node package recipe contains an invalid package name.",
                false,
            ));
        }
        if managed && !version.is_some_and(valid_node_version) {
            return Err(AppRecipeExecutionError::new(
                "invalid_builtin_recipe",
                "A managed Node package recipe requires an exact version.",
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
        if managed {
            let target = managed_node_package_dir(&self.install_base_dir, &context.app_id)?;
            if operation == AppManagementOperation::Uninstall {
                match fs::remove_dir_all(&target) {
                    Ok(()) => return Ok(String::new()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(String::new())
                    }
                    Err(error) => {
                        return Err(AppRecipeExecutionError::new(
                            "package_cleanup_failed",
                            error.to_string(),
                            true,
                        ))
                    }
                }
            }
            let staging = managed_node_package_staging(&self.install_base_dir, &context.app_id)?;
            let _ = fs::remove_dir_all(&staging);
            fs::create_dir_all(&staging).map_err(|error| {
                AppRecipeExecutionError::new("storage_error", error.to_string(), false)
            })?;
            let command = node_package_command(
                operation,
                packages,
                version,
                Some(&staging),
                recipe_privilege,
                &context.capabilities,
                &self.env,
            )?;
            let result = self.run_command(command, context).await;
            let result = match result {
                Ok(result) if result.exit_code == 0 => result,
                Ok(result) => {
                    let _ = fs::remove_dir_all(&staging);
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
                Err(error) => {
                    let _ = fs::remove_dir_all(&staging);
                    return Err(error);
                }
            };
            if let Err(error) = verify_managed_node_package(&staging, packages, &context.app_id) {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
            if let Err(error) = write_managed_node_package_manifest(
                &staging,
                &context.app_id,
                packages,
                version.unwrap_or_default(),
            ) {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
            if let Err(error) =
                replace_managed_node_package(&self.install_base_dir, &context.app_id, &staging)
            {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
            return Ok(bounded(if result.stdout.is_empty() {
                &result.stderr
            } else {
                &result.stdout
            }));
        }
        let command = node_package_command(
            operation,
            packages,
            version,
            None,
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
        let manifest_path = manifest_path(&self.state_dir, &context.app_id);
        let update_manifest = if operation == AppManagementOperation::Update {
            let manifest = read_manifest(&manifest_path, &root)?;
            if !manifest.install_root.exists() {
                return Err(AppRecipeExecutionError::new(
                    "ownership_manifest_invalid",
                    "The managed install target does not exist.",
                    false,
                ));
            }
            Some(manifest)
        } else {
            if root.exists() {
                return Err(AppRecipeExecutionError::new(
                    "install_target_exists",
                    "The managed install target already exists.",
                    false,
                ));
            }
            None
        };
        let staged = self
            .stage_archive(url, sha256, format, &root, context)
            .await?;
        if let Some(manifest) = update_manifest {
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
            inspect_archive(format, &artifact)?;
            fs::create_dir_all(&extracted).map_err(storage_error)?;
            phase(context, "extract");
            extract_archive(format, &artifact, &extracted)?;
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = tokio::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o600))
                .await;
        }
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700));
    }
    Ok(staging)
}

struct ArchiveManifest {
    install_root: PathBuf,
    files: Vec<String>,
}

fn storage_error(error: std::io::Error) -> AppRecipeExecutionError {
    AppRecipeExecutionError::new("app_operation_failed", error.to_string(), true)
}

fn archive_inspection_error(error: impl std::fmt::Display) -> AppRecipeExecutionError {
    AppRecipeExecutionError::new("archive_inspection_failed", error.to_string(), false)
}

fn archive_extraction_error(error: impl std::fmt::Display) -> AppRecipeExecutionError {
    AppRecipeExecutionError::new("archive_extraction_failed", error.to_string(), false)
}

fn bounded(value: &str) -> String {
    truncate_utf16_tail(value, MAX_LOG_CHARS)
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
    platform: FinalComputerPlatform,
    win32_shim_when_unresolved: bool,
) -> Result<AppRecipeCommand, AppRecipeExecutionError> {
    let invocation = command_invocation(
        executable,
        &args,
        &CommandInvocationOptions {
            resolver: ExecutableResolverOptions {
                env: env.clone(),
                platform: recipe_platform(platform),
                ..ExecutableResolverOptions::default()
            },
            win32_shim_when_unresolved,
        },
    )
    .map_err(|error| AppRecipeExecutionError::new(error.code(), error.to_string(), false))?;
    Ok(AppRecipeCommand {
        executable: invocation.executable.display().to_string(),
        args: invocation.args,
        env: invocation.env,
        timeout,
        termination_grace: Duration::from_secs(5),
    })
}

fn recipe_platform(platform: FinalComputerPlatform) -> Platform {
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
        return resolved_command(
            executable,
            args,
            env,
            PACKAGE_COMMAND_TIMEOUT,
            capabilities.platform,
            false,
        );
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

fn valid_node_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 121
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'_' | b'-'))
}

fn valid_managed_app_id(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
}

fn managed_node_package_dir(
    install_base_dir: &Path,
    app_id: &str,
) -> Result<PathBuf, AppRecipeExecutionError> {
    if !valid_managed_app_id(app_id) {
        return Err(AppRecipeExecutionError::new(
            "invalid_app_id",
            "The managed app id is invalid.",
            false,
        ));
    }
    Ok(install_base_dir.join(MANAGED_NODE_PACKAGE_DIR).join(app_id))
}

fn managed_node_package_staging(
    install_base_dir: &Path,
    app_id: &str,
) -> Result<PathBuf, AppRecipeExecutionError> {
    if !valid_managed_app_id(app_id) {
        return Err(AppRecipeExecutionError::new(
            "invalid_app_id",
            "The managed app id is invalid.",
            false,
        ));
    }
    Ok(install_base_dir
        .join(MANAGED_NODE_PACKAGE_DIR)
        .join(".staging")
        .join(format!("{app_id}-{}", uuid::Uuid::new_v4())))
}

fn verify_managed_node_package(
    staging: &Path,
    packages: &[String],
    app_id: &str,
) -> Result<(), AppRecipeExecutionError> {
    let launcher = staging.join("node_modules/.bin").join(app_id);
    let launcher = resolve_executable(&launcher.display().to_string(), &BTreeMap::new(), None);
    let owned = launcher
        .and_then(|launcher| fs::canonicalize(launcher).ok())
        .zip(fs::canonicalize(staging).ok())
        .is_some_and(|(launcher, root)| launcher.starts_with(root));
    if !owned {
        return Err(AppRecipeExecutionError::new(
            "postcondition_failed",
            "The staged package has no executable managed launcher.",
            false,
        ));
    }
    for package in packages {
        let package_root = staging
            .join("node_modules")
            .join(package.split('/').collect::<PathBuf>());
        let manifest_path = package_root.join("package.json");
        let raw = fs::read_to_string(&manifest_path).map_err(|error| {
            AppRecipeExecutionError::new(
                "postcondition_failed",
                format!("Installed package {package} has no readable package manifest: {error}"),
                false,
            )
        })?;
        let manifest = serde_json::from_str::<Value>(&raw).map_err(|error| {
            AppRecipeExecutionError::new(
                "postcondition_failed",
                format!("Installed package {package} has an invalid package manifest: {error}"),
                false,
            )
        })?;
        let bins = match manifest.get("bin") {
            Some(Value::String(value)) => vec![value.clone()],
            Some(Value::Object(values)) => values
                .values()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect(),
            _ => Vec::new(),
        };
        if bins.is_empty()
            || bins.iter().any(|value| {
                let candidate = package_root.join(value);
                !candidate.starts_with(&package_root) || !candidate.is_file()
            })
        {
            return Err(AppRecipeExecutionError::new(
                "postcondition_failed",
                format!("Installed package {package} has no usable executable."),
                false,
            ));
        }
    }
    Ok(())
}

fn write_managed_node_package_manifest(
    staging: &Path,
    app_id: &str,
    packages: &[String],
    version: &str,
) -> Result<(), AppRecipeExecutionError> {
    let packages = packages
        .iter()
        .map(|package| (package.clone(), Value::String(version.to_string())))
        .collect::<serde_json::Map<_, _>>();
    let manifest = json!({
        "appId": app_id,
        "packages": packages,
        "source": "npm",
        "installedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
    fs::write(
        staging.join("managed-app.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest).unwrap_or_default()
        ),
    )
    .map_err(|error| AppRecipeExecutionError::new("storage_error", error.to_string(), false))
}

fn replace_managed_node_package(
    install_base_dir: &Path,
    app_id: &str,
    staging: &Path,
) -> Result<(), AppRecipeExecutionError> {
    let target = managed_node_package_dir(install_base_dir, app_id)?;
    let previous = target.with_file_name(format!(
        "{}.previous-{}",
        target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(app_id),
        uuid::Uuid::new_v4()
    ));
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppRecipeExecutionError::new("storage_error", error.to_string(), false)
        })?;
    }
    if target.exists() {
        fs::rename(&target, &previous).map_err(|error| {
            AppRecipeExecutionError::new("storage_error", error.to_string(), false)
        })?;
    }
    if let Err(error) = fs::rename(staging, &target) {
        if previous.exists() {
            let _ = fs::rename(&previous, &target);
        }
        return Err(AppRecipeExecutionError::new(
            "storage_error",
            error.to_string(),
            false,
        ));
    }
    let _ = fs::remove_dir_all(previous);
    Ok(())
}

fn node_package_command(
    operation: AppManagementOperation,
    packages: &[String],
    version: Option<&str>,
    managed_prefix: Option<&Path>,
    recipe_privilege: AppInstallPrivilege,
    capabilities: &FinalComputerCapabilities,
    env: &BTreeMap<String, String>,
) -> Result<AppRecipeCommand, AppRecipeExecutionError> {
    let package_specs = version
        .filter(|_| managed_prefix.is_some())
        .map(|version| {
            packages
                .iter()
                .map(|package| format!("{package}@{version}"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| packages.to_vec());
    let args = if let Some(prefix) = managed_prefix {
        [
            "install".to_string(),
            "--prefix".to_string(),
            prefix.display().to_string(),
            "--no-save".to_string(),
            "--include=optional".to_string(),
            "--no-audit".to_string(),
            "--no-fund".to_string(),
        ]
        .into_iter()
        .chain(package_specs)
        .collect::<Vec<_>>()
    } else if operation == AppManagementOperation::Uninstall {
        ["uninstall", "--global"]
            .into_iter()
            .map(ToString::to_string)
            .chain(package_specs)
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
        .chain(package_specs)
        .collect::<Vec<_>>()
    };
    if managed_prefix.is_some()
        || capabilities.privilege == AppInstallPrivilege::Root
        || recipe_privilege == AppInstallPrivilege::User
    {
        return resolved_command(
            "npm",
            args,
            env,
            PACKAGE_COMMAND_TIMEOUT,
            capabilities.platform,
            true,
        );
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
            if tokio::time::timeout(command.termination_grace, child.wait())
                .await
                .is_err()
            {
                terminate_child(&mut child, true).await;
                let _ = child.wait().await;
            }
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
    if controlled_instance_core::text::utf16_len(value) <= MAX_LOG_CHARS {
        return;
    }
    *value = controlled_instance_core::text::truncate_utf16_tail(value, MAX_LOG_CHARS);
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
    controlled_instance_core::atomic::write_atomic(path, &bytes, Some(0o600)).map_err(storage_error)
}

fn read_manifest(
    path: &Path,
    expected_root: &Path,
) -> Result<ArchiveManifest, AppRecipeExecutionError> {
    let raw = fs::read_to_string(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppRecipeExecutionError::new(
                "ownership_manifest_missing",
                "The archive ownership manifest is missing.",
                false,
            )
        } else {
            storage_error(error)
        }
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
        .map(|value| value.as_str().unwrap_or_default().replace('\\', "/"))
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
    let entries = archive.entries().map_err(archive_inspection_error)?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_ARCHIVE_ENTRIES {
            return Err(AppRecipeExecutionError::new(
                "archive_too_large",
                "Artifact contains too many entries.",
                false,
            ));
        }
        let entry = entry.map_err(archive_inspection_error)?;
        let header = entry.header();
        let kind = header.entry_type();
        let link = kind.is_symlink() || kind.is_hard_link();
        let path = entry
            .path()
            .map_err(archive_inspection_error)?
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
    for (index, entry) in archive
        .entries()
        .map_err(archive_extraction_error)?
        .enumerate()
    {
        if index >= MAX_ARCHIVE_ENTRIES {
            return Err(AppRecipeExecutionError::new(
                "archive_too_large",
                "Artifact contains too many entries.",
                false,
            ));
        }
        let mut entry = entry.map_err(archive_extraction_error)?;
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
            .map_err(archive_extraction_error)?
            .to_string_lossy()
            .to_string();
        let validated = validate_archive_paths([(relative.as_str(), false)])?;
        let [relative] = validated.as_slice() else {
            unreachable!()
        };
        if relative.split('/').count() > 100 {
            return Err(archive_extraction_error(
                "Archive path exceeds the maximum extraction depth of 100.",
            ));
        }
        let target = destination.join(relative);
        if kind.is_dir() {
            fs::create_dir_all(&target).map_err(archive_extraction_error)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(archive_extraction_error)?;
        }
        let mut output = fs::File::create(&target).map_err(archive_extraction_error)?;
        let copied = std::io::copy(&mut entry, &mut output).map_err(archive_extraction_error)?;
        total = total.saturating_add(copied);
        if total > MAX_EXTRACTED_BYTES {
            return Err(AppRecipeExecutionError::new(
                "archive_too_large",
                "Extracted artifact exceeds the managed size limit.",
                false,
            ));
        }
        output.flush().map_err(archive_extraction_error)?;
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
    use controlled_instance_protocol::FinalComputerArch;

    #[test]
    fn node_package_names_and_archive_paths_reject_unsafe_values() {
        assert!(valid_node_version("0.165.0"));
        assert!(valid_node_version("1.18.30"));
        assert!(!valid_node_version(""));
        assert!(!valid_node_version("0.165.0;touch-pwned"));
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
    fn managed_node_package_command_uses_a_local_prefix_and_pinned_version() {
        let capabilities = FinalComputerCapabilities {
            platform: FinalComputerPlatform::Linux,
            arch: FinalComputerArch::X64,
            installers: vec![AppInstaller::Npm],
            privilege: AppInstallPrivilege::User,
            installer_access: None,
        };
        let command = node_package_command(
            AppManagementOperation::Install,
            &["@openai/codex".to_string()],
            Some("0.165.0"),
            Some(Path::new("/tmp/managed/codex")),
            AppInstallPrivilege::User,
            &capabilities,
            &BTreeMap::new(),
        )
        .expect("command");
        assert!(!command.args.iter().any(|arg| arg == "--global"));
        assert!(command.args.iter().any(|arg| arg == "--prefix"));
        assert!(command
            .args
            .iter()
            .any(|arg| arg == "@openai/codex@0.165.0"));
    }

    #[test]
    fn windows_npm_commands_are_wrapped_by_the_command_interpreter() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let npm = temporary.path().join("npm.cmd");
        std::fs::write(&npm, "@echo off\r\n").expect("npm shim");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&npm, std::fs::Permissions::from_mode(0o700))
                .expect("permissions");
        }
        let environment = BTreeMap::from([
            ("PATH".to_string(), temporary.path().display().to_string()),
            ("ComSpec".to_string(), "cmd.exe".to_string()),
        ]);

        let command = resolved_command(
            "npm",
            vec!["install".to_string(), "example".to_string()],
            &environment,
            PACKAGE_COMMAND_TIMEOUT,
            FinalComputerPlatform::Win32,
            true,
        )
        .expect("wrapped npm command");

        assert_eq!(command.executable, "cmd.exe");
        assert_eq!(&command.args[..4], ["/d", "/s", "/c", "call"]);
        assert!(command.args[4].eq_ignore_ascii_case(npm.to_str().expect("npm path")));
        assert_eq!(command.args[5..], ["install", "example"]);
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

    #[cfg(unix)]
    #[test]
    fn staged_node_package_requires_an_owned_executable_launcher() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().expect("tempdir");
        let stage = root.path().join("stage");
        let package = stage.join("node_modules/@openai/codex");
        fs::create_dir_all(&package).expect("package");
        fs::write(
            package.join("package.json"),
            r#"{"bin":{"codex":"cli.js"}}"#,
        )
        .expect("manifest");
        let cli = package.join("cli.js");
        fs::write(&cli, "#!/bin/sh\nexit 0\n").expect("cli");
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).expect("chmod");
        let packages = vec!["@openai/codex".to_string()];
        assert_eq!(
            verify_managed_node_package(&stage, &packages, "codex")
                .expect_err("missing launcher")
                .code,
            "postcondition_failed"
        );
        let bin = stage.join("node_modules/.bin/codex");
        fs::create_dir_all(bin.parent().expect("bin parent")).expect("bin");
        let external = root.path().join("global-codex");
        fs::copy(&cli, &external).expect("host command");
        symlink(&external, &bin).expect("external link");
        assert!(verify_managed_node_package(&stage, &packages, "codex").is_err());
        fs::remove_file(&bin).expect("remove link");
        symlink("../@openai/codex/cli.js", &bin).expect("owned link");
        verify_managed_node_package(&stage, &packages, "codex").expect("valid private launcher");
    }
}
