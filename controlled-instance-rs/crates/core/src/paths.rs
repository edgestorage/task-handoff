use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoragePaths {
    pub config_path: PathBuf,
    pub data_dir: PathBuf,
    pub app_catalog_dir: PathBuf,
    pub app_sessions_dir: PathBuf,
    pub triggers_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub events_dir: PathBuf,
    pub artifact_dir: PathBuf,
    pub log_dir: PathBuf,
    pub web_token_path: PathBuf,
}

impl StoragePaths {
    pub fn resolve() -> Self {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("."));
        let config_root = env_path("XDG_CONFIG_HOME", home.join(".config"));
        let config_path = env_path(
            "TASK_HANDOFF_CONFIG",
            config_root.join("task-handoff").join("config.json"),
        );
        let default_data_dir = config_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| {
                env_path("XDG_DATA_HOME", home.join(".local").join("share")).join("task-handoff")
            });
        let data_dir = env_path("TASK_HANDOFF_DATA_DIR", default_data_dir);
        Self {
            config_path,
            app_catalog_dir: env_path("TASK_HANDOFF_APP_CATALOG_DIR", data_dir.join("app-catalog")),
            app_sessions_dir: env_path(
                "TASK_HANDOFF_APP_SESSION_DIR",
                data_dir.join("app-sessions"),
            ),
            triggers_dir: env_path("TASK_HANDOFF_TRIGGERS_DIR", data_dir.join("triggers")),
            runtime_dir: env_path("TASK_HANDOFF_RUNTIME_DIR", data_dir.join("runtime")),
            events_dir: env_path("TASK_HANDOFF_EVENTS_DIR", data_dir.join("events")),
            artifact_dir: env_path("TASK_HANDOFF_ARTIFACT_DIR", data_dir.join("artifacts")),
            log_dir: env_path("TASK_HANDOFF_LOG_DIR", data_dir.join("logs")),
            web_token_path: env_path("TASK_HANDOFF_WEB_TOKEN_FILE", data_dir.join("web-token")),
            data_dir,
        }
    }

    pub fn ensure_directories(&self) -> std::io::Result<()> {
        for path in [&self.data_dir, &self.log_dir] {
            std::fs::create_dir_all(path)?;
            crate::fs_permissions::restrict_path(path, 0o700)?;
        }
        Ok(())
    }
}

fn env_path(name: &str, fallback: impl Into<PathBuf>) -> PathBuf {
    env_path_value(std::env::var(name).ok(), fallback)
}

fn env_path_value(value: Option<String>, fallback: impl Into<PathBuf>) -> PathBuf {
    match value {
        Some(value) if !value.trim().is_empty() => resolve_lexical(Path::new(value.trim())),
        _ => fallback.into(),
    }
}

fn resolve_lexical(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            value => normalized.push(value.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_override_paths_are_resolved_like_the_node_runtime() {
        let current = std::env::current_dir().expect("current directory");
        assert_eq!(
            env_path_value(Some("  nested/../relative-data  ".to_string()), "/fallback"),
            current.join("relative-data")
        );
        assert_eq!(
            env_path_value(Some("../sibling".to_string()), "/fallback"),
            current.parent().expect("parent").join("sibling")
        );
        assert_eq!(
            env_path_value(Some("   ".to_string()), "relative-fallback"),
            PathBuf::from("relative-fallback")
        );
    }

    #[test]
    fn startup_only_creates_directories_the_node_runtime_opens_eagerly() {
        let root = tempfile::tempdir().expect("tempdir");
        let data = root.path().join("data");
        let paths = StoragePaths {
            config_path: root.path().join("config.json"),
            data_dir: data.clone(),
            app_catalog_dir: data.join("app-catalog"),
            app_sessions_dir: data.join("app-sessions"),
            triggers_dir: data.join("triggers"),
            runtime_dir: data.join("runtime"),
            events_dir: data.join("events"),
            artifact_dir: data.join("artifacts"),
            log_dir: data.join("logs"),
            web_token_path: data.join("web-token"),
        };
        paths.ensure_directories().expect("directories");
        for path in [&paths.data_dir, &paths.log_dir] {
            assert!(path.is_dir(), "{} should exist", path.display());
        }
        for path in [
            &paths.app_catalog_dir,
            &paths.app_sessions_dir,
            &paths.runtime_dir,
            &paths.triggers_dir,
            &paths.events_dir,
            &paths.artifact_dir,
        ] {
            assert!(!path.exists(), "{} should be lazy", path.display());
        }
    }
}
