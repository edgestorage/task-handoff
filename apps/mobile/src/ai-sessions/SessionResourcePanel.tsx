import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, ActivityIndicator, findNodeHandle, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ControlPlaneInstanceResourceEntry } from '@task-handoff/control-plane-client';

import { AppSessionDetailScreen } from '../app-sessions/AppSessionDetailScreen';
import { appLaunchIcon } from '../app-sessions/app-launch-icon';
import { useActiveAppSessions } from '../app-sessions/use-active-app-sessions';
import { mobileAppSessionStore } from '../app-sessions/store';
import { BrowserTabScreen } from '../browser/BrowserTabScreen';
import { mobileBrowserController } from '../browser/controller';
import { mobileBrowserTabStore } from '../browser/store';
import { EmptyState } from '../components/EmptyState';
import { Icon, type IconName } from '../components/Icon';
import { MenuView, type MenuAction } from '../components/MenuView';
import { useMobileTheme } from '../components/theme';
import { mobileBrowserCapability } from '../control-plane/browser-context';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../i18n';
import { RepositoryResourceView } from '../repository/RepositoryResourceView';
import { mobileResourceWorkspaceStore, openSessionResource, removeSessionResource, sessionResourceKey, type SessionResource } from './resource-workspace-model';

export function SessionResourcePanel({ contextKey, controlPlaneId, expanded, fullscreen, instance, instanceId, onClose, onFullscreenChange, onFractionChange, session, sessionId, syncReady }: {
  contextKey: string;
  controlPlaneId: string;
  expanded: boolean;
  fullscreen: boolean;
  instance?: ControlPlaneInstanceResourceEntry;
  instanceId: string;
  onClose(): void;
  onFullscreenChange(value: boolean): void;
  onFractionChange(value: number): void;
  session?: { cwd?: string; cwdFolderId?: string };
  sessionId: string;
  syncReady: boolean;
}) {
  const runtime = useMobileControlPlaneRuntime();
  const appSessions = useActiveAppSessions();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const state = useSyncExternalStore(
    useCallback((listener) => mobileResourceWorkspaceStore.subscribe(contextKey, listener), [contextKey]),
    useCallback(() => mobileResourceWorkspaceStore.snapshot(contextKey), [contextKey]),
  );
  const browsers = useSyncExternalStore(mobileBrowserTabStore.subscribe, mobileBrowserTabStore.snapshot, mobileBrowserTabStore.snapshot);
  const [browserSupport, setBrowserSupport] = useState<{ key: string; supported: boolean }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const currentContext = useRef(contextKey);
  useLayoutEffect(() => {
    currentContext.current = contextKey;
    return () => { currentContext.current = ''; };
  }, [contextKey]);
  const ready = Boolean(syncReady && runtime.api && instance?.ready && instance.connectionStatus === 'online');
  const apps = appSessions.controlPlaneId === controlPlaneId ? appSessions.state.snapshot?.instances.find((item) => item.instanceId === instanceId)?.appSessions.sessions || [] : [];
  const tabs = browsers.tabs.filter((tab) => tab.controlPlaneId === controlPlaneId && tab.instanceId === instanceId);
  const canBrowse = browserSupport?.key === contextKey && browserSupport.supported;
  useEffect(() => {
    let live = true;
    if (!runtime.profile) return;
    void mobileBrowserCapability(runtime.profile, instance?.capabilities).then((capability) => {
      if (live) setBrowserSupport({ key: contextKey, supported: capability.supported });
    }).catch(() => { if (live) setBrowserSupport({ key: contextKey, supported: false }); });
    return () => { live = false; };
  }, [contextKey, instance?.capabilities, runtime.profile]);
  const open = useCallback((resource: SessionResource) => {
    mobileResourceWorkspaceStore.update(contextKey, openSessionResource(mobileResourceWorkspaceStore.snapshot(contextKey), resource));
  }, [contextKey]);
  const remove = useCallback((key: string) => {
    mobileResourceWorkspaceStore.update(contextKey, removeSessionResource(mobileResourceWorkspaceStore.snapshot(contextKey), key));
  }, [contextKey]);
  const active = state.resources.find((item) => sessionResourceKey(item) === state.activeKey);
  const selectedBrowser = active?.kind === 'browser' ? active : state.resources.find((item) => item.kind === 'browser');
  const [retainedBrowser, setRetainedBrowser] = useState<Extract<SessionResource, { kind: 'browser' }>>();
  const browser = selectedBrowser || retainedBrowser;
  useEffect(() => {
    if (!selectedBrowser) return;
    // Retain the native browser host after its local workspace tab is removed.
    const frame = requestAnimationFrame(() => setRetainedBrowser(selectedBrowser));
    return () => cancelAnimationFrame(frame);
  }, [selectedBrowser]);
  const target = useMemo(() => ({ instanceId, sessionKind: 'ai-session' as const, sessionId }), [instanceId, sessionId]);
  const title = (resource: SessionResource) => resource.kind === 'repository' ? t(`sessionResources.${resource.page}`)
    : resource.kind === 'app-session' ? apps.find((app) => app.id === resource.sessionId)?.title || apps.find((app) => app.id === resource.sessionId)?.appId || t('nav.appSessions')
      : tabs.find((tab) => tab.id === resource.tabId)?.title || t('browser.browser');
  const icon = (resource: SessionResource): IconName => resource.kind === 'repository' ? (resource.page === 'files' ? 'folder-outline' : resource.page === 'changes' ? 'git-compare-outline' : 'git-branch-outline')
    : resource.kind === 'browser' ? 'globe-outline' : appLaunchIcon(apps.find((app) => app.id === resource.sessionId)?.appId);
  const launch = async (appId?: string) => {
    if (!ready || !runtime.api || !runtime.profile || busy || (!appId && !canBrowse) || (appId && !session?.cwd)) return;
    const startedContext = contextKey;
    setBusy(true);
    setError('');
    try {
      if (appId) {
        const result = await runtime.api.appSessions.launch(instanceId, { appId, cwd: session!.cwd });
        mobileAppSessionStore.upsertSession(controlPlaneId, instanceId, result);
        if (currentContext.current === startedContext) open({ kind: 'app-session', sessionId: result.id });
      } else {
        const result = await mobileBrowserController.create({ api: runtime.api, profile: runtime.profile, instanceId });
        if (currentContext.current === startedContext) open({ kind: 'browser', tabId: result.id });
      }
    } catch (cause) {
      if (currentContext.current === startedContext) setError(cause instanceof Error ? cause.message : t('sessionResources.loadFailed'));
    } finally {
      if (currentContext.current === startedContext) setBusy(false);
    }
  };
  const menuActions: MenuAction[] = [
    { id: 'repository', title: t('sessionResources.repository'), subactions: [
      { id: 'files', title: t('sessionResources.files'), image: 'folder', attributes: { disabled: !ready || !session?.cwd } },
      { id: 'changes', title: t('sessionResources.changes'), image: 'doc.text.magnifyingglass', attributes: { disabled: !ready || !session?.cwd } },
      { id: 'worktrees', title: t('sessionResources.worktrees'), image: 'arrow.triangle.branch', attributes: { disabled: !ready || !session?.cwd } },
    ] },
    { id: 'apps', title: t('sessionResources.instanceApps'), subactions: [
      ...(instance?.availableApps || []).map<MenuAction>((app) => ({ id: `launch:${app.id}`, title: app.name, image: 'plus.app', attributes: { disabled: !ready || !session?.cwd || busy } })),
      ...apps.map<MenuAction>((app) => ({ id: `app:${app.id}`, title: app.title || app.appId || app.id, image: 'rectangle.on.rectangle' })),
      ...(!instance?.availableApps.length && !apps.length ? [{ id: 'no-apps', title: t('appSessions.noApps'), attributes: { disabled: true } }] : []),
    ] },
    { id: 'browser', title: t('browser.browser'), subactions: [
      { id: 'new-browser', title: t('browser.new'), image: 'plus', attributes: { disabled: !ready || !canBrowse || busy } },
      ...tabs.map<MenuAction>((tab) => ({ id: `browser:${tab.id}`, title: tab.title || tab.currentUrl || t('browser.browser'), image: 'globe' })),
    ] },
  ];
  const handleMenu = (id: string) => {
    if (id === 'files' || id === 'changes' || id === 'worktrees') open({ kind: 'repository', page: id });
    else if (id.startsWith('launch:')) void launch(id.slice(7));
    else if (id.startsWith('app:')) open({ kind: 'app-session', sessionId: id.slice(4) });
    else if (id.startsWith('browser:')) open({ kind: 'browser', tabId: id.slice(8) });
    else if (id === 'new-browser') void launch();
  };
  const tabScroll = useRef<ScrollView>(null);
  const tabPositions = useRef(new Map<string, { x: number; width: number }>());
  const viewportWidth = useRef(0);
  const scrollOffset = useRef(0);
  const revealTab = useCallback(() => {
    const position = state.activeKey ? tabPositions.current.get(state.activeKey) : undefined;
    if (!position || !viewportWidth.current) return;
    const right = position.x + position.width;
    if (position.x < scrollOffset.current) tabScroll.current?.scrollTo({ x: position.x, animated: true });
    else if (right > scrollOffset.current + viewportWidth.current) tabScroll.current?.scrollTo({ x: right - viewportWidth.current, animated: true });
  }, [state.activeKey]);
  useLayoutEffect(revealTab, [expanded, revealTab]);
  const closeButton = useRef<View>(null);
  useEffect(() => {
    if (!expanded) return;
    const frame = requestAnimationFrame(() => {
      const node = findNodeHandle(closeButton.current);
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded]);
  const actionButton = (label: string, name: IconName, onPress?: () => void) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.button, pressed && styles.pressed]}><Icon color={colors.primary} name={name} /></Pressable>;
  return <View style={styles.root}>
    <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
      <Pressable ref={closeButton} accessibilityRole="button" accessibilityLabel={t('sessionResources.collapse')} onPress={onClose} style={styles.button}><Icon color={colors.primary} name="chevron-forward" /></Pressable>
      <ScrollView horizontal ref={tabScroll} showsHorizontalScrollIndicator={false} style={styles.tabs}
        onLayout={(event) => { viewportWidth.current = event.nativeEvent.layout.width; revealTab(); }}
        onScroll={(event) => { scrollOffset.current = event.nativeEvent.contentOffset.x; }} scrollEventThrottle={16}
        onContentSizeChange={revealTab}>
        <View accessibilityRole="tablist" style={styles.tabRow}>
          {state.resources.map((resource) => {
            const key = sessionResourceKey(resource);
            const selected = key === state.activeKey;
            return <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={title(resource)} onPress={() => open(resource)}
              onLayout={(event) => { tabPositions.current.set(key, event.nativeEvent.layout); revealTab(); }}
              style={[styles.tab, { borderBottomColor: selected ? colors.primary : 'transparent', backgroundColor: selected ? colors.primarySoft : 'transparent' }]}>
              <Icon name={icon(resource)} size={16} color={selected ? colors.primary : colors.textMuted} /><Text numberOfLines={1} style={[styles.tabText, { color: selected ? colors.text : colors.textMuted }]}>{title(resource)}</Text>
            </Pressable>;
          })}
        </View>
      </ScrollView>
      <MenuView actions={menuActions} onPressAction={({ nativeEvent }) => handleMenu(nativeEvent.event)} title={t('sessionResources.add')}>
        {actionButton(t('sessionResources.add'), 'add')}
      </MenuView>
      <MenuView actions={[
        { id: 'fullscreen', title: t(fullscreen ? 'sessionResources.exitFullscreen' : 'sessionResources.fullscreen'), image: 'arrow.up.left.and.arrow.down.right' },
        { id: 'balanced', title: t('sessionResources.balanced') },
        { id: 'conversation', title: t('sessionResources.conversationPriority') },
        { id: 'resource', title: t('sessionResources.resourcePriority') },
        ...(active ? [{ id: 'remove-view', title: t('sessionResources.removeView') }] : []),
      ]} onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === 'fullscreen') onFullscreenChange(!fullscreen);
        else if (nativeEvent.event === 'remove-view' && active) remove(sessionResourceKey(active));
        else onFractionChange(nativeEvent.event === 'balanced' ? 0.5 : nativeEvent.event === 'conversation' ? 0.35 : 0.6);
      }} title={t('sessionResources.options')}>
        {actionButton(t('sessionResources.options'), 'ellipsis-horizontal')}
      </MenuView>
    </View>
    {busy ? <ActivityIndicator style={styles.busy} /> : null}
    {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.error, backgroundColor: colors.errorSoft }]}>{error}</Text> : null}
    <View style={styles.content}>
      {!state.resources.length ? <ScrollView contentContainerStyle={styles.emptyContent}>
        <EmptyState icon="albums-outline" message={t('sessionResources.empty')} />
        <Text style={[styles.hint, { color: colors.textMuted }]}>{t('sessionResources.emptyHint')}</Text>
        {(['files', 'changes', 'worktrees'] as const).map((page) => <Pressable key={page} accessibilityRole="button" disabled={!ready || !session?.cwd} onPress={() => open({ kind: 'repository', page })} style={[styles.quickAction, { borderColor: colors.border }]}><Icon color={colors.primary} name={page === 'files' ? 'folder-outline' : page === 'changes' ? 'git-compare-outline' : 'git-branch-outline'} /><Text style={[styles.quickLabel, { color: colors.text }]}>{t(`sessionResources.${page}`)}</Text></Pressable>)}
        {!ready ? <Text style={[styles.hint, { color: colors.textMuted }]}>{t('sessionResources.unavailable')}</Text> : null}
      </ScrollView> : null}
      {state.resources.filter((resource) => resource.kind !== 'browser').map((resource) => {
        const key = sessionResourceKey(resource);
        const visible = expanded && state.activeKey === key;
        return <View key={key} accessibilityElementsHidden={!visible} importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'} pointerEvents={visible ? 'auto' : 'none'} style={[styles.layer, !visible && styles.hidden]}>
          {resource.kind === 'repository' ? <RepositoryResourceView
            key={`${contextKey}:${session?.cwd || ''}:${session?.cwdFolderId || ''}:${resource.page}`}
            active={visible} client={runtime.api} cwdFolderId={session?.cwdFolderId} page={resource.page} ready={ready} target={target} workspaceIdentity={JSON.stringify([contextKey, session?.cwd || '', session?.cwdFolderId || ''])}
          /> : apps.some((app) => app.id === resource.sessionId) ? <AppSessionDetailScreen resource active={visible && ready} instanceId={instanceId} sessionId={resource.sessionId} onClosed={() => remove(key)} />
            : <EmptyState icon="alert-circle-outline" message={t('sessionResources.unavailable')} />}
        </View>;
      })}
      {browser?.kind === 'browser' ? <View accessibilityElementsHidden={!expanded || active?.kind !== 'browser'} importantForAccessibility={expanded && active?.kind === 'browser' ? 'auto' : 'no-hide-descendants'} pointerEvents={expanded && active?.kind === 'browser' ? 'auto' : 'none'} style={[styles.layer, (!expanded || active?.kind !== 'browser') && styles.hidden]}>
        {tabs.some((tab) => tab.id === browser.tabId) && canBrowse ? <BrowserTabScreen resource active={ready} pane instanceId={instanceId} browserTabId={browser.tabId}
          onSelectTab={(tab) => {
            const current = mobileResourceWorkspaceStore.snapshot(contextKey);
            const next = openSessionResource(current, { kind: 'browser', tabId: tab.id });
            mobileResourceWorkspaceStore.update(contextKey, active?.kind === 'browser' ? next : { ...next, activeKey: current.activeKey });
          }} onClosed={() => remove(sessionResourceKey(browser))} /> : <EmptyState icon="alert-circle-outline" message={t('sessionResources.unavailable')} />}
      </View> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0 }, header: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 48 },
  button: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, tabs: { flex: 1 }, tabRow: { flexDirection: 'row' },
  tab: { alignItems: 'center', borderBottomWidth: 2, flexDirection: 'row', gap: 6, minHeight: 48, maxWidth: 180, paddingHorizontal: 12 }, tabText: { flexShrink: 1, fontSize: 14, fontWeight: '500' },
  content: { flex: 1, minHeight: 0 }, layer: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }, hidden: { opacity: 0 },
  emptyContent: { flexGrow: 1, justifyContent: 'center', padding: 20, gap: 12 }, hint: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  quickAction: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14 }, quickLabel: { fontSize: 15 },
  error: { fontSize: 13, lineHeight: 18, paddingHorizontal: 12, paddingVertical: 8 }, busy: { padding: 8 }, pressed: { opacity: 0.6 },
});
