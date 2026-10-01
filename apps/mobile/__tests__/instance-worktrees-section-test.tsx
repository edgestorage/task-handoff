import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { RepositoryBranches, RepositoryMoveWorktreePreflight, RepositoryWorktrees } from '@task-handoff/protocol/repository';

import { InstanceWorktreesSection } from '../src/instances/InstanceWorktreesSection';
import { createMobileControlPlaneClient } from '../src/control-plane/client';
import { resetWorktreeScopeCache } from '../src/repository/worktree-sync';

jest.mock('../src/control-plane/client', () => ({ createMobileControlPlaneClient: jest.fn() }));
jest.mock('../src/control-plane/runtime', () => ({
  mobileProfileStore: { active: jest.fn().mockResolvedValue({ id: 'profile-1' }) },
  mobileSecureStore: {},
}));

const oid = 'a'.repeat(40);
const folders = [{ id: 'folder-1', name: 'Workspace', path: '/host/workspace' }];
const source = { type: 'local-folder' as const, localFolderId: 'folder-1', path: '/host/workspace' };

function worktrees(items: RepositoryWorktrees['items']): RepositoryWorktrees {
  return { repositoryId: 'repo_1', repositoryContextId: 'repoctx_1', snapshotId: 'snapshot_1', items };
}

const mainWorktree = { id: 'worktree_main', isCurrent: true, isMain: true, managed: false, head: { state: 'branch' as const, branch: 'main', oid }, dirty: false, locked: false, prunable: false, activeAiSessionIds: [], activeAppSessionIds: [], canCreateAiSession: false, canRemove: false, createAiSessionBlockers: ['main-worktree' as const], removeBlockers: ['main-worktree' as const] };
const managedWorktree = { id: 'worktree_demo', isCurrent: false, isMain: false, managed: true, head: { state: 'branch' as const, branch: 'feature/demo', oid }, dirty: true, locked: false, prunable: false, activeAiSessionIds: ['session_one'], activeAppSessionIds: [], canCreateAiSession: true, canRemove: true, createAiSessionBlockers: [], removeBlockers: [] };
const externalWorktree = { id: 'worktree_ext', isCurrent: false, isMain: false, managed: false, head: { state: 'branch' as const, branch: 'legacy', oid }, dirty: false, locked: true, prunable: false, activeAiSessionIds: [], activeAppSessionIds: [], canCreateAiSession: false, canRemove: false, createAiSessionBlockers: ['external-worktree' as const, 'locked' as const], removeBlockers: ['locked' as const] };

const branches: RepositoryBranches = {
  snapshotId: 'snapshot_1',
  branches: [
    { name: 'main', oid, kind: 'local', current: true, checkedOutWorktreeIds: ['worktree_main'] },
    { name: 'feature/demo', oid, kind: 'local', current: false, checkedOutWorktreeIds: ['worktree_demo'] },
  ],
};

function createApi(overrides: {
  worktrees?: RepositoryWorktrees;
  worktreeList?: jest.Mock;
  removeWorktree?: jest.Mock;
  moveWorktreeToMain?: jest.Mock;
  moveWorktreeToMainPreflight?: jest.Mock;
  createWorktree?: jest.Mock;
} = {}) {
  const api = {
    resources: {
      nodeLocalFolders: jest.fn().mockResolvedValue(folders),
      instanceWorkspaceSource: jest.fn().mockResolvedValue(source),
    },
    repository: {
      worktrees: overrides.worktreeList ?? jest.fn().mockResolvedValue(overrides.worktrees ?? worktrees([mainWorktree, managedWorktree, externalWorktree])),
      branches: jest.fn().mockResolvedValue(branches),
      createWorktree: overrides.createWorktree ?? jest.fn(),
      removeWorktree: overrides.removeWorktree ?? jest.fn().mockResolvedValue({ removedWorktreeId: 'worktree_demo', branchRetained: true, worktrees: worktrees([mainWorktree]) }),
      moveWorktreeToMainPreflight: overrides.moveWorktreeToMainPreflight ?? jest.fn(),
      moveWorktreeToMain: overrides.moveWorktreeToMain ?? jest.fn(),
    },
  };
  jest.mocked(createMobileControlPlaneClient).mockReturnValue({ api } as unknown as ReturnType<typeof createMobileControlPlaneClient>);
  return api;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetWorktreeScopeCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('renders worktree state, blockers, and disables unsafe actions', async () => {
  createApi();
  const screen = await render(<InstanceWorktreesSection instanceId="instance-1" nodeId="node-1" workspacePath="/host/workspace" />);

  await waitFor(() => expect(screen.getByText('feature/demo')).toBeTruthy());
  expect(screen.getByText('Current · Main')).toBeTruthy();
  expect(screen.getByText('Managed · 1 in use · Dirty')).toBeTruthy();
  expect(screen.getByText('External · Locked')).toBeTruthy();
  expect(screen.getByText('External worktree · Locked worktree')).toBeTruthy();

  const removeButtons = screen.getAllByLabelText('Remove');
  expect(removeButtons.map((button) => button.props.accessibilityState.disabled)).toEqual([true, false, true]);
  expect(screen.getAllByLabelText('Move to main').map((button) => button.props.accessibilityState.disabled)).toEqual([true, false, false]);
});

test('removes a managed worktree after confirmation and reports retained branch', async () => {
  const removeWorktree = jest.fn().mockResolvedValue({ removedWorktreeId: 'worktree_demo', branchRetained: true, worktrees: worktrees([mainWorktree]) });
  const api = createApi({ removeWorktree });
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const screen = await render(<InstanceWorktreesSection instanceId="instance-1" nodeId="node-1" workspacePath="/host/workspace" />);
  await waitFor(() => expect(screen.getByText('feature/demo')).toBeTruthy());

  const removeButtons = screen.getAllByLabelText('Remove');
  expect(removeButtons[1]!.props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(removeButtons[1]!);

  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)![2]!;
  await buttons.at(-1)!.onPress!();
  await waitFor(() => expect(removeWorktree).toHaveBeenCalledWith({ instanceId: 'instance-1', cwdFolderId: 'folder-1' }, { worktreeId: 'worktree_demo', expectedSnapshotId: 'snapshot_1', confirm: true }));
  await waitFor(() => expect(api.repository.worktrees).toHaveBeenCalledTimes(2));
});

test('surfaces move-to-main blockers from preflight without mutating', async () => {
  const preflight: RepositoryMoveWorktreePreflight = { worktreeId: 'worktree_demo', canMove: false, blockers: ['main-session-occupied'], targetChanges: { conflicts: 0, staged: 0, unstaged: 0, untracked: 0 }, mainWorktreeId: 'worktree_main', mainBranch: 'main' };
  const moveWorktreeToMain = jest.fn();
  createApi({ moveWorktreeToMainPreflight: jest.fn().mockResolvedValue(preflight), moveWorktreeToMain });
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const screen = await render(<InstanceWorktreesSection instanceId="instance-1" nodeId="node-1" workspacePath="/host/workspace" />);
  await waitFor(() => expect(screen.getByText('feature/demo')).toBeTruthy());

  await fireEvent.press(screen.getAllByLabelText('Move to main')[1]!);
  await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
  expect(jest.mocked(Alert.alert).mock.calls.at(-1)![1]).toContain('Main worktree has a running session');
  expect(moveWorktreeToMain).not.toHaveBeenCalled();
});

test('moves a worktree into the main worktree after confirmation', async () => {
  const preflight: RepositoryMoveWorktreePreflight = { worktreeId: 'worktree_demo', canMove: true, blockers: [], targetChanges: { conflicts: 0, staged: 1, unstaged: 1, untracked: 0 }, mainWorktreeId: 'worktree_main', mainBranch: 'main' };
  const moveWorktreeToMain = jest.fn().mockResolvedValue({ movedWorktreeId: 'worktree_demo', adoptedBranch: 'feature/demo', previousHead: oid, carriedChanges: true, worktrees: worktrees([mainWorktree]) });
  createApi({ moveWorktreeToMainPreflight: jest.fn().mockResolvedValue(preflight), moveWorktreeToMain });
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const screen = await render(<InstanceWorktreesSection instanceId="instance-1" nodeId="node-1" workspacePath="/host/workspace" />);
  await waitFor(() => expect(screen.getByText('feature/demo')).toBeTruthy());

  await fireEvent.press(screen.getAllByLabelText('Move to main')[1]!);
  await waitFor(() => expect(jest.mocked(Alert.alert).mock.calls.at(-1)![1]).toContain('Carries 2 uncommitted changes'));
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)![2]!;
  await buttons.at(-1)!.onPress!();
  await waitFor(() => expect(moveWorktreeToMain).toHaveBeenCalledWith({ instanceId: 'instance-1', cwdFolderId: 'folder-1' }, { worktreeId: 'worktree_demo', expectedSnapshotId: 'snapshot_1', confirm: true }));
});

test('reports unsupported instead of an empty list on older instances', async () => {
  const notFound = Object.assign(new Error('not found'), { status: 404 });
  createApi({ worktreeList: jest.fn().mockRejectedValue(notFound) });
  const screen = await render(<InstanceWorktreesSection instanceId="instance-1" nodeId="node-1" workspacePath="/host/workspace" />);
  await waitFor(() => expect(screen.getByText('This instance version does not support worktree management.')).toBeTruthy());
});
