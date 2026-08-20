import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';
import type { RepositoryAiSessionWorkspace } from '@task-handoff/protocol/repository';
import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';
import { controlPlaneLocalFolderDisplayName, type ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';

type InstanceWorkspaceSource = { type: string; localFolderId?: string; path?: string };
export const INSTANCE_WORKSPACE_FOLDER_ID = "__instance_workspace__";

export type AiSessionFolderOption = {
  id: string;
  cwdFolderId?: string;
  name: string;
  path: string;
};

export type NewSessionFormProps = {
  instances: readonly ControlPlaneInstanceDirectoryEntry[];
  nodes: readonly ControlPlaneNodeDirectoryEntry[];
  selectedInstanceId: string;
  selectedInstance?: ControlPlaneInstanceDirectoryEntry;
  folders: readonly AiSessionFolderOption[];
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

export function defaultAiSessionFolderId(
  source: InstanceWorkspaceSource | undefined,
  workspacePath: string | undefined,
  folders: readonly Pick<ControlPlaneNodeLocalFolder, 'id' | 'path'>[],
) {
  if (source?.type !== 'local-folder') return workspacePath?.trim() ? INSTANCE_WORKSPACE_FOLDER_ID : undefined;
  if (source.localFolderId && folders.some((folder) => folder.id === source.localFolderId)) return source.localFolderId;
  const sourcePath = normalizeFolderPath(source.path);
  return sourcePath ? folders.find((folder) => normalizeFolderPath(folder.path) === sourcePath)?.id : undefined;
}

export function aiSessionFolderOptions(
  source: InstanceWorkspaceSource | undefined,
  workspacePath: string | undefined,
  folders: readonly Pick<ControlPlaneNodeLocalFolder, 'id' | 'name' | 'path'>[],
): AiSessionFolderOption[] {
  if (source?.type === 'local-folder') {
    return folders.map((folder) => ({ ...folder, name: controlPlaneLocalFolderDisplayName(folder), cwdFolderId: folder.id }));
  }
  const path = workspacePath?.trim();
  return path ? [{ id: INSTANCE_WORKSPACE_FOLDER_ID, name: folderPathName(path), path }] : [];
}

function normalizeFolderPath(value: string | undefined) {
  const path = value?.trim() || '';
  if (!path || /^\/+$/u.test(path) || /^[A-Za-z]:[\\/]*$/u.test(path)) return path;
  return path.replace(/[\\/]+$/u, '');
}

function folderPathName(value: string) {
  const normalized = value.replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]+/u).filter(Boolean).at(-1) || value;
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
