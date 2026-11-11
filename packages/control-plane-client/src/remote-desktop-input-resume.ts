export const REMOTE_DESKTOP_INPUT_RESUME_ACK_TIMEOUT_MS = 2_500;
export const REMOTE_DESKTOP_INPUT_RESUME_RETRY_BASE_MS = 250;
export const REMOTE_DESKTOP_INPUT_RESUME_RETRY_MAX_MS = 2_000;

const RECOVERABLE_INPUT_RESUME_ERRORS = new Set([
  'REMOTE_DESKTOP_GEOMETRY_CHANGED',
  'REMOTE_DESKTOP_INVALID_STATE',
  'REMOTE_DESKTOP_STALE_EPOCH',
]);

/** A rejected resume can be retried against the latest authoritative session
 * revision. This is not a capability or a protocol limit; it only classifies
 * transient input-binding races shared by browser and mobile viewers. */
export function isRecoverableRemoteDesktopInputResumeError(code: unknown) {
  return typeof code === 'string' && RECOVERABLE_INPUT_RESUME_ERRORS.has(code);
}

export function remoteDesktopInputResumeRetryDelayMs(attempt: number) {
  const exponent = Math.max(0, Math.floor(Number.isFinite(attempt) ? attempt : 0));
  return Math.min(REMOTE_DESKTOP_INPUT_RESUME_RETRY_BASE_MS * 2 ** exponent, REMOTE_DESKTOP_INPUT_RESUME_RETRY_MAX_MS);
}
