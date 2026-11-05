mod catalog;
pub mod codex_app_server;
pub mod command_invocation;
pub mod executable_resolver;
mod install_environment;
mod log_retention;
mod managed;
mod managed_app_providers;
mod managed_node_apps;
mod management;
mod profiles;
mod pty;
mod recipe;
mod runtime;
mod terminal_screen;
mod update_check;

pub use catalog::{
    builtin_app_catalog, resolve_executable, AppCatalogRepository, AppSource, CatalogEntry,
};
pub use controlled_instance_protocol::AppSession;
pub use install_environment::{
    AppInstallEnvironmentError, AppInstallEnvironmentManager, AppInstallEnvironmentOptions,
    AppInstallExecutionPolicy, AptSourceConfiguration, APP_INSTALL_SOURCE_PROFILES,
    MANAGED_NODE_VERSION, MINIMUM_NODE_VERSION,
};
pub use managed::{
    builtin_managed_app_definitions, current_arch, current_platform,
    detect_final_computer_capabilities, detect_final_computer_capabilities_sync,
    detect_managed_app, detect_managed_app_ownership, detect_managed_app_ownership_with_context,
    detect_managed_app_with_managed_root, detect_managed_app_with_version,
    find_builtin_managed_app, is_launchable_managed_definition, managed_app_projection,
    select_install_recipe, validate_managed_definition, InstallRecipe, InstallRecipeSelection,
    ManagedAppDefinition, ManagedAppDetectionResult, ManagedAppDetectionRule, ManagedAppOwnership,
    ManagedAppOwnershipContext,
};
pub use managed_node_apps::ManagedNodeApps;
pub use management::{AppManagementManager, AppManagementRequestError, AppManagementSession};
pub use profiles::ChromiumProfileStore;
pub use pty::{
    process_group_exists, resize_pty, spawn_pty, terminate_process_group, terminate_process_groups,
    PtyHandle, PtySpawn,
};
pub use recipe::{
    run_app_recipe_command, AppRecipeCommand, AppRecipeCommandResult, AppRecipeExecutionContext,
    AppRecipeExecutionError, AppRecipeExecutor, AppRecipeHooks,
};
pub use runtime::{
    AppProfileLocation, AppRuntime, AppRuntimeChange, AppRuntimeChangeKind, AppRuntimeError,
    AppSessionWorkspacePresence, SharedCodexConnection, SharedOpenCodeConnection, TtyAttachment,
    TtyEvent, SHARED_CODEX_APP_SESSION_ID,
};
pub use terminal_screen::TerminalScreenSnapshot;
pub use update_check::{
    parse_apt_policy, parse_brew_outdated, AppUpdateCheckResult, AppUpdateChecker,
};
