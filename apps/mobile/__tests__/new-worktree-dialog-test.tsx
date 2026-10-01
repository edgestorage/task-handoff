import { fireEvent, render } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import type { RepositoryAiSessionWorkspaceBranch, RepositoryWorktree } from '@task-handoff/protocol/repository';

import { NewSessionWorktreePicker } from '../src/ai-sessions/NewSessionWorktreePicker';
import { NewWorktreeDialog } from '../src/ai-sessions/NewWorktreeDialog';

const oid = 'a'.repeat(40);
const branches: RepositoryAiSessionWorkspaceBranch[] = [
  { name: 'main', kind: 'branch', current: true, currentFolderSelectable: true, worktreeSelectable: false, worktreeCheckout: 'attached', worktreeReason: 'current-branch' },
  { name: 'feature/demo', kind: 'branch', current: false, currentFolderSelectable: true, worktreeSelectable: true, worktreeCheckout: 'attached' },
];
const worktrees: RepositoryWorktree[] = [
  { id: 'worktree_main', isCurrent: true, isMain: true, managed: false, head: { state: 'branch', branch: 'main', oid }, dirty: false, locked: false, prunable: false, activeAiSessionIds: [], activeAppSessionIds: [], canCreateAiSession: false, canRemove: false, createAiSessionBlockers: ['main-worktree'], removeBlockers: ['main-worktree'] },
  { id: 'worktree_demo', isCurrent: false, isMain: false, managed: true, head: { state: 'branch', branch: 'feature/demo', oid }, dirty: false, locked: false, prunable: false, activeAiSessionIds: ['session_one'], activeAppSessionIds: [], canCreateAiSession: true, canRemove: true, createAiSessionBlockers: [], removeBlockers: [] },
];

describe('<NewWorktreeDialog />', () => {
  test('confirms an existing branch selection', async () => {
    const onConfirm = jest.fn();
    const screen = await render(<NewWorktreeDialog
      branches={branches}
      confirmLabel="Create worktree"
      description="Create an isolated worktree."
      initialSelection={{ mode: 'existing-branch', branchName: 'feature/demo' }}
      onCancel={jest.fn()}
      onConfirm={onConfirm}
      title="New worktree"
      visible
    />);

    const confirm = screen.getByRole('button', { name: 'Create worktree' });
    expect(confirm).toBeEnabled();
    await fireEvent.press(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ mode: 'existing-branch', branchName: 'feature/demo' });
  });

  test('requires a branch name before creating a new branch worktree', async () => {
    const onConfirm = jest.fn();
    const screen = await render(<NewWorktreeDialog
      branches={branches}
      confirmLabel="Create worktree"
      description="Create an isolated worktree."
      onCancel={jest.fn()}
      onConfirm={onConfirm}
      title="New worktree"
      visible
    />);

    await fireEvent.press(screen.getByText('New branch'));
    const confirm = screen.getByRole('button', { name: 'Create worktree' });
    expect(confirm).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('new-worktree-branch-name'), 'session/demo');
    expect(screen.getByRole('button', { name: 'Create worktree' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Create worktree' }));
    expect(onConfirm).toHaveBeenCalledWith({ mode: 'new-branch', branchName: 'session/demo', startRef: 'main' });
  });
});

describe('<NewSessionWorktreePicker />', () => {
  test('lists worktree state, blocks unavailable worktrees, and starts a new worktree', async () => {
    const onSelect = jest.fn();
    const onNewWorktree = jest.fn();
    const screen = await render(<NewSessionWorktreePicker
      newWorktreeLabel="New worktree"
      onNewWorktree={onNewWorktree}
      onSelect={onSelect}
      selectedValue="worktree_demo"
      title="Worktree"
      worktrees={worktrees}
    >
      {(onPress) => <Pressable accessibilityLabel="open worktrees" onPress={onPress}><Text>open</Text></Pressable>}
    </NewSessionWorktreePicker>);

    await fireEvent.press(screen.getByLabelText('open worktrees'));
    expect(screen.getByText('Managed · 1 in use')).toBeTruthy();
    expect(screen.getByText('Main worktree')).toBeTruthy();

    await fireEvent.press(screen.getByText('main'));
    expect(onSelect).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText('New worktree'));
    expect(onNewWorktree).toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('open worktrees'));
    await fireEvent.press(screen.getByText('feature/demo'));
    expect(onSelect).toHaveBeenCalledWith('worktree_demo');
  });
});
