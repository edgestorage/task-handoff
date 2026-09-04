import { act, render, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { aiSessionStatusGroup, ControlPlaneAiSessionsSchema } from '@task-handoff/control-plane-client';

import { AiSessionInbox, inboxCardContent, inboxEntries } from '../src/ai-sessions/Inbox';
import { aiSessionInboxRows, inboxStatusMessage, matchesStatusFilter, statusFilterLabel } from '../src/ai-sessions/InboxModel';
import type { MobileDirectoryProfileState } from '../src/directories/store';
import { sessionActivityText } from '../src/ai-sessions/SessionDetail';
import { SessionStatusIndicator, sessionStatusTone } from '../src/ai-sessions/SessionStatusIndicator';
import { mobileLightColors } from '../src/components/theme';
import { translate } from '../src/i18n';

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
  test('pairs an empty session message with a contextual icon', async () => {
    const screen = await render(
      <AiSessionInbox state={{
        controlPlaneId: 'cp-1',
        messages: {},
        snapshot: ControlPlaneAiSessionsSchema.parse({ updatedAt: '2026-08-05T00:02:00.000Z', instances: [] }),
        sync: { phase: 'ready' },
      }} />,
    );

    expect(screen.getByText('No AI Sessions yet.')).toBeTruthy();
    expect(screen.getByTestId('empty-state-icon')).toBeTruthy();
  });

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
    expect(screen.getByTestId('swipe-action-list').props.contentInsetAdjustmentBehavior).toBe('automatic');
    const responsePreviews = screen.getAllByText('No response yet.');
    expect(responsePreviews[0].props.numberOfLines).toBe(3);
    expect(StyleSheet.flatten(responsePreviews[0].props.style).fontSize).toBe(15);
    expect(StyleSheet.flatten(responsePreviews[0].props.style).lineHeight).toBe(20);
    expect(StyleSheet.flatten(responsePreviews[0].props.style).minHeight).toBe(60);
    expect(StyleSheet.flatten(screen.getAllByTestId('session-card')[0].props.style).paddingVertical).toBe(12);
    expect(StyleSheet.flatten(screen.getAllByTestId('session-card-footer-row')[0].props.style).minHeight).toBe(18);
    expect(screen.getAllByText('Active')).toHaveLength(1);
    expect(screen.getAllByText('Waiting')).toHaveLength(1);
    expect(screen.getByTestId('session-card-footer-activity')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('tool-activity-label').props.style).fontSize).toBe(15);
    expect(StyleSheet.flatten(screen.getByTestId('tool-activity-label').props.style).lineHeight).toBe(20);
    expect(inboxEntries(snapshot).map((entry) => inboxCardContent(entry.session))).toEqual([
      expect.objectContaining({ prompt: 'Build mobile', turnCount: 2, turnIndex: 1 }),
      expect.objectContaining({ prompt: 'Approve change', turnCount: 1, turnIndex: 0 }),
    ]);
  });

  test('failed session cards preview the authoritative error without expanding the list', async () => {
    const failedSnapshot = ControlPlaneAiSessionsSchema.parse({
      updatedAt: '2026-08-05T00:02:00.000Z',
      instances: [{
        instanceId: 'instance-1',
        revision: 1,
        streamId: 'stream-1',
        aiSessions: {
          updatedAt: '2026-08-05T00:02:00.000Z',
          sessions: [{
            id: 'failed',
            agent: 'codex',
            error: 'Provider rejected the request: invalid authentication token.',
            phase: 'unknown',
            startedAt: '2026-08-05T00:00:00.000Z',
            status: 'failed',
            updatedAt: '2026-08-05T00:02:00.000Z',
          }],
        },
      }],
    });
    const screen = await render(
      <AiSessionInbox state={{ controlPlaneId: 'cp-1', messages: {}, snapshot: failedSnapshot, sync: { phase: 'ready' } }} />,
    );

    expect(screen.getByText('Provider rejected the request: invalid authentication token.').props.numberOfLines).toBe(3);
    expect(screen.queryByText('Session failed. Open the desktop app for diagnostic details.')).toBeNull();
  });

  test('pulling the inbox refreshes its authoritative snapshot and clears the indicator', async () => {
    const onRefresh = jest.fn().mockResolvedValue(undefined);
    const screen = await render(
      <AiSessionInbox onRefresh={onRefresh} state={{ controlPlaneId: 'cp-1', messages: {}, snapshot, sync: { phase: 'ready' } }} />,
    );
    const list = screen.getByTestId('swipe-action-list');

    await act(async () => { list.props.onRefresh(); });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('swipe-action-list').props.refreshing).toBe(false));
  });

  test('sorts by the latest user message despite status and later assistant activity', async () => {
    expect(inboxEntries(snapshot).map((entry) => entry.session.id)).toEqual(['running', 'approval']);
    expect(inboxStatusMessage({ phase: 'offline' })).toBe('Offline — showing the latest cached snapshot.');
  });

  test('optionally prioritizes session status using the shared Web ordering', () => {
    const entries = inboxEntries(snapshot);
    expect(aiSessionInboxRows(entries, undefined, 'none', false).filter((row) => row.type === 'session').map((row) => row.session.id)).toEqual(['running', 'approval']);
    expect(aiSessionInboxRows(entries, undefined, 'none', true).filter((row) => row.type === 'session').map((row) => row.session.id)).toEqual(['approval', 'running']);
  });

  test('groups sessions by authoritative path, instance, node, and agent identities', () => {
    const originalEntries = inboxEntries(snapshot);
    const entries = [
      { ...originalEntries[0], session: { ...originalEntries[0].session, cwd: '/work/mobile' } },
      { ...originalEntries[1], instanceId: 'instance-2', session: { ...originalEntries[1].session, cwd: '/work/server', agent: 'open-code' } },
    ];
    const directory = {
      instances: [
        { id: 'instance-1', name: 'Phone', nodeId: 'node-1' },
        { id: 'instance-2', name: 'Server', nodeId: 'node-2' },
      ],
      nodes: [
        { id: 'node-1', name: 'Local Mac' },
        { id: 'node-2', name: 'Build Node' },
      ],
    } as unknown as Pick<MobileDirectoryProfileState, 'nodes' | 'instances'>;
    const groupLabels = (groupBy: 'path' | 'instance' | 'node' | 'agent') => aiSessionInboxRows(entries, directory, groupBy, false)
      .filter((row) => row.type === 'group')
      .map((row) => [row.label, row.count]);

    expect(groupLabels('path')).toEqual([['/work/mobile', 1], ['/work/server', 1]]);
    expect(groupLabels('instance')).toEqual([['Phone', 1], ['Server', 1]]);
    expect(groupLabels('node')).toEqual([['Local Mac', 1], ['Build Node', 1]]);
    expect(groupLabels('agent')).toEqual([['Codex', 1], ['Open Code', 1]]);
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
    expect(statusFilterLabel(aiSessionStatusGroup(running))).toBe('Active');
    expect(statusFilterLabel(aiSessionStatusGroup(snapshot.instances[0].aiSessions.sessions[1]))).toBe('Waiting');
  });

  test('list and detail consume the shared Web-aligned session status tones', () => {
    expect(sessionStatusTone('active', mobileLightColors).foreground).toBe(mobileLightColors.sessionActive);
    expect(sessionStatusTone('waiting', mobileLightColors).foreground).toBe(mobileLightColors.sessionWaiting);
    expect(sessionStatusTone('problem', mobileLightColors).foreground).toBe(mobileLightColors.error);
    expect(sessionStatusTone('idle', mobileLightColors).foreground).toBe(mobileLightColors.sessionIdle);
  });

  test('renders the Web-aligned spinner only for a running session', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const screen = await render(<SessionStatusIndicator group="active" label="Running" />);

    expect(screen.getByTestId('session-status-spinner')).toBeTruthy();
    expect(screen.queryByTestId('session-status-dot')).toBeNull();

    await screen.rerender(<SessionStatusIndicator group="waiting" label="Waiting" />);
    expect(screen.queryByTestId('session-status-spinner')).toBeNull();
    expect(screen.getByTestId('session-status-dot')).toBeTruthy();
    jest.restoreAllMocks();
  });

  test('keeps the running spinner circular at the larger Story tree size', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const screen = await render(<SessionStatusIndicator group="active" label="Running" size={20} />);

    expect(StyleSheet.flatten(screen.getByTestId('session-status-spinner-arc').props.style).borderRadius).toBe(10);
    jest.restoreAllMocks();
  });

  test('card activity text uses the active locale instead of the English fallback', () => {
    const running = snapshot.instances[0].aiSessions.sessions[0];
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('zh-CN', key, params);
    expect(sessionActivityText({ ...running, phase: 'thinking', toolCallsSinceLastMessage: 2 }, t)).toBe('思考中 · 2 次工具调用');
  });
});
