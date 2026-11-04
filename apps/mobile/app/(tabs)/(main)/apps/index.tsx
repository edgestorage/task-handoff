import { Platform, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppSessionDetailScreen } from '../../../../src/app-sessions/AppSessionDetailScreen';
import { AppSessionList } from '../../../../src/app-sessions/AppSessionList';
import { useAppSessionInboxHeaderActions } from '../../../../src/app-sessions/use-app-session-inbox-header-actions';
import { BrowserTabList } from '../../../../src/browser/BrowserTabList';
import { BrowserTabScreen } from '../../../../src/browser/BrowserTabScreen';
import { useActiveAppSessions } from '../../../../src/app-sessions/use-active-app-sessions';
import { useMobileControlPlaneRuntime } from '../../../../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../../../../src/directories/use-directories';
import { InstanceScopeHeaderButton } from '../../../../src/instance-scope/InstanceScopeHeaderButton';
import { useInstanceScope } from '../../../../src/instance-scope/use-instance-scope';
import { useOpenInstanceDrawer } from '../../../../src/instance-scope/use-open-instance-drawer';
import { MasterDetailEmptyState, MasterDetailLayout, useMasterDetailBack, useMasterDetailLayout } from '../../../../src/components/MasterDetailLayout';
import { NativeSplitEmptyDetail } from '../../../../src/components/NativeSplitEmptyDetail';
import { iosSplitDetailHeaderOptions, iosSplitListHeaderOptions } from '../../../../src/components/navigation-header';
import { useMobileTheme } from '../../../../src/components/theme';
import { AnimatedSegmentedControl } from '../../../../src/components/AnimatedSegmentedControl';
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
  const { dark } = useMobileTheme();
  const { wide } = useMasterDetailLayout();
  const openDrawer = useOpenInstanceDrawer();
  const appHeader = useAppSessionInboxHeaderActions();
  const storedApp = useDetailSelection(appSessionDetailSelection);
  const storedBrowser = useDetailSelection(browserTabDetailSelection);
  const selectedApp = storedApp?.controlPlaneId === controlPlaneId ? storedApp : undefined;
  const selectedBrowser = storedBrowser?.controlPlaneId === controlPlaneId ? storedBrowser : undefined;
  const [sectionState, setSectionState] = useState(() => {
    const initial = storedBrowser && !storedApp ? 'browser' as const : 'apps' as const;
    return { animateFrom: initial, value: initial };
  });
  const { animateFrom: animateFromSection, value: section } = sectionState;
  const setSection = useCallback((value: 'apps' | 'browser') => {
    setSectionState((current) => current.value === value ? current : { animateFrom: current.value, value });
  }, []);
  const previousSelection = useRef({ app: selectedApp, browser: selectedBrowser });
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { app: selectedApp, browser: selectedBrowser };
    if (selectedBrowser && selectedBrowser !== previous.browser) setSection('browser');
    else if (selectedApp && selectedApp !== previous.app) setSection('apps');
  }, [selectedApp, selectedBrowser, setSection]);
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
  const detail = section === 'browser'
    ? selectedBrowser ? <BrowserTabScreen
      browserTabId={selectedBrowser.browserTabId}
      embeddedHeader={Platform.OS === 'ios' && wide}
      instanceId={selectedBrowser.instanceId}
      key={`browser:${selectedBrowser.instanceId}:${selectedBrowser.browserTabId}`}
      onClosed={() => browserTabDetailSelection.clear()}
      onSelectTab={(tab) => browserTabDetailSelection.set({ browserTabId: tab.id, controlPlaneId: tab.controlPlaneId, instanceId: tab.instanceId })}
      pane
    /> : undefined
    : selectedApp ? <AppSessionDetailScreen
      embeddedHeader={Platform.OS === 'ios' && wide}
      instanceId={selectedApp.instanceId}
      key={`app:${selectedApp.instanceId}:${selectedApp.sessionId}`}
      onClosed={() => appSessionDetailSelection.clear()}
      pane
      sessionId={selectedApp.sessionId}
    /> : undefined;
  const splitView = Platform.OS === 'ios' && wide;
  const detailTitle = section === 'browser' ? t('browser.browser') : t('nav.appSessions');
  const nativeSplitOptions = splitView ? {
    detail: iosSplitDetailHeaderOptions(dark, detailTitle),
    list: {
      ...iosSplitListHeaderOptions(dark, t('nav.appSessions')),
      headerLeft: () => <InstanceScopeHeaderButton onPress={openDrawer} />,
      unstable_headerRightItems: appHeader.headerRightItems,
    },
  } : undefined;
  const emptyDetail = nativeSplitOptions ? <NativeSplitEmptyDetail
    icon={section === 'browser' ? 'globe-outline' : 'cube-outline'}
    message={t(section === 'browser' ? 'masterDetail.selectBrowserTab' : 'masterDetail.selectAppSession')}
    testID="app-session-detail-empty"
    title={detailTitle}
  /> : <MasterDetailEmptyState
    icon={section === 'browser' ? 'globe-outline' : 'cube-outline'}
    message={t(section === 'browser' ? 'masterDetail.selectBrowserTab' : 'masterDetail.selectAppSession')}
    testID="app-session-detail-empty"
  />;
  const header = <SectionTabs animateFrom={animateFromSection} onChange={setSection} section={section} />;
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
    nativeSplitOptions={nativeSplitOptions}
    testID="app-session-workbench"
  />;
}

function SectionTabs({ animateFrom, section, onChange }: { animateFrom: 'apps' | 'browser'; section: 'apps' | 'browser'; onChange(value: 'apps' | 'browser'): void }) {
  const { t } = useI18n();
  return <View style={styles.tabsHeader}>
    <AnimatedSegmentedControl
      animateFrom={animateFrom}
      onChange={onChange}
      options={[
        { label: t('nav.appSessions'), testID: 'app-session-section-apps', value: 'apps' },
        { label: t('browser.webSessions'), testID: 'app-session-section-browser', value: 'browser' },
      ]}
      testID="app-session-section-tabs"
      value={section}
    />
  </View>;
}

const styles = StyleSheet.create({
  tabsHeader: { paddingBottom: 12, paddingHorizontal: 20, paddingTop: 16 },
});
