export const REMOTE_DESKTOP_SIGNAL_RESUME_WINDOW_MS = 30_000;
export const REMOTE_DESKTOP_SIGNAL_RESUME_RETRY_BASE_MS = 300;
export const REMOTE_DESKTOP_SIGNAL_RESUME_RETRY_MAX_MS = 4_000;

const LOST_SESSION_ERROR_CODES = new Set([
  "REMOTE_DESKTOP_NOT_FOUND",
  "REMOTE_DESKTOP_STALE_BOOT",
  "REMOTE_DESKTOP_DEADLINE_EXCEEDED",
  "REMOTE_DESKTOP_SESSION_CLOSED",
]);

type RecoveryError = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  retryable?: unknown;
};

function recoveryError(cause: unknown): RecoveryError | undefined {
  return cause && typeof cause === "object" ? cause as RecoveryError : undefined;
}

export function remoteDesktopSignalResumeRetryDelayMs(attempt: number) {
  const exponent = Math.max(0, Math.floor(Number.isFinite(attempt) ? attempt : 0));
  return Math.min(
    REMOTE_DESKTOP_SIGNAL_RESUME_RETRY_BASE_MS * 2 ** exponent,
    REMOTE_DESKTOP_SIGNAL_RESUME_RETRY_MAX_MS,
  );
}

export function isRetryableRemoteDesktopSignalResumeError(cause: unknown) {
  const error = recoveryError(cause);
  if (error?.retryable === true) return true;
  const status = Number(error?.status);
  if (Number.isFinite(status) && status > 0) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  // ky/fetch network failures surface as TypeError without an HTTP status.
  return cause instanceof TypeError || error?.name === "FetchError";
}

export function isLostRemoteDesktopSessionError(cause: unknown) {
  const error = recoveryError(cause);
  if (Number(error?.status) === 404) return true;
  return typeof error?.code === "string" && LOST_SESSION_ERROR_CODES.has(error.code);
}
