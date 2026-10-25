export type ConnectionSyncPhase = 'loading' | 'stale' | 'error';

/**
 * A recoverable failure before the first authoritative snapshot must not look
 * like a terminal load error. The connection coordinator is already backing
 * off and retrying; keep the initial loading state until that attempt settles.
 */
export function connectionSyncPhase(hasSnapshot: boolean, error?: unknown): ConnectionSyncPhase {
  if (hasSnapshot) return 'stale';
  if (error === undefined || error === null) return 'loading';
  return typeof error === 'object' && (error as { retryable?: unknown }).retryable === true
    ? 'loading'
    : 'error';
}
