import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';
import type { ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';

import { NewSessionForm, newSessionVisualBalanceInset } from '../../src/ai-sessions/NewSessionForm';
import { initialInstanceId, instanceCreateGuidance } from '../../src/ai-sessions/new-session-types';
import { createMobileAiSession, lifecycleGuidance } from '../../src/ai-sessions/session-lifecycle';
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
  const [busy, setBusy] = useState(false);

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

  const create = async () => {
    if (!selectedInstance || !controlPlaneId || guidance) return;
    setBusy(true);
    try {
      const profile = await mobileProfileStore.active();
      if (!profile) throw new Error('No active Control Plane.');
      const requestInput = { agent, cwdFolderId: folderId, message, permissionMode };
      const requestId = await mobileCreateRequestStore.getOrCreate(controlPlaneId, selectedInstance.id, requestInput, Crypto.randomUUID);
      const result = await createMobileAiSession(createMobileControlPlaneClient(profile, mobileSecureStore).api, {
        instance: selectedInstance,
        agent,
        cwdFolderId: folderId,
        message,
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
    message={message}
    permissionMode={permissionMode}
    busy={busy || savingPermission}
    disabled={busy || savingPermission || Boolean(guidance) || !agent || !message.trim()}
    error={guidance}
    visualBalanceInset={newSessionVisualBalanceInset(Platform.OS, insets.top)}
    onInstanceChange={(instanceId) => {
      const instance = state.instances.find((candidate) => candidate.id === instanceId);
      setSelection({ instanceId, agent: instance?.availableAgents[0]?.id });
    }}
    onAgentChange={(nextAgent) => setSelection({ instanceId: selectedInstanceId, agent: nextAgent, folderId })}
    onFolderChange={(nextFolderId) => setSelection({ instanceId: selectedInstanceId, agent, folderId: nextFolderId })}
    onMessageChange={setMessage}
    onPermissionModeChange={(next) => { void updatePermissionMode(next); }}
    onCreate={() => { void create(); }}
  />;
}
