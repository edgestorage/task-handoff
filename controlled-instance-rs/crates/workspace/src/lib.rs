use controlled_instance_core::{atomic::read_json, paths::StoragePaths};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

mod branches;
mod changes;
mod config_sync;
mod context;
mod error;
mod files;
mod git;
mod service;
pub mod triggers;
mod worktrees;

pub use branches::*;
pub use changes::*;
pub use config_sync::*;
pub use context::*;
pub use error::*;
pub use files::*;
pub use git::{
    redact_git_diagnostic, GitCancellation, GitError, GitProcess, GitProcessOptions,
    GitProcessResult,
};
pub use service::*;
pub use worktrees::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryContext {
    pub path: PathBuf,
    pub is_repository: bool,
}

#[derive(Debug, Clone)]
pub struct WorkspaceService {
    pub paths: StoragePaths,
}

impl WorkspaceService {
    pub fn new(paths: StoragePaths) -> Self {
        Self { paths }
    }

    pub fn context(&self, path: impl Into<PathBuf>) -> RepositoryContext {
        let path = path.into();
        RepositoryContext {
            is_repository: path.join(".git").exists(),
            path,
        }
    }

    pub fn read_json<T: serde::de::DeserializeOwned>(
        &self,
        relative: impl AsRef<std::path::Path>,
    ) -> std::io::Result<T> {
        read_json(&self.paths.data_dir.join(relative))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_detection_uses_the_worktree_git_entry() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(root.path().join(".git")).expect("git dir");
        let paths = StoragePaths::resolve();
        let service = WorkspaceService::new(paths);
        assert!(service.context(root.path()).is_repository);
    }
}
