import { act, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  ActiveAiSessionsProvider,
  useActiveAiSessionsRuntime,
  useActiveAiSessions,
  type ActiveAiSessionsDependencies,
} from '../src/ai-sessions/use-active-sessions';
import { mobileAiSessionStore } from '../src/ai-sessions/store';

const profile = {
  version: 1 as const,
  identity: {
    controlPlaneId: 'cp-provider',
    publicKeyFingerprint: `sha256:${'a'.repeat(43)}`,
    protocolVersion: '2026-08-05',
  },
  access: {
    kind: 'direct' as const,
    origin: 'https://control.example.com',
    secureSessionKey: 'session.provider',
  },
  capabilities: { authentication: 'required' as const, aiSessions: true, nodes: true, instanceBoard: true, triggers: true },
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

function Consumer({ name }: { name: string }) {
  const { controlPlaneId } = useActiveAiSessions();
  return <Text>{name}:{controlPlaneId}</Text>;
}

function RuntimeConsumer({ onRender }: { onRender(): void }) {
  onRender();
  const { controlPlaneId } = useActiveAiSessionsRuntime();
  return <Text>runtime:{controlPlaneId}</Text>;
}

function MessageCountConsumer() {
  const { state } = useActiveAiSessions();
  return <Text>messages:{Object.keys(state.messages).length}</Text>;
}

test('one root provider owns one AI session connection for multiple screens', async () => {
  const list = jest.fn().mockResolvedValue({ updatedAt: '2026-08-05T00:00:00.000Z', instances: [] });
  const connectEvents = jest.fn(() => ({ close: jest.fn() }));
  const subscribeProfiles = jest.fn(() => () => undefined);
  const runtimeRenders = jest.fn();
  const dependencies: ActiveAiSessionsDependencies = {
    activeProfile: jest.fn().mockResolvedValue(profile),
    subscribeProfiles,
    createClient: () => ({
      api: {
        auth: { session: jest.fn().mockResolvedValue({ authenticated: true }) },
        aiSessions: { list },
      },
      transport: { revalidate: jest.fn().mockResolvedValue(undefined), connectEvents },
    }) as unknown as ReturnType<ActiveAiSessionsDependencies['createClient']>,
    subscribeLifecycle: (listener) => { listener('active'); return () => undefined; },
    subscribeNetwork: (listener) => { listener({ connected: true, internetReachable: true, type: 'wifi' }); return () => undefined; },
  };
  const screen = await render(
    <ActiveAiSessionsProvider dependencies={dependencies}>
      <Consumer name="inbox" />
      <Consumer name="detail" />
      <RuntimeConsumer onRender={runtimeRenders} />
      <MessageCountConsumer />
    </ActiveAiSessionsProvider>,
  );

  await waitFor(() => {
    screen.getByText('inbox:cp-provider');
    screen.getByText('detail:cp-provider');
    expect(list).toHaveBeenCalledTimes(1);
    expect(connectEvents).toHaveBeenCalledTimes(1);
  });
  expect(subscribeProfiles).toHaveBeenCalledTimes(1);
  expect(connectEvents).toHaveBeenCalledWith(expect.objectContaining({
    topics: ['ai.sessions'],
    aiSessionTransient: {
      messageDeltas: { allInstances: false, instanceIds: [] },
      timelineAllSessions: false,
      timelineSessions: [],
    },
  }));
  const stableRuntimeRenderCount = runtimeRenders.mock.calls.length;

  await act(async () => {
    mobileAiSessionStore.appendMessageDelta('cp-provider', {
      instanceId: 'instance-1', sessionId: 'session-1', providerSessionId: 'session-1',
      turnId: 'turn-1', itemId: 'item-1', delta: 'hello', generatedAt: '2026-08-05T00:01:00.000Z',
    });
  });
  await waitFor(() => screen.getByText('messages:1'));
  expect(runtimeRenders).toHaveBeenCalledTimes(stableRuntimeRenderCount);
  await screen.unmount();
  mobileAiSessionStore.clearProfile('cp-provider');
});
