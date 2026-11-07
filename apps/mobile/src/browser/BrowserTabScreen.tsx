import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useFocusEffect, useRouter } from 'expo-router';

import { TaskHandoffBrowserView, type BrowserViewRef } from '../../modules/task-handoff-browser/src';
import { BrowserStartPage } from './BrowserStartPage';
import { BrowserToolbar } from './BrowserToolbar';
import { mobileBrowserStartPages } from './start-page-runtime';
import { MAX_BROWSER_PINNED } from './start-page-store';
import { mobileBrowserController } from './controller';
import { browserErrorDiagnostic } from './diagnostics';
import { diagnosticLog } from '../observability/diagnostic-logs';
import { mobileBrowserTabStore, type MobileBrowserTab } from './store';
import { fromBrowserTransportAddress, normalizeBrowserAddress, toBrowserTransportAddress } from './url';
import type { AnchoredSelectOption } from '../components/AnchoredSelectMenu';
import { EmbeddedPaneHeaderOptions } from '../components/EmbeddedPaneHeader';
import { Icon } from '../components/Icon';
import { useResourcePresentation } from '../components/use-resource-presentation';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../i18n';
import { subscribeToAppLifecycle } from '../platform/lifecycle';
import { subscribeToNetworkState } from '../platform/network';

type TabViewState = { loading: boolean; progress: number; error: string; canGoBack: boolean; canGoForward: boolean };
const INITIAL_VIEW: TabViewState = { loading: false, progress: 0, error: '', canGoBack: false, canGoForward: false };

export function BrowserTabScreen({
  browserTabId,
  resource = false,
  active = true,
  embeddedHeader = false,
  instanceId,
  onClosed,
  onSelectTab,
  pane = false,
  reloadToken = 0,
}: {
  browserTabId: string;
  resource?: boolean;
  active?: boolean;
  embeddedHeader?: boolean;
  instanceId: string;
  onClosed?(): void;
  onSelectTab?(tab: MobileBrowserTab): void;
  pane?: boolean;
  reloadToken?: number;
}) {
  const router = useRouter();
  const runtime = useMobileControlPlaneRuntime();
  const canPresent = useResourcePresentation(JSON.stringify(['browser', runtime.controlPlaneId, instanceId]), active);
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const callbacks = useRef({ onClosed, onSelectTab });
  useEffect(() => { callbacks.current = { onClosed, onSelectTab }; }, [onClosed, onSelectTab]);
  const addressInput = useRef<TextInput>(null);
  const startPages = useSyncExternalStore(mobileBrowserStartPages.subscribe, mobileBrowserStartPages.snapshot, mobileBrowserStartPages.snapshot);
  const viewStateRef = useRef<Record<string, TabViewState>>({});
  const [library, setLibrary] = useState<{ tabId: string; mode: 'start' | 'history' }>();
  const viewRefs = useRef<Record<string, BrowserViewRef | null>>({});
  const snapshot = useSyncExternalStore(mobileBrowserTabStore.subscribe, mobileBrowserTabStore.snapshot, mobileBrowserTabStore.snapshot);
  useSyncExternalStore(mobileBrowserController.subscribe, () => mobileBrowserController.contextId(runtime.controlPlaneId || '', instanceId) || '', () => '');
  const instanceTabs = useMemo(
    () => snapshot.tabs.filter((candidate) => candidate.controlPlaneId === runtime.controlPlaneId && candidate.instanceId === instanceId),
    [instanceId, runtime.controlPlaneId, snapshot.tabs],
  );
  const requestedTab = instanceTabs.find((candidate) => candidate.id === browserTabId);
  // Keep the native views mounted while the router catches up after a tab is closed.
  const tab = requestedTab || instanceTabs.find((candidate) => candidate.id === snapshot.activeTabId) || instanceTabs[0];
  const contextId = mobileBrowserController.contextId(runtime.controlPlaneId || '', instanceId);
  const [addressDrafts, setAddressDrafts] = useState<Record<string, string>>({});
  const [editingTabId, setEditingTabId] = useState<string>();
  const addressFocused = editingTabId === tab?.id;
  const [routeError, setRouteError] = useState('');
  const [creatingTab, setCreatingTab] = useState(false);
  const creatingTabRef = useRef(false);
  const [viewStates, setViewStates] = useState<Record<string, TabViewState>>({});
  const activeViewState = (tab ? viewStates[tab.id] : undefined) ?? INITIAL_VIEW;
  const loading = activeViewState?.loading ?? false;
  const error = activeViewState?.error || routeError;
  const tabControlPlaneId = tab?.controlPlaneId;
  const tabInstanceId = tab?.instanceId;
  const reloadTabId = tab?.id;
  const reloadTabUrl = tab?.currentUrl;
  const lastReloadToken = useRef(reloadToken);

  const activateTab = useCallback((candidate: MobileBrowserTab) => {
    if (callbacks.current.onSelectTab) callbacks.current.onSelectTab(candidate);
    else router.setParams({ browserTabId: candidate.id });
  }, [router]);

  useEffect(() => {
    if (!canPresent) return;
    if (!requestedTab) {
      if (tab) activateTab(tab);
      else if (callbacks.current.onClosed) callbacks.current.onClosed();
      else router.back();
      return;
    }
    mobileBrowserTabStore.activate(tab.controlPlaneId, tab.instanceId, tab.id);
  }, [activateTab, canPresent, instanceTabs, requestedTab, router, snapshot.activeTabId, tab]);

  useFocusEffect(useCallback(() => {
    const diagnostic = { controlPlaneId: tabControlPlaneId, instanceId: tabInstanceId };
    diagnosticLog.info('browser.view.focus', { ...diagnostic, hasApi: !!runtime.api, hasProfile: !!runtime.profile });
    if (!canPresent || !tabControlPlaneId || !tabInstanceId || !runtime.api || !runtime.profile) {
      diagnosticLog.warn('browser.view.runtime-unavailable', diagnostic);
      return;
    }
    let foreground = true;
    let connected = true;
    let live = true;
    let networkSignature = '';
    const reconcile = () => {
      diagnosticLog.info('browser.view.reconcile', { ...diagnostic, foreground, connected });
      if (foreground && connected) {
        void mobileBrowserController.activate(runtime.api!, runtime.profile!, tabInstanceId)
          .then(() => { if (live) setRouteError(''); })
          .catch((cause) => {
            diagnosticLog.warn('browser.view.activate-failed', { ...diagnostic, live, ...browserErrorDiagnostic(cause) });
            if (live) setRouteError(cause instanceof Error ? cause.message : t('browser.createFailed'));
          });
      } else void mobileBrowserController.suspend(tabControlPlaneId, tabInstanceId);
    };
    const unsubscribeLifecycle = subscribeToAppLifecycle((phase) => { foreground = phase === 'active'; reconcile(); });
    const unsubscribeNetwork = subscribeToNetworkState((state) => {
      connected = state.connected;
      const nextSignature = `${state.type}:${state.connected}:${state.internetReachable ?? 'unknown'}`;
      const changed = Boolean(networkSignature) && networkSignature !== nextSignature;
      networkSignature = nextSignature;
      if (changed) void mobileBrowserController.suspend(tabControlPlaneId, tabInstanceId).then(reconcile);
      else reconcile();
    });
    return () => {
      diagnosticLog.info('browser.view.blur', diagnostic);
      live = false;
      unsubscribeLifecycle();
      unsubscribeNetwork();
      void mobileBrowserController.suspend(tabControlPlaneId, tabInstanceId);
    };
  }, [canPresent, runtime.api, runtime.profile, setRouteError, t, tabControlPlaneId, tabInstanceId]));

  useEffect(() => {
    diagnosticLog.info('browser.view.context', { controlPlaneId: tabControlPlaneId, instanceId: tabInstanceId, tabId: tab?.id, contextId, preparing: !contextId });
  }, [contextId, tab?.id, tabControlPlaneId, tabInstanceId]);

  useEffect(() => {
    if (lastReloadToken.current === reloadToken) return;
    lastReloadToken.current = reloadToken;
    if (!active || !reloadTabId || reloadTabUrl === 'about:blank') return;
    const view = viewRefs.current[reloadTabId];
    if (!view) return;
    setRouteError('');
    void view.reload().catch((cause) => setRouteError(cause instanceof Error ? cause.message : t('browser.createFailed')));
  }, [active, reloadTabId, reloadTabUrl, reloadToken, t]);

  if (!tab || !runtime.controlPlaneId) return null;

  const startPage = mobileBrowserStartPages.page(tab.controlPlaneId, tab.instanceId, startPages);
  const isBlank = tab.currentUrl === 'about:blank';
  const canDismissLibrary = !addressFocused && library?.tabId === tab.id && (!isBlank || library.mode === 'history');
  const showLibrary = addressFocused || library?.tabId === tab.id || (!error && isBlank);
  const currentPinned = startPage.pinned.some((item) => item.url === tab.currentUrl);
  const address = addressDrafts[tab.id] ?? (tab.currentUrl === 'about:blank' ? '' : tab.currentUrl);
  const setTabAddress = (tabId: string, value: string) => setAddressDrafts((current) => ({ ...current, [tabId]: value }));
  const activeView = () => viewRefs.current[tab.id];
  const runViewAction = (action: (() => Promise<void>) | undefined) => {
    if (!action) return;
    setRouteError('');
    void Promise.resolve().then(action).catch((cause) => setRouteError(cause instanceof Error ? cause.message : t('browser.createFailed')));
  };
  const finishEditing = () => { addressInput.current?.blur(); Keyboard.dismiss(); setEditingTabId(undefined); };
  const navigate = (value = address) => {
    if (!contextId) return;
    try {
      const url = normalizeBrowserAddress(value);
      setTabAddress(tab.id, url);
      setRouteError('');
      setTabViewState(tab.id, { error: '' });
      setLibrary(undefined);
      finishEditing();
      runViewAction(() => activeView()!.loadUrl(toBrowserTransportAddress(url)));
    } catch (cause) { setRouteError(cause instanceof Error ? cause.message : t('browser.addressInvalid')); }
  };
  const selectTab = (candidate: MobileBrowserTab) => {
    finishEditing();
    setLibrary(undefined);
    setRouteError('');
    mobileBrowserTabStore.activate(candidate.controlPlaneId, candidate.instanceId, candidate.id);
    activateTab(candidate);
  };
  const newTab = async () => {
    if (creatingTabRef.current || !contextId || !runtime.api || !runtime.profile) return;
    creatingTabRef.current = true;
    setCreatingTab(true);
    setRouteError('');
    try {
      const created = await mobileBrowserController.create({ api: runtime.api, profile: runtime.profile, instanceId: tab.instanceId });
      selectTab(created);
    } catch (cause) {
      setRouteError(cause instanceof Error ? cause.message : t('browser.createFailed'));
    } finally {
      creatingTabRef.current = false;
      setCreatingTab(false);
    }
  };
  const close = async () => {
    await mobileBrowserController.close(tab.controlPlaneId, tab.instanceId, tab.id);
    delete viewRefs.current[tab.id];
    delete viewStateRef.current[tab.id];
    setAddressDrafts((current) => {
      const next = { ...current };
      delete next[tab.id];
      return next;
    });
    setViewStates((current) => {
      const next = { ...current };
      delete next[tab.id];
      return next;
    });
    const next = mobileBrowserTabStore.tabsFor(tab.controlPlaneId, tab.instanceId)
      .find((candidate) => candidate.id === mobileBrowserTabStore.snapshot().activeTabId);
    if (next) activateTab(next);
    else if (callbacks.current.onClosed) callbacks.current.onClosed();
    else router.back();
  };
  const setTabViewState = (tabId: string, patch: Partial<TabViewState>) => {
    const next = { ...(viewStateRef.current[tabId] ?? INITIAL_VIEW), ...patch };
    viewStateRef.current[tabId] = next;
    setViewStates((current) => ({ ...current, [tabId]: next }));
  };
  const recordVisit = (candidate: MobileBrowserTab, titleOnly = false) => {
    const state = viewStateRef.current[candidate.id];
    if (state?.loading || state?.error || state?.progress !== 1) return;
    const current = mobileBrowserTabStore.tabsFor(candidate.controlPlaneId, candidate.instanceId).find((item) => item.id === candidate.id);
    if (titleOnly && mobileBrowserStartPages.page(candidate.controlPlaneId, candidate.instanceId).recent[0]?.url !== current?.currentUrl) return;
    if (current) void mobileBrowserStartPages.visit(current.controlPlaneId, current.instanceId, current.currentUrl, current.title);
  };
  const openLibrary = (mode: 'start' | 'history') => {
    finishEditing();
    setLibrary({ tabId: tab.id, mode });
  };
  const moreOptions: AnchoredSelectOption[] = [
    { value: 'start', label: t('browser.startPage'), systemImage: 'house' },
    { value: 'history', label: t('browser.recent'), systemImage: 'clock' },
    ...(!isBlank ? [{ value: 'pin', label: t(currentPinned ? 'browser.unpin' : 'browser.pin'), systemImage: 'pin' as const }] : []),
    { value: 'close', label: t('browser.close'), systemImage: 'xmark', danger: true },
  ];
  const tabMenuOptions: AnchoredSelectOption[] = instanceTabs.map((candidate) => ({
    label: candidate.title || t('browser.untitled'),
    description: candidate.currentUrl === 'about:blank' ? t('browser.untitled') : candidate.currentUrl,
    value: candidate.id,
  }));

  return <SafeAreaView edges={[]} style={[styles.root, { backgroundColor: colors.background }]}>
    {resource ? null : embeddedHeader
      ? <EmbeddedPaneHeaderOptions enabled title={tab.title || t('browser.browser')} />
      : pane ? null : <Stack.Screen options={{ headerLargeTitle: false, title: tab.title || t('browser.browser') }} />}
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.content}>
      <View style={[styles.addressRow, { borderBottomColor: colors.workbenchCardBorder, backgroundColor: colors.surface }]}>
        <View style={[styles.addressField, { borderColor: addressFocused ? colors.primary : 'transparent', backgroundColor: colors.surfaceInset }]}>
          <Icon color={addressFocused ? colors.primary : colors.textMuted} name="globe-outline" size={18} />
          <TextInput
            accessibilityLabel={t('browser.address')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onBlur={() => setEditingTabId(undefined)}
            onChangeText={(value) => setTabAddress(tab.id, value)}
            onFocus={() => setEditingTabId(tab.id)}
            onSubmitEditing={() => navigate()}
            placeholder={t('browser.addressPlaceholder')}
            placeholderTextColor={colors.textMuted}
            ref={addressInput}
            returnKeyType="go"
            selectTextOnFocus
            style={[styles.address, { color: colors.text }]}
            value={address}
          />
          {addressFocused ? <>
            <ToolbarButton label={t('browser.clearAddress')} onPress={() => { setTabAddress(tab.id, ''); addressInput.current?.focus(); }}><Icon color={colors.textMuted} name="close-circle" size={18} /></ToolbarButton>
            <ToolbarButton label={t('browser.go')} disabled={!contextId || !address.trim()} onPress={() => navigate()}><Icon color={colors.primary} name="arrow-forward-circle" size={25} /></ToolbarButton>
          </>
            : <ToolbarButton label={loading ? t('browser.stop') : t('browser.reload')} disabled={!contextId || isBlank} onPress={() => runViewAction(() => loading ? activeView()!.stopLoading() : activeView()!.reload())}>
              <Icon color={colors.textMuted} name={loading ? 'close' : 'refresh'} size={19} />
            </ToolbarButton>}
        </View>
        {addressFocused ? <ToolbarButton label={t('common.cancel')} onPress={() => { setTabAddress(tab.id, isBlank ? '' : tab.currentUrl); finishEditing(); }}><Text style={[styles.cancelText, { color: colors.primary }]}>{t('common.cancel')}</Text></ToolbarButton> : null}
      </View>
      {error ? <View accessibilityLiveRegion="polite" style={[styles.errorRow, { backgroundColor: colors.errorSoft }]}>
        <Icon color={colors.error} name="alert-circle-outline" size={18} />
        <Text selectable style={[styles.error, { color: colors.error }]}>{error}</Text>
        <ToolbarButton label={t('browser.reload')} disabled={!contextId || isBlank} onPress={() => runViewAction(() => activeView()!.reload())}><Icon color={colors.error} name="refresh" size={18} /></ToolbarButton>
      </View> : null}
      <View style={styles.webViewHost}>
      {contextId && canPresent ? instanceTabs.map((candidate) => {
        const active = candidate.id === tab.id;
        return <View key={candidate.id} accessibilityElementsHidden={!active || showLibrary} importantForAccessibility={active && !showLibrary ? 'auto' : 'no-hide-descendants'} pointerEvents={active && !showLibrary ? 'auto' : 'none'} style={[styles.webViewLayer, !active && styles.hiddenWebViewLayer]}>
          <TaskHandoffBrowserView
            contextId={contextId}
            initialUrl={toBrowserTransportAddress(candidate.currentUrl)}
            onError={({ nativeEvent }) => {
              setTabViewState(candidate.id, { loading: false, error: nativeEvent.description });
              mobileBrowserTabStore.update(candidate.controlPlaneId, candidate.instanceId, candidate.id, { loading: false });
            }}
            onLoadingChange={({ nativeEvent }) => {
              setTabViewState(candidate.id, { loading: nativeEvent.loading, progress: Math.min(1, Math.max(0, nativeEvent.progress)), ...(nativeEvent.loading ? { error: '' } : {}) });
              mobileBrowserTabStore.update(candidate.controlPlaneId, candidate.instanceId, candidate.id, { loading: nativeEvent.loading });
              if (!nativeEvent.loading) recordVisit(candidate);
            }}
            onNavigationStateChange={({ nativeEvent }) => {
              const displayUrl = nativeEvent.url === 'about:blank' ? nativeEvent.url : fromBrowserTransportAddress(nativeEvent.url);
              mobileBrowserTabStore.update(candidate.controlPlaneId, candidate.instanceId, candidate.id, { currentUrl: displayUrl, title: nativeEvent.title });
              setTabViewState(candidate.id, { canGoBack: nativeEvent.canGoBack, canGoForward: nativeEvent.canGoForward });
              if (editingTabId !== candidate.id) setTabAddress(candidate.id, displayUrl === 'about:blank' ? '' : displayUrl);
              recordVisit(candidate, true);
            }}
            onNewWindow={({ nativeEvent }) => {
              if (!runtime.api || !runtime.profile) return;
              void mobileBrowserController.create({ api: runtime.api, profile: runtime.profile, instanceId: candidate.instanceId, initialUrl: fromBrowserTransportAddress(nativeEvent.url) })
                .then(selectTab)
                .catch((cause) => setTabViewState(candidate.id, { error: cause instanceof Error ? cause.message : t('browser.createFailed') }));
            }}
            ref={(view) => { viewRefs.current[candidate.id] = view; }}
            style={styles.webView}
          />
        </View>;
        }) : <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={[styles.connecting, { color: colors.textMuted }]}>{t('browser.connecting')}</Text></View>}
        {contextId && showLibrary ? <View style={styles.webViewLayer}>
          <BrowserStartPage page={startPage} mode={addressFocused ? 'suggestions' : library?.tabId === tab.id ? library.mode : 'start'} query={addressFocused ? address : ''} onNavigate={navigate}
            onUnpin={(item) => { void mobileBrowserStartPages.togglePinned(tab.controlPlaneId, tab.instanceId, item.url, item.title); }}
            onClear={() => { void mobileBrowserStartPages.clearRecent(tab.controlPlaneId, tab.instanceId); }} />
        </View> : null}
        {loading && !showLibrary ? <View accessible accessibilityLabel={t('browser.loading')} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(activeViewState.progress * 100) }} style={[styles.loadingTrack, { backgroundColor: colors.workbenchCardBorder }]}><View style={[styles.loadingIndicator, { backgroundColor: colors.primary, width: `${activeViewState.progress * 100}%` }]} /></View> : null}
      </View>
      <BrowserToolbar
        canGoBack={canDismissLibrary || activeViewState.canGoBack}
        canGoForward={activeViewState.canGoForward}
        connected={Boolean(contextId)}
        creating={creatingTab}
        pane={pane}
        resource={resource}
        tabs={tabMenuOptions}
        selectedTabId={tab.id}
        moreOptions={moreOptions}
        onBack={() => { finishEditing(); setLibrary(undefined); if (!canDismissLibrary) runViewAction(() => activeView()!.goBack()); }}
        onForward={() => { finishEditing(); setLibrary(undefined); runViewAction(() => activeView()!.goForward()); }}
        onNew={() => { void newTab(); }}
        onSelectTab={(value) => {
          const candidate = instanceTabs.find((entry) => entry.id === value);
          if (candidate) selectTab(candidate);
        }}
        onMore={(action) => {
          if (action === 'close') void close().catch((cause) => setRouteError(cause instanceof Error ? cause.message : t('browser.createFailed')));
          else if (action === 'pin') {
            if (!currentPinned && startPage.pinned.length >= MAX_BROWSER_PINNED) setRouteError(t('browser.pinnedLimit', { count: MAX_BROWSER_PINNED }));
            else void mobileBrowserStartPages.togglePinned(tab.controlPlaneId, tab.instanceId, tab.currentUrl, tab.title);
          } else openLibrary(action === 'history' ? 'history' : 'start');
        }}
      />
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

function ToolbarButton({ children, disabled = false, label, onPress }: { children: React.ReactNode; disabled?: boolean; label: string; onPress?: () => void }) {
  const unavailable = disabled;
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled: unavailable }} disabled={unavailable} onPress={onPress} style={({ pressed }) => [styles.toolbarButton, unavailable && styles.disabledButton, pressed && styles.pressed]}>{children}</Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, content: { flex: 1 },
  addressRow: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 4, paddingHorizontal: 12, paddingVertical: 8 },
  addressField: { alignItems: 'center', borderRadius: 14, borderWidth: 1, flex: 1, flexDirection: 'row', gap: 8, minHeight: 44, paddingLeft: 12 },
  address: { flex: 1, fontSize: 15, minHeight: 44, paddingHorizontal: 0, paddingVertical: 8 },
  cancelText: { fontSize: 14, lineHeight: 20, paddingHorizontal: 4 },
  loadingTrack: { height: 2, left: 0, overflow: 'hidden', position: 'absolute', right: 0, top: 0 }, loadingIndicator: { height: 2 },
  errorRow: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingLeft: 12, paddingVertical: 4 }, error: { flex: 1, fontSize: 13, lineHeight: 18 },
  webViewHost: { flex: 1, position: 'relative' }, webViewLayer: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 }, hiddenWebViewLayer: { opacity: 0 }, webView: { flex: 1 },
  loading: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center' }, connecting: { fontSize: 14, lineHeight: 20 },
  toolbarButton: { alignItems: 'center', minHeight: 44, justifyContent: 'center', minWidth: 44, borderRadius: 12 },
  disabledButton: { opacity: 0.3 }, pressed: { opacity: 0.5 },
});
