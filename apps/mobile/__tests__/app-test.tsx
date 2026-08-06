import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ControlPlaneAiSessionsSchema } from '@task-handoff/control-plane-client';

import { AiSessionInbox, inboxCardContent, inboxEntries } from '../src/ai-sessions/Inbox';
import { inboxStatusMessage, matchesStatusFilter } from '../src/ai-sessions/InboxModel';

const snapshot = ControlPlaneAiSessionsSchema.parse({
  updatedAt: '2026-08-05T00:02:00.000Z',
  instances: [{
    instanceId: 'instance-1',
    streamId: 'stream-1',
    revision: 1,
    aiSessions: {
      runningCount: 1,
      waitingCount: 1,
      staleCount: 0,
      updatedAt: '2026-08-05T00:02:00.000Z',
      sessions: [
        { id: 'running', agent: 'codex', status: 'running', phase: 'responding', title: 'Build mobile', startedAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:08:00.000Z', unread: true, turns: [{ id: 'running-turn', userPrompt: 'Build mobile', status: 'running', revision: 1, startedAt: '2026-08-05T00:02:00.000Z', updatedAt: '2026-08-05T00:08:00.000Z' }, { id: 'older-turn-returned-last', userPrompt: 'Older prompt', status: 'completed', revision: 1, startedAt: '2026-08-05T00:00:30.000Z', updatedAt: '2026-08-05T00:01:00.000Z' }] },
        { id: 'approval', agent: 'claude', status: 'waiting', phase: 'approval', title: 'Approve change', startedAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:09:00.000Z', unread: false, turns: [{ id: 'approval-turn', userPrompt: 'Approve change', status: 'waiting', revision: 1, startedAt: '2026-08-05T00:01:00.000Z', updatedAt: '2026-08-05T00:09:00.000Z' }] },
      ],
    },
  }],
});

describe('<InboxRoute />', () => {
  test('renders the mobile Control Plane entry point', async () => {
    const screen = await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, right: 0, bottom: 34, left: 0 },
        }}
      >
        <AiSessionInbox state={{ controlPlaneId: 'cp-1', messages: {}, snapshot, sync: { phase: 'ready' } }} />
      </SafeAreaProvider>,
    );

    expect(screen.toJSON()).not.toBeNull();
    expect(inboxEntries(snapshot).map((entry) => inboxCardContent(entry.session))).toEqual([
      expect.objectContaining({ prompt: 'Build mobile', turnCount: 2, turnIndex: 1 }),
      expect.objectContaining({ prompt: 'Approve change', turnCount: 1, turnIndex: 0 }),
    ]);
  });

  test('sorts by the latest user message despite status and later assistant activity', async () => {
    expect(inboxEntries(snapshot).map((entry) => entry.session.id)).toEqual(['running', 'approval']);
    expect(inboxStatusMessage({ phase: 'offline' })).toBe('Offline — showing the latest cached snapshot.');
  });

  test('filters sessions through the normalized all, node, and instance scopes', () => {
    const instanceNodes = new Map([['instance-1', 'node-1']]);
    expect(inboxEntries(snapshot, { kind: 'node', nodeId: 'node-1' }, instanceNodes)).toHaveLength(2);
    expect(inboxEntries(snapshot, { kind: 'node', nodeId: 'node-2' }, instanceNodes)).toHaveLength(0);
    expect(inboxEntries(snapshot, { kind: 'instance', instanceId: 'instance-1' }, instanceNodes)).toHaveLength(2);
    expect(inboxEntries(snapshot, { kind: 'instance', instanceId: 'instance-2' }, instanceNodes)).toHaveLength(0);
  });

  test('card projects the latest turn prompt and response and filters by status', async () => {
    const running = snapshot.instances[0].aiSessions.sessions[0];
    expect(inboxCardContent({ ...running, cwd: '/workspace/mobile', turns: [
      { id: 'one', userPrompt: 'Old prompt', lastMessage: 'Old response', status: 'completed', revision: 1 },
      { id: 'two', userPrompt: 'Current prompt', lastMessage: 'Current response', status: 'running', revision: 2 },
    ] })).toEqual(expect.objectContaining({ prompt: 'Current prompt', response: 'Current response', turnCount: 2, turnIndex: 1 }));
    expect(inboxCardContent({ ...running, turns: [
      { id: 'two', userPrompt: 'Current prompt', status: 'running', revision: 2 },
    ] }, [
      { instanceId: 'instance-1', sessionId: running.id, turnId: 'two', itemId: 'item-z', receivedText: 'Earlier assistant message', status: 'complete', updatedAt: running.updatedAt },
      { instanceId: 'instance-1', sessionId: running.id, turnId: 'two', itemId: 'item-a', receivedText: 'New assistant message', status: 'streaming', updatedAt: running.updatedAt },
    ])).toEqual(expect.objectContaining({ response: 'New assistant message' }));
    expect(snapshot.instances[0].aiSessions.sessions.filter((session) => matchesStatusFilter(session, 'active')).map((session) => session.id)).toEqual(['running']);
    expect(snapshot.instances[0].aiSessions.sessions.filter((session) => matchesStatusFilter(session, 'waiting')).map((session) => session.id)).toEqual(['approval']);
  });
});
