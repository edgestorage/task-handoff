use chrono::{DateTime, Utc};
use controlled_instance_app_runtime::resolve_executable;
use controlled_instance_core::{paths::StoragePaths, process::hostname};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use crate::{
    ai_session_authority::AiSessionAuthority, app_session_authority::AppSessionAuthority,
    InstanceConfig,
};

pub(crate) fn instance_diagnostics(
    config: &InstanceConfig,
    started_at: &str,
    ai_sessions: &AiSessionAuthority,
    app_sessions: &AppSessionAuthority,
    message_delta_coalescing: Value,
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

    let commands = command_diagnostics(required_capabilities.as_ref());
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
                "discoveryUnchanged": 0,
                "discoveryCorrections": 0,
                "messageDeltaCoalescing": message_delta_coalescing,
            },
            "app": {
                "streamId": app_sessions.stream_id(),
                "revision": app_sessions.revision(),
                "retainedEventCount": app_sessions.retained_event_count(),
                "unchangedRefreshes": 0,
            },
        },
    })
}

fn command_diagnostics(required_capabilities: Option<&BTreeSet<String>>) -> Vec<Value> {
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
        .and_then(|started| {
            Utc::now()
                .signed_duration_since(started.with_timezone(&Utc))
                .num_seconds()
                .try_into()
                .ok()
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
        );
        assert!(value.get("ok").is_some());
        assert!(value["image"].is_object());
        assert!(value["runtime"]["linuxRuntime"].is_boolean());
        assert!(value["noVnc"]["available"].is_boolean());
        assert_eq!(value["sessionStreams"]["ai"]["streamId"], "ais_test");
        assert_eq!(value["sessionStreams"]["app"]["streamId"], "aps_test");
    }
}
