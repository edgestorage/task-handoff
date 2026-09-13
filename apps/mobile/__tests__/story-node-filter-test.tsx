import { act, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { StoryNodeFilter } from '@task-handoff/control-plane-client';

import { StoryNodeFilterProvider, useStoryNodeFilter } from '../src/stories/use-story-node-filter';

let mockDirectory = {
  controlPlaneId: 'cp-1',
  state: { nodes: [{ id: 'node-a' }, { id: 'node-b' }, { id: 'node-c' }] },
};

jest.mock('../src/directories/use-directories', () => ({
  useActiveDirectories: () => mockDirectory,
}));

test('Story node filters are isolated by Control Plane and keep their setter stable', async () => {
  let setFilter: ((filter: StoryNodeFilter) => void) | undefined;
  let previousSetFilter: typeof setFilter;
  function Consumer() {
    const value = useStoryNodeFilter();
    previousSetFilter = setFilter;
    setFilter = value.setFilter;
    const { filter } = value;
    return <Text>{filter.kind === 'selected' ? filter.nodeIds.join(',') : filter.kind}</Text>;
  }

  const screen = await render(<StoryNodeFilterProvider><Consumer /></StoryNodeFilterProvider>);
  const firstSetFilter = setFilter;
  await act(async () => setFilter?.({ kind: 'selected', nodeIds: ['node-a'] }));
  await waitFor(() => screen.getByText('node-a'));
  expect(setFilter).toBe(firstSetFilter);

  mockDirectory = { ...mockDirectory, controlPlaneId: 'cp-2' };
  screen.rerender(<StoryNodeFilterProvider><Consumer /></StoryNodeFilterProvider>);
  await waitFor(() => screen.getByText('all'));
  await act(async () => setFilter?.({ kind: 'selected', nodeIds: ['node-b'] }));
  await waitFor(() => screen.getByText('node-b'));

  mockDirectory = { ...mockDirectory, controlPlaneId: 'cp-1' };
  screen.rerender(<StoryNodeFilterProvider><Consumer /></StoryNodeFilterProvider>);
  await waitFor(() => screen.getByText('node-a'));
  expect(previousSetFilter).not.toBe(setFilter);
});
