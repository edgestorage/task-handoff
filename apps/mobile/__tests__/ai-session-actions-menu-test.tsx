import { act, render, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { ControlPlaneAiSessionsSchema } from '@task-handoff/control-plane-client';

import { AiSessionActionsMenu } from '../src/ai-sessions/AiSessionActionsMenu';
import type { MobileAiSessionActionCoordinator } from '../src/ai-sessions/actions';
import type { MenuAction } from '../src/components/MenuView';

let menuActions: MenuAction[] = [];
let pressAction: (event: { nativeEvent: { event: string } }) => void = () => undefined;

jest.mock('@react-native-menu/menu', () => ({
  MenuView: ({ actions, children, onPressAction }: {
    actions: MenuAction[];
    children: React.ReactNode;
    onPressAction(event: { nativeEvent: { event: string } }): void;
  }) => {
    menuActions = actions;
    pressAction = onPressAction;
    return children;
  },
}));

function session(overrides: Record<string, unknown> = {}) {
  return ControlPlaneAiSessionsSchema.parse({
    updatedAt: '2026-11-25T00:00:00.000Z',
    instances: [{
      instanceId: 'instance-1',
      streamId: 'stream-1',
      aiSessions: {
        updatedAt: '2026-11-25T00:00:00.000Z',
        sessions: [{
          actions: { close: true, rename: true },
          agent: 'codex',
          id: 'session-1',
          phase: 'unknown',
          startedAt: '2026-11-25T00:00:00.000Z',
          status: 'idle',
          title: 'Build mobile',
          unread: false,
          updatedAt: '2026-11-25T00:00:00.000Z',
          ...overrides,
        }],
      },
    }],
  }).instances[0].aiSessions.sessions[0];
}

function coordinator() {
  return {
    close: jest.fn().mockResolvedValue({ disposition: 'accepted', result: {} }),
    markUnread: jest.fn().mockResolvedValue({ disposition: 'accepted', result: {} }),
    rename: jest.fn().mockResolvedValue({ disposition: 'accepted', result: {} }),
  } as unknown as MobileAiSessionActionCoordinator;
}

test('exposes the shared session actions from the long-press menu', async () => {
  const actions = coordinator();
  const onOpen = jest.fn();
  const screen = await render(<AiSessionActionsMenu actions={actions} instanceId="instance-1" onOpen={onOpen} session={session()}>
    <View testID="session-trigger" />
  </AiSessionActionsMenu>);

  expect(menuActions.map((action) => action.id)).toEqual(['open', 'mark-unread', 'rename', 'close']);

  await act(async () => {
    pressAction({ nativeEvent: { event: 'open' } });
    pressAction({ nativeEvent: { event: 'mark-unread' } });
    await waitFor(() => expect(actions.markUnread).toHaveBeenCalledWith('instance-1', 'session-1'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  expect(onOpen).toHaveBeenCalledTimes(1);
});
test('hides mark-unread for an unread session and respects close capability', async () => {
  const actions = coordinator();
  const screen = await render(<AiSessionActionsMenu actions={actions} instanceId="instance-1" session={session({ actions: { close: false, rename: false }, unread: true })}>
    <View testID="session-trigger" />
  </AiSessionActionsMenu>);

  expect(menuActions.map((action) => action.id)).toEqual([]);
  await screen.rerender(<AiSessionActionsMenu actions={actions} instanceId="instance-1" session={session({ actions: { close: false, rename: false }, unread: false })}>
    <View testID="session-trigger" />
  </AiSessionActionsMenu>);
  expect(menuActions.map((action) => action.id)).toEqual(['mark-unread']);
});
