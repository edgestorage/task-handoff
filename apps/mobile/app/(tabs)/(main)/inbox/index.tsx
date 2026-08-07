import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { AiSessionInbox } from '../../../../src/ai-sessions/Inbox';
import { useActiveAiSessions } from '../../../../src/ai-sessions/use-active-sessions';
import { useActiveDirectories } from '../../../../src/directories/use-directories';
import { useInstanceScope } from '../../../../src/instance-scope/use-instance-scope';

export default function InboxRoute() {
  const { actions, state } = useActiveAiSessions();
  const { state: directory } = useActiveDirectories();
  const { scope, setScope } = useInstanceScope();
  const { instanceId } = useLocalSearchParams<{ instanceId?: string }>();
  useEffect(() => { if (instanceId) setScope({ kind: 'instance', instanceId }); }, [instanceId, setScope]);
  return <AiSessionInbox actions={actions} directory={directory} initialScope={scope} state={state} onOpen={({ instanceId: targetInstanceId, sessionId }) => router.push({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId: targetInstanceId, sessionId } })} />;
}
