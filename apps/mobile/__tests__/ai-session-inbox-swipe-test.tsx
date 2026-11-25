import { act, render, waitFor } from '@testing-library/react-native';
import { ControlPlaneAiSessionsSchema } from '@task-handoff/control-plane-client';

import { AiSessionInbox } from '../src/ai-sessions/Inbox';
import type { MobileAiSessionActionCoordinator } from '../src/ai-sessions/actions';
import { updateAiSessionInboxViewPreferences } from '../src/ai-sessions/inbox-view-preferences';
import type { SwipeAction } from '../src/components/SwipeActionList.types';

const mockRenderedSwipeActions: SwipeAction[][] = [];

jest.mock('@react-native-menu/menu', () => ({
  MenuView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/components/SwipeActions', () => ({
  SwipeActions: ({ actions, children }: { actions: SwipeAction[]; children: React.ReactNode }) => {
    mockRenderedSwipeActions.push(actions);
    return children;
  },
}));

const snapshot = ControlPlaneAiSessionsSchema.parse({
  updatedAt: '2026-11-25T00:00:00.000Z',
  instances: [{
    instanceId: 'instance-1',
    streamId: 'stream-1',
    aiSessions: {
      updatedAt: '2026-11-25T00:00:00.000Z',
      sessions: [
        { id: 'read', agent: 'codex', status: 'idle', phase: 'unknown', title: 'Read', startedAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:00.000Z', unread: false },
        { id: 'unread', agent: 'codex', status: 'idle', phase: 'unknown', title: 'Unread', startedAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:01:00.000Z', unread: true },
      ],
    },
  }],
});
beforeEach(() => {
  mockRenderedSwipeActions.length = 0;
  updateAiSessionInboxViewPreferences({
    collapsedGroupKeys: [],
    groupBy: 'none',
    layout: 'cards',
    sortByStatus: false,
  });
});

test('exposes mark-unread and close on left swipe for a read session', async () => {
  const actions = { markUnread: jest.fn().mockResolvedValue({ disposition: 'accepted', result: {} }) } as unknown as MobileAiSessionActionCoordinator;
  const screen = await render(<AiSessionInbox actions={actions} state={{ controlPlaneId: 'cp-1', messages: {}, snapshot, sync: { phase: 'ready' } }} />);
  const readActions = mockRenderedSwipeActions.find((actions) => actions.some((action) => action.label === 'Mark as unread'))!;
  const unreadActions = mockRenderedSwipeActions.find((actions) => actions.every((action) => action.label !== 'Mark as unread'))!;

  expect(readActions.map((action: { label: string }) => action.label)).toEqual(['Mark as unread', 'Close']);
  expect(unreadActions.map((action: { label: string }) => action.label)).toEqual(['Close']);

  await act(async () => {
    readActions[0].onPress();
    await waitFor(() => expect(actions.markUnread).toHaveBeenCalledWith('instance-1', 'read'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

test('uses long-press actions without swipe actions in list layout', async () => {
  updateAiSessionInboxViewPreferences({
    collapsedGroupKeys: [],
    groupBy: 'none',
    layout: 'list',
    sortByStatus: false,
  });
  const actions = { markUnread: jest.fn() } as unknown as MobileAiSessionActionCoordinator;

  const screen = await render(<AiSessionInbox actions={actions} state={{ controlPlaneId: 'cp-1', messages: {}, snapshot, sync: { phase: 'ready' } }} />);

  await waitFor(() => expect(screen.getAllByTestId('session-list-row')).toHaveLength(2));
  expect(mockRenderedSwipeActions).toHaveLength(0);
});
