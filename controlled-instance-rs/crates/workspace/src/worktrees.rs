use crate::{
    context::{
        display_path, hash_id, now_iso, read_worktree_status, repository_worktree_id,
        require_operation_repository as require_repository, ResolvedRepository,
    },
    error::RepositoryOperationError,
    git::{GitError, GitProcess},
    service::RepositoryService,
    RepositorySessionTarget,
};
use controlled_instance_core::{atomic::write_json_atomic, fs_permissions};
use controlled_instance_protocol::{
    RepositoryCreateWorktreeRequest, RepositoryCreateWorktreeResult, RepositoryHead,
    RepositoryHeadState, RepositoryMoveWorktreeBlocker, RepositoryMoveWorktreePreflight,
    RepositoryMoveWorktreeRequest, RepositoryMoveWorktreeResult, RepositoryRemoveWorktreeRequest,
    RepositoryRemoveWorktreeResult, RepositoryWorktree, RepositoryWorktreeBlocker,
    RepositoryWorktreeSummary, RepositoryWorktrees,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const REGISTRY_VERSION: u32 = 2;
const GENERATION_MARKER: &str = "task-handoff-generation";
const TERMINAL_SESSION_STATUSES: &[&str] = &[
    "stopped",
    "exited",
    "failed",
    "closed",
    "terminated",
    "completed",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryAiSessionPresence {
    pub id: String,
    pub app_session_id: Option<String>,
    pub cwd: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryAppSessionPresence {
    pub id: String,
    pub cwd: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RepositorySessionInventory {
    pub ai_sessions: Vec<RepositoryAiSessionPresence>,
    pub app_sessions: Vec<RepositoryAppSessionPresence>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ManagedWorktreeState {
    Preparing,
    Ready,
    Removing,
    Quarantined,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ManagedCheckout {
    Attached,
    Detached,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RepositoryWorktreeRef {
    Head,
    Branch { name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManagedWorktreeIntent {
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(rename = "ref")]
    reference: RepositoryWorktreeRef,
    resolved_oid: String,
    checkout: ManagedCheckout,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManagedWorktreeEntry {
    repository_id: String,
    worktree_id: String,
    path: String,
    created_at: String,
    generation_id: String,
    state: ManagedWorktreeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    intent: Option<ManagedWorktreeIntent>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    legacy: bool,
}

#[derive(Debug)]
struct RegistryState {
    root: PathBuf,
    registry_path: PathBuf,
    entries: BTreeMap<String, ManagedWorktreeEntry>,
}

#[derive(Clone)]
pub(crate) struct ManagedWorktreeRegistry {
    state: Arc<Mutex<RegistryState>>,
}

impl ManagedWorktreeRegistry {
    pub(crate) fn new(root: impl Into<PathBuf>) -> Self {
        let root = absolute_path(&root.into());
        let root = fs::canonicalize(&root).unwrap_or(root);
        let registry_path = root.join("registry.json");
        let entries = load_registry_entries(&registry_path, &root);
        Self {
            state: Arc::new(Mutex::new(RegistryState {
                root,
                registry_path,
                entries,
            })),
        }
    }

    fn allocate(
        &self,
        repository_id: &str,
        branch_name: &str,
        key: Option<&str>,
    ) -> Result<PathBuf, String> {
        let mut state = self.lock();
        ensure_registry_root(&mut state)?;
        let repository_directory = state
            .root
            .join(repository_id.strip_prefix("repo:").unwrap_or(repository_id));
        fs::create_dir_all(&repository_directory)
            .map_err(|error| format!("Managed worktree directory could not be created: {error}"))?;
        let _ = fs_permissions::restrict_path(&repository_directory, 0o700);
        let slug = worktree_slug(branch_name);
        let suffix = key
            .map(|value| {
                let mut hasher = Sha256::new();
                hasher.update(value.as_bytes());
                hex::encode(hasher.finalize())[..24].to_string()
            })
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        Ok(repository_directory.join(format!("{slug}-{suffix}")))
    }

    fn prepare(
        &self,
        repository_id: &str,
        worktree_id: &str,
        worktree_path: &Path,
        intent: ManagedWorktreeIntent,
    ) -> Result<(), String> {
        let mut state = self.lock();
        ensure_registry_root(&mut state)?;
        let resolved_path = absolute_path(worktree_path);
        if !within_root(&resolved_path, &state.root) {
            return Err("Managed worktree path is outside the managed root.".to_string());
        }
        if let Some(existing) = state.entries.get(worktree_id) {
            if existing.repository_id != repository_id
                || absolute_path(Path::new(&existing.path)) != resolved_path
            {
                return Err(
                    "Managed worktree identity is already assigned to another path.".to_string(),
                );
            }
        }
        let created_at = state
            .entries
            .get(worktree_id)
            .map(|entry| entry.created_at.clone())
            .unwrap_or_else(now_iso);
        let generation_id = state
            .entries
            .get(worktree_id)
            .map(|entry| entry.generation_id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        state.entries.insert(
            worktree_id.to_string(),
            ManagedWorktreeEntry {
                repository_id: repository_id.to_string(),
                worktree_id: worktree_id.to_string(),
                path: display_path(&resolved_path),
                created_at,
                generation_id,
                state: ManagedWorktreeState::Preparing,
                intent: Some(intent),
                legacy: false,
            },
        );
        persist_registry(&state)
    }

    fn mark_ready(
        &self,
        worktree_id: &str,
        worktree_path: &Path,
        git_common_dir: &Path,
    ) -> Result<(), String> {
        let mut state = self.lock();
        let generation_id = require_entry(&state, worktree_id, worktree_path)?
            .generation_id
            .clone();
        write_generation_marker(worktree_path, git_common_dir, &generation_id)?;
        let canonical = fs::canonicalize(worktree_path)
            .map_err(|error| format!("Managed worktree path is inaccessible: {error}"))?;
        let entry = state
            .entries
            .get_mut(worktree_id)
            .ok_or_else(|| "Managed worktree ownership could not be verified.".to_string())?;
        entry.path = display_path(&canonical);
        entry.state = ManagedWorktreeState::Ready;
        entry.legacy = false;
        persist_registry(&state)
    }

    fn abort_preparation(&self, worktree_id: &str) {
        let mut state = self.lock();
        if state
            .entries
            .get(worktree_id)
            .is_some_and(|entry| entry.state == ManagedWorktreeState::Preparing)
        {
            state.entries.remove(worktree_id);
            let _ = persist_registry(&state);
        }
    }

    fn begin_remove(&self, worktree_id: &str, worktree_path: &Path) -> Result<(), String> {
        let mut state = self.lock();
        let entry = state
            .entries
            .get_mut(worktree_id)
            .ok_or_else(|| "Managed worktree ownership could not be verified.".to_string())?;
        if absolute_path(Path::new(&entry.path)) != absolute_path(worktree_path) {
            return Err("Managed worktree ownership could not be verified.".to_string());
        }
        if entry.state != ManagedWorktreeState::Ready {
            return Err("Managed worktree is not ready for removal.".to_string());
        }
        entry.state = ManagedWorktreeState::Removing;
        persist_registry(&state)
    }

    fn cancel_remove(&self, worktree_id: &str) {
        let mut state = self.lock();
        if let Some(entry) = state.entries.get_mut(worktree_id) {
            if entry.state == ManagedWorktreeState::Removing {
                entry.state = ManagedWorktreeState::Ready;
                let _ = persist_registry(&state);
            }
        }
    }

    fn complete_remove(&self, worktree_id: &str) {
        let mut state = self.lock();
        if state.entries.remove(worktree_id).is_some() {
            let _ = persist_registry(&state);
        }
    }

    fn matches_creation(
        &self,
        worktree_id: &str,
        worktree_path: &Path,
        request_id: &str,
        reference: &RepositoryWorktreeRef,
    ) -> bool {
        let state = self.lock();
        state.entries.get(worktree_id).is_some_and(|entry| {
            entry.state == ManagedWorktreeState::Ready
                && absolute_path(Path::new(&entry.path)) == absolute_path(worktree_path)
                && entry.intent.as_ref().is_some_and(|intent| {
                    intent.request_id.as_deref() == Some(request_id)
                        && intent.reference == *reference
                })
        })
    }

    fn reconcile(
        &self,
        repository_id: &str,
        git_common_dir: &Path,
        records: &[WorktreeRecord],
    ) -> HashSet<String> {
        let mut state = self.lock();
        let records_by_id = records
            .iter()
            .map(|record| {
                let canonical = canonical_worktree_path(&record.path);
                (
                    repository_worktree_id(repository_id, &canonical),
                    WorktreeRecord {
                        path: canonical,
                        ..record.clone()
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        let ids = state.entries.keys().cloned().collect::<Vec<_>>();
        let mut managed = HashSet::new();
        let mut changed = false;
        for worktree_id in ids {
            let Some(entry) = state.entries.get(&worktree_id).cloned() else {
                continue;
            };
            if entry.repository_id != repository_id {
                continue;
            }
            let Some(record) = records_by_id.get(&worktree_id) else {
                if entry.state == ManagedWorktreeState::Preparing && Path::new(&entry.path).exists()
                {
                    if let Some(current) = state.entries.get_mut(&worktree_id) {
                        current.state = ManagedWorktreeState::Quarantined;
                    }
                    changed = true;
                } else {
                    state.entries.remove(&worktree_id);
                    changed = true;
                }
                continue;
            };
            if absolute_path(&record.path) != absolute_path(Path::new(&entry.path)) {
                if entry.state == ManagedWorktreeState::Preparing && Path::new(&entry.path).exists()
                {
                    if let Some(current) = state.entries.get_mut(&worktree_id) {
                        current.state = ManagedWorktreeState::Quarantined;
                    }
                    changed = true;
                } else {
                    state.entries.remove(&worktree_id);
                    changed = true;
                }
                continue;
            }

            let marker = read_generation_marker(&record.path, git_common_dir);
            if marker.as_deref() == Some(entry.generation_id.as_str()) {
                if entry.state == ManagedWorktreeState::Preparing
                    || entry.state == ManagedWorktreeState::Removing
                {
                    if let Some(current) = state.entries.get_mut(&worktree_id) {
                        current.state = ManagedWorktreeState::Ready;
                    }
                    changed = true;
                }
                if state
                    .entries
                    .get(&worktree_id)
                    .is_some_and(|current| current.state == ManagedWorktreeState::Ready)
                {
                    managed.insert(worktree_id);
                }
                continue;
            }

            // Compatibility for v0.0.21: a v1 registry can be rewritten by an older
            // instance, while the Git admin marker still carries the stable identity.
            if let Some(marker) = marker.as_deref().filter(|_| entry.legacy) {
                if let Some(current) = state.entries.get_mut(&worktree_id) {
                    current.generation_id = marker.to_string();
                    current.state = ManagedWorktreeState::Ready;
                    current.legacy = false;
                }
                managed.insert(worktree_id);
                changed = true;
                continue;
            }

            let can_recover = marker.is_none()
                && (entry.legacy
                    || (entry.state == ManagedWorktreeState::Preparing
                        && entry
                            .intent
                            .as_ref()
                            .is_some_and(|intent| record_matches_intent(record, intent))));
            if can_recover
                && write_generation_marker(&record.path, git_common_dir, &entry.generation_id)
                    .is_ok()
            {
                if let Some(current) = state.entries.get_mut(&worktree_id) {
                    current.path = display_path(&record.path);
                    current.state = ManagedWorktreeState::Ready;
                    current.legacy = false;
                }
                managed.insert(worktree_id);
                changed = true;
                continue;
            }
            if let Some(current) = state.entries.get_mut(&worktree_id) {
                if current.state != ManagedWorktreeState::Quarantined {
                    current.state = ManagedWorktreeState::Quarantined;
                    changed = true;
                }
            }
        }
        if changed {
            let _ = persist_registry(&state);
        }
        managed
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorktreeRecord {
    pub(crate) path: PathBuf,
    head_oid: Option<String>,
    pub(crate) branch: Option<String>,
    detached: bool,
    locked: bool,
    lock_reason: Option<String>,
    prunable: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct InternalWorktree {
    pub worktree: RepositoryWorktree,
    pub canonical_path: PathBuf,
    pub hosts_running_session: bool,
}

impl RepositoryService {
    pub async fn list_worktrees(
        &self,
        target: &RepositorySessionTarget,
        sessions: &RepositorySessionInventory,
    ) -> Result<RepositoryWorktrees, RepositoryOperationError> {
        let resolved = self.resolve(target).await;
        let state = require_repository(resolved)?;
        self.list_worktrees_from_state(&state, sessions).await
    }

    pub async fn list_worktrees_from_state(
        &self,
        state: &ResolvedRepository,
        sessions: &RepositorySessionInventory,
    ) -> Result<RepositoryWorktrees, RepositoryOperationError> {
        let internal = self.list_worktrees_internal(state, sessions).await?;
        let public_items = internal
            .iter()
            .map(|item| item.worktree.clone())
            .collect::<Vec<_>>();
        let snapshot_id = hash_id(
            "worktrees",
            &[serde_json::to_string(&public_items).unwrap_or_default()],
        );
        Ok(RepositoryWorktrees {
            repository_id: state.context.repository_id.clone().unwrap_or_default(),
            repository_context_id: state
                .context
                .repository_context_id
                .clone()
                .unwrap_or_default(),
            snapshot_id,
            items: public_items,
        })
    }

    pub async fn create_worktree(
        &self,
        target: &RepositorySessionTarget,
        sessions: &RepositorySessionInventory,
        request: RepositoryCreateWorktreeRequest,
    ) -> Result<RepositoryCreateWorktreeResult, RepositoryOperationError> {
        let initial = require_repository(self.resolve(target).await)?;
        let _guard = self.lock(&initial).await;
        let state = require_repository(self.resolve(target).await)?;
        let expected_snapshot_id = match &request {
            RepositoryCreateWorktreeRequest::NewBranch {
                expected_snapshot_id,
                ..
            }
            | RepositoryCreateWorktreeRequest::ExistingBranch {
                expected_snapshot_id,
                ..
            } => expected_snapshot_id,
        };
        if state.context.snapshot_id.as_deref() != Some(expected_snapshot_id.as_str()) {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_STATE_STALE",
                "Repository state changed before worktree creation.",
                &state,
            ));
        }
        let current = self.list_worktrees_internal(&state, sessions).await?;
        let (branch_name, mode, start_ref) = match &request {
            RepositoryCreateWorktreeRequest::NewBranch {
                branch_name,
                start_ref,
                ..
            } => (branch_name.as_str(), "new-branch", Some(start_ref.as_str())),
            RepositoryCreateWorktreeRequest::ExistingBranch { branch_name, .. } => {
                (branch_name.as_str(), "existing-branch", None)
            }
        };
        crate::branches::validate_git_name(branch_name)?;
        if let Some(start_ref) = start_ref {
            if start_ref.trim().is_empty() || start_ref.chars().count() > 2048 {
                return Err(RepositoryOperationError::new(
                    "REPOSITORY_REQUEST_INVALID",
                    "Invalid Git start ref.",
                ));
            }
        }
        let occupied = has_attached_branch(&current, branch_name);
        if mode == "new-branch" && occupied {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_BRANCH_OCCUPIED",
                "Branch is already checked out in another worktree.",
                &state,
            ));
        }
        let checkout = if mode == "existing-branch" && occupied {
            ManagedCheckout::Detached
        } else {
            ManagedCheckout::Attached
        };
        let root = state.worktree_root.as_ref().expect("required root");
        let git = GitProcess::new(root);
        let revision = if mode == "new-branch" {
            start_ref.expect("new branch ref").to_string()
        } else {
            format!("refs/heads/{branch_name}")
        };
        let resolved_oid = resolve_commit_oid(&git, &revision).await.ok_or_else(|| {
            RepositoryOperationError::with_current(
                "REPOSITORY_BRANCH_INVALID",
                if mode == "new-branch" {
                    "Selected Git start ref no longer exists."
                } else {
                    "Selected Git branch no longer exists."
                },
                &state,
            )
        })?;
        let repository_id = state.context.repository_id.clone().expect("repository id");
        let destination = self
            .managed_worktree_registry
            .allocate(&repository_id, branch_name, None)
            .map_err(operation_failed)?;
        let worktree_id = repository_worktree_id(&repository_id, &destination);
        let intent = ManagedWorktreeIntent {
            request_id: None,
            reference: RepositoryWorktreeRef::Branch {
                name: branch_name.to_string(),
            },
            resolved_oid: resolved_oid.clone(),
            checkout,
        };
        let mut added = false;
        let result = async {
            self.managed_worktree_registry
                .prepare(&repository_id, &worktree_id, &destination, intent)
                .map_err(operation_failed)?;
            let destination_arg = display_path(&destination);
            let args = if mode == "new-branch" {
                vec![
                    "add".to_string(),
                    "-b".to_string(),
                    branch_name.to_string(),
                    destination_arg,
                    resolved_oid.clone(),
                ]
            } else if checkout == ManagedCheckout::Detached {
                vec![
                    "add".to_string(),
                    "--detach".to_string(),
                    destination_arg,
                    resolved_oid.clone(),
                ]
            } else {
                vec!["add".to_string(), destination_arg, branch_name.to_string()]
            };
            git.run("worktree", &args).await.map_err(|error| {
                git_operation_error(error, &state, "Git could not create the worktree.")
            })?;
            added = true;
            let canonical = fs::canonicalize(&destination).map_err(|error| {
                RepositoryOperationError::with_current(
                    "REPOSITORY_OPERATION_FAILED",
                    format!("Git worktree path is inaccessible: {error}"),
                    &state,
                )
            })?;
            self.managed_worktree_registry
                .mark_ready(
                    &worktree_id,
                    &canonical,
                    state.git_common_dir.as_ref().expect("required common dir"),
                )
                .map_err(operation_failed)?;
            Ok::<(), RepositoryOperationError>(())
        }
        .await;
        if let Err(error) = result {
            cleanup_failed_worktree_creation(
                &git,
                &destination,
                added,
                &self.managed_worktree_registry,
                &worktree_id,
            )
            .await;
            return Err(error);
        }
        let refreshed = require_repository(self.resolve(target).await)?;
        Ok(RepositoryCreateWorktreeResult {
            worktree_id,
            worktrees: self.list_worktrees_from_state(&refreshed, sessions).await?,
        })
    }

    pub async fn create_worktree_for_ai_session(
        &self,
        target: &RepositorySessionTarget,
        sessions: &RepositorySessionInventory,
        reference: RepositoryWorktreeRef,
        request_id: &str,
    ) -> Result<RepositoryCreateWorktreeResult, RepositoryOperationError> {
        let initial = require_repository(self.resolve(target).await)?;
        let _guard = self.lock(&initial).await;
        let state = require_repository(self.resolve(target).await)?;
        let root = state.worktree_root.as_ref().expect("required root");
        let git = GitProcess::new(root);
        let ref_label = match &reference {
            RepositoryWorktreeRef::Head => "HEAD".to_string(),
            RepositoryWorktreeRef::Branch { name } => name.clone(),
        };
        let repository_id = state.context.repository_id.clone().expect("repository id");
        let destination = self
            .managed_worktree_registry
            .allocate(&repository_id, &ref_label, Some(request_id))
            .map_err(operation_failed)?;
        let worktree_id = repository_worktree_id(&repository_id, &destination);
        let current = self.list_worktrees_internal(&state, sessions).await?;
        if let Some(existing) = current
            .iter()
            .find(|item| item.canonical_path == destination)
        {
            let matches = self.managed_worktree_registry.matches_creation(
                &worktree_id,
                &existing.canonical_path,
                request_id,
                &reference,
            );
            if !existing.worktree.summary.managed || !matches {
                return Err(RepositoryOperationError::with_current(
                    "REPOSITORY_WORKTREE_UNSAFE",
                    "The worktree destination belongs to another creation request.",
                    &state,
                ));
            }
            if !existing.worktree.can_create_ai_session {
                return Err(RepositoryOperationError::with_current(
                    "REPOSITORY_WORKTREE_UNSAFE",
                    format!(
                        "Worktree cannot host an AI session: {}.",
                        blocker_list(&existing.worktree.create_ai_session_blockers)
                    ),
                    &state,
                ));
            }
            return Ok(RepositoryCreateWorktreeResult {
                worktree_id,
                worktrees: self.list_worktrees_from_state(&state, sessions).await?,
            });
        }
        if destination.exists() {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_WORKTREE_UNSAFE",
                "The managed worktree destination already exists but is not registered as a Git worktree.",
                &state,
            ));
        }
        let (revision, branch_name) = match &reference {
            RepositoryWorktreeRef::Head => ("HEAD".to_string(), None),
            RepositoryWorktreeRef::Branch { name } => {
                (format!("refs/heads/{name}"), Some(name.clone()))
            }
        };
        let resolved_oid = resolve_commit_oid(&git, &revision).await.ok_or_else(|| {
            RepositoryOperationError::with_current(
                "REPOSITORY_BRANCH_INVALID",
                "Selected Git revision no longer exists.",
                &state,
            )
        })?;
        let branch_occupied = branch_name
            .as_deref()
            .is_some_and(|branch| has_attached_branch(&current, branch));
        let checkout = if branch_name.is_some() && !branch_occupied {
            ManagedCheckout::Attached
        } else {
            ManagedCheckout::Detached
        };
        let intent = ManagedWorktreeIntent {
            request_id: Some(request_id.to_string()),
            reference: reference.clone(),
            resolved_oid: resolved_oid.clone(),
            checkout,
        };
        let mut added = false;
        let result = async {
            self.managed_worktree_registry
                .prepare(&repository_id, &worktree_id, &destination, intent)
                .map_err(operation_failed)?;
            let destination_arg = display_path(&destination);
            let args = if checkout == ManagedCheckout::Attached {
                vec![
                    "add".to_string(),
                    destination_arg,
                    branch_name.clone().expect("attached branch"),
                ]
            } else {
                vec![
                    "add".to_string(),
                    "--detach".to_string(),
                    destination_arg,
                    resolved_oid.clone(),
                ]
            };
            git.run("worktree", &args).await.map_err(|error| {
                git_operation_error(
                    error,
                    &state,
                    "Git could not create the AI session worktree.",
                )
            })?;
            added = true;
            let canonical = fs::canonicalize(&destination).map_err(|error| {
                RepositoryOperationError::with_current(
                    "REPOSITORY_OPERATION_FAILED",
                    format!("Git worktree path is inaccessible: {error}"),
                    &state,
                )
            })?;
            self.managed_worktree_registry
                .mark_ready(
                    &worktree_id,
                    &canonical,
                    state.git_common_dir.as_ref().expect("required common dir"),
                )
                .map_err(operation_failed)?;
            Ok::<(), RepositoryOperationError>(())
        }
        .await;
        if let Err(error) = result {
            cleanup_failed_worktree_creation(
                &git,
                &destination,
                added,
                &self.managed_worktree_registry,
                &worktree_id,
            )
            .await;
            return Err(error);
        }
        let refreshed = require_repository(self.resolve(target).await)?;
        Ok(RepositoryCreateWorktreeResult {
            worktree_id,
            worktrees: self.list_worktrees_from_state(&refreshed, sessions).await?,
        })
    }

    pub async fn remove_worktree(
        &self,
        session_target: &RepositorySessionTarget,
        sessions: &RepositorySessionInventory,
        request: RepositoryRemoveWorktreeRequest,
    ) -> Result<RepositoryRemoveWorktreeResult, RepositoryOperationError> {
        if !request.confirm {
            return Err(RepositoryOperationError::new(
                "REPOSITORY_REQUEST_INVALID",
                "confirm must be true.",
            ));
        }
        let initial = require_repository(self.resolve(session_target).await)?;
        let initial_target = self
            .list_worktrees_internal(&initial, sessions)
            .await?
            .into_iter()
            .find(|item| item.worktree.summary.id == request.worktree_id)
            .ok_or_else(|| {
                RepositoryOperationError::with_current(
                    "REPOSITORY_WORKTREE_NOT_FOUND",
                    "Worktree no longer exists.",
                    &initial,
                )
            })?;
        let _guards = self
            .lock_repository_and_worktree_path(&initial, &initial_target.canonical_path)
            .await;
        let state = require_repository(self.resolve(session_target).await)?;
        let list = self.list_worktrees_from_state(&state, sessions).await?;
        if list.snapshot_id != request.expected_snapshot_id {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_STATE_STALE",
                "Worktree state changed before removal.",
                &state,
            ));
        }
        let internal = self.list_worktrees_internal(&state, sessions).await?;
        let target = internal
            .iter()
            .find(|item| item.worktree.summary.id == request.worktree_id)
            .ok_or_else(|| {
                RepositoryOperationError::with_current(
                    "REPOSITORY_WORKTREE_NOT_FOUND",
                    "Worktree no longer exists.",
                    &state,
                )
            })?;
        if target.worktree.summary.is_current {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_WORKTREE_UNSAFE",
                "The current worktree cannot be removed.",
                &state,
            ));
        }
        if !target.worktree.can_remove {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_WORKTREE_UNSAFE",
                format!(
                    "Worktree cannot be removed: {}.",
                    blocker_list(&target.worktree.remove_blockers)
                ),
                &state,
            ));
        }
        if target.worktree.summary.managed {
            self.managed_worktree_registry
                .begin_remove(&target.worktree.summary.id, &target.canonical_path)
                .map_err(operation_failed)?;
        }
        let result = GitProcess::new(state.worktree_root.as_ref().expect("required root"))
            .run(
                "worktree",
                &["remove".to_string(), display_path(&target.canonical_path)],
            )
            .await;
        if let Err(error) = result {
            if target.worktree.summary.managed {
                self.managed_worktree_registry
                    .cancel_remove(&target.worktree.summary.id);
            }
            return Err(git_operation_error(
                error,
                &state,
                "Git could not remove the worktree.",
            ));
        }
        if target.worktree.summary.managed {
            self.managed_worktree_registry
                .complete_remove(&target.worktree.summary.id);
        }
        let removed_worktree_id = target.worktree.summary.id.clone();
        let refreshed = require_repository(self.resolve(session_target).await)?;
        Ok(RepositoryRemoveWorktreeResult {
            removed_worktree_id,
            branch_retained: true,
            worktrees: self.list_worktrees_from_state(&refreshed, sessions).await?,
        })
    }

    pub async fn move_worktree_to_main_preflight(
        &self,
        target: &RepositorySessionTarget,
        sessions: &RepositorySessionInventory,
        request: controlled_instance_protocol::RepositoryMoveWorktreePreflightRequest,
    ) -> Result<RepositoryMoveWorktreePreflight, RepositoryOperationError> {
        let state = require_repository(self.resolve(target).await)?;
        let internal = self.list_worktrees_internal(&state, sessions).await?;
        let target = internal
            .iter()
            .find(|item| item.worktree.summary.id == request.worktree_id)
            .ok_or_else(|| {
                RepositoryOperationError::with_current(
                    "REPOSITORY_WORKTREE_NOT_FOUND",
                    "Worktree no longer exists.",
                    &state,
                )
            })?;
        let main = internal
            .iter()
            .find(|item| item.worktree.summary.is_main)
            .ok_or_else(|| {
                RepositoryOperationError::with_current(
                    "REPOSITORY_OPERATION_FAILED",
                    "The main worktree could not be resolved.",
                    &state,
                )
            })?;
        let blockers = move_worktree_blockers(target, main);
        Ok(RepositoryMoveWorktreePreflight {
            worktree_id: target.worktree.summary.id.clone(),
            can_move: blockers.is_empty(),
            blockers,
            target_branch: target
                .worktree
                .summary
                .head
                .branch
                .clone()
                .filter(|_| target.worktree.summary.head.state == RepositoryHeadState::Branch),
            target_changes: worktree_change_summary(target).await?,
            main_worktree_id: main.worktree.summary.id.clone(),
            main_branch: main
                .worktree
                .summary
                .head
                .branch
                .clone()
                .filter(|_| main.worktree.summary.head.state == RepositoryHeadState::Branch),
        })
    }

    pub async fn move_worktree_to_main(
        &self,
        session_target: &RepositorySessionTarget,
        sessions: &RepositorySessionInventory,
        request: RepositoryMoveWorktreeRequest,
    ) -> Result<RepositoryMoveWorktreeResult, RepositoryOperationError> {
        if !request.confirm {
            return Err(RepositoryOperationError::new(
                "REPOSITORY_REQUEST_INVALID",
                "confirm must be true.",
            ));
        }
        let initial = require_repository(self.resolve(session_target).await)?;
        let initial_internal = self.list_worktrees_internal(&initial, sessions).await?;
        let initial_target = initial_internal
            .iter()
            .find(|item| item.worktree.summary.id == request.worktree_id)
            .ok_or_else(|| {
                RepositoryOperationError::with_current(
                    "REPOSITORY_WORKTREE_NOT_FOUND",
                    "Worktree no longer exists.",
                    &initial,
                )
            })?;
        let initial_main = initial_internal
            .iter()
            .find(|item| item.worktree.summary.is_main)
            .ok_or_else(|| {
                RepositoryOperationError::with_current(
                    "REPOSITORY_OPERATION_FAILED",
                    "The main worktree could not be resolved.",
                    &initial,
                )
            })?;
        let initial_main_path = initial_main.canonical_path.clone();
        let _guards = self
            .lock_repository_and_worktrees(
                &initial,
                [
                    initial_target.canonical_path.clone(),
                    initial_main_path.clone(),
                ],
            )
            .await;
        let state = require_repository(self.resolve(session_target).await)?;
        let list = self.list_worktrees_from_state(&state, sessions).await?;
        if list.snapshot_id != request.expected_snapshot_id {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_STATE_STALE",
                "Worktree state changed before the move.",
                &state,
            ));
        }
        let internal = self.list_worktrees_internal(&state, sessions).await?;
        let target = internal
            .iter()
            .find(|item| item.worktree.summary.id == request.worktree_id)
            .ok_or_else(|| {
                RepositoryOperationError::with_current(
                    "REPOSITORY_WORKTREE_NOT_FOUND",
                    "Worktree no longer exists.",
                    &state,
                )
            })?;
        let main = internal
            .iter()
            .find(|item| item.worktree.summary.is_main)
            .ok_or_else(|| {
                RepositoryOperationError::with_current(
                    "REPOSITORY_OPERATION_FAILED",
                    "The main worktree could not be resolved.",
                    &state,
                )
            })?;
        if main.canonical_path != initial_main_path {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_STATE_STALE",
                "The main worktree moved while the repository was locked.",
                &state,
            ));
        }
        let blockers = move_worktree_blockers(target, main);
        if !blockers.is_empty() {
            return Err(
                if blockers.contains(&RepositoryMoveWorktreeBlocker::MainDirty) {
                    RepositoryOperationError::with_current(
                    "REPOSITORY_MAIN_DIRTY",
                    "The main worktree has uncommitted changes. Commit or stash them there before moving this worktree.",
                    &state,
                )
                } else {
                    RepositoryOperationError::with_current(
                        "REPOSITORY_WORKTREE_UNSAFE",
                        format!(
                            "Worktree cannot be moved into the main worktree: {}.",
                            move_blocker_list(&blockers)
                        ),
                        &state,
                    )
                },
            );
        }
        let branch = target
            .worktree
            .summary
            .head
            .branch
            .clone()
            .filter(|_| target.worktree.summary.head.state == RepositoryHeadState::Branch);
        let previous_head = target.worktree.summary.head.oid.clone();
        let (Some(branch), Some(previous_head)) = (branch, previous_head) else {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_WORKTREE_UNSAFE",
                "The worktree HEAD is not an adoptable branch.",
                &state,
            ));
        };
        let carried_changes = target.worktree.summary.dirty;
        let expected_changes = if carried_changes {
            read_worktree_signature(&target.canonical_path).await?
        } else {
            String::new()
        };
        let target_git = GitProcess::new(&target.canonical_path);
        let main_git = GitProcess::new(&main.canonical_path);
        let mut stashed = false;
        let result = async {
            if carried_changes {
                target_git
                    .run(
                        "stash",
                        &[
                            "push".to_string(),
                            "--include-untracked".to_string(),
                            "--quiet".to_string(),
                            "--message".to_string(),
                            format!("task-handoff move-to-main: {branch}"),
                        ],
                    )
                    .await
                    .map_err(|_| ())?;
                stashed = true;
            }
            target_git
                .run("checkout", &["--detach".to_string(), "--quiet".to_string()])
                .await
                .map_err(|_| ())?;
            Ok::<(), ()>(())
        }
        .await;
        if let Err(()) = result {
            let failures = restore_target_worktree(&target_git, &branch, stashed).await;
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_OPERATION_FAILED",
                if failures.is_empty() {
                    "Git could not release the branch from the worktree.".to_string()
                } else {
                    format!(
                        "The worktree could not be restored ({}). Recover it from the retained stash entry before retrying.",
                        failures.join(", ")
                    )
                },
                &self.resolve(session_target).await,
            ));
        }
        if main_git
            .run("checkout", &["--quiet".to_string(), branch.clone()])
            .await
            .is_err()
        {
            let failures = restore_target_worktree(&target_git, &branch, stashed).await;
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_WORKTREE_UNSAFE",
                if failures.is_empty() {
                    "The main worktree could not adopt the branch.".to_string()
                } else {
                    format!(
                        "The main worktree could not adopt the branch, and the worktree could not be restored ({}). Recover it from the retained stash entry before retrying.",
                        failures.join(", ")
                    )
                },
                &self.resolve(session_target).await,
            ));
        }
        if stashed {
            if main_git
                .run(
                    "stash",
                    &[
                        "pop".to_string(),
                        "--index".to_string(),
                        "--quiet".to_string(),
                    ],
                )
                .await
                .is_err()
            {
                return Err(RepositoryOperationError::with_current(
                    "REPOSITORY_MOVE_CONFLICT",
                    "The carried changes could not be applied to the main worktree. Resolve them there and drop the retained stash entry; the worktree was left in place.",
                    &self.resolve(session_target).await,
                ));
            }
            if read_worktree_signature(&main.canonical_path).await? != expected_changes {
                return Err(RepositoryOperationError::with_current(
                    "REPOSITORY_WORKTREE_UNSAFE",
                    "The carried changes do not match the recorded worktree state. Nothing was removed.",
                    &self.resolve(session_target).await,
                ));
            }
        }
        if target.worktree.summary.managed {
            self.managed_worktree_registry
                .begin_remove(&target.worktree.summary.id, &target.canonical_path)
                .map_err(operation_failed)?;
        }
        let removed = GitProcess::new(state.worktree_root.as_ref().expect("required root"))
            .run(
                "worktree",
                &["remove".to_string(), display_path(&target.canonical_path)],
            )
            .await;
        if removed.is_err() {
            if target.worktree.summary.managed {
                self.managed_worktree_registry
                    .cancel_remove(&target.worktree.summary.id);
            }
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_OPERATION_FAILED",
                "The branch and its changes are now in the main worktree, but the worktree directory could not be removed.",
                &self.resolve(session_target).await,
            ));
        }
        if target.worktree.summary.managed {
            self.managed_worktree_registry
                .complete_remove(&target.worktree.summary.id);
        }
        let moved_worktree_id = target.worktree.summary.id.clone();
        let refreshed = require_repository(self.resolve(session_target).await)?;
        Ok(RepositoryMoveWorktreeResult {
            moved_worktree_id,
            adopted_branch: branch,
            previous_head,
            carried_changes,
            worktrees: self.list_worktrees_from_state(&refreshed, sessions).await?,
        })
    }

    pub async fn resolve_worktree_workspace(
        &self,
        session_target: &RepositorySessionTarget,
        sessions: &RepositorySessionInventory,
        repository_context_id: &str,
        worktree_id: &str,
    ) -> Result<PathBuf, RepositoryOperationError> {
        let state = require_repository(self.resolve(session_target).await)?;
        if state.context.repository_context_id.as_deref() != Some(repository_context_id) {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_STATE_STALE",
                "Repository context is stale.",
                &state,
            ));
        }
        let internal = self.list_worktrees_internal(&state, sessions).await?;
        let target = internal
            .iter()
            .find(|item| item.worktree.summary.id == worktree_id)
            .ok_or_else(|| {
                RepositoryOperationError::with_current(
                    "REPOSITORY_WORKTREE_NOT_FOUND",
                    "Worktree no longer exists.",
                    &state,
                )
            })?;
        if !target.worktree.can_create_ai_session {
            return Err(RepositoryOperationError::with_current(
                "REPOSITORY_WORKTREE_UNSAFE",
                format!(
                    "Worktree cannot host a new session: {}.",
                    blocker_list(&target.worktree.create_ai_session_blockers)
                ),
                &state,
            ));
        }
        match fs::canonicalize(&target.canonical_path) {
            Ok(canonical) if canonical.is_dir() => Ok(canonical),
            _ => Err(RepositoryOperationError::with_current(
                "REPOSITORY_WORKTREE_NOT_FOUND",
                "Worktree path is no longer accessible.",
                &self.resolve(session_target).await,
            )),
        }
    }

    async fn list_worktrees_internal(
        &self,
        state: &ResolvedRepository,
        sessions: &RepositorySessionInventory,
    ) -> Result<Vec<InternalWorktree>, RepositoryOperationError> {
        let output = GitProcess::new(state.worktree_root.as_ref().expect("required root"))
            .run(
                "worktree",
                &[
                    "list".to_string(),
                    "--porcelain".to_string(),
                    "-z".to_string(),
                ],
            )
            .await
            .map_err(|error| git_operation_error(error, state, "Git worktrees are unavailable."))?
            .stdout;
        let records = parse_worktree_porcelain(&output)
            .into_iter()
            .map(|record| WorktreeRecord {
                path: canonical_worktree_path(&record.path),
                ..record
            })
            .collect::<Vec<_>>();
        let repository_id = state.context.repository_id.clone().expect("repository id");
        let git_common_dir = state.git_common_dir.as_ref().expect("required common dir");
        let managed_ids =
            self.managed_worktree_registry
                .reconcile(&repository_id, git_common_dir, &records);
        let canonical_roots = self
            .workspace_roots
            .iter()
            .filter_map(|root| fs::canonicalize(root).ok())
            .collect::<Vec<_>>();
        let mut items = Vec::with_capacity(records.len());
        for (index, record) in records.iter().enumerate() {
            let canonical_path = canonical_worktree_path(&record.path);
            let id = repository_worktree_id(&repository_id, &canonical_path);
            let managed = managed_ids.contains(&id);
            let current = &canonical_path == state.worktree_root.as_ref().expect("required root");
            let authorized = current
                || managed
                || canonical_roots
                    .iter()
                    .any(|root| within_root(&canonical_path, root));
            let accessible = authorized && canonical_path.exists();
            let dirty = if accessible && !record.prunable {
                read_worktree_status(&canonical_path)
                    .await
                    .map(|status| summary_total(&status.summary) > 0)
                    .map_err(|error| {
                        git_operation_error(error, state, "Git worktree status is unavailable.")
                    })?
            } else {
                false
            };
            let ai_sessions =
                sessions_in_worktree(&sessions.ai_sessions, &canonical_path, |session| {
                    session.cwd.as_deref()
                });
            let active_ai_sessions = ai_sessions
                .iter()
                .copied()
                .filter(|session| is_live_session(session.status.as_deref()))
                .collect::<Vec<_>>();
            let active_ai_session_ids = active_ai_sessions
                .iter()
                .map(|session| session.id.clone())
                .collect::<Vec<_>>();
            let ai_app_session_ids = active_ai_sessions
                .iter()
                .filter_map(|session| session.app_session_id.clone())
                .collect::<HashSet<_>>();
            let app_sessions =
                sessions_in_worktree(&sessions.app_sessions, &canonical_path, |session| {
                    session.cwd.as_deref()
                });
            let active_app_session_ids = app_sessions
                .iter()
                .copied()
                .filter(|session| {
                    is_live_session(session.status.as_deref())
                        && !ai_app_session_ids.contains(&session.id)
                })
                .map(|session| session.id.clone())
                .collect::<Vec<_>>();
            let hosts_running_session = ai_sessions
                .iter()
                .any(|session| is_running_ai_session(session.status.as_deref()))
                || app_sessions.iter().any(|session| {
                    !ai_app_session_ids.contains(&session.id)
                        && session.status.as_deref() == Some("running")
                });
            let mut create_blockers = Vec::new();
            if !authorized {
                create_blockers.push(RepositoryWorktreeBlocker::OutsideWorkspaceRoots);
            }
            if !accessible {
                create_blockers.push(RepositoryWorktreeBlocker::PathInaccessible);
            }
            if record.locked {
                create_blockers.push(RepositoryWorktreeBlocker::Locked);
            }
            if record.prunable {
                create_blockers.push(RepositoryWorktreeBlocker::Prunable);
            }
            let mut remove_blockers = Vec::new();
            if index == 0 {
                remove_blockers.push(RepositoryWorktreeBlocker::MainWorktree);
            }
            if !authorized {
                remove_blockers.push(RepositoryWorktreeBlocker::OutsideWorkspaceRoots);
            }
            if !accessible {
                remove_blockers.push(RepositoryWorktreeBlocker::PathInaccessible);
            }
            if dirty {
                remove_blockers.push(RepositoryWorktreeBlocker::Dirty);
            }
            if record.locked {
                remove_blockers.push(RepositoryWorktreeBlocker::Locked);
            }
            if record.prunable {
                remove_blockers.push(RepositoryWorktreeBlocker::Prunable);
            }
            if !active_ai_session_ids.is_empty() || !active_app_session_ids.is_empty() {
                remove_blockers.push(RepositoryWorktreeBlocker::SessionOccupied);
            }
            let head = if record.detached {
                RepositoryHead {
                    state: RepositoryHeadState::Detached,
                    oid: record.head_oid.clone(),
                    branch: None,
                }
            } else if record.head_oid.is_some() {
                RepositoryHead {
                    state: RepositoryHeadState::Branch,
                    oid: record.head_oid.clone(),
                    branch: record.branch.clone(),
                }
            } else {
                RepositoryHead {
                    state: RepositoryHeadState::Unborn,
                    oid: None,
                    branch: record.branch.clone(),
                }
            };
            items.push(InternalWorktree {
                canonical_path,
                hosts_running_session,
                worktree: RepositoryWorktree {
                    summary: RepositoryWorktreeSummary {
                        id,
                        is_current: current,
                        is_main: index == 0,
                        managed,
                        head,
                        dirty,
                        locked: record.locked,
                        lock_reason: record.lock_reason.clone(),
                        prunable: record.prunable,
                        active_ai_session_ids,
                        active_app_session_ids,
                    },
                    can_create_ai_session: create_blockers.is_empty(),
                    can_remove: remove_blockers.is_empty(),
                    create_ai_session_blockers: create_blockers,
                    remove_blockers,
                },
            });
        }
        Ok(items)
    }
}

pub(crate) fn parse_worktree_porcelain(output: &str) -> Vec<WorktreeRecord> {
    let mut records = Vec::new();
    let mut current: Option<WorktreeRecord> = None;
    for field in output.split('\0') {
        if field.is_empty() {
            if let Some(record) = current.take() {
                records.push(record);
            }
            continue;
        }
        if let Some(path) = field.strip_prefix("worktree ") {
            if let Some(record) = current.take() {
                records.push(record);
            }
            current = Some(WorktreeRecord {
                path: PathBuf::from(path),
                head_oid: None,
                branch: None,
                detached: false,
                locked: false,
                lock_reason: None,
                prunable: false,
            });
        } else if let Some(value) = field.strip_prefix("HEAD ") {
            if let Some(record) = current.as_mut() {
                record.head_oid = Some(value.to_string());
            }
        } else if let Some(value) = field.strip_prefix("branch refs/heads/") {
            if let Some(record) = current.as_mut() {
                record.branch = Some(value.to_string());
            }
        } else if field == "detached" {
            if let Some(record) = current.as_mut() {
                record.detached = true;
            }
        } else if let Some(value) = field.strip_prefix("locked") {
            if let Some(record) = current.as_mut() {
                record.locked = true;
                record.lock_reason =
                    Some(value.trim().to_string()).filter(|value| !value.is_empty());
            }
        } else if field.starts_with("prunable") {
            if let Some(record) = current.as_mut() {
                record.prunable = true;
            }
        }
    }
    if let Some(record) = current {
        records.push(record);
    }
    records
}

fn load_registry_entries(
    registry_path: &Path,
    root: &Path,
) -> BTreeMap<String, ManagedWorktreeEntry> {
    let Ok(bytes) = fs::read(registry_path) else {
        return BTreeMap::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        tracing::warn!(
            "[managed-worktrees] registry could not be loaded; managed ownership is unavailable"
        );
        return BTreeMap::new();
    };
    let version = value.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version != 1 && version != REGISTRY_VERSION as u64 {
        tracing::warn!(
            version,
            "[managed-worktrees] unsupported registry version; managed ownership is unavailable"
        );
        return BTreeMap::new();
    }
    let legacy_registry = version == 1;
    let mut entries = BTreeMap::new();
    for item in value
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(object) = item.as_object() else {
            continue;
        };
        let Some(repository_id) = object.get("repositoryId").and_then(Value::as_str) else {
            continue;
        };
        let Some(worktree_id) = object.get("worktreeId").and_then(Value::as_str) else {
            continue;
        };
        let Some(path) = object.get("path").and_then(Value::as_str) else {
            continue;
        };
        let Some(created_at) = object.get("createdAt").and_then(Value::as_str) else {
            continue;
        };
        let resolved = absolute_path(Path::new(path));
        if !within_root(&resolved, root) {
            continue;
        }
        let generation_id = object
            .get("generationId")
            .and_then(Value::as_str)
            .filter(|value| is_generation_id(value))
            .map(ToString::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let state = match object.get("state").and_then(Value::as_str) {
            Some("preparing") => ManagedWorktreeState::Preparing,
            Some("removing") => ManagedWorktreeState::Removing,
            Some("quarantined") => ManagedWorktreeState::Quarantined,
            _ => ManagedWorktreeState::Ready,
        };
        let intent = object.get("intent").and_then(sanitize_managed_intent);
        let legacy = legacy_registry || object.get("legacy").and_then(Value::as_bool) == Some(true);
        entries.insert(
            worktree_id.to_string(),
            ManagedWorktreeEntry {
                repository_id: repository_id.to_string(),
                worktree_id: worktree_id.to_string(),
                path: display_path(&resolved),
                created_at: created_at.to_string(),
                generation_id,
                state,
                intent,
                legacy,
            },
        );
    }
    entries
}

fn sanitize_managed_intent(value: &Value) -> Option<ManagedWorktreeIntent> {
    let object = value.as_object()?;
    let reference = object.get("ref")?.as_object()?;
    let reference = match reference.get("type").and_then(Value::as_str) {
        Some("head") => RepositoryWorktreeRef::Head,
        Some("branch") => RepositoryWorktreeRef::Branch {
            name: reference.get("name")?.as_str()?.to_string(),
        },
        _ => return None,
    };
    let resolved_oid = object.get("resolvedOid")?.as_str()?;
    if !is_oid(resolved_oid) {
        return None;
    }
    let checkout = match object.get("checkout").and_then(Value::as_str) {
        Some("attached") => ManagedCheckout::Attached,
        Some("detached") => ManagedCheckout::Detached,
        _ => return None,
    };
    let request_id = match object.get("requestId") {
        None => None,
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => return None,
    };
    Some(ManagedWorktreeIntent {
        request_id,
        reference,
        resolved_oid: resolved_oid.to_string(),
        checkout,
    })
}

fn persist_registry(state: &RegistryState) -> Result<(), String> {
    let entries = state.entries.values().cloned().collect::<Vec<_>>();
    let value = json!({ "version": REGISTRY_VERSION, "entries": entries });
    write_json_atomic(&state.registry_path, &value, Some(0o600))
        .map_err(|error| format!("Managed worktree registry could not be written: {error}"))
}

fn ensure_registry_root(state: &mut RegistryState) -> Result<(), String> {
    fs::create_dir_all(&state.root)
        .map_err(|error| format!("Managed worktree root could not be created: {error}"))?;
    let _ = fs_permissions::restrict_path(&state.root, 0o700);
    let canonical = fs::canonicalize(&state.root)
        .map_err(|error| format!("Managed worktree root is inaccessible: {error}"))?;
    if canonical != state.root {
        state.root = canonical;
        state.registry_path = state.root.join("registry.json");
    }
    Ok(())
}

fn require_entry<'a>(
    state: &'a RegistryState,
    worktree_id: &str,
    worktree_path: &Path,
) -> Result<&'a ManagedWorktreeEntry, String> {
    let entry = state
        .entries
        .get(worktree_id)
        .ok_or_else(|| "Managed worktree ownership could not be verified.".to_string())?;
    if absolute_path(Path::new(&entry.path)) != absolute_path(worktree_path)
        || !within_root(Path::new(&entry.path), &state.root)
    {
        return Err("Managed worktree ownership could not be verified.".to_string());
    }
    Ok(entry)
}

fn worktree_slug(branch_name: &str) -> String {
    let normalized = branch_name.nfkd().collect::<String>();
    let mut slug = String::new();
    let mut separator = false;
    for character in normalized.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            separator = false;
            slug.push(character);
        } else {
            separator = true;
        }
    }
    let slug = slug.trim_matches('-').chars().take(48).collect::<String>();
    if slug.is_empty() {
        "worktree".to_string()
    } else {
        slug
    }
}

fn record_matches_intent(record: &WorktreeRecord, intent: &ManagedWorktreeIntent) -> bool {
    if record.prunable || record.head_oid.is_none() {
        return false;
    }
    if intent.checkout == ManagedCheckout::Detached {
        return record.detached && record.head_oid.as_deref() == Some(intent.resolved_oid.as_str());
    }
    !record.detached
        && matches!(&intent.reference, RepositoryWorktreeRef::Branch { name } if record.branch.as_deref() == Some(name.as_str()))
        && record.head_oid.as_deref() == Some(intent.resolved_oid.as_str())
}

fn read_generation_marker(worktree_path: &Path, git_common_dir: &Path) -> Option<String> {
    let admin_dir = linked_worktree_admin_dir(worktree_path, git_common_dir)?;
    let value = fs::read_to_string(admin_dir.join(GENERATION_MARKER)).ok()?;
    let value = value.trim();
    is_generation_id(value).then(|| value.to_string())
}

fn write_generation_marker(
    worktree_path: &Path,
    git_common_dir: &Path,
    generation_id: &str,
) -> Result<(), String> {
    let admin_dir = linked_worktree_admin_dir(worktree_path, git_common_dir)
        .ok_or_else(|| "Git linked-worktree ownership could not be verified.".to_string())?;
    let marker_path = admin_dir.join(GENERATION_MARKER);
    match fs::read_to_string(&marker_path) {
        Ok(existing) if existing.trim() == generation_id => return Ok(()),
        Ok(_) => {
            return Err(
                "Git linked-worktree generation belongs to another managed worktree.".to_string(),
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Git generation marker could not be read: {error}")),
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker_path)
        .map_err(|error| format!("Git generation marker could not be written: {error}"))?;
    file.write_all(format!("{generation_id}\n").as_bytes())
        .map_err(|error| format!("Git generation marker could not be written: {error}"))?;
    let _ = fs_permissions::restrict_path(&marker_path, 0o600);
    Ok(())
}

fn linked_worktree_admin_dir(worktree_path: &Path, git_common_dir: &Path) -> Option<PathBuf> {
    let git_file_path = worktree_path.join(".git");
    let worktrees_root = absolute_path(git_common_dir).join("worktrees");
    if fs::metadata(&git_file_path).is_ok_and(|metadata| metadata.is_file()) {
        if let Ok(git_file) = fs::read_to_string(&git_file_path) {
            for line in git_file.lines() {
                if line.to_ascii_lowercase().starts_with("gitdir:") {
                    let value = line[7..].trim();
                    if value.is_empty() {
                        continue;
                    }
                    let candidate = absolute_path(&worktree_path.join(value));
                    if candidate.parent() == Some(worktrees_root.as_path())
                        && admin_dir_points_to_worktree(&candidate, &git_file_path)
                    {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    let entries = fs::read_dir(&worktrees_root).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        if admin_dir_points_to_worktree(&candidate, &git_file_path) {
            return Some(candidate);
        }
    }
    None
}

fn admin_dir_points_to_worktree(admin_dir: &Path, git_file_path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(admin_dir) else {
        return false;
    };
    if !metadata.is_dir() {
        return false;
    }
    let Ok(backlink) = fs::read_to_string(admin_dir.join("gitdir")) else {
        return false;
    };
    let resolved = absolute_path(&admin_dir.join(backlink.trim()));
    paths_equal(&resolved, &absolute_path(git_file_path))
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

async fn resolve_commit_oid(git: &GitProcess, revision: &str) -> Option<String> {
    git.run(
        "rev-parse",
        &[
            "--verify".to_string(),
            "--end-of-options".to_string(),
            format!("{revision}^{{commit}}"),
        ],
    )
    .await
    .ok()
    .map(|result| result.stdout.trim().to_string())
    .filter(|value| !value.is_empty())
}

fn has_attached_branch(worktrees: &[InternalWorktree], branch_name: &str) -> bool {
    worktrees.iter().any(|item| {
        item.worktree.summary.head.state == RepositoryHeadState::Branch
            && item.worktree.summary.head.branch.as_deref() == Some(branch_name)
    })
}

async fn worktree_change_summary(
    target: &InternalWorktree,
) -> Result<controlled_instance_protocol::RepositoryChangeSummary, RepositoryOperationError> {
    if target.worktree.summary.prunable || !target.canonical_path.exists() {
        return Ok(Default::default());
    }
    read_worktree_status(&target.canonical_path)
        .await
        .map(|status| status.summary)
        .map_err(|error| {
            RepositoryOperationError::new(
                "REPOSITORY_OPERATION_FAILED",
                git_error_message(error, "Worktree changes are unavailable."),
            )
        })
}

async fn read_worktree_signature(worktree_path: &Path) -> Result<String, RepositoryOperationError> {
    read_worktree_status(worktree_path)
        .await
        .map(|status| status.signature)
        .map_err(|error| {
            RepositoryOperationError::new(
                "REPOSITORY_OPERATION_FAILED",
                git_error_message(error, "Worktree changes are unavailable."),
            )
        })
}

fn move_worktree_blockers(
    target: &InternalWorktree,
    main: &InternalWorktree,
) -> Vec<RepositoryMoveWorktreeBlocker> {
    let mut blockers = Vec::new();
    if main.worktree.summary.dirty {
        blockers.push(RepositoryMoveWorktreeBlocker::MainDirty);
    }
    if main.hosts_running_session {
        blockers.push(RepositoryMoveWorktreeBlocker::MainSessionOccupied);
    }
    for blocker in &target.worktree.remove_blockers {
        match blocker {
            RepositoryWorktreeBlocker::MainWorktree => {
                blockers.push(RepositoryMoveWorktreeBlocker::MainWorktree)
            }
            RepositoryWorktreeBlocker::OutsideWorkspaceRoots => {
                blockers.push(RepositoryMoveWorktreeBlocker::OutsideWorkspaceRoots)
            }
            RepositoryWorktreeBlocker::PathInaccessible => {
                blockers.push(RepositoryMoveWorktreeBlocker::PathInaccessible)
            }
            RepositoryWorktreeBlocker::Locked => {
                blockers.push(RepositoryMoveWorktreeBlocker::Locked)
            }
            RepositoryWorktreeBlocker::Prunable => {
                blockers.push(RepositoryMoveWorktreeBlocker::Prunable)
            }
            RepositoryWorktreeBlocker::SessionOccupied => {
                blockers.push(RepositoryMoveWorktreeBlocker::SessionOccupied)
            }
            RepositoryWorktreeBlocker::Dirty | RepositoryWorktreeBlocker::ExternalWorktree => {}
        }
    }
    match target.worktree.summary.head.state {
        RepositoryHeadState::Detached => blockers.push(RepositoryMoveWorktreeBlocker::DetachedHead),
        RepositoryHeadState::Unborn => blockers.push(RepositoryMoveWorktreeBlocker::UnbornHead),
        RepositoryHeadState::Branch => {}
    }
    blockers
}

fn sessions_in_worktree<'a, T, F>(sessions: &'a [T], worktree_path: &Path, cwd: F) -> Vec<&'a T>
where
    F: Fn(&T) -> Option<&str>,
{
    sessions
        .iter()
        .filter(|session| {
            let Some(value) = cwd(session).filter(|value| !value.trim().is_empty()) else {
                return false;
            };
            let candidate = match fs::canonicalize(value) {
                Ok(path) => path,
                Err(_) if Path::new(value).is_absolute() => absolute_path(Path::new(value)),
                Err(_) => return false,
            };
            within_root(&candidate, worktree_path)
        })
        .collect()
}

fn is_live_session(status: Option<&str>) -> bool {
    !status.is_some_and(|status| TERMINAL_SESSION_STATUSES.contains(&status))
}

fn is_running_ai_session(status: Option<&str>) -> bool {
    matches!(status, Some("running" | "waiting"))
}

async fn restore_target_worktree(
    git: &GitProcess,
    branch: &str,
    stashed: bool,
) -> Vec<&'static str> {
    let mut failures = Vec::new();
    if git
        .run("checkout", &["--quiet".to_string(), branch.to_string()])
        .await
        .is_err()
    {
        failures.push("branch checkout");
    }
    if stashed
        && git
            .run(
                "stash",
                &[
                    "pop".to_string(),
                    "--index".to_string(),
                    "--quiet".to_string(),
                ],
            )
            .await
            .is_err()
    {
        failures.push("stash restore");
    }
    failures
}

fn summary_total(summary: &controlled_instance_protocol::RepositoryChangeSummary) -> u64 {
    summary.conflicts + summary.staged + summary.unstaged + summary.untracked
}

fn blocker_list(blockers: &[RepositoryWorktreeBlocker]) -> String {
    blockers
        .iter()
        .map(|blocker| match blocker {
            RepositoryWorktreeBlocker::MainWorktree => "main-worktree",
            RepositoryWorktreeBlocker::ExternalWorktree => "external-worktree",
            RepositoryWorktreeBlocker::OutsideWorkspaceRoots => "outside-workspace-roots",
            RepositoryWorktreeBlocker::Dirty => "dirty",
            RepositoryWorktreeBlocker::Locked => "locked",
            RepositoryWorktreeBlocker::Prunable => "prunable",
            RepositoryWorktreeBlocker::SessionOccupied => "session-occupied",
            RepositoryWorktreeBlocker::PathInaccessible => "path-inaccessible",
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn move_blocker_list(blockers: &[RepositoryMoveWorktreeBlocker]) -> String {
    blockers
        .iter()
        .map(|blocker| match blocker {
            RepositoryMoveWorktreeBlocker::MainWorktree => "main-worktree",
            RepositoryMoveWorktreeBlocker::OutsideWorkspaceRoots => "outside-workspace-roots",
            RepositoryMoveWorktreeBlocker::PathInaccessible => "path-inaccessible",
            RepositoryMoveWorktreeBlocker::Locked => "locked",
            RepositoryMoveWorktreeBlocker::Prunable => "prunable",
            RepositoryMoveWorktreeBlocker::SessionOccupied => "session-occupied",
            RepositoryMoveWorktreeBlocker::MainSessionOccupied => "main-session-occupied",
            RepositoryMoveWorktreeBlocker::DetachedHead => "detached-head",
            RepositoryMoveWorktreeBlocker::UnbornHead => "unborn-head",
            RepositoryMoveWorktreeBlocker::MainDirty => "main-dirty",
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn git_operation_error(
    error: GitError,
    state: &ResolvedRepository,
    message: &str,
) -> RepositoryOperationError {
    match error {
        GitError::NotFound => RepositoryOperationError::with_current(
            "REPOSITORY_GIT_UNAVAILABLE",
            "Git executable is unavailable.",
            state,
        ),
        GitError::Timeout(_) => RepositoryOperationError::with_current(
            "REPOSITORY_COMMAND_TIMEOUT",
            "Git operation timed out.",
            state,
        ),
        GitError::OutputLimit(_) => RepositoryOperationError::with_current(
            "REPOSITORY_OUTPUT_LIMIT",
            "Git operation exceeded its output limit.",
            state,
        ),
        GitError::Aborted => RepositoryOperationError::with_current(
            "REPOSITORY_OPERATION_ABORTED",
            "Git operation was aborted.",
            state,
        ),
        other => RepositoryOperationError::with_current(
            "REPOSITORY_OPERATION_FAILED",
            git_error_message(other, message),
            state,
        ),
    }
}

fn git_error_message(error: GitError, fallback: &str) -> String {
    match error {
        GitError::Exit { .. } => fallback.to_string(),
        _ => error.to_string(),
    }
}

fn operation_failed(message: String) -> RepositoryOperationError {
    RepositoryOperationError::new("REPOSITORY_OPERATION_FAILED", message)
}

async fn cleanup_failed_worktree_creation(
    git: &GitProcess,
    destination: &Path,
    added: bool,
    registry: &ManagedWorktreeRegistry,
    worktree_id: &str,
) {
    let mut removed = !added;
    if added {
        removed = git
            .run(
                "worktree",
                &["remove".to_string(), display_path(destination)],
            )
            .await
            .is_ok();
    }
    if removed {
        let _ = fs::remove_dir_all(destination);
        registry.abort_preparation(worktree_id);
    }
}

pub(crate) fn canonical_worktree_path(value: &Path) -> PathBuf {
    fs::canonicalize(value).unwrap_or_else(|_| absolute_path(value))
}

fn absolute_path(value: &Path) -> PathBuf {
    if value.is_absolute() {
        normalize_path(value)
    } else {
        normalize_path(&std::env::current_dir().unwrap_or_default().join(value))
    }
}

fn normalize_path(value: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in value.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    result.push(component.as_os_str());
                }
            }
            _ => result.push(component.as_os_str()),
        }
    }
    result
}

fn within_root(candidate: &Path, root: &Path) -> bool {
    let candidate = absolute_path(candidate);
    let root = absolute_path(root);
    if candidate == root {
        return true;
    }
    let Ok(relative) = candidate.strip_prefix(&root) else {
        return false;
    };
    match relative.components().next() {
        Some(Component::Normal(value)) => !value.to_string_lossy().starts_with(".."),
        Some(Component::ParentDir) => false,
        _ => true,
    }
}

fn is_generation_id(value: &str) -> bool {
    value.len() == 36
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
}

fn is_oid(value: &str) -> bool {
    (40..=64).contains(&value.len()) && value.chars().all(|character| character.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_protocol::RepositoryMoveWorktreePreflightRequest;
    use std::process::Command;

    fn run_git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn repository() -> tempfile::TempDir {
        let root = tempfile::tempdir().expect("repository");
        run_git(root.path(), &["init", "-b", "main"]);
        run_git(root.path(), &["config", "user.email", "test@example.com"]);
        run_git(root.path(), &["config", "user.name", "Test User"]);
        fs::write(root.path().join("README.md"), "initial\n").expect("readme");
        run_git(root.path(), &["add", "README.md"]);
        run_git(root.path(), &["commit", "-m", "initial"]);
        root
    }

    fn target(root: &Path) -> RepositorySessionTarget {
        RepositorySessionTarget {
            kind: controlled_instance_protocol::RepositorySessionKind::AiSession,
            id: "ses_0000000000001".to_string(),
            session_found: true,
            cwd: Some(root.display().to_string()),
            status: Some("idle".to_string()),
        }
    }

    fn make_service(root: &Path, managed: &Path) -> RepositoryService {
        RepositoryService::new_with_managed_root(vec![root.to_path_buf()], managed)
    }

    fn empty_inventory() -> RepositorySessionInventory {
        RepositorySessionInventory::default()
    }

    #[test]
    fn worktree_porcelain_matches_the_node_field_parser() {
        let output = "worktree /tmp/main\0HEAD abcdef\0branch refs/heads/main\0\0worktree /tmp/linked\0HEAD fedcba\0detached\0locked maintenance\0prunable gone\0\0";
        let records = parse_worktree_porcelain(output);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].branch.as_deref(), Some("main"));
        assert!(records[1].detached);
        assert!(records[1].locked);
        assert_eq!(records[1].lock_reason.as_deref(), Some("maintenance"));
        assert!(records[1].prunable);
    }

    #[test]
    fn managed_intent_rejects_null_and_empty_request_ids_like_node() {
        let valid = json!({
            "ref": { "type": "head" },
            "resolvedOid": "a".repeat(40),
            "checkout": "attached"
        });
        assert!(sanitize_managed_intent(&valid).is_some());

        let mut null_request_id = valid.clone();
        null_request_id["requestId"] = Value::Null;
        assert!(sanitize_managed_intent(&null_request_id).is_none());

        let mut empty_request_id = valid;
        empty_request_id["requestId"] = Value::String(String::new());
        assert!(sanitize_managed_intent(&empty_request_id).is_none());
    }

    #[test]
    fn within_root_rejects_relative_paths_that_start_with_two_dots() {
        let root = tempfile::tempdir().expect("root");
        let root = fs::canonicalize(root.path()).expect("canonical root");
        assert!(within_root(&root.join("nested"), &root));
        assert!(!within_root(&root.join("..foo"), &root));
    }

    #[test]
    fn sessions_in_worktree_canonicalizes_relative_cwds_before_containment() {
        let current = std::env::current_dir().expect("current directory");
        let current = fs::canonicalize(&current).unwrap_or(current);
        let root = tempfile::Builder::new()
            .prefix(".controlled-instance-worktree-")
            .tempdir_in(&current)
            .expect("temporary worktree");
        let worktree = fs::canonicalize(root.path()).expect("canonical worktree");
        fs::create_dir_all(worktree.join("project")).expect("project directory");
        let relative_cwd = worktree
            .strip_prefix(&current)
            .expect("relative worktree path")
            .join("project")
            .display()
            .to_string();
        let sessions = vec![RepositoryAiSessionPresence {
            id: "ses_relative".to_string(),
            app_session_id: None,
            cwd: Some(relative_cwd),
            status: Some("idle".to_string()),
        }];

        let matched = sessions_in_worktree(&sessions, &worktree, |session| session.cwd.as_deref());
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].id, "ses_relative");
    }

    #[tokio::test]
    async fn worktree_status_failures_are_propagated_instead_of_treated_as_clean() {
        let repository = repository();
        let managed = tempfile::tempdir().expect("managed root");
        let service = make_service(repository.path(), managed.path());
        let target = target(repository.path());
        let sessions = empty_inventory();
        let resolved = require_repository(service.resolve(&target).await).expect("resolved");
        let snapshot = resolved.context.snapshot_id.clone().expect("snapshot");
        service
            .create_worktree(
                &target,
                &sessions,
                RepositoryCreateWorktreeRequest::NewBranch {
                    branch_name: "broken-status".to_string(),
                    start_ref: "HEAD".to_string(),
                    expected_snapshot_id: snapshot,
                },
            )
            .await
            .expect("create worktree");
        let repository_directory = managed.path().join(
            resolved
                .context
                .repository_id
                .as_deref()
                .expect("repository id")
                .trim_start_matches("repo:"),
        );
        let linked_path = fs::read_dir(repository_directory)
            .expect("managed repository directory")
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("broken-status-")
            })
            .expect("linked worktree")
            .path();
        let index_path = run_git(&linked_path, &["rev-parse", "--git-path", "index"]);
        let index_path = PathBuf::from(index_path);
        let index_path = if index_path.is_absolute() {
            index_path
        } else {
            linked_path.join(index_path)
        };
        fs::write(index_path, b"not a git index").expect("corrupt worktree index");

        let error = service
            .list_worktrees(&target, &sessions)
            .await
            .expect_err("status failure must be returned");
        assert_eq!(error.code, "REPOSITORY_OPERATION_FAILED");
    }

    #[tokio::test]
    async fn create_list_remove_and_session_blockers_follow_the_node_contract() {
        let repository = repository();
        let managed = tempfile::tempdir().expect("managed root");
        let service = make_service(repository.path(), managed.path());
        let target = target(repository.path());
        let sessions = empty_inventory();
        let resolved = require_repository(service.resolve(&target).await).expect("resolved");
        let snapshot = resolved.context.snapshot_id.clone().expect("snapshot");
        let initial = service
            .list_worktrees(&target, &sessions)
            .await
            .expect("initial worktrees");
        assert_eq!(initial.items.len(), 1);
        assert!(initial.items[0].summary.is_current);
        assert!(initial.items[0].summary.is_main);
        assert!(!initial.items[0].can_remove);

        let created = service
            .create_worktree(
                &target,
                &sessions,
                RepositoryCreateWorktreeRequest::NewBranch {
                    branch_name: "feature".to_string(),
                    start_ref: "HEAD".to_string(),
                    expected_snapshot_id: snapshot.clone(),
                },
            )
            .await
            .expect("create worktree");
        assert_eq!(created.worktrees.items.len(), 2);
        let feature = created
            .worktrees
            .items
            .iter()
            .find(|item| item.summary.id == created.worktree_id)
            .expect("created item");
        assert!(feature.summary.managed);
        assert!(!feature.summary.is_main);
        assert_eq!(feature.summary.head.branch.as_deref(), Some("feature"));
        assert!(feature.can_create_ai_session);
        assert!(feature.can_remove);
        let feature_path = created
            .worktrees
            .items
            .iter()
            .find(|item| item.summary.id == created.worktree_id)
            .map(|_| {
                let directory = managed.path().join(
                    resolved
                        .context
                        .repository_id
                        .as_deref()
                        .unwrap()
                        .trim_start_matches("repo:"),
                );
                fs::read_dir(directory)
                    .expect("managed directory")
                    .flatten()
                    .find(|entry| entry.file_name().to_string_lossy().starts_with("feature-"))
                    .expect("feature directory")
                    .path()
            })
            .expect("feature path");
        fs::write(feature_path.join("README.md"), "dirty\n").expect("dirty file");
        let with_changes = service
            .list_worktrees(&target, &sessions)
            .await
            .expect("worktrees after edit");
        let feature = with_changes
            .items
            .iter()
            .find(|item| item.summary.id == created.worktree_id)
            .expect("feature after edit");
        assert!(feature.summary.dirty);
        assert!(feature
            .remove_blockers
            .contains(&RepositoryWorktreeBlocker::Dirty));
        let remove_error = service
            .remove_worktree(
                &target,
                &sessions,
                RepositoryRemoveWorktreeRequest {
                    worktree_id: created.worktree_id.clone(),
                    expected_snapshot_id: with_changes.snapshot_id.clone(),
                    confirm: true,
                },
            )
            .await
            .expect_err("dirty removal must fail");
        assert_eq!(remove_error.code, "REPOSITORY_WORKTREE_UNSAFE");

        let occupied = RepositorySessionInventory {
            ai_sessions: vec![RepositoryAiSessionPresence {
                id: "ses_running".to_string(),
                app_session_id: Some("aps_host".to_string()),
                cwd: Some(feature_path.display().to_string()),
                status: Some("running".to_string()),
            }],
            app_sessions: vec![RepositoryAppSessionPresence {
                id: "aps_host".to_string(),
                cwd: Some(feature_path.display().to_string()),
                status: Some("running".to_string()),
            }],
        };
        let occupied_list = service
            .list_worktrees(&target, &occupied)
            .await
            .expect("occupied worktrees");
        let feature = occupied_list
            .items
            .iter()
            .find(|item| item.summary.id == created.worktree_id)
            .expect("occupied feature");
        assert_eq!(
            feature.summary.active_ai_session_ids,
            vec!["ses_running".to_string()]
        );
        assert!(feature.summary.active_app_session_ids.is_empty());
        assert!(feature
            .remove_blockers
            .contains(&RepositoryWorktreeBlocker::SessionOccupied));

        run_git(&feature_path, &["restore", "README.md"]);
        let clean = service
            .list_worktrees(&target, &sessions)
            .await
            .expect("clean worktrees");
        let removed = service
            .remove_worktree(
                &target,
                &sessions,
                RepositoryRemoveWorktreeRequest {
                    worktree_id: created.worktree_id.clone(),
                    expected_snapshot_id: clean.snapshot_id,
                    confirm: true,
                },
            )
            .await
            .expect("remove clean worktree");
        assert_eq!(removed.removed_worktree_id, created.worktree_id);
        assert!(removed.branch_retained);
        assert_eq!(removed.worktrees.items.len(), 1);
    }

    #[tokio::test]
    async fn failed_git_add_aborts_the_preparing_registry_and_cleans_the_destination() {
        let repository = repository();
        run_git(repository.path(), &["branch", "already-exists"]);
        let managed = tempfile::tempdir().expect("managed root");
        let service = make_service(repository.path(), managed.path());
        let target = target(repository.path());
        let sessions = empty_inventory();
        let resolved = require_repository(service.resolve(&target).await).expect("resolved");
        let snapshot = resolved.context.snapshot_id.clone().expect("snapshot");

        let error = service
            .create_worktree(
                &target,
                &sessions,
                RepositoryCreateWorktreeRequest::NewBranch {
                    branch_name: "already-exists".to_string(),
                    start_ref: "HEAD".to_string(),
                    expected_snapshot_id: snapshot,
                },
            )
            .await
            .expect_err("git worktree add must fail for an existing branch");
        assert_eq!(error.code, "REPOSITORY_OPERATION_FAILED");

        let registry: Value = serde_json::from_slice(
            &fs::read(managed.path().join("registry.json")).expect("registry"),
        )
        .expect("registry json");
        assert_eq!(registry["version"], 2);
        assert_eq!(registry["entries"].as_array().expect("entries").len(), 0);

        let repository_directory = managed.path().join(
            resolved
                .context
                .repository_id
                .as_deref()
                .expect("repository id")
                .trim_start_matches("repo:"),
        );
        assert_eq!(
            fs::read_dir(repository_directory)
                .expect("managed repository directory")
                .count(),
            0
        );
        assert_eq!(
            service
                .list_worktrees(&target, &sessions)
                .await
                .expect("worktrees")
                .items
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn managed_registry_accepts_v1_and_writes_v2_with_a_generation_marker() {
        let repository = repository();
        let managed = tempfile::tempdir().expect("managed root");
        let service = make_service(repository.path(), managed.path());
        let target = target(repository.path());
        let sessions = empty_inventory();
        let resolved = require_repository(service.resolve(&target).await).expect("resolved");
        let snapshot = resolved.context.snapshot_id.clone().expect("snapshot");
        let created = service
            .create_worktree(
                &target,
                &sessions,
                RepositoryCreateWorktreeRequest::NewBranch {
                    branch_name: "registry".to_string(),
                    start_ref: "HEAD".to_string(),
                    expected_snapshot_id: snapshot,
                },
            )
            .await
            .expect("create");
        let registry_path = managed.path().join("registry.json");
        let value: Value =
            serde_json::from_slice(&fs::read(&registry_path).expect("registry")).expect("json");
        assert_eq!(value["version"], 2);
        let entry = &value["entries"][0];
        assert_eq!(entry["worktreeId"], created.worktree_id);
        assert_eq!(entry["state"], "ready");
        let path = PathBuf::from(entry["path"].as_str().expect("path"));
        let common = run_git(repository.path(), &["rev-parse", "--git-common-dir"]);
        let common = repository.path().join(common);
        let admin = linked_worktree_admin_dir(&path, &common).expect("admin dir");
        let marker = fs::read_to_string(admin.join(GENERATION_MARKER)).expect("marker");
        assert_eq!(marker.trim(), entry["generationId"].as_str().unwrap());

        let legacy = json!({
            "version": 1,
            "entries": [{
                "repositoryId": entry["repositoryId"].clone(),
                "worktreeId": entry["worktreeId"].clone(),
                "path": entry["path"].clone(),
                "createdAt": entry["createdAt"].clone()
            }]
        });
        fs::write(&registry_path, serde_json::to_vec_pretty(&legacy).unwrap()).expect("v1 write");
        let reloaded_service = make_service(repository.path(), managed.path());
        let list = reloaded_service
            .list_worktrees(&target, &sessions)
            .await
            .expect("list after v1");
        assert!(list.items.iter().any(|item| item.summary.managed));
        let persisted: Value =
            serde_json::from_slice(&fs::read(&registry_path).expect("rewritten registry"))
                .expect("json");
        assert_eq!(persisted["version"], 2);
        assert_ne!(persisted["entries"][0]["legacy"], true);
    }

    #[tokio::test]
    async fn move_to_main_carries_changes_and_releases_the_linked_worktree() {
        let repository = repository();
        let managed = tempfile::tempdir().expect("managed root");
        let service = make_service(repository.path(), managed.path());
        let target = target(repository.path());
        let sessions = empty_inventory();
        let resolved = require_repository(service.resolve(&target).await).expect("resolved");
        let created = service
            .create_worktree(
                &target,
                &sessions,
                RepositoryCreateWorktreeRequest::NewBranch {
                    branch_name: "move-me".to_string(),
                    start_ref: "HEAD".to_string(),
                    expected_snapshot_id: resolved.context.snapshot_id.unwrap(),
                },
            )
            .await
            .expect("create");
        let item = created
            .worktrees
            .items
            .iter()
            .find(|item| item.summary.id == created.worktree_id)
            .expect("created item");
        let worktree_path = created
            .worktrees
            .items
            .iter()
            .find(|item| item.summary.id == created.worktree_id)
            .and_then(|item| {
                item.summary
                    .head
                    .branch
                    .as_ref()
                    .map(|_| item.summary.id.clone())
            })
            .map(|_| {
                let directory = managed.path().join(
                    resolved
                        .context
                        .repository_id
                        .as_deref()
                        .unwrap()
                        .trim_start_matches("repo:"),
                );
                fs::read_dir(directory)
                    .expect("managed directory")
                    .flatten()
                    .find(|entry| entry.file_name().to_string_lossy().starts_with("move-me-"))
                    .expect("move-me directory")
                    .path()
            })
            .expect("path");
        assert_eq!(item.summary.head.branch.as_deref(), Some("move-me"));
        fs::write(worktree_path.join("README.md"), "carried\n").expect("modify");
        fs::write(worktree_path.join("new.txt"), "untracked\n").expect("untracked");
        let dirty = service
            .list_worktrees(&target, &sessions)
            .await
            .expect("dirty list");
        let preflight = service
            .move_worktree_to_main_preflight(
                &target,
                &sessions,
                RepositoryMoveWorktreePreflightRequest {
                    worktree_id: created.worktree_id.clone(),
                },
            )
            .await
            .expect("preflight");
        assert!(preflight.can_move);
        assert_eq!(preflight.target_changes.unstaged, 1);
        assert_eq!(preflight.target_changes.untracked, 1);
        let moved = service
            .move_worktree_to_main(
                &target,
                &sessions,
                RepositoryMoveWorktreeRequest {
                    worktree_id: created.worktree_id.clone(),
                    expected_snapshot_id: dirty.snapshot_id,
                    confirm: true,
                },
            )
            .await
            .expect("move");
        assert_eq!(moved.adopted_branch, "move-me");
        assert!(moved.carried_changes);
        assert_eq!(moved.worktrees.items.len(), 1);
        assert_eq!(
            moved.worktrees.items[0].summary.head.branch.as_deref(),
            Some("move-me")
        );
        assert_eq!(
            fs::read_to_string(repository.path().join("README.md")).unwrap(),
            "carried\n"
        );
        assert_eq!(
            fs::read_to_string(repository.path().join("new.txt")).unwrap(),
            "untracked\n"
        );
    }
}
