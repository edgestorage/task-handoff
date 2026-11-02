use crate::{
    context::{display_path, resolve_repository, ResolvedRepository},
    files::{within_root, RepositoryFileService},
    worktrees::ManagedWorktreeRegistry,
    RepositoryOperationError, RepositorySessionTarget,
};
use controlled_instance_core::paths::StoragePaths;
use std::{
    borrow::Borrow,
    collections::{BTreeSet, HashMap},
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Clone)]
pub struct RepositoryService {
    pub(crate) workspace_roots: Arc<Vec<PathBuf>>,
    pub(crate) managed_worktree_registry: ManagedWorktreeRegistry,
    lanes: Arc<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
}

impl RepositoryService {
    pub fn new(workspace_roots: Vec<PathBuf>) -> Self {
        let managed_root = std::env::var_os("TASK_HANDOFF_MANAGED_WORKTREES_ROOT")
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| StoragePaths::resolve().data_dir.join("managed-worktrees"));
        Self::new_with_managed_root(workspace_roots, managed_root)
    }

    pub fn new_with_managed_root(
        workspace_roots: Vec<PathBuf>,
        managed_worktree_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            workspace_roots: Arc::new(workspace_roots),
            managed_worktree_registry: ManagedWorktreeRegistry::new(managed_worktree_root),
            lanes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn from_env() -> Self {
        let mut roots = std::env::var_os("TASK_HANDOFF_WORKSPACE_ROOTS")
            .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
            .unwrap_or_default();
        if let Some(workspace) = std::env::var_os("TASK_HANDOFF_WORKSPACE") {
            roots.extend(std::env::split_paths(&workspace));
        }
        roots.retain(|root| !display_path(root).trim().is_empty());
        Self::new(roots)
    }

    pub fn workspace_roots(&self) -> &[PathBuf] {
        &self.workspace_roots
    }

    pub async fn resolve<T>(&self, target: T) -> ResolvedRepository
    where
        T: Borrow<RepositorySessionTarget>,
    {
        resolve_repository(target.borrow()).await
    }

    pub async fn resolve_workspace(&self, cwd: impl Into<PathBuf>) -> ResolvedRepository {
        self.resolve(RepositorySessionTarget {
            kind: controlled_instance_protocol::RepositorySessionKind::AiSession,
            id: "workspace-inspection".to_string(),
            cwd: Some(display_path(&cwd.into())),
            status: Some("idle".to_string()),
        })
        .await
    }

    pub fn files(
        &self,
        resolved: &ResolvedRepository,
    ) -> Result<RepositoryFileService, RepositoryOperationError> {
        let worktree_root = resolved.worktree_root.clone().ok_or_else(|| {
            RepositoryOperationError::new("REPOSITORY_NOT_WORKTREE", "Repository is unavailable.")
        })?;
        let boundary = self
            .workspace_roots
            .iter()
            .filter_map(|root| std::fs::canonicalize(root).ok())
            .find(|root| within_root(&worktree_root, root))
            .unwrap_or_else(|| worktree_root.clone());
        RepositoryFileService::new(worktree_root, Some(boundary), None)
    }

    pub async fn lock_repository(&self, resolved: &ResolvedRepository) -> OwnedMutexGuard<()> {
        self.lock_lane(format!(
            "repository:{}",
            resolved
                .git_common_dir
                .as_ref()
                .or(resolved.worktree_root.as_ref())
                .map(|path| display_path(path))
                .unwrap_or_else(|| "repository".to_string())
        ))
        .await
    }

    pub async fn lock_worktree(&self, resolved: &ResolvedRepository) -> OwnedMutexGuard<()> {
        self.lock_worktree_path(
            resolved
                .worktree_root
                .as_ref()
                .or(resolved.git_common_dir.as_ref())
                .map(PathBuf::as_path)
                .unwrap_or_else(|| std::path::Path::new("worktree")),
        )
        .await
    }

    pub async fn lock_worktree_path(&self, worktree: &std::path::Path) -> OwnedMutexGuard<()> {
        self.lock_lane(format!("worktree:{}", display_path(worktree)))
            .await
    }

    pub async fn lock_repository_and_worktree(
        &self,
        resolved: &ResolvedRepository,
    ) -> Vec<OwnedMutexGuard<()>> {
        let worktrees = resolved.worktree_root.iter().cloned().collect::<Vec<_>>();
        self.lock_repository_and_worktrees(resolved, worktrees)
            .await
    }

    pub async fn lock_repository_and_worktrees(
        &self,
        resolved: &ResolvedRepository,
        worktrees: impl IntoIterator<Item = PathBuf>,
    ) -> Vec<OwnedMutexGuard<()>> {
        let worktree_keys = worktrees
            .into_iter()
            .map(|path| format!("worktree:{}", display_path(&path)))
            .collect::<BTreeSet<_>>();
        let mut guards = Vec::with_capacity(worktree_keys.len() + 1);
        guards.push(self.lock_repository(resolved).await);
        for key in worktree_keys {
            guards.push(self.lock_lane(key).await);
        }
        guards
    }

    pub async fn lock(&self, resolved: &ResolvedRepository) -> OwnedMutexGuard<()> {
        self.lock_repository(resolved).await
    }

    async fn lock_lane(&self, key: String) -> OwnedMutexGuard<()> {
        let lock = self
            .lanes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(key)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        lock.lock_owned().await
    }

    pub async fn with_lock<F, Fut, T>(
        &self,
        resolved: &ResolvedRepository,
        operation: F,
    ) -> Result<T, RepositoryOperationError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, RepositoryOperationError>>,
    {
        let _guard = self.lock_repository(resolved).await;
        operation().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_protocol::{
        RepositoryAvailability, RepositoryContext, RepositorySessionKind,
    };
    use std::time::Duration;
    use tokio::sync::oneshot;

    fn resolved(worktree: &str, common: &str) -> ResolvedRepository {
        ResolvedRepository {
            context: RepositoryContext {
                availability: RepositoryAvailability::Available,
                session_kind: RepositorySessionKind::AiSession,
                session_id: "session-test".to_string(),
                observed_at: "2026-11-02T00:00:00.000Z".to_string(),
                snapshot_id: None,
                repository_id: None,
                repository_context_id: None,
                repository_root: None,
                display_name: None,
                cwd_relative_path: None,
                head: None,
                upstream: None,
                current_worktree: None,
                changes: None,
                remotes: None,
                primary_action: None,
            },
            changes: None,
            worktree_root: Some(PathBuf::from(worktree)),
            git_dir: Some(PathBuf::from(common).join(".git/worktrees/current")),
            git_common_dir: Some(PathBuf::from(common)),
        }
    }

    async fn receives(signal: &mut oneshot::Receiver<()>, duration: Duration) -> bool {
        tokio::time::timeout(duration, signal).await.is_ok()
    }

    #[tokio::test]
    async fn worktree_lanes_allow_independent_worktrees() {
        let service = RepositoryService::new_with_managed_root(Vec::new(), std::env::temp_dir());
        let first = resolved("/worktrees/first", "/repository");
        let second = resolved("/worktrees/second", "/repository");
        let first_guard = service.lock_worktree(&first).await;

        let (released, mut received) = oneshot::channel();
        let second_service = service.clone();
        let second_state = second.clone();
        tokio::spawn(async move {
            let _guard = second_service.lock_worktree(&second_state).await;
            let _ = released.send(());
        });
        assert!(receives(&mut received, Duration::from_secs(1)).await);

        let (blocked, mut waiting) = oneshot::channel();
        let first_service = service.clone();
        let first_state = first.clone();
        tokio::spawn(async move {
            let _guard = first_service.lock_worktree(&first_state).await;
            let _ = blocked.send(());
        });
        assert!(!receives(&mut waiting, Duration::from_millis(50)).await);

        drop(first_guard);
        assert!(receives(&mut waiting, Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn repository_lane_does_not_block_independent_worktree_lanes() {
        let service = RepositoryService::new_with_managed_root(Vec::new(), std::env::temp_dir());
        let state = resolved("/worktrees/first", "/repository");
        let repository_guard = service.lock_repository(&state).await;

        let (released, mut received) = oneshot::channel();
        let worktree_service = service.clone();
        let worktree_state = state.clone();
        tokio::spawn(async move {
            let _guard = worktree_service.lock_worktree(&worktree_state).await;
            let _ = released.send(());
        });
        assert!(receives(&mut received, Duration::from_secs(1)).await);

        drop(repository_guard);
    }

    #[tokio::test]
    async fn repository_and_worktree_locks_are_stable_and_deduplicated() {
        let service = RepositoryService::new_with_managed_root(Vec::new(), std::env::temp_dir());
        let state = resolved("/worktrees/first", "/repository");
        let first = PathBuf::from("/worktrees/first");
        let second = PathBuf::from("/worktrees/second");

        let (forward_done, mut forward_received) = oneshot::channel();
        let forward_service = service.clone();
        let forward_state = state.clone();
        let forward_first = first.clone();
        let forward_second = second.clone();
        tokio::spawn(async move {
            let _guards = forward_service
                .lock_repository_and_worktrees(
                    &forward_state,
                    [forward_first.clone(), forward_second, forward_first],
                )
                .await;
            let _ = forward_done.send(());
        });

        let (reverse_done, mut reverse_received) = oneshot::channel();
        let reverse_service = service.clone();
        let reverse_state = state.clone();
        tokio::spawn(async move {
            let _guards = reverse_service
                .lock_repository_and_worktrees(&reverse_state, [second, first])
                .await;
            let _ = reverse_done.send(());
        });

        assert!(receives(&mut forward_received, Duration::from_secs(1)).await);
        assert!(receives(&mut reverse_received, Duration::from_secs(1)).await);
    }
}
