use serde::{Deserialize, Serialize};

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositorySessionKind {
    AiSession,
    AppSession,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryAvailability {
    Available,
    SessionNotFound,
    SessionInactive,
    CwdMissing,
    CwdInaccessible,
    GitUnavailable,
    NotWorktree,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryHeadState {
    Branch,
    Detached,
    Unborn,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryPrimaryAction {
    ReviewChanges,
    ResolveConflicts,
    PublishBranch,
    Push,
    Pull,
    Diverged,
    UpToDate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryChangeScope {
    Conflict,
    Staged,
    Unstaged,
    Untracked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Untracked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryHead {
    pub state: RepositoryHeadState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryUpstream {
    pub ref_name: String,
    pub remote: String,
    pub branch: String,
    pub ahead: u64,
    pub behind: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryChangeSummary {
    pub conflicts: u64,
    pub staged: u64,
    pub unstaged: u64,
    pub untracked: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRemote {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetch_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryWorktreeSummary {
    pub id: String,
    pub is_current: bool,
    pub is_main: bool,
    pub managed: bool,
    pub head: RepositoryHead,
    pub dirty: bool,
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
    pub prunable: bool,
    #[serde(default)]
    pub active_ai_session_ids: Vec<String>,
    #[serde(default)]
    pub active_app_session_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryWorktreeBlocker {
    MainWorktree,
    ExternalWorktree,
    OutsideWorkspaceRoots,
    Dirty,
    Locked,
    Prunable,
    SessionOccupied,
    PathInaccessible,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryWorktree {
    #[serde(flatten)]
    pub summary: RepositoryWorktreeSummary,
    pub can_create_ai_session: bool,
    pub can_remove: bool,
    #[serde(default)]
    pub create_ai_session_blockers: Vec<RepositoryWorktreeBlocker>,
    #[serde(default)]
    pub remove_blockers: Vec<RepositoryWorktreeBlocker>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryWorktrees {
    pub repository_id: String,
    pub repository_context_id: String,
    pub snapshot_id: String,
    pub items: Vec<RepositoryWorktree>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "mode",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RepositoryCreateWorktreeRequest {
    NewBranch {
        branch_name: String,
        start_ref: String,
        expected_snapshot_id: String,
    },
    ExistingBranch {
        branch_name: String,
        expected_snapshot_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryRemoveWorktreeRequest {
    pub worktree_id: String,
    pub expected_snapshot_id: String,
    pub confirm: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCreateWorktreeResult {
    pub worktree_id: String,
    pub worktrees: RepositoryWorktrees,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRemoveWorktreeResult {
    pub removed_worktree_id: String,
    pub branch_retained: bool,
    pub worktrees: RepositoryWorktrees,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryMoveWorktreeBlocker {
    MainWorktree,
    OutsideWorkspaceRoots,
    PathInaccessible,
    Locked,
    Prunable,
    SessionOccupied,
    MainSessionOccupied,
    DetachedHead,
    UnbornHead,
    MainDirty,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryMoveWorktreePreflightRequest {
    pub worktree_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryMoveWorktreePreflight {
    pub worktree_id: String,
    pub can_move: bool,
    #[serde(default)]
    pub blockers: Vec<RepositoryMoveWorktreeBlocker>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_branch: Option<String>,
    pub target_changes: RepositoryChangeSummary,
    pub main_worktree_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryMoveWorktreeRequest {
    pub worktree_id: String,
    pub expected_snapshot_id: String,
    pub confirm: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryMoveWorktreeResult {
    pub moved_worktree_id: String,
    pub adopted_branch: String,
    pub previous_head: String,
    pub carried_changes: bool,
    pub worktrees: RepositoryWorktrees,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AiSessionWorkspaceSelection {
    Current,
    Worktree {
        repository_context_id: String,
        worktree_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryStartAiSessionRequest {
    pub agent: String,
    pub workspace_selection: AiSessionWorkspaceSelection,
    pub message: String,
    pub client_request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryCreateWorktreeAiSessionRequest {
    pub agent: String,
    pub worktree: RepositoryCreateWorktreeRequest,
    pub message: String,
    pub client_request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryAiSessionLaunchResult {
    pub ai_session_id: String,
    pub provider_session_id: String,
    pub worktree_id: String,
    pub disposition: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryAiSessionWorkspaceBranchKind {
    Branch,
    Head,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryAiSessionWorkspaceCheckout {
    Attached,
    Detached,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryAiSessionCurrentFolderReason {
    Dirty,
    SessionOccupied,
    BranchOccupied,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryAiSessionWorktreeReason {
    CurrentBranch,
    BranchOccupied,
    WorktreeUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryAiSessionWorkspaceBranch {
    pub name: String,
    pub kind: RepositoryAiSessionWorkspaceBranchKind,
    pub current: bool,
    pub current_folder_selectable: bool,
    pub worktree_selectable: bool,
    pub worktree_checkout: RepositoryAiSessionWorkspaceCheckout,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_folder_reason: Option<RepositoryAiSessionCurrentFolderReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_reason: Option<RepositoryAiSessionWorktreeReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryAiSessionWorkspace {
    pub availability: RepositoryAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
    pub dirty: bool,
    #[serde(default)]
    pub branches: Vec<RepositoryAiSessionWorkspaceBranch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_context_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(default)]
    pub worktrees: Vec<RepositoryWorktree>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryRuntimePathInput {
    #[serde(rename = "type")]
    pub runtime_path_type: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryAiSessionWorkspaceInspectRequest {
    pub cwd: RepositoryRuntimePathInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryAiSessionWorkspaceCheckoutRequest {
    pub cwd: RepositoryRuntimePathInput,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryContext {
    pub availability: RepositoryAvailability,
    pub session_kind: RepositorySessionKind,
    pub session_id: String,
    pub observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_context_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd_relative_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<RepositoryHead>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<RepositoryUpstream>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_worktree: Option<RepositoryWorktreeSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<RepositoryChangeSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remotes: Option<Vec<RepositoryRemote>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_action: Option<RepositoryPrimaryAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryChangeEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub scope: RepositoryChangeScope,
    pub status: RepositoryFileStatus,
    pub version: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryChanges {
    pub snapshot_id: String,
    pub summary: RepositoryChangeSummary,
    pub entries: Vec<RepositoryChangeEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryFileKind {
    Directory,
    File,
    Symlink,
    Submodule,
    NestedRepository,
    Special,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryFileMode {
    pub executable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDirectoryEntry {
    pub name: String,
    pub path: String,
    pub kind: RepositoryFileKind,
    pub traversable: bool,
    pub editable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<RepositoryFileMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDirectoryListing {
    pub path: String,
    pub entries: Vec<RepositoryDirectoryEntry>,
    pub snapshot_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryPathKind {
    Directory,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryPathSearchEntry {
    pub name: String,
    pub path: String,
    pub kind: RepositoryPathKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryPathSearchResult {
    pub entries: Vec<RepositoryPathSearchEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryFileContent {
    pub path: String,
    pub content: String,
    pub byte_length: u64,
    pub version: String,
    pub mode: RepositoryFileMode,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryDiffLineKind {
    Metadata,
    Hunk,
    Context,
    Addition,
    Deletion,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDiffLine {
    pub kind: RepositoryDiffLineKind,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_start: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_start: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunk_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDiffContextGap {
    pub gap_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_hunk_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_hunk_id: Option<String>,
    pub lines: Vec<RepositoryDiffLine>,
    pub start_line_count: u64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDiff {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub scope: RepositoryChangeScope,
    pub binary: bool,
    pub complete: bool,
    pub truncated: bool,
    pub byte_limit: u64,
    pub content: String,
    pub lines: Vec<RepositoryDiffLine>,
    pub context_gaps: Vec<RepositoryDiffContextGap>,
    pub version: String,
    pub snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryFileMutationResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<RepositoryFileContent>,
    pub snapshot_id: String,
    pub context: RepositoryContext,
    pub changes: RepositoryChanges,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryMutationResult {
    pub ok: bool,
    pub snapshot_id: String,
    pub context: RepositoryContext,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<RepositoryChanges>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_oid: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryBranchKind {
    Local,
    RemoteTracking,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryBranch {
    pub name: String,
    pub oid: String,
    pub kind: RepositoryBranchKind,
    pub current: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checked_out_worktree_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryBranches {
    pub snapshot_id: String,
    pub branches: Vec<RepositoryBranch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryBranchMutationResult {
    pub snapshot_id: String,
    pub context: RepositoryContext,
    pub branches: RepositoryBranches,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryVersionedPath {
    pub path: String,
    pub expected_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryCreateFileRequest {
    pub path: String,
    pub content: String,
    pub expected_absent: bool,
    pub expected_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryWriteFileRequest {
    pub path: String,
    pub content: String,
    pub expected_version: String,
    pub expected_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryRenameFileRequest {
    pub path: String,
    pub destination: String,
    pub expected_version: String,
    pub expected_destination_absent: bool,
    pub expected_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryDeleteFileRequest {
    pub path: String,
    pub expected_version: String,
    pub expected_snapshot_id: String,
    pub confirm: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryPathMutationRequest {
    pub expected_snapshot_id: String,
    pub paths: Vec<RepositoryVersionedPath>,
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryCommitRequest {
    pub expected_snapshot_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryCreateBranchRequest {
    pub expected_snapshot_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryCheckoutBranchRequest {
    pub expected_snapshot_id: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryCreateTrackingBranchRequest {
    pub expected_snapshot_id: String,
    pub name: String,
    pub remote_tracking_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryDeleteBranchRequest {
    pub expected_snapshot_id: String,
    pub name: String,
    pub confirm: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryFetchRequest {
    pub expected_snapshot_id: String,
    pub remote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryPullRequest {
    pub expected_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryPushRequest {
    pub expected_snapshot_id: String,
    pub remote: String,
    pub source_branch: String,
    pub target_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryPublishRequest {
    pub expected_snapshot_id: String,
    pub remote: String,
    pub source_branch: String,
    pub target_branch: String,
    pub set_upstream: bool,
    #[serde(default)]
    pub confirm_set_upstream: bool,
}
