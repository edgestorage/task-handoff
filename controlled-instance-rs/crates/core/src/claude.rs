use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
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
}
