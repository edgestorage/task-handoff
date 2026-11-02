use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use controlled_instance_protocol::{
    AppInstallPrivilege, AppInstaller, AppInstallerAccess, AppKind, FinalComputerArch,
    FinalComputerCapabilities, FinalComputerPlatform, ManagedAppActionReason,
    ManagedAppActionReasonCode, ManagedAppManagementSource, ManagedAppProjection, ManagedAppState,
};
use serde_json::Value;
use tokio::process::Command;

use crate::{resolve_executable, AppRuntimeError};

const ALL_PLATFORMS: [FinalComputerPlatform; 7] = [
    FinalComputerPlatform::Linux,
    FinalComputerPlatform::Darwin,
    FinalComputerPlatform::Win32,
    FinalComputerPlatform::Freebsd,
    FinalComputerPlatform::Openbsd,
    FinalComputerPlatform::Aix,
    FinalComputerPlatform::Sunos,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedAppDetectionRule {
    LauncherExecutable {
        version_args: Vec<String>,
    },
    Executable {
        command: String,
        version_args: Vec<String>,
    },
}

impl ManagedAppDetectionRule {
    fn command<'a>(
        &'a self,
        launcher: &'a controlled_instance_protocol::AppCatalogItem,
    ) -> Option<&'a str> {
        match self {
            Self::LauncherExecutable { .. } => launcher.command.as_deref(),
            Self::Executable { command, .. } => Some(command),
        }
    }

    fn version_args(&self) -> &[String] {
        match self {
            Self::LauncherExecutable { version_args } | Self::Executable { version_args, .. } => {
                version_args
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallRecipe {
    Bundled {
        platforms: Vec<FinalComputerPlatform>,
        arches: Option<Vec<FinalComputerArch>>,
        privilege: Option<AppInstallPrivilege>,
    },
    SystemPackage {
        platforms: Vec<FinalComputerPlatform>,
        arches: Option<Vec<FinalComputerArch>>,
        privilege: Option<AppInstallPrivilege>,
        installer: AppInstaller,
        packages: Vec<String>,
    },
    NodePackage {
        platforms: Vec<FinalComputerPlatform>,
        arches: Option<Vec<FinalComputerArch>>,
        privilege: Option<AppInstallPrivilege>,
        installer: AppInstaller,
        packages: Vec<String>,
    },
    Archive {
        platforms: Vec<FinalComputerPlatform>,
        arches: Option<Vec<FinalComputerArch>>,
        privilege: Option<AppInstallPrivilege>,
        url: String,
        sha256: String,
        format: String,
        install_root: String,
    },
}

impl InstallRecipe {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Bundled { .. } => "bundled",
            Self::SystemPackage { .. } => "system-package",
            Self::NodePackage { .. } => "node-package",
            Self::Archive { .. } => "archive",
        }
    }

    pub fn platforms(&self) -> &[FinalComputerPlatform] {
        match self {
            Self::Bundled { platforms, .. }
            | Self::SystemPackage { platforms, .. }
            | Self::NodePackage { platforms, .. }
            | Self::Archive { platforms, .. } => platforms,
        }
    }

    pub fn arches(&self) -> Option<&[FinalComputerArch]> {
        match self {
            Self::Bundled { arches, .. }
            | Self::SystemPackage { arches, .. }
            | Self::NodePackage { arches, .. }
            | Self::Archive { arches, .. } => arches.as_deref(),
        }
    }

    pub fn privilege(&self) -> AppInstallPrivilege {
        match self {
            Self::Bundled { privilege, .. }
            | Self::SystemPackage { privilege, .. }
            | Self::NodePackage { privilege, .. }
            | Self::Archive { privilege, .. } => privilege.unwrap_or(AppInstallPrivilege::User),
        }
    }

    pub fn installer(&self) -> Option<AppInstaller> {
        match self {
            Self::SystemPackage { installer, .. } | Self::NodePackage { installer, .. } => {
                Some(*installer)
            }
            Self::Bundled { .. } | Self::Archive { .. } => None,
        }
    }

    pub fn packages(&self) -> &[String] {
        match self {
            Self::SystemPackage { packages, .. } | Self::NodePackage { packages, .. } => packages,
            Self::Bundled { .. } | Self::Archive { .. } => &[],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedAppDefinition {
    pub launcher: controlled_instance_protocol::AppCatalogItem,
    pub launchable: bool,
    pub detection: Vec<ManagedAppDetectionRule>,
    pub recipes: Vec<InstallRecipe>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedAppDetectionResult {
    pub state: ManagedAppState,
    pub executable_paths: Vec<PathBuf>,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InstallRecipeSelection {
    pub recipe: Option<InstallRecipe>,
    pub reason: Option<ManagedAppActionReason>,
}

#[derive(Debug, Clone)]
pub struct ManagedAppOwnership {
    pub source: ManagedAppManagementSource,
    pub recipe: Option<InstallRecipe>,
}

pub struct ManagedAppOwnershipContext<'a> {
    pub state_dir: &'a Path,
    pub install_base_dir: &'a Path,
}

fn env_value(name: &str) -> Option<String> {
    std::env::var_os(name)
        .and_then(|value| value.into_string().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_string(name: &str, fallback: &str) -> String {
    env_value(name).unwrap_or_else(|| fallback.to_string())
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn model_args(names: &[&str]) -> Vec<String> {
    names
        .iter()
        .find_map(|name| env_value(name))
        .map(|value| vec!["--model".to_string(), value])
        .unwrap_or_default()
}

fn launcher_detection() -> Vec<ManagedAppDetectionRule> {
    vec![ManagedAppDetectionRule::LauncherExecutable {
        version_args: vec!["--version".to_string()],
    }]
}

fn bundled_recipe() -> InstallRecipe {
    InstallRecipe::Bundled {
        platforms: ALL_PLATFORMS.to_vec(),
        arches: None,
        privilege: None,
    }
}

fn node_recipe(
    installer: AppInstaller,
    package: &str,
    privilege: AppInstallPrivilege,
) -> InstallRecipe {
    InstallRecipe::NodePackage {
        platforms: vec![
            FinalComputerPlatform::Linux,
            FinalComputerPlatform::Darwin,
            FinalComputerPlatform::Win32,
        ],
        arches: Some(vec![FinalComputerArch::X64, FinalComputerArch::Arm64]),
        privilege: Some(privilege),
        installer,
        packages: vec![package.to_string()],
    }
}

fn launcher(
    id: &str,
    name: &str,
    kind: AppKind,
    description: &str,
    command: String,
    args: Option<Vec<String>>,
) -> controlled_instance_protocol::AppCatalogItem {
    controlled_instance_protocol::AppCatalogItem {
        id: id.to_string(),
        name: name.to_string(),
        kind,
        description: Some(description.to_string()),
        command: Some(command),
        args,
        cwd: None,
        env: None,
        display: None,
        default_display_target: None,
        automation: None,
        web: None,
    }
}

pub fn builtin_managed_app_definitions() -> Vec<ManagedAppDefinition> {
    let mut definitions = vec![
        ManagedAppDefinition {
            launcher: launcher(
                "terminal-tty",
                "Terminal",
                AppKind::Tty,
                "Interactive shell in the task workspace.",
                env_string("SHELL", "/bin/bash"),
                None,
            ),
            launchable: true,
            detection: launcher_detection(),
            recipes: vec![bundled_recipe()],
        },
        ManagedAppDefinition {
            launcher: launcher(
                "codex",
                "Codex",
                AppKind::Tty,
                "OpenAI Codex CLI in the task workspace.",
                env_string("TASK_HANDOFF_CODEX_COMMAND", "codex"),
                {
                    let mut args = vec![
                        "-c".to_string(),
                        "check_for_update_on_startup=false".to_string(),
                    ];
                    args.extend(model_args(&["TASK_HANDOFF_CODEX_MODEL", "CODEX_MODEL"]));
                    Some(args)
                },
            ),
            launchable: true,
            detection: launcher_detection(),
            recipes: vec![
                node_recipe(
                    AppInstaller::Npm,
                    "@openai/codex",
                    AppInstallPrivilege::User,
                ),
                node_recipe(
                    AppInstaller::Npm,
                    "@openai/codex",
                    AppInstallPrivilege::PasswordlessSudo,
                ),
            ],
        },
        ManagedAppDefinition {
            launcher: launcher(
                "opencode",
                "OpenCode",
                AppKind::Tty,
                "OpenCode CLI attached to the managed TaskHandoff agent server.",
                env_string("TASK_HANDOFF_OPENCODE_COMMAND", "opencode"),
                Some(vec![]),
            ),
            launchable: true,
            detection: launcher_detection(),
            recipes: vec![
                node_recipe(AppInstaller::Npm, "opencode-ai", AppInstallPrivilege::User),
                node_recipe(
                    AppInstaller::Npm,
                    "opencode-ai",
                    AppInstallPrivilege::PasswordlessSudo,
                ),
            ],
        },
        ManagedAppDefinition {
            launcher: launcher(
                "claude",
                "Claude",
                AppKind::Tty,
                "Claude Code CLI in the task workspace.",
                env_string("TASK_HANDOFF_CLAUDE_COMMAND", "claude"),
                {
                    let mut args = Vec::new();
                    if env_flag("TASK_HANDOFF_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS")
                        || env_flag("TASK_HANDOFF_CLAUDE_SKIP_PERMISSIONS")
                    {
                        args.push("--dangerously-skip-permissions".to_string());
                    }
                    if std::env::var("TASK_HANDOFF_CONTROL_MODE").ok().as_deref()
                        != Some("controlled")
                    {
                        args.extend(model_args(&["TASK_HANDOFF_CLAUDE_MODEL", "CLAUDE_MODEL"]));
                    }
                    Some(args)
                },
            ),
            launchable: true,
            detection: launcher_detection(),
            recipes: vec![
                node_recipe(
                    AppInstaller::Npm,
                    "@anthropic-ai/claude-code",
                    AppInstallPrivilege::User,
                ),
                node_recipe(
                    AppInstaller::Npm,
                    "@anthropic-ai/claude-code",
                    AppInstallPrivilege::PasswordlessSudo,
                ),
            ],
        },
        ManagedAppDefinition {
            launcher: {
                let mut app = launcher(
                    "terminal-gui",
                    "GUI Terminal",
                    AppKind::Gui,
                    "xterm terminal in an isolated virtual desktop with VNC access.",
                    env_string("TASK_HANDOFF_XTERM_COMMAND", "xterm"),
                    Some(vec!["-geometry".to_string(), "120x32".to_string()]),
                );
                app.display = Some(controlled_instance_protocol::AppDisplayOptions {
                    width: Some(1024),
                    height: Some(768),
                    depth: Some(24),
                });
                app
            },
            launchable: true,
            detection: launcher_detection(),
            recipes: vec![InstallRecipe::SystemPackage {
                platforms: vec![FinalComputerPlatform::Linux],
                arches: None,
                privilege: Some(AppInstallPrivilege::PasswordlessSudo),
                installer: AppInstaller::Apt,
                packages: vec!["xterm".to_string()],
            }],
        },
        ManagedAppDefinition {
            launcher: {
                let mut app = launcher(
                    "chromium",
                    "Browser",
                    AppKind::Gui,
                    "Chromium browser with VNC and CDP endpoints.",
                    env_string("TASK_HANDOFF_CHROMIUM_COMMAND", "chromium"),
                    Some(vec!["about:blank".to_string()]),
                );
                app.display = Some(controlled_instance_protocol::AppDisplayOptions {
                    width: Some(1440),
                    height: Some(900),
                    depth: Some(24),
                });
                app.automation = Some(controlled_instance_protocol::AppAutomationCatalog {
                    kind: "cdp".to_string(),
                    port_arg: Some("--remote-debugging-port={port}".to_string()),
                    endpoint_path: None,
                });
                app
            },
            launchable: true,
            detection: launcher_detection(),
            recipes: vec![InstallRecipe::SystemPackage {
                platforms: vec![FinalComputerPlatform::Linux],
                arches: None,
                privilege: Some(AppInstallPrivilege::PasswordlessSudo),
                installer: AppInstaller::Apt,
                packages: vec!["chromium".to_string(), "chromium-sandbox".to_string()],
            }],
        },
        ManagedAppDefinition {
            launcher: {
                let mut app = launcher(
                    "vscode-web",
                    "VS Code",
                    AppKind::Web,
                    "VS Code Web in the task workspace.",
                    env_string("TASK_HANDOFF_VSCODE_WEB_COMMAND", "code-server"),
                    [
                        "--auth",
                        "none",
                        "--bind-addr",
                        "127.0.0.1:{port}",
                        "--disable-telemetry",
                        "--user-data-dir",
                        "{sessionDir}/user-data",
                        "--extensions-dir",
                        "{sessionDir}/extensions",
                        "{cwd}",
                    ]
                    .into_iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .into(),
                );
                app.web = Some(controlled_instance_protocol::AppWebCatalog {
                    port_arg: None,
                    ready_path: Some("/".to_string()),
                });
                app
            },
            launchable: true,
            detection: launcher_detection(),
            recipes: vec![bundled_recipe()],
        },
    ];
    if env_flag("TASK_HANDOFF_ENABLE_CC_SWITCH") {
        definitions.push(ManagedAppDefinition {
            launcher: {
                let mut app = launcher(
                    "cc-switch",
                    "CC Switch",
                    AppKind::Gui,
                    "CC Switch desktop app in an isolated virtual desktop.",
                    env_string("TASK_HANDOFF_CC_SWITCH_COMMAND", "cc-switch"),
                    None,
                );
                app.display = Some(controlled_instance_protocol::AppDisplayOptions {
                    width: Some(1440),
                    height: Some(900),
                    depth: Some(24),
                });
                app
            },
            launchable: true,
            detection: launcher_detection(),
            recipes: vec![bundled_recipe()],
        });
    }
    definitions.push(ManagedAppDefinition {
        launcher: launcher(
            "thctl",
            "thctl",
            AppKind::Tty,
            "TaskHandoff Control Plane command line client.",
            env_string("TASK_HANDOFF_THCTL_COMMAND", "thctl"),
            None,
        ),
        launchable: false,
        detection: launcher_detection(),
        recipes: vec![
            node_recipe(
                AppInstaller::Npm,
                "@task-handoff/thctl",
                AppInstallPrivilege::User,
            ),
            node_recipe(
                AppInstaller::Npm,
                "@task-handoff/thctl",
                AppInstallPrivilege::PasswordlessSudo,
            ),
        ],
    });
    definitions
}

pub fn find_builtin_managed_app(app_id: &str) -> Option<ManagedAppDefinition> {
    builtin_managed_app_definitions()
        .into_iter()
        .find(|definition| definition.launcher.id == app_id)
}

pub fn current_platform() -> FinalComputerPlatform {
    match std::env::consts::OS {
        "linux" => FinalComputerPlatform::Linux,
        "macos" => FinalComputerPlatform::Darwin,
        "windows" => FinalComputerPlatform::Win32,
        "freebsd" => FinalComputerPlatform::Freebsd,
        "openbsd" => FinalComputerPlatform::Openbsd,
        "aix" => FinalComputerPlatform::Aix,
        "solaris" | "illumos" => FinalComputerPlatform::Sunos,
        _ => FinalComputerPlatform::Unknown,
    }
}

pub fn current_arch() -> FinalComputerArch {
    match std::env::consts::ARCH {
        "x86_64" => FinalComputerArch::X64,
        "aarch64" => FinalComputerArch::Arm64,
        "arm" => FinalComputerArch::Arm,
        "x86" => FinalComputerArch::Ia32,
        "powerpc64" => FinalComputerArch::Ppc64,
        "s390x" => FinalComputerArch::S390x,
        "riscv64" => FinalComputerArch::Riscv64,
        _ => FinalComputerArch::Unknown,
    }
}

fn find_executable(
    command: &str,
    app: &controlled_instance_protocol::AppCatalogItem,
) -> Option<PathBuf> {
    resolve_executable(
        command,
        &app.env.clone().unwrap_or_default(),
        app.cwd.as_deref(),
    )
}

pub fn detect_managed_app(definition: &ManagedAppDefinition) -> ManagedAppDetectionResult {
    detect_managed_app_inner(definition, false)
}

pub fn detect_managed_app_with_version(
    definition: &ManagedAppDefinition,
) -> ManagedAppDetectionResult {
    detect_managed_app_inner(definition, true)
}

fn detect_managed_app_inner(
    definition: &ManagedAppDefinition,
    include_version: bool,
) -> ManagedAppDetectionResult {
    let paths = definition
        .detection
        .iter()
        .filter_map(|rule| rule.command(&definition.launcher))
        .filter_map(|command| find_executable(command, &definition.launcher))
        .collect::<Vec<_>>();
    let state = if paths.is_empty() {
        ManagedAppState::NotInstalled
    } else if paths.len() == definition.detection.len() {
        ManagedAppState::Installed
    } else {
        ManagedAppState::Broken
    };
    ManagedAppDetectionResult {
        state,
        executable_paths: paths,
        version: (include_version && state == ManagedAppState::Installed)
            .then(|| {
                definition
                    .detection
                    .iter()
                    .find(|rule| !rule.version_args().is_empty())
                    .and_then(|rule| little_version(rule, &definition.launcher))
            })
            .flatten(),
    }
}

fn little_version(
    rule: &ManagedAppDetectionRule,
    launcher: &controlled_instance_protocol::AppCatalogItem,
) -> Option<String> {
    let command = rule.command(launcher)?;
    let executable = find_executable(command, launcher)?;
    let output = command_output_with_timeout(
        executable.as_os_str(),
        rule.version_args(),
        &launcher.env.clone().unwrap_or_default(),
        Duration::from_secs(2),
        1024,
    )?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then(|| value.chars().take(120).collect())
}

fn privilege_rank(privilege: AppInstallPrivilege) -> u8 {
    match privilege {
        AppInstallPrivilege::User => 0,
        AppInstallPrivilege::PasswordlessSudo => 1,
        AppInstallPrivilege::Root => 2,
    }
}

pub fn select_install_recipe(
    definition: &ManagedAppDefinition,
    capabilities: &FinalComputerCapabilities,
) -> InstallRecipeSelection {
    let platform_matches = definition
        .recipes
        .iter()
        .filter(|recipe| recipe.platforms().contains(&capabilities.platform))
        .collect::<Vec<_>>();
    let arch_matches = platform_matches
        .into_iter()
        .filter(|recipe| {
            recipe
                .arches()
                .map(|arches| arches.contains(&capabilities.arch))
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    if arch_matches.is_empty() {
        return InstallRecipeSelection {
            recipe: None,
            reason: Some(ManagedAppActionReason {
                code: ManagedAppActionReasonCode::UnsupportedPlatform,
                message: format!(
                    "No built-in recipe supports {}/{}.",
                    platform_name(capabilities.platform),
                    arch_name(capabilities.arch)
                ),
            }),
        };
    }
    let installer_matches = arch_matches
        .into_iter()
        .filter(|recipe| {
            recipe
                .installer()
                .map(|installer| capabilities.installers.contains(&installer))
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    if installer_matches.is_empty() {
        return InstallRecipeSelection {
            recipe: None,
            reason: Some(ManagedAppActionReason {
                code: ManagedAppActionReasonCode::InstallerUnavailable,
                message: "The required package installer is unavailable on this computer."
                    .to_string(),
            }),
        };
    }
    let privilege_matches = installer_matches
        .into_iter()
        .filter(|recipe| {
            privilege_rank(capabilities.privilege) >= privilege_rank(recipe.privilege())
        })
        .collect::<Vec<_>>();
    if privilege_matches.is_empty() {
        return InstallRecipeSelection {
            recipe: None,
            reason: Some(ManagedAppActionReason {
                code: ManagedAppActionReasonCode::InsufficientPrivilege,
                message:
                    "The controlled instance does not have the privilege required by this recipe."
                        .to_string(),
            }),
        };
    }
    let writable_matches = privilege_matches
        .into_iter()
        .filter(|recipe| {
            !matches!(
                recipe,
                InstallRecipe::NodePackage {
                    privilege: Some(AppInstallPrivilege::User),
                    ..
                }
            ) || capabilities.privilege == AppInstallPrivilege::Root
                || capabilities
                    .installer_access
                    .as_ref()
                    .and_then(|access| access.npm_global_writable)
                    == Some(true)
        })
        .collect::<Vec<_>>();
    if let Some(recipe) = writable_matches.first() {
        return InstallRecipeSelection {
            recipe: Some((*recipe).clone()),
            reason: None,
        };
    }
    InstallRecipeSelection {
        recipe: None,
        reason: Some(ManagedAppActionReason {
            code: ManagedAppActionReasonCode::InstallerNotWritable,
            message: "The npm global installation directory is not writable by this controlled-instance user.".to_string(),
        }),
    }
}

fn platform_name(platform: FinalComputerPlatform) -> &'static str {
    match platform {
        FinalComputerPlatform::Linux => "linux",
        FinalComputerPlatform::Darwin => "darwin",
        FinalComputerPlatform::Win32 => "win32",
        FinalComputerPlatform::Freebsd => "freebsd",
        FinalComputerPlatform::Openbsd => "openbsd",
        FinalComputerPlatform::Aix => "aix",
        FinalComputerPlatform::Sunos => "sunos",
        FinalComputerPlatform::Unknown => "unknown",
    }
}

fn arch_name(arch: FinalComputerArch) -> &'static str {
    match arch {
        FinalComputerArch::X64 => "x64",
        FinalComputerArch::Arm64 => "arm64",
        FinalComputerArch::Arm => "arm",
        FinalComputerArch::Ia32 => "ia32",
        FinalComputerArch::Ppc64 => "ppc64",
        FinalComputerArch::S390x => "s390x",
        FinalComputerArch::Riscv64 => "riscv64",
        FinalComputerArch::Unknown => "unknown",
    }
}

pub fn managed_app_projection(
    definition: &ManagedAppDefinition,
    detection: &ManagedAppDetectionResult,
    capabilities: &FinalComputerCapabilities,
    management_source: Option<ManagedAppManagementSource>,
) -> ManagedAppProjection {
    let selected = select_install_recipe(definition, capabilities);
    let source = management_source.unwrap_or_else(|| {
        if detection.state == ManagedAppState::NotInstalled {
            ManagedAppManagementSource::None
        } else if matches!(selected.recipe, Some(InstallRecipe::Bundled { .. })) {
            ManagedAppManagementSource::Bundled
        } else if selected.recipe.is_some() {
            ManagedAppManagementSource::Recipe
        } else {
            ManagedAppManagementSource::External
        }
    });
    let state = if detection.state == ManagedAppState::NotInstalled && selected.recipe.is_none() {
        ManagedAppState::Unsupported
    } else {
        detection.state
    };
    let bundled = matches!(selected.recipe, Some(InstallRecipe::Bundled { .. }));
    let can_install =
        state == ManagedAppState::NotInstalled && selected.recipe.is_some() && !bundled;
    let can_uninstall = matches!(state, ManagedAppState::Installed | ManagedAppState::Broken)
        && selected.recipe.is_some()
        && !bundled
        && source == ManagedAppManagementSource::Recipe;
    let can_update = can_uninstall;
    let install_reason = if can_install {
        None
    } else if bundled {
        Some(reason(
            Bundled,
            "This app is supplied with the controlled computer.",
        ))
    } else if matches!(state, ManagedAppState::Installed | ManagedAppState::Broken) {
        Some(reason(AlreadyInstalled, "This app is already present."))
    } else {
        selected.reason.clone()
    };
    let uninstall_reason = if can_uninstall {
        None
    } else if bundled {
        Some(reason(
            Bundled,
            "Bundled apps cannot be removed by app management.",
        ))
    } else if source == ManagedAppManagementSource::External {
        Some(reason(
            ExternallyManaged,
            "This app was installed outside App management and must be removed with its original installer.",
        ))
    } else if matches!(
        state,
        ManagedAppState::NotInstalled | ManagedAppState::Unsupported
    ) {
        Some(reason(NotInstalled, "This app is not installed."))
    } else {
        selected.reason.clone()
    };
    let update_reason = if can_update {
        None
    } else if bundled {
        Some(reason(
            Bundled,
            "Bundled apps are supplied with the controlled computer and cannot be updated by app management.",
        ))
    } else if source == ManagedAppManagementSource::External {
        Some(reason(
            ExternallyManaged,
            "This app was installed outside App management and must be updated with its original installer.",
        ))
    } else if matches!(
        state,
        ManagedAppState::NotInstalled | ManagedAppState::Unsupported
    ) {
        Some(reason(NotInstalled, "This app is not installed."))
    } else {
        selected.reason.clone()
    };
    ManagedAppProjection {
        id: definition.launcher.id.clone(),
        name: definition.launcher.name.clone(),
        kind: definition.launcher.kind,
        description: definition.launcher.description.clone(),
        state,
        management_source: source,
        version: detection.version.clone(),
        can_install,
        can_uninstall,
        can_update: Some(can_update),
        install_reason,
        uninstall_reason,
        update_reason,
        update_check: None,
        active_job_id: None,
    }
}

fn reason(code: ManagedAppActionReasonCode, message: &str) -> ManagedAppActionReason {
    ManagedAppActionReason {
        code,
        message: message.to_string(),
    }
}

use ManagedAppActionReasonCode::{AlreadyInstalled, Bundled, ExternallyManaged, NotInstalled};

fn command_output_with_timeout(
    executable: &std::ffi::OsStr,
    args: &[String],
    overrides: &BTreeMap<String, String>,
    timeout: Duration,
    max_bytes: usize,
) -> Option<std::process::Output> {
    let mut command = std::process::Command::new(executable);
    command.args(args).stdin(Stdio::null());
    for (name, value) in overrides {
        command.env(name, value);
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut output = child.wait_with_output().ok()?;
    output.stdout.truncate(max_bytes);
    output.stderr.truncate(max_bytes);
    Some(output)
}

async fn quick_command(name: &str, args: &[&str]) -> Option<std::process::Output> {
    let executable = resolve_executable(name, &BTreeMap::new(), None)?;
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        Command::new(executable)
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    Some(output)
}

fn command_available(name: &str) -> bool {
    resolve_executable(name, &BTreeMap::new(), None).is_some()
}

fn path_writable_or_creatable(value: &Path) -> bool {
    let mut candidate = value;
    while !candidate.exists() {
        let Some(parent) = candidate.parent() else {
            return false;
        };
        if parent == candidate {
            break;
        }
        candidate = parent;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(path) = std::ffi::CString::new(candidate.as_os_str().as_bytes()) else {
            return false;
        };
        unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        std::fs::metadata(candidate)
            .map(|metadata| !metadata.permissions().readonly())
            .unwrap_or(false)
    }
}

pub fn detect_final_computer_capabilities_sync() -> FinalComputerCapabilities {
    let platform = current_platform();
    let arch = current_arch();
    let installers = [
        AppInstaller::Apt,
        AppInstaller::Dnf,
        AppInstaller::Brew,
        AppInstaller::Npm,
    ]
    .into_iter()
    .filter(|installer| command_available(installer.as_str()))
    .collect::<Vec<_>>();
    let uid = {
        #[cfg(unix)]
        unsafe {
            libc::geteuid()
        }
        #[cfg(not(unix))]
        1
    };
    let privilege = if uid == 0 {
        AppInstallPrivilege::Root
    } else {
        let sudo = resolve_executable("sudo", &BTreeMap::new(), None).and_then(|executable| {
            command_output_with_timeout(
                executable.as_os_str(),
                &["-n".to_string(), "true".to_string()],
                &BTreeMap::new(),
                Duration::from_secs(2),
                1024,
            )
        });
        if sudo.is_some_and(|output| output.status.success()) {
            AppInstallPrivilege::PasswordlessSudo
        } else {
            AppInstallPrivilege::User
        }
    };
    let installer_access = if installers.contains(&AppInstaller::Npm) {
        let read = |args: &[String]| -> String {
            resolve_executable("npm", &BTreeMap::new(), None)
                .and_then(|executable| {
                    command_output_with_timeout(
                        executable.as_os_str(),
                        args,
                        &BTreeMap::new(),
                        Duration::from_secs(2),
                        1024 * 1024,
                    )
                })
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                .unwrap_or_default()
        };
        let prefix = read(&["prefix".to_string(), "--global".to_string()]);
        let root = read(&["root".to_string(), "--global".to_string()]);
        let writable = !prefix.is_empty()
            && !root.is_empty()
            && Path::new(&prefix).is_absolute()
            && Path::new(&root).is_absolute()
            && {
                let bin = if platform == FinalComputerPlatform::Win32 {
                    PathBuf::from(&prefix)
                } else {
                    Path::new(&prefix).join("bin")
                };
                path_writable_or_creatable(Path::new(&root)) && path_writable_or_creatable(&bin)
            };
        Some(AppInstallerAccess {
            npm_global_writable: Some(writable),
        })
    } else {
        None
    };
    FinalComputerCapabilities {
        platform,
        arch,
        installers,
        privilege,
        installer_access,
    }
}

async fn passwordless_sudo() -> bool {
    #[cfg(unix)]
    {
        let Some(executable) = resolve_executable("sudo", &BTreeMap::new(), None) else {
            return false;
        };
        tokio::time::timeout(
            Duration::from_secs(2),
            Command::new(executable)
                .args(["-n", "true"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .status(),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .map(|status| status.success())
        .unwrap_or(false)
    }
    #[cfg(not(unix))]
    false
}

pub async fn detect_final_computer_capabilities() -> FinalComputerCapabilities {
    let platform = current_platform();
    let arch = current_arch();
    let installers = [
        AppInstaller::Apt,
        AppInstaller::Dnf,
        AppInstaller::Brew,
        AppInstaller::Npm,
    ]
    .into_iter()
    .filter(|installer| command_available(installer.as_str()))
    .collect::<Vec<_>>();
    let uid = {
        #[cfg(unix)]
        unsafe {
            libc::geteuid()
        }
        #[cfg(not(unix))]
        1
    };
    let privilege = if uid == 0 {
        AppInstallPrivilege::Root
    } else if passwordless_sudo().await {
        AppInstallPrivilege::PasswordlessSudo
    } else {
        AppInstallPrivilege::User
    };
    let installer_access = if installers.contains(&AppInstaller::Npm) {
        let prefix = quick_command("npm", &["prefix", "--global"]).await;
        let root = quick_command("npm", &["root", "--global"]).await;
        let prefix = prefix
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default();
        let root = root
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default();
        let writable = if prefix.is_empty()
            || root.is_empty()
            || !Path::new(&prefix).is_absolute()
            || !Path::new(&root).is_absolute()
        {
            false
        } else {
            let bin = if platform == FinalComputerPlatform::Win32 {
                PathBuf::from(&prefix)
            } else {
                Path::new(&prefix).join("bin")
            };
            path_writable_or_creatable(Path::new(&root)) && path_writable_or_creatable(&bin)
        };
        Some(AppInstallerAccess {
            npm_global_writable: Some(writable),
        })
    } else {
        None
    };
    FinalComputerCapabilities {
        platform,
        arch,
        installers,
        privilege,
        installer_access,
    }
}

async fn ownership_command(executable: &str, args: &[String]) -> Option<(i32, String, String)> {
    let resolved = resolve_executable(executable, &BTreeMap::new(), None)?;
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        Command::new(resolved)
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    Some((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

fn resolved_path(value: &Path) -> PathBuf {
    std::fs::canonicalize(value).unwrap_or_else(|_| value.to_path_buf())
}

fn path_inside(candidate: &Path, root: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

async fn node_package_owns_executable(
    recipe: &InstallRecipe,
    detection: &ManagedAppDetectionResult,
    capabilities: &FinalComputerCapabilities,
) -> bool {
    let InstallRecipe::NodePackage {
        installer,
        packages,
        privilege: Some(privilege),
        ..
    } = recipe
    else {
        return false;
    };
    let response = if capabilities.privilege == AppInstallPrivilege::PasswordlessSudo
        && *privilege != AppInstallPrivilege::User
    {
        ownership_command(
            "sudo",
            &[
                "-n".to_string(),
                installer.as_str().to_string(),
                "root".to_string(),
                "--global".to_string(),
            ],
        )
        .await
    } else {
        ownership_command(
            installer.as_str(),
            &["root".to_string(), "--global".to_string()],
        )
        .await
    };
    let Some((0, stdout, _)) = response else {
        return false;
    };
    let npm_root = PathBuf::from(stdout.trim());
    if !npm_root.is_absolute() {
        return false;
    }
    let detected = detection
        .executable_paths
        .iter()
        .map(|path| resolved_path(path))
        .collect::<Vec<_>>();
    for package_name in packages {
        let package_root = package_name
            .split('/')
            .filter(|segment| !segment.is_empty())
            .fold(npm_root.clone(), |path, segment| path.join(segment));
        let Ok(raw) = std::fs::read_to_string(package_root.join("package.json")) else {
            continue;
        };
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let default_bin = package_name.rsplit('/').next().unwrap_or(package_name);
        let bin = match record.get("bin") {
            Some(Value::String(value)) => {
                BTreeMap::from([(default_bin.to_string(), value.clone())])
            }
            Some(Value::Object(values)) => values
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .as_str()
                        .map(|value| (name.clone(), value.to_string()))
                })
                .collect(),
            _ => BTreeMap::new(),
        };
        let owned = bin
            .values()
            .map(|value| package_root.join(value))
            .filter(|value| path_inside(value, &package_root))
            .map(|value| resolved_path(&value))
            .collect::<Vec<_>>();
        if detected.iter().any(|candidate| owned.contains(candidate)) {
            return true;
        }
        if capabilities.platform == FinalComputerPlatform::Win32 {
            let prefix = npm_root.parent().unwrap_or(&npm_root);
            let names = bin.keys().collect::<std::collections::HashSet<_>>();
            if detection.executable_paths.iter().any(|candidate| {
                candidate.parent() == Some(prefix)
                    && candidate
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .map(|value| names.contains(&value.to_string()))
                        .unwrap_or(false)
            }) {
                return true;
            }
        }
    }
    false
}

async fn system_package_owns_executable(
    recipe: &InstallRecipe,
    detection: &ManagedAppDetectionResult,
) -> bool {
    let InstallRecipe::SystemPackage {
        installer,
        packages,
        ..
    } = recipe
    else {
        return false;
    };
    let candidates = detection
        .executable_paths
        .iter()
        .flat_map(|path| [path.clone(), resolved_path(path)])
        .collect::<Vec<_>>();
    match installer {
        AppInstaller::Apt => {
            for candidate in candidates {
                let Some((0, stdout, _)) = ownership_command(
                    "dpkg-query",
                    &["--search".to_string(), candidate.display().to_string()],
                )
                .await
                else {
                    continue;
                };
                if stdout.lines().any(|line| {
                    let package = line.split(':').next().unwrap_or_default();
                    let package = package
                        .rsplit_once(':')
                        .map(|(name, _)| name)
                        .unwrap_or(package);
                    packages.iter().any(|expected| expected == package)
                }) {
                    return true;
                }
            }
            false
        }
        AppInstaller::Dnf => {
            for candidate in candidates {
                let Some((0, stdout, _)) = ownership_command(
                    "rpm",
                    &[
                        "-qf".to_string(),
                        candidate.display().to_string(),
                        "--qf".to_string(),
                        "%{NAME}".to_string(),
                    ],
                )
                .await
                else {
                    continue;
                };
                if packages.iter().any(|package| package == stdout.trim()) {
                    return true;
                }
            }
            false
        }
        AppInstaller::Brew => {
            for package in packages {
                let Some((0, stdout, _)) =
                    ownership_command("brew", &["--prefix".to_string(), package.clone()]).await
                else {
                    continue;
                };
                let prefix = resolved_path(Path::new(stdout.trim()));
                if candidates
                    .iter()
                    .any(|candidate| path_is_inside(candidate, &prefix))
                {
                    return true;
                }
            }
            false
        }
        AppInstaller::Npm => false,
    }
}

fn path_is_inside(candidate: &Path, root: &Path) -> bool {
    let candidate = resolved_path(candidate);
    path_inside(&candidate, root)
}

pub async fn detect_managed_app_ownership(
    definition: &ManagedAppDefinition,
    detection: &ManagedAppDetectionResult,
    capabilities: &FinalComputerCapabilities,
) -> ManagedAppOwnership {
    detect_managed_app_ownership_with_context(definition, detection, capabilities, None).await
}

pub async fn detect_managed_app_ownership_with_context(
    definition: &ManagedAppDefinition,
    detection: &ManagedAppDetectionResult,
    capabilities: &FinalComputerCapabilities,
    context: Option<&ManagedAppOwnershipContext<'_>>,
) -> ManagedAppOwnership {
    if detection.state == ManagedAppState::NotInstalled {
        return ManagedAppOwnership {
            source: ManagedAppManagementSource::None,
            recipe: None,
        };
    }
    let viable = definition
        .recipes
        .iter()
        .filter(|recipe| {
            select_install_recipe(
                &ManagedAppDefinition {
                    recipes: vec![(*recipe).clone()],
                    ..definition.clone()
                },
                capabilities,
            )
            .recipe
            .is_some()
        })
        .cloned()
        .collect::<Vec<_>>();
    if let Some(recipe) = viable
        .iter()
        .find(|recipe| matches!(recipe, InstallRecipe::Bundled { .. }))
    {
        return ManagedAppOwnership {
            source: ManagedAppManagementSource::Bundled,
            recipe: Some(recipe.clone()),
        };
    }
    for recipe in viable {
        let owned = match &recipe {
            InstallRecipe::NodePackage { .. } => {
                node_package_owns_executable(&recipe, detection, capabilities).await
            }
            InstallRecipe::SystemPackage { .. } => {
                system_package_owns_executable(&recipe, detection).await
            }
            InstallRecipe::Archive { install_root, .. } => context.is_some_and(|context| {
                archive_manifest_owns_executable(
                    &definition.launcher.id,
                    install_root,
                    detection,
                    context,
                )
            }),
            InstallRecipe::Bundled { .. } => false,
        };
        if owned {
            return ManagedAppOwnership {
                source: ManagedAppManagementSource::Recipe,
                recipe: Some(recipe),
            };
        }
    }
    ManagedAppOwnership {
        source: ManagedAppManagementSource::External,
        recipe: None,
    }
}

fn archive_manifest_owns_executable(
    app_id: &str,
    install_root: &str,
    detection: &ManagedAppDetectionResult,
    context: &ManagedAppOwnershipContext<'_>,
) -> bool {
    let expected_root = absolute_normalized(&context.install_base_dir.join(install_root));
    let manifest_file = context
        .state_dir
        .join("manifests")
        .join(format!("{app_id}.json"));
    let Ok(raw) = std::fs::read_to_string(manifest_file) else {
        return false;
    };
    let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    if record.get("installRoot").and_then(Value::as_str)
        != Some(expected_root.to_string_lossy().as_ref())
    {
        return false;
    }
    let Some(files) = record.get("files").and_then(Value::as_array) else {
        return false;
    };
    let owned = files
        .iter()
        .map(manifest_value_string)
        .map(|relative| absolute_normalized(&expected_root.join(relative)))
        .filter(|path| path.starts_with(&expected_root))
        .collect::<BTreeSet<_>>();
    detection
        .executable_paths
        .iter()
        .map(|path| absolute_normalized(path))
        .any(|path| owned.contains(&path))
}

fn manifest_value_string(value: &Value) -> String {
    value
        .as_str()
        .map(ToString::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn absolute_normalized(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

pub fn is_launchable_managed_definition(definition: &ManagedAppDefinition) -> bool {
    definition.launchable
}

pub fn validate_managed_definition(
    definition: &ManagedAppDefinition,
) -> Result<(), AppRuntimeError> {
    if definition.launcher.id.is_empty() {
        return Err(AppRuntimeError::catalog_invalid(
            "Managed app id must not be empty.",
        ));
    }
    if definition.detection.is_empty() {
        return Err(AppRuntimeError::catalog_invalid(
            "Managed app detection must not be empty.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capabilities(privilege: AppInstallPrivilege) -> FinalComputerCapabilities {
        FinalComputerCapabilities {
            platform: FinalComputerPlatform::Linux,
            arch: FinalComputerArch::X64,
            installers: vec![AppInstaller::Npm],
            privilege,
            installer_access: Some(AppInstallerAccess {
                npm_global_writable: Some(true),
            }),
        }
    }

    #[test]
    fn builtin_definitions_keep_launchable_and_management_only_apps_distinct() {
        let definitions = builtin_managed_app_definitions();
        assert!(definitions
            .iter()
            .any(|item| item.launcher.id == "thctl" && !item.launchable));
        assert!(definitions
            .iter()
            .any(|item| item.launcher.id == "codex" && item.launchable));
    }

    #[test]
    fn recipe_selection_prefers_the_first_privilege_compatible_recipe() {
        let definition = find_builtin_managed_app("codex").expect("codex");
        let selected = select_install_recipe(&definition, &capabilities(AppInstallPrivilege::User));
        assert_eq!(
            selected.recipe.as_ref().map(InstallRecipe::kind),
            Some("node-package")
        );
        assert_eq!(
            selected.recipe.as_ref().map(InstallRecipe::privilege),
            Some(AppInstallPrivilege::User)
        );

        let unsupported = FinalComputerCapabilities {
            platform: FinalComputerPlatform::Sunos,
            ..capabilities(AppInstallPrivilege::User)
        };
        let selected = select_install_recipe(&definition, &unsupported);
        assert!(selected.recipe.is_none());
        assert_eq!(
            selected.reason.map(|reason| reason.code),
            Some(ManagedAppActionReasonCode::UnsupportedPlatform)
        );
    }

    #[test]
    fn projections_disable_bundled_management_actions() {
        let definition = find_builtin_managed_app("terminal-tty").expect("terminal");
        let detection = detect_managed_app(&definition);
        let projection = managed_app_projection(
            &definition,
            &detection,
            &capabilities(AppInstallPrivilege::User),
            None,
        );
        assert!(!projection.can_install);
        assert!(!projection.can_uninstall);
        assert_eq!(
            projection.update_reason.map(|reason| reason.code),
            Some(Bundled)
        );
    }

    #[tokio::test]
    async fn archive_manifests_establish_recipe_ownership() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let state_dir = temporary.path().join("state");
        let install_base_dir = temporary.path().join("apps");
        let install_root = install_base_dir.join("example");
        std::fs::create_dir_all(state_dir.join("manifests")).expect("manifest directory");
        std::fs::write(
            state_dir.join("manifests").join("example.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "appId": "example",
                "installRoot": install_root,
                "files": ["bin/example"],
            })
            .to_string(),
        )
        .expect("manifest");
        let definition = ManagedAppDefinition {
            launcher: launcher(
                "example",
                "Example",
                AppKind::Tty,
                "Example app",
                "example".to_string(),
                None,
            ),
            launchable: true,
            detection: launcher_detection(),
            recipes: vec![InstallRecipe::Archive {
                platforms: vec![FinalComputerPlatform::Linux],
                arches: Some(vec![FinalComputerArch::X64]),
                privilege: None,
                url: "https://example.invalid/example.tar.gz".to_string(),
                sha256: "0".repeat(64),
                format: "tar.gz".to_string(),
                install_root: "example".to_string(),
            }],
        };
        let detection = ManagedAppDetectionResult {
            state: ManagedAppState::Installed,
            executable_paths: vec![install_root.join("bin").join("example")],
            version: None,
        };
        let ownership = detect_managed_app_ownership_with_context(
            &definition,
            &detection,
            &capabilities(AppInstallPrivilege::User),
            Some(&ManagedAppOwnershipContext {
                state_dir: &state_dir,
                install_base_dir: &install_base_dir,
            }),
        )
        .await;
        assert_eq!(ownership.source, ManagedAppManagementSource::Recipe);
    }
}
