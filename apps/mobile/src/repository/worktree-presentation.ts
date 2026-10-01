import type { RepositoryMoveWorktreeBlocker, RepositoryWorktree, RepositoryWorktreeBlocker } from '@task-handoff/protocol/repository';

import type { Translate } from '../i18n';

export function repositoryWorktreeLabel(worktree: RepositoryWorktree, t: Translate) {
  if (worktree.head.state === 'branch') return worktree.head.branch || t('repository.worktrees.unknownBranch');
  if (worktree.head.state === 'unborn') return t('repository.worktrees.unbornBranch');
  return t('repository.worktrees.detachedAt', { commit: worktree.head.oid?.slice(0, 8) || t('repository.worktrees.unknownCommit') });
}

export function repositoryWorktreeKindLabel(worktree: RepositoryWorktree, t: Translate) {
  if (worktree.isMain) return t('repository.worktrees.main');
  return worktree.managed ? t('repository.worktrees.managed') : t('repository.worktrees.external');
}

export function repositoryWorktreeActiveSessionCount(worktree: RepositoryWorktree) {
  return worktree.activeAiSessionIds.length + worktree.activeAppSessionIds.length;
}

export function repositoryWorktreeMeta(worktree: RepositoryWorktree, t: Translate) {
  const labels = [repositoryWorktreeKindLabel(worktree, t)];
  if (worktree.isCurrent) labels.unshift(t('repository.worktrees.current'));
  const activeSessions = repositoryWorktreeActiveSessionCount(worktree);
  if (activeSessions) labels.push(t('repository.worktrees.inUse', { count: activeSessions }));
  if (worktree.dirty) labels.push(t('repository.worktrees.dirty'));
  if (worktree.locked) labels.push(t('repository.worktrees.locked'));
  if (worktree.prunable) labels.push(t('repository.worktrees.prunable'));
  return labels.join(' · ');
}

const worktreeBlockerKeys = {
  'main-worktree': 'repository.worktrees.blockers.main',
  'external-worktree': 'repository.worktrees.blockers.external',
  'outside-workspace-roots': 'repository.worktrees.blockers.outsideRoots',
  dirty: 'repository.worktrees.blockers.uncommitted',
  locked: 'repository.worktrees.blockers.locked',
  prunable: 'repository.worktrees.blockers.prunable',
  'session-occupied': 'repository.worktrees.blockers.activeSession',
  'path-inaccessible': 'repository.worktrees.blockers.directoryInaccessible',
} as const satisfies Record<RepositoryWorktreeBlocker, Parameters<Translate>[0]>;

const moveWorktreeBlockerKeys = {
  'main-worktree': 'repository.worktrees.blockers.main',
  'outside-workspace-roots': 'repository.worktrees.blockers.outsideRoots',
  'path-inaccessible': 'repository.worktrees.blockers.directoryInaccessible',
  locked: 'repository.worktrees.blockers.locked',
  prunable: 'repository.worktrees.blockers.prunable',
  'session-occupied': 'repository.worktrees.blockers.activeSession',
  'main-session-occupied': 'repository.worktrees.blockers.mainSessionOccupied',
  'detached-head': 'repository.worktrees.blockers.detachedHead',
  'unborn-head': 'repository.worktrees.blockers.unbornHead',
  'main-dirty': 'repository.worktrees.blockers.mainDirty',
} as const satisfies Record<RepositoryMoveWorktreeBlocker, Parameters<Translate>[0]>;

export function repositoryWorktreeCreateBlockers(worktree: RepositoryWorktree, t: Translate) {
  const labels = worktree.createAiSessionBlockers.map((blocker) => t(worktreeBlockerKeys[blocker]));
  return labels.length ? labels : worktree.canCreateAiSession ? [] : [t('repository.worktrees.blockers.unavailable')];
}

export function repositoryWorktreeRemoveBlockers(worktree: RepositoryWorktree, t: Translate) {
  if (worktree.isCurrent) return [t('repository.worktrees.blockers.current')];
  const labels = worktree.removeBlockers.map((blocker) => t(worktreeBlockerKeys[blocker]));
  return labels.length ? labels : worktree.canRemove ? [] : [t('repository.worktrees.blockers.cannotRemove')];
}

export function repositoryMoveWorktreeBlockers(blockers: readonly RepositoryMoveWorktreeBlocker[], t: Translate) {
  return blockers.map((blocker) => t(moveWorktreeBlockerKeys[blocker]));
}

export function repositoryWorktreeSearchText(worktree: RepositoryWorktree, t: Translate) {
  return [repositoryWorktreeLabel(worktree, t), repositoryWorktreeKindLabel(worktree, t), repositoryWorktreeMeta(worktree, t)].join(' ').toLocaleLowerCase();
}
