import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import type { ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';

import { NewAppSessionForm } from '../../src/app-sessions/NewAppSessionForm';
import { appLaunchIssue, initialAppInstanceId } from '../../src/app-sessions/new-app-session-types';
import { mobileAppSessionStore } from '../../src/app-sessions/store';
import { createDirectControlPlaneClient } from '../../src/control-plane/client';
import { mobileProfileStore, mobileSecureStore } from '../../src/control-plane/runtime';
import { useActiveDirectories } from '../../src/directories/use-directories';
import { useI18n } from '../../src/i18n';
import { useMobileToast } from '../../src/components/MobileToast';

export default function NewAppSessionRoute() {
  const { t } = useI18n();
  const toast = useMobileToast();
  const { instanceId: requestedInstanceId } = useLocalSearchParams<{ instanceId?: string }>();
  const { controlPlaneId, state } = useActiveDirectories();
  const [selection, setSelection] = useState<{ instanceId?: string; appId?: string; folderId?: string }>({});
  const [folderState, setFolderState] = useState<{ nodeId: string; folders: ControlPlaneNodeLocalFolder[] }>({ nodeId: '', folders: [] });
  const [busy, setBusy] = useState(false);

  const selectedInstanceId = state.instances.some((instance) => instance.id === selection.instanceId)
    ? selection.instanceId!
    : initialAppInstanceId(state.instances, requestedInstanceId);
  const selectedInstance = state.instances.find((instance) => instance.id === selectedInstanceId);
  const selectedAppId = selectedInstance?.availableApps.some((app) => app.id === selection.appId)
    ? selection.appId!
    : selectedInstance?.availableApps[0]?.id ?? '';
  const selectedApp = selectedInstance?.availableApps.find((app) => app.id === selectedAppId);
  const issue = appLaunchIssue(selectedInstance);
  const guidance = issue ? t(issue === 'choose-instance'
    ? 'appSessions.chooseInstanceGuidance'
    : issue === 'instance-not-ready'
      ? 'appSessions.instanceNotReady'
      : 'appSessions.noApps') : undefined;

  useEffect(() => {
    const nodeId = selectedInstance?.runtime.type === 'local' && selectedApp?.supportsCwdSelection ? selectedInstance.nodeId : undefined;
    if (!nodeId) return;
    const abort = new AbortController();
    void mobileProfileStore.active().then(async (profile) => {
      if (!profile || abort.signal.aborted) return;
      const folders = await createDirectControlPlaneClient(profile, mobileSecureStore).api.resources.nodeLocalFolders(nodeId, abort.signal);
      if (!abort.signal.aborted) setFolderState({ nodeId, folders });
    }).catch(() => {
      if (!abort.signal.aborted) setFolderState({ nodeId, folders: [] });
    });
    return () => abort.abort();
  }, [selectedApp?.supportsCwdSelection, selectedInstance?.nodeId, selectedInstance?.runtime.type]);

  const create = async () => {
    if (!selectedInstance || !selectedAppId || !controlPlaneId || guidance) return;
    setBusy(true);
    try {
      const profile = await mobileProfileStore.active();
      if (!profile || profile.identity.controlPlaneId !== controlPlaneId) throw new Error('No active Control Plane.');
      const api = createDirectControlPlaneClient(profile, mobileSecureStore).api;
      const session = await api.appSessions.launch(selectedInstance.id, {
        appId: selectedAppId,
        ...(selection.folderId ? { cwdFolderId: selection.folderId } : {}),
      });
      const snapshot = await api.appSessions.refresh().catch(() => undefined);
      if (snapshot) mobileAppSessionStore.replaceSnapshot(controlPlaneId, snapshot);
      if (session.kind === 'tty' && session.status === 'running') {
        if (snapshot) router.replace({ pathname: '/app-sessions/[instanceId]/[sessionId]', params: { instanceId: selectedInstance.id, sessionId: session.id } });
        else router.back();
      } else {
        router.back();
      }
    } catch (cause) {
      toast.show({ detail: cause instanceof Error ? cause.message : t('appSessions.createError'), title: t('toast.actionFailed', { action: t('appSessions.create') }), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Stack.Screen options={{ title: t('nav.newAppSession') }} />
    <NewAppSessionForm
      instances={state.instances}
      selectedInstance={selectedInstance}
      selectedAppId={selectedAppId}
      folders={folderState.nodeId === selectedInstance?.nodeId ? folderState.folders : []}
      selectedFolderId={selection.instanceId === selectedInstanceId ? selection.folderId : undefined}
      busy={busy}
      disabled={busy || Boolean(guidance) || !selectedAppId}
      error={guidance}
      onInstanceChange={(instanceId) => {
        const instance = state.instances.find((candidate) => candidate.id === instanceId);
        setSelection({ instanceId, appId: instance?.availableApps[0]?.id });
      }}
      onAppChange={(appId) => setSelection({ instanceId: selectedInstanceId, appId })}
      onFolderChange={(folderId) => setSelection({ instanceId: selectedInstanceId, appId: selectedAppId, folderId })}
      onCreate={() => { void create(); }}
    />
  </>;
}
