import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Animated, Keyboard, PixelRatio, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ControlPlaneAiSessionSummarySchema, type ControlPlaneClient } from '@task-handoff/control-plane-client';

import { conversationDetailItems, detailItems, isSessionScrollNearBottom, SessionDetail } from '../src/ai-sessions/SessionDetail';
import { COMPOSER_BACKDROP_OPACITIES, composerBottomBackdropGeometry, moveQueueId, queueItemsWithQueuedOrder, queueListScrollEnabled, sessionKeyboardAvoidingBehavior, SessionWorkspace } from '../src/ai-sessions/SessionWorkspace';
import { MobileAiSessionActionCoordinator } from '../src/ai-sessions/actions';
import { advanceStreamingMarkdownBlocks, CHARACTER_FADE_MS, hasUnclosedMarkdownFence, initialStreamingText, SafeMarkdown, shouldAnimateMarkdownText, safeMarkdownLink, sanitizeMarkdown, StreamingMarkdownText, streamingMarkdownStableCutoff } from '../src/components/SafeMarkdown';
import { nextStreamingMarkdownCommit } from '../src/components/useStreamingMarkdown';
import { MobileAiSessionPermissionStore } from '../src/ai-sessions/permission-store';
import type { ValueStore } from '../src/platform/secure-storage';
import { MobileAiSessionStore } from '../src/ai-sessions/store';

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

function actionClient(sendMessage: jest.Mock) {
  return {
    aiSessions: {
      list: jest.fn().mockResolvedValue({ updatedAt: session.updatedAt, instances: [] }),
      sendMessage,
    },
  } as unknown as ControlPlaneClient;
}

test('detail preserves turn and streaming message identity order', () => {
  const items = detailItems(session, [{ instanceId: 'instance-1', sessionId: 'session-1', turnId: 'turn-1', itemId: 'item-1', receivedText: 'Streaming result', status: 'streaming', updatedAt: '2026-08-05T00:01:00.000Z' }]);
  expect(items.map((item) => [item.role, item.text])).toEqual([['user', 'Please **test** this'], ['assistant', 'Streaming result']]);
  expect(items[1]).toEqual(expect.objectContaining({ streamKey: 'turn-1:item-1', streaming: true }));
});

test('short detail content does not force a full viewport scroll range', async () => {
  const shortSession = ControlPlaneAiSessionSummarySchema.parse({
    ...session,
    currentTool: undefined,
    subAgents: [],
    turns: [{ ...session.turns![0], lastMessage: 'Done.', status: 'completed' }],
  });
  const screen = await render(<SessionDetail bottomInset={98} messages={[]} session={shortSession} />);
  const contentStyle = StyleSheet.flatten(screen.getByTestId('session-detail-scroll').props.contentContainerStyle);

  expect(contentStyle.flexGrow).toBeUndefined();
  expect(contentStyle.paddingBottom).toBe(114);
  screen.unmount();
});

test('detail pauses scroll following away from the bottom and resumes it from the floating action', async () => {
  const frame = jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
  const cancelFrame = jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  const screen = await render(<SessionDetail messages={[]} session={session} />);
  const list = screen.getByTestId('session-detail-scroll');

  await fireEvent(list, 'layout', { nativeEvent: { layout: { height: 500 } } });
  await fireEvent(list, 'contentSizeChange', 390, 1_200);
  await fireEvent(list, 'scrollBeginDrag');
  await fireEvent.scroll(list, {
    nativeEvent: {
      contentOffset: { x: 0, y: 300 },
      contentSize: { height: 1_200, width: 390 },
      layoutMeasurement: { height: 500, width: 390 },
    },
  });

  const resume = await screen.findByRole('button', { name: 'Scroll to latest message' });
  await fireEvent.press(resume);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Scroll to latest message' })).toBeNull());
  screen.unmount();
  frame.mockRestore();
  cancelFrame.mockRestore();
});

test('scroll following uses a bottom tolerance and treats short content as settled', () => {
  expect(isSessionScrollNearBottom({ contentHeight: 400, offsetY: 0, viewportHeight: 500 })).toBe(true);
  expect(isSessionScrollNearBottom({ contentHeight: 1_000, offsetY: 460, viewportHeight: 500 })).toBe(true);
  expect(isSessionScrollNearBottom({ contentHeight: 1_000, offsetY: 300, viewportHeight: 500 })).toBe(false);
});

test('turn mode replaces the previous assistant item when a new item starts', () => {
  const messages = [
    { instanceId: 'instance-1', sessionId: 'session-1', turnId: 'turn-1', itemId: 'item-z', receivedText: 'Earlier assistant message', status: 'complete' as const, updatedAt: '2026-08-05T00:01:00.000Z' },
    { instanceId: 'instance-1', sessionId: 'session-1', turnId: 'turn-1', itemId: 'item-a', receivedText: 'New assistant message', status: 'streaming' as const, updatedAt: '2026-08-05T00:02:00.000Z' },
  ];

  expect(detailItems(session, messages)).toEqual([
    expect.objectContaining({ role: 'user', text: 'Please **test** this' }),
    expect.objectContaining({ role: 'assistant', text: 'New assistant message', streamKey: 'turn-1:item-a', streaming: true }),
  ]);
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
  expect(conversationDetailItems(multiTurn, []).map((item) => item.id)).toEqual([
    'turn-1:user', 'turn-1:assistant', 'turn-2:user', 'turn-2:assistant',
  ]);
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

test('streaming fence detection follows CommonMark marker and closing-length rules', () => {
  expect(hasUnclosedMarkdownFence('```ts\nconst ok = true;')).toBe(true);
  expect(hasUnclosedMarkdownFence('```ts\nconst ok = true;\n```')).toBe(false);
  expect(hasUnclosedMarkdownFence('~~~~js\nconst ok = true;\n~~~')).toBe(true);
  expect(hasUnclosedMarkdownFence('~~~~js\nconst ok = true;\n~~~~')).toBe(false);
  expect(hasUnclosedMarkdownFence('``` bad`info\nplain text')).toBe(false);
});

test('streaming markdown freezes completed parser blocks and retains one mutable tail', () => {
  expect(streamingMarkdownStableCutoff('first\n\nsecond')).toBe('first\n\n'.length);
  expect(streamingMarkdownStableCutoff('- first\n\n- second')).toBe(0);
  expect(streamingMarkdownStableCutoff('[label]\n\nnext')).toBe(0);

  const initial = advanceStreamingMarkdownBlocks({
    nextId: 1,
    source: '',
    stable: [],
    tail: { id: 0, source: '' },
  }, 'first\n\nsecond');
  expect(initial).toEqual({
    nextId: 2,
    source: 'first\n\nsecond',
    stable: [{ id: 0, source: 'first\n\n' }],
    tail: { id: 1, source: 'second' },
  });
  const appended = advanceStreamingMarkdownBlocks(initial, 'first\n\nsecond\n\nthird');
  expect(appended).toEqual({
    nextId: 3,
    source: 'first\n\nsecond\n\nthird',
    stable: [{ id: 0, source: 'first\n\n' }, { id: 1, source: 'second\n\n' }],
    tail: { id: 2, source: 'third' },
  });
});

test('safe markdown renders semantic headings, emphasis, lists, and code', async () => {
  const screen = await render(
    <SafeMarkdown>{'# Result\n\n**Ready**\n\n- first\n- second\n\n`inline`\n\n```ts\nconst ok = true;\n```\n\n| Item | Status |\n| --- | --- |\n| Typecheck | Pass |'}</SafeMarkdown>,
  );
  screen.getByText('Result');
  screen.getByText('Ready');
  screen.getByText('first');
  screen.getByText('second');
  screen.getByText('inline');
  screen.getByText(/const ok = true/);
  expect(screen.getByTestId('markdown-code-scroll')).toBeTruthy();
  screen.getByText('ts');
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  expect(screen.getByTestId('markdown-table-scroll')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByText('const').props.style).color).toBe('#cf222e');
  expect(screen.getAllByTestId('markdown-list-item-content').every((item) => StyleSheet.flatten(item.props.style).flex === 0)).toBe(true);
});

test('fenced code copies raw source and confirms the action', async () => {
  const write = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
  const screen = await render(<SafeMarkdown>{'```typescript\nconst ok = true;\n```'}</SafeMarkdown>);

  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Copy' })));
  await waitFor(() => expect(write).toHaveBeenCalledWith('const ok = true;'));
  await waitFor(() => screen.getByRole('button', { name: 'Copied' }));
  screen.unmount();
  write.mockRestore();
});

test('untyped fenced code exposes a plain text language label', async () => {
  const screen = await render(<SafeMarkdown>{'```\nplain\n```'}</SafeMarkdown>);
  screen.getByText('Plain text');
  screen.unmount();
});

test('fenced code constrains its cross-axis height inside a vertical conversation', async () => {
  const screen = await render(<SafeMarkdown>{'```\nline one\nline two\nline three\n```'}</SafeMarkdown>);
  expect(StyleSheet.flatten(screen.getByTestId('markdown-code-scroll').props.style).height).toBe(Math.ceil(60 * PixelRatio.getFontScale() + 24));
  screen.unmount();
});

test('fenced code height follows the accessibility font scale', async () => {
  const fontScale = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1.5);
  const screen = await render(<SafeMarkdown>{'```\nline one\nline two\nline three\n```'}</SafeMarkdown>);
  expect(StyleSheet.flatten(screen.getByTestId('markdown-code-scroll').props.style).height).toBe(114);
  screen.unmount();
  fontScale.mockRestore();
});

test('inline code aligns its measured code baseline with the body baseline', async () => {
  const screen = await render(<SafeMarkdown>Use `StreamingMarkdownController` here.</SafeMarkdown>);
  const inlineCode = screen.getByTestId('markdown-inline-code');
  expect(StyleSheet.flatten(inlineCode.props.style)).toEqual(expect.objectContaining({
    borderRadius: 6,
    overflow: 'hidden',
    paddingHorizontal: 4,
  }));
  const inlineCodeText = screen.getByTestId('markdown-inline-code-text');
  expect(StyleSheet.flatten(inlineCodeText.props.style)).toEqual(expect.objectContaining({ fontSize: 13, lineHeight: 20 }));
  await act(async () => {
    fireEvent(screen.getByTestId('markdown-inline-code-baseline-probe'), 'textLayout', { nativeEvent: { lines: [{ ascender: 16, y: 0 }] } });
    fireEvent(inlineCodeText, 'textLayout', { nativeEvent: { lines: [{ ascender: 14.5, y: 0 }] } });
  });
  expect(StyleSheet.flatten(screen.getByTestId('markdown-inline-code').props.style).transform).toEqual([{ translateY: 1.5 }]);
  screen.unmount();
});

test('safe markdown can remove the final paragraph spacing inside message bubbles', async () => {
  const screen = await render(<SafeMarkdown trimEnd>One paragraph</SafeMarkdown>);
  const paragraph = screen.getByText('One paragraph').parent?.parent;
  expect(StyleSheet.flatten(paragraph?.props.style).marginBottom).toBe(0);
});

test('streaming text uses the Web fade duration while tables and reduced motion disable character fades', () => {
  expect(CHARACTER_FADE_MS).toBe(150);
  expect(shouldAnimateMarkdownText(true, false, ['paragraph'])).toBe(true);
  expect(shouldAnimateMarkdownText(true, false, ['td', 'tr', 'table'])).toBe(false);
  expect(shouldAnimateMarkdownText(true, true, ['paragraph'])).toBe(false);
});

test('new text nodes created during streaming run the 150ms character fade', async () => {
  const timing = jest.spyOn(Animated, 'timing').mockImplementation((_value, config) => ({
    reset: () => undefined,
    start: () => undefined,
    stop: () => undefined,
  }));
  const screen = await render(<StreamingMarkdownText animate content="World" />);

  await waitFor(() => expect(timing).toHaveBeenCalled());
  expect(timing.mock.calls.some(([, config]) => config.duration === CHARACTER_FADE_MS && config.toValue === 1 && config.useNativeDriver === false)).toBe(true);
  screen.unmount();
  timing.mockRestore();
});

test('independent character animations coalesce their completed state into one frame', async () => {
  const completions: Array<(result: { finished: boolean }) => void> = [];
  const timing = jest.spyOn(Animated, 'timing').mockImplementation(() => ({
    reset: () => undefined,
    start: (callback) => { if (callback) completions.push(callback); },
    stop: () => undefined,
  }));
  let flush: FrameRequestCallback | undefined;
  const frame = jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    flush = callback;
    return 1;
  });
  const cancelFrame = jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  const screen = await render(<Text><StreamingMarkdownText animate content="ABC" /></Text>);

  await waitFor(() => expect(completions).toHaveLength(3));
  completions.forEach((complete) => complete({ finished: true }));
  expect(timing).toHaveBeenCalledTimes(3);
  expect(frame).toHaveBeenCalledTimes(1);
  await act(async () => { flush?.(0); });
  screen.getByText('ABC');

  screen.unmount();
  timing.mockRestore();
  frame.mockRestore();
  cancelFrame.mockRestore();
});

test('streaming text resumes from persisted Markdown node content after a remount', () => {
  expect(initialStreamingText('Hello!', true, 'Hello')).toBe('Hello');
  expect(initialStreamingText('Rewritten', true, 'Old')).toBe('');
  expect(initialStreamingText('Snapshot', false, undefined)).toBe('Snapshot');
});

test('streaming markdown commits whole graphemes and resets rewrites atomically', () => {
  const target = `A👨‍👩‍👧‍👦B${'x'.repeat(100)}`;
  const first = nextStreamingMarkdownCommit('', target);
  expect(first).not.toContain('�');
  expect(first.length).toBeLessThan(target.length);
  expect(nextStreamingMarkdownCommit('old', 'replacement')).toBe('replacement');
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
      pendingCount: 2,
      items: [
        { id: 'queue-1', message: 'queued work', attachments: [], references: [], status: 'failed', createdAt: session.startedAt, updatedAt: session.updatedAt, error: 'provider unavailable' },
        { id: 'queue-2', message: 'another queued message', attachments: [], references: [], status: 'queued', createdAt: session.startedAt, updatedAt: session.updatedAt },
      ],
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
  screen.getByLabelText('Queued messages');
  screen.getByText('queued work');
  screen.getByText('another queued message');
  expect(screen.getAllByRole('button', { name: 'remove' })).toHaveLength(2);
  screen.getByText('Needs attention');
  screen.getByText('Ask');
  screen.getByText('provider unavailable');
});

test('queued messages expose edit controls and a drag handle that reorders with the authoritative revision', async () => {
  const actionable = ControlPlaneAiSessionSummarySchema.parse({
    ...session,
    actions: { send: true, interrupt: true },
    queue: {
      revision: 4,
      pendingCount: 2,
      items: [
        { id: 'queue-1', message: 'first queued message', attachments: [], references: [], status: 'queued', createdAt: session.startedAt, updatedAt: session.updatedAt },
        { id: 'queue-2', message: 'second queued message', attachments: [], references: [], status: 'queued', createdAt: session.startedAt, updatedAt: session.updatedAt },
      ],
    },
  });
  const reorderQueue = jest.fn().mockResolvedValue({ disposition: 'accepted' });
  const editQueue = jest.fn().mockResolvedValue({ disposition: 'accepted' });
  const actions = {
    subscribe: () => () => undefined,
    state: () => ({ phase: 'idle' as const }),
    approval: jest.fn(), interrupt: jest.fn(), queue: jest.fn(), send: jest.fn(), editQueue, reorderQueue,
  } as unknown as MobileAiSessionActionCoordinator;
  const screen = await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
      <SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} />
    </SafeAreaProvider>,
  );

  const handles = screen.getAllByTestId('queue-drag-handle');
  expect(handles).toHaveLength(2);
  expect(queueListScrollEnabled('queue-1')).toBe(false);
  expect(queueListScrollEnabled()).toBe(true);
  await act(async () => { fireEvent(handles[0], 'accessibilityAction', { nativeEvent: { actionName: 'increment' } }); });
  expect(reorderQueue).toHaveBeenCalledWith('instance', session.id, 4, ['queue-2', 'queue-1']);
  expect(screen.getAllByRole('button', { name: 'edit' })).toHaveLength(2);
  const composer = screen.getByTestId('session-message-input');
  await act(async () => { fireEvent.changeText(composer, 'preserved draft'); });
  await act(async () => { fireEvent.press(screen.getAllByRole('button', { name: 'edit' })[0]); });
  await waitFor(() => expect(screen.getByTestId('session-message-input').props.value).toBe('second queued message'));
  screen.getByText('Edit queued message');
  fireEvent.changeText(screen.getByTestId('session-message-input'), 'updated queued message');
  await waitFor(() => expect(screen.getByTestId('session-message-input').props.value).toBe('updated queued message'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save queued message' })).toBeEnabled());
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Save queued message' })); });
  await waitFor(() => expect(editQueue).toHaveBeenCalledWith('instance', session.id, 'queue-2', 4, 'updated queued message'));
  await waitFor(() => expect(screen.getByTestId('session-message-input').props.value).toBe('preserved draft'));
  expect(editQueue).toHaveBeenCalledTimes(1);
});

test('queue drag preview reorders queued items without moving the normalized failed group', () => {
  const items = [
    { id: 'queue-1', status: 'queued' },
    { id: 'queue-2', status: 'queued' },
    { id: 'failed-1', status: 'failed' },
  ];
  const reordered = moveQueueId(['queue-1', 'queue-2'], 0, 1);
  expect(queueItemsWithQueuedOrder(items, reordered).map((item) => item.id)).toEqual(['queue-2', 'queue-1', 'failed-1']);
});

test('running composer sends in auto mode so the authoritative runtime queues the message', async () => {
  const actionable = ControlPlaneAiSessionSummarySchema.parse({ ...session, actions: { send: true, interrupt: true } });
  const send = jest.fn().mockReturnValue(new Promise(() => undefined));
  const actions = { subscribe: () => () => undefined, state: () => ({ phase: 'idle' as const }), approval: jest.fn(), interrupt: jest.fn(), queue: jest.fn(), send } as unknown as MobileAiSessionActionCoordinator;
  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}><SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} /></SafeAreaProvider>);
  screen.getByRole('button', { name: 'Stop' });
  fireEvent.changeText(screen.getByTestId('session-message-input'), 'Change direction');
  await waitFor(() => screen.getByRole('button', { name: 'Send' }));
  fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('instance', 'session-1', 'Change direction', undefined, [], 'auto'));
  screen.unmount();
});

test('composer shows authoritative send loading and locks mutable controls until accepted', async () => {
  let resolveRequest!: (value: unknown) => void;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const sendMessage = jest.fn().mockReturnValue(request);
  const actions = new MobileAiSessionActionCoordinator('cp', actionClient(sendMessage), new MobileAiSessionStore());
  const actionable = ControlPlaneAiSessionSummarySchema.parse({ ...session, actions: { send: true, interrupt: true } });
  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}><SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} /></SafeAreaProvider>);

  fireEvent.changeText(screen.getByTestId('session-message-input'), 'Wait for the backend');
  fireEvent.press(await waitFor(() => screen.getByRole('button', { name: 'Send' })));

  await waitFor(() => screen.getByRole('button', { name: 'Sending…' }));
  expect(screen.getByTestId('session-composer-action-loading')).toBeTruthy();
  expect(screen.getByTestId('session-message-input').props.editable).toBe(false);
  expect(screen.getByRole('button', { name: 'Add attachment' }).props.accessibilityState.disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Permission mode: Ask' }).props.accessibilityState.disabled).toBe(true);
  fireEvent.press(screen.getByRole('button', { name: 'Sending…' }));
  expect(sendMessage).toHaveBeenCalledTimes(1);

  await act(async () => { resolveRequest({}); await request; });
  await waitFor(() => expect(screen.getByTestId('session-message-input').props.value).toBe(''));
  expect(screen.queryByTestId('session-composer-action-loading')).toBeNull();
  screen.unmount();
});

test('composer stops loading and preserves the draft after a failed send', async () => {
  let rejectRequest!: (cause: unknown) => void;
  const request = new Promise((_resolve, reject) => { rejectRequest = reject; });
  const actions = new MobileAiSessionActionCoordinator('cp', actionClient(jest.fn().mockReturnValue(request)), new MobileAiSessionStore());
  const actionable = ControlPlaneAiSessionSummarySchema.parse({ ...session, actions: { send: true, interrupt: true } });
  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}><SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} /></SafeAreaProvider>);

  fireEvent.changeText(screen.getByTestId('session-message-input'), 'Keep this draft');
  fireEvent.press(await waitFor(() => screen.getByRole('button', { name: 'Send' })));
  await waitFor(() => screen.getByRole('button', { name: 'Sending…' }));
  await act(async () => { rejectRequest(Object.assign(new Error('Request rejected'), { status: 400 })); await request.catch(() => undefined); });

  await waitFor(() => screen.getByRole('button', { name: 'Send' }));
  expect(screen.getByTestId('session-message-input').props.value).toBe('Keep this draft');
  expect(screen.getByTestId('session-message-input').props.editable).toBe(true);
  screen.getByText('Request rejected');
  expect(screen.queryByTestId('session-composer-action-loading')).toBeNull();
  screen.unmount();
});

test('result-unknown stops loading but keeps send disabled and the draft intact', async () => {
  let rejectRequest!: (cause: unknown) => void;
  const request = new Promise((_resolve, reject) => { rejectRequest = reject; });
  const actions = new MobileAiSessionActionCoordinator('cp', actionClient(jest.fn().mockReturnValue(request)), new MobileAiSessionStore());
  const actionable = ControlPlaneAiSessionSummarySchema.parse({ ...session, actions: { send: true, interrupt: true } });
  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}><SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} /></SafeAreaProvider>);

  fireEvent.changeText(screen.getByTestId('session-message-input'), 'Uncertain draft');
  fireEvent.press(await waitFor(() => screen.getByRole('button', { name: 'Send' })));
  await waitFor(() => screen.getByRole('button', { name: 'Sending…' }));
  await act(async () => { rejectRequest(Object.assign(new Error('Connection lost'), { code: 'DIRECT_NETWORK_FAILED', retryable: true })); await request.catch(() => undefined); });

  const sendButton = await waitFor(() => screen.getByRole('button', { name: 'Send' }));
  expect(sendButton.props.accessibilityState).toEqual(expect.objectContaining({ busy: false, disabled: true }));
  expect(screen.getByTestId('session-message-input').props.value).toBe('Uncertain draft');
  expect(screen.queryByTestId('session-composer-action-loading')).toBeNull();
  screen.getByText(/result is unknown/i);
  screen.unmount();
});

test('session composer restores its persisted permission mode before falling back to the instance default', async () => {
  const values = new Map<string, string>();
  const storage: ValueStore = {
    available: async () => true,
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
  const permissions = new MobileAiSessionPermissionStore(storage);
  await permissions.write('cp', 'instance', session.id, 'auto-review');
  const actions = { subscribe: () => () => undefined, state: () => ({ phase: 'idle' as const }), approval: jest.fn(), interrupt: jest.fn(), queue: jest.fn(), send: jest.fn() } as unknown as MobileAiSessionActionCoordinator;

  const screen = await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
      <SessionWorkspace actions={actions} controlPlaneId="cp" defaultPermissionMode="full-access" instanceId="instance" messages={[]} permissions={permissions} session={session} />
    </SafeAreaProvider>,
  );

  await waitFor(() => screen.getByRole('button', { name: 'Permission mode: Auto review' }));
  screen.unmount();
});

test('session composer lets the server apply its authoritative permission default while the directory is still loading', async () => {
  const actionable = ControlPlaneAiSessionSummarySchema.parse({ ...session, actions: { send: true, interrupt: true } });
  const send = jest.fn().mockResolvedValue({ disposition: 'accepted' });
  const actions = { subscribe: () => () => undefined, state: () => ({ phase: 'idle' as const }), approval: jest.fn(), interrupt: jest.fn(), queue: jest.fn(), send } as unknown as MobileAiSessionActionCoordinator;
  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}><SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} /></SafeAreaProvider>);

  fireEvent.changeText(screen.getByTestId('session-message-input'), 'Use the instance default');
  await waitFor(() => screen.getByRole('button', { name: 'Send' }));
  fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('instance', 'session-1', 'Use the instance default', undefined, [], 'auto'));
  screen.unmount();
});

test('composer expands to a multiline editor while focused', async () => {
  const timing = jest.spyOn(Animated, 'timing').mockImplementation(() => ({
    reset: () => undefined,
    start: (callback) => callback?.({ finished: true }),
    stop: () => undefined,
  }));
  const actionable = ControlPlaneAiSessionSummarySchema.parse({ ...session, actions: { send: true, interrupt: true } });
  const actions = { subscribe: () => () => undefined, state: () => ({ phase: 'idle' as const }), approval: jest.fn(), interrupt: jest.fn(), queue: jest.fn(), send: jest.fn() } as unknown as MobileAiSessionActionCoordinator;
  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}><SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} /></SafeAreaProvider>);
  const input = screen.getByTestId('session-message-input');

  expect(screen.getByTestId('session-composer-blur')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('session-composer').props.style).backgroundColor).toBe('transparent');
  expect(screen.queryByTestId('session-composer-tint')).toBeNull();
  expect(screen.getByTestId('session-composer').props.accessibilityState.expanded).toBe(false);
  fireEvent(input, 'focus');
  await waitFor(() => expect(screen.getByTestId('session-composer').props.accessibilityState.expanded).toBe(true));
  fireEvent(screen.getByTestId('session-message-input'), 'blur');
  await waitFor(() => expect(screen.getByTestId('session-composer').props.accessibilityState.expanded).toBe(false));
  timing.mockRestore();
});

test('touching outside the composer dismisses the keyboard', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  const actionable = ControlPlaneAiSessionSummarySchema.parse({ ...session, actions: { send: true, interrupt: true } });
  const actions = { subscribe: () => () => undefined, state: () => ({ phase: 'idle' as const }), approval: jest.fn(), interrupt: jest.fn(), queue: jest.fn(), send: jest.fn() } as unknown as MobileAiSessionActionCoordinator;
  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}><SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} /></SafeAreaProvider>);

  fireEvent(screen.getByTestId('session-content'), 'touchStart');
  expect(dismiss).toHaveBeenCalledTimes(1);
  dismiss.mockRestore();
});

test('floating composer follows the keyboard without creating an opaque layout section', async () => {
  const actionable = ControlPlaneAiSessionSummarySchema.parse({ ...session, actions: { send: true, interrupt: true } });
  const actions = { subscribe: () => () => undefined, state: () => ({ phase: 'idle' as const }), approval: jest.fn(), interrupt: jest.fn(), queue: jest.fn(), send: jest.fn() } as unknown as MobileAiSessionActionCoordinator;
  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}><SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} /></SafeAreaProvider>);

  const actionsStyle = StyleSheet.flatten(screen.getByTestId('session-actions').props.style);
  const workspaceStyle = StyleSheet.flatten(screen.getByTestId('session-workspace').props.style);
  expect(sessionKeyboardAvoidingBehavior('ios')).toBe('height');
  expect(sessionKeyboardAvoidingBehavior('android')).toBeUndefined();
  expect(actionsStyle.position).toBe('absolute');
  expect(workspaceStyle.backgroundColor).toBeUndefined();
  screen.unmount();
});

test('composer backdrop fades from 16px above the input through the safe-area bottom', () => {
  expect(COMPOSER_BACKDROP_OPACITIES).toEqual({ fade: [0, 0.8], composer: 0.8, bottom: [0.8, 1, 1] });
  expect(composerBottomBackdropGeometry(34)).toEqual({ height: 34, locations: [0, 26 / 34, 1] });
});

test('blurring the mobile composer cancels a queued message edit and restores the prior draft', async () => {
  jest.useFakeTimers();
  const actionable = ControlPlaneAiSessionSummarySchema.parse({
    ...session,
    actions: { send: true, interrupt: true },
    queue: {
      revision: 4,
      pendingCount: 1,
      items: [
        { id: 'queue-1', message: 'queued message', attachments: [], references: [], status: 'queued', createdAt: session.startedAt, updatedAt: session.updatedAt },
      ],
    },
  });
  const editQueue = jest.fn();
  const actions = {
    subscribe: () => () => undefined,
    state: () => ({ phase: 'idle' as const }),
    approval: jest.fn(), interrupt: jest.fn(), queue: jest.fn(), send: jest.fn(), editQueue, reorderQueue: jest.fn(),
  } as unknown as MobileAiSessionActionCoordinator;
  const screen = await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
      <SessionWorkspace actions={actions} controlPlaneId="cp" instanceId="instance" messages={[]} session={actionable} />
    </SafeAreaProvider>,
  );

  await act(async () => { fireEvent.changeText(screen.getByTestId('session-message-input'), 'preserved draft'); });
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'edit' })); });
  expect(screen.getByTestId('session-message-input').props.value).toBe('queued message');
  await act(async () => { fireEvent.changeText(screen.getByTestId('session-message-input'), 'discard this edit'); });
  await act(async () => { fireEvent(screen.getByTestId('session-message-input'), 'blur'); });
  expect(screen.getByTestId('session-message-input').props.value).toBe('preserved draft');
  expect(screen.queryByText('Edit queued message')).toBeNull();
  expect(editQueue).not.toHaveBeenCalled();

  screen.unmount();
  act(() => { jest.runOnlyPendingTimers(); });
  jest.useRealTimers();
});
