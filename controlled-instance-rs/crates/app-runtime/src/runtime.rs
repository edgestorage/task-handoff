use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use controlled_instance_ai_session::ClaudeControlClient;
use controlled_instance_core::{
    atomic::{read_json, write_json_atomic},
    paths::StoragePaths,
    text::truncate_utf16,
};
use controlled_instance_protocol::{
    mint_entity_id, AppCatalogItem, AppDisplayMode, AppDisplayOptions, AppDisplayTarget, AppKind,
    AppLaunchOptions, AppProfile, AppProfileList, AppSession, AppSessionAutomation,
    AppSessionBinding, AppSessionDisplay, AppSessionPaths, AppSessionProcess, AppSessionTty,
    AppSessionVnc, AppSessionWeb, AppSessionWorkspace as WireAppSessionWorkspace,
    AppSessionsSnapshot,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    io::Read,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
};
use thiserror::Error;
use tokio::{
    process::{Child, Command},
    sync::{broadcast, oneshot, watch},
};
use tracing::{debug, warn};

use crate::{
    catalog::AppCatalogRepository,
    codex_app_server::{
        app_server_disabled, configured_transport, listen_plan, remove_upstream_artifacts,
        spawn_app_server, start_session_proxy, story_mcp_args, wait_until_ready,
        CodexAppServerUpstream, CodexSessionProxy,
    },
    command_invocation::{command_invocation, CommandInvocation, CommandInvocationOptions},
    executable_resolver::ExecutableResolverOptions,
    log_retention::{
        attach_child_logs, enforce_instance_log_budget, RotatingLogWriter,
        DEFAULT_APP_SESSION_LOG_BUDGET_BYTES,
    },
    managed_app_providers::{
        managed_app_provider, managed_app_runtime_provider, ManagedAppGuiRuntime,
        ManagedAppTtyRuntime, ManagedAppWebRuntime,
    },
    profiles::{profile_view, ChromiumProfileStore},
    pty::{
        kill_process_groups, request_stop_process_groups, terminate_process_group,
        terminate_process_groups, wait_process_groups, PtyHandle, PROCESS_KILL_TIMEOUT,
        PROCESS_STOP_TIMEOUT,
    },
    terminal_screen::{TerminalScreenSnapshot, TerminalScreenState},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppSessionWorkspacePresence {
    pub id: String,
    pub cwd: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppProfileLocation {
    pub id: String,
    pub name: String,
    pub directory: PathBuf,
    pub is_default: bool,
}

const DEFAULT_TTY_COLS: u16 = 120;
const DEFAULT_TTY_ROWS: u16 = 32;
const DISPLAY_START: u32 = 101;
const DISPLAY_END: u32 = 199;
const SCREENSHOT_MAX_BYTES: usize = 20 * 1024 * 1024;
const CLEANABLE_SESSION_STATUSES: [&str; 3] = ["stopped", "exited", "failed"];
const DEFAULT_SESSION_RETENTION_DAYS: f64 = 7.0;
const MAINTENANCE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);
const SHARED_OPENCODE_CONSUMER: &str = "__shared_opencode_server__";
const SHARED_CODEX_CONSUMER: &str = "__shared_codex_app_server__";
pub const SHARED_CODEX_APP_SESSION_ID: &str = "__shared_codex_app_server__";
static TTY_ATTACHMENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn command_options(cwd: &Path, env: &BTreeMap<String, String>) -> CommandInvocationOptions {
    CommandInvocationOptions::from(ExecutableResolverOptions {
        env: env.clone(),
        cwd: cwd.to_path_buf(),
        ..ExecutableResolverOptions::default()
    })
}

fn merge_app_environment(
    base: BTreeMap<String, String>,
    app: Option<&BTreeMap<String, String>>,
    launch: &BTreeMap<String, String>,
    managed: &BTreeMap<String, String>,
    unset: &BTreeSet<String>,
    terminal: bool,
) -> BTreeMap<String, String> {
    let mut env = base;
    if let Some(app) = app {
        env.extend(app.clone());
    }
    env.extend(launch.clone());
    env.extend(managed.clone());
    for name in unset {
        env.remove(name);
    }
    if terminal {
        env.insert("TERM".to_string(), "xterm-256color".to_string());
    }
    env
}

async fn stop_process_groups_with_escalation(pids: Vec<u32>) -> Vec<u32> {
    if pids.is_empty() {
        return Vec::new();
    }
    let fallback = pids.clone();
    tokio::task::spawn_blocking(move || {
        let remaining = wait_process_groups(&pids, PROCESS_STOP_TIMEOUT);
        if remaining.is_empty() {
            return remaining;
        }
        kill_process_groups(&remaining);
        wait_process_groups(&remaining, PROCESS_KILL_TIMEOUT)
    })
    .await
    .unwrap_or(fallback)
}

fn invoke_command(
    command: &str,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<CommandInvocation, AppRuntimeError> {
    command_invocation(command, args, &command_options(cwd, env))
        .map_err(|error| AppRuntimeError::spawn(error.to_string()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedOpenCodeConnection {
    pub endpoint: String,
    pub headers: BTreeMap<String, String>,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Error)]
pub enum AppRuntimeError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    SessionNotFound(String),
    #[error("{0}")]
    SessionTitleInvalid(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    MissingCommand(String),
    #[error("{0}")]
    Spawn(String),
    #[error("{0}")]
    Storage(String),
    #[error("{0}")]
    NotImplemented(String),
    #[error("{0}")]
    Draining(String),
    #[error("{0}")]
    CatalogInvalid(String),
    #[error("{message}")]
    ProfileBusy {
        message: String,
        profile_id: String,
        session_id: String,
    },
    #[error("{message}")]
    ProfileNotFound {
        message: String,
        profile_id: Option<String>,
    },
    #[error("{0}")]
    ProfileUnsupported(String),
    #[error("{0}")]
    ProfileNameInvalid(String),
    #[error("{0}")]
    ProfileNameConflict(String),
    #[error("{message}")]
    ProfileDefaultProtected { message: String, profile_id: String },
    #[error("{0}")]
    DisplayNotFound(String),
    #[error("{0}")]
    DisplayInvalid(String),
    #[error("{0}")]
    DisplaySessionNotFound(String),
    #[error("{0}")]
    DisplayStartFailed(String),
    #[error("{0}")]
    DisplayResizeFailed(String),
    #[error("{0}")]
    ScreenshotUnavailable(String),
    #[error("{0}")]
    ScreenshotFailed(String),
    #[error("{0}")]
    AutomationUnavailable(String),
    #[error("{0}")]
    ResourceExhausted(String),
    #[error("{0}")]
    ResumeInvalid(String),
    #[error("{0}")]
    ResumeUnsupported(String),
    #[error("{0}")]
    ProcessStopTimeout(String),
    #[error("{0}")]
    CodexAppServerStartFailed(String),
    #[error("{0}")]
    OpenCodeServerStartFailed(String),
    #[error("{0}")]
    LogsFailed(String),
}

impl AppRuntimeError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "APP_LAUNCH_INVALID",
            Self::NotFound(_) => "APP_NOT_FOUND",
            Self::SessionNotFound(_) => "APP_SESSION_NOT_FOUND",
            Self::SessionTitleInvalid(_) => "APP_SESSION_TITLE_INVALID",
            Self::Conflict(_) => "APP_CONFLICT",
            Self::MissingCommand(_) => "APP_DEPENDENCY_MISSING",
            Self::Spawn(_) => "APP_LAUNCH_FAILED",
            Self::Storage(_) => "APP_PERSISTENCE_FAILED",
            Self::NotImplemented(_) => "APP_NOT_IMPLEMENTED",
            Self::Draining(_) => "APP_RUNTIME_DRAINING",
            Self::CatalogInvalid(_) => "APP_CATALOG_INVALID",
            Self::ProfileBusy { .. } => "BROWSER_PROFILE_BUSY",
            Self::ProfileNotFound { .. } => "BROWSER_PROFILE_NOT_FOUND",
            Self::ProfileUnsupported(_) => "BROWSER_PROFILE_UNSUPPORTED",
            Self::ProfileNameInvalid(_) => "BROWSER_PROFILE_NAME_INVALID",
            Self::ProfileNameConflict(_) => "BROWSER_PROFILE_NAME_CONFLICT",
            Self::ProfileDefaultProtected { .. } => "BROWSER_PROFILE_DEFAULT_PROTECTED",
            Self::DisplayNotFound(_) => "APP_DISPLAY_NOT_FOUND",
            Self::DisplayInvalid(_) => "APP_DISPLAY_INVALID",
            Self::DisplaySessionNotFound(_) => "APP_DISPLAY_SESSION_NOT_FOUND",
            Self::DisplayStartFailed(_) => "APP_DISPLAY_START_FAILED",
            Self::DisplayResizeFailed(_) => "APP_DISPLAY_RESIZE_FAILED",
            Self::ScreenshotUnavailable(_) => "APP_SCREENSHOT_UNAVAILABLE",
            Self::ScreenshotFailed(_) => "APP_SCREENSHOT_FAILED",
            Self::AutomationUnavailable(_) => "APP_AUTOMATION_UNAVAILABLE",
            Self::ResourceExhausted(_) => "APP_RESOURCE_EXHAUSTED",
            Self::ResumeInvalid(_) => "APP_RESUME_INVALID",
            Self::ResumeUnsupported(_) => "APP_RESUME_UNSUPPORTED",
            Self::ProcessStopTimeout(_) => "APP_PROCESS_STOP_TIMEOUT",
            Self::CodexAppServerStartFailed(_) => "CODEX_APP_SERVER_START_FAILED",
            Self::OpenCodeServerStartFailed(_) => "OPENCODE_SERVER_START_FAILED",
            Self::LogsFailed(_) => "APP_LOGS_FAILED",
        }
    }

    pub fn missing_command(command: impl Into<String>) -> Self {
        Self::MissingCommand(format!("Missing required command: {}", command.into()))
    }

    pub fn spawn(message: impl Into<String>) -> Self {
        Self::Spawn(format!(
            "App process could not be started: {}",
            message.into()
        ))
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self::Storage(message.into())
    }

    pub fn catalog_invalid(message: impl Into<String>) -> Self {
        Self::CatalogInvalid(format!("Custom app catalog is invalid: {}", message.into()))
    }

    pub fn details(&self) -> Option<Value> {
        match self {
            Self::ProfileBusy {
                profile_id,
                session_id,
                ..
            } => Some(json!({
                "profileId": profile_id,
                "sessionId": session_id,
            })),
            Self::ProfileNotFound {
                profile_id: Some(profile_id),
                ..
            } => Some(json!({ "profileId": profile_id })),
            Self::ProfileDefaultProtected { profile_id, .. } => {
                Some(json!({ "profileId": profile_id }))
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppRuntimeChangeKind {
    Created,
    Updated,
    Deleted,
}

#[derive(Debug, Clone)]
pub struct AppRuntimeChange {
    pub kind: AppRuntimeChangeKind,
    pub session: AppSession,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TtyEvent {
    Output {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
        #[serde(skip)]
        source_client_id: u64,
    },
    Exit {
        code: Option<i32>,
        signal: Option<String>,
    },
}

pub struct TtyAttachment {
    pub session: AppSession,
    pub dimensions: (u16, u16),
    events: Option<broadcast::Receiver<TtyEvent>>,
    pub client_id: u64,
    entry: Arc<SessionEntry>,
}

impl TtyAttachment {
    pub fn snapshot(&self) -> Option<TerminalScreenSnapshot> {
        self.entry.terminal_snapshot()
    }

    pub fn take_events(&mut self) -> Option<broadcast::Receiver<TtyEvent>> {
        self.events.take()
    }

    pub fn write(&self, data: &[u8]) -> Result<(), AppRuntimeError> {
        if let Some(pty) = self
            .entry
            .pty
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            pty.write(data)
        } else {
            Err(AppRuntimeError::NotFound(
                "TTY session is not running.".to_string(),
            ))
        }
    }

    pub fn resize(
        &self,
        cols: u16,
        rows: u16,
    ) -> Result<Option<TerminalScreenSnapshot>, AppRuntimeError> {
        if cols == 0 || rows == 0 {
            return Err(AppRuntimeError::Invalid(
                "TTY dimensions are invalid.".to_string(),
            ));
        }
        {
            let mut dimensions = self
                .entry
                .dimensions
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *dimensions == (cols, rows) {
                return Ok(None);
            }
            *dimensions = (cols, rows);
        }
        if let Some(pty) = self
            .entry
            .pty
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            pty.resize(cols, rows)?;
        }
        self.entry.resize_terminal(cols, rows);
        Ok(self.entry.terminal_snapshot())
    }

    pub fn notify_resize(&self, cols: u16, rows: u16) {
        let _ = self.entry.clients.send(TtyEvent::Resize {
            cols,
            rows,
            source_client_id: self.client_id,
        });
    }
}

struct SessionEntry {
    metadata: RwLock<AppSession>,
    pty: Mutex<Option<PtyHandle>>,
    terminal: Mutex<Option<TerminalScreenState>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    stop_receiver: tokio::sync::Mutex<Option<oneshot::Receiver<()>>>,
    clients: broadcast::Sender<TtyEvent>,
    dimensions: RwLock<(u16, u16)>,
    stopping: AtomicBool,
    stop_escalation_started: AtomicBool,
    stop_escalation: Arc<watch::Sender<Option<Vec<u32>>>>,
    stop_exit_sent: AtomicBool,
    processes: Mutex<Vec<u32>>,
    claude_lifecycle: Mutex<Option<ClaudeSessionLifecycle>>,
    opencode_consumer: Mutex<Option<String>>,
    codex_lifecycle: Mutex<Option<CodexTtyLifecycle>>,
}

#[derive(Clone)]
struct SharedOpenCodeServer {
    endpoint: String,
    username: String,
    password: String,
    headers: BTreeMap<String, String>,
    log_path: PathBuf,
    child: Arc<Mutex<Option<Child>>>,
    consumers: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone)]
struct SharedCodexAppServer {
    id: String,
    upstream: CodexAppServerUpstream,
    command: String,
    args: Vec<String>,
    log_path: PathBuf,
    child: Arc<Mutex<Option<Child>>>,
    consumers: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone)]
struct CodexTtyLifecycle {
    proxy: Arc<CodexSessionProxy>,
    consumer_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedCodexConnection {
    pub upstream: CodexAppServerUpstream,
    pub pid: Option<u32>,
    pub command: String,
    pub args: Vec<String>,
    pub log_path: PathBuf,
}

#[derive(Clone)]
struct ClaudeSessionLifecycle {
    short: String,
    control_socket: PathBuf,
    cleaned: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VncBackend {
    NoVnc,
    KasmVnc,
}

impl VncBackend {
    fn from_environment() -> Self {
        if std::env::var("TASK_HANDOFF_VNC_BACKEND").as_deref() == Ok("kasmvnc") {
            Self::KasmVnc
        } else {
            Self::NoVnc
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::NoVnc => "novnc",
            Self::KasmVnc => "kasmvnc",
        }
    }
}

#[derive(Debug, Clone)]
struct SharedDisplayRuntime {
    id: String,
    display: String,
    vnc_port: u16,
    websockify_port: Option<u16>,
    x_pid: Option<u32>,
    wm_pid: Option<u32>,
    compositor_pid: Option<u32>,
    xauthority: Option<String>,
    processes: Vec<u32>,
    app_session_ids: HashSet<String>,
}

#[derive(Debug, Clone, Copy)]
struct DisplayGeometry {
    width: u32,
    height: u32,
    depth: u32,
}

struct DisplayBackendRequest<'a> {
    app: &'a AppCatalogItem,
    backend: VncBackend,
    display: &'a str,
    cwd: &'a Path,
    session_dir: &'a Path,
    log_dir: &'a Path,
    geometry: DisplayGeometry,
    vnc_port: u16,
    websockify_port: Option<u16>,
    env: &'a BTreeMap<String, String>,
}

struct SpawnGuiProcessOptions<'a> {
    log_path: &'a Path,
    label: &'a str,
    critical: bool,
}

struct SpawnedGuiProcess {
    child: Child,
    pid: u32,
    label: String,
    critical: bool,
}

pub struct AppRuntime {
    inner: Arc<AppRuntimeInner>,
}

type AppLaunchAdmission = Arc<dyn Fn(&str) -> bool + Send + Sync>;

struct AppRuntimeInner {
    storage_paths: StoragePaths,
    catalog: AppCatalogRepository,
    profiles: ChromiumProfileStore,
    sessions: RwLock<BTreeMap<String, Arc<SessionEntry>>>,
    shared_displays: Mutex<BTreeMap<String, SharedDisplayRuntime>>,
    shared_display_mutation: tokio::sync::Mutex<()>,
    managed_environment: RwLock<BTreeMap<String, String>>,
    managed_environment_unset: RwLock<BTreeSet<String>>,
    shared_resource_private_environment: RwLock<BTreeMap<String, BTreeMap<String, String>>>,
    persisted_sessions: RwLock<BTreeMap<String, AppSession>>,
    changes: broadcast::Sender<AppRuntimeChange>,
    draining: AtomicBool,
    app_launch_allowed: RwLock<AppLaunchAdmission>,
    next_display: Mutex<u32>,
    next_vnc_port: Mutex<u16>,
    next_websockify_port: Mutex<u16>,
    next_web_port: Mutex<u16>,
    next_cdp_port: Mutex<u16>,
    shared_opencode: Arc<Mutex<Option<SharedOpenCodeServer>>>,
    shared_opencode_start: tokio::sync::Mutex<()>,
    shared_codex: Arc<Mutex<Option<SharedCodexAppServer>>>,
    shared_codex_start: tokio::sync::Mutex<()>,
}

impl Clone for AppRuntime {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl AppRuntime {
    pub fn new(storage_paths: StoragePaths, workspace: impl Into<PathBuf>) -> Self {
        Self::new_with_managed_root(storage_paths, workspace, None)
    }

    pub fn new_with_managed_root(
        storage_paths: StoragePaths,
        _workspace: impl Into<PathBuf>,
        managed_app_root: Option<PathBuf>,
    ) -> Self {
        let catalog = AppCatalogRepository::new_with_managed_root(
            &storage_paths.app_catalog_dir,
            managed_app_root,
        );
        let profiles = ChromiumProfileStore::new(&storage_paths.data_dir);
        if let Err(error) = profiles.ensure_default() {
            warn!(%error, "failed to initialize browser profiles");
        }
        let (changes, _) = broadcast::channel(128);
        let runtime = Self {
            inner: Arc::new(AppRuntimeInner {
                storage_paths,
                catalog,
                profiles,
                sessions: RwLock::new(BTreeMap::new()),
                shared_displays: Mutex::new(BTreeMap::new()),
                shared_display_mutation: tokio::sync::Mutex::new(()),
                managed_environment: RwLock::new(BTreeMap::new()),
                managed_environment_unset: RwLock::new(BTreeSet::new()),
                shared_resource_private_environment: RwLock::new(BTreeMap::new()),
                persisted_sessions: RwLock::new(BTreeMap::new()),
                changes,
                draining: AtomicBool::new(false),
                app_launch_allowed: RwLock::new(Arc::new(|_| true)),
                next_display: Mutex::new(101),
                next_vnc_port: Mutex::new(6101),
                next_websockify_port: Mutex::new(7101),
                next_web_port: Mutex::new(8101),
                next_cdp_port: Mutex::new(9201),
                shared_opencode: Arc::new(Mutex::new(None)),
                shared_opencode_start: tokio::sync::Mutex::new(()),
                shared_codex: Arc::new(Mutex::new(None)),
                shared_codex_start: tokio::sync::Mutex::new(()),
            }),
        };
        if env_flag("TASK_HANDOFF_APP_SESSION_PERSIST") {
            runtime.load_persisted_sessions();
        }
        runtime.safe_run_persistence_maintenance();
        runtime.start_maintenance_timer();
        runtime
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppRuntimeChange> {
        self.inner.changes.subscribe()
    }

    pub fn catalog_entry(&self, app_id: &str) -> Option<crate::CatalogEntry> {
        self.inner.catalog.find(app_id)
    }

    pub fn catalog(&self) -> Vec<AppCatalogItem> {
        self.inner.catalog.catalog()
    }

    pub fn custom_catalog(
        &self,
    ) -> Result<(PathBuf, controlled_instance_protocol::CustomAppCatalog), AppRuntimeError> {
        Ok((
            self.inner.catalog.custom_path().to_path_buf(),
            self.inner.catalog.load_custom()?,
        ))
    }

    pub fn save_custom_catalog(
        &self,
        value: Value,
    ) -> Result<(PathBuf, controlled_instance_protocol::CustomAppCatalog), AppRuntimeError> {
        Ok((
            self.inner.catalog.custom_path().to_path_buf(),
            self.inner.catalog.save_custom(value)?,
        ))
    }

    pub fn app_inventory(&self) -> controlled_instance_protocol::AppInventorySnapshot {
        self.inner.catalog.inventory()
    }

    pub fn list_app_profiles(&self, app_id: &str) -> Result<AppProfileList, AppRuntimeError> {
        self.ensure_profile_app(app_id)?;
        let default_profile_id = self.inner.profiles.default_profile_id()?;
        let profiles = self
            .inner
            .profiles
            .list()?
            .into_iter()
            .map(|profile| {
                let disk_usage_bytes = self.inner.profiles.usage_bytes(&profile.id).ok();
                self.profile_view(app_id, profile, &default_profile_id, disk_usage_bytes)
            })
            .collect();
        Ok(AppProfileList {
            app_id: app_id.to_string(),
            default_profile_id,
            profiles,
            observed_at: now_iso(),
        })
    }

    pub fn app_profile_locations(
        &self,
        app_id: &str,
    ) -> Result<Vec<AppProfileLocation>, AppRuntimeError> {
        self.ensure_profile_app(app_id)?;
        let default_profile_id = self.inner.profiles.default_profile_id()?;
        Ok(self
            .inner
            .profiles
            .list()?
            .into_iter()
            .map(|profile| AppProfileLocation {
                is_default: profile.id == default_profile_id,
                id: profile.id,
                name: profile.name,
                directory: PathBuf::from(profile.directory),
            })
            .collect())
    }

    pub fn create_app_profile(
        &self,
        app_id: &str,
        name: &str,
    ) -> Result<AppProfile, AppRuntimeError> {
        self.ensure_profile_app(app_id)?;
        let profile = self.inner.profiles.create(name)?;
        let default_profile_id = self.inner.profiles.default_profile_id()?;
        Ok(self.profile_view(app_id, profile, &default_profile_id, None))
    }

    pub fn rename_app_profile(
        &self,
        app_id: &str,
        profile_id: &str,
        name: &str,
    ) -> Result<AppProfile, AppRuntimeError> {
        self.ensure_profile_app(app_id)?;
        let profile = self.inner.profiles.rename(profile_id, name)?;
        let default_profile_id = self.inner.profiles.default_profile_id()?;
        Ok(self.profile_view(app_id, profile, &default_profile_id, None))
    }

    pub fn remove_app_profile(
        &self,
        app_id: &str,
        profile_id: &str,
    ) -> Result<(), AppRuntimeError> {
        self.assert_app_profile_idle(app_id, profile_id)?;
        self.ensure_profile_app(app_id)?;
        self.inner.profiles.remove(profile_id)
    }

    pub fn set_default_app_profile(
        &self,
        app_id: &str,
        profile_id: &str,
    ) -> Result<AppProfile, AppRuntimeError> {
        self.ensure_profile_app(app_id)?;
        let profile = self.inner.profiles.set_default(profile_id)?;
        Ok(self.profile_view(app_id, profile, profile_id, None))
    }

    pub fn assert_app_profile_idle(
        &self,
        app_id: &str,
        profile_id: &str,
    ) -> Result<(), AppRuntimeError> {
        if let Some(session_id) = self.running_profile_session_id(app_id, profile_id) {
            return Err(AppRuntimeError::ProfileBusy {
                message: format!(
                    "Browser profile {profile_id} is already running in session {session_id}."
                ),
                profile_id: profile_id.to_string(),
                session_id,
            });
        }
        Ok(())
    }

    fn ensure_profile_app(&self, app_id: &str) -> Result<(), AppRuntimeError> {
        self.inner.catalog.find(app_id).ok_or_else(|| {
            AppRuntimeError::NotFound(format!("Managed app {app_id} was not found."))
        })?;
        if !managed_app_provider(app_id)
            .is_some_and(|provider| provider.capabilities.supports_profiles)
        {
            return Err(AppRuntimeError::ProfileUnsupported(format!(
                "Managed app {app_id} does not support browser profiles."
            )));
        }
        Ok(())
    }

    fn running_profile_session_id(&self, app_id: &str, profile_id: &str) -> Option<String> {
        self.list_sessions().into_iter().find_map(|session| {
            (session.app_id == app_id
                && session.status == "running"
                && session
                    .launch
                    .as_ref()
                    .and_then(|launch| launch.profile_id.as_deref())
                    == Some(profile_id))
            .then_some(session.id)
        })
    }

    fn profile_view(
        &self,
        app_id: &str,
        profile: crate::profiles::ChromiumProfileRecord,
        default_profile_id: &str,
        disk_usage_bytes: Option<u64>,
    ) -> AppProfile {
        let running_session_id = self.running_profile_session_id(app_id, &profile.id);
        let mut view = profile_view(profile, default_profile_id);
        view.running_session_id = running_session_id;
        view.disk_usage_bytes = disk_usage_bytes;
        view
    }

    pub fn set_managed_environment(&self, env: BTreeMap<String, String>) {
        self.set_managed_environment_with_unset(env, BTreeSet::new());
    }

    pub fn set_managed_environment_with_unset(
        &self,
        env: BTreeMap<String, String>,
        unset: BTreeSet<String>,
    ) {
        let changed = {
            let current = self
                .inner
                .managed_environment
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let current_unset = self
                .inner
                .managed_environment_unset
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *current != env || *current_unset != unset
        };
        if !changed {
            return;
        }
        *self
            .inner
            .managed_environment
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = env;
        *self
            .inner
            .managed_environment_unset
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = unset;
        self.stop_shared_opencode();
        self.stop_shared_codex();
    }

    pub fn set_shared_resource_private_environment(
        &self,
        resource: &str,
        environment: BTreeMap<String, String>,
    ) {
        let mut environments = self
            .inner
            .shared_resource_private_environment
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if environments.get(resource) == Some(&environment) {
            return;
        }
        environments.insert(resource.to_string(), environment);
        drop(environments);
        if resource == "opencode" {
            self.stop_shared_opencode();
        } else if resource == "codex" {
            self.stop_shared_codex();
        }
    }

    pub async fn ensure_shared_codex(&self) -> Result<SharedCodexConnection, AppRuntimeError> {
        self.acquire_shared_codex(SHARED_CODEX_CONSUMER, None).await
    }

    pub fn shared_codex_connection(&self) -> Option<SharedCodexConnection> {
        let server = self
            .inner
            .shared_codex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()?;
        server.is_running().then(|| server.connection())
    }

    pub fn running_shared_codex_app_server(&self) -> bool {
        self.shared_codex_connection().is_some()
    }

    pub fn release_shared_codex(&self, consumer_id: &str) {
        let server = {
            let mut shared = self
                .inner
                .shared_codex
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            {
                let Some(server) = shared.as_ref() else {
                    return;
                };
                let mut consumers = server
                    .consumers
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                consumers.remove(consumer_id);
                if !consumers.is_empty() {
                    return;
                }
            }
            shared.take()
        };
        if let Some(server) = server {
            server.stop();
            remove_upstream_artifacts(&server.upstream);
        }
    }

    pub fn set_app_launch_admission(&self, allowed: impl Fn(&str) -> bool + Send + Sync + 'static) {
        *self
            .inner
            .app_launch_allowed
            .write()
            .unwrap_or_else(|p| p.into_inner()) = Arc::new(allowed);
    }

    fn require_app_launch_admission(&self, app_id: &str) -> Result<(), AppRuntimeError> {
        if !(self
            .inner
            .app_launch_allowed
            .read()
            .unwrap_or_else(|p| p.into_inner()))(app_id)
        {
            return Err(AppRuntimeError::Conflict(
                "The app is being changed. Try again after the operation completes.".into(),
            ));
        }
        Ok(())
    }

    pub fn process_environment(
        &self,
        base: &BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, String>, AppRuntimeError> {
        self.inner
            .catalog
            .managed_node_apps()
            .map(|apps| apps.terminal_environment(base))
            .transpose()
            .map_err(|error| AppRuntimeError::storage(error.to_string()))
            .map(|env| env.unwrap_or_else(|| base.clone()))
    }

    pub fn prepare_shell(
        &self,
        command: &str,
        args: &[String],
        env: &BTreeMap<String, String>,
    ) -> Result<(Vec<String>, BTreeMap<String, String>), AppRuntimeError> {
        self.inner
            .catalog
            .managed_node_apps()
            .map(|apps| apps.prepare_shell(command, args, env))
            .transpose()
            .map_err(|error| AppRuntimeError::storage(error.to_string()))
            .map(|result| result.unwrap_or_else(|| (args.to_vec(), env.clone())))
    }

    fn missing_app_command(&self, app: &AppCatalogItem) -> AppRuntimeError {
        if self
            .inner
            .catalog
            .managed_node_apps()
            .is_some_and(|apps| apps.contains(&app.id))
        {
            AppRuntimeError::MissingCommand(format!(
                "{} is not installed in this instance. Install it from app management.",
                app.name
            ))
        } else {
            AppRuntimeError::missing_command(app.command.clone().unwrap_or_else(|| app.id.clone()))
        }
    }

    pub fn stop_shared_resource(&self, app_id: &str) {
        match app_id {
            "codex" => self.stop_shared_codex(),
            "opencode" => self.stop_shared_opencode(),
            _ => {}
        }
    }

    pub fn invalidate_catalog(&self) {
        self.inner.catalog.invalidate();
    }

    pub fn stop_shared_codex(&self) {
        let server = self
            .inner
            .shared_codex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(server) = server {
            server.stop();
            remove_upstream_artifacts(&server.upstream);
        }
    }

    async fn acquire_shared_codex(
        &self,
        consumer_id: &str,
        launch_environment: Option<&BTreeMap<String, String>>,
    ) -> Result<SharedCodexConnection, AppRuntimeError> {
        let _guard = self.inner.shared_codex_start.lock().await;
        self.require_app_launch_admission("codex")?;
        if let Some(server) = self
            .inner
            .shared_codex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        {
            if server.is_running() {
                server
                    .consumers
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(consumer_id.to_string());
                return Ok(server.connection());
            }
        }
        self.stop_shared_codex();

        let entry =
            self.inner.catalog.find("codex").ok_or_else(|| {
                AppRuntimeError::NotFound("Codex app is unavailable.".to_string())
            })?;
        let catalog_command = entry
            .app
            .command
            .clone()
            .unwrap_or_else(|| "codex".to_string());
        let command = if self.inner.catalog.managed_node_apps().is_some() {
            catalog_command.clone()
        } else {
            std::env::var("TASK_HANDOFF_CODEX_APP_SERVER_COMMAND")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| catalog_command.clone())
        };
        let cwd = entry
            .app
            .cwd
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.inner.storage_paths.data_dir.clone());
        let mut environment = match launch_environment {
            Some(environment) => environment.clone(),
            None => {
                let mut environment =
                    self.environment(&entry.app, &AppLaunchOptions::default(), false)?;
                environment.insert("TERM".to_string(), "xterm-256color".to_string());
                environment
            }
        };
        if let Some(private) = self
            .inner
            .shared_resource_private_environment
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get("codex")
            .cloned()
        {
            environment.extend(private);
        }
        let executable = if command == catalog_command {
            entry
                .executable
                .clone()
                .ok_or_else(|| self.missing_app_command(&entry.app))?
        } else {
            crate::catalog::resolve_executable(
                &command,
                &environment,
                Some(&cwd.display().to_string()),
            )
            .ok_or_else(|| AppRuntimeError::missing_command(command.clone()))?
        };
        let runtime_dir = self
            .inner
            .storage_paths
            .runtime_dir
            .join("codex-app-server");
        let log_dir = self
            .inner
            .storage_paths
            .log_dir
            .join("app-sessions")
            .join("codex-app-server");
        std::fs::create_dir_all(&log_dir)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        let log_path = log_dir.join("codex-app-server.log");
        let plan = listen_plan(configured_transport(), &runtime_dir, || {
            self.allocate_web_port()
        })?;
        let mut args = story_mcp_args(&environment);
        args.push("app-server".to_string());
        args.extend(plan.listen_args.clone());
        let invocation =
            invoke_command(&executable.display().to_string(), &args, &cwd, &environment)?;
        let mut child = spawn_app_server(&invocation, &cwd, &environment, &log_path).await?;
        if let Err(error) = wait_until_ready(&mut child, &plan).await {
            if let Some(pid) = child.id() {
                terminate_process_group(pid);
            }
            let _ = child.start_kill();
            remove_upstream_artifacts(&plan.upstream);
            return Err(AppRuntimeError::CodexAppServerStartFailed(
                error.to_string(),
            ));
        }
        let pid = child.id();
        let id = uuid::Uuid::new_v4().to_string();
        let server = SharedCodexAppServer {
            id: id.clone(),
            upstream: plan.upstream,
            command,
            args,
            log_path,
            child: Arc::new(Mutex::new(Some(child))),
            consumers: Arc::new(Mutex::new(HashSet::from([consumer_id.to_string()]))),
        };
        let connection = server.connection();
        *self
            .inner
            .shared_codex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(server.clone());
        self.watch_shared_codex(server, pid);
        Ok(connection)
    }

    fn watch_shared_codex(&self, server: SharedCodexAppServer, _pid: Option<u32>) {
        let runtime = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let current = runtime
                    .inner
                    .shared_codex
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .as_ref()
                    .map(|current| current.id.clone());
                if current.as_deref() != Some(server.id.as_str()) {
                    return;
                }
                if server.is_running() {
                    continue;
                }
                let stopped = runtime
                    .inner
                    .shared_codex
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                    .filter(|current| current.id == server.id);
                if let Some(server) = stopped {
                    let exit = server.exit_status();
                    let consumers = server
                        .consumers
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone();
                    for session_id in consumers {
                        if session_id == SHARED_CODEX_CONSUMER {
                            continue;
                        }
                        if let Ok(metadata) = runtime.update_metadata(&session_id, |metadata| {
                            if let Some(ai) = metadata.ai.as_mut().and_then(Value::as_object_mut) {
                                if let Some(app_server) =
                                    ai.get_mut("appServer").and_then(Value::as_object_mut)
                                {
                                    let (status, exit_code, signal) = app_server_exit_fields(exit);
                                    app_server.insert("status".to_string(), json!(status));
                                    app_server.insert("exitCode".to_string(), json!(exit_code));
                                    app_server.insert("signal".to_string(), json!(signal));
                                }
                            }
                            metadata.updated_at = now_iso();
                        }) {
                            runtime.persist(&metadata);
                            runtime.emit(AppRuntimeChangeKind::Updated, metadata);
                        }
                    }
                    remove_upstream_artifacts(&server.upstream);
                }
                return;
            }
        });
    }

    fn bind_codex_thread(&self, session_id: &str, thread_id: String) {
        let Ok(metadata) = self.update_metadata(session_id, |metadata| {
            let ai = metadata
                .ai
                .get_or_insert_with(|| json!({ "agent": "codex" }));
            if let Some(object) = ai.as_object_mut() {
                object.insert("agent".to_string(), json!("codex"));
                object.insert("activeThreadId".to_string(), json!(thread_id));
                let threads = object
                    .entry("threadIds")
                    .or_insert_with(|| json!([]))
                    .as_array_mut();
                if let Some(threads) = threads {
                    if !threads
                        .iter()
                        .any(|value| value.as_str() == Some(thread_id.as_str()))
                    {
                        threads.push(json!(thread_id));
                    }
                }
            }
            metadata.updated_at = now_iso();
        }) else {
            return;
        };
        self.persist(&metadata);
        self.emit(AppRuntimeChangeKind::Updated, metadata);
    }

    pub fn app_session_id_for_codex_thread(&self, thread_id: &str) -> Option<String> {
        self.list_sessions().into_iter().find_map(|session| {
            let ai = session.ai.as_ref()?;
            let active = ai.get("activeThreadId").and_then(Value::as_str);
            let known = ai
                .get("threadIds")
                .and_then(Value::as_array)
                .is_some_and(|threads| {
                    threads
                        .iter()
                        .any(|value| value.as_str() == Some(thread_id))
                });
            (active == Some(thread_id) || known).then_some(session.id)
        })
    }

    pub async fn ensure_shared_opencode(
        &self,
    ) -> Result<SharedOpenCodeConnection, AppRuntimeError> {
        self.acquire_shared_opencode(SHARED_OPENCODE_CONSUMER, None)
            .await
    }

    pub fn shared_opencode_connection(&self) -> Option<SharedOpenCodeConnection> {
        let server = self
            .inner
            .shared_opencode
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()?;
        server.is_running().then(|| server.connection())
    }

    pub fn release_shared_opencode(&self, consumer_id: &str) {
        let server = {
            let mut shared = self
                .inner
                .shared_opencode
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            {
                let Some(server) = shared.as_ref() else {
                    return;
                };
                let mut consumers = server
                    .consumers
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                consumers.remove(consumer_id);
                if !consumers.is_empty() {
                    return;
                }
            }
            shared.take()
        };
        if let Some(server) = server {
            server.stop();
        }
    }

    pub fn stop_shared_opencode(&self) {
        let server = self
            .inner
            .shared_opencode
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(server) = server {
            server.stop();
        }
    }

    async fn acquire_shared_opencode(
        &self,
        consumer_id: &str,
        launch_environment: Option<&BTreeMap<String, String>>,
    ) -> Result<SharedOpenCodeConnection, AppRuntimeError> {
        let _guard = self.inner.shared_opencode_start.lock().await;
        self.require_app_launch_admission("opencode")?;
        if let Some(server) = self
            .inner
            .shared_opencode
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        {
            if server.is_running() {
                server
                    .consumers
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(consumer_id.to_string());
                return Ok(server.connection());
            }
        }
        self.stop_shared_opencode();

        let entry =
            self.inner.catalog.find("opencode").ok_or_else(|| {
                AppRuntimeError::NotFound("OpenCode app is unavailable.".to_string())
            })?;
        let executable = entry
            .executable
            .ok_or_else(|| self.missing_app_command(&entry.app))?;
        let cwd = entry
            .app
            .cwd
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.inner.storage_paths.data_dir.clone());
        let mut environment = match launch_environment {
            Some(environment) => environment.clone(),
            None => {
                let mut environment =
                    self.environment(&entry.app, &AppLaunchOptions::default(), false)?;
                environment.insert("TERM".to_string(), "xterm-256color".to_string());
                environment
            }
        };
        if let Some(private) = self
            .inner
            .shared_resource_private_environment
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get("opencode")
            .cloned()
        {
            environment.extend(private);
        }
        let port = self.allocate_web_port()?;
        let endpoint = format!("http://127.0.0.1:{port}");
        let username = "task-handoff".to_string();
        let mut password_bytes = [0_u8; 32];
        password_bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        password_bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        let password = URL_SAFE_NO_PAD.encode(password_bytes);
        let authorization = STANDARD.encode(format!("{username}:{password}"));
        let headers = BTreeMap::from([(
            "Authorization".to_string(),
            format!("Basic {authorization}"),
        )]);
        let config = opencode_server_config(&environment)?;
        let mut server_environment = environment;
        server_environment.insert("OPENCODE_SERVER_USERNAME".to_string(), username.clone());
        server_environment.insert("OPENCODE_SERVER_PASSWORD".to_string(), password.clone());
        server_environment.insert("OPENCODE_CLIENT".to_string(), "task-handoff".to_string());
        server_environment.insert(
            "OPENCODE_CONFIG_CONTENT".to_string(),
            serde_json::to_string(&config)
                .map_err(|error| AppRuntimeError::spawn(error.to_string()))?,
        );

        let log_dir = self
            .inner
            .storage_paths
            .log_dir
            .join("app-sessions")
            .join("opencode-server");
        std::fs::create_dir_all(&log_dir)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        let log_path = log_dir.join("opencode-server.log");
        let invocation = invoke_command(
            &executable.display().to_string(),
            &[
                "serve".into(),
                "--hostname=127.0.0.1".into(),
                format!("--port={port}"),
            ],
            &cwd,
            &server_environment,
        )?;
        let mut command = Command::new(&invocation.executable);
        command
            .args(&invocation.args)
            .current_dir(&cwd)
            .envs(&invocation.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppRuntimeError::missing_command(executable.display().to_string())
            } else {
                AppRuntimeError::spawn(format!("OpenCode server failed to start: {error}"))
            }
        })?;
        attach_child_logs(&mut child, &log_path)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        let server = SharedOpenCodeServer {
            endpoint: endpoint.clone(),
            username,
            password,
            headers: headers.clone(),
            log_path: log_path.clone(),
            child: Arc::new(Mutex::new(Some(child))),
            consumers: Arc::new(Mutex::new(HashSet::from([consumer_id.to_string()]))),
        };
        *self
            .inner
            .shared_opencode
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(server.clone());

        if let Err(error) =
            wait_for_opencode_health(&server, std::time::Duration::from_secs(10)).await
        {
            server.stop();
            self.stop_shared_opencode();
            return Err(AppRuntimeError::OpenCodeServerStartFailed(
                error.to_string(),
            ));
        }
        Ok(server.connection())
    }

    pub fn begin_drain(&self) {
        self.inner.draining.store(true, Ordering::SeqCst);
    }

    pub fn end_drain(&self) {
        self.inner.draining.store(false, Ordering::SeqCst);
    }

    pub fn is_draining(&self) -> bool {
        self.inner.draining.load(Ordering::SeqCst)
    }

    pub fn list_sessions(&self) -> Vec<AppSession> {
        let mut sessions = self
            .inner
            .persisted_sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        sessions
    }

    pub fn snapshot(&self) -> AppSessionsSnapshot {
        AppSessionsSnapshot::active(self.list_sessions())
    }

    pub fn get_session(&self, id: &str) -> Option<AppSession> {
        self.live_session(id).or_else(|| {
            self.inner
                .persisted_sessions
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(id)
                .cloned()
        })
    }

    fn live_session(&self, id: &str) -> Option<AppSession> {
        let entry = self
            .inner
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()?;
        let metadata = entry
            .metadata
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        Some(metadata)
    }

    pub fn get_session_cwd(&self, id: &str) -> Option<String> {
        self.get_session(id).map(|session| session.workspace.cwd)
    }

    pub fn list_session_workspaces(&self) -> Vec<AppSessionWorkspacePresence> {
        self.list_sessions()
            .into_iter()
            .map(|session| AppSessionWorkspacePresence {
                cwd: Some(session.workspace.cwd),
                id: session.id,
                status: session.status,
            })
            .collect()
    }

    pub fn running_session_count(&self) -> u64 {
        self.list_sessions()
            .iter()
            .filter(|session| session.status == "running")
            .count() as u64
    }

    pub fn problem_session_count(&self) -> u64 {
        self.list_sessions()
            .iter()
            .filter(|session| session.status == "failed")
            .count() as u64
    }

    pub fn insert_session(&self, session: AppSession) {
        let metadata = session.clone();
        let entry = Arc::new(SessionEntry::new(session));
        let id = entry.session_id();
        self.inner
            .persisted_sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), metadata);
        self.inner
            .sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, entry);
    }

    pub async fn start(
        &self,
        app_id: &str,
        options: AppLaunchOptions,
    ) -> Result<AppSession, AppRuntimeError> {
        if self.is_draining() {
            return Err(AppRuntimeError::Draining(
                "App launches are unavailable while the controlled instance is draining for a runtime update."
                    .to_string(),
            ));
        }
        self.require_app_launch_admission(app_id)?;
        let options = normalize_launch_options(options)?;
        let entry = self
            .inner
            .catalog
            .find(app_id)
            .ok_or_else(|| AppRuntimeError::NotFound("App not found.".to_string()))?;
        let app = entry.app;
        if let Some(profile_id) = options.profile_id.as_deref() {
            if !managed_app_provider(&app.id)
                .is_some_and(|provider| provider.capabilities.supports_profiles)
            {
                return Err(AppRuntimeError::ProfileUnsupported(format!(
                    "Managed app {} does not support launch profiles.",
                    app.id
                )));
            }
            self.assert_app_profile_idle(&app.id, profile_id)?;
            self.inner.profiles.resolve(profile_id)?;
        }
        let executable = entry
            .executable
            .ok_or_else(|| self.missing_app_command(&app))?;
        let resume_args = self.ai_session_resume_args(&app, &options)?;
        match app.kind {
            AppKind::Tty => self.start_tty(app, executable, options, resume_args).await,
            AppKind::Web => self.start_web(app, executable, options).await,
            AppKind::Gui => self.start_gui(app, executable, options).await,
        }
    }

    pub async fn start_resume(
        &self,
        agent: &str,
        cwd: &str,
        ai_session_id: &str,
        provider_session_id: &str,
    ) -> Result<AppSession, AppRuntimeError> {
        if !Path::new(cwd).is_dir() {
            return Err(AppRuntimeError::Invalid(format!(
                "App workspace is not a directory: {cwd}"
            )));
        }
        let options = AppLaunchOptions {
            cwd: Some(cwd.to_string()),
            ai_session_resume: Some(controlled_instance_protocol::AppAiSessionResume {
                ai_session_id: ai_session_id.to_string(),
                provider_session_id: provider_session_id.to_string(),
            }),
            ..AppLaunchOptions::default()
        };
        self.start(agent, options).await
    }

    fn ai_session_resume_args(
        &self,
        app: &AppCatalogItem,
        options: &AppLaunchOptions,
    ) -> Result<Vec<String>, AppRuntimeError> {
        let Some(resume) = options.ai_session_resume.as_ref() else {
            return Ok(Vec::new());
        };
        let provider = managed_app_provider(&app.id)
            .filter(|provider| provider.capabilities.supports_ai_session_resume)
            .ok_or_else(|| {
                AppRuntimeError::ResumeUnsupported(format!(
                    "{} does not support AI session resume.",
                    app.id
                ))
            })?;
        provider
            .ai_session_resume_args(&resume.provider_session_id)
            .ok_or_else(|| {
                AppRuntimeError::ResumeUnsupported(format!(
                    "{} does not support AI session resume.",
                    app.id
                ))
            })
    }

    async fn start_tty(
        &self,
        app: AppCatalogItem,
        executable: PathBuf,
        mut options: AppLaunchOptions,
        resume_args: Vec<String>,
    ) -> Result<AppSession, AppRuntimeError> {
        self.require_app_launch_admission(&app.id)?;
        let cwd = resolve_launch_cwd(options.cwd.as_deref(), app.cwd.as_deref());
        if !cwd.is_dir() {
            return Err(AppRuntimeError::Invalid(format!(
                "App workspace is not a directory: {}",
                cwd.display()
            )));
        }
        options.cwd = Some(cwd.display().to_string());
        let id = mint_entity_id("app");
        let session_dir = self.inner.storage_paths.app_sessions_dir.join(&id);
        let log_dir = self
            .inner
            .storage_paths
            .log_dir
            .join("app-sessions")
            .join(&id);
        std::fs::create_dir_all(&session_dir)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        std::fs::create_dir_all(&log_dir)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        let resume_args_for_launch = resume_args.clone();
        let mut args = app.args.clone().unwrap_or_default();
        args.extend(options.args.clone());
        args.extend(resume_args);
        let mut env = self.environment(&app, &options, true)?;
        let shell = executable.display().to_string();
        let mut tty_mode = "pty".to_string();
        let mut ai = None;
        let mut claude_short = None;
        let mut claude_control_socket = None;
        let mut opencode_consumer = None;
        let mut codex_lifecycle = None;
        let tty_runtime = managed_app_provider(&app.id)
            .map(|provider| provider.tty_runtime)
            .unwrap_or(ManagedAppTtyRuntime::Default);
        if tty_runtime == ManagedAppTtyRuntime::Codex && !app_server_disabled() {
            let shared = self.acquire_shared_codex(&id, Some(&env)).await?;
            let proxy_port = match self.allocate_web_port() {
                Ok(port) => port,
                Err(error) => {
                    self.release_shared_codex(&id);
                    return Err(error);
                }
            };
            let runtime = self.clone();
            let session_id = id.clone();
            let proxy = match start_session_proxy(
                shared.upstream.clone(),
                proxy_port,
                Arc::new(move |thread_id| runtime.bind_codex_thread(&session_id, thread_id)),
            )
            .await
            {
                Ok(proxy) => Arc::new(proxy),
                Err(error) => {
                    self.release_shared_codex(&id);
                    return Err(error);
                }
            };
            args = app.args.clone().unwrap_or_default();
            args.extend([
                "--remote".to_string(),
                proxy.endpoint().to_string(),
                "--cd".to_string(),
                cwd.display().to_string(),
            ]);
            args.extend(options.args.clone());
            args.extend(resume_args_for_launch);
            env.insert("TASK_HANDOFF_APP_SESSION_ID".to_string(), id.clone());
            env.insert(
                "TASK_HANDOFF_CODEX_APP_SERVER_URL".to_string(),
                shared.upstream.endpoint(),
            );
            env.insert(
                "TASK_HANDOFF_CODEX_APP_SERVER_PROXY_URL".to_string(),
                proxy.endpoint().to_string(),
            );
            if let Some(socket_path) = shared.upstream.socket_path() {
                env.insert(
                    "TASK_HANDOFF_CODEX_APP_SERVER_SOCKET".to_string(),
                    socket_path.display().to_string(),
                );
            }
            ai = Some(json!({
                "agent": "codex",
                "appServer": shared.upstream.app_server_metadata(
                    shared.pid,
                    &shared.command,
                    &shared.args,
                    &shared.log_path,
                    Some((proxy.endpoint(), proxy.port())),
                    "running",
                ),
            }));
            codex_lifecycle = Some(CodexTtyLifecycle {
                proxy,
                consumer_id: id.clone(),
            });
        } else if tty_runtime == ManagedAppTtyRuntime::OpenCode {
            let connection = self.acquire_shared_opencode(&id, Some(&env)).await?;
            args = vec![
                "attach".to_string(),
                connection.endpoint.clone(),
                "--dir".to_string(),
                cwd.display().to_string(),
            ];
            args.extend(options.args.clone());
            args.extend(resume_args_for_launch);
            env.insert(
                "OPENCODE_SERVER_USERNAME".to_string(),
                connection.username.clone(),
            );
            env.insert(
                "OPENCODE_SERVER_PASSWORD".to_string(),
                connection.password.clone(),
            );
            env.insert("OPENCODE_CLIENT".to_string(), "task-handoff".to_string());
            ai = Some(json!({ "agent": "opencode" }));
            opencode_consumer = Some(id.clone());
        } else if tty_runtime == ManagedAppTtyRuntime::Claude {
            if let Some(prepared) = prepare_claude_tty_launch(&shell, &args, &cwd, &env, &id)? {
                let PreparedClaudeLaunch {
                    args: prepared_args,
                    env: prepared_env,
                    tty_mode: prepared_mode,
                    ai: prepared_ai,
                    short,
                    control_socket,
                } = prepared;
                args = prepared_args;
                env.extend(prepared_env);
                tty_mode = prepared_mode;
                ai = Some(prepared_ai);
                claude_short = Some(short.clone());
                claude_control_socket = Some(control_socket);
            }
        }
        self.require_app_launch_admission(&app.id)?;
        let (prepared_args, prepared_env) = self.prepare_shell(&shell, &args, &env)?;
        args = prepared_args;
        env = prepared_env;
        let dimensions = (DEFAULT_TTY_COLS, DEFAULT_TTY_ROWS);
        let invocation = invoke_command(&shell, &args, &cwd, &env)?;
        let spawn = match crate::pty::spawn_pty(
            &invocation.executable.to_string_lossy(),
            &invocation.args,
            &cwd,
            &invocation.env,
            dimensions.0,
            dimensions.1,
        ) {
            Ok(spawn) => spawn,
            Err(error) => {
                if let Some(short) = claude_short.as_deref() {
                    stop_claude_background(&shell, short, &cwd, &env);
                }
                if let Some(lifecycle) = codex_lifecycle.as_ref() {
                    lifecycle.proxy.stop();
                    self.release_shared_codex(&lifecycle.consumer_id);
                }
                return Err(error);
            }
        };
        let pty = spawn.handle.clone();
        let reader = spawn.reader;
        let child = spawn.child;
        let pid = spawn.pid;
        let now = now_iso();
        let metadata = AppSession {
            id: id.clone(),
            app_id: app.id.clone(),
            title: options.title.clone().unwrap_or_else(|| app.name.clone()),
            kind: "tty".to_string(),
            status: "running".to_string(),
            created_at: now.clone(),
            updated_at: now,
            workspace: WireAppSessionWorkspace {
                cwd: cwd.display().to_string(),
            },
            launch: Some(options.clone()),
            tty: Some(AppSessionTty {
                web_path: format!("/api/apps/sessions/{id}/tty"),
                shell: shell.clone(),
                cwd: cwd.display().to_string(),
                mode: Some(tty_mode),
            }),
            display: None,
            vnc: None,
            web: None,
            automation: None,
            process: Some(AppSessionProcess {
                pid: Some(pid),
                command: shell,
                exit_code: None,
                signal: None,
            }),
            ai,
            paths: AppSessionPaths {
                session_dir: session_dir.display().to_string(),
                log_dir: log_dir.display().to_string(),
            },
            bindings: Vec::new(),
            extra: BTreeMap::new(),
        };
        let entry = Arc::new(SessionEntry::new(metadata.clone()));
        entry.set_pty(pty);
        entry.set_terminal(TerminalScreenState::new(dimensions.0, dimensions.1));
        if let (Some(short), Some(control_socket)) = (claude_short, claude_control_socket) {
            entry.set_claude_lifecycle(short, control_socket);
        }
        if let Some(consumer) = opencode_consumer.clone() {
            entry.set_opencode_consumer(consumer);
        }
        if let Some(lifecycle) = codex_lifecycle {
            entry.set_codex_lifecycle(lifecycle);
        }
        self.inner
            .sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), entry.clone());
        self.persist(&metadata);
        self.emit(AppRuntimeChangeKind::Created, metadata.clone());
        self.start_tty_reader(entry.clone(), reader, log_dir.join("tty.log"));
        self.start_child_monitor(entry, child, app.id);
        Ok(metadata)
    }

    async fn start_web(
        &self,
        app: AppCatalogItem,
        executable: PathBuf,
        mut options: AppLaunchOptions,
    ) -> Result<AppSession, AppRuntimeError> {
        let command = app.command.clone().unwrap_or_else(|| app.id.clone());
        if crate::catalog::resolve_executable(&command, &BTreeMap::new(), None).is_none() {
            return Err(AppRuntimeError::missing_command(command));
        }
        let cwd = resolve_launch_cwd(options.cwd.as_deref(), app.cwd.as_deref());
        if !cwd.is_dir() {
            return Err(AppRuntimeError::Invalid(format!(
                "App workspace is not a directory: {}",
                cwd.display()
            )));
        }
        options.cwd = Some(cwd.display().to_string());
        let id = mint_entity_id("app");
        let session_dir = self.inner.storage_paths.app_sessions_dir.join(&id);
        let log_dir = self
            .inner
            .storage_paths
            .log_dir
            .join("app-sessions")
            .join(&id);
        std::fs::create_dir_all(&session_dir)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        std::fs::create_dir_all(&log_dir)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        let port = self.allocate_web_port()?;
        let placeholders = |value: &str| {
            value
                .replace("{port}", &port.to_string())
                .replace("{sessionDir}", &session_dir.display().to_string())
                .replace("{cwd}", &cwd.display().to_string())
        };
        let mut args = app
            .args
            .as_deref()
            .unwrap_or_default()
            .iter()
            .chain(options.args.iter())
            .map(|arg| placeholders(arg))
            .collect::<Vec<_>>();
        if let Some(port_arg) = app.web.as_ref().and_then(|web| web.port_arg.as_ref()) {
            args.insert(0, placeholders(port_arg));
        }
        if managed_app_runtime_provider(&app)
            .is_some_and(|provider| provider.web_runtime == ManagedAppWebRuntime::VscodeWeb)
        {
            prepare_vscode_web_session(&session_dir);
        }
        let env = self.environment(&app, &options, false)?;
        let log_path = log_dir.join(format!("{}.log", app.id));
        let invocation = invoke_command(&executable.display().to_string(), &args, &cwd, &env)?;
        let mut command = Command::new(&invocation.executable);
        command
            .args(&invocation.args)
            .current_dir(&cwd)
            .envs(&invocation.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .map_err(|error| AppRuntimeError::spawn(error.to_string()))?;
        attach_child_logs(&mut child, &log_path)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        let pid = child.id();
        let now = now_iso();
        let metadata = AppSession {
            id: id.clone(),
            app_id: app.id.clone(),
            title: options.title.clone().unwrap_or_else(|| app.name.clone()),
            kind: "web".to_string(),
            status: "running".to_string(),
            created_at: now.clone(),
            updated_at: now,
            workspace: WireAppSessionWorkspace {
                cwd: cwd.display().to_string(),
            },
            launch: Some(options.clone()),
            tty: None,
            display: None,
            vnc: None,
            web: Some(AppSessionWeb {
                host: "127.0.0.1".to_string(),
                port,
                web_path: format!("/api/apps/sessions/{id}/web/"),
                ready_path: app.web.as_ref().and_then(|web| web.ready_path.clone()),
            }),
            automation: None,
            process: Some(AppSessionProcess {
                pid,
                command: executable.display().to_string(),
                exit_code: None,
                signal: None,
            }),
            ai: None,
            paths: AppSessionPaths {
                session_dir: session_dir.display().to_string(),
                log_dir: log_dir.display().to_string(),
            },
            bindings: Vec::new(),
            extra: BTreeMap::new(),
        };
        let entry = Arc::new(SessionEntry::new(metadata.clone()));
        if let Some(pid) = pid {
            entry.add_process(pid);
        }
        self.inner
            .sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, entry.clone());
        self.persist(&metadata);
        self.emit(AppRuntimeChangeKind::Created, metadata.clone());
        self.start_child_monitor(entry, child, app.id);
        Ok(metadata)
    }

    async fn start_gui(
        &self,
        app: AppCatalogItem,
        executable: PathBuf,
        options: AppLaunchOptions,
    ) -> Result<AppSession, AppRuntimeError> {
        let cwd = resolve_launch_cwd(options.cwd.as_deref(), app.cwd.as_deref());
        if !cwd.is_dir() {
            return Err(AppRuntimeError::Invalid(format!(
                "App workspace is not a directory: {}",
                cwd.display()
            )));
        }
        let backend = VncBackend::from_environment();
        let app_command = app.command.clone().unwrap_or_else(|| app.id.clone());
        let required_commands: &[&str] = if backend == VncBackend::KasmVnc {
            &[
                "vncserver",
                "vncpasswd",
                "openssl",
                "xrdb",
                "xrandr",
                "openbox",
                app_command.as_str(),
            ]
        } else {
            &[
                "Xvfb",
                "openbox",
                "x11vnc",
                "websockify",
                app_command.as_str(),
            ]
        };
        for command in required_commands {
            if crate::catalog::resolve_executable(command, &BTreeMap::new(), None).is_none() {
                return Err(AppRuntimeError::missing_command(*command));
            }
        }
        let id = mint_entity_id("app");
        let session_dir = self.inner.storage_paths.app_sessions_dir.join(&id);
        let log_dir = self
            .inner
            .storage_paths
            .log_dir
            .join("app-sessions")
            .join(&id);
        std::fs::create_dir_all(&session_dir)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        std::fs::create_dir_all(&log_dir)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;

        let mut launch = options;
        let display_target = launch
            .display_target
            .clone()
            .or_else(|| normalize_display_target(app.default_display_target.clone()))
            .unwrap_or(AppDisplayTarget {
                mode: AppDisplayMode::Isolated,
                id: None,
                auto_create: None,
            });
        launch.display_target = Some(display_target.clone());
        launch.cwd = Some(cwd.display().to_string());
        let cdp_port = self.allocate_cdp_port()?;
        let args = self.gui_args(&app, &session_dir, cdp_port, &launch)?;
        let mut env = self.environment(&app, &launch, false)?;
        let width = launch
            .display
            .as_ref()
            .and_then(|display| display.width)
            .or_else(|| app.display.as_ref().and_then(|display| display.width))
            .unwrap_or(1440);
        let height = launch
            .display
            .as_ref()
            .and_then(|display| display.height)
            .or_else(|| app.display.as_ref().and_then(|display| display.height))
            .unwrap_or(900);
        let depth = launch
            .display
            .as_ref()
            .and_then(|display| display.depth)
            .or_else(|| app.display.as_ref().and_then(|display| display.depth))
            .unwrap_or(24);
        let automation = app
            .automation
            .as_ref()
            .map(|automation| AppSessionAutomation {
                kind: automation.kind.clone(),
                endpoint: format!(
                    "http://127.0.0.1:{cdp_port}{}",
                    automation.endpoint_path.clone().unwrap_or_default()
                ),
                port: cdp_port,
            });

        let mut isolated_vnc_port = None;
        let mut isolated_websockify_port = None;
        let (shared_display, isolated_display) = if display_target.mode == AppDisplayMode::Shared {
            let shared = self
                .ensure_shared_display(
                    &app,
                    &launch,
                    backend,
                    &cwd,
                    DisplayGeometry {
                        width,
                        height,
                        depth,
                    },
                )
                .await?;
            (Some(shared.clone()), Vec::<SpawnedGuiProcess>::new())
        } else {
            let display_number = self.allocate_display()?;
            let display = format!(":{display_number}");
            let vnc_port = if backend == VncBackend::KasmVnc {
                self.allocate_web_port()?
            } else {
                self.allocate_vnc_port()?
            };
            let websockify_port = (backend == VncBackend::NoVnc)
                .then(|| self.allocate_websockify_port())
                .transpose()?;
            isolated_vnc_port = Some(vnc_port);
            isolated_websockify_port = websockify_port;
            env.insert("DISPLAY".to_string(), display.clone());
            let display_processes = self
                .start_display_backend(DisplayBackendRequest {
                    app: &app,
                    backend,
                    display: &display,
                    cwd: &cwd,
                    session_dir: &session_dir,
                    log_dir: &log_dir,
                    geometry: DisplayGeometry {
                        width,
                        height,
                        depth,
                    },
                    vnc_port,
                    websockify_port,
                    env: &env,
                })
                .await?;
            let compositor = self
                .spawn_gui_process(
                    "picom",
                    &[
                        "--config".to_string(),
                        "/dev/null".to_string(),
                        "--backend".to_string(),
                        "xrender".to_string(),
                    ],
                    &cwd,
                    &env,
                    SpawnGuiProcessOptions {
                        log_path: &log_dir.join("picom.log"),
                        label: "picom",
                        critical: false,
                    },
                )
                .ok();
            let mut processes = display_processes;
            if let Some(compositor) = compositor {
                processes.push(compositor);
            }
            (None, processes)
        };

        let display_name = shared_display
            .as_ref()
            .map(|display| display.display.clone())
            .unwrap_or_else(|| {
                env.get("DISPLAY")
                    .cloned()
                    .unwrap_or_else(|| ":101".to_string())
            });
        env.insert("DISPLAY".to_string(), display_name.clone());
        if let Some(xauthority) = shared_display
            .as_ref()
            .and_then(|display| display.xauthority.as_ref())
        {
            env.insert("XAUTHORITY".to_string(), xauthority.clone());
        } else if backend == VncBackend::KasmVnc {
            env.insert(
                "XAUTHORITY".to_string(),
                session_dir.join("home/.Xauthority").display().to_string(),
            );
        }
        let app_env = self.gui_app_environment(&env, backend);
        let openbox = if shared_display.is_none() {
            match self.spawn_gui_process(
                "openbox",
                &[],
                &cwd,
                &app_env,
                SpawnGuiProcessOptions {
                    log_path: &log_dir.join("openbox.log"),
                    label: "openbox",
                    critical: true,
                },
            ) {
                Ok(process) => Some(process),
                Err(error) => {
                    let pids = isolated_display
                        .iter()
                        .map(|process| process.pid)
                        .collect::<Vec<_>>();
                    terminate_process_groups(&pids);
                    return Err(error);
                }
            }
        } else {
            None
        };
        let app_process = match self.spawn_gui_process(
            &executable.display().to_string(),
            &args,
            &cwd,
            &app_env,
            SpawnGuiProcessOptions {
                log_path: &log_dir.join(format!("{}.log", app.id)),
                label: &app.id,
                critical: true,
            },
        ) {
            Ok(process) => process,
            Err(error) => {
                if let Some(openbox) = &openbox {
                    terminate_process_groups(&[openbox.pid]);
                }
                let pids = isolated_display
                    .iter()
                    .map(|process| process.pid)
                    .collect::<Vec<_>>();
                terminate_process_groups(&pids);
                return Err(error);
            }
        };
        let (vnc_port, websockify_port, x_pid, wm_pid, compositor_pid, xauthority) =
            match &shared_display {
                Some(display) => (
                    display.vnc_port,
                    display.websockify_port,
                    display.x_pid,
                    display.wm_pid,
                    display.compositor_pid,
                    display.xauthority.clone(),
                ),
                None => (
                    isolated_vnc_port.unwrap_or_default(),
                    isolated_websockify_port,
                    isolated_display.first().map(|process| process.pid),
                    openbox.as_ref().map(|process| process.pid),
                    isolated_display
                        .iter()
                        .find(|process| process.label == "picom")
                        .map(|process| process.pid),
                    env.get("XAUTHORITY").cloned(),
                ),
            };
        let web_path = if backend == VncBackend::KasmVnc {
            format!("/api/apps/sessions/{id}/web/")
        } else {
            format!("/api/apps/sessions/{id}/vnc")
        };
        let no_vnc_path = if backend == VncBackend::KasmVnc {
            format!("/api/apps/sessions/{id}/web/")
        } else {
            format!("/api/apps/sessions/{id}/novnc/vnc.html")
        };
        let now = now_iso();
        let metadata = AppSession {
            id: id.clone(),
            app_id: app.id.clone(),
            title: launch.title.clone().unwrap_or_else(|| app.name.clone()),
            kind: "gui".to_string(),
            status: "running".to_string(),
            created_at: now.clone(),
            updated_at: now,
            workspace: WireAppSessionWorkspace {
                cwd: cwd.display().to_string(),
            },
            launch: Some(launch),
            tty: None,
            display: Some(AppSessionDisplay {
                display: display_name,
                mode: Some(if shared_display.is_some() {
                    "shared".to_string()
                } else {
                    "isolated".to_string()
                }),
                display_session_id: shared_display.as_ref().map(|display| display.id.clone()),
                width,
                height,
                depth,
                x_pid,
                wm_pid,
                compositor_pid,
                xauthority,
            }),
            vnc: Some(AppSessionVnc {
                backend: Some(backend.as_str().to_string()),
                host: "127.0.0.1".to_string(),
                port: vnc_port,
                websockify_port,
                web_path: web_path.clone(),
                no_vnc_path,
            }),
            web: (backend == VncBackend::KasmVnc).then_some(AppSessionWeb {
                host: "127.0.0.1".to_string(),
                port: vnc_port,
                web_path,
                ready_path: None,
            }),
            automation,
            process: Some(AppSessionProcess {
                pid: Some(app_process.pid),
                command: executable.display().to_string(),
                exit_code: None,
                signal: None,
            }),
            ai: None,
            paths: AppSessionPaths {
                session_dir: session_dir.display().to_string(),
                log_dir: log_dir.display().to_string(),
            },
            bindings: Vec::new(),
            extra: BTreeMap::new(),
        };
        let entry = Arc::new(SessionEntry::new(metadata.clone()));
        if let Some(openbox) = &openbox {
            entry.add_process(openbox.pid);
        }
        entry.add_process(app_process.pid);
        for process in &isolated_display {
            entry.add_process(process.pid);
        }
        self.inner
            .sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), entry.clone());
        if let Some(display) = &shared_display {
            if let Some(display) = self
                .inner
                .shared_displays
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get_mut(&display.id)
            {
                display.app_session_ids.insert(id.clone());
            }
        }
        self.persist(&metadata);
        self.emit(AppRuntimeChangeKind::Created, metadata.clone());

        if let Some(openbox) = openbox {
            self.start_auxiliary_process_monitor(entry.clone(), openbox);
        }
        for process in isolated_display {
            self.start_auxiliary_process_monitor(entry.clone(), process);
        }
        self.start_child_monitor(entry, app_process.child, app.id);
        Ok(metadata)
    }

    async fn start_display_backend(
        &self,
        request: DisplayBackendRequest<'_>,
    ) -> Result<Vec<SpawnedGuiProcess>, AppRuntimeError> {
        let DisplayBackendRequest {
            app,
            backend,
            display,
            cwd,
            session_dir,
            log_dir,
            geometry,
            vnc_port,
            websockify_port,
            env,
        } = request;
        let DisplayGeometry {
            width,
            height,
            depth,
        } = geometry;
        match backend {
            VncBackend::NoVnc => {
                let websockify_port = websockify_port.ok_or_else(|| {
                    AppRuntimeError::DisplayStartFailed(
                        "NoVNC websockify port was not allocated.".to_string(),
                    )
                })?;
                let result = (|| {
                    let xvfb = self.spawn_gui_process(
                        "Xvfb",
                        &[
                            display.to_string(),
                            "-screen".to_string(),
                            "0".to_string(),
                            format!("{width}x{height}x{depth}"),
                            "-nolisten".to_string(),
                            "tcp".to_string(),
                        ],
                        cwd,
                        env,
                        SpawnGuiProcessOptions {
                            log_path: &log_dir.join("xvfb.log"),
                            label: "display",
                            critical: true,
                        },
                    )?;
                    let x11vnc = match self.spawn_gui_process(
                        "x11vnc",
                        &[
                            "-display".to_string(),
                            display.to_string(),
                            "-localhost".to_string(),
                            "-forever".to_string(),
                            "-shared".to_string(),
                            "-nopw".to_string(),
                            "-xrandr".to_string(),
                            "resize".to_string(),
                            "-rfbport".to_string(),
                            vnc_port.to_string(),
                        ],
                        cwd,
                        env,
                        SpawnGuiProcessOptions {
                            log_path: &log_dir.join("x11vnc.log"),
                            label: "vnc",
                            critical: true,
                        },
                    ) {
                        Ok(process) => process,
                        Err(error) => {
                            terminate_process_groups(&[xvfb.pid]);
                            return Err(error);
                        }
                    };
                    let websockify = match self.spawn_gui_process(
                        "websockify",
                        &[websockify_port.to_string(), format!("127.0.0.1:{vnc_port}")],
                        cwd,
                        env,
                        SpawnGuiProcessOptions {
                            log_path: &log_dir.join("websockify.log"),
                            label: "websockify",
                            critical: true,
                        },
                    ) {
                        Ok(process) => process,
                        Err(error) => {
                            terminate_process_groups(&[xvfb.pid, x11vnc.pid]);
                            return Err(error);
                        }
                    };
                    Ok(vec![xvfb, x11vnc, websockify])
                })();
                let processes = result?;
                self.wait_for_x_display(display, std::time::Duration::from_secs(5))
                    .await
                    .map_err(|error| {
                        let pids = processes
                            .iter()
                            .map(|process| process.pid)
                            .collect::<Vec<_>>();
                        terminate_process_groups(&pids);
                        AppRuntimeError::DisplayStartFailed(format!(
                            "Display {display} failed to start: {error}"
                        ))
                    })?;
                let _ = app;
                let _ = session_dir;
                Ok(processes)
            }
            VncBackend::KasmVnc => {
                let scale = gui_scale_from_env(env);
                prepare_kasm_vnc_home(session_dir, width, height, depth, vnc_port, scale)?;
                let launcher = write_kasm_vnc_launcher(session_dir, display, width, height, depth)?;
                let mut kasm_env = env.clone();
                kasm_env.insert(
                    "HOME".to_string(),
                    session_dir.join("home").display().to_string(),
                );
                let kasm = self.spawn_gui_process(
                    "bash",
                    &[launcher.display().to_string()],
                    cwd,
                    &kasm_env,
                    SpawnGuiProcessOptions {
                        log_path: &log_dir.join("kasmvnc.log"),
                        label: "kasmvnc",
                        critical: true,
                    },
                )?;
                if let Err(error) = self
                    .wait_for_x_display(display, std::time::Duration::from_secs(5))
                    .await
                {
                    terminate_process_groups(&[kasm.pid]);
                    return Err(AppRuntimeError::DisplayStartFailed(format!(
                        "Display {display} failed to start: {error}"
                    )));
                }
                apply_gui_scale(&kasm_env, session_dir, scale);
                let _ = app;
                Ok(vec![kasm])
            }
        }
    }

    async fn ensure_shared_display(
        &self,
        app: &AppCatalogItem,
        launch: &AppLaunchOptions,
        backend: VncBackend,
        cwd: &Path,
        geometry: DisplayGeometry,
    ) -> Result<SharedDisplayRuntime, AppRuntimeError> {
        let DisplayGeometry {
            width,
            height,
            depth,
        } = geometry;
        let target = launch.display_target.as_ref();
        let id = target
            .and_then(|target| target.id.clone())
            .unwrap_or_else(|| "main".to_string());
        let _guard = self.inner.shared_display_mutation.lock().await;
        if let Some(existing) = self
            .inner
            .shared_displays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&id)
            .cloned()
        {
            return Ok(existing);
        }
        if target.and_then(|target| target.auto_create) == Some(false) {
            return Err(AppRuntimeError::DisplaySessionNotFound(format!(
                "Shared display session not found: {id}"
            )));
        }
        let safe_id = id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let session_dir = self
            .inner
            .storage_paths
            .app_sessions_dir
            .join(format!("display_{safe_id}"));
        let log_dir = self
            .inner
            .storage_paths
            .log_dir
            .join("app-sessions")
            .join(format!("display_{safe_id}"));
        std::fs::create_dir_all(&session_dir)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        std::fs::create_dir_all(&log_dir)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        let display_number = self.allocate_display()?;
        let display = format!(":{display_number}");
        let vnc_port = if backend == VncBackend::KasmVnc {
            self.allocate_web_port()?
        } else {
            self.allocate_vnc_port()?
        };
        let websockify_port = (backend == VncBackend::NoVnc)
            .then(|| self.allocate_websockify_port())
            .transpose()?;
        let mut env = self.environment(app, launch, false)?;
        env.insert("DISPLAY".to_string(), display.clone());
        let display_processes = self
            .start_display_backend(DisplayBackendRequest {
                app,
                backend,
                display: &display,
                cwd,
                session_dir: &session_dir,
                log_dir: &log_dir,
                geometry: DisplayGeometry {
                    width,
                    height,
                    depth,
                },
                vnc_port,
                websockify_port,
                env: &env,
            })
            .await?;
        let mut app_env = self.gui_app_environment(&env, backend);
        let xauthority =
            (backend == VncBackend::KasmVnc).then(|| session_dir.join("home").join(".Xauthority"));
        if let Some(xauthority) = xauthority.as_ref() {
            app_env.insert("XAUTHORITY".to_string(), xauthority.display().to_string());
        }
        let openbox = match self.spawn_gui_process(
            "openbox",
            &[],
            cwd,
            &app_env,
            SpawnGuiProcessOptions {
                log_path: &log_dir.join("openbox.log"),
                label: "openbox",
                critical: true,
            },
        ) {
            Ok(process) => process,
            Err(error) => {
                let pids = display_processes
                    .iter()
                    .map(|process| process.pid)
                    .collect::<Vec<_>>();
                terminate_process_groups(&pids);
                return Err(error);
            }
        };
        let compositor = self
            .spawn_gui_process(
                "picom",
                &[
                    "--config".to_string(),
                    "/dev/null".to_string(),
                    "--backend".to_string(),
                    "xrender".to_string(),
                ],
                cwd,
                &app_env,
                SpawnGuiProcessOptions {
                    log_path: &log_dir.join("picom.log"),
                    label: "picom",
                    critical: false,
                },
            )
            .ok();
        let processes = display_processes
            .iter()
            .map(|process| process.pid)
            .chain(std::iter::once(openbox.pid))
            .chain(compositor.as_ref().map(|process| process.pid))
            .collect::<Vec<_>>();
        let shared = SharedDisplayRuntime {
            id: id.clone(),
            display,
            vnc_port,
            websockify_port,
            x_pid: display_processes.first().map(|process| process.pid),
            wm_pid: Some(openbox.pid),
            compositor_pid: compositor.as_ref().map(|process| process.pid),
            xauthority: xauthority.as_ref().map(|path| path.display().to_string()),
            processes,
            app_session_ids: HashSet::new(),
        };
        self.inner
            .shared_displays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, shared.clone());
        for process in display_processes {
            self.start_shared_display_process_monitor(shared.id.clone(), process);
        }
        self.start_shared_display_process_monitor(shared.id.clone(), openbox);
        if let Some(compositor) = compositor {
            self.start_shared_display_process_monitor(shared.id.clone(), compositor);
        }
        Ok(shared)
    }

    fn spawn_gui_process(
        &self,
        command: &str,
        args: &[String],
        cwd: &Path,
        env: &BTreeMap<String, String>,
        options: SpawnGuiProcessOptions<'_>,
    ) -> Result<SpawnedGuiProcess, AppRuntimeError> {
        let SpawnGuiProcessOptions {
            log_path,
            label,
            critical,
        } = options;
        let executable = crate::catalog::resolve_executable(command, env, cwd.to_str())
            .ok_or_else(|| AppRuntimeError::missing_command(command))?;
        let invocation = invoke_command(&executable.display().to_string(), args, cwd, env)?;
        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        }
        let mut process = Command::new(&invocation.executable);
        process
            .args(&invocation.args)
            .current_dir(cwd)
            .envs(&invocation.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        unsafe {
            process.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = process.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppRuntimeError::missing_command(command)
            } else {
                AppRuntimeError::spawn(error.to_string())
            }
        })?;
        attach_child_logs(&mut child, log_path)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
        let pid = child
            .id()
            .ok_or_else(|| AppRuntimeError::spawn("GUI child has no pid"))?;
        Ok(SpawnedGuiProcess {
            child,
            pid,
            label: label.to_string(),
            critical,
        })
    }

    fn start_auxiliary_process_monitor(
        &self,
        entry: Arc<SessionEntry>,
        process: SpawnedGuiProcess,
    ) {
        let runtime = self.clone();
        let SpawnedGuiProcess {
            mut child,
            label,
            critical,
            ..
        } = process;
        tokio::spawn(async move {
            let exit = child.wait().await.ok();
            let code = exit.and_then(|status| status.code());
            let signal = exit.and_then(signal_name);
            if !critical || entry.stopping.load(Ordering::SeqCst) || code == Some(0) {
                return;
            }
            let metadata = {
                let mut metadata = entry
                    .metadata
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if metadata.status != "running" {
                    return;
                }
                metadata.status = "failed".to_string();
                metadata.updated_at = now_iso();
                metadata.extra.insert(
                    "error".to_string(),
                    json!({
                        "code": "APP_PROCESS_EXITED",
                        "message": format!(
                            "{label} exited unexpectedly with code {} signal {}.",
                            code.map(|code| code.to_string()).unwrap_or_else(|| "null".to_string()),
                            signal.unwrap_or_else(|| "null".to_string()),
                        ),
                    }),
                );
                metadata.clone()
            };
            runtime.persist(&metadata);
            runtime.emit(AppRuntimeChangeKind::Updated, metadata);
        });
    }

    fn start_shared_display_process_monitor(&self, display_id: String, process: SpawnedGuiProcess) {
        let runtime = self.clone();
        let SpawnedGuiProcess {
            mut child,
            label: _,
            critical,
            ..
        } = process;
        tokio::spawn(async move {
            let exit = child.wait().await.ok();
            let code = exit.and_then(|status| status.code());
            let signal = exit.and_then(signal_name);
            let code_text = code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "null".to_string());
            let signal_text = signal.unwrap_or_else(|| "null".to_string());
            if !critical || code == Some(0) {
                return;
            }
            let app_session_ids = {
                let mut displays = runtime
                    .inner
                    .shared_displays
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let Some(display) = displays.get(&display_id) else {
                    return;
                };
                if display.app_session_ids.is_empty() {
                    return;
                }
                let ids = display.app_session_ids.iter().cloned().collect::<Vec<_>>();
                displays.remove(&display_id);
                ids
            };
            for session_id in app_session_ids {
                if let Ok(metadata) = runtime.update_metadata(&session_id, |metadata| {
                    metadata.status = "failed".to_string();
                    metadata.updated_at = now_iso();
                    metadata.extra.insert(
                        "error".to_string(),
                        json!({
                            "code": "APP_DISPLAY_PROCESS_EXITED",
                            "message": format!(
                                "Shared display {display_id} exited unexpectedly with code {} signal {}.",
                                code_text,
                                signal_text,
                            ),
                        }),
                    );
                }) {
                    runtime.persist(&metadata);
                    runtime.emit(AppRuntimeChangeKind::Updated, metadata);
                }
            }
        });
    }

    async fn wait_for_x_display(
        &self,
        display: &str,
        timeout: std::time::Duration,
    ) -> Result<(), AppRuntimeError> {
        let display_number = display
            .trim_start_matches(':')
            .split('.')
            .next()
            .unwrap_or_default();
        let socket = PathBuf::from("/tmp/.X11-unix").join(format!("X{display_number}"));
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            if socket.exists() {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        Err(AppRuntimeError::DisplayStartFailed(format!(
            "Display {display} did not become ready within {}ms.",
            timeout.as_millis()
        )))
    }

    fn gui_args(
        &self,
        app: &AppCatalogItem,
        session_dir: &Path,
        cdp_port: u16,
        launch: &AppLaunchOptions,
    ) -> Result<Vec<String>, AppRuntimeError> {
        let render = |arg: &str| render_gui_argument(arg, session_dir, cdp_port);
        let mut args = app
            .args
            .as_deref()
            .unwrap_or_default()
            .iter()
            .chain(launch.args.iter())
            .map(|arg| render(arg))
            .collect::<Vec<_>>();
        let gui_runtime = managed_app_runtime_provider(app)
            .map(|provider| provider.gui_runtime)
            .unwrap_or(ManagedAppGuiRuntime::Default);
        if gui_runtime == ManagedAppGuiRuntime::Chromium {
            let user_data_dir = launch
                .profile_id
                .as_deref()
                .map(|profile_id| self.inner.profiles.resolve(profile_id))
                .transpose()?
                .map(|profile| profile.directory)
                .unwrap_or_else(|| session_dir.join("profile").display().to_string());
            let mut chromium_args = Vec::new();
            if env_flag("TASK_HANDOFF_CHROMIUM_NO_SANDBOX") {
                chromium_args.push("--no-sandbox".to_string());
            }
            chromium_args.extend([
                "--disable-dev-shm-usage".to_string(),
                "--no-first-run".to_string(),
            ]);
            let extensions = chromium_extension_dirs();
            if !extensions.is_empty() {
                chromium_args.push(format!(
                    "--load-extension={}",
                    extensions
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                ));
            }
            chromium_args.extend([
                "--remote-debugging-address=127.0.0.1".to_string(),
                format!("--user-data-dir={user_data_dir}"),
                app.automation
                    .as_ref()
                    .and_then(|automation| automation.port_arg.as_ref())
                    .map(|arg| arg.replace("{port}", &cdp_port.to_string()))
                    .unwrap_or_else(|| format!("--remote-debugging-port={cdp_port}")),
            ]);
            chromium_args.extend(args);
            args = chromium_args;
        } else if gui_runtime == ManagedAppGuiRuntime::TerminalGui {
            args.splice(
                0..0,
                [
                    "-fa".to_string(),
                    std::env::var("TASK_HANDOFF_XTERM_FONT_FAMILY")
                        .unwrap_or_else(|_| "Monospace".to_string()),
                    "-fs".to_string(),
                    std::env::var("TASK_HANDOFF_XTERM_FONT_SIZE")
                        .unwrap_or_else(|_| "11".to_string()),
                ],
            );
        } else if let Some(port_arg) = app
            .automation
            .as_ref()
            .and_then(|automation| automation.port_arg.as_ref())
        {
            args.insert(0, port_arg.replace("{port}", &cdp_port.to_string()));
        }
        Ok(args)
    }

    fn gui_app_environment(
        &self,
        env: &BTreeMap<String, String>,
        backend: VncBackend,
    ) -> BTreeMap<String, String> {
        let mut env = env.clone();
        if let Some(home) = std::env::var_os("TASK_HANDOFF_GUI_APP_HOME") {
            env.insert("HOME".to_string(), home.to_string_lossy().into_owned());
        } else if !env.contains_key("HOME") {
            if let Some(home) = std::env::var_os("HOME") {
                env.insert("HOME".to_string(), home.to_string_lossy().into_owned());
            }
        }
        if backend == VncBackend::KasmVnc {
            env.insert(
                "TASK_HANDOFF_GUI_SCALE".to_string(),
                format_gui_scale(gui_scale_from_env(&env)),
            );
            env.insert("XCURSOR_SIZE".to_string(), "24".to_string());
        }
        env
    }

    fn start_tty_reader(
        &self,
        entry: Arc<SessionEntry>,
        mut reader: std::fs::File,
        log_path: PathBuf,
    ) {
        let event_tx = entry.clients.clone();
        tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut buffer = [0u8; 8192];
            let mut pending = Vec::new();
            let log = RotatingLogWriter::open(log_path).ok();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let bytes = &buffer[..size];
                        if let Some(log) = log.as_ref() {
                            let _ = log.write(bytes);
                        }
                        let data = decode_utf8_stream(&mut pending, bytes);
                        if data.is_empty() {
                            continue;
                        }
                        entry.write_terminal(&data);
                        let _ = event_tx.send(TtyEvent::Output { data });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
    }

    fn start_child_monitor(&self, entry: Arc<SessionEntry>, mut child: Child, log_name: String) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut stop = entry.take_stop_receiver();
            let exit = tokio::select! {
                status = child.wait() => match status {
                    Ok(status) => (status.code(), signal_name(status), None),
                    Err(error) => {
                        debug!(app_id = %log_name, %error, "App process wait failed");
                        (None, None, Some(error.to_string()))
                    }
                },
                _ = async {
                    if let Some(receiver) = stop.as_mut() {
                        let _ = receiver.await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => {
                    match child.wait().await {
                        Ok(status) => (status.code(), signal_name(status), None),
                        Err(error) => {
                            debug!(app_id = %log_name, %error, "App process wait failed");
                            (None, None, Some(error.to_string()))
                        }
                    }
                }
            };
            let stopping = entry.stopping.load(Ordering::SeqCst);
            let paused = {
                let mut metadata = entry
                    .metadata
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if !stopping {
                    if let Some(error) = exit.2.as_deref() {
                        metadata.status = "failed".to_string();
                        metadata.extra.insert(
                            "error".to_string(),
                            json!({
                                "code": "APP_PROCESS_ERROR",
                                "message": format!("{log_name} failed: {error}"),
                            }),
                        );
                    } else {
                        metadata.status = if metadata.tty.is_some() || exit.0 == Some(0) {
                            "exited"
                        } else {
                            "failed"
                        }
                        .to_string();
                    }
                    metadata.updated_at = now_iso();
                    if let Some(process) = metadata.process.as_mut() {
                        process.exit_code = Some(exit.0);
                        process.signal = Some(exit.1.clone());
                    }
                    if exit.2.is_none() && metadata.tty.is_none() && exit.0 != Some(0) {
                        metadata.extra.insert(
                            "error".to_string(),
                            json!({
                                "code": "APP_PROCESS_EXITED",
                                "message": format!(
                                    "{log_name} exited with code {} signal {}.",
                                    exit.0
                                        .map(|code| code.to_string())
                                        .unwrap_or_else(|| "null".to_string()),
                                    exit.1
                                        .as_deref()
                                        .unwrap_or("null"),
                                ),
                            }),
                        );
                    }
                }
                metadata.clone()
            };
            entry.clear_pty();
            entry.notify_exit(exit.0, exit.1.clone());
            if !stopping {
                runtime.persist(&paused);
                let has_tty = paused.tty.is_some();
                runtime.emit(AppRuntimeChangeKind::Updated, paused);
                // Node only reaps the PTY process group when its root exits;
                // GUI helper processes (Xvfb/openbox/VNC) stay until the
                // session is explicitly stopped or restarted.
                if has_tty {
                    let pids = entry.all_process_pids();
                    terminate_process_groups(&pids);
                }
            }
            if let Some(consumer) = entry.take_opencode_consumer() {
                runtime.release_shared_opencode(&consumer);
            }
            if let Some(lifecycle) = entry.take_codex_lifecycle() {
                lifecycle.proxy.stop();
                runtime.release_shared_codex(&lifecycle.consumer_id);
            }
            if let Some(display_id) = entry
                .metadata
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .display
                .as_ref()
                .and_then(|display| display.display_session_id.clone())
            {
                runtime.release_shared_display(&display_id, &entry.session_id());
            }
        });
    }

    pub async fn stop_session(&self, id: &str) -> Option<AppSession> {
        let entry = self
            .inner
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned();
        let Some(entry) = entry else {
            return self
                .inner
                .persisted_sessions
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(id)
                .cloned();
        };
        let stopping = {
            let mut metadata = entry
                .metadata
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            metadata.status = "stopping".to_string();
            metadata.updated_at = now_iso();
            metadata.clone()
        };
        self.persist(&stopping);
        entry.notify_stop_exit();
        entry.stop();
        entry.clear_terminal();
        let lifecycle_entry = entry.clone();
        tokio::spawn(async move {
            lifecycle_entry.stop_claude_daemon().await;
        });
        if let Some(consumer) = entry.take_opencode_consumer() {
            self.release_shared_opencode(&consumer);
        }
        if let Some(lifecycle) = entry.take_codex_lifecycle() {
            lifecycle.proxy.stop();
            self.release_shared_codex(&lifecycle.consumer_id);
        }
        let metadata = self
            .update_metadata(id, |metadata| {
                metadata.status = "stopped".to_string();
                metadata.updated_at = now_iso();
            })
            .ok()?;
        self.persist(&metadata);
        self.emit(AppRuntimeChangeKind::Updated, metadata.clone());
        if let Some(display_id) = metadata
            .display
            .as_ref()
            .and_then(|display| display.display_session_id.clone())
        {
            self.release_shared_display(&display_id, id);
        }
        self.inner
            .sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
        Some(metadata)
    }

    pub async fn restart(&self, id: &str) -> Result<AppSession, AppRuntimeError> {
        if self.is_draining() {
            return Err(AppRuntimeError::Draining(
                "App launches are unavailable while the controlled instance is draining for a runtime update."
                    .to_string(),
            ));
        }
        let session = self.get_session(id).ok_or_else(|| {
            AppRuntimeError::SessionNotFound("App session not found.".to_string())
        })?;
        self.stop_session(id).await;
        let launch = AppLaunchOptions {
            title: Some(session.title.clone()),
            ..session.launch.unwrap_or_default()
        };
        self.start(&session.app_id, launch).await
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<AppSession, AppRuntimeError> {
        if self.get_session(id).is_none() {
            return Err(AppRuntimeError::SessionNotFound(
                "App session not found.".to_string(),
            ));
        }
        let title = title.trim();
        if title.is_empty() || controlled_instance_core::text::utf16_len(title) > 120 {
            return Err(AppRuntimeError::SessionTitleInvalid(
                "App session title must contain between 1 and 120 characters.".to_string(),
            ));
        }
        let metadata = self.update_metadata(id, |metadata| {
            metadata.title = title.to_string();
            let launch = metadata.launch.take().unwrap_or_default();
            metadata.launch = Some(AppLaunchOptions {
                title: Some(title.to_string()),
                ..launch
            });
            metadata.updated_at = now_iso();
        })?;
        self.persist(&metadata);
        self.emit(AppRuntimeChangeKind::Updated, metadata.clone());
        Ok(metadata)
    }

    pub async fn delete(&self, id: &str) -> Result<AppSession, AppRuntimeError> {
        let Some(metadata) = self.get_session(id) else {
            return Err(AppRuntimeError::SessionNotFound(
                "App session not found.".to_string(),
            ));
        };
        let entry = self
            .inner
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned();
        if let Some(entry) = entry.as_ref() {
            // Node waits for process-tree escalation before committing the
            // stopped/removed session state, so a failed delete remains
            // retryable instead of leaving an already-stopped ghost.
            entry.notify_stop_exit();
            entry.stop();
            let remaining = entry.wait_for_stop_escalation().await;
            if !remaining.is_empty() {
                return Err(AppRuntimeError::ProcessStopTimeout(format!(
                    "App session process trees did not exit: {}.",
                    remaining
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
        }
        let metadata = self.stop_session(id).await.unwrap_or(metadata);
        let _removed = self
            .inner
            .sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
        let _removed = self
            .inner
            .persisted_sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
        let _ = std::fs::remove_dir_all(self.inner.storage_paths.app_sessions_dir.join(id));
        let _ = std::fs::remove_dir_all(
            self.inner
                .storage_paths
                .log_dir
                .join("app-sessions")
                .join(id),
        );
        self.emit(AppRuntimeChangeKind::Deleted, metadata.clone());
        Ok(metadata)
    }

    pub fn read_logs(&self, id: &str, max_bytes: f64) -> Result<Value, AppRuntimeError> {
        let session = self.get_session(id).ok_or_else(|| {
            AppRuntimeError::SessionNotFound("App session not found.".to_string())
        })?;
        let log_dir = PathBuf::from(&session.paths.log_dir);
        let max_bytes = max_bytes.clamp(1024.0, (512 * 1024) as f64);
        let entries = match std::fs::read_dir(&log_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({
                    "sessionId": id,
                    "logDir": session.paths.log_dir,
                    "maxBytes": max_bytes,
                    "files": [],
                }));
            }
            Err(error) => {
                return Err(AppRuntimeError::LogsFailed(error.to_string()));
            }
        };
        let mut paths = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| AppRuntimeError::LogsFailed(error.to_string()))?;
            let file_type = entry
                .file_type()
                .map_err(|error| AppRuntimeError::LogsFailed(error.to_string()))?;
            if file_type.is_file() && entry.path().extension().is_some_and(|value| value == "log") {
                paths.push(entry.path());
            }
        }
        paths.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
        let mut files = Vec::new();
        for path in paths {
            let metadata = std::fs::metadata(&path)
                .map_err(|error| AppRuntimeError::LogsFailed(error.to_string()))?;
            let size = metadata.len();
            let remaining = (size as f64 - max_bytes).max(0.0);
            if remaining.fract() != 0.0 {
                return Err(AppRuntimeError::LogsFailed(format!(
                    "The argument 'size' is invalid. Received {remaining}"
                )));
            }
            let start = remaining as u64;
            let content = read_tail(&path, start)
                .map_err(|error| AppRuntimeError::LogsFailed(error.to_string()))?;
            let updated_at = metadata
                .modified()
                .map(|value| {
                    chrono::DateTime::<Utc>::from(value)
                        .to_rfc3339_opts(SecondsFormat::Millis, true)
                })
                .map_err(|error| AppRuntimeError::LogsFailed(error.to_string()))?;
            files.push(json!({
                "name": path.file_name().and_then(|value| value.to_str()).unwrap_or("log"),
                "size": size,
                "updatedAt": updated_at,
                "truncated": start > 0,
                "content": content,
            }));
        }
        Ok(json!({
            "sessionId": id,
            "logDir": session.paths.log_dir,
            "maxBytes": max_bytes,
            "files": files,
        }))
    }

    pub fn tty_attachment(&self, id: &str) -> Option<TtyAttachment> {
        let entry = self
            .inner
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()?;
        let session = entry
            .metadata
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if session.status != "running" {
            return None;
        }
        let dimensions = *entry
            .dimensions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Some(TtyAttachment {
            session,
            dimensions,
            events: Some(entry.clients.subscribe()),
            client_id: TTY_ATTACHMENT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            entry,
        })
    }

    pub fn web_target(&self, id: &str) -> Option<(String, u16)> {
        let session = self.live_session(id)?;
        if session.status != "running" {
            return None;
        }
        session.web.map(|web| (web.host, web.port))
    }

    pub fn vnc_target(&self, id: &str) -> Option<(String, u16)> {
        self.live_session(id)
            .and_then(|session| session.vnc.map(|vnc| (vnc.host, vnc.port)))
    }

    pub async fn screenshot(&self, id: &str) -> Result<Vec<u8>, AppRuntimeError> {
        let session = self.live_session(id).ok_or_else(|| {
            AppRuntimeError::SessionNotFound("App session not found.".to_string())
        })?;
        let display = session.display.as_ref().ok_or_else(|| {
            AppRuntimeError::ScreenshotUnavailable(
                "Screenshots are only available for GUI sessions.".to_string(),
            )
        })?;
        let mut env = std::env::vars().collect::<BTreeMap<_, _>>();
        env.insert("DISPLAY".to_string(), display.display.clone());
        if let Some(xauthority) = &display.xauthority {
            env.insert("XAUTHORITY".to_string(), xauthority.clone());
            if let Some(parent) = Path::new(xauthority).parent() {
                env.insert("HOME".to_string(), parent.display().to_string());
            }
        }
        let executable =
            crate::catalog::resolve_executable("import", &env, None).ok_or_else(|| {
                AppRuntimeError::MissingCommand(
                    "Missing required command: import. Install ImageMagick in the runtime image."
                        .to_string(),
                )
            })?;
        let output = Command::new(executable)
            .args(["-window", "root", "png:-"])
            .envs(&env)
            .output()
            .await
            .map_err(|error| {
                AppRuntimeError::ScreenshotFailed(format!("Screenshot failed: {error}"))
            })?;
        if output.stdout.len() > SCREENSHOT_MAX_BYTES {
            return Err(AppRuntimeError::ScreenshotFailed(
                "Screenshot failed: stdout maxBuffer length exceeded".to_string(),
            ));
        }
        if !output.status.success() {
            return Err(AppRuntimeError::ScreenshotFailed(format!(
                "Screenshot failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(output.stdout)
    }

    pub async fn resize_display(
        &self,
        id: &str,
        display: AppDisplayOptions,
    ) -> Result<AppSession, AppRuntimeError> {
        let session = self.live_session(id).ok_or_else(|| {
            AppRuntimeError::DisplayNotFound("Display session not found.".to_string())
        })?;
        let current = session.display.clone().ok_or_else(|| {
            AppRuntimeError::DisplayNotFound("Display session not found.".to_string())
        })?;
        // Node normalizes each requested field independently and falls back to
        // the current value for out-of-range dimensions instead of rejecting
        // the whole resize.
        let width = display
            .width
            .filter(|width| (320..=7680).contains(width))
            .unwrap_or(current.width);
        let height = display
            .height
            .filter(|height| (240..=4320).contains(height))
            .unwrap_or(current.height);
        let depth = display
            .depth
            .filter(|depth| (8..=32).contains(depth))
            .unwrap_or(current.depth);
        let mut env = std::env::vars().collect::<BTreeMap<_, _>>();
        env.insert("DISPLAY".to_string(), current.display.clone());
        if let Some(xauthority) = &current.xauthority {
            env.insert("XAUTHORITY".to_string(), xauthority.clone());
            if let Some(parent) = Path::new(xauthority).parent() {
                env.insert("HOME".to_string(), parent.display().to_string());
            }
        }
        let env_for_resize = env.clone();
        tokio::task::spawn_blocking(move || {
            resize_display_with_xrandr(&env_for_resize, width, height)
        })
        .await
        .map_err(|error| AppRuntimeError::DisplayResizeFailed(error.to_string()))?
        .map_err(|error| {
            AppRuntimeError::DisplayResizeFailed(format!("Display resize failed: {error}"))
        })?;
        let metadata = self.update_metadata(id, |metadata| {
            if let Some(display) = metadata.display.as_mut() {
                display.width = width;
                display.height = height;
                display.depth = depth;
            }
            metadata.updated_at = now_iso();
        })?;
        self.persist(&metadata);
        self.emit(AppRuntimeChangeKind::Updated, metadata.clone());
        Ok(metadata)
    }

    pub async fn automation_status(&self, id: &str) -> Result<Value, AppRuntimeError> {
        let session = self.get_session(id).ok_or_else(|| {
            AppRuntimeError::SessionNotFound("App session not found.".to_string())
        })?;
        let automation = session.automation.as_ref().ok_or_else(|| {
            AppRuntimeError::AutomationUnavailable(
                "Automation is not configured for this app session.".to_string(),
            )
        })?;
        let mut status = json!({
            "sessionId": id,
            "type": automation.kind,
            "endpoint": automation.endpoint,
            "port": automation.port,
            "ready": false,
        });
        if session.status != "running" {
            status["error"] = json!({
                "code": "APP_AUTOMATION_NOT_RUNNING",
                "message": "Automation endpoint is only available while the app session is running.",
            });
            return Ok(status);
        }
        let endpoint = format!("{}/json/version", automation.endpoint.trim_end_matches('/'));
        match reqwest::Client::new()
            .get(&endpoint)
            .timeout(std::time::Duration::from_secs(1))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                match response.json::<Value>().await {
                    Ok(value) => {
                        status["ready"] = json!(true);
                        for (wire, source) in [
                            ("browser", "Browser"),
                            ("protocolVersion", "Protocol-Version"),
                            ("webSocketDebuggerUrl", "webSocketDebuggerUrl"),
                        ] {
                            if let Some(value) = value.get(source).and_then(Value::as_str) {
                                status[wire] = json!(value);
                            }
                        }
                        Ok(status)
                    }
                    Err(error) => {
                        status["error"] = json!({
                            "code": "APP_AUTOMATION_NOT_READY",
                            "message": error.to_string(),
                        });
                        Ok(status)
                    }
                }
            }
            Ok(response) => {
                status["error"] = json!({
                    "code": "APP_AUTOMATION_NOT_READY",
                    "message": format!("CDP version endpoint returned HTTP {}.", response.status()),
                });
                Ok(status)
            }
            Err(error) => {
                status["error"] = json!({
                    "code": "APP_AUTOMATION_NOT_READY",
                    "message": error.to_string(),
                });
                Ok(status)
            }
        }
    }

    pub async fn stop_all(&self) {
        let entries = self
            .inner
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for entry in &entries {
            let metadata = {
                let mut metadata = entry
                    .metadata
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                metadata.status = "stopped".to_string();
                metadata.updated_at = now_iso();
                metadata.clone()
            };
            self.persist(&metadata);
            entry.stop();
            entry.clear_terminal();
            let lifecycle_entry = entry.clone();
            tokio::spawn(async move {
                lifecycle_entry.stop_claude_daemon().await;
            });
            if let Some(consumer) = entry.take_opencode_consumer() {
                self.release_shared_opencode(&consumer);
            }
            if let Some(lifecycle) = entry.take_codex_lifecycle() {
                lifecycle.proxy.stop();
                self.release_shared_codex(&lifecycle.consumer_id);
            }
            if let Some(display_id) = metadata
                .display
                .as_ref()
                .and_then(|display| display.display_session_id.clone())
            {
                self.release_shared_display(&display_id, &metadata.id);
            }
        }
        self.stop_shared_opencode();
        self.stop_shared_codex();
        self.inner
            .sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        for entry in &entries {
            let _ = entry.wait_for_stop_escalation().await;
        }
    }

    fn release_shared_display(&self, display_id: &str, session_id: &str) {
        let pids = {
            let mut displays = self
                .inner
                .shared_displays
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(display) = displays.get_mut(display_id) else {
                return;
            };
            display.app_session_ids.remove(session_id);
            if !display.app_session_ids.is_empty() {
                return;
            }
            displays
                .remove(display_id)
                .map(|display| display.processes)
                .unwrap_or_default()
        };
        terminate_process_groups(&pids);
    }

    fn environment(
        &self,
        app: &AppCatalogItem,
        options: &AppLaunchOptions,
        terminal: bool,
    ) -> Result<BTreeMap<String, String>, AppRuntimeError> {
        let managed = self
            .inner
            .managed_environment
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let unset = self
            .inner
            .managed_environment_unset
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let env = merge_app_environment(
            std::env::vars().collect(),
            app.env.as_ref(),
            &options.env,
            &managed,
            &unset,
            terminal,
        );
        self.process_environment(&env)
    }

    fn allocate_web_port(&self) -> Result<u16, AppRuntimeError> {
        self.allocate_port(&self.inner.next_web_port, 8101, 8199)
    }

    fn allocate_display(&self) -> Result<u32, AppRuntimeError> {
        let mut used = BTreeSet::new();
        for entry in self
            .inner
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
        {
            let metadata = entry
                .metadata
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(number) = metadata
                .display
                .as_ref()
                .and_then(|display| parse_display_number(&display.display))
            {
                used.insert(number);
            }
        }
        for display in self
            .inner
            .shared_displays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
        {
            if let Some(number) = parse_display_number(&display.display) {
                used.insert(number);
            }
        }
        let mut next = self
            .inner
            .next_display
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let initial = (*next).clamp(DISPLAY_START, DISPLAY_END);
        let total = DISPLAY_END - DISPLAY_START + 1;
        for offset in 0..total {
            let candidate = DISPLAY_START + ((initial - DISPLAY_START + offset) % total);
            if !used.contains(&candidate)
                && !Path::new(&format!("/tmp/.X{candidate}-lock")).exists()
                && !Path::new(&format!("/tmp/.X11-unix/X{candidate}")).exists()
            {
                *next = if candidate >= DISPLAY_END {
                    DISPLAY_START
                } else {
                    candidate + 1
                };
                return Ok(candidate);
            }
        }
        Err(AppRuntimeError::ResourceExhausted(format!(
            "No available allocation in range {DISPLAY_START}-{DISPLAY_END}."
        )))
    }

    fn allocate_vnc_port(&self) -> Result<u16, AppRuntimeError> {
        self.allocate_port(&self.inner.next_vnc_port, 6101, 6199)
    }

    fn allocate_websockify_port(&self) -> Result<u16, AppRuntimeError> {
        self.allocate_port(&self.inner.next_websockify_port, 7101, 7199)
    }

    fn allocate_cdp_port(&self) -> Result<u16, AppRuntimeError> {
        self.allocate_port(&self.inner.next_cdp_port, 9201, 9299)
    }

    fn allocate_port(
        &self,
        next: &Mutex<u16>,
        start: u16,
        end: u16,
    ) -> Result<u16, AppRuntimeError> {
        let used = self.used_ports();
        allocate_available_port(next, start, end, &used, is_port_available)
    }

    fn used_ports(&self) -> BTreeSet<u16> {
        let sessions = self
            .inner
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut used = BTreeSet::new();
        for entry in sessions {
            let session = entry
                .metadata
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(vnc) = &session.vnc {
                used.insert(vnc.port);
                used.extend(vnc.websockify_port);
            }
            used.extend(session.web.as_ref().map(|web| web.port));
            used.extend(
                session
                    .automation
                    .as_ref()
                    .map(|automation| automation.port),
            );
            used.extend(
                session
                    .ai
                    .as_ref()
                    .and_then(|ai| ai.get("appServer"))
                    .and_then(|app_server| app_server.get("proxyPort"))
                    .and_then(Value::as_u64)
                    .and_then(|port| u16::try_from(port).ok()),
            );
        }
        for display in self
            .inner
            .shared_displays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
        {
            used.insert(display.vnc_port);
            used.extend(display.websockify_port);
        }
        used
    }

    fn update_metadata(
        &self,
        id: &str,
        update: impl FnOnce(&mut AppSession),
    ) -> Result<AppSession, AppRuntimeError> {
        let entry = self
            .inner
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned();
        if let Some(entry) = entry {
            let metadata = {
                let mut metadata = entry
                    .metadata
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                update(&mut metadata);
                metadata.clone()
            };
            return Ok(metadata);
        }
        let mut sessions = self
            .inner
            .persisted_sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let metadata = sessions.get_mut(id).ok_or_else(|| {
            AppRuntimeError::SessionNotFound("App session not found.".to_string())
        })?;
        update(metadata);
        Ok(metadata.clone())
    }

    fn persist(&self, session: &AppSession) {
        self.inner
            .persisted_sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session.id.clone(), session.clone());
        if !env_flag("TASK_HANDOFF_APP_SESSION_PERSIST") {
            return;
        }
        self.write_persisted_session_metadata(session);
    }

    fn write_persisted_session_metadata(&self, session: &AppSession) {
        let session_dir = PathBuf::from(&session.paths.session_dir);
        if let Err(error) = std::fs::create_dir_all(&session_dir) {
            warn!(app_session_id = %session.id, %error, "failed to create App session directory");
            return;
        }
        let path = session_dir.join("metadata.json");
        if let Err(error) = write_json_atomic(&path, session, Some(0o600)) {
            warn!(app_session_id = %session.id, %error, "failed to persist App session metadata");
        }
    }

    fn load_persisted_sessions(&self) {
        let Ok(entries) = std::fs::read_dir(&self.inner.storage_paths.app_sessions_dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            if !entry
                .file_type()
                .map(|value| value.is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            let Some(expected_id) = entry.file_name().to_str().map(ToString::to_string) else {
                continue;
            };
            let path = entry.path().join("metadata.json");
            let Ok(metadata) = read_json::<Value>(&path) else {
                continue;
            };
            let Some(session) = self.sanitize_persisted_session(metadata, &expected_id) else {
                continue;
            };
            let session = self.recover_persisted_session(session);
            self.write_persisted_session_metadata(&session);
            self.inner
                .persisted_sessions
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(session.id.clone(), session);
        }
    }

    fn sanitize_persisted_session(&self, metadata: Value, expected_id: &str) -> Option<AppSession> {
        let record = metadata.as_object()?.clone();
        let string_field = |name: &str| record.get(name).and_then(Value::as_str);
        if string_field("id") != Some(expected_id)
            || string_field("appId").is_none()
            || string_field("title").is_none()
            || string_field("createdAt").is_none()
            || string_field("updatedAt").is_none()
            || !matches!(string_field("kind"), Some("tty" | "gui" | "web"))
            || !matches!(
                string_field("status"),
                Some("created" | "running" | "stopping" | "stopped" | "exited" | "failed")
            )
        {
            return None;
        }
        let paths = record.get("paths")?.as_object()?;
        if !paths.get("sessionDir").is_some_and(Value::is_string)
            || !paths.get("logDir").is_some_and(Value::is_string)
        {
            return None;
        }
        let process_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let workspace_env = std::env::var("TASK_HANDOFF_WORKSPACE").ok();
        let claude_cwd = record
            .get("ai")
            .and_then(|ai| ai.get("claude"))
            .and_then(|claude| claude.get("cwd"))
            .and_then(Value::as_str);
        let app_cwd = self
            .inner
            .catalog
            .find(string_field("appId")?)
            .and_then(|entry| entry.app.cwd);
        let candidate = [
            record
                .get("workspace")
                .and_then(|workspace| workspace.get("cwd"))
                .and_then(Value::as_str),
            record
                .get("tty")
                .and_then(|tty| tty.get("cwd"))
                .and_then(Value::as_str),
            claude_cwd,
            record
                .get("launch")
                .and_then(|launch| launch.get("cwd"))
                .and_then(Value::as_str),
            app_cwd.as_deref(),
            workspace_env.as_deref(),
            process_cwd.to_str(),
        ]
        .into_iter()
        .flatten()
        .find(|candidate| !candidate.trim().is_empty());
        let cwd = candidate
            .map(Path::new)
            .map(|candidate| resolve_path_from(candidate, &process_cwd))
            .unwrap_or_else(|| resolve_path_from(&process_cwd, &process_cwd));

        let mut record = record;
        record.insert("workspace".to_string(), json!({ "cwd": cwd }));
        record.insert(
            "paths".to_string(),
            json!({
                "sessionDir": self.inner.storage_paths.app_sessions_dir.join(expected_id),
                "logDir": self.inner.storage_paths.log_dir.join("app-sessions").join(expected_id),
            }),
        );
        sanitize_persisted_optional_fields(&mut record);
        serde_json::from_value::<AppSession>(Value::Object(record))
            .ok()
            .map(controlled_instance_protocol::normalize_app_session)
    }

    fn recover_persisted_session(&self, mut session: AppSession) -> AppSession {
        if !matches!(session.status.as_str(), "running" | "stopping") {
            return session;
        }
        session.status = "exited".to_string();
        session.updated_at = now_iso();
        session.extra.entry("error".to_string()).or_insert_with(|| {
            json!({
                "code": "APP_SESSION_RESTORED_WITHOUT_PROCESS",
                "message": "Runtime restarted; previous app processes are not attached. Use restart to launch a new session.",
            })
        });
        if let Some(process) = session.process.as_mut() {
            process.exit_code = Some(process.exit_code.flatten());
            process.signal = Some(process.signal.clone().flatten());
        }
        session
    }

    fn start_maintenance_timer(&self) {
        let weak = Arc::downgrade(&self.inner);
        let _ = std::thread::Builder::new()
            .name("app-runtime-maintenance".to_string())
            .spawn(move || loop {
                std::thread::sleep(MAINTENANCE_INTERVAL);
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                let runtime = AppRuntime { inner };
                runtime.safe_run_persistence_maintenance();
            });
    }

    fn safe_run_persistence_maintenance(&self) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.run_persistence_maintenance_at(Utc::now(), session_retention_days())
        }));
        if result.is_err() {
            warn!("App persistence maintenance failed");
        }
    }

    fn run_persistence_maintenance_at(
        &self,
        now: DateTime<Utc>,
        retention_days: f64,
    ) -> (Vec<AppSession>, Vec<PathBuf>) {
        let deleted_sessions = self.cleanup_expired_sessions_at(now, retention_days);
        let active_log_directories = self.active_log_directories();
        let deleted_logs = enforce_instance_log_budget(
            &self.inner.storage_paths.log_dir.join("app-sessions"),
            active_log_directories,
            DEFAULT_APP_SESSION_LOG_BUDGET_BYTES,
        );
        (deleted_sessions, deleted_logs)
    }

    fn cleanup_expired_sessions_at(
        &self,
        now: DateTime<Utc>,
        retention_days: f64,
    ) -> Vec<AppSession> {
        let cutoff = now.timestamp_millis() as f64 - retention_days * 24.0 * 60.0 * 60.0 * 1000.0;
        let live_ids = self
            .inner
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        let expired = self
            .inner
            .persisted_sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .filter(|session| {
                !live_ids.contains(&session.id)
                    && CLEANABLE_SESSION_STATUSES.contains(&session.status.as_str())
                    && session_timestamp(session).is_some_and(|timestamp| timestamp <= cutoff)
            })
            .cloned()
            .collect::<Vec<_>>();
        if expired.is_empty() {
            return expired;
        }
        let expired_ids = expired
            .iter()
            .map(|session| session.id.clone())
            .collect::<BTreeSet<_>>();
        self.inner
            .persisted_sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|id, _| !expired_ids.contains(id));
        for session in &expired {
            self.remove_session_files(&session.id);
        }
        expired
    }

    fn active_log_directories(&self) -> Vec<PathBuf> {
        let entries = self
            .inner
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        entries
            .into_iter()
            .map(|entry| {
                entry
                    .metadata
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .paths
                    .log_dir
                    .clone()
            })
            .map(PathBuf::from)
            .collect()
    }

    fn remove_session_files(&self, id: &str) {
        let _ = std::fs::remove_dir_all(self.inner.storage_paths.app_sessions_dir.join(id));
        let _ = std::fs::remove_dir_all(
            self.inner
                .storage_paths
                .log_dir
                .join("app-sessions")
                .join(id),
        );
    }

    fn emit(&self, kind: AppRuntimeChangeKind, session: AppSession) {
        let _ = self.inner.changes.send(AppRuntimeChange { kind, session });
    }
}

struct PreparedClaudeLaunch {
    args: Vec<String>,
    env: BTreeMap<String, String>,
    tty_mode: String,
    ai: Value,
    short: String,
    control_socket: PathBuf,
}

struct CapturedCommand {
    status: Option<i32>,
    output: String,
    timed_out: bool,
}

fn prepare_claude_tty_launch(
    command: &str,
    launch_args: &[String],
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    app_session_id: &str,
) -> Result<Option<PreparedClaudeLaunch>, AppRuntimeError> {
    if env_flag("TASK_HANDOFF_CLAUDE_BG_DISABLED") {
        return Ok(None);
    }
    let mut args = vec!["--bg".to_string()];
    args.extend(launch_args.iter().cloned());
    let timeout = claude_background_timeout();
    let result = capture_command(command, &args, cwd, environment, timeout)?;
    if result.timed_out {
        return Err(AppRuntimeError::spawn(format!(
            "Claude background launch timed out after {}ms.",
            timeout.as_millis()
        )));
    }
    if result.status != Some(0) {
        return Err(AppRuntimeError::spawn(format!(
            "Claude background launch exited with code {}: {}",
            result
                .status
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            result.output.trim()
        )));
    }
    let short = claude_short_from_output(&result.output).ok_or_else(|| {
        AppRuntimeError::spawn("Claude background launch did not report a worker id.")
    })?;
    let control_sock = controlled_instance_core::claude::control_socket_path(environment);
    let mut extra_environment = BTreeMap::new();
    extra_environment.insert(
        "TASK_HANDOFF_APP_SESSION_ID".to_string(),
        app_session_id.to_string(),
    );
    extra_environment.insert("TASK_HANDOFF_CLAUDE_SHORT".to_string(), short.clone());
    extra_environment.insert(
        "TASK_HANDOFF_CLAUDE_CONTROL_SOCK".to_string(),
        control_sock.display().to_string(),
    );
    Ok(Some(PreparedClaudeLaunch {
        args: vec!["attach".to_string(), short.clone()],
        env: extra_environment,
        tty_mode: "claude-attach".to_string(),
        ai: json!({
            "agent": "claude",
            "claude": {
                "short": short,
                "controlSock": control_sock.display().to_string(),
                "cwd": cwd.display().to_string(),
            }
        }),
        short,
        control_socket: control_sock,
    }))
}

fn claude_short_from_output(output: &str) -> Option<String> {
    let labeled = regex::Regex::new(r"(?i)\b(?:short|id|worker|session)\D+([a-f0-9]{8})\b")
        .expect("static Claude worker regex");
    if let Some(captures) = labeled.captures(output) {
        return captures.get(1).map(|value| value.as_str().to_string());
    }
    regex::Regex::new(r"(?i)\b([a-f0-9]{8})\b")
        .expect("static Claude short regex")
        .captures(output)
        .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()))
}

fn stop_claude_background(
    command: &str,
    short: &str,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
) {
    let _ = capture_command(
        command,
        &["stop".to_string(), short.to_string()],
        cwd,
        environment,
        claude_background_timeout(),
    );
}

fn capture_command(
    command: &str,
    args: &[String],
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    timeout: std::time::Duration,
) -> Result<CapturedCommand, AppRuntimeError> {
    let invocation = invoke_command(command, args, cwd, environment)?;
    let mut child = std::process::Command::new(&invocation.executable)
        .args(&invocation.args)
        .current_dir(cwd)
        .envs(&invocation.env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| {
            AppRuntimeError::spawn(format!("Claude background launch failed: {error}"))
        })?;
    let stdout = child.stdout.take().map(|mut stream| {
        std::thread::spawn(move || {
            let mut output = String::new();
            let _ = stream.read_to_string(&mut output);
            output
        })
    });
    let stderr = child.stderr.take().map(|mut stream| {
        std::thread::spawn(move || {
            let mut output = String::new();
            let _ = stream.read_to_string(&mut output);
            output
        })
    });
    let deadline = std::time::Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if std::time::Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppRuntimeError::spawn(format!(
                    "Claude background launch failed: {error}"
                )));
            }
        }
    };
    let stdout = stdout
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    let stderr = stderr
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    Ok(CapturedCommand {
        status,
        output: format!("{stdout}\n{stderr}"),
        timed_out,
    })
}

impl SessionEntry {
    fn new(metadata: AppSession) -> Self {
        let (clients, _) = broadcast::channel(256);
        let (stop, stop_receiver) = oneshot::channel();
        let (stop_escalation, _) = watch::channel(None);
        Self {
            metadata: RwLock::new(metadata),
            pty: Mutex::new(None),
            terminal: Mutex::new(None),
            stop: Mutex::new(Some(stop)),
            stop_receiver: tokio::sync::Mutex::new(Some(stop_receiver)),
            clients,
            dimensions: RwLock::new((DEFAULT_TTY_COLS, DEFAULT_TTY_ROWS)),
            stopping: AtomicBool::new(false),
            stop_escalation_started: AtomicBool::new(false),
            stop_escalation: Arc::new(stop_escalation),
            stop_exit_sent: AtomicBool::new(false),
            processes: Mutex::new(Vec::new()),
            claude_lifecycle: Mutex::new(None),
            opencode_consumer: Mutex::new(None),
            codex_lifecycle: Mutex::new(None),
        }
    }

    fn session_id(&self) -> String {
        self.metadata
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .id
            .clone()
    }

    fn set_pty(&self, pty: PtyHandle) {
        *self
            .pty
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(pty);
    }

    fn set_terminal(&self, terminal: TerminalScreenState) {
        *self
            .terminal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(terminal);
    }

    fn write_terminal(&self, data: &str) {
        if let Some(terminal) = self
            .terminal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_mut()
        {
            terminal.write(data);
        }
    }

    fn resize_terminal(&self, cols: u16, rows: u16) {
        if let Some(terminal) = self
            .terminal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_mut()
        {
            terminal.resize(cols, rows);
        }
    }

    fn terminal_snapshot(&self) -> Option<TerminalScreenSnapshot> {
        self.terminal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(TerminalScreenState::snapshot)
    }

    fn clear_terminal(&self) {
        *self
            .terminal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    fn clear_pty(&self) {
        *self
            .pty
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    fn pid(&self) -> Option<u32> {
        self.pty
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(PtyHandle::pid)
    }

    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let process_pids = self.all_process_pids();
        if let Some(pty) = self
            .pty
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            pty.stop();
        }
        let processes = self
            .processes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        request_stop_process_groups(&processes);
        if let Some(stop) = self
            .stop
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = stop.send(());
        }
        self.start_stop_escalation(process_pids);
    }

    fn start_stop_escalation(&self, process_pids: Vec<u32>) {
        if self.stop_escalation_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let completed = self.stop_escalation.clone();
        tokio::spawn(async move {
            let remaining = stop_process_groups_with_escalation(process_pids).await;
            completed.send_replace(Some(remaining));
        });
    }

    async fn wait_for_stop_escalation(&self) -> Vec<u32> {
        let mut receiver = self.stop_escalation.subscribe();
        loop {
            if let Some(remaining) = receiver.borrow().clone() {
                return remaining;
            }
            if receiver.changed().await.is_err() {
                return Vec::new();
            }
        }
    }

    fn notify_exit(&self, code: Option<i32>, signal: Option<String>) {
        if self.stop_exit_sent.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.clients.send(TtyEvent::Exit { code, signal });
    }

    fn notify_stop_exit(&self) {
        self.notify_exit(None, Some("SIGHUP".to_string()));
    }

    fn set_claude_lifecycle(&self, short: String, control_socket: PathBuf) {
        *self
            .claude_lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ClaudeSessionLifecycle {
            short,
            control_socket,
            cleaned: Arc::new(AtomicBool::new(false)),
        });
    }

    fn set_opencode_consumer(&self, consumer_id: String) {
        *self
            .opencode_consumer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(consumer_id);
    }

    fn take_opencode_consumer(&self) -> Option<String> {
        self.opencode_consumer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }

    fn set_codex_lifecycle(&self, lifecycle: CodexTtyLifecycle) {
        *self
            .codex_lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(lifecycle);
    }

    fn take_codex_lifecycle(&self) -> Option<CodexTtyLifecycle> {
        self.codex_lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }

    async fn stop_claude_daemon(&self) {
        let lifecycle = self
            .claude_lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(lifecycle) = lifecycle else {
            return;
        };
        if lifecycle.cleaned.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Err(error) = ClaudeControlClient::new()
            .kill(&lifecycle.short, "SIGTERM", &lifecycle.control_socket)
            .await
        {
            debug!(
                short = %lifecycle.short,
                socket = %lifecycle.control_socket.display(),
                %error,
                "Claude daemon cleanup failed"
            );
        }
    }

    fn take_stop_receiver(&self) -> Option<oneshot::Receiver<()>> {
        self.stop_receiver
            .try_lock()
            .ok()
            .and_then(|mut slot| slot.take())
    }

    fn add_process(&self, pid: u32) {
        if pid == 0 {
            return;
        }
        let mut processes = self
            .processes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !processes.contains(&pid) {
            processes.push(pid);
        }
    }

    fn process_pids(&self) -> Vec<u32> {
        self.processes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn all_process_pids(&self) -> Vec<u32> {
        let mut pids = self.process_pids();
        if let Some(pid) = self.pid() {
            pids.push(pid);
        }
        pids.sort_unstable();
        pids.dedup();
        pids
    }
}

impl SharedCodexAppServer {
    fn is_running(&self) -> bool {
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let child_running = child
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
        child_running && codex_upstream_is_live(&self.upstream)
    }

    fn connection(&self) -> SharedCodexConnection {
        let pid = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .and_then(Child::id);
        SharedCodexConnection {
            upstream: self.upstream.clone(),
            pid,
            command: self.command.clone(),
            args: self.args.clone(),
            log_path: self.log_path.clone(),
        }
    }

    fn exit_status(&self) -> Option<std::process::ExitStatus> {
        self.child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_mut()
            .and_then(|child| child.try_wait().ok().flatten())
    }

    fn stop(&self) {
        if let Some(mut child) = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            if let Some(pid) = child.id() {
                terminate_process_group(pid);
            }
            let _ = child.start_kill();
        }
    }
}

impl SharedOpenCodeServer {
    fn is_running(&self) -> bool {
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        child
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }

    fn connection(&self) -> SharedOpenCodeConnection {
        SharedOpenCodeConnection {
            endpoint: self.endpoint.clone(),
            headers: self.headers.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
        }
    }

    fn stop(&self) {
        if let Some(mut child) = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            if let Some(pid) = child.id() {
                terminate_process_group(pid);
            }
            let _ = child.start_kill();
        }
    }
}

fn opencode_server_config(
    environment: &BTreeMap<String, String>,
) -> Result<Value, AppRuntimeError> {
    let mut config = environment
        .get("TASK_HANDOFF_OPENCODE_CONFIG_CONTENT")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            serde_json::from_str::<Value>(value).map_err(|error| {
                AppRuntimeError::spawn(format!("OpenCode config content is invalid: {error}"))
            })
        })
        .transpose()?
        .unwrap_or_else(|| json!({}));
    if !config.is_object() {
        config = json!({});
    }
    if let Some(object) = config.as_object_mut() {
        let agent = object
            .entry("agent")
            .or_insert_with(|| json!({}))
            .as_object_mut();
        if let Some(agent) = agent {
            let title = agent
                .entry("title")
                .or_insert_with(|| json!({}))
                .as_object_mut();
            if let Some(title) = title {
                title.insert("disable".to_string(), Value::Bool(true));
            }
        }
    }
    if let Some(plugin_path) = environment
        .get("TASK_HANDOFF_OPENCODE_STORY_PLUGIN")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        if let Ok(plugin) = url::Url::from_file_path(&plugin_path) {
            if let Some(object) = config.as_object_mut() {
                let plugins = object
                    .entry("plugin")
                    .or_insert_with(|| json!([]))
                    .as_array_mut();
                if let Some(plugins) = plugins {
                    let plugin = Value::String(plugin.to_string());
                    if !plugins.contains(&plugin) {
                        plugins.push(plugin);
                    }
                }
            }
        }
    }
    Ok(config)
}

async fn wait_for_opencode_health(
    server: &SharedOpenCodeServer,
    timeout: std::time::Duration,
) -> Result<(), AppRuntimeError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|error| AppRuntimeError::spawn(error.to_string()))?;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if !server.is_running() {
            return Err(AppRuntimeError::spawn(format!(
                "OpenCode server exited before becoming healthy. Log: {}",
                server.log_path.display()
            )));
        }
        let mut request = client.get(format!("{}/global/health", server.endpoint));
        for (name, value) in &server.headers {
            request = request.header(name, value);
        }
        if let Ok(response) = request.send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AppRuntimeError::spawn(format!(
                "OpenCode server did not become healthy at {}. Log: {}",
                server.endpoint,
                server.log_path.display()
            )));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

fn normalize_launch_options(
    mut options: AppLaunchOptions,
) -> Result<AppLaunchOptions, AppRuntimeError> {
    options.title = options
        .title
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty());
    options.env = options
        .env
        .into_iter()
        .filter(|(key, _)| !key.trim().is_empty())
        .map(|(key, value)| (key.trim().to_string(), value))
        .collect();
    options.cwd = options
        .cwd
        .map(|cwd| cwd.trim().to_string())
        .filter(|cwd| !cwd.is_empty());
    options.profile_id = options
        .profile_id
        .map(|profile| profile.trim().to_string())
        .filter(|profile| !profile.is_empty())
        .map(|profile| truncate_utf16(&profile, 120));
    if let Some(display) = options.display.take() {
        let mut normalized = AppDisplayOptions::default();
        if let Some(width) = display.width.filter(|width| (320..=7680).contains(width)) {
            normalized.width = Some(width);
        }
        if let Some(height) = display
            .height
            .filter(|height| (240..=4320).contains(height))
        {
            normalized.height = Some(height);
        }
        if let Some(depth) = display.depth.filter(|depth| (8..=32).contains(depth)) {
            normalized.depth = Some(depth);
        }
        if normalized != AppDisplayOptions::default() {
            options.display = Some(normalized);
        }
    }
    if let Some(resume) = options.ai_session_resume.take() {
        let ai_session_id = resume.ai_session_id.trim().to_string();
        let provider_session_id = resume.provider_session_id.trim().to_string();
        if ai_session_id.is_empty() || provider_session_id.is_empty() {
            return Err(AppRuntimeError::ResumeInvalid(
                "AI session resume requires both AI and provider session ids.".to_string(),
            ));
        }
        options.ai_session_resume = Some(controlled_instance_protocol::AppAiSessionResume {
            ai_session_id,
            provider_session_id,
        });
    }
    options.display_target = normalize_display_target(options.display_target);
    Ok(options)
}

fn sanitize_persisted_optional_fields(record: &mut serde_json::Map<String, Value>) {
    if let Some(launch) = record.get("launch").cloned() {
        match sanitize_persisted_launch(launch) {
            Some(launch) => {
                record.insert(
                    "launch".to_string(),
                    serde_json::to_value(launch).unwrap_or(Value::Null),
                );
            }
            None => {
                record.remove("launch");
            }
        }
    }
    retain_typed_persisted_field::<AppSessionTty>(record, "tty");
    retain_typed_persisted_field::<AppSessionDisplay>(record, "display");
    retain_typed_persisted_field::<AppSessionVnc>(record, "vnc");
    retain_typed_persisted_field::<AppSessionWeb>(record, "web");
    retain_typed_persisted_field::<AppSessionAutomation>(record, "automation");
    retain_typed_persisted_field::<AppSessionProcess>(record, "process");
    if let Some(bindings) = record.get("bindings").cloned() {
        let Some(bindings) = bindings.as_array() else {
            record.remove("bindings");
            return;
        };
        let bindings = bindings
            .iter()
            .filter_map(|binding| serde_json::from_value::<AppSessionBinding>(binding.clone()).ok())
            .collect::<Vec<_>>();
        record.insert(
            "bindings".to_string(),
            serde_json::to_value(bindings).unwrap_or_else(|_| json!([])),
        );
    }
}

fn retain_typed_persisted_field<T>(record: &mut serde_json::Map<String, Value>, key: &str)
where
    T: serde::de::DeserializeOwned + Serialize,
{
    let Some(value) = record.get(key).cloned() else {
        return;
    };
    match serde_json::from_value::<T>(value) {
        Ok(value) => {
            record.insert(
                key.to_string(),
                serde_json::to_value(value).unwrap_or(Value::Null),
            );
        }
        Err(_) => {
            record.remove(key);
        }
    }
}

fn sanitize_persisted_launch(value: Value) -> Option<AppLaunchOptions> {
    let mut launch = value.as_object()?.clone();
    for key in ["title", "cwd", "profileId"] {
        if launch.get(key).is_some_and(|value| !value.is_string()) {
            launch.remove(key);
        }
    }
    if let Some(args) = launch.get("args").cloned() {
        let Some(args) = args.as_array() else {
            launch.remove("args");
            return serde_json::from_value(Value::Object(launch)).ok();
        };
        let args = args
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        launch.insert("args".to_string(), json!(args));
    }
    if let Some(env) = launch.get("env").cloned() {
        let Some(env) = env.as_object() else {
            launch.remove("env");
            return serde_json::from_value(Value::Object(launch)).ok();
        };
        let env = env
            .iter()
            .filter_map(|(key, value)| {
                value
                    .as_str()
                    .map(|value| (key.trim().to_string(), value.to_string()))
            })
            .filter(|(key, _)| !key.is_empty())
            .collect::<BTreeMap<_, _>>();
        launch.insert("env".to_string(), json!(env));
    }
    retain_typed_persisted_field::<AppDisplayOptions>(&mut launch, "display");
    retain_typed_persisted_field::<AppDisplayTarget>(&mut launch, "displayTarget");
    retain_typed_persisted_field::<controlled_instance_protocol::AppAiSessionResume>(
        &mut launch,
        "aiSessionResume",
    );
    serde_json::from_value(Value::Object(launch)).ok()
}

fn normalize_display_target(target: Option<AppDisplayTarget>) -> Option<AppDisplayTarget> {
    let target = target?;
    match target.mode {
        AppDisplayMode::Isolated => Some(AppDisplayTarget {
            mode: AppDisplayMode::Isolated,
            id: None,
            auto_create: None,
        }),
        AppDisplayMode::Shared => {
            let id = target
                .id
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| "main".to_string());
            Some(AppDisplayTarget {
                mode: AppDisplayMode::Shared,
                id: Some(id),
                auto_create: Some(target.auto_create.unwrap_or(true)),
            })
        }
    }
}

fn chromium_extension_dirs() -> Vec<PathBuf> {
    let is_extension = |path: &Path| path.join("manifest.json").is_file();
    if let Some(configured) = std::env::var_os("TASK_HANDOFF_CHROMIUM_EXTENSION_DIRS") {
        return configured
            .to_string_lossy()
            .split([',', ';'])
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .filter(|path| is_extension(path))
            .collect();
    }
    let root = std::env::var_os("TASK_HANDOFF_CHROMIUM_EXTENSION_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/opt/task-handoff/chromium-extensions"));
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|path| is_extension(path))
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn decode_utf8_stream(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    pending.extend_from_slice(bytes);
    let mut output = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                output.push_str(text);
                pending.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    output.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or_default());
                    pending.drain(..valid);
                }
                match error.error_len() {
                    Some(invalid) => {
                        output.push('\u{fffd}');
                        pending.drain(..invalid);
                    }
                    None => break,
                }
            }
        }
    }
    output
}

fn gui_scale_from_env(env: &BTreeMap<String, String>) -> f64 {
    env.get("TASK_HANDOFF_GUI_SCALE")
        .filter(|value| !value.is_empty())
        .cloned()
        .or_else(|| {
            std::env::var("TASK_HANDOFF_GUI_SCALE")
                .ok()
                .filter(|value| !value.is_empty())
        })
        .as_deref()
        .and_then(parse_js_number)
        .filter(|value| value.is_finite())
        .unwrap_or(1.0)
        .clamp(1.0, 3.0)
}

fn parse_js_number(value: &str) -> Option<f64> {
    let value =
        value.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            return i64::from_str_radix(digits, radix)
                .ok()
                .map(|value| value as f64);
        }
    }
    match value {
        "Infinity" | "+Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => value.parse::<f64>().ok().or(Some(f64::NAN)),
    }
}

fn format_gui_scale(scale: f64) -> String {
    let mut value = format!("{scale:.2}");
    while value.ends_with('0') && value.contains('.') {
        value.pop();
    }
    if value.ends_with('.') {
        value.pop();
    }
    value
}

fn prepare_kasm_vnc_home(
    session_dir: &Path,
    width: u32,
    height: u32,
    depth: u32,
    port: u16,
    scale: f64,
) -> Result<(), AppRuntimeError> {
    let home = session_dir.join("home");
    let vnc_dir = home.join(".vnc");
    let gtk_dir = home.join(".config/gtk-3.0");
    let fontconfig_dir = home.join(".config/fontconfig");
    for directory in [&vnc_dir, &gtk_dir, &fontconfig_dir] {
        std::fs::create_dir_all(directory)
            .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
    }
    let dpi = (96.0 * scale).round() as u32;
    let gtk_dpi = dpi * 1024;
    let username = std::env::var("TASK_HANDOFF_KASMVNC_USERNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "agent".to_string());
    let password = std::env::var("TASK_HANDOFF_KASMVNC_PASSWORD")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "taskhandoff".to_string());
    let pem = vnc_dir.join("self.pem");
    let openssl = crate::catalog::resolve_executable("openssl", &std::env::vars().collect(), None)
        .ok_or_else(|| AppRuntimeError::missing_command("openssl"))?;
    let output = std::process::Command::new(openssl)
        .args([
            "req",
            "-x509",
            "-nodes",
            "-newkey",
            "rsa:2048",
            "-keyout",
            pem.to_str().unwrap_or_default(),
            "-out",
            pem.to_str().unwrap_or_default(),
            "-days",
            "3650",
            "-subj",
            "/CN=localhost",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| AppRuntimeError::DisplayStartFailed(error.to_string()))?;
    if !output.success() {
        return Err(AppRuntimeError::DisplayStartFailed(
            "KasmVNC certificate generation failed.".to_string(),
        ));
    }
    std::fs::write(
        home.join(".Xresources"),
        format!(
            "Xft.dpi: {dpi}\nXft.antialias: 1\nXft.hinting: 1\nXft.hintstyle: hintslight\nXft.rgba: rgb\nXft.lcdfilter: lcddefault\nXcursor.size: 24\nXTerm*faceName: Monospace\nXTerm*faceSize: 11\nXTerm*renderFont: true\n"
        ),
    )
    .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
    std::fs::write(
        gtk_dir.join("settings.ini"),
        format!(
            "[Settings]\ngtk-xft-dpi={gtk_dpi}\ngtk-xft-antialias=1\ngtk-xft-hinting=1\ngtk-xft-hintstyle=hintslight\ngtk-xft-rgba=rgb\ngtk-cursor-theme-size=24\n"
        ),
    )
    .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
    std::fs::write(
        home.join(".gtkrc-2.0"),
        format!(
            "gtk-xft-dpi = {gtk_dpi}\ngtk-xft-antialias = 1\ngtk-xft-hinting = 1\ngtk-xft-hintstyle = \"hintslight\"\ngtk-xft-rgba = \"rgb\"\ngtk-cursor-theme-size = 24\n"
        ),
    )
    .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
    std::fs::write(
        fontconfig_dir.join("fonts.conf"),
        "<?xml version=\"1.0\"?>\n<!DOCTYPE fontconfig SYSTEM \"urn:fontconfig:fonts.dtd\">\n<fontconfig>\n  <match target=\"font\">\n    <edit name=\"antialias\" mode=\"assign\"><bool>true</bool></edit>\n    <edit name=\"hinting\" mode=\"assign\"><bool>true</bool></edit>\n    <edit name=\"hintstyle\" mode=\"assign\"><const>hintslight</const></edit>\n    <edit name=\"rgba\" mode=\"assign\"><const>rgb</const></edit>\n    <edit name=\"lcdfilter\" mode=\"assign\"><const>lcddefault</const></edit>\n  </match>\n</fontconfig>\n",
    )
    .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
    std::fs::write(
        vnc_dir.join("kasmvnc.yaml"),
        format!(
            "desktop:\n  resolution:\n    width: {width}\n    height: {height}\n  allow_resize: true\n  pixel_depth: {depth}\nnetwork:\n  protocol: http\n  interface: 127.0.0.1\n  websocket_port: {port}\n  use_ipv4: true\n  use_ipv6: false\n  ssl:\n    pem_certificate: {pem}\n    pem_key: {pem}\n    require_ssl: false\nuser_session:\n  session_type: shared\n  concurrent_connections_prompt: false\n  idle_timeout: never\ncommand_line:\n  prompt: false\n",
            pem = pem.display()
        ),
    )
    .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
    let vncpasswd =
        crate::catalog::resolve_executable("vncpasswd", &std::env::vars().collect(), None)
            .ok_or_else(|| AppRuntimeError::missing_command("vncpasswd"))?;
    let mut child = std::process::Command::new(vncpasswd)
        .args(["-u", &username, "-w", "-r"])
        .env("HOME", &home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| AppRuntimeError::DisplayStartFailed(error.to_string()))?;
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = writeln!(stdin, "{password}");
        let _ = writeln!(stdin, "{password}");
    }
    let status = child
        .wait()
        .map_err(|error| AppRuntimeError::DisplayStartFailed(error.to_string()))?;
    if !status.success() {
        return Err(AppRuntimeError::DisplayStartFailed(
            "KasmVNC password preparation failed.".to_string(),
        ));
    }
    Ok(())
}

fn write_kasm_vnc_launcher(
    session_dir: &Path,
    display: &str,
    width: u32,
    height: u32,
    depth: u32,
) -> Result<PathBuf, AppRuntimeError> {
    let launcher = session_dir.join("kasmvnc-launcher.sh");
    std::fs::write(
        &launcher,
        format!(
            "#!/usr/bin/env bash\nset -euo pipefail\ndisplay={display:?}\ngeometry={geometry:?}\ndepth={depth:?}\ntail_pid=\"\"\ncleanup() {{\n  if [ -n \"${{tail_pid:-}}\" ]; then\n    kill \"$tail_pid\" >/dev/null 2>&1 || true\n    wait \"$tail_pid\" >/dev/null 2>&1 || true\n  fi\n  HOME=\"$HOME\" vncserver -kill \"$display\" >/dev/null 2>&1 || true\n}}\ntrap cleanup EXIT\ntrap 'cleanup; exit 0' TERM INT\nHOME=\"$HOME\" vncserver \"$display\" -noxstartup -geometry \"$geometry\" -depth \"$depth\" -publicIP 127.0.0.1\nlog_file=$(ls -t \"$HOME/.vnc\"/*.log 2>/dev/null | head -n 1 || true)\nif [ -z \"$log_file\" ]; then\n  while true; do sleep 3600; done\nfi\ntail -F \"$log_file\" &\ntail_pid=$!\nwait \"$tail_pid\"\n",
            geometry = format!("{width}x{height}")
        ),
    )
    .map_err(|error| AppRuntimeError::storage(error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755));
    }
    Ok(launcher)
}

fn apply_gui_scale(env: &BTreeMap<String, String>, session_dir: &Path, scale: f64) {
    if scale <= 1.0 {
        return;
    }
    let resources = session_dir.join("home/.Xresources");
    if !resources.is_file() {
        return;
    }
    let Ok(xrdb) = crate::catalog::resolve_executable("xrdb", env, None)
        .ok_or_else(|| AppRuntimeError::missing_command("xrdb"))
    else {
        return;
    };
    let _ = std::process::Command::new(xrdb)
        .args(["-merge", resources.to_str().unwrap_or_default()])
        .envs(env)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn resize_display_with_xrandr(
    env: &BTreeMap<String, String>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let executable = crate::catalog::resolve_executable("xrandr", env, None)
        .ok_or_else(|| "Missing required command: xrandr".to_string())?;
    let query = std::process::Command::new(&executable)
        .arg("--query")
        .envs(env)
        .output()
        .map_err(|error| error.to_string())?;
    let output = if query.status.success() {
        String::from_utf8_lossy(&query.stdout).into_owned()
    } else {
        String::new()
    };
    let connected = output
        .lines()
        .find_map(|line| line.split_once(" connected").map(|(name, _)| name.trim()))
        .filter(|name| !name.is_empty());
    let mode = format!("{width}x{height}");
    let attempts = connected
        .map(|output| {
            vec![
                vec![
                    "--output".to_string(),
                    output.to_string(),
                    "--mode".to_string(),
                    mode.clone(),
                ],
                vec!["--fb".to_string(), mode.clone()],
            ]
        })
        .unwrap_or_else(|| vec![vec!["--fb".to_string(), mode.clone()]]);
    let mut last_error = String::new();
    for args in attempts {
        match std::process::Command::new(&executable)
            .args(&args)
            .envs(env)
            .output()
        {
            Ok(result) if result.status.success() => return Ok(()),
            Ok(result) => {
                last_error = String::from_utf8_lossy(&result.stderr).trim().to_string();
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(if last_error.is_empty() {
        "xrandr did not accept the requested display size.".to_string()
    } else {
        last_error
    })
}

fn resolve_launch_cwd(launch_cwd: Option<&str>, catalog_cwd: Option<&str>) -> PathBuf {
    let process_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    resolve_launch_cwd_from(
        launch_cwd,
        catalog_cwd,
        std::env::var("TASK_HANDOFF_WORKSPACE").ok().as_deref(),
        &process_cwd,
    )
}

fn resolve_launch_cwd_from(
    launch_cwd: Option<&str>,
    catalog_cwd: Option<&str>,
    workspace_env: Option<&str>,
    process_cwd: &Path,
) -> PathBuf {
    let candidate = launch_cwd
        .filter(|value| !value.is_empty())
        .or_else(|| catalog_cwd.filter(|value| !value.is_empty()))
        .or_else(|| workspace_env.filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .unwrap_or_else(|| process_cwd.to_path_buf());
    resolve_path_from(&candidate, process_cwd)
}

fn resolve_path_from(path: &Path, process_cwd: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize_path_lexically(path)
    } else {
        normalize_path_lexically(&process_cwd.join(path))
    }
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized.file_name().is_some() {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        normalized
    }
}

fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok()
}

fn allocate_available_port(
    next: &Mutex<u16>,
    start: u16,
    end: u16,
    used: &BTreeSet<u16>,
    mut is_available: impl FnMut(u16) -> bool,
) -> Result<u16, AppRuntimeError> {
    let mut value = next.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let total = u32::from(end.saturating_sub(start)) + 1;
    let initial = (*value).max(start);
    for offset in 0..total {
        let candidate = start + ((u32::from(initial - start) + offset) % total) as u16;
        if !used.contains(&candidate) && is_available(candidate) {
            *value = if candidate >= end {
                start
            } else {
                candidate + 1
            };
            return Ok(candidate);
        }
    }
    Err(AppRuntimeError::ResourceExhausted(format!(
        "No available allocation in range {start}-{end}."
    )))
}

fn parse_display_number(value: &str) -> Option<u32> {
    value.strip_prefix(':').unwrap_or(value).parse().ok()
}

fn read_tail(path: &Path, start: u64) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn signal_name(status: std::process::ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| {
            signal_number_name(signal)
                .map(ToString::to_string)
                .unwrap_or_else(|| signal.to_string())
        })
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

#[cfg(target_os = "linux")]
fn signal_number_name(signal: i32) -> Option<&'static str> {
    Some(match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        7 => "SIGBUS",
        8 => "SIGFPE",
        9 => "SIGKILL",
        10 => "SIGUSR1",
        11 => "SIGSEGV",
        12 => "SIGUSR2",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        16 => "SIGSTKFLT",
        17 => "SIGCHLD",
        18 => "SIGCONT",
        19 => "SIGSTOP",
        20 => "SIGTSTP",
        21 => "SIGTTIN",
        22 => "SIGTTOU",
        23 => "SIGURG",
        24 => "SIGXCPU",
        25 => "SIGXFSZ",
        26 => "SIGVTALRM",
        27 => "SIGPROF",
        28 => "SIGWINCH",
        29 => "SIGIO",
        30 => "SIGPWR",
        31 => "SIGSYS",
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
fn signal_number_name(signal: i32) -> Option<&'static str> {
    Some(match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        7 => "SIGBUS",
        8 => "SIGFPE",
        9 => "SIGKILL",
        10 => "SIGUSR1",
        11 => "SIGSEGV",
        12 => "SIGUSR2",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        16 => "SIGURG",
        17 => "SIGSTOP",
        18 => "SIGTSTP",
        19 => "SIGCONT",
        20 => "SIGCHLD",
        21 => "SIGTTIN",
        22 => "SIGTTOU",
        23 => "SIGIO",
        24 => "SIGXCPU",
        25 => "SIGXFSZ",
        26 => "SIGVTALRM",
        27 => "SIGPROF",
        28 => "SIGWINCH",
        29 => "SIGINFO",
        30 => "SIGUSR1",
        31 => "SIGUSR2",
        _ => return None,
    })
}

#[cfg(all(unix, not(target_os = "linux"), not(target_os = "macos")))]
fn signal_number_name(signal: i32) -> Option<&'static str> {
    Some(match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        7 => "SIGBUS",
        8 => "SIGFPE",
        9 => "SIGKILL",
        10 => "SIGUSR1",
        11 => "SIGSEGV",
        12 => "SIGUSR2",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => return None,
    })
}

fn app_server_exit_fields(
    status: Option<std::process::ExitStatus>,
) -> (&'static str, Option<i32>, Option<String>) {
    let Some(status) = status else {
        return ("failed", None, None);
    };
    (
        if status.success() { "exited" } else { "failed" },
        status.code(),
        signal_name(status),
    )
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .is_some_and(|value| parse_env_flag(&value))
}

fn parse_env_flag(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn claude_background_timeout() -> std::time::Duration {
    claude_background_timeout_from_value(
        std::env::var("TASK_HANDOFF_CLAUDE_BG_TIMEOUT_MS")
            .ok()
            .as_deref(),
    )
}

fn claude_background_timeout_from_value(value: Option<&str>) -> std::time::Duration {
    let milliseconds = value
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(15_000.0);
    std::time::Duration::from_secs_f64(milliseconds / 1000.0)
}

fn render_gui_argument(argument: &str, session_dir: &Path, cdp_port: u16) -> String {
    argument
        .replace("{sessionDir}", &session_dir.display().to_string())
        .replace("{cdpPort}", &cdp_port.to_string())
}

fn codex_upstream_is_live(upstream: &CodexAppServerUpstream) -> bool {
    upstream.socket_path().is_none_or(Path::exists)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn session_retention_days() -> f64 {
    session_retention_days_from(
        std::env::var("TASK_HANDOFF_APP_SESSION_RETENTION_DAYS")
            .ok()
            .as_deref(),
    )
}

fn session_retention_days_from(raw: Option<&str>) -> f64 {
    raw.filter(|value| !value.is_empty())
        .and_then(parse_js_number)
        .filter(|days| days.is_finite() && *days > 0.0)
        .unwrap_or(DEFAULT_SESSION_RETENTION_DAYS)
}

fn session_timestamp(session: &AppSession) -> Option<f64> {
    let value = if session.updated_at.is_empty() {
        session.created_at.as_str()
    } else {
        session.updated_at.as_str()
    };
    parse_javascript_date(value)
}

fn parse_javascript_date(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(timestamp) = DateTime::parse_from_rfc3339(value) {
        return Some(timestamp.timestamp_millis() as f64);
    }
    if let Ok(timestamp) = DateTime::parse_from_rfc2822(value) {
        return Some(timestamp.timestamp_millis() as f64);
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as f64);
    }
    for format in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
    ] {
        let Ok(naive) = NaiveDateTime::parse_from_str(value, format) else {
            continue;
        };
        if let Some(timestamp) = Local.from_local_datetime(&naive).single() {
            return Some(timestamp.timestamp_millis() as f64);
        }
    }
    None
}

fn prepare_vscode_web_session(session_dir: &Path) {
    let settings_path = session_dir
        .join("user-data")
        .join("User")
        .join("settings.json");
    let existing = read_json::<Value>(&settings_path)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut settings = serde_json::Map::from_iter([
        (
            "workbench.colorTheme".to_string(),
            Value::String("Default Dark Modern".to_string()),
        ),
        (
            "workbench.preferredDarkColorTheme".to_string(),
            Value::String("Default Dark Modern".to_string()),
        ),
    ]);
    settings.extend(existing);
    let _ = write_json_atomic(&settings_path, &Value::Object(settings), Some(0o600));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage(root: &Path) -> StoragePaths {
        StoragePaths {
            config_path: root.join("config.json"),
            data_dir: root.to_path_buf(),
            app_catalog_dir: root.join("app-catalog"),
            app_sessions_dir: root.join("app-sessions"),
            triggers_dir: root.join("triggers"),
            runtime_dir: root.join("runtime"),
            events_dir: root.join("events"),
            artifact_dir: root.join("artifacts"),
            log_dir: root.join("logs"),
            web_token_path: root.join("web-token"),
        }
    }

    fn session_with_allocated_ports() -> AppSession {
        serde_json::from_value(json!({
            "id": "app_test",
            "appId": "test",
            "title": "Test",
            "kind": "gui",
            "status": "running",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "workspace": { "cwd": "/tmp" },
            "vnc": {
                "host": "127.0.0.1",
                "port": 6102,
                "websockifyPort": 7102,
                "webPath": "/vnc",
                "noVncPath": "/novnc"
            },
            "web": {
                "host": "127.0.0.1",
                "port": 8102,
                "webPath": "/web"
            },
            "automation": {
                "type": "cdp",
                "endpoint": "http://127.0.0.1:9202",
                "port": 9202
            },
            "ai": { "appServer": { "proxyPort": 8103 } },
            "paths": { "sessionDir": "/tmp/session", "logDir": "/tmp/logs" }
        }))
        .expect("app session")
    }

    #[test]
    fn app_environment_layers_follow_the_node_precedence() {
        let base = BTreeMap::from([
            ("LAYER".to_string(), "process".to_string()),
            ("PROCESS_ONLY".to_string(), "yes".to_string()),
            ("REMOVE_ME".to_string(), "yes".to_string()),
            ("TERM".to_string(), "process-term".to_string()),
        ]);
        let app = BTreeMap::from([
            ("LAYER".to_string(), "app".to_string()),
            ("APP_ONLY".to_string(), "yes".to_string()),
        ]);
        let launch = BTreeMap::from([
            ("LAYER".to_string(), "launch".to_string()),
            ("LAUNCH_ONLY".to_string(), "yes".to_string()),
        ]);
        let managed = BTreeMap::from([
            ("LAYER".to_string(), "managed".to_string()),
            ("MANAGED_ONLY".to_string(), "yes".to_string()),
            ("TERM".to_string(), "managed-term".to_string()),
        ]);
        let unset = BTreeSet::from(["REMOVE_ME".to_string()]);

        let web = merge_app_environment(base.clone(), Some(&app), &launch, &managed, &unset, false);
        assert_eq!(web.get("LAYER").map(String::as_str), Some("managed"));
        assert_eq!(web.get("TERM").map(String::as_str), Some("managed-term"));
        assert_eq!(web.get("APP_ONLY").map(String::as_str), Some("yes"));
        assert_eq!(web.get("LAUNCH_ONLY").map(String::as_str), Some("yes"));
        assert_eq!(web.get("MANAGED_ONLY").map(String::as_str), Some("yes"));
        assert!(!web.contains_key("REMOVE_ME"));

        let tty = merge_app_environment(base, Some(&app), &launch, &managed, &unset, true);
        assert_eq!(tty.get("LAYER").map(String::as_str), Some("managed"));
        assert_eq!(tty.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(tty.get("PROCESS_ONLY").map(String::as_str), Some("yes"));

        let app_with_term = BTreeMap::from([("TERM".to_string(), "app-term".to_string())]);
        let web_without_managed_term = merge_app_environment(
            BTreeMap::new(),
            Some(&app_with_term),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeSet::new(),
            false,
        );
        assert_eq!(
            web_without_managed_term.get("TERM").map(String::as_str),
            Some("app-term")
        );
    }

    #[test]
    fn gui_argument_rendering_matches_the_node_placeholders() {
        assert_eq!(
            render_gui_argument(
                "{sessionDir}/profile:{cwd}:{cdpPort}:{port}",
                Path::new("/tmp/session"),
                9222
            ),
            "/tmp/session/profile:{cwd}:9222:{port}"
        );
    }

    #[test]
    fn custom_xterm_apps_receive_the_terminal_gui_extension() {
        let mut app = crate::builtin_app_catalog()
            .into_iter()
            .find(|app| app.id == "terminal-gui")
            .expect("terminal gui");
        app.id = "custom-xterm".to_string();
        app.command = Some("/usr/local/bin/xterm".to_string());
        assert_eq!(
            managed_app_runtime_provider(&app).map(|provider| provider.gui_runtime),
            Some(ManagedAppGuiRuntime::TerminalGui)
        );

        app.command = Some("/usr/local/bin/other-terminal".to_string());
        assert_eq!(
            managed_app_runtime_provider(&app).map(|provider| provider.gui_runtime),
            None
        );
    }

    #[test]
    fn claude_background_timeout_uses_javascript_number_parsing() {
        assert_eq!(
            claude_background_timeout_from_value(Some(" 2500 ")).as_millis(),
            2_500
        );
        assert_eq!(
            claude_background_timeout_from_value(Some("2.5e3")).as_millis(),
            2_500
        );
        assert_eq!(
            claude_background_timeout_from_value(Some("0")).as_millis(),
            15_000
        );
    }

    #[test]
    fn environment_flags_do_not_trim_values() {
        assert!(parse_env_flag("TRUE"));
        assert!(!parse_env_flag(" true"));
        assert!(!parse_env_flag("true "));
        assert!(!parse_env_flag(""));
    }

    #[test]
    fn persisted_sessions_tolerate_old_optional_shapes_and_missing_workspace() {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new(storage(root.path()), root.path());
        let value = json!({
            "id": "app_legacy",
            "appId": "terminal-tty",
            "title": "Legacy",
            "kind": "tty",
            "status": "exited",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "launch": { "title": "Legacy", "args": null, "cwd": root.path() },
            "process": { "command": "shell", "exitCode": null, "signal": null },
            "paths": { "sessionDir": "/old/session", "logDir": "/old/log" }
        });

        let session = runtime
            .sanitize_persisted_session(value, "app_legacy")
            .expect("legacy session");
        assert_eq!(session.workspace.cwd, root.path().display().to_string());
        assert!(session
            .launch
            .as_ref()
            .is_some_and(|launch| launch.args.is_empty()));
        assert_eq!(
            session.paths.session_dir,
            root.path()
                .join("app-sessions/app_legacy")
                .display()
                .to_string()
        );
    }

    #[test]
    fn restored_running_sessions_expose_explicit_null_process_fields() {
        let runtime = AppRuntime::new(storage(Path::new("/tmp")), Path::new("/tmp"));
        let session = serde_json::from_value(json!({
            "id": "app_running",
            "appId": "terminal-tty",
            "title": "Running",
            "kind": "tty",
            "status": "running",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "workspace": { "cwd": "/tmp" },
            "process": { "command": "shell" },
            "paths": { "sessionDir": "/tmp/session", "logDir": "/tmp/log" }
        }))
        .expect("session");

        let recovered = runtime.recover_persisted_session(session);
        let serialized = serde_json::to_value(recovered).expect("serialize recovered session");
        assert_eq!(serialized["status"], "exited");
        assert_eq!(serialized["process"]["exitCode"], Value::Null);
        assert_eq!(serialized["process"]["signal"], Value::Null);
    }

    #[test]
    fn display_allocation_exhausts_the_configured_range_instead_of_reusing() {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new(storage(root.path()), root.path());
        let catalog = crate::builtin_app_catalog();
        let app = catalog
            .iter()
            .find(|app| app.id == "terminal-gui")
            .expect("terminal gui");
        for number in DISPLAY_START..=DISPLAY_END {
            let mut metadata = session_with_allocated_ports();
            metadata.id = format!("app_display_{number}");
            metadata.app_id = app.id.clone();
            metadata.display = Some(AppSessionDisplay {
                display: format!(":{number}"),
                mode: Some("isolated".to_string()),
                display_session_id: None,
                width: 800,
                height: 600,
                depth: 24,
                x_pid: None,
                wm_pid: None,
                compositor_pid: None,
                xauthority: None,
            });
            runtime
                .inner
                .sessions
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(metadata.id.clone(), Arc::new(SessionEntry::new(metadata)));
        }

        let error = runtime.allocate_display().expect_err("exhausted displays");
        assert_eq!(error.code(), "APP_RESOURCE_EXHAUSTED");
    }

    #[cfg(unix)]
    #[test]
    fn log_reads_ignore_symlinks_and_preserve_fractional_number_failures() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new(storage(root.path()), root.path());
        let log_dir = root.path().join("logs/app-sessions/app_logs");
        std::fs::create_dir_all(&log_dir).expect("log directory");
        std::fs::write(log_dir.join("app.log"), "x".repeat(2048)).expect("log file");
        let outside = root.path().join("outside.log");
        std::fs::write(&outside, "secret").expect("outside log");
        symlink(&outside, log_dir.join("linked.log")).expect("log symlink");
        let mut session = session_with_allocated_ports();
        session.id = "app_logs".to_string();
        session.paths.log_dir = log_dir.display().to_string();
        runtime
            .inner
            .persisted_sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session.id.clone(), session);

        let logs = runtime.read_logs("app_logs", 4096.0).expect("read logs");
        assert_eq!(logs["files"].as_array().map(Vec::len), Some(1));
        assert_eq!(logs["files"][0]["name"], "app.log");

        let error = runtime
            .read_logs("app_logs", 1024.5)
            .expect_err("fractional log limit");
        assert_eq!(error.code(), "APP_LOGS_FAILED");
    }

    #[test]
    fn ai_session_resume_arguments_are_owned_by_managed_app_providers() {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new(storage(root.path()), root.path());
        let catalog = crate::builtin_app_catalog();
        let codex = catalog.iter().find(|app| app.id == "codex").expect("codex");
        let terminal = catalog
            .iter()
            .find(|app| app.id == "terminal-tty")
            .expect("terminal");
        let resume = AppLaunchOptions {
            ai_session_resume: Some(controlled_instance_protocol::AppAiSessionResume {
                ai_session_id: "ai-session".to_string(),
                provider_session_id: "provider-session".to_string(),
            }),
            ..AppLaunchOptions::default()
        };

        assert_eq!(
            runtime
                .ai_session_resume_args(codex, &resume)
                .expect("codex resume"),
            vec!["resume".to_string(), "provider-session".to_string()]
        );
        let error = runtime
            .ai_session_resume_args(terminal, &resume)
            .expect_err("unsupported terminal resume");
        assert_eq!(error.code(), "APP_RESUME_UNSUPPORTED");
        assert_eq!(
            error.to_string(),
            "terminal-tty does not support AI session resume."
        );
    }

    #[test]
    fn invalid_ai_session_resume_identity_uses_the_node_error_code() {
        let error = normalize_launch_options(AppLaunchOptions {
            ai_session_resume: Some(controlled_instance_protocol::AppAiSessionResume {
                ai_session_id: " ".to_string(),
                provider_session_id: "provider-session".to_string(),
            }),
            ..AppLaunchOptions::default()
        })
        .expect_err("invalid resume");
        assert_eq!(error.code(), "APP_RESUME_INVALID");

        let normalized = normalize_launch_options(AppLaunchOptions {
            ai_session_resume: Some(controlled_instance_protocol::AppAiSessionResume {
                ai_session_id: " ai-session ".to_string(),
                provider_session_id: " provider-session ".to_string(),
            }),
            ..AppLaunchOptions::default()
        })
        .expect("valid resume");
        assert_eq!(
            normalized.ai_session_resume,
            Some(controlled_instance_protocol::AppAiSessionResume {
                ai_session_id: "ai-session".to_string(),
                provider_session_id: "provider-session".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn start_resume_rejects_apps_without_resume_capability() {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new(storage(root.path()), root.path());
        let error = runtime
            .start_resume(
                "terminal-tty",
                root.path().to_str().expect("root"),
                "ai-session",
                "provider-session",
            )
            .await
            .expect_err("unsupported resume");
        assert_eq!(error.code(), "APP_RESUME_UNSUPPORTED");
    }

    #[test]
    fn unix_codex_upstream_requires_the_socket_to_exist() {
        let root = tempfile::tempdir().expect("tempdir");
        let socket = root.path().join("app-server.sock");
        let upstream = CodexAppServerUpstream::Unix {
            socket_path: socket.clone(),
        };
        assert!(!codex_upstream_is_live(&upstream));
        std::fs::write(&socket, b"socket").expect("socket fixture");
        assert!(codex_upstream_is_live(&upstream));
    }

    #[test]
    fn relative_launch_cwd_resolves_from_the_process_cwd() {
        let process_cwd = Path::new("/tmp/app-runtime-process");

        assert_eq!(
            resolve_launch_cwd_from(
                Some("nested/../launch"),
                Some("/catalog/ignored"),
                Some("/workspace/ignored"),
                process_cwd,
            ),
            PathBuf::from("/tmp/app-runtime-process/launch")
        );
        assert_eq!(
            resolve_launch_cwd_from(None, Some("/catalog/app"), Some("/workspace"), process_cwd),
            PathBuf::from("/catalog/app")
        );
        assert_eq!(
            resolve_launch_cwd_from(None, None, Some("workspace"), process_cwd),
            PathBuf::from("/tmp/app-runtime-process/workspace")
        );
        assert_eq!(
            resolve_launch_cwd_from(None, None, None, process_cwd),
            process_cwd
        );
    }

    #[test]
    fn persisted_session_recovery_rewrites_paths_and_writes_sanitized_metadata() {
        let root = tempfile::tempdir().expect("tempdir");
        let storage = storage(root.path());
        let runtime = AppRuntime::new(storage.clone(), root.path());
        let id = "app_restored";
        let session_dir = storage.app_sessions_dir.join(id);
        std::fs::create_dir_all(&session_dir).expect("session dir");
        let mut session = session_with_allocated_ports();
        session.id = id.to_string();
        session.workspace.cwd = "relative/../workspace".to_string();
        session.paths = AppSessionPaths {
            session_dir: "/stale/session".to_string(),
            log_dir: "/stale/log".to_string(),
        };
        let metadata_path = session_dir.join("metadata.json");
        write_json_atomic(&metadata_path, &session, Some(0o600)).expect("metadata");

        runtime.load_persisted_sessions();

        let restored = runtime.get_session(id).expect("restored session");
        let process_cwd = std::env::current_dir().expect("process cwd");
        assert_eq!(
            PathBuf::from(&restored.workspace.cwd),
            process_cwd.join("workspace")
        );
        assert_eq!(
            PathBuf::from(&restored.paths.session_dir),
            storage.app_sessions_dir.join(id)
        );
        assert_eq!(
            PathBuf::from(&restored.paths.log_dir),
            storage.log_dir.join("app-sessions").join(id)
        );
        let written: AppSession = read_json(&metadata_path).expect("written metadata");
        assert_eq!(written.workspace.cwd, restored.workspace.cwd);
        assert_eq!(written.paths.session_dir, restored.paths.session_dir);
        assert_eq!(written.paths.log_dir, restored.paths.log_dir);
        assert_eq!(written.status, "exited");
        assert_eq!(
            written.extra["error"]["code"],
            "APP_SESSION_RESTORED_WITHOUT_PROCESS"
        );
    }

    #[test]
    fn session_gc_removes_only_old_cleanable_persisted_sessions() {
        let root = tempfile::tempdir().expect("tempdir");
        let storage = storage(root.path());
        let runtime = AppRuntime::new(storage.clone(), root.path());
        let now = DateTime::parse_from_rfc3339("2026-11-02T00:00:00Z")
            .expect("timestamp")
            .with_timezone(&Utc);
        let mut expired = session_with_allocated_ports();
        expired.id = "app_expired".to_string();
        expired.status = "exited".to_string();
        expired.updated_at = "2026-10-20T00:00:00Z".to_string();
        let mut recent = session_with_allocated_ports();
        recent.id = "app_recent".to_string();
        recent.status = "stopped".to_string();
        recent.updated_at = "2026-11-01T00:00:00Z".to_string();
        for session in [&expired, &recent] {
            std::fs::create_dir_all(storage.app_sessions_dir.join(&session.id))
                .expect("session dir");
            std::fs::create_dir_all(storage.log_dir.join("app-sessions").join(&session.id))
                .expect("log dir");
        }
        runtime
            .inner
            .persisted_sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .extend([
                (expired.id.clone(), expired.clone()),
                (recent.id.clone(), recent.clone()),
            ]);

        let deleted = runtime.cleanup_expired_sessions_at(now, 7.0);

        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].id, expired.id);
        assert!(!storage.app_sessions_dir.join(&expired.id).exists());
        assert!(!storage
            .log_dir
            .join("app-sessions")
            .join(&expired.id)
            .exists());
        assert!(storage.app_sessions_dir.join(&recent.id).exists());
        let persisted = runtime
            .inner
            .persisted_sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!persisted.contains_key(&expired.id));
        assert!(persisted.contains_key(&recent.id));
    }

    #[test]
    fn maintenance_intervals_and_retention_match_the_node_contract() {
        assert_eq!(MAINTENANCE_INTERVAL, std::time::Duration::from_secs(21_600));
        assert_eq!(DEFAULT_SESSION_RETENTION_DAYS, 7.0);
        assert!(CLEANABLE_SESSION_STATUSES.contains(&"exited"));
        assert!(CLEANABLE_SESSION_STATUSES.contains(&"stopped"));
        assert!(CLEANABLE_SESSION_STATUSES.contains(&"failed"));
        assert_eq!(session_retention_days_from(None), 7.0);
        assert_eq!(session_retention_days_from(Some("0x10")), 16.0);
        assert_eq!(session_retention_days_from(Some("0b10")), 2.0);
        assert_eq!(session_retention_days_from(Some("17.5")), 17.5);
        assert_eq!(session_retention_days_from(Some("not-a-number")), 7.0);
        assert_eq!(session_retention_days_from(Some("Infinity")), 7.0);
    }

    #[test]
    fn session_timestamps_accept_javascript_date_parse_formats() {
        assert_eq!(
            parse_javascript_date("2026-11-02"),
            Some(1_793_577_600_000.0)
        );
        assert!(parse_javascript_date("2026-11-02 03:04:05").is_some());
        assert!(parse_javascript_date("2026-11-02T03:04:05Z").is_some());
        assert!(parse_javascript_date("not-a-date").is_none());
    }

    #[test]
    fn port_allocation_round_robins_from_the_current_cursor() {
        let next = Mutex::new(30002);
        let used = BTreeSet::new();

        assert_eq!(
            allocate_available_port(&next, 30001, 30003, &used, |_| true).expect("first"),
            30002
        );
        assert_eq!(
            allocate_available_port(&next, 30001, 30003, &used, |_| true).expect("second"),
            30003
        );
        assert_eq!(
            allocate_available_port(&next, 30001, 30003, &used, |_| true).expect("wrapped"),
            30001
        );
        assert_eq!(
            *next.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
            30002
        );
    }

    #[test]
    fn port_allocation_skips_recorded_and_unavailable_candidates() {
        let next = Mutex::new(30101);
        let used = BTreeSet::from([30101]);
        let mut probed = Vec::new();

        let port = allocate_available_port(&next, 30101, 30104, &used, |candidate| {
            probed.push(candidate);
            candidate != 30102
        })
        .expect("available port");

        assert_eq!(port, 30103);
        assert_eq!(probed, vec![30102, 30103]);
        assert_eq!(
            *next.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
            30104
        );
    }

    #[test]
    fn port_allocation_reports_exhaustion_without_advancing_the_cursor() {
        let next = Mutex::new(30202);
        let used = BTreeSet::from([30201, 30203]);

        let error = allocate_available_port(&next, 30201, 30203, &used, |_| false)
            .expect_err("allocation should fail");

        assert_eq!(error.code(), "APP_RESOURCE_EXHAUSTED");
        assert_eq!(
            error.to_string(),
            "No available allocation in range 30201-30203."
        );
        assert_eq!(
            *next.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
            30202
        );
    }

    #[test]
    fn os_probe_rejects_a_bound_loopback_port() {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .expect("ephemeral listener");
        let port = listener.local_addr().expect("local address").port();
        let next = Mutex::new(port);

        let error = allocate_available_port(&next, port, port, &BTreeSet::new(), is_port_available)
            .expect_err("bound port must be unavailable");

        assert_eq!(error.code(), "APP_RESOURCE_EXHAUSTED");
    }

    #[test]
    fn used_ports_include_session_and_shared_display_allocations() {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new(storage(root.path()), root.path());
        let session = session_with_allocated_ports();
        runtime
            .inner
            .sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session.id.clone(), Arc::new(SessionEntry::new(session)));
        runtime
            .inner
            .shared_displays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                "display-test".to_string(),
                SharedDisplayRuntime {
                    id: "display-test".to_string(),
                    display: ":101".to_string(),
                    vnc_port: 6103,
                    websockify_port: Some(7103),
                    x_pid: None,
                    wm_pid: None,
                    compositor_pid: None,
                    xauthority: None,
                    processes: Vec::new(),
                    app_session_ids: HashSet::new(),
                },
            );

        assert_eq!(
            runtime.used_ports(),
            BTreeSet::from([6102, 6103, 7102, 7103, 8102, 8103, 9202])
        );
    }

    #[test]
    fn vscode_web_session_merges_default_theme_without_overwriting_settings() {
        let root = tempfile::tempdir().expect("tempdir");
        let settings = root
            .path()
            .join("user-data")
            .join("User")
            .join("settings.json");
        std::fs::create_dir_all(settings.parent().expect("settings parent")).expect("settings dir");
        std::fs::write(
            &settings,
            r#"{"editor.fontSize":15,"workbench.colorTheme":"Custom"}"#,
        )
        .expect("existing settings");
        prepare_vscode_web_session(root.path());
        let value: Value = read_json(&settings).expect("settings json");
        assert_eq!(value["editor.fontSize"], 15);
        assert_eq!(value["workbench.colorTheme"], "Custom");
        assert_eq!(
            value["workbench.preferredDarkColorTheme"],
            "Default Dark Modern"
        );
    }

    #[test]
    fn under_drain_launches_are_rejected() {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new(storage(root.path()), root.path());
        runtime.begin_drain();
        let error = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(runtime.start("terminal-tty", AppLaunchOptions::default()))
            .expect_err("draining");
        assert_eq!(error.code(), "APP_RUNTIME_DRAINING");
    }

    #[tokio::test]
    async fn missing_private_apps_report_not_installed() {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new_with_managed_root(
            storage(root.path()),
            root.path(),
            Some(root.path().join("managed-apps")),
        );
        for id in ["codex", "claude", "opencode"] {
            let error = runtime
                .start(id, AppLaunchOptions::default())
                .await
                .expect_err("private package absent");
            assert_eq!(error.code(), "APP_DEPENDENCY_MISSING");
            assert!(error.to_string().contains("not installed in this instance"));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tty_session_starts_writes_and_stops() {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new(storage(root.path()), root.path());
        let session = runtime
            .start(
                "terminal-tty",
                AppLaunchOptions {
                    env: BTreeMap::from([("SHELL".to_string(), "/bin/sh".to_string())]),
                    args: vec!["-c".to_string(), "cat".to_string()],
                    ..AppLaunchOptions::default()
                },
            )
            .await
            .expect("tty session");
        assert_eq!(session.status, "running");
        let attachment = runtime.tty_attachment(&session.id).expect("attachment");
        attachment.write(b"hello\n").expect("write");
        let stopped = runtime.stop_session(&session.id).await.expect("stop");
        assert_eq!(stopped.status, "stopped");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_session_requests_stop_then_escalates_the_whole_session_after_the_grace_period() {
        use std::time::{Duration, Instant};

        let root = tempfile::tempdir().expect("tempdir");
        let ready = root.path().join("ready");
        let runtime = AppRuntime::new(storage(root.path()), root.path());
        let session = runtime
            .start(
                "terminal-tty",
                AppLaunchOptions {
                    env: BTreeMap::from([("SHELL".to_string(), "/bin/sh".to_string())]),
                    args: vec![
                        "-c".to_string(),
                        format!(
                            "trap '' TERM; : > '{}'; while :; do sleep 1; done",
                            ready.display()
                        ),
                    ],
                    ..AppLaunchOptions::default()
                },
            )
            .await
            .expect("tty session");
        let entry = runtime
            .inner
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&session.id)
            .cloned()
            .expect("session entry");
        assert!(!entry.all_process_pids().is_empty());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !ready.exists() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(ready.exists(), "shell did not install its TERM trap");

        let started = Instant::now();
        let stopped = runtime.stop_session(&session.id).await.expect("stop");
        assert_eq!(stopped.status, "stopped");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "stop_session must return without waiting for escalation"
        );

        let remaining = entry.wait_for_stop_escalation().await;
        assert!(
            remaining.is_empty(),
            "process groups still remain: {remaining:?}"
        );
        assert!(
            started.elapsed() >= Duration::from_secs(4),
            "SIGKILL was sent before the five-second grace period: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn vnc_and_tty_targets_do_not_add_the_node_runtime_restrictions() {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new(storage(root.path()), root.path());

        let mut vnc = session_with_allocated_ports();
        vnc.id = "app_vnc_stopped".to_string();
        vnc.status = "stopped".to_string();
        runtime.insert_session(vnc);
        assert_eq!(
            runtime.vnc_target("app_vnc_stopped"),
            Some(("127.0.0.1".to_string(), 6102))
        );

        let mut tty = session_with_allocated_ports();
        tty.id = "app_tty_without_metadata".to_string();
        tty.tty = None;
        runtime.insert_session(tty);
        assert!(runtime.tty_attachment("app_tty_without_metadata").is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tty_attachments_include_the_current_screen_snapshot() {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new(storage(root.path()), root.path());
        let session = runtime
            .start(
                "terminal-tty",
                AppLaunchOptions {
                    env: BTreeMap::from([("SHELL".to_string(), "/bin/sh".to_string())]),
                    args: vec![
                        "-c".to_string(),
                        "printf 'reconnect-marker\\n'; sleep 5".to_string(),
                    ],
                    ..AppLaunchOptions::default()
                },
            )
            .await
            .expect("tty session");
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let snapshot = runtime
            .tty_attachment(&session.id)
            .expect("attachment")
            .snapshot()
            .expect("snapshot");
        assert!(snapshot.data.contains("reconnect-marker"));
        assert_eq!(snapshot.pending_escape, "");
        assert_eq!(
            (snapshot.cols, snapshot.rows),
            (DEFAULT_TTY_COLS, DEFAULT_TTY_ROWS)
        );
        let _ = runtime.stop_session(&session.id).await;
    }

    #[tokio::test]
    async fn missing_app_sessions_use_the_session_not_found_code() {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = AppRuntime::new(storage(root.path()), root.path());

        let restart = runtime.restart("missing").await.expect_err("restart");
        assert_eq!(restart.code(), "APP_SESSION_NOT_FOUND");
        let delete = runtime.delete("missing").await.expect_err("delete");
        assert_eq!(delete.code(), "APP_SESSION_NOT_FOUND");
        let logs = runtime.read_logs("missing", 4096.0).expect_err("read logs");
        assert_eq!(logs.code(), "APP_SESSION_NOT_FOUND");
        let screenshot = runtime.screenshot("missing").await.expect_err("screenshot");
        assert_eq!(screenshot.code(), "APP_SESSION_NOT_FOUND");
        let automation = runtime
            .automation_status("missing")
            .await
            .expect_err("automation");
        assert_eq!(automation.code(), "APP_SESSION_NOT_FOUND");
        let rename = runtime
            .rename("missing", "Title")
            .expect_err("rename session");
        assert_eq!(rename.code(), "APP_SESSION_NOT_FOUND");
    }

    #[cfg(unix)]
    #[test]
    fn shared_codex_exit_metadata_distinguishes_clean_and_failed_exits() {
        let exited = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .status()
            .expect("clean exit");
        assert_eq!(
            app_server_exit_fields(Some(exited)),
            ("exited", Some(0), None)
        );

        let failed = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 7"])
            .status()
            .expect("failed exit");
        assert_eq!(
            app_server_exit_fields(Some(failed)),
            ("failed", Some(7), None)
        );
        assert_eq!(app_server_exit_fields(None), ("failed", None, None));
    }
    #[test]
    fn utf8_stream_decoder_preserves_codepoints_split_across_chunks() {
        let mut pending = Vec::new();
        assert_eq!(decode_utf8_stream(&mut pending, &[0xe4, 0xb8]), "");
        assert_eq!(decode_utf8_stream(&mut pending, &[0xad]), "中");
        assert_eq!(decode_utf8_stream(&mut pending, b"ok"), "ok");
    }

    #[cfg(unix)]
    #[test]
    fn signal_names_match_node_exit_signal_strings() {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            signal_name(std::process::ExitStatus::from_raw(15)),
            Some("SIGTERM".to_string())
        );
        assert_eq!(
            signal_name(std::process::ExitStatus::from_raw(9)),
            Some("SIGKILL".to_string())
        );
    }
}
