import { ApiError } from "../../../api/client";
import { translateApiError } from "../../../i18n/apiError";
import type { Translate } from "../../../i18n/status";

export type RepositoryErrorPresentation = {
  code?: string;
  message: string;
  recovery?: string;
  retryable?: boolean;
};

const recoveryCodes = new Set([
  "REPOSITORY_SESSION_NOT_FOUND", "REPOSITORY_SESSION_INACTIVE", "REPOSITORY_CWD_MISSING", "REPOSITORY_CWD_INACCESSIBLE",
  "REPOSITORY_GIT_UNAVAILABLE", "REPOSITORY_NOT_WORKTREE", "REPOSITORY_FILE_BINARY", "REPOSITORY_FILE_TOO_LARGE",
  "REPOSITORY_FILE_STALE", "REPOSITORY_STATE_STALE", "REPOSITORY_WORKTREE_NOT_FOUND", "REPOSITORY_WORKTREE_OCCUPIED",
  "REPOSITORY_WORKTREE_UNSAFE", "REPOSITORY_BRANCH_OCCUPIED", "REPOSITORY_BRANCH_UNMERGED", "REPOSITORY_CONFLICT",
  "REPOSITORY_DIRTY", "REPOSITORY_IDENTITY_MISSING", "REPOSITORY_HOOK_FAILED", "REPOSITORY_SIGNING_FAILED",
  "REPOSITORY_AUTHENTICATION_FAILED", "REPOSITORY_NON_FAST_FORWARD", "REPOSITORY_UPSTREAM_MISSING", "REPOSITORY_COMMAND_TIMEOUT",
  "REPOSITORY_OUTPUT_LIMIT", "REPOSITORY_OPERATION_ABORTED",
]);

export function repositoryErrorPresentation(error: unknown, fallback: string, t: Translate): RepositoryErrorPresentation {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: translateApiError(error, t, fallback),
      recovery: recoveryCodes.has(error.code) ? t(`repository.errorNotice.recovery.${error.code}`) : undefined,
      retryable: error.retryable,
    };
  }
  return {
    message: translateApiError(error, t, fallback),
  };
}
