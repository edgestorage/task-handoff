import type { ControlPlaneInstanceAction } from '@task-handoff/protocol/control-plane-directory';

import type { Translate } from '../i18n';

export const PRIMARY_INSTANCE_LIFECYCLE_ACTIONS = ['start', 'stop', 'restart'] as const;

export function instanceLifecycleActionLabel(action: ControlPlaneInstanceAction, t: Translate) {
  return t(
    action === 'start' ? 'instance.start' : action === 'stop' ? 'instance.stop' : action === 'restart' ? 'instance.restart' : action === 'retry-git' ? 'instance.retryGit' : 'instance.retryImage',
  );
}

export function instanceRetryAction(actions: readonly ControlPlaneInstanceAction[]): 'retry-git' | 'retry-image' | undefined {
  // Image and Git preparation are sequential, so a failed instance offers a
  // single retry for whichever step failed.
  return actions.includes('retry-git') ? 'retry-git' : actions.includes('retry-image') ? 'retry-image' : undefined;
}

export function instanceControlActions(actions: readonly ControlPlaneInstanceAction[]): ControlPlaneInstanceAction[] {
  const retryAction = instanceRetryAction(actions);
  return [
    ...PRIMARY_INSTANCE_LIFECYCLE_ACTIONS.filter((action) => actions.includes(action)),
    ...(retryAction ? [retryAction] : []),
  ];
}
