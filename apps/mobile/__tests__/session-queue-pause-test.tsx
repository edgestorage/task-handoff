import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { Pause, Play } from 'lucide-react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ControlPlaneAiSessionSummarySchema, type ControlPlaneClient } from '@task-handoff/control-plane-client';
import { ControlPlaneInstanceDirectoryCapabilitiesSchema } from '@task-handoff/protocol/control-plane-directory';
import { StoryDecisionSchema } from '@task-handoff/protocol/stories';

import { queuePauseIcon, SessionWorkspace } from '../src/ai-sessions/SessionWorkspace';
import type { MobileAiSessionActionCoordinator } from '../src/ai-sessions/actions';
import { MobileToastProvider } from '../src/components/MobileToast';

const session = ControlPlaneAiSessionSummarySchema.parse({
  id: 'session-1',
  agent: 'codex',
  storyId: 'story-1',
  title: 'Queued session',
  status: 'running',
  phase: 'responding',
  turns: [{ id: 'turn-1', userPrompt: 'Ship it', status: 'running', phase: 'responding', revision: 1, startedAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:01:00.000Z' }],
  queue: {
    revision: 4,
    pendingCount: 1,
    items: [{ id: 'queue-1', message: 'follow up', attachments: [], references: [], status: 'queued', createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:01:00.000Z' }],
  },
  startedAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:01:00.000Z',
});

const queuePauseCapabilities = ControlPlaneInstanceDirectoryCapabilitiesSchema.parse({
  aiSessionQueuePause: true,
  aiSessionProviders: [{ agent: 'codex', actions: {}, timeline: {} }],
});

function client(overrides: Partial<ControlPlaneClient['stories']> = {}) {
  return {
    aiSessions: { list: jest.fn().mockResolvedValue({ updatedAt: session.updatedAt, instances: [] }) },
    stories: {
      listDecisions: jest.fn().mockResolvedValue({ decisions: [] }),
      decideStory: jest.fn().mockResolvedValue({}),
      cancelDecision: jest.fn().mockResolvedValue({}),
      ...overrides,
    },
  } as unknown as ControlPlaneClient;
}

function actions(pauseQueue: jest.Mock) {
  return {
    subscribe: () => () => undefined,
    state: () => ({ phase: 'idle' as const }),
    approval: jest.fn(),
    interrupt: jest.fn(),
    pauseQueue,
    queue: jest.fn(),
    send: jest.fn(),
    editQueue: jest.fn(),
    reorderQueue: jest.fn(),
  } as unknown as MobileAiSessionActionCoordinator;
}

async function renderWorkspace(props: Partial<Parameters<typeof SessionWorkspace>[0]> = {}) {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
      <MobileToastProvider>
        <SessionWorkspace controlPlaneId="cp" instanceId="instance" messages={[]} session={session} {...props} />
      </MobileToastProvider>
    </SafeAreaProvider>,
  );
}

test('queue pause control mirrors the queue state as an icon action', () => {
  expect(queuePauseIcon(false)).toBe(Pause);
  expect(queuePauseIcon(true)).toBe(Play);
});

test('pauses the queue only when the instance declares the capability', async () => {
  const pauseQueue = jest.fn().mockResolvedValue({ disposition: 'accepted', result: {} });
  const withoutCapability = await renderWorkspace({ actions: actions(pauseQueue) });
  expect(withoutCapability.queryByRole('button', { name: 'Pause queue' })).toBeNull();
  expect(withoutCapability.getByText('Queued messages')).toBeTruthy();
  await withoutCapability.unmount();

  const screen = await renderWorkspace({ actions: actions(pauseQueue), instanceCapabilities: queuePauseCapabilities });
  await fireEvent.press(screen.getByRole('button', { name: 'Pause queue' }));
  await waitFor(() => expect(pauseQueue).toHaveBeenCalledWith('instance', 'session-1', true));
  await screen.unmount();
});

test('resumes a paused queue and reports the resume label', async () => {
  const pauseQueue = jest.fn().mockResolvedValue({ disposition: 'accepted', result: {} });
  const paused = ControlPlaneAiSessionSummarySchema.parse({ ...session, queue: { ...session.queue, paused: true } });
  const screen = await renderWorkspace({ actions: actions(pauseQueue), instanceCapabilities: queuePauseCapabilities, session: paused });
  await fireEvent.press(screen.getByRole('button', { name: 'Resume queue' }));
  await waitFor(() => expect(pauseQueue).toHaveBeenCalledWith('instance', 'session-1', false));
  await screen.unmount();
});

test('shows this session pending decision above the queue and submits the authoritative response', async () => {
  const decision = StoryDecisionSchema.parse({
    id: 'decision-1',
    storyId: 'story-1',
    sessionId: 'session-1',
    question: 'Approve deployment?',
    options: [{ id: 'approve', label: 'Approve' }, { id: 'hold', label: 'Hold' }],
    allowFreeText: false,
    status: 'pending',
    revision: 3,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:01:00.000Z',
  });
  const otherSessionDecision = StoryDecisionSchema.parse({ ...decision, id: 'decision-2', sessionId: 'session-2', question: 'Unrelated question?' });
  const decideStory = jest.fn().mockResolvedValue({ ...decision, status: 'decided', revision: 4, selectedOptionId: 'approve' });
  const screen = await renderWorkspace({ client: client({ listDecisions: jest.fn().mockResolvedValue({ decisions: [decision, otherSessionDecision] }), decideStory }), nodeId: 'node-1' });

  await waitFor(() => screen.getByText('Approve deployment?'));
  expect(screen.queryByText('Unrelated question?')).toBeNull();
  // 决策优先于排队信息展示在对话框上方。
  expect(within(screen.getByTestId('session-actions')).getAllByTestId(/^(session-decisions|queued-message-list)$/).map((node) => node.props.testID))
    .toEqual(['session-decisions', 'queued-message-list']);
  await fireEvent.press(screen.getByRole('radio', { name: 'Approve' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Submit decision' }));
  await waitFor(() => expect(decideStory).toHaveBeenCalledWith('story-1', 'decision-1', 'node-1', { expectedRevision: 3, optionId: 'approve' }));
  await waitFor(() => expect(screen.queryByText('Approve deployment?')).toBeNull());
  await screen.unmount();
});

test('keeps a decision out of the session prompt when the node cannot resolve it yet', async () => {
  const decideStory = jest.fn();
  const screen = await renderWorkspace({ client: client({ listDecisions: jest.fn().mockRejectedValue(new Error('unsupported')), decideStory }), nodeId: 'node-1' });
  await waitFor(() => expect(screen.queryByText('Approve deployment?')).toBeNull());
  expect(decideStory).not.toHaveBeenCalled();
  await screen.unmount();
});
