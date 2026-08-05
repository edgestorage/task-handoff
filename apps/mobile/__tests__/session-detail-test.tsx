import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ControlPlaneAiSessionSummarySchema } from '@task-handoff/control-plane-client';

import { detailItems, SessionDetail } from '../src/ai-sessions/SessionDetail';
import { SessionWorkspace } from '../src/ai-sessions/SessionWorkspace';
import type { MobileAiSessionActionCoordinator } from '../src/ai-sessions/actions';
import { SafeMarkdown, safeMarkdownLink, sanitizeMarkdown } from '../src/components/SafeMarkdown';

const session = ControlPlaneAiSessionSummarySchema.parse({
  id: 'session-1', agent: 'codex', title: 'Long session', status: 'running', phase: 'tool',
  currentTool: { name: 'shell', inputPreview: 'pnpm test' },
  turns: [{ id: 'turn-1', userPrompt: 'Please **test** this', status: 'running', phase: 'responding', revision: 1, startedAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:01:00.000Z' }],
  subAgents: Array.from({ length: 50 }, (_, index) => ({
    threadId: `thread-${index}`, path: `root/worker-${index}`, status: index === 0 ? 'running' : 'completed',
    activity: 'interacted', message: `Worker ${index}`, updatedAt: '2026-08-05T00:01:00.000Z',
  })),
  startedAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:01:00.000Z',
});

test('detail preserves turn and streaming message identity order', () => {
  const items = detailItems(session, [{ instanceId: 'instance-1', sessionId: 'session-1', turnId: 'turn-1', itemId: 'item-1', receivedText: 'Streaming result', status: 'streaming', updatedAt: '2026-08-05T00:01:00.000Z' }]);
  expect(items.map((item) => [item.role, item.text])).toEqual([['user', 'Please **test** this'], ['assistant', 'Streaming result']]);
});

test('detail navigates one authoritative turn and applies streaming only to latest', async () => {
  const multiTurn = ControlPlaneAiSessionSummarySchema.parse({
    ...session,
    subAgents: [],
    turns: [
      { id: 'turn-1', userPrompt: 'First prompt', lastMessage: 'First response', status: 'completed', phase: 'responding', revision: 1, startedAt: session.startedAt, updatedAt: session.updatedAt },
      { id: 'turn-2', userPrompt: 'Second prompt', lastMessage: 'Snapshot response', status: 'running', phase: 'responding', revision: 2, startedAt: session.startedAt, updatedAt: session.updatedAt },
    ],
  });
  expect(detailItems(multiTurn, [{ instanceId: 'instance', sessionId: multiTurn.id, turnId: 'turn-2', itemId: 'stream', receivedText: 'Live response', status: 'streaming', updatedAt: session.updatedAt }], 0).map((item) => item.text)).toEqual(['First prompt', 'First response']);
  const screen = await render(<SessionDetail messages={[]} session={multiTurn} />);
  screen.getByText('Second prompt');
  screen.getByText('2 / 2');
  expect(screen.queryByText('Prompt')).toBeNull();
  expect(screen.queryByText('codex response')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Previous turn' }));
  await waitFor(() => screen.getByText('First prompt'));
  expect(screen.queryByText('Second prompt')).toBeNull();
  expect(screen.queryByText('shell · pnpm test')).toBeNull();
  screen.rerender(<SessionDetail messages={[]} mode="conversation" session={multiTurn} />);
  await waitFor(() => screen.getByText('Second prompt'));
  screen.getByText('First prompt');
  screen.getByText('shell · pnpm test');
  expect(screen.queryByText('Turn 1 of 2')).toBeNull();
  expect(screen.queryByText('Prompt')).toBeNull();
  expect(screen.queryByText('codex response')).toBeNull();
  screen.unmount();
});

test('safe markdown normalizes protocol text and rejects executable schemes', () => {
  expect(sanitizeMarkdown('one\r\ntwo\0')).toBe('one\ntwo\uFFFD');
  expect(safeMarkdownLink('javascript:alert(1)')).toBeUndefined();
  expect(safeMarkdownLink('file:///etc/passwd')).toBeUndefined();
  expect(safeMarkdownLink('https://example.com/docs')).toBe('https://example.com/docs');
});

test('safe markdown renders semantic headings, emphasis, lists, and code', async () => {
  const screen = await render(
    <SafeMarkdown>{'# Result\n\n**Ready**\n\n- first\n- second\n\n`inline`\n\n```ts\nconst ok = true;\n```'}</SafeMarkdown>,
  );
  screen.getByText('Result');
  screen.getByText('Ready');
  screen.getByText('first');
  screen.getByText('second');
  screen.getByText('inline');
  screen.getByText(/const ok = true/);
});

test('detail renders active tool and expands active sub-agents within the protocol bound', async () => {
  const screen = await render(<SessionDetail messages={[]} session={session} />);
  screen.getByText('shell · pnpm test');
  screen.getByText('Sub-agents (50) · Hide');
  screen.getByText('root/worker-0');
  screen.getByText('root/worker-49');
});

test('interrupted sub-agents expand and render explicit missing-field semantics', async () => {
  const interrupted = ControlPlaneAiSessionSummarySchema.parse({
    ...session,
    subAgents: [{ threadId: 'thread-interrupted', status: 'interrupted', updatedAt: '2026-08-05T00:01:00.000Z' }],
  });
  const screen = await render(<SessionDetail messages={[]} session={interrupted} />);
  screen.getByText('Sub-agents (1) · Hide');
  screen.getByText(/interrupted · activity unknown/);
  screen.getByText('No message available.');
});

test('offline detail keeps cached content visible but disables authoritative actions', async () => {
  const actionable = ControlPlaneAiSessionSummarySchema.parse({
    ...session,
    actions: { send: true, interrupt: true, approval: true },
    queue: {
      pendingCount: 1,
      items: [{ id: 'queue-1', message: 'queued work', attachments: [], references: [], status: 'failed', createdAt: session.startedAt, updatedAt: session.updatedAt, error: 'provider unavailable' }],
    },
  });
  const actions = {
    subscribe: () => () => undefined,
    state: () => ({ phase: 'idle' as const }),
    approval: jest.fn(), interrupt: jest.fn(), queue: jest.fn(), send: jest.fn(),
  } as unknown as MobileAiSessionActionCoordinator;
  const screen = await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
      <SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} syncPhase="offline" />
    </SafeAreaProvider>,
  );
  screen.getByText('Live state is unavailable. Actions are disabled until the Control Plane snapshot recovers.');
  expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'retry' })).toBeDisabled();
  screen.getByText('failed · 0 attachments · 0 references');
  screen.getByText('provider unavailable');
});

test('running composer makes draft action an explicit steer request', async () => {
  const actionable = ControlPlaneAiSessionSummarySchema.parse({ ...session, actions: { send: true, interrupt: true } });
  const send = jest.fn().mockReturnValue(new Promise(() => undefined));
  const actions = { subscribe: () => () => undefined, state: () => ({ phase: 'idle' as const }), approval: jest.fn(), interrupt: jest.fn(), queue: jest.fn(), send } as unknown as MobileAiSessionActionCoordinator;
  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}><SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} /></SafeAreaProvider>);
  screen.getByRole('button', { name: 'Stop' });
  fireEvent.changeText(screen.getByLabelText('Message'), 'Change direction');
  await waitFor(() => screen.getByRole('button', { name: 'Steer' }));
  fireEvent.press(screen.getByRole('button', { name: 'Steer' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('instance', 'session-1', 'Change direction', 'ask', [], 'steer'));
  screen.unmount();
});

test('composer expands to a multiline editor while focused', async () => {
  const actionable = ControlPlaneAiSessionSummarySchema.parse({ ...session, actions: { send: true, interrupt: true } });
  const actions = { subscribe: () => () => undefined, state: () => ({ phase: 'idle' as const }), approval: jest.fn(), interrupt: jest.fn(), queue: jest.fn(), send: jest.fn() } as unknown as MobileAiSessionActionCoordinator;
  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}><SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} /></SafeAreaProvider>);
  const input = screen.getByLabelText('Message');

  expect(StyleSheet.flatten(input.props.style).minHeight).toBe(40);
  fireEvent(input, 'focus');
  await waitFor(() => expect(StyleSheet.flatten(screen.getByLabelText('Message').props.style).minHeight).toBe(94));
  fireEvent(input, 'blur');
  await waitFor(() => expect(StyleSheet.flatten(screen.getByLabelText('Message').props.style).minHeight).toBe(40));
});
