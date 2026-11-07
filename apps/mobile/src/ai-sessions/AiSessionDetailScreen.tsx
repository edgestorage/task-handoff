import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Stack, useNavigation, useRouter, type NativeStackHeaderItem, type NativeStackHeaderItemMenuAction } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { AccessibilityInfo, Alert, findNodeHandle, Platform, Pressable, StyleSheet, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { MenuView, type MenuAction } from '../components/MenuView';

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
  const handleMenuEvent = (event: string) => {
    if (event === 'view-turn') setDetailMode('turn');
    else if (event === 'view-conversation') setDetailMode('conversation');
    else if (event === 'rename') openRename();
    else if (event === 'live-activity') {
      if (trackedHere) void taskStatus.stopTracking();
      else if (controlPlaneId) void taskStatus.startTracking({ controlPlaneId, instanceId, sessionId });
    }
    else if (event === 'triggers') router.push({ pathname: '/sessions/[instanceId]/[sessionId]/triggers' as never, params: { instanceId, sessionId } });
    else if (event === 'close') closeSession();
  };
  const menuActions: MenuAction[] = [
    { id: 'view-turn', image: 'rectangle.stack', state: detailMode === 'turn' ? 'on' : 'off', title: t('sessions.compact') },
    { id: 'view-conversation', image: 'text.bubble', state: detailMode === 'conversation' ? 'on' : 'off', title: t('sessions.conversation') },
    ...(canRename ? [{ id: 'rename', image: 'pencil', title: renaming ? t('sessions.renaming') : t('sessions.rename'), attributes: { disabled: renaming || !actions || sessionView.syncPhase !== 'ready' } } as MenuAction] : []),
    ...(liveActivityAction ? [liveActivityAction] : []),
    ...(triggers.available ? [{ id: 'triggers', image: 'bolt', title: t('triggers.sessionTitle') } as MenuAction] : []),
    { id: 'close', image: 'xmark.circle', title: closing ? t('sessions.closing') : t('sessions.closeSession'), attributes: { destructive: true, disabled: closing || !actions || sessionView.syncPhase !== 'ready' } },
  ];
  const menu = <MenuView
    actions={menuActions}
    onPressAction={({ nativeEvent }) => handleMenuEvent(nativeEvent.event)}
    title={t('sessions.sessionView')}
  >
    <Pressable accessibilityLabel={t('sessions.moreActions')} accessibilityRole="button" hitSlop={10} style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}>
      <Icon color={colors.primary} name="ellipsis-horizontal" size={23} />
    </Pressable>
  </MenuView>;
  const nativeMenuActions = [
    { type: 'action', label: t('sessions.compact'), onPress: () => handleMenuEvent('view-turn'), state: detailMode === 'turn' ? 'on' : 'off' },
    { type: 'action', label: t('sessions.conversation'), onPress: () => handleMenuEvent('view-conversation'), state: detailMode === 'conversation' ? 'on' : 'off' },
    ...(canRename ? [{ type: 'action' as const, label: renaming ? t('sessions.renaming') : t('sessions.rename'), onPress: openRename, disabled: renaming || !actions || sessionView.syncPhase !== 'ready' }] : []),
    ...(liveActivityAction ? [{ type: 'action' as const, label: liveActivityAction.title, onPress: () => handleMenuEvent('live-activity'), disabled: Boolean(liveActivityAction.attributes?.disabled), state: trackedHere ? 'on' as const : 'off' as const }] : []),
    ...(triggers.available ? [{ type: 'action' as const, label: t('triggers.sessionTitle'), onPress: () => handleMenuEvent('triggers') }] : []),
    { type: 'action' as const, label: closing ? t('sessions.closing') : t('sessions.closeSession'), onPress: () => handleMenuEvent('close'), destructive: true, disabled: closing || !actions || sessionView.syncPhase !== 'ready' },
  ] satisfies NativeStackHeaderItemMenuAction[];
  const nativeHeaderRightItems = () => [
    {
      accessibilityLabel: t(resourceExpanded ? 'sessionResources.collapse' : 'sessionResources.expand'),
      icon: { name: 'rectangle.stack', type: 'sfSymbol' as const },
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
      menu: { title: t('sessions.sessionView'), items: nativeMenuActions },
    },
  ] satisfies NativeStackHeaderItem[];
  const nativeHeaderRightItemsRef = useRef(nativeHeaderRightItems);
  useLayoutEffect(() => { nativeHeaderRightItemsRef.current = nativeHeaderRightItems; });
  const embeddedHeaderRightItems = useCallback(() => nativeHeaderRightItemsRef.current(), []);
  const headerActions = <View style={styles.headerActions}>
    <Pressable ref={resourceButton} accessibilityRole="button" accessibilityLabel={t(resourceExpanded ? 'sessionResources.collapse' : 'sessionResources.expand')} hitSlop={6}
      accessibilityState={{ expanded: resourceExpanded }} onPress={toggleResources} style={({ pressed }) => [styles.resourceButton, resourceExpanded && { backgroundColor: colors.primarySoft }, pressed && styles.menuButtonPressed]} testID="session-resource-toggle">
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
    navigation.setOptions(Platform.OS === 'ios'
      ? { title, unstable_headerRightItems: embeddedHeaderRightItems }
      : { headerRight: embeddedHeaderRight, title });
  }, [embeddedHeader, embeddedHeaderRight, embeddedHeaderRightItems, headerMenuKey, navigation, title]);
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
  const resourceActivity = session ? {
    lastMessage: latestAiSessionMessage(session, messages),
    running: session.status === 'running',
    text: sessionActivityText(session, t),
  } : undefined;
  return <>
    {embeddedHeader ? null : <Stack.Screen options={Platform.OS === 'ios'
      ? { ...(pane ? {} : { title }), unstable_headerRightItems: nativeHeaderRightItems }
      : pane ? { headerRight: () => headerActions } : { title, headerRight: () => headerActions }} />}
    {embeddedHeader ? null : <PaneHeaderRestore pane={pane} />}
    <SessionResourceLayout activity={resourceActivity?.text || resourceActivity?.lastMessage ? resourceActivity : undefined} topInset={sessionResourceTopInset(Platform.OS, headerHeight)} expanded={resourceExpanded} fraction={fraction} onClose={closeResources} onFractionChange={changeFraction}
      panel={<SessionResourcePanel key={contextKey} contextKey={contextKey} controlPlaneId={controlPlaneId || ''} expanded={resourceExpanded}
        instance={instance} instanceId={instanceId} sessionId={sessionId} session={session} syncReady={sessionView.syncPhase === 'ready'}
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
  </>;
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  resourceButton: { alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 17 },
  menuButton: { alignItems: 'center', height: 34, justifyContent: 'center', width: 34 },
  menuButtonPressed: { opacity: 0.65 },
});
