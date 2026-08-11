import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AiSessionGitSelection, AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';
import type { RepositoryAiSessionWorkspace } from '@task-handoff/protocol/repository';
import type { ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';

import { NewSessionForm, newSessionVisualBalanceInset } from '../../src/ai-sessions/NewSessionForm';
import { initialInstanceId, instanceCreateGuidance } from '../../src/ai-sessions/new-session-types';
import { createMobileAiSession, lifecycleGuidance } from '../../src/ai-sessions/session-lifecycle';
import { uploadMobileAttachment, usableUploadRefs, validateMobileLocalFile, type MobilePendingAttachment } from '../../src/ai-sessions/attachments';
import { pickDocument, pickImage, type MobileLocalFile } from '../../src/platform/file-picker';
import { createMobileControlPlaneClient } from '../../src/control-plane/client';
import { mobileCreateRequestStore, mobilePermissionStore, mobileProfileStore, mobileSecureStore } from '../../src/control-plane/runtime';
import { useActiveDirectories } from '../../src/directories/use-directories';
import { mobileDirectoryStore } from '../../src/directories/store';
import { useMobileToast } from '../../src/components/MobileToast';
import { useI18n } from '../../src/i18n';

export default function NewAiSessionRoute() {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const toast = useMobileToast();
  const { instanceId: requestedInstanceId } = useLocalSearchParams<{ instanceId?: string }>();
  const { controlPlaneId, state } = useActiveDirectories();
  const [selection, setSelection] = useState<{ instanceId?: string; agent?: string; folderId?: string }>({});
  const [message, setMessage] = useState('');
  const [permissionSelection, setPermissionSelection] = useState<{ instanceId: string; mode: AiSessionPermissionMode }>();
  const [savingPermission, setSavingPermission] = useState(false);
  const [folderState, setFolderState] = useState<{ nodeId: string; folders: ControlPlaneNodeLocalFolder[] }>({ nodeId: '', folders: [] });
  const [workspaceState, setWorkspaceState] = useState<{
    instanceId?: string;
    folderId?: string;
    workspace?: RepositoryAiSessionWorkspace;
    mode: 'current-folder' | 'worktree';
    branch?: string;
  }>({ mode: 'current-folder' });
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<NewSessionLocalAttachment[]>([]);

  const selectedInstanceId = state.instances.some((instance) => instance.id === selection.instanceId)
    ? selection.instanceId!
    : initialInstanceId(state.instances, requestedInstanceId);
  const selectedInstance = state.instances.find((instance) => instance.id === selectedInstanceId);
  const agent = selectedInstance?.availableAgents.some((candidate) => candidate.id === selection.agent)
    ? selection.agent!
    : selectedInstance?.availableAgents[0]?.id ?? '';
  const folderId = selection.instanceId === selectedInstanceId ? selection.folderId : undefined;
  const permissionMode = permissionSelection?.instanceId === selectedInstanceId
    ? permissionSelection.mode
    : selectedInstance?.config.defaultCodexPermissionMode ?? 'ask';

  const guidance = instanceCreateGuidance(selectedInstance);
  useEffect(() => {
    const nodeId = selectedInstance?.nodeId;
    if (!nodeId) return;
    const abort = new AbortController();
    void mobileProfileStore.active().then(async (profile) => {
      if (!profile || abort.signal.aborted) return;
      const nextFolders = await createMobileControlPlaneClient(profile, mobileSecureStore).api.resources.nodeLocalFolders(nodeId, abort.signal);
      if (!abort.signal.aborted) setFolderState({ nodeId, folders: nextFolders });
    }).catch(() => {
      if (!abort.signal.aborted) setFolderState({ nodeId, folders: [] });
    });
    return () => abort.abort();
  }, [selectedInstance?.nodeId]);

  useEffect(() => {
    if (!selectedInstanceId || !folderId) return;
    const abort = new AbortController();
    void mobileProfileStore.active().then(async (profile) => {
      if (!profile || abort.signal.aborted) return;
      const workspace = await createMobileControlPlaneClient(profile, mobileSecureStore).api.aiSessions.workspace(selectedInstanceId, folderId, abort.signal);
      if (abort.signal.aborted) return;
      setWorkspaceState({
        instanceId: selectedInstanceId,
        folderId,
        workspace,
        mode: 'current-folder',
        branch: workspace.currentBranch
          || workspace.branches.find((candidate) => candidate.current)?.name
          || workspace.branches.find((candidate) => candidate.currentFolderSelectable)?.name,
      });
    }).catch(() => {
      // Compatibility for v0.0.21: an older Control Plane keeps the cwd-only creation flow.
      if (!abort.signal.aborted) setWorkspaceState({ instanceId: selectedInstanceId, folderId, mode: 'current-folder' });
    });
    return () => abort.abort();
  }, [selectedInstanceId, folderId]);

  const workspaceMatchesSelection = workspaceState.instanceId === selectedInstanceId && workspaceState.folderId === folderId;
  const workspaceLoading = Boolean(selectedInstanceId && folderId && !workspaceMatchesSelection);

  const gitSelection: AiSessionGitSelection | undefined = workspaceMatchesSelection
    && workspaceState.workspace?.availability === 'available'
    && workspaceState.branch
    ? { mode: workspaceState.mode, branch: workspaceState.branch }
    : undefined;

  const create = async () => {
    if (!selectedInstance || !controlPlaneId || guidance) return;
    setBusy(true);
    try {
      const profile = await mobileProfileStore.active();
      if (!profile) throw new Error('No active Control Plane.');
      const requestInput = {
        agent,
        cwdFolderId: folderId,
        gitSelection,
        message,
        permissionMode,
        attachments: attachments.map(({ local }) => ({ kind: local.kind, name: local.name, size: local.size })),
      };
      const requestId = await mobileCreateRequestStore.getOrCreate(controlPlaneId, selectedInstance.id, requestInput, Crypto.randomUUID);
      const client = createMobileControlPlaneClient(profile, mobileSecureStore).api;
      const uploadedAttachments = await Promise.all(attachments.map(async (attachment) => attachment.uploaded?.phase === 'uploaded'
        ? attachment.uploaded
        : uploadMobileAttachment(client, { instanceId: selectedInstance.id, sessionId: requestId }, attachment.local)));
      setAttachments((current) => current.map((attachment) => {
        const index = attachments.findIndex((candidate) => candidate.id === attachment.id);
        return index >= 0 ? { ...attachment, uploaded: uploadedAttachments[index] } : attachment;
      }));
      const result = await createMobileAiSession(client, {
        instance: selectedInstance,
        agent,
        cwdFolderId: folderId,
        gitSelection,
        message,
        attachments: usableUploadRefs(uploadedAttachments),
        permissionMode,
        clientRequestId: requestId,
      });
      if (agent === 'codex') await mobilePermissionStore.write(controlPlaneId, selectedInstance.id, result.aiSessionId, permissionMode).catch(() => undefined);
      await mobileCreateRequestStore.clear(controlPlaneId, selectedInstance.id, requestId);
      router.replace({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId: selectedInstance.id, sessionId: result.aiSessionId } });
    } catch (cause) {
      toast.show({ detail: lifecycleGuidance(cause).message, title: t('toast.actionFailed', { action: t('sessions.create') }), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const addAttachment = async (kind: 'image' | 'file') => {
    try {
      const selected = await (kind === 'image' ? pickImage() : pickDocument());
      if (!selected) return;
      const local = validateMobileLocalFile(selected);
      setAttachments((current) => [...current, { id: Crypto.randomUUID(), local }]);
    } catch (cause) {
      toast.show({ detail: cause instanceof Error ? cause.message : 'Could not select attachment.', title: t('composer.addAttachment'), tone: 'error' });
    }
  };

  const removeAttachment = (id: string) => {
    if (busy) return;
    setAttachments((current) => {
      const attachment = current.find((candidate) => candidate.id === id);
      if (attachment?.local.temporary && !attachment.uploaded) {
        try { new File(attachment.local.uri).delete(); } catch { /* The picker cache may already be gone. */ }
      }
      return current.filter((candidate) => candidate.id !== id);
    });
  };

  const updatePermissionMode = async (next: AiSessionPermissionMode) => {
    if (!selectedInstance || agent !== 'codex' || !controlPlaneId || savingPermission || next === permissionMode) return;
    const previous = permissionMode;
    setPermissionSelection({ instanceId: selectedInstance.id, mode: next });
    setSavingPermission(true);
    try {
      const profile = await mobileProfileStore.active();
      if (!profile || profile.identity.controlPlaneId !== controlPlaneId) throw new Error('No active Control Plane.');
      const saved = await createMobileControlPlaneClient(profile, mobileSecureStore).api.resources.updateInstanceDefaultPermissionMode(selectedInstance.id, next);
      mobileDirectoryStore.setInstanceDefaultPermissionMode(controlPlaneId, selectedInstance.id, saved);
      setPermissionSelection({ instanceId: selectedInstance.id, mode: saved });
    } catch (cause) {
      setPermissionSelection({ instanceId: selectedInstance.id, mode: previous });
      toast.show({ detail: cause instanceof Error ? cause.message : 'Could not save the default permission mode.', title: t('toast.actionFailed', { action: t('sessions.permission') }), tone: 'error' });
    } finally {
      setSavingPermission(false);
    }
  };

  return <NewSessionForm
    key={selectedInstance?.id || 'no-instance'}
    instances={state.instances}
    nodes={state.nodes}
    selectedInstance={selectedInstance}
    folders={folderState.nodeId === selectedInstance?.nodeId ? folderState.folders : []}
    selectedInstanceId={selectedInstanceId}
    selectedAgent={agent}
    selectedFolderId={folderId}
    workspace={workspaceMatchesSelection ? workspaceState.workspace : undefined}
    workspaceMode={workspaceMatchesSelection ? workspaceState.mode : 'current-folder'}
    selectedBranch={workspaceMatchesSelection ? workspaceState.branch : undefined}
    workspaceLoading={workspaceLoading}
    message={message}
    attachments={attachments.map(({ id, local }) => ({ id, kind: local.kind, name: local.name }))}
    permissionMode={permissionMode}
    busy={busy || savingPermission || workspaceLoading}
    disabled={busy || savingPermission || workspaceLoading || Boolean(guidance) || !agent || !message.trim()}
    error={guidance}
    visualBalanceInset={newSessionVisualBalanceInset(Platform.OS, insets.top)}
    onInstanceChange={(instanceId) => {
      const instance = state.instances.find((candidate) => candidate.id === instanceId);
      setSelection({ instanceId, agent: instance?.availableAgents[0]?.id });
    }}
    onAgentChange={(nextAgent) => setSelection({ instanceId: selectedInstanceId, agent: nextAgent, folderId })}
    onFolderChange={(nextFolderId) => setSelection({ instanceId: selectedInstanceId, agent, folderId: nextFolderId })}
    onWorkspaceModeChange={(mode) => {
      const workspace = workspaceState.workspace;
      const selected = workspace?.branches.find((candidate) => candidate.name === workspaceState.branch);
      const selectable = selected && (mode === 'worktree' ? selected.worktreeSelectable : selected.currentFolderSelectable);
      const branch = selectable
        ? selected.name
        : workspace?.branches.find((candidate) => mode === 'worktree' ? candidate.worktreeSelectable : candidate.currentFolderSelectable)?.name;
      setWorkspaceState((current) => ({ ...current, mode, branch }));
    }}
    onBranchChange={(branch) => setWorkspaceState((current) => ({ ...current, branch }))}
    onMessageChange={setMessage}
    onAddImage={() => { void addAttachment('image'); }}
    onAddFile={() => { void addAttachment('file'); }}
    onRemoveAttachment={removeAttachment}
    onPermissionModeChange={(next) => { void updatePermissionMode(next); }}
    onCreate={() => { void create(); }}
  />;
}

type NewSessionLocalAttachment = {
  id: string;
  local: MobileLocalFile & { mime: string; size: number };
  uploaded?: MobilePendingAttachment;
};
