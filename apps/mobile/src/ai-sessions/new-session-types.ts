import type { AiSessionModelSelection, AiSessionPermissionMode, AiSessionReasoningEffort } from '@task-handoff/protocol/ai-sessions';
import type { RepositoryAiSessionWorkspace } from '@task-handoff/protocol/repository';
import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';
import { controlPlaneLocalFolderDisplayName, type AiSessionModelGroup, type AiSessionPastedTextPresentation, type ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';

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
  modelGroups?: AiSessionModelGroup[];
  modelSelection?: AiSessionModelSelection;
  reasoningEffort?: AiSessionReasoningEffort;
  reasoningEffortEnabled?: boolean;
  busy: boolean;
  disabled: boolean;
  error?: string;
  attachments: readonly { id: string; kind: 'image' | 'file'; name: string; size?: number; textPresentation?: AiSessionPastedTextPresentation }[];
  visualBalanceInset?: number;
  onInstanceChange(value: string): void;
  onAgentChange(value: string): void;
  onFolderChange(value?: string): void;
  onWorkspaceModeChange?(value: 'current-folder' | 'worktree'): void;
  onBranchChange?(value: string): void;
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

export function storyAiSessionCreationDefaults(
  instances: readonly Pick<ControlPlaneInstanceDirectoryEntry, 'id' | 'nodeId'>[],
  snapshot: {
    instances: readonly {
      instanceId: string;
      aiSessions: { sessions: readonly ({ id?: string; agent?: string; cwd?: string; cwdFolderId?: string; storyId?: string; updatedAt: string } & Record<string, unknown>)[] } & Record<string, unknown>;
    }[];
  } | undefined,
  storyId: string,
  nodeId: string,
): { instanceId?: string; cwd?: string; cwdFolderId?: string } {
  const storyInstanceIds = new Set(instances.filter((instance) => instance.nodeId === nodeId).map((instance) => instance.id));
  let latest: { instanceId: string; cwd?: string; cwdFolderId?: string; updatedAt: string } | undefined;
  for (const instance of snapshot?.instances ?? []) {
    if (!storyInstanceIds.has(instance.instanceId)) continue;
    for (const session of instance.aiSessions.sessions) {
      if (session.storyId !== storyId) continue;
      if (!latest || Date.parse(session.updatedAt) > Date.parse(latest.updatedAt)) {
        latest = { instanceId: instance.instanceId, cwd: session.cwd, cwdFolderId: session.cwdFolderId, updatedAt: session.updatedAt };
      }
    }
  }
  return latest
    ? { instanceId: latest.instanceId, cwd: latest.cwd, cwdFolderId: latest.cwdFolderId }
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
  folders: readonly Pick<ControlPlaneNodeLocalFolder, 'id' | 'name' | 'path'>[],
): AiSessionFolderOption[] {
  if (source?.type === 'local-folder') {
    return folders.map((folder) => ({ ...folder, name: controlPlaneLocalFolderDisplayName(folder), cwdFolderId: folder.id }));
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
  if (!instance.availableAgents.length) return 'No AI agents are available on this instance.';
  return undefined;
}
