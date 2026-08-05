import { useCallback, useEffect, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';

import { SessionWorkspace } from '../../../src/ai-sessions/SessionWorkspace';
import { MobileAiSessionActionCoordinator } from '../../../src/ai-sessions/actions';
import { useActiveAiSessions } from '../../../src/ai-sessions/use-active-sessions';
import { createDirectControlPlaneClient } from '../../../src/control-plane/client';
import { mobileDraftStore, mobileProfileStore, mobileSecureStore } from '../../../src/control-plane/runtime';
import { mobileAiSessionStore } from '../../../src/ai-sessions/store';

export default function SessionDetailRoute() {
  const params = useLocalSearchParams<{ instanceId: string; sessionId: string }>();
  const { controlPlaneId, state } = useActiveAiSessions();
  const session = controlPlaneId ? mobileAiSessionStore.session(controlPlaneId, params.instanceId, params.sessionId) : undefined;
  const messages = Object.values(state.messages).filter((message) => message.instanceId === params.instanceId && message.sessionId === params.sessionId);
  const [actions, setActions] = useState<MobileAiSessionActionCoordinator>();
  const [client, setClient] = useState<ReturnType<typeof createDirectControlPlaneClient>['api']>();
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
    <Stack.Screen options={{ title: session?.title || session?.agent || 'AI Session' }} />
    <SessionWorkspace
    actions={actions}
    controlPlaneId={controlPlaneId || '__booting__'}
    client={client}
    drafts={mobileDraftStore}
    instanceId={params.instanceId}
    messages={messages}
    onVisible={markVisible}
    session={session}
    syncPhase={state.sync.phase}
    />
  </>;
}
