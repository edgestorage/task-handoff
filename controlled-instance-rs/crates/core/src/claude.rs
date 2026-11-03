use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Component, Path, PathBuf},
};

pub fn control_socket_path_from_env() -> PathBuf {
    control_socket_path(&env::vars().collect())
}

pub fn control_socket_path(environment: &BTreeMap<String, String>) -> PathBuf {
    if let Some(path) = environment
        .get("CLAUDE_CONTROL_SOCK")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(path);
    }
    control_socket_dir(environment).join("control.sock")
}

pub fn find_claude_transcript_path(session_id: &str, cwd: Option<&str>) -> Option<PathBuf> {
    let claude_home = claude_home_from_env()?;
    find_claude_transcript_path_in(&claude_home, session_id, cwd)
}

pub fn claude_home_from_env() -> Option<PathBuf> {
    env::var_os("CLAUDE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".claude"))
        })
}

pub fn claude_sessions_dir(claude_home: &Path) -> PathBuf {
    claude_home.join("sessions")
}

pub fn find_claude_transcript_path_in(
    claude_home: &Path,
    session_id: &str,
    cwd: Option<&str>,
) -> Option<PathBuf> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return None;
    }
    let projects_dir = claude_home.join("projects");
    if let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) {
        let project_dir = absolute_lexical_path(Path::new(cwd));
        let project_name = project_dir.to_string_lossy().replace(['\\', '/'], "-");
        let candidate = projects_dir
            .join(project_name)
            .join(format!("{session_id}.jsonl"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let mut pending = vec![projects_dir];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() {
                pending.push(path);
            } else if file_type.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.contains(session_id))
            {
                return Some(path);
            }
        }
    }
    None
}

fn control_socket_dir(environment: &BTreeMap<String, String>) -> PathBuf {
    let tmp = if environment.contains_key("TERMUX_VERSION") {
        environment
            .get("PREFIX")
            .filter(|value| !value.is_empty())
            .map(|prefix| PathBuf::from(prefix).join("tmp"))
            .unwrap_or_else(|| PathBuf::from("/tmp"))
    } else {
        PathBuf::from("/tmp")
    };
    let claude_config = environment
        .get("CLAUDE_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            environment
                .get("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".claude"))
        })
        .unwrap_or_else(|| PathBuf::from(".claude"));
    let absolute = absolute_lexical_path(&claude_config);
    let normalized = absolute.to_string_lossy().replace('\\', "/");
    let hash = hex::encode(Sha256::digest(normalized.as_bytes()));
    let uid = current_uid();
    tmp.join(format!("cc-daemon-{uid}")).join(&hash[..8])
}

fn current_uid() -> u32 {
    #[cfg(unix)]
    {
        unsafe { libc::getuid() }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

fn absolute_lexical_path(path: &Path) -> PathBuf {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_and_default_layout_match_the_node_contract() {
        let mut environment = BTreeMap::new();
        environment.insert(
            "CLAUDE_CONTROL_SOCK".to_string(),
            "/tmp/custom.sock".to_string(),
        );
        assert_eq!(
            control_socket_path(&environment),
            PathBuf::from("/tmp/custom.sock")
        );

        environment.remove("CLAUDE_CONTROL_SOCK");
        environment.insert("HOME".to_string(), "/home/test".to_string());
        let path = control_socket_path(&environment);
        assert!(path.starts_with(format!("/tmp/cc-daemon-{}", current_uid())));
        assert_eq!(
            path.file_name().and_then(|value| value.to_str()),
            Some("control.sock")
        );
        let hash = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .expect("hash");
        assert_eq!(hash.len(), 8);
        assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn transcript_lookup_prefers_the_cwd_project_and_falls_back_to_a_scan() {
        let root = tempfile::tempdir().expect("tempdir");
        let home = root.path().join(".claude");
        let project = home.join("projects").join("-workspace");
        std::fs::create_dir_all(&project).expect("project");
        let direct = project.join("session-id.jsonl");
        std::fs::write(&direct, b"{}\n").expect("transcript");
        assert_eq!(
            find_claude_transcript_path_in(&home, "session-id", Some("/workspace")),
            Some(direct)
        );

        let fallback_project = home.join("projects").join("other");
        std::fs::create_dir_all(&fallback_project).expect("fallback project");
        let fallback = fallback_project.join("fallback-session.jsonl");
        std::fs::write(&fallback, b"{}\n").expect("fallback transcript");
        assert_eq!(
            find_claude_transcript_path_in(&home, "fallback-session", Some("/missing")),
            Some(fallback)
        );
    }
}
