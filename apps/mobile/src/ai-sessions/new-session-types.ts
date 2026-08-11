import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';
import type { RepositoryAiSessionWorkspace } from '@task-handoff/protocol/repository';
import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';
import type { ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';

export type NewSessionFormProps = {
  instances: readonly ControlPlaneInstanceDirectoryEntry[];
  nodes: readonly ControlPlaneNodeDirectoryEntry[];
  selectedInstanceId: string;
  selectedInstance?: ControlPlaneInstanceDirectoryEntry;
  folders: readonly ControlPlaneNodeLocalFolder[];
  selectedAgent: string;
  selectedFolderId?: string;
  workspace?: RepositoryAiSessionWorkspace;
  workspaceMode?: 'current-folder' | 'worktree';
  selectedBranch?: string;
  workspaceLoading?: boolean;
  message: string;
  permissionMode: AiSessionPermissionMode;
  busy: boolean;
  disabled: boolean;
  error?: string;
  attachments: readonly { id: string; kind: 'image' | 'file'; name: string }[];
  visualBalanceInset?: number;
  onInstanceChange(value: string): void;
  onAgentChange(value: string): void;
  onFolderChange(value?: string): void;
  onWorkspaceModeChange?(value: 'current-folder' | 'worktree'): void;
  onBranchChange?(value: string): void;
  onMessageChange(value: string): void;
  onAddImage(): void;
  onAddFile(): void;
  onRemoveAttachment(id: string): void;
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
