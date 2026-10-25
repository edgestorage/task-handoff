import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { AiSessionInbox } from '../../../../src/ai-sessions/Inbox';
import { useActiveAiSessions } from '../../../../src/ai-sessions/use-active-sessions';
import { useMobileControlPlaneRuntime } from '../../../../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../../../../src/directories/use-directories';
import { useInstanceScope } from '../../../../src/instance-scope/use-instance-scope';

export default function InboxRoute() {
  const { actions, refresh, state } = useActiveAiSessions();
  const runtime = useMobileControlPlaneRuntime();
  const { state: directory } = useActiveDirectories();
  const { scope, setScope } = useInstanceScope();
  const { instanceId } = useLocalSearchParams<{ instanceId?: string }>();
  useEffect(() => { if (instanceId) setScope({ kind: 'instance', instanceId }); }, [instanceId, setScope]);
  return <AiSessionInbox actions={actions} connection={{ phase: runtime.phase, relay: runtime.profile?.access.kind === 'cloud-relay' }} directory={directory} initialScope={scope} state={state} onRefresh={refresh} onOpen={({ instanceId: targetInstanceId, sessionId }) => router.push({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId: targetInstanceId, sessionId } })} />;
}
