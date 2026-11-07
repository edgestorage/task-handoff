import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import type { ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';

import { NewAppSessionForm } from '../../src/app-sessions/NewAppSessionForm';
import { appLaunchIssue, initialAppInstanceId, resolveAppLaunchSelection, type AppLaunchSelection } from '../../src/app-sessions/new-app-session-types';
import { mobileAppSessionStore } from '../../src/app-sessions/store';
import { createMobileControlPlaneClient } from '../../src/control-plane/client';
import { mobileProfileStore, mobileSecureStore } from '../../src/control-plane/runtime';
import { useActiveDirectories } from '../../src/directories/use-directories';
import { useI18n } from '../../src/i18n';
import { useMobileToast } from '../../src/components/MobileToast';
import { mobileBrowserCapability } from '../../src/control-plane/browser-context';
import { useMobileControlPlaneRuntime } from '../../src/control-plane/use-mobile-control-plane-runtime';
import { mobileBrowserController } from '../../src/browser/controller';
import { mobileSessionCreationInstanceStore, preferredSessionCreationInstanceId } from '../../src/session-creation/instance-selection';
import { useInstanceScope } from '../../src/instance-scope/use-instance-scope';

const EMBEDDED_BROWSER_APP_ID = 'embedded-browser';

export default function NewAppSessionRoute() {
  const { t } = useI18n();
  const toast = useMobileToast();
  const runtime = useMobileControlPlaneRuntime();
  const { instanceId: requestedInstanceId } = useLocalSearchParams<{ instanceId?: string }>();
  const { controlPlaneId, state } = useActiveDirectories();
  const { scope } = useInstanceScope();
  const [selection, setSelection] = useState<AppLaunchSelection>({});
  const [folderState, setFolderState] = useState<{ key: string; status: 'ready' | 'error'; folders: ControlPlaneNodeLocalFolder[] }>({ key: '', status: 'ready', folders: [] });
  const [folderAttempt, setFolderAttempt] = useState(0);
  const [browserCapability, setBrowserCapability] = useState<{ key: string; supported: boolean }>({ key: '', supported: false });
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  const preferredInstanceId = preferredSessionCreationInstanceId(
    state.instances,
    requestedInstanceId,
    mobileSessionCreationInstanceStore.read(controlPlaneId, 'app'),
  );
  const selectedInstanceId = selection.controlPlaneId === controlPlaneId && state.instances.some((instance) => instance.id === selection.instanceId)
    ? selection.instanceId!
    : initialAppInstanceId(state.instances, preferredInstanceId);
  const selectedInstance = state.instances.find((instance) => instance.id === selectedInstanceId);
  const browserCapabilityKey = runtime.profile && selectedInstance
    ? `${runtime.profile.identity.controlPlaneId}\u0000${selectedInstance.id}\u0000${JSON.stringify(selectedInstance.capabilities)}`
    : '';
  const browserSupported = browserCapability.key === browserCapabilityKey && browserCapability.supported;
  const appsLoading = Boolean(browserCapabilityKey) && browserCapability.key !== browserCapabilityKey;
  const availableApps = selectedInstance
    ? [
      ...(browserSupported ? [{ id: EMBEDDED_BROWSER_APP_ID, name: t('browser.embeddedBrowser'), kind: 'web' as const, supportsCwdSelection: false }] : []),
      ...selectedInstance.availableApps,
    ]
    : [];
  const { app: selectedApp } = resolveAppLaunchSelection(controlPlaneId, selectedInstance, availableApps, selection, []);
  const selectedAppId = selectedApp?.id ?? '';
  const folderNodeId = selectedInstance?.runtime.type === 'local' && selectedApp?.supportsCwdSelection ? selectedInstance.nodeId : undefined;
  const folderKey = folderNodeId ? JSON.stringify([controlPlaneId, folderNodeId, folderAttempt]) : '';
  const foldersLoading = Boolean(folderKey) && folderState.key !== folderKey;
  const foldersError = Boolean(folderKey) && folderState.key === folderKey && folderState.status === 'error';
  const folders = folderState.key === folderKey ? folderState.folders : [];
  const { folderId: selectedFolderId } = resolveAppLaunchSelection(controlPlaneId, selectedInstance, availableApps, selection, folders);
  const awaitingSelectedFolder = foldersLoading && selection.controlPlaneId === controlPlaneId && selection.instanceId === selectedInstanceId && selection.appId === selectedAppId && Boolean(selection.folderId);
  const issue = appLaunchIssue(selectedInstance);
  const effectiveIssue = issue === 'no-apps' && (browserSupported || appsLoading) ? undefined : issue;
  const guidance = effectiveIssue ? t(effectiveIssue === 'choose-instance'
    ? 'appSessions.chooseInstanceGuidance'
    : effectiveIssue === 'instance-not-ready'
      ? 'appSessions.instanceNotReady'
      : 'appSessions.noApps') : undefined;

  useEffect(() => {
    let live = true;
    if (!selectedInstance || !runtime.profile || !browserCapabilityKey) return () => { live = false; };
    void mobileBrowserCapability(runtime.profile, selectedInstance.capabilities, runtime.api)
      .then((capability) => { if (live) setBrowserCapability({ key: browserCapabilityKey, supported: capability.supported }); })
      .catch(() => { if (live) setBrowserCapability({ key: browserCapabilityKey, supported: false }); });
    return () => { live = false; };
  }, [browserCapabilityKey, runtime.profile, runtime.api, selectedInstance]);

  useEffect(() => {
    if (!folderNodeId || !runtime.api || runtime.controlPlaneId !== controlPlaneId) return;
    const abort = new AbortController();
    void runtime.api.resources.nodeLocalFolders(folderNodeId, abort.signal).then((folders) => {
      if (!abort.signal.aborted) setFolderState({ key: folderKey, status: 'ready', folders });
    }).catch(() => {
      if (!abort.signal.aborted) setFolderState({ key: folderKey, status: 'error', folders: [] });
    });
    return () => abort.abort();
  }, [controlPlaneId, folderKey, folderNodeId, runtime.api, runtime.controlPlaneId]);

  const create = async () => {
    if (submitting.current || !selectedInstance || !selectedAppId || !controlPlaneId || guidance || awaitingSelectedFolder) return;
    submitting.current = true;
    setBusy(true);
    try {
      const profile = await mobileProfileStore.active();
      if (!profile || profile.identity.controlPlaneId !== controlPlaneId) throw new Error('No active Control Plane.');
      const api = createMobileControlPlaneClient(profile, mobileSecureStore).api;
      if (selectedAppId === EMBEDDED_BROWSER_APP_ID) {
        const tab = await mobileBrowserController.create({ api, profile, instanceId: selectedInstance.id });
        router.replace(`/browser/${encodeURIComponent(tab.instanceId)}/${encodeURIComponent(tab.id)}` as Href);
        return;
      }
      const session = await api.appSessions.launch(selectedInstance.id, {
        appId: selectedAppId,
        ...(selectedFolderId ? { cwdFolderId: selectedFolderId } : {}),
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
      submitting.current = false;
      setBusy(false);
    }
  };

  return <>
    <NewAppSessionForm
      instances={state.instances}
      nodes={state.nodes}
      selectedInstance={selectedInstance}
      apps={availableApps}
      selectedAppId={selectedAppId}
      appsLoading={appsLoading}
      folders={folders}
      foldersLoading={foldersLoading}
      foldersError={foldersError}
      selectedFolderId={selectedFolderId}
      busy={busy}
      disabled={busy || Boolean(guidance) || !selectedAppId || awaitingSelectedFolder}
      error={guidance}
      onInstanceChange={(instanceId) => {
        if (submitting.current || instanceId === selectedInstanceId) return;
        const instance = state.instances.find((candidate) => candidate.id === instanceId);
        if (scope.kind === 'all') mobileSessionCreationInstanceStore.write(controlPlaneId, 'app', instanceId);
        setSelection({ controlPlaneId, instanceId, appId: instance?.availableApps[0]?.id });
      }}
      onAppChange={(appId) => { if (!submitting.current && appId !== selectedAppId) setSelection({ controlPlaneId, instanceId: selectedInstanceId, appId }); }}
      onFolderChange={(folderId) => { if (!submitting.current) setSelection({ controlPlaneId, instanceId: selectedInstanceId, appId: selectedAppId, folderId }); }}
      onRetryFolders={() => { if (!submitting.current) setFolderAttempt((value) => value + 1); }}
      onCreate={() => { void create(); }}
    />
  </>;
}
