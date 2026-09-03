import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ControlPlaneAiSessionsSchema } from '@task-handoff/control-plane-client';
import type { Story } from '@task-handoff/protocol/stories';

import { StoryInbox } from '../src/stories/StoryInbox';
import { useActiveAiSessionsSnapshot } from '../src/ai-sessions/use-active-sessions';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../src/directories/use-directories';

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: jest.fn() }));
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: jest.fn() }));
jest.mock('../src/ai-sessions/use-active-sessions', () => ({ useActiveAiSessionsSnapshot: jest.fn() }));
jest.mock('../src/ai-sessions/SessionStatusIndicator', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SessionStatusIndicator: () => React.createElement(View, { testID: 'session-status' }) };
});

const mockRuntime = jest.mocked(useMobileControlPlaneRuntime);
const mockDirectories = jest.mocked(useActiveDirectories);
const mockSessions = jest.mocked(useActiveAiSessionsSnapshot);

describe('<StoryInbox />', () => {
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
    const screen = await render(<StoryInbox onOpen={onOpen} onOpenDocument={onOpenDocument} onOpenSession={onOpenSession} />);

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.queryByText('Plan')).toBeNull();
    expect(screen.queryByText('Build it')).toBeNull();

    await fireEvent.press(screen.getByLabelText('Expand Alpha'));
    await waitFor(() => expect(screen.getByText('Plan')).toBeTruthy());
    await fireEvent.press(screen.getByText('Plan'));
    await fireEvent.press(screen.getByText('Build it'));
    await fireEvent.press(screen.getByText('Alpha'));

    expect(onOpenDocument).toHaveBeenCalledWith(story, story.documents[0]);
    expect(onOpenSession).toHaveBeenCalledWith('instance-a', 'session-a');
    expect(onOpen).toHaveBeenCalledWith(story);
    await screen.unmount();
  });
});
