import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';
import type { ControlPlaneInstanceDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

export type NewSessionFormProps = {
  instances: readonly ControlPlaneInstanceDirectoryEntry[];
  selectedInstanceId: string;
  selectedInstance?: ControlPlaneInstanceDirectoryEntry;
  selectedAgent: string;
  cwd: string;
  message: string;
  permissionMode: AiSessionPermissionMode;
  busy: boolean;
  disabled: boolean;
  error?: string;
  onInstanceChange(value: string): void;
  onAgentChange(value: string): void;
  onCwdChange(value: string): void;
  onMessageChange(value: string): void;
  onPermissionModeChange(value: AiSessionPermissionMode): void;
  onCreate(): void;
};

export function initialInstanceId(instances: readonly ControlPlaneInstanceDirectoryEntry[], requested?: string) {
  if (requested && instances.some((instance) => instance.id === requested)) return requested;
  return instances.find(canCreateSession)?.id ?? instances[0]?.id ?? '';
}

export function canCreateSession(instance: ControlPlaneInstanceDirectoryEntry) {
  return instance.ready
    && instance.connectionStatus === 'online'
    && Boolean(instance.workspace.path)
    && instance.availableAgents.length > 0;
}

export function instanceCreateGuidance(instance?: ControlPlaneInstanceDirectoryEntry) {
  if (!instance) return 'Choose an instance to continue.';
  if (!instance.ready || instance.connectionStatus !== 'online') return 'This instance is not ready. Start or repair it from the desktop app.';
  if (!instance.workspace.path) return 'This instance has not reported a workspace.';
  if (!instance.availableAgents.length) return 'No AI agents are available on this instance.';
  return undefined;
}
