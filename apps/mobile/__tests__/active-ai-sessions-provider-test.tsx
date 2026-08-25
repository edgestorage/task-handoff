import { act, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  ActiveAiSessionsProvider,
  useActiveAiSessionView,
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
  detailRevision: 'detail-1',
};

const compactSession = {
  id: 'session-detail',
  providerSessionId: 'session-detail',
  creationSource: 'ai-session' as const,
  agent: 'codex' as const,
  status: 'idle' as const,
  phase: 'unknown' as const,
  startedAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
  turnCount: 1,
  queue: { revision: 0, pendingCount: 0, items: [] },
  toolCallsSinceLastMessage: 0,
  subAgentCount: 0,
  subAgents: [],
  unread: false,
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

function DetailConsumer() {
  const { controlPlaneId } = useActiveAiSessionsRuntime();
  useActiveAiSessionView(controlPlaneId, 'instance-1', 'session-1');
  return <Text>detail-mounted</Text>;
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
      <DetailConsumer />
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
      messageDeltas: { allInstances: false, instanceIds: ['instance-1'] },
      replaySince: expect.any(String),
      timelineAllSessions: false,
      timelineSessions: [{ instanceId: 'instance-1', sessionId: 'session-1' }],
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

test('selected compact session reloads detail when its authoritative revision changes', async () => {
  const list = jest.fn().mockResolvedValue({
    updatedAt: compactSession.updatedAt,
    instances: [{
      instanceId: 'instance-detail',
      streamId: 'stream-detail',
      revision: 1,
      aiSessions: { runningCount: 0, waitingCount: 0, staleCount: 0, updatedAt: compactSession.updatedAt, sessions: [{ ...compactSession, detailRevision: 'detail-1', turnsRevision: 'turns-1' }] },
    }],
  });
  const detail = jest.fn()
    .mockResolvedValue({ id: compactSession.id, queue: compactSession.queue, subAgents: [] });
  const firstTurn = { id: 'turn-1', status: 'completed' as const, phase: 'responding' as const, revision: 1, bodyRevision: 'body-1', userPrompt: 'question', lastMessage: 'answer', startedAt: compactSession.startedAt, updatedAt: compactSession.updatedAt };
  const secondTurn = { id: 'turn-2', status: 'completed' as const, phase: 'responding' as const, revision: 1, bodyRevision: 'body-2', userPrompt: 'second question', lastMessage: 'second answer', startedAt: '2026-08-05T00:01:00.000Z', updatedAt: '2026-08-05T00:01:00.000Z' };
  const turnIndex = jest.fn()
    .mockResolvedValueOnce({ sessionId: compactSession.id, revision: 'turns-1', turns: [firstTurn] })
    .mockResolvedValueOnce({ sessionId: compactSession.id, revision: 'turns-2', turns: [firstTurn, secondTurn] });
  const turnBody = jest.fn()
    .mockResolvedValueOnce({ sessionId: compactSession.id, revision: firstTurn.bodyRevision, turn: firstTurn })
    .mockResolvedValueOnce({ sessionId: compactSession.id, revision: secondTurn.bodyRevision, turn: secondTurn });
  const dependencies: ActiveAiSessionsDependencies = {
    activeProfile: jest.fn().mockResolvedValue(profile),
    subscribeProfiles: () => () => undefined,
    createClient: () => ({
      api: { auth: { session: jest.fn().mockResolvedValue({ authenticated: true }) }, aiSessions: { list, detail, turnIndex, turnBody } },
      transport: { revalidate: jest.fn().mockResolvedValue(undefined), connectEvents: () => ({ close: jest.fn() }) },
    }) as unknown as ReturnType<ActiveAiSessionsDependencies['createClient']>,
    subscribeLifecycle: (listener) => { listener('active'); return () => undefined; },
    subscribeNetwork: (listener) => { listener({ connected: true, internetReachable: true, type: 'wifi' }); return () => undefined; },
  };
  function SelectedDetail() {
    const view = useActiveAiSessionView('cp-provider', 'instance-detail', 'session-detail');
    return <Text>{view.session?.turns?.at(-1)?.lastMessage || 'loading'}</Text>;
  }

  const screen = await render(<ActiveAiSessionsProvider dependencies={dependencies}><SelectedDetail /></ActiveAiSessionsProvider>);
  await waitFor(() => screen.getByText('answer'));
  expect(detail).toHaveBeenCalledTimes(1);

  const updatedAt = '2026-08-05T00:01:00.000Z';
  await act(async () => {
    mobileAiSessionStore.replaceSnapshot('cp-provider', {
      updatedAt,
      instances: [{
        instanceId: 'instance-detail',
        streamId: 'stream-detail',
        revision: 2,
        aiSessions: {
          runningCount: 0,
          waitingCount: 0,
          staleCount: 0,
          updatedAt,
          sessions: [{ ...compactSession, updatedAt, detailRevision: 'detail-2', turnsRevision: 'turns-2' }],
        },
      }],
    });
  });
  await waitFor(() => screen.getByText('second answer'));
  expect(detail).toHaveBeenCalledTimes(2);
  expect(turnIndex).toHaveBeenCalledTimes(2);
  expect(turnBody).toHaveBeenCalledTimes(2);
  await screen.unmount();
  mobileAiSessionStore.clearProfile('cp-provider');
});
