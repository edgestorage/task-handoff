import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { AiSessionDetailScreen } from '../../../../src/ai-sessions/AiSessionDetailScreen';
import { AiSessionInbox } from '../../../../src/ai-sessions/Inbox';
import { useAiSessionInboxHeaderActions } from '../../../../src/ai-sessions/use-ai-session-inbox-header';
import { useActiveAiSessions } from '../../../../src/ai-sessions/use-active-sessions';
import { MasterDetailEmptyState, MasterDetailLayout, useMasterDetailBack, useMasterDetailLayout } from '../../../../src/components/MasterDetailLayout';
import { NativeSplitEmptyDetail } from '../../../../src/components/NativeSplitEmptyDetail';
import { iosSplitDetailHeaderOptions, iosSplitListHeaderOptions } from '../../../../src/components/navigation-header';
import { useMobileTheme } from '../../../../src/components/theme';
import { useMobileControlPlaneRuntime } from '../../../../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../../../../src/directories/use-directories';
import { InstanceScopeHeaderButton } from '../../../../src/instance-scope/InstanceScopeHeaderButton';
import { useInstanceScope } from '../../../../src/instance-scope/use-instance-scope';
import { useOpenInstanceDrawer } from '../../../../src/instance-scope/use-open-instance-drawer';
import { useI18n } from '../../../../src/i18n';
import { aiSessionDetailSelection, useDetailSelection } from '../../../../src/master-detail/selection';
import { useCompactDetailOnResize } from '../../../../src/master-detail/use-compact-detail-on-resize';

export default function InboxRoute() {
  const { actions, refresh, state } = useActiveAiSessions();
  const runtime = useMobileControlPlaneRuntime();
  const { state: directory } = useActiveDirectories();
  const { scope, setScope } = useInstanceScope();
  const { t } = useI18n();
  const { dark } = useMobileTheme();
  const { wide } = useMasterDetailLayout();
  const openDrawer = useOpenInstanceDrawer();
  const inboxHeader = useAiSessionInboxHeaderActions();
  const { instanceId } = useLocalSearchParams<{ instanceId?: string }>();
  const storedSelection = useDetailSelection(aiSessionDetailSelection);
  const selected = storedSelection?.controlPlaneId === state.controlPlaneId ? storedSelection : undefined;
  useEffect(() => { if (instanceId) setScope({ kind: 'instance', instanceId }); }, [instanceId, setScope]);
  const detailHref = selected ? {
    pathname: '/sessions/[instanceId]/[sessionId]' as const,
    params: { instanceId: selected.instanceId, sessionId: selected.sessionId },
  } : undefined;
  const openSession = ({ instanceId: targetInstanceId, sessionId }: { instanceId: string; sessionId: string }) => {
    aiSessionDetailSelection.set({ controlPlaneId: state.controlPlaneId, instanceId: targetInstanceId, sessionId });
    if (!wide) router.push({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId: targetInstanceId, sessionId } });
  };
  const splitView = Platform.OS === 'ios' && wide;
  const nativeSplitOptions = splitView ? {
    detail: iosSplitDetailHeaderOptions(dark, t('nav.aiSession')),
    list: {
      ...iosSplitListHeaderOptions(dark, t('nav.aiSessions')),
      headerLeft: () => <InstanceScopeHeaderButton onPress={openDrawer} />,
      unstable_headerRightItems: inboxHeader.headerRightItems,
    },
  } : undefined;
  useCompactDetailOnResize({ enabled: Boolean(selected), href: detailHref, wide });
  useMasterDetailBack(wide, Boolean(selected), () => aiSessionDetailSelection.clear());
  return <MasterDetailLayout
    detail={selected ? <AiSessionDetailScreen
      instanceId={selected.instanceId}
      key={`${selected.instanceId}:${selected.sessionId}`}
      embeddedHeader={Boolean(nativeSplitOptions)}
      onClosed={() => aiSessionDetailSelection.clear()}
      onOpenSession={(targetInstanceId, sessionId) => aiSessionDetailSelection.set({ controlPlaneId: state.controlPlaneId, instanceId: targetInstanceId, sessionId })}
      pane
      sessionId={selected.sessionId}
    /> : undefined}
    emptyDetail={nativeSplitOptions ? <NativeSplitEmptyDetail icon="chatbubbles-outline" message={t('masterDetail.selectAiSession')} testID="ai-session-detail-empty" title={t('nav.aiSession')} /> : <MasterDetailEmptyState icon="chatbubbles-outline" message={t('masterDetail.selectAiSession')} testID="ai-session-detail-empty" />}
    list={<AiSessionInbox
      actions={actions}
      api={runtime.api}
      connection={{ phase: runtime.phase, relay: runtime.profile?.access.kind === 'cloud-relay' }}
      directory={directory}
      initialScope={scope}
      onOpen={openSession}
      onRefresh={refresh}
      selected={wide ? selected : undefined}
      state={state}
    />}
    nativeSplitOptions={nativeSplitOptions}
    testID="ai-session-workbench"
  />;
}
