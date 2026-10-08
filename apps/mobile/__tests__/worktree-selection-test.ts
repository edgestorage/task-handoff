import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { RepositoryAiSessionWorkspace } from '@task-handoff/protocol/repository';

import {
  aiSessionGitSelection,
  aiSessionWorkspaceDialogInitialSelection,
  aiSessionWorkspaceSelection,
  aiSessionWorkspaceSelectionLabel,
  aiSessionWorkspaceSelectionValue,
  applyWorktreeCreationOutcome,
  createWorkspaceWorktreeForSession,
  initialAiSessionWorkspaceState,
  MOBILE_MANAGED_WORKTREE_OPTION,
  MOBILE_NEW_WORKTREE_OPTION,
  selectAiSessionWorktree,
  switchAiSessionWorkspaceMode,
} from '../src/repository/worktree-selection';
import { repositoryWorktreeCreateBlockers, repositoryWorktreeMeta } from '../src/repository/worktree-presentation';
import { translate } from '../src/i18n';

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en-US', key, params);

const oid = 'a'.repeat(40);

function workspace(overrides: Partial<RepositoryAiSessionWorkspace> = {}): RepositoryAiSessionWorkspace {
  return {
    availability: 'available',
    currentBranch: 'main',
    dirty: false,
    branches: [
      { name: 'main', kind: 'branch', current: true, currentFolderSelectable: true, worktreeSelectable: false, worktreeCheckout: 'attached', worktreeReason: 'current-branch' },
      { name: 'feature/demo', kind: 'branch', current: false, currentFolderSelectable: true, worktreeSelectable: true, worktreeCheckout: 'attached' },
    ],
    repositoryContextId: 'context_one',
    snapshotId: 'snapshot_one',
    worktrees: [
      { id: 'worktree_main', isCurrent: true, isMain: true, managed: false, head: { state: 'branch', branch: 'main', oid }, dirty: false, locked: false, prunable: false, activeAiSessionIds: [], activeAppSessionIds: [], canCreateAiSession: false, canRemove: false, createAiSessionBlockers: ['main-worktree'], removeBlockers: ['main-worktree'] },
      { id: 'worktree_demo', isCurrent: false, isMain: false, managed: true, head: { state: 'branch', branch: 'feature/demo', oid }, dirty: true, locked: false, prunable: false, activeAiSessionIds: ['session_one'], activeAppSessionIds: [], canCreateAiSession: true, canRemove: true, createAiSessionBlockers: [], removeBlockers: [] },
    ],
    ...overrides,
  };
}

function client(options: { createWorktree?: jest.Mock; workspace?: jest.Mock } = {}) {
  return {
    repository: { createWorktree: options.createWorktree ?? jest.fn() },
    aiSessions: { workspace: options.workspace ?? jest.fn(async () => workspace()) },
  } as unknown as ControlPlaneClient;
}

describe('mobile worktree session selection', () => {
  test('derives the initial selection from the authoritative workspace', () => {
    const state = initialAiSessionWorkspaceState('instance-1', 'folder-1', workspace());
    expect(state.mode).toBe('current-folder');
    expect(state.branch).toBe('main');
    expect(state.worktreeId).toBe('worktree_demo');
  });

  test('inherits the Story session worktree when the folder workspace proves it is selectable', () => {
    const state = initialAiSessionWorkspaceState('instance-1', 'folder-1', workspace(), 'worktree_demo');
    expect(state.mode).toBe('worktree');
    expect(state.worktreeId).toBe('worktree_demo');
    expect(aiSessionWorkspaceSelection(state, true)).toEqual({
      type: 'existing-worktree',
      repositoryContextId: 'context_one',
      worktreeId: 'worktree_demo',
    });
  });

  test('keeps the folder default unless the inherited worktree is really usable here', () => {
    const locked = workspace({
      worktrees: [
        workspace().worktrees[0],
        workspace().worktrees[1],
        { ...workspace().worktrees[1], id: 'worktree_locked', canCreateAiSession: false, createAiSessionBlockers: ['locked'] },
      ],
    });
    for (const [snapshot, id] of [[workspace(), 'worktree_missing'], [workspace(), 'worktree_main'], [locked, 'worktree_locked']] as const) {
      const state = initialAiSessionWorkspaceState('instance-1', 'folder-1', snapshot, id);
      expect(state.mode).toBe('current-folder');
      expect(state.worktreeId).toBe('worktree_demo');
    }
  });

  test('switches to worktree mode and derives existing-worktree selections instead of a branch', () => {
    const state = switchAiSessionWorkspaceMode(initialAiSessionWorkspaceState('instance-1', 'folder-1', workspace()), 'worktree');
    expect(aiSessionGitSelection(state, true)).toBeUndefined();
    expect(aiSessionWorkspaceSelection(state, true)).toEqual({
      type: 'existing-worktree',
      repositoryContextId: 'context_one',
      worktreeId: 'worktree_demo',
    });
    expect(aiSessionWorkspaceSelectionValue(state)).toBe('worktree_demo');
  });

  test('ignores selections that do not match the resolved instance and folder', () => {
    const state = switchAiSessionWorkspaceMode(initialAiSessionWorkspaceState('instance-1', 'folder-1', workspace()), 'worktree');
    expect(aiSessionWorkspaceSelection(state, false)).toBeUndefined();
    expect(aiSessionGitSelection(state, false)).toBeUndefined();
  });

  test('keeps deferred worktree selections for v0.0.21 instances', () => {
    const state = applyWorktreeCreationOutcome(
      switchAiSessionWorkspaceMode(initialAiSessionWorkspaceState('instance-1', 'folder-1', workspace()), 'worktree'),
      { type: 'deferred', newWorktree: { branchName: 'session/demo', startRef: 'main' } },
    );
    expect(aiSessionWorkspaceSelectionValue(state)).toBe(MOBILE_NEW_WORKTREE_OPTION);
    expect(aiSessionWorkspaceSelectionLabel(state)).toBe('session/demo');
    expect(aiSessionWorkspaceSelection(state, true)).toEqual({
      type: 'new-worktree',
      branchName: 'session/demo',
      startRef: 'main',
      expectedSnapshotId: 'snapshot_one',
    });
    expect(aiSessionWorkspaceDialogInitialSelection(state)).toEqual({ mode: 'new-branch', branchName: 'session/demo', startRef: 'main' });

    const branchDeferred = applyWorktreeCreationOutcome(
      switchAiSessionWorkspaceMode(initialAiSessionWorkspaceState('instance-1', 'folder-1', workspace()), 'worktree'),
      { type: 'deferred', managedWorktreeBranch: 'feature/demo' },
    );
    expect(aiSessionWorkspaceSelectionValue(branchDeferred)).toBe(MOBILE_MANAGED_WORKTREE_OPTION);
    expect(aiSessionWorkspaceSelection(branchDeferred, true)).toBeUndefined();
    expect(aiSessionGitSelection(branchDeferred, true)).toEqual({ mode: 'worktree', branch: 'feature/demo' });
  });

  test('creates the worktree up front and selects the returned identity', async () => {
    const createWorktree = jest.fn(async () => ({ worktreeId: 'worktree_new', worktrees: { repositoryId: 'repo', repositoryContextId: 'context_one', snapshotId: 'snapshot_two', items: [] } }));
    const refreshed = workspace({ snapshotId: 'snapshot_two' });
    const outcome = await createWorkspaceWorktreeForSession({
      client: client({ createWorktree, workspace: jest.fn(async () => refreshed) }),
      instanceId: 'instance-1',
      cwdFolderId: 'folder-1',
      workspace: workspace(),
      selection: { mode: 'existing-branch', branchName: 'feature/demo' },
    });
    expect(createWorktree).toHaveBeenCalledWith(
      { instanceId: 'instance-1', cwdFolderId: 'folder-1' },
      { mode: 'existing-branch', branchName: 'feature/demo', expectedSnapshotId: 'snapshot_one' },
    );
    expect(outcome).toEqual({ type: 'created', worktreeId: 'worktree_new', workspace: refreshed });
    const state = applyWorktreeCreationOutcome(initialAiSessionWorkspaceState('instance-1', 'folder-1', workspace()), outcome);
    expect(aiSessionWorkspaceSelectionValue(state)).toBe('worktree_new');
  });

  test('defers to session-time creation on 404 and surfaces other failures', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    const deferred = await createWorkspaceWorktreeForSession({
      client: client({ createWorktree: jest.fn(async () => { throw notFound; }) }),
      instanceId: 'instance-1',
      workspace: workspace(),
      selection: { mode: 'new-branch', branchName: 'session/demo', startRef: 'main' },
    });
    expect(deferred).toEqual({ type: 'deferred', newWorktree: { branchName: 'session/demo', startRef: 'main' } });

    const conflict = Object.assign(new Error('Conflict'), { status: 409 });
    await expect(createWorkspaceWorktreeForSession({
      client: client({ createWorktree: jest.fn(async () => { throw conflict; }) }),
      instanceId: 'instance-1',
      workspace: workspace(),
      selection: { mode: 'existing-branch', branchName: 'feature/demo' },
    })).rejects.toBe(conflict);
  });

  test('selects an existing worktree without keeping a deferred branch', () => {
    const state = applyWorktreeCreationOutcome(
      initialAiSessionWorkspaceState('instance-1', 'folder-1', workspace()),
      { type: 'deferred', managedWorktreeBranch: 'feature/demo' },
    );
    expect(aiSessionWorkspaceSelectionValue(selectAiSessionWorktree(state, 'worktree_demo'))).toBe('worktree_demo');
  });

  test('presents worktree state and blockers for the picker and management surface', () => {
    const [main, demo] = workspace().worktrees;
    expect(repositoryWorktreeMeta(demo, t)).toBe('Managed · 1 in use · Dirty');
    expect(repositoryWorktreeCreateBlockers(main, t)).toEqual(['Main worktree']);
    expect(repositoryWorktreeCreateBlockers(demo, t)).toEqual([]);
  });
});
