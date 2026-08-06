import { router, useLocalSearchParams } from 'expo-router';

import { AiSessionInbox } from '../../../src/ai-sessions/Inbox';
import { useActiveAiSessions } from '../../../src/ai-sessions/use-active-sessions';
import { mobileAiSessionStore } from '../../../src/ai-sessions/store';
import { useActiveDirectories } from '../../../src/directories/use-directories';

export default function InboxRoute() {
  const { controlPlaneId, state } = useActiveAiSessions();
  const { state: directory } = useActiveDirectories();
  const { instanceId } = useLocalSearchParams<{ instanceId?: string }>();
  return <AiSessionInbox
    directory={directory}
    initialScope={instanceId ? { kind: 'instance', instanceId } : state.scope}
    onScopeChange={(scope) => { if (controlPlaneId) mobileAiSessionStore.setScope(controlPlaneId, scope); }}
    state={state}
    onOpen={({ instanceId: targetInstanceId, sessionId }) => router.push({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId: targetInstanceId, sessionId } })}
  />;
}
