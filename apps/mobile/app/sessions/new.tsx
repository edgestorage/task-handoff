import * as Crypto from 'expo-crypto';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';

import { NewSessionForm } from '../../src/ai-sessions/NewSessionForm';
import { initialInstanceId, instanceCreateGuidance } from '../../src/ai-sessions/new-session-types';
import { createMobileAiSession, lifecycleGuidance } from '../../src/ai-sessions/session-lifecycle';
import { createDirectControlPlaneClient } from '../../src/control-plane/client';
import { mobileCreateRequestStore, mobileProfileStore, mobileSecureStore } from '../../src/control-plane/runtime';
import { useActiveDirectories } from '../../src/directories/use-directories';

export default function NewAiSessionRoute() {
  const { instanceId: requestedInstanceId } = useLocalSearchParams<{ instanceId?: string }>();
  const { controlPlaneId, state } = useActiveDirectories();
  const [selection, setSelection] = useState<{ instanceId?: string; agent?: string; cwd?: string }>({});
  const [message, setMessage] = useState('');
  const [permissionMode, setPermissionMode] = useState<AiSessionPermissionMode>('ask');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const selectedInstanceId = state.instances.some((instance) => instance.id === selection.instanceId)
    ? selection.instanceId!
    : initialInstanceId(state.instances, requestedInstanceId);
  const selectedInstance = state.instances.find((instance) => instance.id === selectedInstanceId);
  const agent = selectedInstance?.availableAgents.some((candidate) => candidate.id === selection.agent)
    ? selection.agent!
    : selectedInstance?.availableAgents[0]?.id ?? '';
  const cwd = selection.instanceId === selectedInstanceId && selection.cwd !== undefined
    ? selection.cwd
    : selectedInstance?.workspace.path ?? '';

  const guidance = instanceCreateGuidance(selectedInstance);
  const create = async () => {
    if (!selectedInstance || !controlPlaneId || guidance) return;
    setBusy(true);
    setError(undefined);
    try {
      const profile = await mobileProfileStore.active();
      if (!profile) throw new Error('No active Control Plane.');
      const requestInput = { agent, cwd, message, permissionMode };
      const requestId = await mobileCreateRequestStore.getOrCreate(controlPlaneId, selectedInstance.id, requestInput, Crypto.randomUUID);
      const result = await createMobileAiSession(createDirectControlPlaneClient(profile, mobileSecureStore).api, {
        instance: selectedInstance,
        agent,
        cwd,
        message,
        permissionMode,
        clientRequestId: requestId,
      });
      await mobileCreateRequestStore.clear(controlPlaneId, selectedInstance.id, requestId);
      router.replace({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId: selectedInstance.id, sessionId: result.aiSessionId } });
    } catch (cause) {
      setError(lifecycleGuidance(cause).message);
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Stack.Screen options={{ title: 'New AI Session' }} />
    <NewSessionForm
      key={selectedInstance?.id || 'no-instance'}
      instances={state.instances}
      selectedInstance={selectedInstance}
      selectedInstanceId={selectedInstanceId}
      selectedAgent={agent}
      cwd={cwd}
      message={message}
      permissionMode={permissionMode}
      busy={busy}
      disabled={busy || Boolean(guidance) || !agent || !cwd.trim() || !message.trim()}
      error={error || guidance}
      onInstanceChange={(instanceId) => {
        const instance = state.instances.find((candidate) => candidate.id === instanceId);
        setSelection({ instanceId, agent: instance?.availableAgents[0]?.id, cwd: instance?.workspace.path ?? '' });
        setError(undefined);
      }}
      onAgentChange={(nextAgent) => setSelection({ instanceId: selectedInstanceId, agent: nextAgent, cwd })}
      onCwdChange={(nextCwd) => setSelection({ instanceId: selectedInstanceId, agent, cwd: nextCwd })}
      onMessageChange={setMessage}
      onPermissionModeChange={setPermissionMode}
      onCreate={() => { void create(); }}
    />
  </>;
}
