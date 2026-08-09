import { useCallback, useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, Pressable, StyleSheet } from 'react-native';
import * as Crypto from 'expo-crypto';
import { MenuView, type MenuAction } from '@expo/ui/community/menu';

import { SessionWorkspace } from '../../../src/ai-sessions/SessionWorkspace';
import type { SessionDetailMode } from '../../../src/ai-sessions/SessionDetail';
import { mobileAiSessionBusyKey } from '../../../src/ai-sessions/actions';
import { useActiveAiSessionView, useActiveAiSessionsRuntime } from '../../../src/ai-sessions/use-active-sessions';
import { mobileDraftStore, mobilePermissionStore } from '../../../src/control-plane/runtime';
import { mobileAiSessionStore } from '../../../src/ai-sessions/store';
import { useActiveDirectories } from '../../../src/directories/use-directories';
import { useMobileTheme } from '../../../src/components/theme';
import { SystemIcon } from '../../../src/components/SystemIcon';
import { useI18n } from '../../../src/i18n';
import { useTaskStatusSettings } from '../../../src/task-status/settings';
import { useActiveTriggers } from '../../../src/triggers/use-active-triggers';

export default function SessionDetailRoute() {
  const params = useLocalSearchParams<{ instanceId: string; sessionId: string }>();
  const router = useRouter();
  const { actions, client, controlPlaneId } = useActiveAiSessionsRuntime();
  const directories = useActiveDirectories();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const taskStatus = useTaskStatusSettings();
  const triggers = useActiveTriggers();
  const sessionView = useActiveAiSessionView(controlPlaneId, params.instanceId, params.sessionId);
  const session = sessionView.session;
  const messages = sessionView.messages;
  const [detailMode, setDetailMode] = useState<SessionDetailMode>('turn');
  const [closing, setClosing] = useState(false);
  const defaultPermissionMode = directories.controlPlaneId === controlPlaneId
    ? directories.state.instances.find((instance) => instance.id === params.instanceId)?.config.defaultCodexPermissionMode
    : undefined;
  const markVisible = useCallback((sessionUpdatedAt: string) => {
    if (!client || !controlPlaneId || !session?.unread) return;
    void client.aiSessions.markRead(params.instanceId, params.sessionId, sessionUpdatedAt).then((unread) => {
      mobileAiSessionStore.applyUnread(controlPlaneId, unread);
    }).catch(() => undefined);
  }, [client, controlPlaneId, params.instanceId, params.sessionId, session?.unread]);
  const title = session?.title || session?.agent || 'AI Session';
  const trackedSession = taskStatus.trackedSession;
  const trackedHere = Boolean(trackedSession
    && trackedSession.controlPlaneId === controlPlaneId
    && trackedSession.instanceId === params.instanceId
    && trackedSession.sessionId === params.sessionId);
  const canTrack = session?.status === 'running' || session?.status === 'waiting';
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
      void actions.close(params.instanceId, params.sessionId, Crypto.randomUUID()).then((result) => {
        if (result.disposition === 'accepted') {
          router.back();
          return;
        }
        const actionState = actions.state(mobileAiSessionBusyKey(controlPlaneId, params.instanceId, params.sessionId, 'close'));
        Alert.alert(t('sessions.closeFailed'), actionState.error);
      }).finally(() => setClosing(false));
    } },
  ]);
  return <>
    <Stack.Screen options={{
      title,
      headerRight: () => (
        <MenuView
          actions={[
            { id: 'view-turn', image: 'rectangle.stack', state: detailMode === 'turn' ? 'on' : 'off', title: t('sessions.turn') },
            { id: 'view-conversation', image: 'text.bubble', state: detailMode === 'conversation' ? 'on' : 'off', title: t('sessions.filterAll') },
            ...(liveActivityAction ? [liveActivityAction] : []),
            ...(triggers.available ? [{ id: 'triggers', image: 'bolt', title: t('triggers.sessionTitle') } as MenuAction] : []),
            { id: 'close', image: 'xmark.circle', title: closing ? t('sessions.closing') : t('sessions.closeSession'), attributes: { destructive: true, disabled: closing || !actions || sessionView.syncPhase !== 'ready' } },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === 'view-turn') setDetailMode('turn');
            else if (nativeEvent.event === 'view-conversation') setDetailMode('conversation');
            else if (nativeEvent.event === 'live-activity') {
              if (trackedHere) void taskStatus.stopTracking();
              else if (controlPlaneId) void taskStatus.startTracking({ controlPlaneId, instanceId: params.instanceId, sessionId: params.sessionId });
            }
            else if (nativeEvent.event === 'triggers') router.push({ pathname: '/sessions/[instanceId]/[sessionId]/triggers' as never, params: { instanceId: params.instanceId, sessionId: params.sessionId } });
            else if (nativeEvent.event === 'close') closeSession();
          }}
          title={t('sessions.sessionView')}
        >
          <Pressable accessibilityLabel={t('sessions.moreActions')} accessibilityRole="button" hitSlop={10} style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}>
            <SystemIcon android="more_horiz" color={colors.primary} ios="ellipsis.circle" size={23} />
          </Pressable>
        </MenuView>
      ),
    }} />
    <SessionWorkspace
    actions={actions}
    controlPlaneId={controlPlaneId || '__booting__'}
    client={client}
    drafts={mobileDraftStore}
    permissions={mobilePermissionStore}
    defaultPermissionMode={defaultPermissionMode}
    detailMode={detailMode}
    instanceId={params.instanceId}
    messages={messages}
    onVisible={markVisible}
    onDetailModeChange={setDetailMode}
    session={session}
    syncPhase={sessionView.syncPhase}
    />
  </>;
}

const styles = StyleSheet.create({
  menuButton: { alignItems: 'center', height: 34, justifyContent: 'center', width: 34 },
  menuButtonPressed: { opacity: 0.65 },
});
