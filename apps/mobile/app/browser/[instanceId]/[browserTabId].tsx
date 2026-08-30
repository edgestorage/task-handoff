import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import { TaskHandoffBrowserView, type BrowserViewRef } from '../../../modules/task-handoff-browser/src';
import { mobileBrowserController } from '../../../src/browser/controller';
import { mobileBrowserTabStore, type MobileBrowserTab } from '../../../src/browser/store';
import { fromBrowserTransportAddress, normalizeBrowserAddress, toBrowserTransportAddress } from '../../../src/browser/url';
import { NewSessionContextMenu } from '../../../src/ai-sessions/NewSessionContextMenu';
import type { AnchoredSelectOption } from '../../../src/components/AnchoredSelectMenu';
import { SystemIcon } from '../../../src/components/SystemIcon';
import { useMobileTheme } from '../../../src/components/theme';
import { useMobileControlPlaneRuntime } from '../../../src/control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../../../src/i18n';
import { subscribeToAppLifecycle } from '../../../src/platform/lifecycle';
import { subscribeToNetworkState } from '../../../src/platform/network';

type TabViewState = { loading: boolean; error: string };

export default function MobileBrowserRoute() {
  const params = useLocalSearchParams<{ instanceId: string; browserTabId: string }>();
  const router = useRouter();
  const runtime = useMobileControlPlaneRuntime();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const viewRefs = useRef<Record<string, BrowserViewRef | null>>({});
  const snapshot = useSyncExternalStore(mobileBrowserTabStore.subscribe, mobileBrowserTabStore.snapshot, mobileBrowserTabStore.snapshot);
  useSyncExternalStore(mobileBrowserController.subscribe, () => mobileBrowserController.contextId(runtime.controlPlaneId || '', params.instanceId) || '', () => '');
  const instanceTabs = useMemo(
    () => snapshot.tabs.filter((candidate) => candidate.controlPlaneId === runtime.controlPlaneId && candidate.instanceId === params.instanceId),
    [params.instanceId, runtime.controlPlaneId, snapshot.tabs],
  );
  const requestedTab = instanceTabs.find((candidate) => candidate.id === params.browserTabId);
  // Keep the native views mounted while the router catches up after a tab is closed.
  const tab = requestedTab || instanceTabs.find((candidate) => candidate.id === snapshot.activeTabId) || instanceTabs[0];
  const contextId = mobileBrowserController.contextId(runtime.controlPlaneId || '', params.instanceId);
  const [addressDrafts, setAddressDrafts] = useState<Record<string, string>>({});
  const [addressFocused, setAddressFocused] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [viewStates, setViewStates] = useState<Record<string, TabViewState>>({});
  const activeViewState = tab ? viewStates[tab.id] : undefined;
  const loading = activeViewState?.loading ?? false;
  const error = activeViewState?.error || routeError;
  const tabControlPlaneId = tab?.controlPlaneId;
  const tabInstanceId = tab?.instanceId;

  useEffect(() => {
    if (!requestedTab) {
      if (tab) router.setParams({ browserTabId: tab.id });
      else router.back();
      return;
    }
    mobileBrowserTabStore.activate(tab.controlPlaneId, tab.instanceId, tab.id);
  }, [instanceTabs, requestedTab, router, snapshot.activeTabId, tab]);

  useFocusEffect(useCallback(() => {
    if (!tabControlPlaneId || !tabInstanceId || !runtime.api || !runtime.profile) return;
    let foreground = true;
    let connected = true;
    let live = true;
    let networkSignature = '';
    const reconcile = () => {
      if (foreground && connected) {
        void mobileBrowserController.activate(runtime.api!, runtime.profile!, tabInstanceId)
          .then(() => { if (live) setRouteError(''); })
          .catch((cause) => { if (live) setRouteError(cause instanceof Error ? cause.message : t('browser.createFailed')); });
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
      live = false;
      unsubscribeLifecycle();
      unsubscribeNetwork();
      void mobileBrowserController.suspend(tabControlPlaneId, tabInstanceId);
    };
  }, [runtime.api, runtime.profile, t, tabControlPlaneId, tabInstanceId]));

  if (!tab || !runtime.controlPlaneId) return null;

  const address = addressDrafts[tab.id] ?? (tab.currentUrl === 'about:blank' ? '' : tab.currentUrl);
  const setTabAddress = (tabId: string, value: string) => setAddressDrafts((current) => ({ ...current, [tabId]: value }));
  const activeView = () => viewRefs.current[tab.id];
  const navigate = () => {
    try {
      const url = normalizeBrowserAddress(address);
      setTabAddress(tab.id, url);
      setRouteError('');
      setTabViewState(tab.id, { error: '' });
      void activeView()?.loadUrl(toBrowserTransportAddress(url));
    } catch (cause) { setRouteError(cause instanceof Error ? cause.message : t('browser.addressInvalid')); }
  };
  const selectTab = (candidate: MobileBrowserTab) => {
    setRouteError('');
    mobileBrowserTabStore.activate(candidate.controlPlaneId, candidate.instanceId, candidate.id);
    router.setParams({ browserTabId: candidate.id });
  };
  const newTab = async () => {
    if (!runtime.api || !runtime.profile) return;
    try {
      const created = await mobileBrowserController.create({ api: runtime.api, profile: runtime.profile, instanceId: tab.instanceId });
      selectTab(created);
    } catch (cause) {
      setRouteError(cause instanceof Error ? cause.message : t('browser.createFailed'));
    }
  };
  const close = async () => {
    await mobileBrowserController.close(tab.controlPlaneId, tab.instanceId, tab.id);
    delete viewRefs.current[tab.id];
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
    if (next) router.setParams({ browserTabId: next.id });
    else router.back();
  };
  const setTabViewState = (tabId: string, patch: Partial<TabViewState>) => {
    setViewStates((current) => {
      const previous = current[tabId];
      return {
        ...current,
        [tabId]: { loading: previous?.loading ?? false, error: previous?.error ?? '', ...patch },
      };
    });
  };
  const tabMenuOptions: AnchoredSelectOption[] = instanceTabs.map((candidate) => ({
    label: candidate.title || t('browser.untitled'),
    description: candidate.currentUrl === 'about:blank' ? t('browser.untitled') : candidate.currentUrl,
    value: candidate.id,
  }));

  return <SafeAreaView edges={['bottom']} style={[styles.root, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ headerLargeTitle: false, title: tab.title || t('browser.browser') }} />
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.content}>
      <View style={[styles.addressRow, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
        <View style={[styles.addressField, { backgroundColor: colors.surfaceMuted }]}>
          <SystemIcon android="language" color={colors.textMuted} ios="globe" size={16} />
          <TextInput
            accessibilityLabel={t('browser.address')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onBlur={() => setAddressFocused(false)}
            onChangeText={(value) => setTabAddress(tab.id, value)}
            onFocus={() => setAddressFocused(true)}
            onSubmitEditing={navigate}
            placeholder={t('browser.addressPlaceholder')}
            placeholderTextColor={colors.textPlaceholder}
            returnKeyType="go"
            selectTextOnFocus
            style={[styles.address, { color: colors.text }]}
            value={address}
          />
          {addressFocused && address ? <Pressable accessibilityLabel={t('browser.address')} accessibilityRole="button" hitSlop={8} onPress={() => setTabAddress(tab.id, '')} style={styles.clearButton}>
            <SystemIcon android="cancel" color={colors.textMuted} ios="xmark.circle.fill" size={16} />
          </Pressable> : null}
        </View>
        <Pressable accessibilityLabel={loading ? t('browser.stop') : t('browser.reload')} accessibilityRole="button" hitSlop={8} onPress={() => loading ? activeView()?.stopLoading() : activeView()?.reload()} style={styles.iconButton}>
          <SystemIcon android={loading ? 'close' : 'refresh'} color={colors.primary} ios={loading ? 'xmark' : 'arrow.clockwise'} size={19} />
        </Pressable>
      </View>
      {loading ? <View accessibilityLiveRegion="polite" style={[styles.loadingTrack, { backgroundColor: colors.border }]}><View style={[styles.loadingIndicator, { backgroundColor: colors.primary }]} /></View> : null}
      {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { backgroundColor: colors.errorSoft, color: colors.error }]}>{error}</Text> : null}
      <View style={styles.webViewHost}>
      {contextId ? instanceTabs.map((candidate) => {
        const active = candidate.id === tab.id;
        return <View key={candidate.id} pointerEvents={active ? 'auto' : 'none'} style={[styles.webViewLayer, !active && styles.hiddenWebViewLayer]}>
          <TaskHandoffBrowserView
            contextId={contextId}
            initialUrl={toBrowserTransportAddress(candidate.currentUrl)}
            onError={({ nativeEvent }) => {
              setTabViewState(candidate.id, { loading: false, error: nativeEvent.description });
              mobileBrowserTabStore.update(candidate.controlPlaneId, candidate.instanceId, candidate.id, { loading: false });
            }}
            onLoadingChange={({ nativeEvent }) => {
              setTabViewState(candidate.id, { loading: nativeEvent.loading, ...(nativeEvent.loading ? { error: '' } : {}) });
              mobileBrowserTabStore.update(candidate.controlPlaneId, candidate.instanceId, candidate.id, { loading: nativeEvent.loading });
            }}
            onNavigationStateChange={({ nativeEvent }) => {
              const displayUrl = nativeEvent.url === 'about:blank' ? nativeEvent.url : fromBrowserTransportAddress(nativeEvent.url);
              mobileBrowserTabStore.update(candidate.controlPlaneId, candidate.instanceId, candidate.id, { currentUrl: displayUrl, title: nativeEvent.title });
              setTabAddress(candidate.id, displayUrl === 'about:blank' ? '' : displayUrl);
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
        }) : <ActivityIndicator style={styles.loading} />}
      </View>
      <View style={[styles.toolbar, { borderTopColor: colors.border, backgroundColor: colors.surface }]}>
        <View style={styles.toolbarSlot}><ToolbarButton label={t('browser.back')} onPress={() => activeView()?.goBack()}><SystemIcon android="arrow_back" color={colors.text} ios="chevron.left" /></ToolbarButton></View>
        <View style={styles.toolbarSlot}><ToolbarButton label={t('browser.forward')} onPress={() => activeView()?.goForward()}><SystemIcon android="arrow_forward" color={colors.text} ios="chevron.right" /></ToolbarButton></View>
        <View style={styles.toolbarSlot}><ToolbarButton label={t('browser.new')} onPress={() => { void newTab(); }}><SystemIcon android="add" color={colors.text} ios="plus" /></ToolbarButton></View>
        <View style={styles.toolbarSlot}><NewSessionContextMenu cancelLabel={t('common.cancel')} onSelect={(value) => {
            const candidate = instanceTabs.find((entry) => entry.id === value);
            if (candidate) selectTab(candidate);
          }} options={tabMenuOptions} selectedValue={tab.id} title={t('browser.browser')}>
            {(onPress) => <ToolbarButton label={`${instanceTabs.length} ${t('browser.browser')}`} onPress={onPress}>
              <View style={[styles.tabCount, { borderColor: colors.text, backgroundColor: colors.surface }]}><Text style={[styles.tabCountText, { color: colors.text }]}>{instanceTabs.length}</Text></View>
            </ToolbarButton>}
          </NewSessionContextMenu></View>
        <View style={styles.toolbarSlot}><ToolbarButton label={t('browser.close')} onPress={() => { void close(); }}><SystemIcon android="close" color={colors.text} ios="xmark" /></ToolbarButton></View>
      </View>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

function ToolbarButton({ children, label, onPress }: { children: React.ReactNode; label: string; onPress?: () => void }) {
  return <Pressable accessibilityLabel={label} accessibilityRole="button" disabled={!onPress} hitSlop={8} onPress={onPress} style={[styles.toolbarButton, !onPress && styles.disabledButton]}>{children}</Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, content: { flex: 1 }, addressRow: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 6, padding: 8 },
  addressField: { alignItems: 'center', borderRadius: 9, flex: 1, flexDirection: 'row', gap: 6, minHeight: 38, paddingHorizontal: 10 }, address: { flex: 1, fontSize: 15, height: 38, paddingHorizontal: 0 }, clearButton: { alignItems: 'center', height: 28, justifyContent: 'center', width: 28 }, iconButton: { alignItems: 'center', height: 38, justifyContent: 'center', width: 38 },
  loadingTrack: { height: 2, overflow: 'hidden' }, loadingIndicator: { height: 2, width: '35%' },
  error: { fontSize: 12, lineHeight: 17, paddingHorizontal: 12, paddingVertical: 7 }, webViewHost: { flex: 1, position: 'relative' },
  webViewLayer: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 }, hiddenWebViewLayer: { opacity: 0 }, webView: { flex: 1 }, loading: { flex: 1 },
  toolbar: { alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 58, paddingHorizontal: 6 },
  toolbarSlot: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  toolbarButton: { alignItems: 'center', height: 42, justifyContent: 'center', width: 42 },
  disabledButton: { opacity: 0.45 },
  tabCount: { alignItems: 'center', borderRadius: 5, borderWidth: 2, height: 27, justifyContent: 'center', minWidth: 27, paddingHorizontal: 4 }, tabCountText: { fontSize: 14, fontWeight: '500', lineHeight: 18 },
});
