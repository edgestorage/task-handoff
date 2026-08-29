import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useFocusEffect, useIsFocused, useLocalSearchParams, useRouter, type Href } from 'expo-router';

import { TaskHandoffBrowserView, type BrowserViewRef } from '../../../modules/task-handoff-browser/src';
import { mobileBrowserController } from '../../../src/browser/controller';
import { mobileBrowserTabStore } from '../../../src/browser/store';
import { normalizeBrowserAddress } from '../../../src/browser/url';
import { SystemIcon } from '../../../src/components/SystemIcon';
import { useMobileTheme } from '../../../src/components/theme';
import { useMobileControlPlaneRuntime } from '../../../src/control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../../../src/i18n';
import { subscribeToAppLifecycle } from '../../../src/platform/lifecycle';
import { subscribeToNetworkState } from '../../../src/platform/network';

export default function MobileBrowserRoute() {
  const params = useLocalSearchParams<{ instanceId: string; browserTabId: string }>();
  const router = useRouter();
  const runtime = useMobileControlPlaneRuntime();
  const focused = useIsFocused();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const viewRef = useRef<BrowserViewRef>(null);
  const snapshot = useSyncExternalStore(mobileBrowserTabStore.subscribe, mobileBrowserTabStore.snapshot, mobileBrowserTabStore.snapshot);
  useSyncExternalStore(mobileBrowserController.subscribe, () => mobileBrowserController.contextId(runtime.controlPlaneId || '', params.instanceId) || '', () => '');
  const tab = snapshot.tabs.find((candidate) => candidate.controlPlaneId === runtime.controlPlaneId && candidate.instanceId === params.instanceId && candidate.id === params.browserTabId);
  const contextId = mobileBrowserController.contextId(runtime.controlPlaneId || '', params.instanceId);
  const [address, setAddress] = useState(tab?.currentUrl === 'about:blank' ? '' : tab?.currentUrl || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const tabControlPlaneId = tab?.controlPlaneId;
  const tabInstanceId = tab?.instanceId;

  useEffect(() => { if (!tab) router.back(); }, [router, tab]);
  useFocusEffect(useCallback(() => {
    if (!tabControlPlaneId || !tabInstanceId || !runtime.api || !runtime.profile) return;
    let foreground = true;
    let connected = true;
    let networkSignature = '';
    const reconcile = () => {
      if (foreground && connected) void mobileBrowserController.activate(runtime.api!, runtime.profile!, tabInstanceId).catch((cause) => setError(cause instanceof Error ? cause.message : t('browser.createFailed')));
      else void mobileBrowserController.suspend(tabControlPlaneId, tabInstanceId);
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
    return () => { unsubscribeLifecycle(); unsubscribeNetwork(); };
  }, [runtime.api, runtime.profile, t, tabControlPlaneId, tabInstanceId]));
  if (!tab || !runtime.controlPlaneId) return null;

  const navigate = () => {
    try {
      const url = normalizeBrowserAddress(address);
      setAddress(url);
      setError('');
      void viewRef.current?.loadUrl(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('browser.addressInvalid')); }
  };
  const close = async () => {
    await mobileBrowserController.close(tab.controlPlaneId, tab.instanceId, tab.id);
    router.back();
  };

  return <SafeAreaView edges={['bottom']} style={[styles.root, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ headerLargeTitle: false, title: tab.title || t('browser.browser') }} />
    <View style={[styles.addressRow, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
      <TextInput
        accessibilityLabel={t('browser.address')}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onChangeText={setAddress}
        onSubmitEditing={navigate}
        placeholder={t('browser.addressPlaceholder')}
        placeholderTextColor={colors.textPlaceholder}
        returnKeyType="go"
        selectTextOnFocus
        style={[styles.address, { backgroundColor: colors.surfaceMuted, color: colors.text }]}
        value={address}
      />
      <Pressable accessibilityLabel={loading ? t('browser.stop') : t('browser.reload')} accessibilityRole="button" hitSlop={8} onPress={() => loading ? viewRef.current?.stopLoading() : viewRef.current?.reload()} style={styles.iconButton}>
        <SystemIcon android={loading ? 'close' : 'refresh'} color={colors.primary} ios={loading ? 'xmark' : 'arrow.clockwise'} size={19} />
      </Pressable>
    </View>
    {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { backgroundColor: colors.errorSoft, color: colors.error }]}>{error}</Text> : null}
    <View style={styles.webView}>
      {contextId && focused ? <TaskHandoffBrowserView
        contextId={contextId}
        initialUrl={tab.currentUrl}
        onError={({ nativeEvent }) => { setLoading(false); setError(nativeEvent.description); }}
        onLoadingChange={({ nativeEvent }) => setLoading(nativeEvent.loading)}
        onNavigationStateChange={({ nativeEvent }) => {
          mobileBrowserTabStore.update(tab.controlPlaneId, tab.instanceId, tab.id, { currentUrl: nativeEvent.url, title: nativeEvent.title });
          setAddress(nativeEvent.url === 'about:blank' ? '' : nativeEvent.url);
        }}
        onNewWindow={({ nativeEvent }) => {
          if (!runtime.api || !runtime.profile) return;
          void mobileBrowserController.create({ api: runtime.api, profile: runtime.profile, instanceId: tab.instanceId, initialUrl: nativeEvent.url }).then((created) => {
            router.push(`/browser/${encodeURIComponent(created.instanceId)}/${encodeURIComponent(created.id)}` as Href);
          }).catch((cause) => setError(cause instanceof Error ? cause.message : t('browser.createFailed')));
        }}
        ref={viewRef}
        style={styles.webView}
      /> : <ActivityIndicator style={styles.loading} />}
    </View>
    <View style={[styles.toolbar, { borderTopColor: colors.border, backgroundColor: colors.surface }]}>
      <ToolbarButton label={t('browser.back')} onPress={() => viewRef.current?.goBack()}><SystemIcon android="arrow_back" color={colors.primary} ios="chevron.left" /></ToolbarButton>
      <ToolbarButton label={t('browser.forward')} onPress={() => viewRef.current?.goForward()}><SystemIcon android="arrow_forward" color={colors.primary} ios="chevron.right" /></ToolbarButton>
      <ScrollView contentContainerStyle={styles.tabs} horizontal showsHorizontalScrollIndicator={false}>
        {snapshot.tabs.filter((candidate) => candidate.controlPlaneId === tab.controlPlaneId && candidate.instanceId === tab.instanceId).map((candidate) => <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: candidate.id === tab.id }}
          key={candidate.id}
          onPress={() => router.replace(`/browser/${encodeURIComponent(candidate.instanceId)}/${encodeURIComponent(candidate.id)}` as Href)}
          style={[styles.tab, { backgroundColor: candidate.id === tab.id ? colors.primarySoft : colors.surfaceMuted }]}
        ><Text numberOfLines={1} style={[styles.tabText, { color: colors.text }]}>{candidate.title || t('browser.untitled')}</Text></Pressable>)}
      </ScrollView>
      <ToolbarButton label={t('browser.close')} onPress={() => { void close(); }}><SystemIcon android="close" color={colors.error} ios="xmark" /></ToolbarButton>
    </View>
  </SafeAreaView>;
}

function ToolbarButton({ children, label, onPress }: { children: React.ReactNode; label: string; onPress(): void }) {
  return <Pressable accessibilityLabel={label} accessibilityRole="button" hitSlop={8} onPress={onPress} style={styles.toolbarButton}>{children}</Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, addressRow: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 6, padding: 8 },
  address: { borderRadius: 8, flex: 1, fontSize: 15, height: 38, paddingHorizontal: 12 }, iconButton: { alignItems: 'center', height: 38, justifyContent: 'center', width: 38 },
  error: { fontSize: 12, lineHeight: 17, paddingHorizontal: 12, paddingVertical: 7 }, webView: { flex: 1 }, loading: { flex: 1 },
  toolbar: { alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 50, paddingHorizontal: 6 },
  toolbarButton: { alignItems: 'center', height: 42, justifyContent: 'center', width: 42 }, tabs: { alignItems: 'center', gap: 6, paddingHorizontal: 6 },
  tab: { borderRadius: 6, justifyContent: 'center', maxWidth: 140, minHeight: 32, minWidth: 72, paddingHorizontal: 10 }, tabText: { fontSize: 12, lineHeight: 17 },
});
