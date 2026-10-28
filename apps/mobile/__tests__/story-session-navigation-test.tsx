import { act, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { Story } from '@task-handoff/protocol/stories';

import StoriesRoute from '../app/(tabs)/(main)/stories/index';
import StoryDetailRoute from '../app/stories/[storyId]';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { resetDetailSelections, storyDetailSelection, storySessionDetailSelection } from '../src/master-detail/selection';

type MockInboxProps = {
  onOpen(story: Story): void;
  onOpenSession(story: Story, instanceId: string, sessionId: string): void;
};
type MockDetailProps = { onOpenSession(instanceId: string, sessionId: string): void };
type MockSessionProps = {
  instanceId: string;
  onClosed(): void;
  onOpenSession(instanceId: string, sessionId: string): void;
  sessionId: string;
};

const mockWide = { value: true };
const mockRouteParams = { current: {} as Record<string, string> };
const mockWideRoute = { select: undefined as undefined | (() => void) };
const mockInboxProps: { current?: MockInboxProps } = { current: undefined };
const mockDetailProps: { current?: MockDetailProps } = { current: undefined };
const mockSessionProps: { current?: MockSessionProps } = { current: undefined };

jest.mock('expo-router', () => ({
  router: { dismissTo: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => mockRouteParams.current,
  useNavigation: () => ({ setOptions: jest.fn() }),
}));

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => {
  const useMobileControlPlaneRuntime = jest.fn();
  return { useMobileControlPlaneRuntime, useOptionalMobileControlPlaneRuntime: useMobileControlPlaneRuntime };
});

jest.mock('../src/components/MasterDetailLayout', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    MasterDetailEmptyState: ({ message }: { message: string }) => React.createElement(Text, null, message),
    MasterDetailLayout: ({ detail, emptyDetail, list }: { detail?: React.ReactNode; emptyDetail?: React.ReactNode; list: React.ReactNode }) => React.createElement(
      View,
      null,
      list,
      mockWide.value ? detail ?? emptyDetail : null,
    ),
    useMasterDetailBack: () => undefined,
    useMasterDetailLayout: () => ({ wide: mockWide.value }),
  };
});

jest.mock('../src/master-detail/use-compact-detail-on-resize', () => ({ useCompactDetailOnResize: () => undefined }));

jest.mock('../src/master-detail/use-wide-detail-route', () => ({
  useWideDetailRoute: ({ select }: { select(): void }) => { mockWideRoute.select = select; },
}));

jest.mock('../src/stories/StoryInbox', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    StoryInbox: (props: MockInboxProps) => {
      mockInboxProps.current = props;
      return React.createElement(Text, null, 'Story inbox');
    },
  };
});

jest.mock('../src/stories/StoryDetail', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    StoryDetail: (props: MockDetailProps) => {
      mockDetailProps.current = props;
      return React.createElement(Text, null, 'Story detail');
    },
  };
});

jest.mock('../src/ai-sessions/AiSessionDetailScreen', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    AiSessionDetailScreen: (props: MockSessionProps) => {
      mockSessionProps.current = props;
      return React.createElement(Text, null, `Session detail ${props.instanceId}:${props.sessionId}`);
    },
  };
});

const mockRuntime = jest.mocked(useMobileControlPlaneRuntime);
const story: Story = {
  id: 'story-1',
  ownerNodeId: 'node-1',
  title: 'Story',
  actions: [],
  documents: [],
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  resetDetailSelections();
  mockWide.value = true;
  mockRouteParams.current = {};
  mockWideRoute.select = undefined;
  mockInboxProps.current = undefined;
  mockDetailProps.current = undefined;
  mockSessionProps.current = undefined;
  mockRuntime.mockReturnValue({ controlPlaneId: 'cp-1', storyCapability: true } as ReturnType<typeof useMobileControlPlaneRuntime>);
});

describe('Story session navigation', () => {
  test('opens a linked session in the Story detail pane on wide layouts', async () => {
    const screen = await render(<StoriesRoute />);

    await act(async () => { mockInboxProps.current?.onOpenSession(story, 'instance-1', 'session-1'); });

    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByText('Session detail instance-1:session-1')).toBeTruthy();
    expect(screen.queryByText('Story detail')).toBeNull();
    expect(storyDetailSelection.get()).toMatchObject({ storyId: 'story-1' });
    expect(storySessionDetailSelection.get()).toMatchObject({ instanceId: 'instance-1', sessionId: 'session-1' });

    await act(async () => { mockSessionProps.current?.onOpenSession('instance-2', 'session-2'); });
    expect(router.push).not.toHaveBeenCalled();
    expect(storySessionDetailSelection.get()).toMatchObject({ instanceId: 'instance-2', sessionId: 'session-2' });

    await act(async () => { mockSessionProps.current?.onClosed(); });
    expect(screen.getByText('Story detail')).toBeTruthy();
    expect(storySessionDetailSelection.get()).toBeUndefined();
  });

  test('opens a Story-detail session in the right pane without leaving the Story route', async () => {
    const screen = await render(<StoriesRoute />);
    await act(async () => { mockInboxProps.current?.onOpen(story); });
    expect(screen.getByText('Story detail')).toBeTruthy();

    await act(async () => { mockDetailProps.current?.onOpenSession('instance-1', 'session-1'); });

    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByText('Session detail instance-1:session-1')).toBeTruthy();
  });

  test('selecting another Story clears the session pane', async () => {
    const screen = await render(<StoriesRoute />);
    await act(async () => { mockInboxProps.current?.onOpenSession(story, 'instance-1', 'session-1'); });

    await act(async () => { mockInboxProps.current?.onOpen(story); });

    expect(screen.getByText('Story detail')).toBeTruthy();
    expect(storySessionDetailSelection.get()).toBeUndefined();
  });

  test('opens compact linked sessions through the standard AI session route', async () => {
    mockWide.value = false;
    const screen = await render(<StoriesRoute />);

    await act(async () => { mockInboxProps.current?.onOpenSession(story, 'instance-1', 'session-1'); });

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/sessions/[instanceId]/[sessionId]',
      params: { instanceId: 'instance-1', sessionId: 'session-1' },
    });
    expect(screen.queryByText('Session detail instance-1:session-1')).toBeNull();
    expect(storySessionDetailSelection.get()).toMatchObject({ instanceId: 'instance-1', sessionId: 'session-1' });
  });

  test('opens compact Story-detail sessions through the standard route', async () => {
    mockWide.value = false;
    mockRouteParams.current = { nodeId: 'node-1', storyId: 'story-1' };
    await render(<StoryDetailRoute />);
    await act(async () => { mockWideRoute.select?.(); });

    await act(async () => { mockDetailProps.current?.onOpenSession('instance-1', 'session-1'); });

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/sessions/[instanceId]/[sessionId]',
      params: { instanceId: 'instance-1', sessionId: 'session-1' },
    });
    expect(storyDetailSelection.get()).toMatchObject({ storyId: 'story-1' });
  });
});
