use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use std::path::{Component, Path, PathBuf};

pub struct FileTriggerMatcher {
    included: GlobSet,
    excluded: GlobSet,
}

impl FileTriggerMatcher {
    pub fn new(globs: &[String], ignored: &[String]) -> Result<Self, String> {
        Ok(Self {
            included: compile_globs(globs)?,
            excluded: compile_globs(ignored)?,
        })
    }

    pub fn matches(&self, relative: &str) -> bool {
        let relative = relative.replace('\\', "/");
        !default_ignored(&relative)
            && !self.excluded.is_match(&relative)
            && self.included.is_match(&relative)
    }
}

fn compile_globs(patterns: &[String]) -> Result<GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|error| format!("Invalid trigger glob {pattern:?}: {error}"))?;
        builder.add(glob);
    }
    builder
        .build()
        .map_err(|error| format!("Invalid trigger glob set: {error}"))
}

pub fn default_ignored(relative: &str) -> bool {
    let segments = relative.split('/').collect::<Vec<_>>();
    if segments
        .iter()
        .take(segments.len().saturating_sub(1))
        .any(|segment| matches!(*segment, ".git" | "node_modules" | "dist" | "build"))
    {
        return true;
    }
    relative
        .rsplit_once('.')
        .is_some_and(|(_, extension)| matches!(extension, "log" | "tmp" | "swp"))
}

pub fn workspace_relative_path(workspace: &Path, file: &Path) -> Option<String> {
    let workspace = normalize_lexical(workspace);
    let file = normalize_lexical(file);
    let relative = file.strip_prefix(&workspace).ok()?;
    Some(
        relative
            .components()
            .filter_map(|component| match component {
                Component::Normal(value) => Some(value.to_string_lossy().to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/"),
    )
    .filter(|value| !value.is_empty())
}

pub fn root_within_workspace(workspace: &Path, root: &str) -> Option<PathBuf> {
    let workspace =
        std::fs::canonicalize(workspace).unwrap_or_else(|_| normalize_lexical(workspace));
    let root = Path::new(root);
    let root = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(root)
    };
    let root = std::fs::canonicalize(&root).unwrap_or_else(|_| normalize_lexical(&root));
    root.starts_with(&workspace).then_some(root)
}

pub fn normalize_lexical(path: &Path) -> PathBuf {
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
    fn matcher_applies_dotfiles_default_ignores_and_explicit_excludes() {
        let matcher = FileTriggerMatcher::new(
            &["**/*.rs".to_string(), "**/.env".to_string()],
            &["target/**".to_string()],
        )
        .expect("matcher");
        assert!(matcher.matches("src/main.rs"));
        assert!(matcher.matches(".env"));
        assert!(!matcher.matches("target/debug/main.rs"));
        assert!(!matcher.matches("node_modules/pkg/main.rs"));
        assert!(!matcher.matches("dist/main.rs"));
        assert!(!matcher.matches("build/main.rs"));
        assert!(!matcher.matches("src/debug.log"));
        assert!(!matcher.matches("src/debug.tmp"));
        assert!(!matcher.matches("src/debug.swp"));
    }

    #[test]
    fn workspace_paths_are_lexical_and_cannot_escape_the_root() {
        let workspace = Path::new("/workspace/project");
        assert_eq!(
            workspace_relative_path(workspace, Path::new("/workspace/project/src/main.rs")),
            Some("src/main.rs".to_string())
        );
        assert_eq!(
            workspace_relative_path(workspace, Path::new("/workspace/project/../secret")),
            None
        );
        assert_eq!(
            root_within_workspace(workspace, "/workspace/project/../secret"),
            None
        );
    }
}
