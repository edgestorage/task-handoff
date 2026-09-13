import { render } from '@testing-library/react-native';

import NewStoryRoute from '../app/stories/new';
import { useActiveDirectories } from '../src/directories/use-directories';
import { useStoryNodeFilter } from '../src/stories/use-story-node-filter';

jest.mock('expo-router', () => ({ router: { replace: jest.fn() } }));
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: jest.fn() }));
jest.mock('../src/stories/use-story-node-filter', () => ({ useStoryNodeFilter: jest.fn() }));
jest.mock('../src/stories/StoryEditor', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text: NativeText } = jest.requireActual<typeof import('react-native')>('react-native');
  return { StoryEditor: ({ nodeId }: { nodeId?: string }) => React.createElement(NativeText, null, nodeId || 'no-node') };
});

const mockDirectories = jest.mocked(useActiveDirectories);
const mockNodeFilter = jest.mocked(useStoryNodeFilter);

test('new Story prefers an online node inside the current Story node filter', async () => {
  mockDirectories.mockReturnValue({ state: { nodes: [
    { id: 'node-a', name: 'Node A', status: 'online' },
    { id: 'node-b', name: 'Node B', status: 'online' },
  ] } } as unknown as ReturnType<typeof useActiveDirectories>);
  mockNodeFilter.mockReturnValue({ filter: { kind: 'selected', nodeIds: ['node-b'] }, setFilter: jest.fn() });

  const screen = await render(<NewStoryRoute />);

  expect(screen.getByText('node-b')).toBeTruthy();
  expect(screen.queryByText('node-a')).toBeNull();
});
