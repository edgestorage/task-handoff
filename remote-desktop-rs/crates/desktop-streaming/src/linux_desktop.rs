//! Linux display and X11 session resolution shared by preflight and runtime.
//!
//! This module never starts a process. It only probes an existing display,
//! discovers a launchable desktop, and returns an ownership plan. The surface
//! keeper executes that plan and remains the sole owner of processes it starts.
use crate::{
    error::BackendError,
    platform::linux::{self, Config},
};
use std::{
    collections::HashSet,
    ffi::OsString,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

const SESSION_DIRECTORIES: [&str; 2] = ["/usr/local/share/xsessions", "/usr/share/xsessions"];
const SESSION_SELECTOR_ENV: &str = "TASK_HANDOFF_DESKTOP_SESSION";
const MAX_SESSION_FILES: usize = 128;
const MAX_SESSION_BYTES: u64 = 64 * 1024;
const MAX_SESSION_LINE_BYTES: usize = 4 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DisplayOwnership {
    Attached,
    Owned,
}

#[derive(Clone)]
pub(crate) enum SessionLaunch {
    Standard {
        id: String,
        name: String,
        desktop_names: Vec<String>,
        command: Vec<String>,
    },
    Fallback,
}

#[derive(Clone)]
pub(crate) enum DesktopAction {
    Reuse,
    Launch(SessionLaunch),
}

#[derive(Clone)]
pub(crate) struct DisplayPlan {
    pub config: Config,
    pub ownership: DisplayOwnership,
    pub action: DesktopAction,
}

impl DisplayPlan {
    pub fn desktop_source(&self) -> &'static str {
        match self.ownership {
            DisplayOwnership::Attached => "host-desktop",
            DisplayOwnership::Owned => "instance-virtual-display",
        }
    }
}

#[derive(Clone)]
struct SessionEntry {
    id: String,
    name: String,
    desktop_names: Vec<String>,
    command: Vec<String>,
}

struct ResolverEnvironment {
    display: Option<String>,
    authority: Option<PathBuf>,
    session_type: Option<String>,
    selector: Option<String>,
    path: OsString,
    session_directories: Vec<PathBuf>,
}

pub(crate) fn resolve() -> anyhow::Result<DisplayPlan> {
    let environment = ResolverEnvironment {
        display: std::env::var("DISPLAY")
            .ok()
            .filter(|value| !value.is_empty()),
        authority: std::env::var_os("XAUTHORITY").map(PathBuf::from),
        session_type: std::env::var("XDG_SESSION_TYPE").ok(),
        selector: std::env::var(SESSION_SELECTOR_ENV)
            .ok()
            .filter(|value| !value.is_empty()),
        path: std::env::var_os("PATH").unwrap_or_default(),
        session_directories: SESSION_DIRECTORIES.iter().map(PathBuf::from).collect(),
    };
    resolve_with(&environment, linux::probe)
}

fn resolve_with<F>(environment: &ResolverEnvironment, probe: F) -> anyhow::Result<DisplayPlan>
where
    F: Fn(&Config) -> anyhow::Result<linux::Probe>,
{
    if let Some(display) = environment.display.as_deref() {
        let config = Config {
            display: display.to_owned(),
            cookie: None,
            authority: environment.authority.clone(),
            include_cursor: true,
        };
        if let Ok(probed) = probe(&config) {
            let action = if probed.has_window_manager {
                DesktopAction::Reuse
            } else {
                DesktopAction::Launch(resolve_launch(environment)?)
            };
            return Ok(DisplayPlan {
                config,
                ownership: DisplayOwnership::Attached,
                action,
            });
        }
    }

    anyhow::ensure!(
        environment
            .session_type
            .as_deref()
            .is_none_or(|kind| !kind.eq_ignore_ascii_case("wayland")),
        BackendError::WaylandUnsupported
    );
    anyhow::ensure!(
        command_in_path("Xvfb", &environment.path),
        BackendError::DesktopUnavailable
    );
    let action = DesktopAction::Launch(resolve_launch(environment)?);
    Ok(DisplayPlan {
        config: Config {
            display: String::new(),
            cookie: None,
            authority: None,
            include_cursor: true,
        },
        ownership: DisplayOwnership::Owned,
        action,
    })
}

fn resolve_launch(environment: &ResolverEnvironment) -> anyhow::Result<SessionLaunch> {
    let sessions = discover_sessions(&environment.session_directories, &environment.path)?;
    if sessions.is_empty() {
        let fallback = ["openbox", "tint2", "jgmenu"]
            .iter()
            .all(|command| command_in_path(command, &environment.path));
        anyhow::ensure!(fallback, BackendError::DesktopUnavailable);
        return Ok(SessionLaunch::Fallback);
    }

    anyhow::ensure!(
        command_in_path("dbus-run-session", &environment.path),
        BackendError::DesktopUnavailable
    );
    let selected = select_session(&sessions, environment.selector.as_deref())?;
    Ok(SessionLaunch::Standard {
        id: selected.id.clone(),
        name: selected.name.clone(),
        desktop_names: selected.desktop_names.clone(),
        command: selected.command.clone(),
    })
}

fn select_session<'a>(
    sessions: &'a [SessionEntry],
    selector: Option<&str>,
) -> anyhow::Result<&'a SessionEntry> {
    if let Some(selector) = selector {
        let matches = sessions
            .iter()
            .filter(|session| session_matches(session, selector))
            .collect::<Vec<_>>();
        anyhow::ensure!(matches.len() == 1, BackendError::DesktopUnavailable);
        return Ok(matches[0]);
    }
    anyhow::ensure!(sessions.len() == 1, BackendError::DesktopUnavailable);
    Ok(&sessions[0])
}

fn session_matches(session: &SessionEntry, selector: &str) -> bool {
    session.id.eq_ignore_ascii_case(selector)
        || session.name.eq_ignore_ascii_case(selector)
        || session
            .desktop_names
            .iter()
            .any(|name| name.eq_ignore_ascii_case(selector))
}

fn discover_sessions(
    directories: &[PathBuf],
    path: &OsString,
) -> anyhow::Result<Vec<SessionEntry>> {
    let mut seen = HashSet::new();
    let mut sessions = Vec::new();
    let mut file_count = 0;
    for directory in directories {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        let mut files = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "desktop")
            })
            .collect::<Vec<_>>();
        files.sort();
        for file in files {
            file_count += 1;
            anyhow::ensure!(
                file_count <= MAX_SESSION_FILES,
                BackendError::DesktopUnavailable
            );
            let Ok(metadata) = std::fs::metadata(&file) else {
                continue;
            };
            if !metadata.is_file() || metadata.len() > MAX_SESSION_BYTES {
                continue;
            }
            let Ok(bytes) = std::fs::read(&file) else {
                continue;
            };
            let Some(session) = parse_session(&file, &bytes, path) else {
                continue;
            };
            if seen.insert(session.id.clone()) {
                sessions.push(session);
            }
        }
    }
    Ok(sessions)
}

fn parse_session(file: &Path, bytes: &[u8], path: &OsString) -> Option<SessionEntry> {
    let id = file.file_stem()?.to_str()?.to_owned();
    let text = std::str::from_utf8(bytes).ok()?;
    let mut in_desktop_entry = false;
    let mut found_desktop_entry = false;
    let mut hidden = false;
    let mut name = None;
    let mut exec = None;
    let mut try_exec = None;
    let mut desktop_names = Vec::new();

    for line in text.lines() {
        if line.len() > MAX_SESSION_LINE_BYTES {
            return None;
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            if in_desktop_entry || found_desktop_entry {
                break;
            }
            in_desktop_entry = line == "[Desktop Entry]";
            found_desktop_entry |= in_desktop_entry;
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = unescape_value(value.trim());
        match key.trim() {
            "Hidden" => hidden = value.eq_ignore_ascii_case("true"),
            "Name" => name = Some(value),
            "Exec" => exec = Some(value),
            "TryExec" => try_exec = Some(value),
            "DesktopNames" => {
                desktop_names = value
                    .split(';')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect()
            }
            _ => {}
        }
    }

    if !found_desktop_entry || hidden {
        return None;
    }
    if let Some(try_exec) = try_exec {
        if !command_in_path(&try_exec, path) {
            return None;
        }
    }
    let mut command = shlex::split(&exec?)?;
    command = normalize_field_codes(command)?;
    let executable = command.first()?;
    if !command_in_path(executable, path) {
        return None;
    }
    Some(SessionEntry {
        name: name.unwrap_or_else(|| id.clone()),
        id,
        desktop_names,
        command,
    })
}

fn normalize_field_codes(tokens: Vec<String>) -> Option<Vec<String>> {
    let mut normalized = Vec::with_capacity(tokens.len());
    for token in tokens {
        let mut value = String::with_capacity(token.len());
        let mut chars = token.chars();
        while let Some(character) = chars.next() {
            if character != '%' {
                value.push(character);
                continue;
            }
            match chars.next()? {
                '%' => value.push('%'),
                'f' | 'F' | 'u' | 'U' | 'i' | 'c' | 'k' => {}
                _ => return None,
            }
        }
        if !value.is_empty() {
            normalized.push(value);
        }
    }
    (!normalized.is_empty()).then_some(normalized)
}

fn unescape_value(value: &str) -> String {
    let mut unescaped = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            unescaped.push(character);
            continue;
        }
        match chars.next() {
            Some('s') => unescaped.push(' '),
            Some('n') => unescaped.push('\n'),
            Some('t') => unescaped.push('\t'),
            Some('r') => unescaped.push('\r'),
            Some('\\') => unescaped.push('\\'),
            Some(other) => {
                unescaped.push('\\');
                unescaped.push(other);
            }
            None => unescaped.push('\\'),
        }
    }
    unescaped
}

fn command_in_path(command: &str, path: &OsString) -> bool {
    let command = Path::new(command);
    if command.components().count() > 1 {
        return is_executable(command);
    }
    std::env::split_paths(path).any(|directory| is_executable(&directory.join(command)))
}

fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn executable(path: &Path) {
        std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn environment(directory: &Path) -> ResolverEnvironment {
        let bin = directory.join("bin");
        let sessions = directory.join("sessions");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        for name in ["Xvfb", "dbus-run-session", "openbox", "tint2", "jgmenu"] {
            executable(&bin.join(name));
        }
        ResolverEnvironment {
            display: None,
            authority: None,
            session_type: None,
            selector: None,
            path: bin.as_os_str().to_owned(),
            session_directories: vec![sessions],
        }
    }

    fn session_executable(environment: &ResolverEnvironment) -> PathBuf {
        let path = Path::new(&environment.path).join("session");
        executable(&path);
        path
    }

    fn probe_without_window_manager(_: &Config) -> anyhow::Result<linux::Probe> {
        Ok(linux::Probe {
            has_window_manager: false,
        })
    }

    #[test]
    fn parses_standard_session_and_drops_safe_field_codes() {
        let directory = tempfile::tempdir().unwrap();
        let environment = environment(directory.path());
        let session = session_executable(&environment);
        std::fs::write(
            environment.session_directories[0].join("xfce.desktop"),
            format!(
                "[Desktop Entry]\nType=Application\nName=Xfce Session\nTryExec={}\nExec={} --disable-foo %U\nDesktopNames=Xfce;XFCE;\n",
                session.display(),
                session.display()
            ),
        )
        .unwrap();
        let plan = resolve_with(&environment, probe_without_window_manager).unwrap();
        match plan.action {
            DesktopAction::Launch(SessionLaunch::Standard { name, command, .. }) => {
                assert_eq!(name, "Xfce Session");
                assert_eq!(
                    command,
                    vec![
                        session.to_string_lossy().to_string(),
                        "--disable-foo".into()
                    ]
                );
            }
            _ => panic!("expected standard session"),
        }
    }

    #[test]
    fn hidden_missing_tryexec_and_unknown_field_codes_are_ignored() {
        let directory = tempfile::tempdir().unwrap();
        let environment = environment(directory.path());
        let sessions = &environment.session_directories[0];
        std::fs::write(
            sessions.join("hidden.desktop"),
            "[Desktop Entry]\nHidden=true\nTryExec=/bin/sh\nExec=/bin/sh\n",
        )
        .unwrap();
        std::fs::write(
            sessions.join("missing.desktop"),
            "[Desktop Entry]\nTryExec=/definitely/missing\nExec=/bin/sh\n",
        )
        .unwrap();
        std::fs::write(
            sessions.join("invalid.desktop"),
            "[Desktop Entry]\nTryExec=/bin/sh\nExec=/bin/sh %Z\n",
        )
        .unwrap();
        let plan = resolve_with(&environment, probe_without_window_manager).unwrap();
        assert!(matches!(
            plan.action,
            DesktopAction::Launch(SessionLaunch::Fallback)
        ));
    }

    #[test]
    fn selector_resolves_multiple_sessions_and_ambiguity_fails() {
        let directory = tempfile::tempdir().unwrap();
        let mut environment = environment(directory.path());
        let session = session_executable(&environment);
        let command = session.to_string_lossy();
        for id in ["xfce", "lxqt"] {
            std::fs::write(
                environment.session_directories[0].join(format!("{id}.desktop")),
                format!("[Desktop Entry]\nName={id}\nTryExec={command}\nExec={command}\n"),
            )
            .unwrap();
        }
        let ambiguity = resolve_with(&environment, probe_without_window_manager)
            .err()
            .expect("ambiguous sessions must fail");
        assert_eq!(
            error_code(&ambiguity),
            Some(BackendError::DesktopUnavailable.to_string())
        );
        environment.selector = Some("lxqt".into());
        let plan = resolve_with(&environment, probe_without_window_manager).unwrap();
        match plan.action {
            DesktopAction::Launch(SessionLaunch::Standard { id, .. }) => assert_eq!(id, "lxqt"),
            _ => panic!("expected selected session"),
        }
    }

    #[test]
    fn attached_display_reuses_existing_window_manager_without_session_discovery() {
        let directory = tempfile::tempdir().unwrap();
        let environment = ResolverEnvironment {
            display: Some(":41".into()),
            authority: None,
            session_type: Some("wayland".into()),
            selector: None,
            path: directory.path().as_os_str().to_owned(),
            session_directories: vec![directory.path().join("missing")],
        };
        let plan = resolve_with(&environment, |_| {
            Ok(linux::Probe {
                has_window_manager: true,
            })
        })
        .unwrap();
        assert_eq!(plan.ownership, DisplayOwnership::Attached);
        assert!(matches!(plan.action, DesktopAction::Reuse));
    }

    #[test]
    fn attached_display_without_window_manager_launches_only_the_desktop() {
        let directory = tempfile::tempdir().unwrap();
        let mut environment = environment(directory.path());
        environment.display = Some(":41".into());
        let session = session_executable(&environment);
        std::fs::write(
            environment.session_directories[0].join("xfce.desktop"),
            format!(
                "[Desktop Entry]\nName=Xfce\nTryExec={}\nExec={}\n",
                session.display(),
                session.display()
            ),
        )
        .unwrap();
        let plan = resolve_with(&environment, probe_without_window_manager).unwrap();
        assert_eq!(plan.ownership, DisplayOwnership::Attached);
        assert_eq!(plan.desktop_source(), "host-desktop");
        assert!(matches!(
            plan.action,
            DesktopAction::Launch(SessionLaunch::Standard { .. })
        ));
    }

    #[test]
    fn unusable_display_falls_back_to_owned_xvfb() {
        let directory = tempfile::tempdir().unwrap();
        let environment = environment(directory.path());
        let mut environment = ResolverEnvironment {
            display: Some(":99".into()),
            ..environment
        };
        environment.selector = None;
        let plan = resolve_with(&environment, |_| {
            anyhow::bail!(BackendError::InvalidDisplay)
        })
        .unwrap();
        assert_eq!(plan.ownership, DisplayOwnership::Owned);
        assert_eq!(plan.desktop_source(), "instance-virtual-display");
        assert!(matches!(
            plan.action,
            DesktopAction::Launch(SessionLaunch::Fallback)
        ));
    }

    #[test]
    fn standard_session_without_dbus_launcher_is_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        let environment = environment(directory.path());
        let session = session_executable(&environment);
        std::fs::remove_file(Path::new(&environment.path).join("dbus-run-session")).unwrap();
        std::fs::write(
            environment.session_directories[0].join("session.desktop"),
            format!("[Desktop Entry]\nExec={}\n", session.display()),
        )
        .unwrap();
        let error = resolve_with(&environment, probe_without_window_manager)
            .err()
            .expect("missing dbus-run-session must fail");
        assert_eq!(
            error_code(&error),
            Some(BackendError::DesktopUnavailable.to_string())
        );
    }

    #[test]
    fn session_directories_use_declared_priority_and_first_duplicate_wins() {
        let directory = tempfile::tempdir().unwrap();
        let mut environment = environment(directory.path());
        let second = directory.path().join("sessions-second");
        std::fs::create_dir_all(&second).unwrap();
        environment.session_directories.push(second.clone());
        let session = session_executable(&environment);
        for (directory, name) in [
            (&environment.session_directories[0], "Local Session"),
            (&second, "System Session"),
        ] {
            std::fs::write(
                directory.join("shared.desktop"),
                format!("[Desktop Entry]\nName={name}\nExec={}\n", session.display()),
            )
            .unwrap();
        }
        let plan = resolve_with(&environment, probe_without_window_manager).unwrap();
        match plan.action {
            DesktopAction::Launch(SessionLaunch::Standard { name, .. }) => {
                assert_eq!(name, "Local Session")
            }
            _ => panic!("expected standard session"),
        }
    }

    #[test]
    fn wayland_without_a_usable_x11_display_does_not_substitute_xvfb() {
        let directory = tempfile::tempdir().unwrap();
        let environment = environment(directory.path());
        let environment = ResolverEnvironment {
            display: Some(":99".into()),
            session_type: Some("wayland".into()),
            ..environment
        };
        let error = resolve_with(&environment, |_| {
            anyhow::bail!(BackendError::InvalidDisplay)
        })
        .err()
        .expect("Wayland without an X11 display must fail");
        assert_eq!(
            error_code(&error),
            Some(BackendError::WaylandUnsupported.to_string())
        );
    }

    fn error_code(error: &anyhow::Error) -> Option<String> {
        error
            .downcast_ref::<BackendError>()
            .map(ToString::to_string)
    }
}
