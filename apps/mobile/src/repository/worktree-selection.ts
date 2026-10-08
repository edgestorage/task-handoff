import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import { isControlPlaneNotFoundError } from '@task-handoff/control-plane-client';
import type { AiSessionCreateWorkspaceSelection, AiSessionGitSelection } from '@task-handoff/protocol/ai-sessions';
import type { RepositoryAiSessionWorkspace } from '@task-handoff/protocol/repository';

export const MOBILE_NEW_WORKTREE_OPTION = '__new_worktree__';
export const MOBILE_MANAGED_WORKTREE_OPTION = '__managed_worktree__';

export type AiSessionWorkspaceMode = 'current-folder' | 'worktree';
export type MobileNewWorktreeSelection =
  | { mode: 'existing-branch'; branchName: string }
  | { mode: 'new-branch'; branchName: string; startRef: string };

export type AiSessionWorkspaceSelectionState = {
  instanceId?: string;
  folderId?: string;
  workspace?: RepositoryAiSessionWorkspace;
  mode: AiSessionWorkspaceMode;
  branch?: string;
  worktreeId?: string;
  /** Compatibility for v0.0.21: the worktree is created together with the AI session. */
  managedWorktreeBranch?: string;
  newWorktree?: { branchName: string; startRef: string };
};

export function initialAiSessionWorkspaceState(
  instanceId: string | undefined,
  folderId: string | undefined,
  workspace: RepositoryAiSessionWorkspace,
  inheritedWorktreeId?: string,
): AiSessionWorkspaceSelectionState {
  // The inherited worktree comes from the session's own repository context; it only
  // takes effect when this folder's workspace proves it is selectable here. The
  // folder's own worktree stays in `current-folder` mode.
  const inherited = inheritedWorktreeId
    ? workspace.worktrees.find((candidate) => candidate.id === inheritedWorktreeId && !candidate.isCurrent && candidate.canCreateAiSession)
    : undefined;
  return {
    instanceId,
    folderId,
    workspace,
    mode: inherited ? 'worktree' : 'current-folder',
    branch: workspace.currentBranch
      || workspace.branches.find((candidate) => candidate.current)?.name
      || workspace.branches.find((candidate) => candidate.currentFolderSelectable)?.name,
    worktreeId: inherited?.id
      || workspace.worktrees.find((candidate) => !candidate.isCurrent && candidate.canCreateAiSession)?.id
      || workspace.worktrees.find((candidate) => candidate.canCreateAiSession)?.id,
  };
}

export function switchAiSessionWorkspaceMode(state: AiSessionWorkspaceSelectionState, mode: AiSessionWorkspaceMode): AiSessionWorkspaceSelectionState {
  const workspace = state.workspace;
  const selectedBranch = workspace?.branches.find((candidate) => candidate.name === state.branch);
  const branch = selectedBranch?.currentFolderSelectable ? selectedBranch.name : workspace?.branches.find((candidate) => candidate.currentFolderSelectable)?.name;
  const worktreeId = state.worktreeId
    || workspace?.worktrees.find((candidate) => !candidate.isCurrent && candidate.canCreateAiSession)?.id
    || workspace?.worktrees.find((candidate) => candidate.canCreateAiSession)?.id;
  return { ...state, mode, branch, worktreeId, managedWorktreeBranch: undefined, newWorktree: undefined };
}

export function selectAiSessionWorktree(state: AiSessionWorkspaceSelectionState, worktreeId: string): AiSessionWorkspaceSelectionState {
  return { ...state, worktreeId, managedWorktreeBranch: undefined, newWorktree: undefined };
}

export function aiSessionGitSelection(state: AiSessionWorkspaceSelectionState, matches: boolean): AiSessionGitSelection | undefined {
  if (!matches || state.workspace?.availability !== 'available') return undefined;
  if (state.mode === 'current-folder' && state.branch) return { mode: 'current-folder', branch: state.branch };
  if (state.mode === 'worktree' && state.managedWorktreeBranch) return { mode: 'worktree', branch: state.managedWorktreeBranch };
  return undefined;
}

export function aiSessionWorkspaceSelection(state: AiSessionWorkspaceSelectionState, matches: boolean): AiSessionCreateWorkspaceSelection | undefined {
  const workspace = state.workspace;
  if (!matches || workspace?.availability !== 'available' || state.mode !== 'worktree' || state.managedWorktreeBranch) return undefined;
  if (state.newWorktree && workspace.snapshotId) return { type: 'new-worktree', ...state.newWorktree, expectedSnapshotId: workspace.snapshotId };
  if (workspace.repositoryContextId && state.worktreeId) {
    return { type: 'existing-worktree', repositoryContextId: workspace.repositoryContextId, worktreeId: state.worktreeId };
  }
  return undefined;
}

export function aiSessionWorkspaceSelectionValue(state: AiSessionWorkspaceSelectionState) {
  if (state.managedWorktreeBranch) return MOBILE_MANAGED_WORKTREE_OPTION;
  if (state.newWorktree) return MOBILE_NEW_WORKTREE_OPTION;
  return state.worktreeId;
}

export function aiSessionWorkspaceSelectionLabel(state: AiSessionWorkspaceSelectionState) {
  if (state.managedWorktreeBranch) return state.managedWorktreeBranch;
  if (state.newWorktree) return state.newWorktree.branchName;
  return undefined;
}

export function aiSessionWorkspaceDialogInitialSelection(state: AiSessionWorkspaceSelectionState): MobileNewWorktreeSelection | undefined {
  if (state.managedWorktreeBranch) return { mode: 'existing-branch', branchName: state.managedWorktreeBranch };
  if (state.newWorktree) return { mode: 'new-branch', ...state.newWorktree };
  return undefined;
}

export type WorkspaceWorktreeCreationOutcome =
  | { type: 'created'; worktreeId: string; workspace: RepositoryAiSessionWorkspace }
  | { type: 'deferred'; managedWorktreeBranch?: string; newWorktree?: { branchName: string; startRef: string } };

export function applyWorktreeCreationOutcome(state: AiSessionWorkspaceSelectionState, outcome: WorkspaceWorktreeCreationOutcome): AiSessionWorkspaceSelectionState {
  if (outcome.type === 'created') {
    return { ...state, workspace: outcome.workspace, worktreeId: outcome.worktreeId, managedWorktreeBranch: undefined, newWorktree: undefined };
  }
  return { ...state, worktreeId: undefined, managedWorktreeBranch: outcome.managedWorktreeBranch, newWorktree: outcome.newWorktree };
}

/** Creates the worktree up front and falls back to session-time creation on v0.0.21 instances. */
export async function createWorkspaceWorktreeForSession(options: {
  client: ControlPlaneClient;
  instanceId: string;
  cwdFolderId?: string;
  workspace: RepositoryAiSessionWorkspace;
  selection: MobileNewWorktreeSelection;
}): Promise<WorkspaceWorktreeCreationOutcome> {
  const { client, instanceId, cwdFolderId, workspace, selection } = options;
  const expectedSnapshotId = workspace.snapshotId;
  if (!expectedSnapshotId) throw new Error('The repository workspace has no snapshot.');
  const target = { instanceId, ...(cwdFolderId ? { cwdFolderId } : {}) };
  try {
    const created = await client.repository.createWorktree(target, selection.mode === 'new-branch'
      ? { mode: 'new-branch', branchName: selection.branchName, startRef: selection.startRef, expectedSnapshotId }
      : { mode: 'existing-branch', branchName: selection.branchName, expectedSnapshotId });
    let refreshed = workspace;
    try {
      refreshed = await client.aiSessions.workspace(instanceId, cwdFolderId);
    } catch {
      // Keep the current workspace; the created worktree is still selected below.
    }
    return { type: 'created', worktreeId: created.worktreeId, workspace: refreshed };
  } catch (error) {
    // Compatibility for v0.0.21: an older controlled instance can only create a
    // worktree as part of AI session creation, so defer it to the session request.
    if (!isControlPlaneNotFoundError(error)) throw error;
    return selection.mode === 'existing-branch'
      ? { type: 'deferred', managedWorktreeBranch: selection.branchName }
      : { type: 'deferred', newWorktree: { branchName: selection.branchName, startRef: selection.startRef } };
  }
}
