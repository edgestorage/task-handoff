use chrono::{DateTime, Utc};
use controlled_instance_app_runtime::resolve_executable;
use controlled_instance_core::{paths::StoragePaths, process::hostname};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

use crate::{
    ai_session_authority::AiSessionAuthority, app_session_authority::AppSessionAuthority,
    state::StreamDiagnostics, InstanceConfig,
};

pub(crate) fn log_controlled_instance_start(paths: &StoragePaths) {
    if !env_flag("TASK_HANDOFF_DIAGNOSTIC_LOGS") {
        return;
    }
    let _ = append_start_diagnostic(&paths.log_dir, &paths.data_dir);
}

fn append_start_diagnostic(log_dir: &Path, data_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(log_dir)?;
    let log_path = log_dir.join("controlled-instance.log");
    let entry = json!({
        "time": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "event": "controlled_instance_start",
        "component": "controlled-instance",
        "controlMode": std::env::var("TASK_HANDOFF_CONTROL_MODE").ok(),
        "diagnosticLogs": std::env::var("TASK_HANDOFF_DIAGNOSTIC_LOGS").ok(),
        "dataDir": data_dir,
        "logDir": log_dir,
        "logPath": log_path,
        "process": process_snapshot(),
    });
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(log_path)?;
    let encoded = serde_json::to_string(&entry)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    writeln!(file, "{encoded}")
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

fn process_snapshot() -> Value {
    let pid = std::process::id();
    let ppid = parent_process_id();
    json!({
        "pid": pid,
        "ppid": ppid,
        "cwd": std::env::current_dir().ok(),
        "argv": std::env::args().collect::<Vec<_>>(),
        "parent": parent_process(ppid),
        "env": relevant_env(),
    })
}

fn relevant_env() -> Value {
    let entries = std::env::vars()
        .filter(|(key, _)| {
            key.starts_with("TASK_HANDOFF")
                || key.starts_with("CODEX")
                || key.starts_with("CLAUDE")
                || matches!(key.as_str(), "PWD" | "OLDPWD" | "SHELL" | "TERM")
        })
        .map(|(key, value)| {
            let secret = [
                "TOKEN",
                "KEY",
                "SECRET",
                "AUTH",
                "PASSWORD",
                "COOKIE",
                "CONFIG_CONTENT",
            ]
            .iter()
            .any(|needle| key.to_ascii_uppercase().contains(needle));
            (
                key,
                Value::String(if secret {
                    "[redacted]".to_string()
                } else {
                    value
                }),
            )
        })
        .collect::<BTreeMap<_, _>>();
    Value::Object(entries.into_iter().collect())
}

fn parent_process(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let pid = pid.to_string();
    let output = std::process::Command::new("ps")
        .args(["-p", pid.as_str(), "-o", "pid=,ppid=,comm=,args="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn parent_process_id() -> u32 {
    #[cfg(unix)]
    {
        std::os::unix::process::parent_id()
    }
    #[cfg(not(unix))]
    {
        0
    }
}

pub(crate) fn instance_diagnostics(
    config: &InstanceConfig,
    started_at: &str,
    ai_sessions: &AiSessionAuthority,
    app_sessions: &AppSessionAuthority,
    message_delta_coalescing: Value,
    stream_diagnostics: &StreamDiagnostics,
) -> Value {
    let no_vnc_root = resolve_novnc_root();
    let profile = env_optional("TASK_HANDOFF_IMAGE_PROFILE");
    let declared_capabilities = env_optional("TASK_HANDOFF_IMAGE_CAPABILITIES")
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let required_capabilities = env_optional("TASK_HANDOFF_IMAGE_CAPABILITIES").map(|value| {
        value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect::<BTreeSet<_>>()
    });

    let root = std::env::var_os("TASK_HANDOFF_MANAGED_APP_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| config.storage_paths.data_dir.join("managed-apps"));
    let catalog = controlled_instance_app_runtime::AppCatalogRepository::new_with_managed_root(
        &config.storage_paths.app_catalog_dir,
        Some(root),
    );
    let commands = command_diagnostics(required_capabilities.as_ref(), &catalog);
    let storage = storage_diagnostics(&config.storage_paths);
    let linux_runtime = std::env::consts::OS == "linux";
    let gui_required = required_capabilities.as_ref().is_none_or(|capabilities| {
        ["browser", "gui-terminal", "vscode-web"]
            .iter()
            .any(|capability| capabilities.contains(*capability))
    });
    let required_runtime_ready = linux_runtime
        && commands.iter().all(|command| {
            !command
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || command
                    .get("available")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
        && (!gui_required || no_vnc_root.is_some())
        && storage.iter().all(|entry| {
            entry
                .get("writable")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });

    let mut image = Map::new();
    if let Some(profile) = profile {
        image.insert("profile".to_string(), Value::String(profile));
    }
    image.insert(
        "capabilities".to_string(),
        Value::Array(
            declared_capabilities
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );

    let mut no_vnc = Map::new();
    no_vnc.insert("available".to_string(), Value::Bool(no_vnc_root.is_some()));
    if let Some(root) = &no_vnc_root {
        no_vnc.insert(
            "root".to_string(),
            Value::String(root.display().to_string()),
        );
    }

    json!({
        "ok": required_runtime_ready,
        "image": image,
        "runtime": {
            "platform": node_platform(),
            "arch": node_arch(),
            "linuxRuntime": linux_runtime,
            // The UI field predates the Rust runtime. Keep the wire field and
            // report the runtime implementation instead of claiming Node.
            "node": format!("rust {}", env!("CARGO_PKG_VERSION")),
            "pid": std::process::id(),
            "hostname": hostname(),
            "uptimeSeconds": uptime_seconds(started_at),
        },
        "noVnc": no_vnc,
        "commands": commands,
        "storage": storage,
        "sessionStreams": {
            "ai": {
                "streamId": ai_sessions.stream_id(),
                "revision": ai_sessions.revision(),
                "retainedEventCount": ai_sessions.retained_event_count(),
                "discoveryUnchanged": stream_diagnostics.ai_discovery_unchanged.load(std::sync::atomic::Ordering::Relaxed),
                "discoveryCorrections": stream_diagnostics.ai_discovery_corrections.load(std::sync::atomic::Ordering::Relaxed),
                "messageDeltaCoalescing": message_delta_coalescing,
            },
            "app": {
                "streamId": app_sessions.stream_id(),
                "revision": app_sessions.revision(),
                "retainedEventCount": app_sessions.retained_event_count(),
                "unchangedRefreshes": stream_diagnostics.app_unchanged_refreshes.load(std::sync::atomic::Ordering::Relaxed),
            },
        },
    })
}

fn command_diagnostics(
    required_capabilities: Option<&BTreeSet<String>>,
    catalog: &controlled_instance_app_runtime::AppCatalogRepository,
) -> Vec<Value> {
    let commands = [
        (
            "Xvfb".to_string(),
            "Xvfb".to_string(),
            vec!["browser", "gui-terminal", "vscode-web"],
        ),
        (
            "openbox".to_string(),
            "openbox".to_string(),
            vec!["browser", "gui-terminal", "vscode-web"],
        ),
        (
            "picom".to_string(),
            "picom".to_string(),
            vec!["browser", "gui-terminal", "vscode-web"],
        ),
        (
            "x11vnc".to_string(),
            "x11vnc".to_string(),
            vec!["browser", "gui-terminal", "vscode-web"],
        ),
        (
            "websockify".to_string(),
            "websockify".to_string(),
            vec!["browser", "gui-terminal", "vscode-web"],
        ),
        (
            "vncserver".to_string(),
            "vncserver".to_string(),
            vec!["browser", "gui-terminal", "vscode-web"],
        ),
        (
            "vncpasswd".to_string(),
            "vncpasswd".to_string(),
            vec!["browser", "gui-terminal", "vscode-web"],
        ),
        (
            "openssl".to_string(),
            "openssl".to_string(),
            vec!["browser", "gui-terminal", "vscode-web"],
        ),
        (
            "xrdb".to_string(),
            "xrdb".to_string(),
            vec!["browser", "gui-terminal", "vscode-web"],
        ),
        (
            "xrandr".to_string(),
            "xrandr".to_string(),
            vec!["browser", "gui-terminal", "vscode-web"],
        ),
        (
            "chromium".to_string(),
            env_optional("TASK_HANDOFF_CHROMIUM_COMMAND").unwrap_or_else(|| "chromium".to_string()),
            vec!["browser"],
        ),
        (
            "code-server".to_string(),
            env_optional("TASK_HANDOFF_VSCODE_WEB_COMMAND")
                .unwrap_or_else(|| "code-server".to_string()),
            vec!["vscode-web"],
        ),
        (
            "xterm".to_string(),
            env_optional("TASK_HANDOFF_XTERM_COMMAND").unwrap_or_else(|| "xterm".to_string()),
            vec!["gui-terminal"],
        ),
        (
            "import".to_string(),
            "import".to_string(),
            vec!["browser", "gui-terminal", "vscode-web"],
        ),
        (
            "codex".to_string(),
            env_optional("TASK_HANDOFF_CODEX_COMMAND").unwrap_or_else(|| "codex".to_string()),
            vec!["codex"],
        ),
        (
            "claude".to_string(),
            env_optional("TASK_HANDOFF_CLAUDE_COMMAND")
                .or_else(|| env_optional("CLAUDE_CLI_PATH"))
                .unwrap_or_else(|| "claude".to_string()),
            vec!["claude"],
        ),
        (
            "opencode".to_string(),
            env_optional("TASK_HANDOFF_OPENCODE_COMMAND").unwrap_or_else(|| "opencode".to_string()),
            vec!["opencode"],
        ),
    ];

    commands
        .into_iter()
        .map(|(label, command, required_for)| {
            let command = catalog
                .find(&label)
                .and_then(|entry| entry.app.command)
                .unwrap_or(command);
            let path = resolve_executable(&command, &BTreeMap::new(), None);
            let required = required_capabilities.is_none_or(|capabilities| {
                required_for
                    .iter()
                    .any(|capability| capabilities.contains(*capability))
            });
            let mut entry = Map::new();
            entry.insert("name".to_string(), Value::String(label));
            entry.insert("command".to_string(), Value::String(command));
            entry.insert("available".to_string(), Value::Bool(path.is_some()));
            if let Some(path) = path {
                entry.insert(
                    "path".to_string(),
                    Value::String(path.display().to_string()),
                );
            }
            entry.insert(
                "requiredFor".to_string(),
                Value::Array(
                    required_for
                        .into_iter()
                        .map(|capability| Value::String(capability.to_string()))
                        .collect(),
                ),
            );
            entry.insert("required".to_string(), Value::Bool(required));
            Value::Object(entry)
        })
        .collect()
}

fn storage_diagnostics(paths: &StoragePaths) -> Vec<Value> {
    [
        ("configPath", &paths.config_path),
        ("dataDir", &paths.data_dir),
        ("appCatalogDir", &paths.app_catalog_dir),
        ("appSessionsDir", &paths.app_sessions_dir),
        ("triggersDir", &paths.triggers_dir),
        ("runtimeDir", &paths.runtime_dir),
        ("eventsDir", &paths.events_dir),
        ("artifactDir", &paths.artifact_dir),
        ("logDir", &paths.log_dir),
        ("webTokenPath", &paths.web_token_path),
    ]
    .into_iter()
    .map(|(key, path)| {
        let target = path.clone();
        let path = path.display().to_string();
        let metadata = std::fs::metadata(&target).ok();
        let exists = metadata.is_some();
        let entry_type = match metadata.as_ref() {
            Some(metadata) if metadata.is_file() => "file",
            Some(metadata) if metadata.is_dir() => "directory",
            _ => "missing",
        };
        let is_file = key.ends_with("Path");
        let access_path = if exists {
            target.clone()
        } else if is_file {
            nearest_existing_directory(
                target
                    .parent()
                    .unwrap_or_else(|| Path::new("/"))
                    .to_path_buf(),
            )
        } else {
            nearest_existing_directory(target.clone())
        };
        json!({
            "key": key,
            "path": path,
            "exists": exists,
            "type": entry_type,
            "writable": is_writable(&access_path, exists && entry_type == "file"),
        })
    })
    .collect()
}

fn nearest_existing_directory(mut current: PathBuf) -> PathBuf {
    loop {
        if let Ok(metadata) = std::fs::metadata(&current) {
            return if metadata.is_dir() {
                current
            } else {
                current.parent().map(Path::to_path_buf).unwrap_or(current)
            };
        }
        let Some(parent) = current.parent() else {
            return current;
        };
        let parent = parent.to_path_buf();
        if parent == current {
            return current;
        }
        current = parent;
    }
}

#[cfg(unix)]
fn is_writable(path: &Path, _file: bool) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a NUL-terminated, valid C string for the duration of
    // the call and access(2) does not retain it.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
fn is_writable(path: &Path, file: bool) -> bool {
    if file {
        return std::fs::OpenOptions::new().write(true).open(path).is_ok();
    }
    std::fs::metadata(path)
        .map(|metadata| !metadata.permissions().readonly())
        .unwrap_or(false)
}

fn uptime_seconds(started_at: &str) -> u64 {
    DateTime::parse_from_rfc3339(started_at)
        .ok()
        .map(|started| {
            let milliseconds = Utc::now()
                .signed_duration_since(started.with_timezone(&Utc))
                .num_milliseconds();
            (milliseconds.max(0) as f64 / 1_000.0).round() as u64
        })
        .unwrap_or(0)
}

fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        platform => platform,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "arm" => "arm",
        arch => arch,
    }
}

fn env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn resolve_novnc_root() -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("TASK_HANDOFF_NOVNC_ROOT") {
        let configured = configured.to_string_lossy();
        let configured = configured.trim();
        if !configured.is_empty() {
            let root = PathBuf::from(configured);
            if root.join("vnc.html").exists() {
                return Some(root);
            }
        }
    }
    [
        "/usr/share/novnc",
        "/usr/share/noVNC",
        "/usr/local/share/novnc",
        "/usr/local/share/noVNC",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|root| root.join("vnc.html").exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_diagnostics_keep_the_node_order_and_shapes() {
        let root = tempfile::tempdir().expect("tempdir");
        let paths = StoragePaths {
            config_path: root.path().join("config.json"),
            data_dir: root.path().to_path_buf(),
            app_catalog_dir: root.path().join("app-catalog"),
            app_sessions_dir: root.path().join("app-sessions"),
            triggers_dir: root.path().join("triggers"),
            runtime_dir: root.path().join("runtime"),
            events_dir: root.path().join("events"),
            artifact_dir: root.path().join("artifacts"),
            log_dir: root.path().join("logs"),
            web_token_path: root.path().join("web-token"),
        };
        let entries = storage_diagnostics(&paths);
        assert_eq!(entries.len(), 10);
        assert_eq!(entries[0]["key"], "configPath");
        assert_eq!(entries[0]["type"], "missing");
        assert_eq!(entries[1]["type"], "directory");
        assert_eq!(entries[1]["writable"], true);
    }

    #[test]
    fn diagnostics_include_the_stream_and_runtime_contracts() {
        let root = tempfile::tempdir().expect("tempdir");
        let storage_paths = StoragePaths {
            config_path: root.path().join("config.json"),
            data_dir: root.path().to_path_buf(),
            app_catalog_dir: root.path().join("app-catalog"),
            app_sessions_dir: root.path().join("app-sessions"),
            triggers_dir: root.path().join("triggers"),
            runtime_dir: root.path().join("runtime"),
            events_dir: root.path().join("events"),
            artifact_dir: root.path().join("artifacts"),
            log_dir: root.path().join("logs"),
            web_token_path: root.path().join("web-token"),
        };
        let config = InstanceConfig::for_test(root.path().to_path_buf(), storage_paths);
        let ai = AiSessionAuthority::new(
            "inst_test",
            "ais_test",
            "2026-11-02T00:00:00.000Z".to_string(),
        );
        let app = AppSessionAuthority::new(
            "inst_test",
            "aps_test",
            "2026-11-02T00:00:00.000Z".to_string(),
        );
        let value = instance_diagnostics(
            &config,
            "2026-11-02T00:00:00.000Z",
            &ai,
            &app,
            json!({
                "windowMs": 32,
                "pendingMessageCount": 0,
                "rawDeltaCount": 0,
                "emittedEventCount": 0,
                "totalBatchSize": 0,
                "maxBatchSize": 0,
                "flushReasons": {},
                "totalFirstBatchWaitMs": 0,
                "maxFirstBatchWaitMs": 0,
            }),
            &StreamDiagnostics::default(),
        );
        assert!(value.get("ok").is_some());
        assert!(value["image"].is_object());
        assert!(value["runtime"]["linuxRuntime"].is_boolean());
        assert!(value["noVnc"]["available"].is_boolean());
        assert_eq!(value["sessionStreams"]["ai"]["streamId"], "ais_test");
        assert_eq!(value["sessionStreams"]["app"]["streamId"], "aps_test");
    }

    #[test]
    fn startup_diagnostic_writes_jsonl_with_private_permissions() {
        let root = tempfile::tempdir().expect("tempdir");
        let log_dir = root.path().join("logs");
        let data_dir = root.path().join("data");
        std::fs::create_dir_all(&data_dir).expect("data dir");
        append_start_diagnostic(&log_dir, &data_dir).expect("diagnostic");

        let log_path = log_dir.join("controlled-instance.log");
        let content = std::fs::read_to_string(&log_path).expect("diagnostic log");
        let line: Value = serde_json::from_str(content.trim()).expect("jsonl");
        assert_eq!(line["event"], "controlled_instance_start");
        assert_eq!(line["component"], "controlled-instance");
        assert_eq!(line["process"]["pid"], std::process::id());
        assert!(line.get("time").and_then(Value::as_str).is_some());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(log_path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
}
