import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AI_SESSION_DEFAULT_REASONING_EFFORT, type AiSessionModelSelection, type AiSessionPermissionMode, type AiSessionReasoningEffort } from '@task-handoff/protocol/ai-sessions';
import { normalizeAiSessionReasoningEffortCapabilities } from '@task-handoff/protocol/ai-session-provider-capabilities';
import { aiSessionMessageText, defaultAiSessionModelSelection, deriveAiSessionModelGroups, type AiSessionCatalogModelEntity } from '@task-handoff/control-plane-client';
import { directoryAiSessionProviderCapability } from '@task-handoff/protocol/control-plane-directory';

import { NewSessionForm, newSessionVisualBalanceInset } from '../../src/ai-sessions/NewSessionForm';
import { NewWorktreeDialog } from '../../src/ai-sessions/NewWorktreeDialog';
import { aiSessionFolderOptions, defaultAiSessionFolderId, initialAiSessionFolderId, initialInstanceId, instanceCreateGuidance, type AiSessionFolderOption } from '../../src/ai-sessions/new-session-types';
import { createMobileAiSession, lifecycleGuidance } from '../../src/ai-sessions/session-lifecycle';
import { mobilePastedImage, mobilePastedText, uploadMobileAttachment, usableUploadRefs, validateMobileLocalFile, type MobilePendingAttachment } from '../../src/ai-sessions/attachments';
import { pickDocument, pickImage, type MobileLocalFile } from '../../src/platform/file-picker';
import { createMobileControlPlaneClient } from '../../src/control-plane/client';
import { mobileCreateRequestStore, mobilePermissionStore, mobileProfileStore, mobileSecureStore } from '../../src/control-plane/runtime';
import { useActiveDirectories } from '../../src/directories/use-directories';
import { mobileDirectoryStore } from '../../src/directories/store';
import { useMobileToast } from '../../src/components/MobileToast';
import { useI18n } from '../../src/i18n';
import { mobileSessionCreationInstanceStore, preferredSessionCreationInstanceId } from '../../src/session-creation/instance-selection';
import { useInstanceScope } from '../../src/instance-scope/use-instance-scope';
import {
  aiSessionGitSelection,
  aiSessionWorkspaceSelection,
  aiSessionWorkspaceDialogInitialSelection,
  aiSessionWorkspaceSelectionLabel,
  aiSessionWorkspaceSelectionValue,
  applyWorktreeCreationOutcome,
  createWorkspaceWorktreeForSession,
  initialAiSessionWorkspaceState,
  selectAiSessionWorktree,
  switchAiSessionWorkspaceMode,
  type AiSessionWorkspaceSelectionState,
  type MobileNewWorktreeSelection,
} from '../../src/repository/worktree-selection';
import { invalidateWorktreeInstance, loadWorktreeScope, subscribeToWorktreeForeground } from '../../src/repository/worktree-sync';

export default function NewAiSessionRoute() {
  const insets = useSafeAreaInsets();
  const { locale, t } = useI18n();
  const toast = useMobileToast();
  const { cwd: requestedCwd, cwdFolderId: requestedCwdFolderId, instanceId: requestedInstanceId, storyId: requestedStoryId, message: requestedMessage, worktreeSessionId: requestedWorktreeSessionId } = useLocalSearchParams<{ cwd?: string; cwdFolderId?: string; instanceId?: string; storyId?: string; message?: string; worktreeSessionId?: string }>();
  const { controlPlaneId, state } = useActiveDirectories();
  const { scope } = useInstanceScope();
  const [selection, setSelection] = useState<{ instanceId?: string; agent?: string; folderId?: string }>({});
  const [useRequestedDefaults, setUseRequestedDefaults] = useState(true);
  const [message, setMessage] = useState(typeof requestedMessage === 'string' ? requestedMessage : '');
  const [permissionSelection, setPermissionSelection] = useState<{ instanceId: string; mode: AiSessionPermissionMode }>();
  const [savingPermission, setSavingPermission] = useState(false);
  const [modelEntities, setModelEntities] = useState<AiSessionCatalogModelEntity[]>([]);
  const [modelSelectionDraft, setModelSelectionDraft] = useState<{ instanceId: string; agent: string; value: AiSessionModelSelection }>();
  const [reasoningEffort, setReasoningEffort] = useState<AiSessionReasoningEffort>();
  const [folderState, setFolderState] = useState<{ nodeId: string; folders: AiSessionFolderOption[] }>({ nodeId: '', folders: [] });
  const [workspaceState, setWorkspaceState] = useState<AiSessionWorkspaceSelectionState>({ mode: 'current-folder' });
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<NewSessionLocalAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  const pastedTextSequence = useRef(0);
  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (!attachment.local.temporary || attachment.uploaded?.phase === 'uploaded') continue;
      try { new File(attachment.local.uri).delete(); } catch { /* Temporary picker or paste cache may already be gone. */ }
    }
  }, []);

  const preferredInstanceId = preferredSessionCreationInstanceId(
    state.instances,
    requestedInstanceId,
    mobileSessionCreationInstanceStore.read(controlPlaneId, 'ai'),
  );
  const selectedInstanceId = state.instances.some((instance) => instance.id === selection.instanceId)
    ? selection.instanceId!
    : initialInstanceId(state.instances, preferredInstanceId);
  const selectedInstance = state.instances.find((instance) => instance.id === selectedInstanceId);
  const agent = selectedInstance?.availableAgents.some((candidate) => candidate.id === selection.agent)
    ? selection.agent!
    : selectedInstance?.availableAgents[0]?.id ?? '';
  const folderId = selection.instanceId === selectedInstanceId ? selection.folderId : undefined;
  const folders = folderState.nodeId === selectedInstance?.nodeId ? folderState.folders : [];
  const selectedFolder = folders.find((folder) => folder.id === folderId);
  const selectedCwdFolderId = selectedFolder?.cwdFolderId;
  const maxFileAttachmentBytes = selectedInstance?.config.aiSessionMaxFileAttachmentBytes;
  const providerCapability = directoryAiSessionProviderCapability(selectedInstance?.capabilities, agent);
  const permissionModes = providerCapability?.permissionModes || [];
  const requestedPermissionMode = permissionSelection?.instanceId === selectedInstanceId
    ? permissionSelection.mode
    : selectedInstance?.config.defaultCodexPermissionMode ?? 'ask';
  const permissionMode = permissionModes.includes(requestedPermissionMode) ? requestedPermissionMode : permissionModes[0] ?? requestedPermissionMode;
  const modelGroups = selectedInstance ? deriveAiSessionModelGroups({
    entities: modelEntities,
    assignment: selectedInstance.modelSelection,
    agent,
    nodeId: selectedInstance.nodeId,
    mode: 'create',
    capability: providerCapability?.modelSelection,
  }) : [];
  const modelSelection = modelSelectionDraft?.instanceId === selectedInstanceId && modelSelectionDraft.agent === agent
    ? modelSelectionDraft.value
    : defaultAiSessionModelSelection(modelGroups);
  const reasoningCapability = normalizeAiSessionReasoningEffortCapabilities(providerCapability);
  const effectiveReasoningEffort = reasoningCapability.selectAtCreate
    ? reasoningEffort ?? (agent === 'codex' ? AI_SESSION_DEFAULT_REASONING_EFFORT : undefined)
    : undefined;

  const guidance = instanceCreateGuidance(selectedInstance);
  useEffect(() => {
    const nodeId = selectedInstance?.nodeId;
    if (!nodeId) return;
    const abort = new AbortController();
    void mobileProfileStore.active().then(async (profile) => {
      if (!profile || abort.signal.aborted) return;
      const api = createMobileControlPlaneClient(profile, mobileSecureStore).api;
      const [nextFolders, source] = await Promise.all([
        api.resources.nodeLocalFolders(nodeId, abort.signal),
        api.resources.instanceWorkspaceSource(selectedInstanceId, abort.signal).catch(() => undefined),
      ]);
      if (abort.signal.aborted) return;
      const folderOptions = aiSessionFolderOptions(source, selectedInstance?.workspace.path, nextFolders, locale);
      const defaultFolderId = defaultAiSessionFolderId(source, selectedInstance?.workspace.path, nextFolders);
      const requestedFolderId = useRequestedDefaults && selectedInstanceId === requestedInstanceId
        ? initialAiSessionFolderId(folderOptions, {
          cwd: requestedCwd,
          cwdFolderId: requestedCwdFolderId,
          runtimeType: selectedInstance?.runtime.type,
          source,
          workspacePath: selectedInstance?.workspace.path,
        })
        : undefined;
      setFolderState({ nodeId, folders: folderOptions });
      setSelection((current) => {
        const sameInstance = current.instanceId === selectedInstanceId;
        const selectedFolderId = sameInstance && folderOptions.some((folder) => folder.id === current.folderId)
          ? current.folderId
          : requestedFolderId ?? defaultFolderId;
        return {
          instanceId: selectedInstanceId,
          agent: sameInstance ? current.agent : undefined,
          folderId: selectedFolderId,
        };
      });
    }).catch(() => {
      if (!abort.signal.aborted) setFolderState({ nodeId, folders: [] });
    });
    return () => abort.abort();
  }, [requestedCwd, requestedCwdFolderId, requestedInstanceId, selectedInstance?.nodeId, selectedInstance?.runtime.type, selectedInstance?.workspace.path, selectedInstanceId, useRequestedDefaults]);

  useEffect(() => {
    const abort = new AbortController();
    void mobileProfileStore.active().then(async (profile) => {
      if (!profile || abort.signal.aborted) return;
      const registry = await createMobileControlPlaneClient(profile, mobileSecureStore).api.resources.models(abort.signal);
      if (abort.signal.aborted) return;
      setModelEntities(registry.models.map((group) => ({ ...group.model, locations: group.locations })));
    }).catch(() => { if (!abort.signal.aborted) setModelEntities([]); });
    return () => abort.abort();
  }, [controlPlaneId]);

  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);
  useEffect(() => subscribeToWorktreeForeground(() => setWorkspaceRefreshToken((current) => current + 1)), []);
  useEffect(() => {
    if (!selectedInstanceId || !selectedCwdFolderId) return;
    const abort = new AbortController();
    void mobileProfileStore.active().then(async (profile) => {
      if (!profile || abort.signal.aborted) return;
      const client = createMobileControlPlaneClient(profile, mobileSecureStore).api;
      const [workspace, inheritedWorktreeId] = await Promise.all([
        loadWorktreeScope(
          { kind: 'session-workspace', instanceId: selectedInstanceId, cwdFolderId: selectedCwdFolderId },
          () => client.aiSessions.workspace(selectedInstanceId, selectedCwdFolderId, abort.signal),
        ),
        useRequestedDefaults && selectedInstanceId === requestedInstanceId
          ? inheritedStoryWorktreeId(client, selectedInstanceId, requestedWorktreeSessionId, abort.signal)
          : undefined,
      ]);
      if (abort.signal.aborted) return;
      setWorkspaceState(initialAiSessionWorkspaceState(selectedInstanceId, folderId, workspace, inheritedWorktreeId));
    }).catch(() => {
      // Compatibility for v0.0.21: an older Control Plane keeps the cwd-only creation flow.
      if (!abort.signal.aborted) setWorkspaceState({ instanceId: selectedInstanceId, folderId, mode: 'current-folder' });
    });
    return () => abort.abort();
  }, [selectedInstanceId, folderId, requestedInstanceId, requestedWorktreeSessionId, selectedCwdFolderId, useRequestedDefaults, workspaceRefreshToken]);

  const workspaceMatchesSelection = workspaceState.instanceId === selectedInstanceId && workspaceState.folderId === folderId;
  const workspaceLoading = Boolean(selectedInstanceId && folderId && !workspaceMatchesSelection);

  const gitSelection = aiSessionGitSelection(workspaceState, workspaceMatchesSelection);
  const workspaceSelection = aiSessionWorkspaceSelection(workspaceState, workspaceMatchesSelection);

  const confirmNewWorktree = async (selection: MobileNewWorktreeSelection) => {
    const workspace = workspaceState.workspace;
    if (!workspace?.snapshotId || !selectedInstance || creatingWorktree) return;
    setCreatingWorktree(true);
    try {
      const profile = await mobileProfileStore.active();
      if (!profile) throw new Error('No active Control Plane.');
      const client = createMobileControlPlaneClient(profile, mobileSecureStore).api;
      const outcome = await createWorkspaceWorktreeForSession({
        client,
        instanceId: selectedInstance.id,
        cwdFolderId: selectedFolder?.cwdFolderId,
        workspace,
        selection,
      });
      if (outcome.type === 'created') invalidateWorktreeInstance(selectedInstance.id);
      setWorkspaceState((current) => applyWorktreeCreationOutcome(current, outcome));
      setWorktreeDialogOpen(false);
    } catch (cause) {
      toast.show({ detail: cause instanceof Error ? cause.message : t('sessions.worktreeCreateFailed'), title: t('toast.actionFailed', { action: t('sessions.newWorktree') }), tone: 'error' });
    } finally {
      setCreatingWorktree(false);
    }
  };

  const create = async () => {
    if (!selectedInstance || !controlPlaneId || guidance || !selectedFolder) return;
    setBusy(true);
    try {
      const profile = await mobileProfileStore.active();
      if (!profile) throw new Error('No active Control Plane.');
      const requestInput = {
        agent,
        cwdFolderId: selectedFolder.cwdFolderId,
        gitSelection,
        workspaceSelection,
        message: aiSessionMessageText(message.trim()),
        permissionMode: permissionModes.includes(permissionMode) ? permissionMode : undefined,
        modelSelection,
        reasoningEffort: effectiveReasoningEffort,
        attachments: attachments.map(({ local }) => ({ kind: local.kind, name: local.name, size: local.size })),
      };
      const requestId = await mobileCreateRequestStore.getOrCreate(controlPlaneId, selectedInstance.id, requestInput, Crypto.randomUUID);
      const client = createMobileControlPlaneClient(profile, mobileSecureStore).api;
      const uploadedAttachments = await Promise.all(attachments.map(async (attachment) => attachment.uploaded?.phase === 'uploaded'
        ? attachment.uploaded
        : uploadMobileAttachment(client, { instanceId: selectedInstance.id, sessionId: requestId }, attachment.local, { maxFileAttachmentBytes })));
      setAttachments((current) => current.map((attachment) => {
        const index = attachments.findIndex((candidate) => candidate.id === attachment.id);
        return index >= 0 ? { ...attachment, uploaded: uploadedAttachments[index] } : attachment;
      }));
      const result = await createMobileAiSession(client, {
        instance: selectedInstance,
        agent,
        cwdFolderId: selectedFolder.cwdFolderId,
        gitSelection,
        workspaceSelection,
        message: aiSessionMessageText(message.trim()),
        attachments: usableUploadRefs(uploadedAttachments),
        permissionMode: permissionModes.includes(permissionMode) ? permissionMode : undefined,
        modelSelection,
        reasoningEffort: effectiveReasoningEffort,
        clientRequestId: requestId,
        storyId: typeof requestedStoryId === 'string' ? requestedStoryId : undefined,
      });
      if (permissionModes.includes(permissionMode)) await mobilePermissionStore.write(controlPlaneId, selectedInstance.id, result.aiSessionId, permissionMode).catch(() => undefined);
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
      const local = validateMobileLocalFile(selected, maxFileAttachmentBytes);
      setAttachments((current) => [...current, { id: Crypto.randomUUID(), local }]);
    } catch (cause) {
      toast.show({ detail: cause instanceof Error ? cause.message : 'Could not select attachment.', title: t('composer.addAttachment'), tone: 'error' });
    }
  };

  const pasteText = (text: string) => {
    try {
      if (attachments.length >= 6) throw new Error('You can attach at most 6 files.');
      const nextSequence = pastedTextSequence.current + 1;
      const local = validateMobileLocalFile(mobilePastedText(text, nextSequence, maxFileAttachmentBytes), maxFileAttachmentBytes);
      pastedTextSequence.current = nextSequence;
      setAttachments((current) => [...current, { id: Crypto.randomUUID(), local }]);
    } catch (cause) {
      toast.show({ detail: cause instanceof Error ? cause.message : 'Could not attach pasted text.', title: t('composer.addAttachment'), tone: 'error' });
    }
  };

  const pasteImages = (uris: string[]) => {
    try {
      const available = Math.max(0, 6 - attachments.length);
      if (uris.length > available) throw new Error('You can attach at most 6 files.');
      const pasted = uris.map((uri) => ({ id: Crypto.randomUUID(), local: validateMobileLocalFile(mobilePastedImage(uri), maxFileAttachmentBytes) }));
      setAttachments((current) => [...current, ...pasted]);
    } catch (cause) {
      for (const uri of uris) {
        try { new File(uri).delete(); } catch { /* The native wrapper owns only temporary paste files. */ }
      }
      toast.show({ detail: cause instanceof Error ? cause.message : 'Could not paste image.', title: t('composer.addAttachment'), tone: 'error' });
    }
  };

  const removeAttachment = (id: string) => {
    if (busy) return;
    setAttachments((current) => {
      const attachment = current.find((candidate) => candidate.id === id);
      if (attachment?.local.temporary && attachment.uploaded?.phase !== 'uploaded') {
        try { new File(attachment.local.uri).delete(); } catch { /* The picker cache may already be gone. */ }
      }
      return current.filter((candidate) => candidate.id !== id);
    });
  };

  const updatePermissionMode = async (next: AiSessionPermissionMode) => {
    if (!selectedInstance || !permissionModes.includes(next) || !controlPlaneId || savingPermission || next === permissionMode) return;
    const previous = permissionMode;
    setPermissionSelection({ instanceId: selectedInstance.id, mode: next });
    if (agent !== 'codex') return;
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

  const form = <NewSessionForm
    key={selectedInstance?.id || 'no-instance'}
    instances={state.instances}
    nodes={state.nodes}
    selectedInstance={selectedInstance}
    folders={folders}
    selectedInstanceId={selectedInstanceId}
    selectedAgent={agent}
    selectedFolderId={folderId}
    workspace={workspaceMatchesSelection ? workspaceState.workspace : undefined}
    workspaceMode={workspaceMatchesSelection ? workspaceState.mode : 'current-folder'}
    selectedBranch={workspaceMatchesSelection ? workspaceState.branch : undefined}
    selectedWorktree={workspaceMatchesSelection ? aiSessionWorkspaceSelectionValue(workspaceState) : undefined}
    selectedWorktreeLabel={workspaceMatchesSelection ? aiSessionWorkspaceSelectionLabel(workspaceState) : undefined}
    workspaceLoading={workspaceLoading}
    message={message}
    attachments={attachments.map(({ id, local }) => ({ id, kind: local.kind, name: local.name, size: local.size, textPresentation: local.textPresentation }))}
      permissionMode={permissionMode}
      permissionModes={permissionModes}
      modelGroups={modelGroups}
      modelSelection={modelSelection}
      reasoningEffort={effectiveReasoningEffort}
      reasoningEffortEnabled={reasoningCapability.selectAtCreate}
      onModelSelectionChange={(value) => setModelSelectionDraft({ instanceId: selectedInstanceId, agent, value })}
      onReasoningEffortChange={setReasoningEffort}
    busy={busy || savingPermission || workspaceLoading}
    disabled={busy || savingPermission || workspaceLoading || Boolean(guidance) || !agent || !selectedFolder || (!message.trim() && !attachments.length) || (workspaceState.mode === 'worktree' && !workspaceSelection)}
    error={guidance}
    visualBalanceInset={newSessionVisualBalanceInset(Platform.OS, insets.top)}
    onInstanceChange={(instanceId) => {
      const instance = state.instances.find((candidate) => candidate.id === instanceId);
      if (scope.kind === 'all') mobileSessionCreationInstanceStore.write(controlPlaneId, 'ai', instanceId);
      setUseRequestedDefaults(false);
      setReasoningEffort(undefined);
      setSelection({ instanceId, agent: instance?.availableAgents[0]?.id });
    }}
    onAgentChange={(nextAgent) => { setReasoningEffort(undefined); setSelection({ instanceId: selectedInstanceId, agent: nextAgent, folderId }); }}
    onFolderChange={(nextFolderId) => setSelection({ instanceId: selectedInstanceId, agent, folderId: nextFolderId })}
    onWorkspaceModeChange={(mode) => {
      setWorkspaceState((current) => switchAiSessionWorkspaceMode(current, mode));
    }}
    onBranchChange={(branch) => setWorkspaceState((current) => ({ ...current, branch }))}
    onWorktreeChange={(value) => setWorkspaceState((current) => selectAiSessionWorktree(current, value))}
    onNewWorktree={() => setWorktreeDialogOpen(true)}
    onMessageChange={setMessage}
    onAddImage={() => { void addAttachment('image'); }}
    onAddFile={() => { void addAttachment('file'); }}
    onPasteImages={pasteImages}
    onPasteText={pasteText}
    onRemoveAttachment={removeAttachment}
    onPermissionModeChange={(next) => { void updatePermissionMode(next); }}
    onCreate={() => { void create(); }}
  />;

  return <>{form}{workspaceMatchesSelection && workspaceState.workspace?.availability === 'available' ? <NewWorktreeDialog
    branches={workspaceState.workspace.branches}
    busy={creatingWorktree}
    confirmLabel={t('sessions.useNewWorktree')}
    defaultStartRef={workspaceState.workspace.currentBranch || 'HEAD'}
    description={t('sessions.newWorktreeDescription')}
    initialSelection={aiSessionWorkspaceDialogInitialSelection(workspaceState)}
    onCancel={() => setWorktreeDialogOpen(false)}
    onConfirm={(selection) => { void confirmNewWorktree(selection); }}
    title={t('sessions.newWorktree')}
    visible={worktreeDialogOpen}
  /> : null}</>;
}

/**
 * The Story composer inherits the worktree of the Story session it was opened from.
 * The session's own repository context is the authority for where it runs; a failure
 * is not fatal because the folder defaults still produce a usable composer.
 */
async function inheritedStoryWorktreeId(
  client: ReturnType<typeof createMobileControlPlaneClient>['api'],
  instanceId: string,
  sessionId: string | undefined,
  signal: AbortSignal,
) {
  if (!sessionId) return undefined;
  try {
    const context = await client.repository.context({ instanceId, sessionKind: 'ai-session', sessionId }, { signal });
    return context.currentWorktree?.id;
  } catch {
    return undefined;
  }
}

type NewSessionLocalAttachment = {
  id: string;
  local: MobileLocalFile & { mime: string; size: number };
  uploaded?: MobilePendingAttachment;
};
