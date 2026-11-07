import type { ControlPlaneInstanceResourceEntry, ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';

export type AppLaunchSelection = { controlPlaneId?: string; instanceId?: string; appId?: string; folderId?: string };

/** Display and submission share this target; stale selections never cross instance/profile boundaries. */
export function resolveAppLaunchSelection(controlPlaneId: string | undefined, instance: ControlPlaneInstanceResourceEntry | undefined,
  apps: readonly ControlPlaneInstanceResourceEntry['availableApps'][number][], selection: AppLaunchSelection,
  folders: readonly ControlPlaneNodeLocalFolder[]) {
  const scoped = selection.controlPlaneId === controlPlaneId && selection.instanceId === instance?.id;
  // The browser is discovered asynchronously. Keep the directory's initial App as the default
  // when that additional choice arrives, instead of switching the user's launch target.
  const app = apps.find((candidate) => scoped && candidate.id === selection.appId)
    ?? apps.find((candidate) => candidate.id === instance?.availableApps[0]?.id)
    ?? apps[0];
  const folderId = scoped && selection.appId === app?.id && app?.supportsCwdSelection && instance?.runtime.type === 'local'
    ? folders.find((folder) => folder.id === selection.folderId && folder.nodeId === instance.nodeId)?.id : undefined;
  return { app, folderId };
}

export function canLaunchApp(instance: ControlPlaneInstanceResourceEntry) {
  return instance.ready
    && instance.connectionStatus === 'online'
    && instance.availableApps.length > 0;
}

export function initialAppInstanceId(instances: readonly ControlPlaneInstanceResourceEntry[], requested?: string) {
  if (requested && instances.some((instance) => instance.id === requested)) return requested;
  return instances.find(canLaunchApp)?.id ?? instances[0]?.id ?? '';
}

export type AppLaunchIssue = 'choose-instance' | 'instance-not-ready' | 'no-apps';

export function appLaunchIssue(instance?: ControlPlaneInstanceResourceEntry): AppLaunchIssue | undefined {
  if (!instance) return 'choose-instance';
  if (!instance.ready || instance.connectionStatus !== 'online') return 'instance-not-ready';
  if (!instance.availableApps.length) return 'no-apps';
  return undefined;
}
