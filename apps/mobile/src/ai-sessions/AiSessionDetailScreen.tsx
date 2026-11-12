import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Stack, useNavigation, useRouter, type NativeStackHeaderItem, type NativeStackHeaderItemButton } from 'expo-router';
import { useHeaderHeight, useIsFocused } from 'expo-router/react-navigation';
import { AccessibilityInfo, Alert, findNodeHandle, Platform, Pressable, StyleSheet, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { MenuView } from '../components/MenuView';

import { clearRepositoryViewProfile } from '../repository/view-memory';
import { SessionResourceLayout } from './SessionResourceLayout';
import { SessionResourcePanel } from './SessionResourcePanel';
import { mobileResourceWorkspaceStore, openRepositoryFileResource, resourceContextKey, sessionResourceTopInset } from './resource-workspace-model';
import { SessionWorkspace } from './SessionWorkspace';
import { latestAiSessionMessage, sessionActivityText, type SessionDetailMode } from './SessionDetail';
import { getAiSessionViewPreferences, subscribeAiSessionViewPreferences, updateAiSessionViewPreferences } from './session-view-preferences';
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
import { directoryAiSessionProviderCapability, directoryRemoteDesktopCapabilities } from '@task-handoff/protocol/control-plane-directory';
import { createMobileControlPlaneClient } from '../control-plane/client';
import { PaneHeaderRestore } from '../master-detail/use-pane-header-restore';
import { closeRemoteDesktopControllersForSession } from '../remote-desktop/controller-registry';
import { SessionRemoteDesktopFloatingPreview } from '../remote-desktop/SessionRemoteDesktopFloatingPreview';
import { SessionRemoteDesktopInlinePreview } from '../remote-desktop/SessionRemoteDesktopInlinePreview';
import { useSessionPreviewPresentation } from '../remote-desktop/session-preview-presentation';
import { removeSessionRemoteDesktopLink, useSessionRemoteDesktopLink } from '../remote-desktop/session-links';
import { floatingSessionMenuActions, nativeSessionMenuItems, type SessionMenuAction, type SessionMenuGroup, type SessionMenuItem } from './session-menu-model';

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
  const screenFocused = useIsFocused();
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
  const closeResources = useCallback(() => {
    mobileResourceWorkspaceStore.update(contextKey, { ...mobileResourceWorkspaceStore.snapshot(contextKey), expanded: false });
    requestAnimationFrame(() => {
      const node = findNodeHandle(resourceButton.current);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    });
  }, [contextKey]);
  const toggleResources = useCallback(() => {
    if (resourceExpanded) closeResources();
    else mobileResourceWorkspaceStore.update(contextKey, { ...mobileResourceWorkspaceStore.snapshot(contextKey), expanded: true });
  }, [closeResources, contextKey, resourceExpanded]);
  const openFileInResources = useCallback((href: string) => {
    const current = mobileResourceWorkspaceStore.snapshot(contextKey);
    mobileResourceWorkspaceStore.update(contextKey, openRepositoryFileResource(current, href));
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
  const sessionViewPreferences = useSyncExternalStore(
    subscribeAiSessionViewPreferences,
    getAiSessionViewPreferences,
    getAiSessionViewPreferences,
  );
  const detailMode = sessionViewPreferences.detailMode;
  const setDetailMode = useCallback((next: SessionDetailMode) => updateAiSessionViewPreferences({ detailMode: next }), []);
  const [closing, setClosing] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameRequestId, setRenameRequestId] = useState(() => Crypto.randomUUID());
  const [remoteDesktopPreview, setRemoteDesktopPreview] = useState({ open: false, sessionId });
  const sessionPreviewPresentation = useSessionPreviewPresentation();
  const remoteDesktopPreviewOpen = remoteDesktopPreview.open
    && remoteDesktopPreview.sessionId === sessionId
    && sessionPreviewPresentation === 'floating';
  const [modelEntities, setModelEntities] = useState<AiSessionCatalogModelEntity[]>([]);
  const defaultPermissionMode = instance?.config.defaultCodexPermissionMode;
  const remoteDesktopLink = useSessionRemoteDesktopLink(controlPlaneId, instanceId, sessionId);
  // iOS 26+ defaults to content-wide back swipes, which compete with preview
  // dragging. While the preview is visible, keep only the native edge swipe.
  const fullScreenGestureEnabled = screenFocused && remoteDesktopLink && remoteDesktopPreviewOpen ? false : undefined;
  const remoteDesktopAvailable = directoryRemoteDesktopCapabilities(instance?.capabilities)?.available !== false;
  const openRemoteDesktopDetails = useCallback(() => {
    router.push({
      pathname: '/remote-desktop/[instanceId]' as never,
      params: { instanceId, origin: 'session-card', sessionId },
    });
  }, [instanceId, router, sessionId]);
  const removeRemoteDesktopFromSession = useCallback(() => {
    setRemoteDesktopPreview({ open: false, sessionId });
    removeSessionRemoteDesktopLink(controlPlaneId, instanceId, sessionId);
    closeRemoteDesktopControllersForSession(controlPlaneId, instanceId, sessionId);
  }, [controlPlaneId, instanceId, sessionId, setRemoteDesktopPreview]);
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
  const closeSession = () => Alert.alert(t('sessions.closeConfirmTitle', { name: title }), t('sessions.closeConfirmDescription'), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('sessions.closeSession'), style: 'destructive', onPress: () => {
      if (!actions || !controlPlaneId) return;
      setClosing(true);
      void actions.close(instanceId, sessionId, Crypto.randomUUID()).then((result) => {
        if (result.disposition === 'accepted') {
          removeSessionRemoteDesktopLink(controlPlaneId, instanceId, sessionId);
          closeRemoteDesktopControllersForSession(controlPlaneId, instanceId, sessionId);
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
    setRenameRequestId(Crypto.randomUUID());
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
      clientRequestId: renameRequestId,
    }).then((result) => {
      if (result.disposition === 'accepted') {
        setRenameOpen(false);
        return;
      }
      setRenameError(result.disposition === 'duplicate-blocked' ? t('sessions.renameBusy') : result.error);
    }).finally(() => setRenaming(false));
  };
  const handleMenuEvent = (event: string) => {
    if (event === 'view-turn') setDetailMode('turn');
    else if (event === 'view-conversation') setDetailMode('conversation');
    else if (event === 'rename') openRename();
    else if (event === 'live-activity') {
      if (trackedHere) void taskStatus.stopTracking();
      else if (controlPlaneId) void taskStatus.startTracking({ controlPlaneId, instanceId, sessionId });
    }
    else if (event === 'triggers') router.push({ pathname: '/sessions/[instanceId]/[sessionId]/triggers' as never, params: { instanceId, sessionId } });
    else if (event === 'remote-desktop') router.push({
      pathname: '/remote-desktop/[instanceId]' as never,
      params: { instanceId, origin: 'session-menu', sessionId },
    });
    else if (event === 'close') closeSession();
  };
  const liveActivityEnabled = taskStatus.available && taskStatus.loaded && !taskStatus.autoStart;
  const manageSessionActions: SessionMenuAction[] = [
    ...(canRename ? [{
      id: 'rename',
      label: renaming ? t('sessions.renaming') : t('sessions.rename'),
      symbol: 'pencil',
      disabled: renaming || !actions || sessionView.syncPhase !== 'ready',
      onPress: () => handleMenuEvent('rename'),
    } satisfies SessionMenuAction] : []),
    ...(liveActivityEnabled ? [{
      id: 'live-activity',
      label: trackedHere ? t('liveActivity.stop') : t('liveActivity.start'),
      symbol: trackedHere ? 'waveform.slash' : 'waveform',
      selected: trackedHere,
      disabled: !trackedHere && (!canTrack || !controlPlaneId),
      onPress: () => handleMenuEvent('live-activity'),
    } satisfies SessionMenuAction] : []),
    ...(triggers.available ? [{
      id: 'triggers',
      label: t('triggers.sessionTitle'),
      symbol: 'bolt',
      onPress: () => handleMenuEvent('triggers'),
    } satisfies SessionMenuAction] : []),
  ];
  const sessionViewGroup: SessionMenuGroup = {
    id: 'session-view',
    label: t('sessions.sessionView'),
    actions: [
      { id: 'view-turn', label: t('sessions.compact'), symbol: 'rectangle.stack', selected: detailMode === 'turn', onPress: () => handleMenuEvent('view-turn') },
      { id: 'view-conversation', label: t('sessions.conversation'), symbol: 'text.bubble', selected: detailMode === 'conversation', onPress: () => handleMenuEvent('view-conversation') },
    ],
  };
  const remoteDesktopAction: SessionMenuAction = {
    id: 'remote-desktop',
    label: t('remoteDesktop.open'),
    symbol: 'display',
    disabled: !controlPlaneId || !remoteDesktopAvailable,
    onPress: () => handleMenuEvent('remote-desktop'),
  };
  const sessionMenuItems: SessionMenuItem[] = [
    { type: 'group', group: sessionViewGroup },
    { type: 'action', action: remoteDesktopAction },
    ...(manageSessionActions.length ? [{
      type: 'group' as const,
      group: {
        id: 'session-actions',
        label: t('sessions.sessionActions'),
        actions: manageSessionActions,
      },
    }] : []),
  ];
  const closeSessionAction: SessionMenuAction = {
    id: 'close',
    label: closing ? t('sessions.closing') : t('sessions.closeSession'),
    symbol: 'xmark.circle',
    destructive: true,
    disabled: closing || !actions || sessionView.syncPhase !== 'ready',
    onPress: () => handleMenuEvent('close'),
  };
  const menuActions = floatingSessionMenuActions(sessionMenuItems, [closeSessionAction]);
  const menu = <MenuView
    actions={menuActions}
    onPressAction={({ nativeEvent }) => handleMenuEvent(nativeEvent.event)}
    title={t('sessions.moreActions')}
  >
    <Pressable accessibilityLabel={t('sessions.moreActions')} accessibilityRole="button" hitSlop={10} style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}>
      <Icon color={colors.primary} name="ellipsis-horizontal" size={23} />
    </Pressable>
  </MenuView>;
  const nativeMenuActions = nativeSessionMenuItems(sessionMenuItems, [closeSessionAction]);
  const resourceIconSize = 20;
  const resourceSymbolPointSize = 18;
  const nativeHeaderRightItems = () => [
    {
      accessibilityLabel: t(resourceExpanded ? 'sessionResources.collapse' : 'sessionResources.expand'),
      icon: { name: 'rectangle.stack', pointSize: resourceSymbolPointSize, type: 'sfSymbol' as const } as NativeStackHeaderItemButton['icon'],
      identifier: 'session-resources',
      label: t('sessionResources.title'),
      onPress: toggleResources,
      selected: resourceExpanded,
      sharesBackground: false,
      tintColor: colors.primary,
      type: 'button' as const,
    },
    {
      accessibilityLabel: t('sessions.moreActions'),
      icon: { name: 'ellipsis', type: 'sfSymbol' as const },
      identifier: 'session-actions',
      label: t('sessions.moreActions'),
      sharesBackground: false,
      tintColor: colors.primary,
      type: 'menu' as const,
      menu: { title: t('sessions.moreActions'), items: nativeMenuActions },
    },
  ] satisfies NativeStackHeaderItem[];
  const nativeHeaderRightItemsRef = useRef(nativeHeaderRightItems);
  useLayoutEffect(() => { nativeHeaderRightItemsRef.current = nativeHeaderRightItems; });
  const embeddedHeaderRightItems = useCallback(() => nativeHeaderRightItemsRef.current(), []);
  const headerActions = <View style={styles.headerActions}>
    <Pressable ref={resourceButton} accessibilityRole="button" accessibilityLabel={t(resourceExpanded ? 'sessionResources.collapse' : 'sessionResources.expand')} hitSlop={6}
      accessibilityState={{ expanded: resourceExpanded }} onPress={toggleResources} style={({ pressed }) => [styles.resourceButton, resourceExpanded && { backgroundColor: colors.primarySoft }, pressed && styles.menuButtonPressed]} testID="session-resource-toggle">
      <Icon color={colors.primary} name="albums-outline" size={resourceIconSize} />
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
    liveActivityEnabled,
    trackedHere,
    trackedHere,
    triggers.available,
    remoteDesktopAvailable,
    closing,
  ].join('|');
  useLayoutEffect(() => {
    if (!embeddedHeader) return;
    navigation.setOptions(Platform.OS === 'ios'
      ? { title, unstable_headerRightItems: embeddedHeaderRightItems, fullScreenGestureEnabled }
      : { headerRight: embeddedHeaderRight, title });
  }, [embeddedHeader, embeddedHeaderRight, embeddedHeaderRightItems, fullScreenGestureEnabled, headerMenuKey, navigation, title]);
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
    onOpenFile={openFileInResources}
    onOpenRemoteDesktopPreview={() => setRemoteDesktopPreview({ open: true, sessionId })}
    onOpenRemoteDesktopDetail={openRemoteDesktopDetails}
    onRemoveRemoteDesktop={removeRemoteDesktopFromSession}
    renderRemoteDesktopInlinePreview={({ instanceId: previewInstanceId, onOpenDetail, sessionId: previewSessionId }) => (
      <SessionRemoteDesktopInlinePreview
        instanceId={previewInstanceId}
        onOpenDetail={onOpenDetail}
        sessionId={previewSessionId}
      />
    )}
    onOpenSession={(nextSessionId) => {
      if (onOpenSession) onOpenSession(instanceId, nextSessionId);
      else router.push({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId, sessionId: nextSessionId } });
    }}
    onDetailModeChange={setDetailMode}
    loadError={loadError}
    onRetryLoad={sessionView.retryReads}
    remoteDesktopTarget={remoteDesktopLink?.target}
    session={session}
    syncPhase={sessionView.syncPhase}
    timelines={sessionView.timelines}
    workspaceName={workspaceName}
  />;
  const resourceActivity = session ? {
    lastMessage: latestAiSessionMessage(session, messages),
    running: session.status === 'running',
    text: sessionActivityText(session, t),
  } : undefined;
  return <View style={styles.root}>
    {embeddedHeader ? null : <Stack.Screen options={Platform.OS === 'ios'
      ? { ...(pane ? {} : { title }), unstable_headerRightItems: nativeHeaderRightItems, fullScreenGestureEnabled }
      : pane ? { headerRight: () => headerActions } : { title, headerRight: () => headerActions }} />}
    {embeddedHeader ? null : <PaneHeaderRestore pane={pane} />}
    <SessionResourceLayout activity={resourceActivity?.text || resourceActivity?.lastMessage ? resourceActivity : undefined} topInset={sessionResourceTopInset(Platform.OS, headerHeight)} expanded={resourceExpanded} fraction={fraction} onClose={closeResources} onFractionChange={changeFraction}
      panel={<SessionResourcePanel key={contextKey} contextKey={contextKey} controlPlaneId={controlPlaneId || ''} expanded={resourceExpanded}
        instance={instance} instanceId={instanceId} sessionId={sessionId} session={session} syncReady={sessionView.syncPhase === 'ready'}
        onOpenRemoteDesktop={openRemoteDesktopDetails}
        onFractionChange={changeFraction} />}
    >{workspace}</SessionResourceLayout>
    <SessionRenameModal
      busy={renaming}
      error={renameError}
      initialTitle={title}
      onClose={() => { if (!renaming) setRenameOpen(false); }}
      onSubmit={submitRename}
      open={renameOpen}
    />
    {screenFocused && remoteDesktopLink && sessionPreviewPresentation === 'floating' ? <SessionRemoteDesktopFloatingPreview
      controlPlaneId={controlPlaneId}
      instanceId={instanceId}
      onClose={() => setRemoteDesktopPreview({ open: false, sessionId })}
      onOpen={openRemoteDesktopDetails}
      sessionId={sessionId}
      topInset={sessionResourceTopInset(Platform.OS, headerHeight)}
      visible={remoteDesktopPreviewOpen}
    /> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  resourceButton: { alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 17 },
  menuButton: { alignItems: 'center', height: 34, justifyContent: 'center', width: 34 },
  menuButtonPressed: { opacity: 0.65 },
});
