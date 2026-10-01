import { subscribeToAppLifecycle } from '../platform/lifecycle';

/**
 * Mobile worktree projections are keyed by `(instanceId, cwdFolderId)` so the new-session
 * composer and the instance worktree section share one in-flight request and one freshness
 * window. No polling or extra protocol events are introduced: entries are invalidated by the
 * mutation that changed them and re-read when the screen regains focus or the app foregrounds.
 */
export type WorktreeScopeKind = 'management-scope' | 'management' | 'session-workspace';

export type WorktreeScope = {
  kind: WorktreeScopeKind;
  instanceId?: string;
  cwdFolderId?: string;
  /** Extra discriminator for projections that are not keyed by a folder (e.g. folder resolution). */
  variant?: string;
};

export const WORKTREE_CACHE_TTL_MS = 30_000;

const SEPARATOR = '\u0000';
const entries = new Map<string, { fetchedAt: number; value: unknown }>();
const pending = new Map<string, Promise<unknown>>();

export function worktreeScopeKey(scope: WorktreeScope) {
  return [scope.kind, scope.instanceId ?? '', scope.cwdFolderId ?? '', scope.variant ?? ''].join(SEPARATOR);
}

export function readWorktreeScope<T>(scope: WorktreeScope, maxAgeMs = WORKTREE_CACHE_TTL_MS): T | undefined {
  const entry = entries.get(worktreeScopeKey(scope));
  if (!entry || Date.now() - entry.fetchedAt > maxAgeMs) return undefined;
  return entry.value as T;
}

function hasFreshWorktreeScope(scope: WorktreeScope, maxAgeMs: number): boolean {
  const entry = entries.get(worktreeScopeKey(scope));
  return Boolean(entry) && Date.now() - entry!.fetchedAt <= maxAgeMs;
}

export function isWorktreeScopeStale(scope: WorktreeScope, maxAgeMs = WORKTREE_CACHE_TTL_MS): boolean {
  return !hasFreshWorktreeScope(scope, maxAgeMs);
}

export function writeWorktreeScope<T>(scope: WorktreeScope, value: T): T {
  entries.set(worktreeScopeKey(scope), { fetchedAt: Date.now(), value });
  return value;
}

/**
 * Returns the cached projection while it is fresh, otherwise loads it once. Concurrent callers
 * with the same key share the same promise, so focus + mount + foreground cannot fan out into
 * duplicate requests for the same `(instanceId, cwdFolderId)`.
 */
export function loadWorktreeScope<T>(scope: WorktreeScope, loader: () => Promise<T>, maxAgeMs = WORKTREE_CACHE_TTL_MS): Promise<T> {
  const key = worktreeScopeKey(scope);
  if (hasFreshWorktreeScope(scope, maxAgeMs)) return Promise.resolve(entries.get(key)!.value as T);
  const inflight = pending.get(key);
  if (inflight) return inflight as Promise<T>;
  const request = loader()
    .then((value) => writeWorktreeScope(scope, value))
    .finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}

export function invalidateWorktreeScope(scope: WorktreeScope) {
  const key = worktreeScopeKey(scope);
  entries.delete(key);
  pending.delete(key);
}

/** Drops every cached projection for an instance after a worktree mutation. */
export function invalidateWorktreeInstance(instanceId: string) {
  for (const key of [...entries.keys()]) if (key.split(SEPARATOR)[1] === instanceId) entries.delete(key);
  for (const key of [...pending.keys()]) if (key.split(SEPARATOR)[1] === instanceId) pending.delete(key);
}

export function resetWorktreeScopeCache() {
  entries.clear();
  pending.clear();
}

/** Invokes the listener when the app returns to the foreground, not on the initial subscription. */
export function subscribeToWorktreeForeground(listener: () => void) {
  let active: boolean | undefined;
  return subscribeToAppLifecycle((phase) => {
    const next = phase === 'active';
    const wasActive = active ?? true;
    active = next;
    if (next && !wasActive) listener();
  });
}
