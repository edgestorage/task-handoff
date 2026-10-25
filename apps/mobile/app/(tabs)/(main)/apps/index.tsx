import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppSessionDetailScreen } from '../../../../src/app-sessions/AppSessionDetailScreen';
import { AppSessionList } from '../../../../src/app-sessions/AppSessionList';
import { BrowserTabList } from '../../../../src/browser/BrowserTabList';
import { BrowserTabScreen } from '../../../../src/browser/BrowserTabScreen';
import { useActiveAppSessions } from '../../../../src/app-sessions/use-active-app-sessions';
import { useMobileControlPlaneRuntime } from '../../../../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../../../../src/directories/use-directories';
import { useInstanceScope } from '../../../../src/instance-scope/use-instance-scope';
import { MasterDetailEmptyState, MasterDetailLayout, useMasterDetailBack, useMasterDetailLayout } from '../../../../src/components/MasterDetailLayout';
import { useMobileTheme } from '../../../../src/components/theme';
import { useI18n } from '../../../../src/i18n';
import {
  appSessionDetailSelection,
  browserTabDetailSelection,
  useDetailSelection,
} from '../../../../src/master-detail/selection';
import { useCompactDetailOnResize } from '../../../../src/master-detail/use-compact-detail-on-resize';

export default function AppsRoute() {
  const { closeSession, controlPlaneId, refresh, state } = useActiveAppSessions();
  const runtime = useMobileControlPlaneRuntime();
  const { state: directory } = useActiveDirectories();
  const { scope } = useInstanceScope();
  const { t } = useI18n();
  const { wide } = useMasterDetailLayout();
  const storedApp = useDetailSelection(appSessionDetailSelection);
  const storedBrowser = useDetailSelection(browserTabDetailSelection);
  const selectedApp = storedApp?.controlPlaneId === controlPlaneId ? storedApp : undefined;
  const selectedBrowser = storedBrowser?.controlPlaneId === controlPlaneId ? storedBrowser : undefined;
  const [section, setSection] = useState<'apps' | 'browser'>(storedBrowser && !storedApp ? 'browser' : 'apps');
  const previousSelection = useRef({ app: selectedApp, browser: selectedBrowser });
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { app: selectedApp, browser: selectedBrowser };
    if (selectedBrowser && selectedBrowser !== previous.browser) setSection('browser');
    else if (selectedApp && selectedApp !== previous.app) setSection('apps');
  }, [selectedApp, selectedBrowser]);
  const activeDetailHref = section === 'browser' && selectedBrowser ? {
    pathname: '/browser/[instanceId]/[browserTabId]' as const,
    params: { browserTabId: selectedBrowser.browserTabId, instanceId: selectedBrowser.instanceId },
  } : section === 'apps' && selectedApp ? {
    pathname: '/app-sessions/[instanceId]/[sessionId]' as const,
    params: { instanceId: selectedApp.instanceId, sessionId: selectedApp.sessionId },
  } : undefined;
  const hasActiveSelection = section === 'browser' ? Boolean(selectedBrowser) : Boolean(selectedApp);
  const openAppSession = (instanceId: string, sessionId: string) => {
    if (controlPlaneId) appSessionDetailSelection.set({ controlPlaneId, instanceId, sessionId });
    if (!wide) router.push({ pathname: '/app-sessions/[instanceId]/[sessionId]', params: { instanceId, sessionId } });
  };
  const openBrowserTab = (instanceId: string, browserTabId: string) => {
    if (controlPlaneId) browserTabDetailSelection.set({ browserTabId, controlPlaneId, instanceId });
    if (!wide) router.push(`/browser/${encodeURIComponent(instanceId)}/${encodeURIComponent(browserTabId)}` as never);
  };
  useCompactDetailOnResize({ enabled: hasActiveSelection, href: activeDetailHref, wide });
  useMasterDetailBack(wide, hasActiveSelection, () => {
    if (section === 'browser') browserTabDetailSelection.clear();
    else appSessionDetailSelection.clear();
  });
  const emptyDetail = <MasterDetailEmptyState
    icon={section === 'browser' ? 'globe-outline' : 'cube-outline'}
    message={t(section === 'browser' ? 'masterDetail.selectBrowserTab' : 'masterDetail.selectAppSession')}
    testID="app-session-detail-empty"
  />;
  const detail = section === 'browser'
    ? selectedBrowser ? <BrowserTabScreen
      browserTabId={selectedBrowser.browserTabId}
      instanceId={selectedBrowser.instanceId}
      key={`browser:${selectedBrowser.instanceId}:${selectedBrowser.browserTabId}`}
      onClosed={() => browserTabDetailSelection.clear()}
      onSelectTab={(tab) => browserTabDetailSelection.set({ browserTabId: tab.id, controlPlaneId: tab.controlPlaneId, instanceId: tab.instanceId })}
      pane
    /> : undefined
    : selectedApp ? <AppSessionDetailScreen
      instanceId={selectedApp.instanceId}
      key={`app:${selectedApp.instanceId}:${selectedApp.sessionId}`}
      onClosed={() => appSessionDetailSelection.clear()}
      pane
      sessionId={selectedApp.sessionId}
    /> : undefined;
  const header = <SectionTabs onChange={setSection} section={section} />;
  return <MasterDetailLayout
    detail={detail}
    emptyDetail={emptyDetail}
    list={section === 'browser'
      ? <BrowserTabList directory={directory} header={header} onOpen={openBrowserTab} scope={scope} selected={wide ? selectedBrowser : undefined} />
      : <AppSessionList
        connection={{ phase: runtime.phase, relay: runtime.profile?.access.kind === 'cloud-relay' }}
        directory={directory}
        header={header}
        onCloseSession={closeSession}
        onOpen={openAppSession}
        onRefresh={refresh}
        scope={scope}
        selected={wide ? selectedApp : undefined}
        state={state}
      />}
    testID="app-session-workbench"
  />;
}

function SectionTabs({ section, onChange }: { section: 'apps' | 'browser'; onChange(value: 'apps' | 'browser'): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [trackWidth, setTrackWidth] = useState(0);
  const [offset] = useState(() => new Animated.Value(0));
  const tabPadding = 3;
  const optionWidth = Math.max(0, (trackWidth - tabPadding * 2) / 2);
  useEffect(() => {
    if (!optionWidth) return;
    const animation = Animated.spring(offset, {
      damping: 24,
      mass: 0.75,
      stiffness: 260,
      toValue: (section === 'browser' ? 1 : 0) * optionWidth,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [offset, optionWidth, section]);
  return <View style={styles.tabsHeader}>
    <View accessibilityRole="tablist" onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)} style={[styles.tabs, { backgroundColor: colors.surfaceMuted }]}>
      {optionWidth > 0 ? <Animated.View pointerEvents="none" style={[styles.tabSelection, { backgroundColor: colors.surface, transform: [{ translateX: offset }], width: optionWidth }]} /> : null}
      {([['apps', t('nav.appSessions')], ['browser', t('browser.webSessions')]] as const).map(([value, label]) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: section === value }} key={value} onPress={() => onChange(value)} style={styles.tab}>
        <Text style={[styles.tabLabel, { color: section === value ? colors.text : colors.textMuted }]}>{label}</Text>
      </Pressable>)}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  tabsHeader: { paddingBottom: 12, paddingHorizontal: 20, paddingTop: 16 },
  tabs: { borderRadius: 999, flexDirection: 'row', padding: 3, position: 'relative', width: '100%' },
  tabSelection: { borderRadius: 999, bottom: 3, left: 3, position: 'absolute', top: 3 },
  tab: { alignItems: 'center', borderRadius: 999, flex: 1, justifyContent: 'center', minHeight: 34, paddingHorizontal: 4, zIndex: 1 },
  tabLabel: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
});
