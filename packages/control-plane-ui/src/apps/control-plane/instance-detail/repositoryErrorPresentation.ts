import { ApiError } from "../../../api/client";

export type RepositoryErrorPresentation = {
  code?: string;
  message: string;
  recovery?: string;
  retryable?: boolean;
};

const recoveryByCode: Record<string, string> = {
  REPOSITORY_SESSION_NOT_FOUND: "The session was deleted. Close this view and return to the current session list.",
  REPOSITORY_SESSION_INACTIVE: "The session is no longer active. Reopen Environment from an active session.",
  REPOSITORY_CWD_MISSING: "This session has no authoritative working directory to inspect.",
  REPOSITORY_CWD_INACCESSIBLE: "Restore access to the session working directory in the controlled instance, then refresh.",
  REPOSITORY_GIT_UNAVAILABLE: "Install Git in the controlled instance. The control plane will not run Git against a local substitute path.",
  REPOSITORY_NOT_WORKTREE: "Use the session terminal to initialize or enter a Git worktree, then refresh Environment.",
  REPOSITORY_FILE_BINARY: "Binary content is not loaded into the editor. Use an appropriate tool in the session environment.",
  REPOSITORY_FILE_TOO_LARGE: "Open the file with a tool in the session environment; the browser editor size limit was not bypassed.",
  REPOSITORY_FILE_STALE: "The server version changed. Review the latest content before explicitly retrying your draft.",
  REPOSITORY_STATE_STALE: "Repository state changed after this view loaded. The latest server snapshot has been requested; review it before retrying.",
  REPOSITORY_WORKTREE_NOT_FOUND: "The worktree disappeared or moved. Refresh the worktree list before choosing another one.",
  REPOSITORY_WORKTREE_OCCUPIED: "An active AI or app session is using this worktree. Stop or move that work in its own session before retrying.",
  REPOSITORY_WORKTREE_UNSAFE: "The worktree is dirty, locked, external, prunable, or otherwise unsafe for this operation. Review its blockers; force is unavailable.",
  REPOSITORY_BRANCH_OCCUPIED: "The branch is checked out in another worktree. Use that worktree or choose a different branch.",
  REPOSITORY_BRANCH_UNMERGED: "The branch contains unmerged commits. Merge it safely before deletion; force deletion is unavailable.",
  REPOSITORY_CONFLICT: "Resolve every conflict in Files / Changes or the session terminal, then refresh repository state.",
  REPOSITORY_DIRTY: "Review or commit the current changes first. The system will not stash or overwrite them automatically.",
  REPOSITORY_IDENTITY_MISSING: "Configure Git user.name and user.email in the controlled instance before committing.",
  REPOSITORY_HOOK_FAILED: "Inspect the failing Git hook in the session terminal. The commit was not reported as successful.",
  REPOSITORY_SIGNING_FAILED: "Repair commit signing in the controlled instance or use its terminal to inspect the signing configuration.",
  REPOSITORY_AUTHENTICATION_FAILED: "Verify the controlled instance's existing Git or SSH credentials in the session terminal. Credentials are never entered in this UI.",
  REPOSITORY_NON_FAST_FORWARD: "Fetch and reconcile the branch in the session terminal. The system will not retry with force.",
  REPOSITORY_UPSTREAM_MISSING: "Publish the branch with an explicit remote and target before using upstream delivery actions.",
  REPOSITORY_COMMAND_TIMEOUT: "The Git command was stopped at its time limit. Check the remote or repository in the session terminal before retrying.",
  REPOSITORY_OUTPUT_LIMIT: "The command exceeded its output budget. Inspect the complete result in the session terminal.",
  REPOSITORY_OPERATION_ABORTED: "Repository state was preserved. Refresh the authoritative snapshot before retrying.",
};

export function repositoryErrorPresentation(error: unknown, fallback: string): RepositoryErrorPresentation {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message || fallback,
      recovery: recoveryByCode[error.code],
      retryable: error.retryable,
    };
  }
  return {
    message: error instanceof Error && error.message ? error.message : fallback,
  };
}
