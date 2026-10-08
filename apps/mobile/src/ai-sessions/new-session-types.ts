import type { ReactNode } from 'react';
import type { AiSessionModelSelection, AiSessionPermissionMode, AiSessionReasoningEffort } from '@task-handoff/protocol/ai-sessions';
import type { RepositoryAiSessionWorkspace } from '@task-handoff/protocol/repository';
import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';
import { controlPlaneLocalFolderDisplayName, latestStorySessionForCreation, type AiSessionModelGroup, type AiSessionPastedTextPresentation, type ControlPlaneAiSessions, type ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';
import { storyTreeSessionForest } from '../stories/story-tree-model';

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
  selectedWorktree?: string;
  selectedWorktreeLabel?: string;
  workspaceLoading?: boolean;
  message: string;
  permissionMode: AiSessionPermissionMode;
  permissionModes?: AiSessionPermissionMode[];
  modelGroups?: AiSessionModelGroup[];
  modelSelection?: AiSessionModelSelection;
  reasoningEffort?: AiSessionReasoningEffort;
  reasoningEffortEnabled?: boolean;
  busy: boolean;
  disabled: boolean;
  error?: string;
  embedded?: boolean;
  header?: ReactNode;
  attachmentsDisabled?: boolean;
  attachments: readonly { id: string; kind: 'image' | 'file'; name: string; size?: number; textPresentation?: AiSessionPastedTextPresentation }[];
  submitLabel?: string;
  submittingLabel?: string;
  visualBalanceInset?: number;
  onInstanceChange(value: string): void;
  onAgentChange(value: string): void;
  onFolderChange(value?: string): void;
  onWorkspaceModeChange?(value: 'current-folder' | 'worktree'): void;
  onBranchChange?(value: string): void;
  onWorktreeChange?(value: string): void;
  onNewWorktree?(): void;
  onMessageChange(value: string): void;
  onAddImage(): void;
  onAddFile(): void;
  onPasteImages?(uris: string[]): void;
  onPasteText?(text: string): void;
  onRemoveAttachment(id: string): void;
  onPermissionModeChange(value: AiSessionPermissionMode): void;
  onModelSelectionChange?(value: AiSessionModelSelection): void;
  onReasoningEffortChange?(value: AiSessionReasoningEffort): void;
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

/**
 * Creation defaults for a Story composer follow the Web Story view exactly: the
 * newest root session of the Story on the Story's own node, ordered by last user
 * message. Sessions closed from the Story tree stay visible there but must not
 * seed new sessions, so they are skipped.
 */
export function storyAiSessionCreationDefaults(
  instances: readonly Pick<ControlPlaneInstanceDirectoryEntry, 'id' | 'nodeId'>[],
  snapshot: ControlPlaneAiSessions | undefined,
  storyId: string,
  nodeId: string,
): { instanceId?: string; sessionId?: string; cwd?: string; cwdFolderId?: string } {
  const latest = latestStorySessionForCreation(
    storyTreeSessionForest(snapshot),
    storyId,
    instances.filter((instance) => instance.nodeId === nodeId).map((instance) => instance.id),
  );
  return latest
    ? { instanceId: latest.instanceId, sessionId: latest.id, cwd: latest.cwd, cwdFolderId: latest.cwdFolderId }
    : { instanceId: instances.find((instance) => instance.nodeId === nodeId)?.id };
}

export function initialAiSessionFolderId(
  options: readonly AiSessionFolderOption[],
  input: {
    cwd?: string;
    cwdFolderId?: string;
    runtimeType?: string;
    source?: InstanceWorkspaceSource;
    workspacePath?: string;
  },
) {
  if (input.cwdFolderId) {
    const folder = options.find((candidate) => candidate.cwdFolderId === input.cwdFolderId || candidate.id === input.cwdFolderId);
    if (folder) return folder.id;
  }
  // Compatibility for v0.0.28: historical sessions can identify their folder only by cwd.
  const cwd = normalizeFolderPath(input.cwd);
  if (!cwd) return undefined;
  const direct = options.find((folder) => normalizeFolderPath(folder.path) === cwd);
  if (direct) return direct.id;
  if (input.runtimeType === 'local' || input.source?.type !== 'local-folder') return undefined;
  const sourcePath = normalizeFolderPath(input.source.path);
  const workspacePath = normalizeFolderPath(input.workspacePath);
  if (!sourcePath || !workspacePath) return undefined;
  return options.find((folder) => {
    const relativePath = relativeFolderPath(sourcePath, folder.path);
    if (relativePath === undefined) return false;
    return normalizeFolderPath([workspacePath, relativePath].filter(Boolean).join('/')) === cwd;
  })?.id;
}

export function aiSessionFolderOptions(
  source: InstanceWorkspaceSource | undefined,
  workspacePath: string | undefined,
  folders: readonly Pick<ControlPlaneNodeLocalFolder, 'id' | 'name' | 'path' | 'localizedNames'>[],
  locale?: string,
): AiSessionFolderOption[] {
  if (source?.type === 'local-folder') {
    return folders.map((folder) => ({ id: folder.id, path: folder.path, name: controlPlaneLocalFolderDisplayName(folder, locale), cwdFolderId: folder.id }));
  }
  const path = workspacePath?.trim();
  return path ? [{ id: INSTANCE_WORKSPACE_FOLDER_ID, name: folderPathName(path), path }] : [];
}

function normalizeFolderPath(value: string | undefined) {
  const path = value?.trim().replaceAll('\\', '/') || '';
  if (!path || /^\/+$/u.test(path) || /^[A-Za-z]:[\\/]*$/u.test(path)) return path;
  return path.replace(/\/+$/u, '');
}

function relativeFolderPath(root: string, candidate: string) {
  const normalizedRoot = normalizeFolderPath(root);
  const normalizedCandidate = normalizeFolderPath(candidate);
  const windows = /^[A-Za-z]:\//u.test(normalizedRoot);
  const comparableRoot = windows ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableCandidate = windows ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  if (comparableCandidate === comparableRoot) return '';
  return comparableCandidate.startsWith(`${comparableRoot}/`)
    ? normalizedCandidate.slice(normalizedRoot.length + 1)
    : undefined;
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
  if (!instance.availableAgents.length) return 'No AI agents are installed on this instance. Open the Web Control Plane and go to Instance settings > App management to install one.';
  return undefined;
}
