import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ControlPlaneAiSessionsSchema } from '@task-handoff/control-plane-client';
import type { Story } from '@task-handoff/protocol/stories';

import { StoryInbox } from '../src/stories/StoryInbox';
import { useActiveAiSessionsSnapshot } from '../src/ai-sessions/use-active-sessions';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../src/directories/use-directories';

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: jest.fn() }));
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: jest.fn() }));
jest.mock('../src/ai-sessions/use-active-sessions', () => ({ useActiveAiSessionsRuntime: () => ({}), useActiveAiSessionsSnapshot: jest.fn() }));
jest.mock('@expo/ui/community/menu', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { MenuView: ({ actions, children, onPressAction }: { actions: { id: string; title: string }[]; children: React.ReactNode; onPressAction(event: { nativeEvent: { event: string } }): void }) => React.createElement(
    React.Fragment,
    null,
    children,
    ...actions.map((action) => React.createElement(Pressable, {
      accessibilityLabel: `menu-${action.id}`,
      key: action.id,
      onPress: () => onPressAction({ nativeEvent: { event: action.id } }),
    }, React.createElement(Text, null, action.title))),
  ) };
});
jest.mock('../src/ai-sessions/SessionStatusIndicator', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SessionStatusIndicator: () => React.createElement(View, { testID: 'session-status' }) };
});

const mockRuntime = jest.mocked(useMobileControlPlaneRuntime);
const mockDirectories = jest.mocked(useActiveDirectories);
const mockSessions = jest.mocked(useActiveAiSessionsSnapshot);

describe('<StoryInbox />', () => {
  test('shows an unavailable error in a compact empty state when nodes cannot return Stories', async () => {
    mockRuntime.mockReturnValue({ api: { stories: { list: jest.fn().mockResolvedValue({ stories: [], unavailableNodeIds: ['node-a'] }) } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);
    mockDirectories.mockReturnValue({ state: { nodes: [{ id: 'node-a', name: 'Node A' }], instances: [] } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockSessions.mockReturnValue(ControlPlaneAiSessionsSchema.parse({ updatedAt: '2026-09-04T00:00:00.000Z', instances: [] }));

    const screen = await render(<StoryInbox onEdit={jest.fn()} onNewSession={jest.fn()} onOpen={jest.fn()} onOpenDocument={jest.fn()} onOpenSession={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Stories could not be loaded.')).toBeTruthy());
    expect(screen.queryByText('No Stories yet.')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('story-list').props.contentContainerStyle).flexGrow).toBeUndefined();
    await screen.unmount();
  });

  test('expands a Story into document and node-scoped AI Session rows', async () => {
    const story: Story = {
      id: 'story-1', ownerNodeId: 'node-a', title: 'Alpha', actions: [],
      documents: [{ title: 'Plan', storyPath: 'plan.md', revision: 'r1' }],
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    };
    mockRuntime.mockReturnValue({ api: { stories: { list: jest.fn().mockResolvedValue({ stories: [story], unavailableNodeIds: [] }) } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);
    mockDirectories.mockReturnValue({ state: {
      nodes: [{ id: 'node-a', name: 'Node A' }],
      instances: [{ id: 'instance-a', nodeId: 'node-a', name: 'Instance A' }],
    } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockSessions.mockReturnValue(ControlPlaneAiSessionsSchema.parse({
      updatedAt: '2026-09-04T00:00:00.000Z',
      instances: [{ instanceId: 'instance-a', streamId: 'stream-a', aiSessions: {
        updatedAt: '2026-09-04T00:00:00.000Z',
        sessions: [{ id: 'session-a', agent: 'codex', storyId: 'story-1', title: 'Build it', status: 'idle', startedAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z', unread: false }],
      } }],
    }));
    const onOpen = jest.fn();
    const onOpenDocument = jest.fn();
    const onOpenSession = jest.fn();
    const screen = await render(<StoryInbox onEdit={jest.fn()} onNewSession={jest.fn()} onOpen={onOpen} onOpenDocument={onOpenDocument} onOpenSession={onOpenSession} />);

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.queryByText('Plan')).toBeNull();
    expect(screen.queryByText('Build it')).toBeNull();

    await fireEvent.press(screen.getByLabelText('Expand Alpha'));
    await waitFor(() => expect(screen.getByText('Plan')).toBeTruthy());
    expect(screen.queryByTestId('session-status')).toBeNull();
    await fireEvent.press(screen.getByText('Plan'));
    await fireEvent.press(screen.getByText('Build it'));
    await fireEvent.press(screen.getByText('Alpha'));

    expect(onOpenDocument).toHaveBeenCalledWith(story, story.documents[0]);
    expect(onOpenSession).toHaveBeenCalledWith('instance-a', 'session-a');
    expect(onOpen).toHaveBeenCalledWith(story);
    await screen.unmount();
  });

  test('starts a Story session with the latest linked session instance and folder', async () => {
    const story: Story = {
      id: 'story-1', ownerNodeId: 'node-a', title: 'Alpha', actions: [], documents: [],
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    };
    mockRuntime.mockReturnValue({ api: { stories: { list: jest.fn().mockResolvedValue({ stories: [story], unavailableNodeIds: [] }) } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);
    mockDirectories.mockReturnValue({ state: {
      nodes: [{ id: 'node-a', name: 'Node A' }],
      instances: [
        { id: 'instance-a', nodeId: 'node-a', name: 'Instance A', ready: true },
        { id: 'instance-b', nodeId: 'node-a', name: 'Instance B', ready: true },
      ],
    } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockSessions.mockReturnValue(ControlPlaneAiSessionsSchema.parse({
      updatedAt: '2026-09-04T00:03:00.000Z',
      instances: [
        { instanceId: 'instance-a', streamId: 'stream-a', aiSessions: { updatedAt: '2026-09-04T00:01:00.000Z', sessions: [
          { id: 'older', agent: 'codex', storyId: 'story-1', status: 'idle', cwd: '/workspace/old', cwdFolderId: 'folder-old', startedAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:01:00.000Z', unread: false },
        ] } },
        { instanceId: 'instance-b', streamId: 'stream-b', aiSessions: { updatedAt: '2026-09-04T00:02:00.000Z', sessions: [
          { id: 'latest', agent: 'codex', storyId: 'story-1', status: 'idle', cwd: '/workspace/latest', cwdFolderId: 'folder-latest', startedAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:02:00.000Z', unread: false },
        ] } },
      ],
    }));
    const onNewSession = jest.fn();
    const screen = await render(<StoryInbox onEdit={jest.fn()} onNewSession={onNewSession} onOpen={jest.fn()} onOpenDocument={jest.fn()} onOpenSession={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('menu-new-session'));

    expect(onNewSession).toHaveBeenCalledWith(story, {
      instanceId: 'instance-b',
      cwd: '/workspace/latest',
      cwdFolderId: 'folder-latest',
    });
    await screen.unmount();
  });

  test('exposes Story shortcuts for existing sessions, actions, and automations', async () => {
    const story: Story = {
      id: 'story-1', ownerNodeId: 'node-a', title: 'Alpha', actions: [], documents: [],
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    };
    mockRuntime.mockReturnValue({ api: { stories: { list: jest.fn().mockResolvedValue({ stories: [story], unavailableNodeIds: [] }) } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);
    mockDirectories.mockReturnValue({ state: { nodes: [{ id: 'node-a', name: 'Node A' }], instances: [{ id: 'instance-a', nodeId: 'node-a', name: 'Instance A' }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockSessions.mockReturnValue(ControlPlaneAiSessionsSchema.parse({
      updatedAt: '2026-09-04T00:00:00.000Z', instances: [{ instanceId: 'instance-a', streamId: 'stream-a', aiSessions: {
        updatedAt: '2026-09-04T00:00:00.000Z', sessions: [{ id: 'session-a', agent: 'codex', status: 'idle', startedAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z', unread: false }],
      } }],
    }));
    const onAddExisting = jest.fn();
    const onAddAction = jest.fn();
    const onAddAutomation = jest.fn();
    const screen = await render(<StoryInbox onAddAction={onAddAction} onAddAutomation={onAddAutomation} onAddExisting={onAddExisting} onEdit={jest.fn()} onNewSession={jest.fn()} onOpen={jest.fn()} onOpenDocument={jest.fn()} onOpenSession={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('menu-add-existing'));
    await fireEvent.press(screen.getByLabelText('menu-add-action'));
    await fireEvent.press(screen.getByLabelText('menu-add-automation'));

    expect(onAddExisting).toHaveBeenCalledWith(story);
    expect(onAddAction).toHaveBeenCalledWith(story);
    expect(onAddAutomation).toHaveBeenCalledWith(story);
    await screen.unmount();
  });
});
