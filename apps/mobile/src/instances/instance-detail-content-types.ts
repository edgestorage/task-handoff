import type { ControlPlaneInstanceAction } from '@task-handoff/protocol/control-plane-directory';

export type InstanceDetailStatusTone = 'healthy' | 'error' | 'muted';

export type InstanceDetailContentProps = {
  actions: readonly ControlPlaneInstanceAction[];
  actionsEnabled: boolean;
  activeSessionCount: number;
  error?: { code: string; message: string };
  heartbeat: string;
  lifecycleAction?: ControlPlaneInstanceAction;
  nodeName: string;
  onCreateSession(): void;
  onLifecycleAction(action: ControlPlaneInstanceAction): void;
  onShowHistory(): void;
  onShowSessions(): void;
  onShowWorktrees(): void;
  problemSessionCount: number;
  protocol: string;
  protocolCompatible: boolean;
  protocolWarning?: string;
  runtime: string;
  status: string;
  statusTone: InstanceDetailStatusTone;
  workspace: string;
};
