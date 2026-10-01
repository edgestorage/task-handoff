import { subscribeToAppLifecycle } from '../src/platform/lifecycle';
import { invalidateWorktreeInstance, invalidateWorktreeScope, isWorktreeScopeStale, loadWorktreeScope, readWorktreeScope, resetWorktreeScopeCache, subscribeToWorktreeForeground, worktreeScopeKey, writeWorktreeScope, WORKTREE_CACHE_TTL_MS } from '../src/repository/worktree-sync';

jest.mock('../src/platform/lifecycle', () => ({ subscribeToAppLifecycle: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  resetWorktreeScopeCache();
});

afterEach(() => {
  jest.useRealTimers();
});

test('coalesces concurrent loads for the same instance and folder', async () => {
  const loader = jest.fn().mockResolvedValue({ items: [] });
  const scope = { kind: 'management' as const, instanceId: 'instance-1', cwdFolderId: 'folder-1' };

  const [first, second] = await Promise.all([
    loadWorktreeScope(scope, loader),
    loadWorktreeScope(scope, loader),
  ]);

  expect(loader).toHaveBeenCalledTimes(1);
  expect(first).toBe(second);
  expect(readWorktreeScope(scope)).toBe(first);
});

test('does not share projections across folders or instances', async () => {
  const loader = jest.fn().mockResolvedValue({ items: [] });
  await loadWorktreeScope({ kind: 'management', instanceId: 'instance-1', cwdFolderId: 'folder-1' }, loader);
  await loadWorktreeScope({ kind: 'management', instanceId: 'instance-1', cwdFolderId: 'folder-2' }, loader);
  await loadWorktreeScope({ kind: 'session-workspace', instanceId: 'instance-1', cwdFolderId: 'folder-1' }, loader);
  expect(loader).toHaveBeenCalledTimes(3);
  expect(worktreeScopeKey({ kind: 'management', instanceId: 'instance-1', cwdFolderId: 'folder-1' }))
    .not.toBe(worktreeScopeKey({ kind: 'session-workspace', instanceId: 'instance-1', cwdFolderId: 'folder-1' }));
});

test('reuses fresh entries and reloads stale ones', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  const loader = jest.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
  const scope = { kind: 'management' as const, instanceId: 'instance-1', cwdFolderId: 'folder-1' };

  expect(await loadWorktreeScope(scope, loader)).toBe('first');
  expect(isWorktreeScopeStale(scope)).toBe(false);
  expect(await loadWorktreeScope(scope, loader)).toBe('first');
  expect(loader).toHaveBeenCalledTimes(1);

  jest.setSystemTime(new Date(Date.now() + WORKTREE_CACHE_TTL_MS + 1));
  expect(isWorktreeScopeStale(scope)).toBe(true);
  expect(await loadWorktreeScope(scope, loader)).toBe('second');
  expect(loader).toHaveBeenCalledTimes(2);
});

test('keeps a cached projection that resolves to an empty value', async () => {
  const loader = jest.fn().mockResolvedValue(undefined);
  const scope = { kind: 'management-scope' as const, instanceId: 'instance-1', variant: 'node-1' };
  expect(await loadWorktreeScope(scope, loader)).toBeUndefined();
  expect(await loadWorktreeScope(scope, loader)).toBeUndefined();
  expect(loader).toHaveBeenCalledTimes(1);
  expect(isWorktreeScopeStale(scope)).toBe(false);
});

test('invalidates one scope or every projection of an instance', async () => {
  writeWorktreeScope({ kind: 'management', instanceId: 'instance-1', cwdFolderId: 'folder-1' }, 'a');
  writeWorktreeScope({ kind: 'session-workspace', instanceId: 'instance-1', cwdFolderId: 'folder-1' }, 'b');
  writeWorktreeScope({ kind: 'management', instanceId: 'instance-2', cwdFolderId: 'folder-1' }, 'c');

  invalidateWorktreeScope({ kind: 'management', instanceId: 'instance-1', cwdFolderId: 'folder-1' });
  expect(readWorktreeScope({ kind: 'management', instanceId: 'instance-1', cwdFolderId: 'folder-1' })).toBeUndefined();
  expect(readWorktreeScope({ kind: 'session-workspace', instanceId: 'instance-1', cwdFolderId: 'folder-1' })).toBe('b');

  invalidateWorktreeInstance('instance-1');
  expect(readWorktreeScope({ kind: 'session-workspace', instanceId: 'instance-1', cwdFolderId: 'folder-1' })).toBeUndefined();
  expect(readWorktreeScope({ kind: 'management', instanceId: 'instance-2', cwdFolderId: 'folder-1' })).toBe('c');
});

test('notifies foreground listeners only when returning from the background', () => {
  const listener = jest.fn();
  let phase: ((value: 'active' | 'background') => void) | undefined;
  jest.mocked(subscribeToAppLifecycle).mockImplementation((next) => {
    phase = next as (value: 'active' | 'background') => void;
    next('active');
    return () => undefined;
  });

  const unsubscribe = subscribeToWorktreeForeground(listener);
  expect(listener).not.toHaveBeenCalled();
  phase!('background');
  expect(listener).not.toHaveBeenCalled();
  phase!('active');
  expect(listener).toHaveBeenCalledTimes(1);
  phase!('active');
  expect(listener).toHaveBeenCalledTimes(1);
  expect(typeof unsubscribe).toBe('function');
});
