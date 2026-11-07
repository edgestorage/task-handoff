import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Stack, useNavigation, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { AccessibilityInfo, Alert, findNodeHandle, Platform, Pressable, StyleSheet, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { MenuView, type MenuAction } from '../components/MenuView';

import { clearRepositoryViewProfile } from '../repository/view-memory';
import { SessionResourceLayout } from './SessionResourceLayout';
import { SessionResourcePanel } from './SessionResourcePanel';
import { mobileResourceWorkspaceStore, resourceContextKey } from './resource-workspace-model';
import { SessionWorkspace } from './SessionWorkspace';
import type { SessionDetailMode } from './SessionDetail';
import { workspaceLabel } from './InboxModel';
import { mobileAiSessionBusyKey } from './actions';
import { useActiveAiSessionView, useActiveAiSessionsRuntime } from './use-active-sessions';
import { openEmbeddedWebBrowserLink } from '../browser/link-opener';
import { mobileDraftStore, mobilePermissionStore, mobileProfileStore, mobileSecureStore } from '../control-plane/runtime';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import { browserTabDetailSelection } from '../master-detail/selection';
import { useMobileTheme } from '../components/theme';
import { Icon } from '../components/Icon';
import { SessionRenameModal } from '../components/SessionRenameModal';
import { useI18n } from '../i18n';
import { useTaskStatusSettings } from '../task-status/settings';
import { useActiveTriggers } from '../triggers/use-active-triggers';
import { deriveAiSessionModelGroups, type AiSessionCatalogModelEntity } from '@task-handoff/control-plane-client';
import { directoryAiSessionProviderCapability } from '@task-handoff/protocol/control-plane-directory';
import { createMobileControlPlaneClient } from '../control-plane/client';
import { PaneHeaderRestore } from '../master-detail/use-pane-header-restore';

export function AiSessionDetailScreen({
  instanceId,
  embeddedHeader = false,
  onClosed,
  onOpenSession,
  pane = false,
  sessionId,
}: {
  instanceId: string;
  embeddedHeader?: boolean;
  onClosed?(): void;
  onOpenSession?(instanceId: string, sessionId: string): void;
  pane?: boolean;
  sessionId: string;
}) {
  const router = useRouter();
  const navigation = useNavigation();
  const { actions, client, controlPlaneId, refresh } = useActiveAiSessionsRuntime();
  const runtime = useMobileControlPlaneRuntime();
  const directories = useActiveDirectories();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const contextKey = resourceContextKey(controlPlaneId || '', instanceId, sessionId);
  const resourceState = useSyncExternalStore(
    useCallback((listener) => mobileResourceWorkspaceStore.subscribe(contextKey, listener), [contextKey]),
    useCallback(() => mobileResourceWorkspaceStore.snapshot(contextKey), [contextKey]),
  );
  useLayoutEffect(() => mobileResourceWorkspaceStore.enterContext(contextKey), [contextKey]);
  const resourceExpanded = Boolean(resourceState.expanded && mobileResourceWorkspaceStore.isCurrentContext(contextKey));
  const fullscreen = Boolean(resourceState.fullscreen);
  const fraction = resourceState.fraction ?? 0.4;
  const resourceButton = useRef<View>(null);
  const headerHeight = useHeaderHeight();
  const previousProfile = useRef(controlPlaneId);
  useEffect(() => {
    if (previousProfile.current && previousProfile.current !== controlPlaneId) {
      mobileResourceWorkspaceStore.clearProfile(previousProfile.current);
      clearRepositoryViewProfile(previousProfile.current);
    }
    previousProfile.current = controlPlaneId;
  }, [controlPlaneId]);
  const setFullscreen = useCallback((value: boolean) => {
    mobileResourceWorkspaceStore.update(contextKey, { ...mobileResourceWorkspaceStore.snapshot(contextKey), fullscreen: value });
  }, [contextKey]);
  const closeResources = useCallback(() => {
    mobileResourceWorkspaceStore.update(contextKey, { ...mobileResourceWorkspaceStore.snapshot(contextKey), expanded: false, fullscreen: false });
    requestAnimationFrame(() => {
      const node = findNodeHandle(resourceButton.current);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    });
  }, [contextKey]);
  const changeFraction = useCallback((value: number | ((current: number) => number)) => {
    const current = mobileResourceWorkspaceStore.snapshot(contextKey);
    const next = typeof value === 'function' ? value(current.fraction ?? 0.4) : value;
    mobileResourceWorkspaceStore.update(contextKey, { ...current, fraction: Math.max(0.25, Math.min(0.75, next)) });
  }, [contextKey]);
  const taskStatus = useTaskStatusSettings();
  const triggers = useActiveTriggers();
  const sessionView = useActiveAiSessionView(controlPlaneId, instanceId, sessionId);
  const session = sessionView.session;
  const messages = sessionView.messages;
  const loadError = sessionView.readError && (
    !session
    || (sessionView.readError.kind === 'turns' && (session.turnCount ?? 0) > 0 && !session.turns?.length)
  ) ? sessionView.readError.message : undefined;
  const instance = directories.controlPlaneId === controlPlaneId
    ? directories.state.instances.find((candidate) => candidate.id === instanceId)
    : undefined;
  const [detailMode, setDetailMode] = useState<SessionDetailMode>('turn');
  const [closing, setClosing] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const renameRequestId = useRef('');
  const [modelEntities, setModelEntities] = useState<AiSessionCatalogModelEntity[]>([]);
  const defaultPermissionMode = instance?.config.defaultCodexPermissionMode;
  const markVisible = useCallback(() => {
    if (!client || !controlPlaneId || !session?.unread) return;
    void client.aiSessions.markRead(instanceId, sessionId).catch(() => undefined);
  }, [client, controlPlaneId, instanceId, session?.unread, sessionId]);
  const title = session?.title || session?.agent || 'AI Session';
  const openBuiltinBrowser = useCallback(async (url: string) => {
    const target = await openEmbeddedWebBrowserLink({
      api: runtime.api,
      capabilities: instance?.capabilities,
      profile: runtime.profile,
      instanceId,
      url,
    });
    if (target.kind === 'app-browser' || !runtime.profile) return;
    browserTabDetailSelection.set({
      browserTabId: target.tabId,
      controlPlaneId: runtime.controlPlaneId || runtime.profile.identity.controlPlaneId,
      instanceId,
    });
    router.push({
      pathname: '/browser/[instanceId]/[browserTabId]',
      params: { browserTabId: target.tabId, instanceId },
    });
  }, [instance?.capabilities, instanceId, router, runtime.api, runtime.controlPlaneId, runtime.profile]);
  const workspaceName = workspaceLabel(session?.cwd, t);
  const instanceName = instance?.name || instanceId;
  const trackedSession = taskStatus.trackedSession;
  const trackedHere = Boolean(trackedSession
    && trackedSession.controlPlaneId === controlPlaneId
    && trackedSession.instanceId === instanceId
    && trackedSession.sessionId === sessionId);
  const canTrack = session?.status === 'running' || session?.status === 'waiting';
  const canRename = session?.actions?.rename === true;
  const modelGroups = instance && session ? deriveAiSessionModelGroups({
    entities: modelEntities,
    assignment: instance.modelSelection,
    agent: session.agent,
    nodeId: instance.nodeId,
    mode: 'existing',
    currentSelection: session.modelSelection,
    capability: directoryAiSessionProviderCapability(instance.capabilities, session.agent)?.modelSelection,
  }) : [];
  useEffect(() => {
    const abort = new AbortController();
    void mobileProfileStore.active().then(async (profile) => {
      if (!profile || abort.signal.aborted) return;
      const registry = await createMobileControlPlaneClient(profile, mobileSecureStore).api.resources.models(abort.signal);
      if (!abort.signal.aborted) setModelEntities(registry.models.map((group) => ({ ...group.model, locations: group.locations })));
    }).catch(() => { if (!abort.signal.aborted) setModelEntities([]); });
    return () => abort.abort();
  }, [controlPlaneId]);
  const liveActivityAction: MenuAction | undefined = taskStatus.available && taskStatus.loaded && !taskStatus.autoStart ? {
    id: 'live-activity',
    image: trackedHere ? 'waveform.slash' : 'waveform',
    title: trackedHere ? t('liveActivity.stop') : t('liveActivity.start'),
    attributes: { disabled: !trackedHere && (!canTrack || !controlPlaneId) },
  } : undefined;
  const closeSession = () => Alert.alert(t('sessions.closeConfirmTitle', { name: title }), t('sessions.closeConfirmDescription'), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('sessions.closeSession'), style: 'destructive', onPress: () => {
      if (!actions || !controlPlaneId) return;
      setClosing(true);
      void actions.close(instanceId, sessionId, Crypto.randomUUID()).then((result) => {
        if (result.disposition === 'accepted') {
          if (onClosed) onClosed();
          else router.back();
          return;
        }
        const actionState = actions.state(mobileAiSessionBusyKey(controlPlaneId, instanceId, sessionId, 'close'));
        Alert.alert(t('sessions.closeFailed'), actionState.error);
      }).finally(() => setClosing(false));
    } },
  ]);
  const openRename = () => {
    if (!canRename) return;
    renameRequestId.current = Crypto.randomUUID();
    setRenameError('');
    setRenameOpen(true);
  };
  const submitRename = (nextTitle: string) => {
    if (!actions || !session || !canRename || renaming) return;
    setRenaming(true);
    setRenameError('');
    void actions.rename(instanceId, sessionId, {
      title: nextTitle,
      expectedTitle: session.title?.trim() || '',
      clientRequestId: renameRequestId.current,
    }).then((result) => {
      if (result.disposition === 'accepted') {
        setRenameOpen(false);
        return;
      }
      setRenameError(result.disposition === 'duplicate-blocked' ? t('sessions.renameBusy') : result.error);
    }).finally(() => setRenaming(false));
  };
  const menu = <MenuView
    actions={[
      { id: 'view-turn', image: 'rectangle.stack', state: detailMode === 'turn' ? 'on' : 'off', title: t('sessions.compact') },
      { id: 'view-conversation', image: 'text.bubble', state: detailMode === 'conversation' ? 'on' : 'off', title: t('sessions.conversation') },
      ...(canRename ? [{ id: 'rename', image: 'pencil', title: renaming ? t('sessions.renaming') : t('sessions.rename'), attributes: { disabled: renaming || !actions || sessionView.syncPhase !== 'ready' } } as MenuAction] : []),
      ...(liveActivityAction ? [liveActivityAction] : []),
      ...(triggers.available ? [{ id: 'triggers', image: 'bolt', title: t('triggers.sessionTitle') } as MenuAction] : []),
      { id: 'close', image: 'xmark.circle', title: closing ? t('sessions.closing') : t('sessions.closeSession'), attributes: { destructive: true, disabled: closing || !actions || sessionView.syncPhase !== 'ready' } },
    ]}
    onPressAction={({ nativeEvent }) => {
      if (nativeEvent.event === 'view-turn') setDetailMode('turn');
      else if (nativeEvent.event === 'view-conversation') setDetailMode('conversation');
      else if (nativeEvent.event === 'rename') openRename();
      else if (nativeEvent.event === 'live-activity') {
        if (trackedHere) void taskStatus.stopTracking();
        else if (controlPlaneId) void taskStatus.startTracking({ controlPlaneId, instanceId, sessionId });
      }
      else if (nativeEvent.event === 'triggers') router.push({ pathname: '/sessions/[instanceId]/[sessionId]/triggers' as never, params: { instanceId, sessionId } });
      else if (nativeEvent.event === 'close') closeSession();
    }}
    title={t('sessions.sessionView')}
  >
    <Pressable accessibilityLabel={t('sessions.moreActions')} accessibilityRole="button" hitSlop={10} style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}>
      <Icon color={colors.primary} name="ellipsis-horizontal" size={23} />
    </Pressable>
  </MenuView>;
  const headerActions = <View style={styles.headerActions}>
    <Pressable ref={resourceButton} accessibilityRole="button" accessibilityLabel={t(resourceExpanded ? 'sessionResources.collapse' : 'sessionResources.expand')}
      accessibilityState={{ expanded: resourceExpanded }} onPress={() => {
        if (resourceExpanded) closeResources();
        else mobileResourceWorkspaceStore.update(contextKey, { ...mobileResourceWorkspaceStore.snapshot(contextKey), expanded: true });
      }} style={({ pressed }) => [styles.resourceButton, resourceExpanded && { backgroundColor: colors.primarySoft }, pressed && styles.menuButtonPressed]} testID="session-resource-toggle">
      <Icon color={colors.primary} name="albums-outline" size={22} />
    </Pressable>{menu}
  </View>;
  const menuRef = useRef<ReactNode>(headerActions);
  useLayoutEffect(() => { menuRef.current = headerActions; });
  const embeddedHeaderRight = useCallback(() => menuRef.current, []);
  const headerMenuKey = [
    resourceExpanded,
    contextKey,
    detailMode,
    canRename,
    renaming,
    Boolean(actions),
    sessionView.syncPhase,
    liveActivityAction?.id,
    liveActivityAction?.title,
    trackedHere,
    triggers.available,
    closing,
  ].join('|');
  useLayoutEffect(() => {
    if (!embeddedHeader) return;
    navigation.setOptions({ headerRight: embeddedHeaderRight, title });
  }, [embeddedHeader, embeddedHeaderRight, headerMenuKey, navigation, title]);
  const workspace = <SessionWorkspace
    actions={actions}
    controlPlaneId={controlPlaneId || '__booting__'}
    client={client}
    refresh={refresh}
    drafts={mobileDraftStore}
    permissions={mobilePermissionStore}
    defaultPermissionMode={defaultPermissionMode}
    maxFileAttachmentBytes={instance?.config.aiSessionMaxFileAttachmentBytes}
    modelGroups={modelGroups}
    detailMode={detailMode}
    instanceId={instanceId}
    instanceName={instanceName}
    instanceCapabilities={instance?.capabilities}
    messages={messages}
    nodeId={instance?.nodeId}
    onVisible={markVisible}
    onOpenBuiltinBrowser={openBuiltinBrowser}
    onOpenSession={(nextSessionId) => {
      if (onOpenSession) onOpenSession(instanceId, nextSessionId);
      else router.push({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId, sessionId: nextSessionId } });
    }}
    onDetailModeChange={setDetailMode}
    loadError={loadError}
    onRetryLoad={sessionView.retryReads}
    session={session}
    syncPhase={sessionView.syncPhase}
    timelines={sessionView.timelines}
    workspaceName={workspaceName}
  />;
  return <>
    {embeddedHeader ? null : <Stack.Screen options={pane ? { headerRight: () => headerActions } : { title, headerRight: () => headerActions }} />}
    {embeddedHeader ? null : <PaneHeaderRestore pane={pane} />}
    <SessionResourceLayout topInset={embeddedHeader && Platform.OS === 'ios' ? headerHeight : 0} expanded={resourceExpanded} fullscreen={fullscreen} fraction={fraction} onClose={closeResources} onFractionChange={changeFraction}
      panel={<SessionResourcePanel key={contextKey} contextKey={contextKey} controlPlaneId={controlPlaneId || ''} expanded={resourceExpanded} fullscreen={fullscreen}
        instance={instance} instanceId={instanceId} sessionId={sessionId} session={session} syncReady={sessionView.syncPhase === 'ready'}
        onClose={closeResources} onFullscreenChange={setFullscreen} onFractionChange={changeFraction} />}
    >{workspace}</SessionResourceLayout>
    <SessionRenameModal
      busy={renaming}
      error={renameError}
      initialTitle={title}
      onClose={() => { if (!renaming) setRenameOpen(false); }}
      onSubmit={submitRename}
      open={renameOpen}
    />
  </>;
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  resourceButton: { alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 10 },
  menuButton: { alignItems: 'center', height: 34, justifyContent: 'center', width: 34 },
  menuButtonPressed: { opacity: 0.65 },
});
