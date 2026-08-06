import { useCallback, useEffect, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';

import { SessionWorkspace } from '../../../src/ai-sessions/SessionWorkspace';
import type { SessionDetailMode } from '../../../src/ai-sessions/SessionDetail';
import { MobileAiSessionActionCoordinator } from '../../../src/ai-sessions/actions';
import { useActiveAiSessions } from '../../../src/ai-sessions/use-active-sessions';
import { createDirectControlPlaneClient } from '../../../src/control-plane/client';
import { mobileDraftStore, mobilePermissionStore, mobileProfileStore, mobileSecureStore } from '../../../src/control-plane/runtime';
import { mobileAiSessionStore } from '../../../src/ai-sessions/store';
import { useActiveDirectories } from '../../../src/directories/use-directories';
import { useMobileTheme } from '../../../src/components/theme';
import { useI18n } from '../../../src/i18n';

const supportsScrollEdgeEffects = Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;

export default function SessionDetailRoute() {
  const params = useLocalSearchParams<{ instanceId: string; sessionId: string }>();
  const { controlPlaneId, state } = useActiveAiSessions();
  const directories = useActiveDirectories();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const session = controlPlaneId ? mobileAiSessionStore.session(controlPlaneId, params.instanceId, params.sessionId) : undefined;
  const messages = Object.values(state.messages).filter((message) => message.instanceId === params.instanceId && message.sessionId === params.sessionId);
  const [actions, setActions] = useState<MobileAiSessionActionCoordinator>();
  const [client, setClient] = useState<ReturnType<typeof createDirectControlPlaneClient>['api']>();
  const [detailMode, setDetailMode] = useState<SessionDetailMode>('turn');
  const defaultPermissionMode = directories.controlPlaneId === controlPlaneId
    ? directories.state.instances.find((instance) => instance.id === params.instanceId)?.config.defaultCodexPermissionMode
    : undefined;
  useEffect(() => {
    let live = true;
    void mobileProfileStore.active().then((profile) => {
      if (!live || !profile || profile.identity.controlPlaneId !== controlPlaneId) return;
      const api = createDirectControlPlaneClient(profile, mobileSecureStore).api;
      setClient(api);
      setActions(new MobileAiSessionActionCoordinator(controlPlaneId, api, mobileAiSessionStore));
    });
    return () => { live = false; };
  }, [controlPlaneId]);
  const markVisible = useCallback((sessionUpdatedAt: string) => {
    if (!controlPlaneId || !session?.unread) return;
    void mobileProfileStore.active().then(async (profile) => {
      if (!profile || profile.identity.controlPlaneId !== controlPlaneId) return;
      const { api } = createDirectControlPlaneClient(profile, mobileSecureStore);
      const unread = await api.aiSessions.markRead(params.instanceId, params.sessionId, sessionUpdatedAt);
      mobileAiSessionStore.applyUnread(controlPlaneId, unread);
    }).catch(() => undefined);
  }, [controlPlaneId, params.instanceId, params.sessionId, session?.unread]);
  return <>
    <Stack.Screen options={{
      title: session?.title || session?.agent || 'AI Session',
      ...(Platform.OS === 'ios' ? {
        headerStyle: { backgroundColor: 'transparent' },
        headerTransparent: true,
        ...(supportsScrollEdgeEffects
          ? { scrollEdgeEffects: { top: 'soft' as const } }
          : { headerBlurEffect: 'systemMaterial' as const }),
      } : undefined),
      headerRight: () => (
        <Pressable
          accessibilityLabel={t('sessions.sessionViewMode')}
          accessibilityRole="button"
          onPress={() => setDetailMode((current) => current === 'turn' ? 'conversation' : 'turn')}
          style={({ pressed }) => [styles.modeButton, { backgroundColor: colors.surfaceMuted }, pressed && styles.modeButtonPressed]}
        >
          <Text style={[styles.modeButtonText, { color: colors.primary }]}>{detailMode === 'turn' ? t('sessions.turn') : t('sessions.filterAll')}</Text>
        </Pressable>
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
    syncPhase={state.sync.phase}
    />
  </>;
}

const styles = StyleSheet.create({
  modeButton: { alignItems: 'center', borderRadius: 15, justifyContent: 'center', minHeight: 30, minWidth: 54, paddingHorizontal: 10 },
  modeButtonPressed: { opacity: 0.65 },
  modeButtonText: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
});
