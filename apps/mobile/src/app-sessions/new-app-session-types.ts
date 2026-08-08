import type { ControlPlaneInstanceResourceEntry } from '@task-handoff/control-plane-client';

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
