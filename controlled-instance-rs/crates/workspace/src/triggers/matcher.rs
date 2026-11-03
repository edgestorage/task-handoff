// globset lacks picomatch extglob/brace semantics used by the Node trigger matcher.
use picomatch_rs::{compile_matcher, CompileOptions, Matcher};
use std::{
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

pub struct FileTriggerMatcher {
    included: Vec<Matcher>,
    excluded: Vec<Matcher>,
}

impl FileTriggerMatcher {
    pub fn new(globs: &[String], ignored: &[String]) -> Result<Self, String> {
        Ok(Self {
            included: compile_globs(globs)?,
            excluded: compile_globs(ignored)?,
        })
    }

    pub fn matches(&self, relative: &str) -> Result<bool, String> {
        if default_ignored(relative) {
            return Ok(false);
        }
        if matches_any(&self.excluded, relative)? {
            return Ok(false);
        }
        matches_any(&self.included, relative)
    }
}

fn compile_globs(patterns: &[String]) -> Result<Vec<Matcher>, String> {
    let options = CompileOptions {
        dot: true,
        ..CompileOptions::default()
    };
    let mut matchers = Vec::with_capacity(patterns.len());
    for pattern in patterns {
        matchers.push(
            compile_matcher(pattern, &options)
                .map_err(|error| format!("Invalid trigger glob {pattern:?}: {error:?}"))?,
        );
    }
    Ok(matchers)
}

fn matches_any(matchers: &[Matcher], relative: &str) -> Result<bool, String> {
    for matcher in matchers {
        if matcher
            .is_match(relative)
            .map_err(|error| format!("Trigger glob match failed: {error:?}"))?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn default_ignored(relative: &str) -> bool {
    static IGNORED_DIRECTORY: OnceLock<regex::Regex> = OnceLock::new();
    static IGNORED_EXTENSION: OnceLock<regex::Regex> = OnceLock::new();
    let directory = IGNORED_DIRECTORY.get_or_init(|| {
        regex::Regex::new(r"(^|/)(\.git|node_modules|dist|build)/").expect("regex")
    });
    let extension =
        IGNORED_EXTENSION.get_or_init(|| regex::Regex::new(r"\.(log|tmp|swp)$").expect("regex"));
    directory.is_match(relative) || extension.is_match(relative)
}

pub fn workspace_relative_path(workspace: &Path, file: &Path) -> Option<String> {
    let base = std::env::current_dir().ok()?;
    workspace_relative_path_from(workspace, file, &base)
}

fn workspace_relative_path_from(workspace: &Path, file: &Path, base: &Path) -> Option<String> {
    let workspace = resolve_from(workspace, base);
    let file = resolve_from(file, base);
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
    let base = std::env::current_dir().ok()?;
    root_within_workspace_from(workspace, root, &base)
}

fn root_within_workspace_from(workspace: &Path, root: &str, base: &Path) -> Option<PathBuf> {
    let workspace = resolve_from(workspace, base);
    let root = resolve_from(Path::new(root), base);
    path_within(&workspace, &root).then_some(root)
}

pub fn resolve_path(path: &Path) -> Option<PathBuf> {
    let base = std::env::current_dir().ok()?;
    Some(resolve_from(path, &base))
}

fn resolve_from(path: &Path, base: &Path) -> PathBuf {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    normalize_lexical(&path)
}

pub fn path_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    let rooted = path.is_absolute();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !rooted {
                    normalized.push("..");
                }
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
        assert!(matcher.matches("src/main.rs").expect("match"));
        assert!(matcher.matches(".env").expect("match"));
        assert!(!matcher.matches("target/debug/main.rs").expect("match"));
        assert!(!matcher.matches("node_modules/pkg/main.rs").expect("match"));
        assert!(!matcher.matches("dist/main.rs").expect("match"));
        assert!(!matcher.matches("build/main.rs").expect("match"));
        assert!(!matcher.matches("src/debug.log").expect("match"));
        assert!(!matcher.matches("src/debug.tmp").expect("match"));
        assert!(!matcher.matches("src/debug.swp").expect("match"));
    }

    #[test]
    fn matcher_matches_picomatch_dot_extglob_braces_and_globstar_boundaries() {
        let matcher =
            FileTriggerMatcher::new(&["**/*.{rs,ts}".to_string()], &["**/vendor/**".to_string()])
                .expect("matcher");
        for path in [
            "main.rs",
            "src/main.ts",
            ".hidden/main.rs",
            "src/nested/main.rs",
            "src/main.test.rs",
        ] {
            assert!(matcher.matches(path).expect("match"), "{path}");
        }
        for path in ["src/vendor/main.rs", "src/main.js"] {
            assert!(!matcher.matches(path).expect("match"), "{path}");
        }

        let extglob =
            FileTriggerMatcher::new(&["**/!(*.test).rs".to_string()], &[]).expect("extglob");
        assert!(extglob.matches("src/main.rs").expect("match"));
        assert!(!extglob.matches("src/main.test.rs").expect("match"));

        let literal =
            FileTriggerMatcher::new(&["src/*.rs".to_string()], &[]).expect("literal matcher");
        assert!(literal.matches("src/main.rs").expect("match"));
        assert!(!literal.matches("src/nested/main.rs").expect("match"));
    }

    #[test]
    fn default_ignores_match_node_anchoring() {
        assert!(default_ignored(".git/config"));
        assert!(default_ignored("src/node_modules/pkg/index.js"));
        assert!(default_ignored("dist/main.js"));
        assert!(default_ignored("build/main.js"));
        assert!(default_ignored("src/error.log"));
        assert!(!default_ignored("src/dist"));
        assert!(!default_ignored("src/node_modules"));
        assert!(!default_ignored("src/catalog.json"));
    }

    #[test]
    fn workspace_paths_follow_node_resolve_and_relative_boundaries() {
        let workspace = Path::new("/workspace/project");
        let base = Path::new("/workspace");
        assert_eq!(
            workspace_relative_path(workspace, Path::new("/workspace/project/src/main.rs")),
            Some("src/main.rs".to_string())
        );
        assert_eq!(
            workspace_relative_path_from(
                workspace,
                Path::new("/workspace/project/../secret"),
                base
            ),
            None
        );
        assert_eq!(
            root_within_workspace_from(workspace, "/workspace/project/../secret", base),
            None
        );
        assert_eq!(
            root_within_workspace_from(workspace, "project/src", base),
            Some(PathBuf::from("/workspace/project/src"))
        );
        assert_eq!(
            root_within_workspace_from(workspace, "./project/../project/src", base),
            Some(PathBuf::from("/workspace/project/src"))
        );
        assert_eq!(
            root_within_workspace_from(workspace, "/workspace/project-other", base),
            None
        );
        assert_eq!(
            root_within_workspace_from(workspace, "/workspace/project", base),
            Some(PathBuf::from("/workspace/project"))
        );
    }
}
