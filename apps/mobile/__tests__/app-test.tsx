import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { aiSessionStatusGroup, ControlPlaneAiSessionsSchema } from '@task-handoff/control-plane-client';

import { AiSessionInbox, inboxCardContent, inboxEntries } from '../src/ai-sessions/Inbox';
import { aiSessionInboxRows, aiSessionInboxSections, inboxHierarchyEntries, inboxIsAwaitingInitialSync, inboxStatusMessage, matchesStatusFilter, statusFilterLabel } from '../src/ai-sessions/InboxModel';
import { updateAiSessionInboxViewPreferences } from '../src/ai-sessions/inbox-view-preferences';
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

beforeEach(() => updateAiSessionInboxViewPreferences({
  collapsedGroupKeys: [],
  groupBy: 'none',
  layout: 'cards',
  sortByStatus: false,
}));

describe('<InboxRoute />', () => {
  test('shows loading instead of an authoritative empty state before the first snapshot arrives', async () => {
    const idle = await render(
      <AiSessionInbox
        connection={{ phase: 'verifying', relay: true }}
        state={{ controlPlaneId: 'cp-1', messages: {}, sync: { phase: 'idle' } }}
      />,
    );

    expect(idle.getByLabelText('Loading AI Sessions')).toBeTruthy();
    expect(idle.getByTestId('session-inbox-loading').props.accessibilityState).toEqual({ busy: true });
    expect(idle.getByText('Connecting to Cloud Relay')).toBeTruthy();
    expect(idle.getByText('Establishing a secure connection before syncing AI Sessions')).toBeTruthy();
    expect(idle.queryByTestId('swipe-action-list')).toBeNull();
    expect(idle.queryByText('No AI Sessions yet')).toBeNull();
    await idle.unmount();

    const loading = await render(
      <AiSessionInbox
        connection={{ phase: 'connected', relay: false }}
        state={{ controlPlaneId: 'cp-1', messages: {}, sync: { phase: 'loading' } }}
      />,
    );

    expect(loading.getByLabelText('Loading AI Sessions')).toBeTruthy();
    expect(loading.getByTestId('session-inbox-loading')).toBeTruthy();
    expect(loading.getByText('Syncing AI Sessions')).toBeTruthy();
    expect(loading.getByText('Fetching the latest AI Session snapshot')).toBeTruthy();
    expect(loading.queryByTestId('swipe-action-list')).toBeNull();
    expect(loading.queryByText('No AI Sessions yet')).toBeNull();
    expect(inboxIsAwaitingInitialSync({ sync: { phase: 'idle' } })).toBe(true);
    expect(inboxIsAwaitingInitialSync({ sync: { phase: 'loading' } })).toBe(true);
  });

  test('pairs an empty session message with a contextual icon', async () => {
    const screen = await render(
      <AiSessionInbox state={{
        controlPlaneId: 'cp-1',
        messages: {},
        snapshot: ControlPlaneAiSessionsSchema.parse({ updatedAt: '2026-08-05T00:02:00.000Z', instances: [] }),
        sync: { phase: 'ready' },
      }} />,
    );

    expect(screen.getByText('No AI Sessions yet')).toBeTruthy();
    expect(screen.getByTestId('empty-state-icon')).toBeTruthy();
    expect(inboxIsAwaitingInitialSync({ snapshot: ControlPlaneAiSessionsSchema.parse({ updatedAt: '2026-08-05T00:02:00.000Z', instances: [] }), sync: { phase: 'ready' } })).toBe(false);
  });

  test('keeps a cached session list visible while refreshing', async () => {
    const screen = await render(
      <AiSessionInbox state={{ controlPlaneId: 'cp-1', messages: {}, snapshot, sync: { phase: 'loading' } }} />,
    );

    expect(screen.queryByLabelText('Loading AI Sessions')).toBeNull();
    expect(screen.getAllByTestId('session-card')).toHaveLength(2);
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
    const responsePreviews = screen.getAllByText('No response yet');
    expect(responsePreviews[0].props.numberOfLines).toBe(3);
    expect(StyleSheet.flatten(responsePreviews[0].props.style).fontSize).toBe(15);
    expect(StyleSheet.flatten(responsePreviews[0].props.style).lineHeight).toBe(20);
    expect(StyleSheet.flatten(responsePreviews[0].props.style).minHeight).toBe(60);
    const firstCardStyle = StyleSheet.flatten(screen.getAllByTestId('session-card')[0].props.style);
    expect(firstCardStyle.paddingTop).toBe(10);
    expect(firstCardStyle.paddingBottom).toBe(12);
    expect(firstCardStyle.gap).toBe(8);
    expect(StyleSheet.flatten(screen.getAllByTestId('session-status-leading')[0].props.style)).toEqual(expect.objectContaining({ height: 14, width: 14 }));
    expect(StyleSheet.flatten(screen.getAllByTestId('session-identity')[0].props.style).gap).toBe(6);
    expect(StyleSheet.flatten(screen.getAllByTestId('session-card-footer-row')[0].props.style).minHeight).toBe(18);
    expect(screen.getAllByTestId('session-workspace-context')).toHaveLength(2);
    expect(screen.getAllByTestId('session-instance-context')).toHaveLength(2);
    expect(within(screen.getAllByTestId('session-workspace-context')[0]).getByText('instance-1')).toBeTruthy();
    expect(screen.getByTestId('ai-agent-icon-codex')).toBeTruthy();
    expect(screen.getByTestId('ai-agent-icon-claude')).toBeTruthy();
    const workspaceLabels = screen.getAllByText('Unknown workspace');
    expect(StyleSheet.flatten(workspaceLabels[0].props.style)).toEqual(expect.objectContaining({ fontSize: 13, fontWeight: '400' }));
    expect(screen.getAllByText('Active')).toHaveLength(1);
    expect(screen.getAllByText('Waiting')).toHaveLength(1);
    expect(screen.getByTestId('session-card-footer-activity')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('tool-activity-label').props.style)).toEqual(expect.objectContaining({ fontSize: 14, fontWeight: '400' }));
    expect(StyleSheet.flatten(screen.getByTestId('tool-activity-label').props.style).lineHeight).toBe(20);
    expect(inboxEntries(snapshot).map((entry) => inboxCardContent(entry.session))).toEqual([
      expect.objectContaining({ prompt: 'Build mobile', turnCount: 2, turnIndex: 1 }),
      expect.objectContaining({ prompt: 'Approve change', turnCount: 1, turnIndex: 0 }),
    ]);
  });

  test('keeps status filters readable and horizontally scrollable in a narrow list pane', async () => {
    const screen = await render(
      <AiSessionInbox state={{ controlPlaneId: 'cp-1', messages: {}, snapshot, sync: { phase: 'ready' } }} />,
    );

    expect(screen.getByTestId('session-status-filter-scroll').props.horizontal).toBe(true);
    expect(screen.getByTestId('session-status-filters').props.accessibilityRole).toBe('tablist');
    expect(StyleSheet.flatten(screen.getByTestId('session-status-filters').props.style).backgroundColor).toBe(mobileLightColors.workbenchSelectionBackground);
    expect(StyleSheet.flatten(screen.getByTestId('session-status-filter-all').props.style).backgroundColor).toBe(mobileLightColors.statusFilterSelectedBackground);
    expect(screen.getByText('Problem').props.numberOfLines).toBe(1);
    expect(StyleSheet.flatten(screen.getByTestId('session-status-filter-problem').props.style)).toEqual(expect.objectContaining({ flexGrow: 1, flexShrink: 0, minWidth: 44 }));
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

    expect(groupLabels('path')).toEqual([['mobile', 1], ['server', 1]]);
    expect(groupLabels('instance')).toEqual([['Phone', 1], ['Server', 1]]);
    expect(groupLabels('node')).toEqual([['Local Mac', 1], ['Build Node', 1]]);
    expect(groupLabels('agent')).toEqual([['Codex', 1], ['Open Code', 1]]);
  });

  test('prefers registered folder names and falls back to the final path segment', () => {
    const originalEntries = inboxEntries(snapshot);
    const entries = [
      { ...originalEntries[0], session: { ...originalEntries[0].session, cwd: '/work/mobile', cwdFolderId: 'folder-mobile' } },
      { ...originalEntries[1], instanceId: 'instance-2', session: { ...originalEntries[1].session, cwd: '/work/server' } },
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
    const folders = [{
      id: 'folder-mobile',
      name: 'Mobile App',
      nodeId: 'node-1',
      path: '/work/mobile',
      localizedNames: { 'zh-CN': '移动端项目' },
    }];
    const pathGroupLabels = aiSessionInboxRows(entries, directory, 'path', false, undefined, new Set(), folders, 'zh-CN')
      .filter((row) => row.type === 'group')
      .map((row) => row.label);

    expect(pathGroupLabels).toEqual(['移动端项目', 'server']);
  });

  test('omits a collapsed group’s sessions while keeping its header and count', () => {
    const entries = inboxEntries(snapshot);
    const directory = {
      instances: [{ id: 'instance-1', name: 'Phone', nodeId: 'node-1' }],
      nodes: [{ id: 'node-1', name: 'Local Mac' }],
    } as unknown as Pick<MobileDirectoryProfileState, 'nodes' | 'instances'>;
    const rows = aiSessionInboxRows(entries, directory, 'instance', false, undefined, new Set(['group:instance:instance-1']));

    expect(rows).toEqual([expect.objectContaining({
      collapsed: true,
      count: 2,
      key: 'group:instance:instance-1',
      label: 'Phone',
      type: 'group',
    })]);
  });

  test('keeps collapsed group children in section data for the height animation', () => {
    const directory = {
      instances: [{ id: 'instance-1', name: 'Phone', nodeId: 'node-1' }],
      nodes: [{ id: 'node-1', name: 'Local Mac' }],
    } as unknown as Pick<MobileDirectoryProfileState, 'nodes' | 'instances'>;
    const sections = aiSessionInboxSections(inboxEntries(snapshot), directory, 'instance', false, undefined, new Set(['group:instance:instance-1']));

    expect(sections).toEqual([expect.objectContaining({
      collapsed: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ instanceId: 'instance-1', session: expect.objectContaining({ id: 'running' }) }),
        expect.objectContaining({ instanceId: 'instance-1', session: expect.objectContaining({ id: 'approval' }) }),
      ]),
      key: 'group:instance:instance-1',
      type: 'group',
    })]);
  });

  test('collapses and expands groups from the list header', async () => {
    updateAiSessionInboxViewPreferences({ groupBy: 'instance' });
    const screen = await render(
      <AiSessionInbox directory={{ instances: [{ id: 'instance-1', nodeId: 'node-1', name: 'Phone' }], nodes: [{ id: 'node-1', name: 'Local Mac' }] } as unknown as MobileDirectoryProfileState} state={{ controlPlaneId: 'cp-1', messages: {}, snapshot, sync: { phase: 'ready' } }} />,
    );

    const header = screen.getByTestId('session-group-header');
    expect(header.props.accessibilityState).toEqual({ expanded: true });
    expect(screen.getAllByTestId('session-card')).toHaveLength(2);

    await act(async () => { fireEvent.press(header); });

    expect(screen.getByTestId('session-group-header').props.accessibilityState).toEqual({ expanded: false });
    expect(screen.queryAllByTestId('session-card')).toHaveLength(0);
    expect(screen.getByText('2')).toBeTruthy();

    await act(async () => { fireEvent.press(screen.getByTestId('session-group-header')); });

    expect(screen.getAllByTestId('session-card')).toHaveLength(2);
  });

  test('renders the persisted compact list layout with status, title, context, and time', async () => {
    updateAiSessionInboxViewPreferences({ layout: 'list' });
    const screen = await render(
      <AiSessionInbox state={{ controlPlaneId: 'cp-1', messages: {}, snapshot, sync: { phase: 'ready' } }} />,
    );

    const rows = screen.getAllByTestId('session-list-row');
    expect(rows).toHaveLength(2);
    expect(screen.queryAllByTestId('session-card')).toHaveLength(0);
    expect(StyleSheet.flatten(rows[0].props.style).minHeight).toBe(50);
    expect(within(rows[0]).getByText(/Approve change|Build mobile/)).toBeTruthy();
    expect(within(rows[0]).getByText(/instance-1 · Unknown workspace/)).toBeTruthy();
    expect(screen.getAllByTestId('session-status-leading')).toHaveLength(2);
  });

  test('aligns grouped list disclosure, status, path, and session title columns', async () => {
    updateAiSessionInboxViewPreferences({ groupBy: 'instance', layout: 'list' });
    const screen = await render(
      <AiSessionInbox state={{ controlPlaneId: 'cp-1', messages: {}, snapshot, sync: { phase: 'ready' } }} />,
    );

    const headerStyle = StyleSheet.flatten(screen.getByTestId('session-group-header').props.style);
    const disclosureStyle = StyleSheet.flatten(screen.getByTestId('session-group-disclosure').props.style);
    const rowStyle = StyleSheet.flatten(screen.getAllByTestId('session-list-row')[0].props.style);
    const statusStyle = StyleSheet.flatten(screen.getAllByTestId('session-status-leading')[0].props.style);
    const rowPaddingLeft = rowStyle.paddingLeft ?? rowStyle.paddingHorizontal;

    expect(headerStyle.paddingLeft + disclosureStyle.width / 2).toBe(rowPaddingLeft + statusStyle.width / 2);
    expect(headerStyle.paddingLeft + disclosureStyle.width + headerStyle.gap)
      .toBe(rowPaddingLeft + statusStyle.width + rowStyle.gap);
  });

  test('hides the idle dot in compact list rows without collapsing the status slot', async () => {
    updateAiSessionInboxViewPreferences({ layout: 'list' });
    const idleSnapshot = ControlPlaneAiSessionsSchema.parse({
      updatedAt: snapshot.updatedAt,
      instances: [{
        ...snapshot.instances[0],
        aiSessions: {
          ...snapshot.instances[0].aiSessions,
          sessions: [{ ...snapshot.instances[0].aiSessions.sessions[0], phase: 'unknown', status: 'idle' }],
        },
      }],
    });
    const screen = await render(
      <AiSessionInbox state={{ controlPlaneId: 'cp-1', messages: {}, snapshot: idleSnapshot, sync: { phase: 'ready' } }} />,
    );

    expect(screen.queryByTestId('session-status-dot')).toBeNull();
    expect(screen.queryByTestId('session-status-spinner')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('session-status-leading').props.style)).toEqual(expect.objectContaining({ height: 24, width: 20 }));
  });

  test('filters sessions through the normalized all, node, and instance scopes', () => {
    const instanceNodes = new Map([['instance-1', 'node-1']]);
    expect(inboxEntries(snapshot, { kind: 'node', nodeId: 'node-1' }, instanceNodes)).toHaveLength(2);
    expect(inboxEntries(snapshot, { kind: 'node', nodeId: 'node-2' }, instanceNodes)).toHaveLength(0);
    expect(inboxEntries(snapshot, { kind: 'instance', instanceId: 'instance-1' }, instanceNodes)).toHaveLength(2);
    expect(inboxEntries(snapshot, { kind: 'instance', instanceId: 'instance-2' }, instanceNodes)).toHaveLength(0);
  });

  test('derives expandable sub sessions and forces ancestor paths for child status matches', () => {
    const hierarchySnapshot = ControlPlaneAiSessionsSchema.parse({
      updatedAt: '2026-08-05T00:03:00.000Z',
      instances: [{
        instanceId: 'instance-1', streamId: 'stream-1', aiSessions: {
          updatedAt: '2026-08-05T00:03:00.000Z',
          sessions: [
            { id: 'parent', agent: 'codex', providerSessionId: 'provider-parent', status: 'idle', startedAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:01:00.000Z' },
            { id: 'child', agent: 'codex', providerSessionId: 'provider-child', lineage: { kind: 'subagent', parentProviderSessionId: 'provider-parent' }, status: 'waiting', startedAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:02:00.000Z' },
            { id: 'grandchild', agent: 'codex', providerSessionId: 'provider-grandchild', lineage: { kind: 'subagent', parentProviderSessionId: 'provider-child' }, status: 'running', startedAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:03:00.000Z' },
          ],
        },
      }],
    });

    expect(inboxHierarchyEntries(hierarchySnapshot).map((entry) => [entry.session.id, entry.depth, entry.hasChildren])).toEqual([
      ['parent', 0, true],
    ]);
    expect(inboxHierarchyEntries(hierarchySnapshot, { kind: 'all' }, new Map(), { expandedSessionIds: new Set(['parent', 'child']) }).map((entry) => [entry.session.id, entry.depth])).toEqual([
      ['parent', 0], ['child', 1], ['grandchild', 2],
    ]);
    expect(inboxHierarchyEntries(hierarchySnapshot, { kind: 'all' }, new Map(), { statusFilter: 'active' }).map((entry) => entry.session.id)).toEqual([
      'parent', 'child', 'grandchild',
    ]);
  });

  test('keeps orphan children and old-producer flat sessions visible at the top level', () => {
    const base = { agent: 'codex', status: 'idle' as const, startedAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:01:00.000Z' };
    const mobileSnapshot = ControlPlaneAiSessionsSchema.parse({
      updatedAt: base.updatedAt,
      instances: [{ instanceId: 'instance-1', streamId: 'stream-1', aiSessions: {
        updatedAt: base.updatedAt,
        sessions: [
          { ...base, id: 'orphan', providerSessionId: 'provider-orphan', lineage: { kind: 'subagent', parentProviderSessionId: 'missing-parent' } },
          { ...base, id: 'legacy-parent', providerSessionId: 'provider-parent' },
          { ...base, id: 'legacy-child', providerSessionId: 'provider-child' },
        ],
      } }],
    });

    expect(inboxHierarchyEntries(mobileSnapshot).map((entry) => [entry.session.id, entry.depth, entry.hasChildren])).toEqual([
      ['legacy-child', 0, false],
      ['orphan', 0, false],
      ['legacy-parent', 0, false],
    ]);
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
    expect(StyleSheet.flatten(screen.getByTestId('session-status-spinner').props.style).borderColor).toBe(mobileLightColors.sessionRunningTrack);
    expect(StyleSheet.flatten(screen.getByTestId('session-status-spinner-arc').props.style)).toEqual(expect.objectContaining({
      borderBottomColor: mobileLightColors.sessionRunningIndicator,
      borderLeftColor: mobileLightColors.sessionRunningIndicator,
      borderRightColor: mobileLightColors.sessionRunningIndicator,
      borderTopColor: 'transparent',
    }));

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
