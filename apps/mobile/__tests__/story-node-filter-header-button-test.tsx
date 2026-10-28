import { fireEvent, render } from '@testing-library/react-native';

import { StoryNodeFilterHeaderButton } from '../src/stories/StoryNodeFilterHeaderButton';

jest.mock('../src/directories/use-directories', () => ({
  useActiveDirectories: () => ({ state: { instances: [], nodes: [] } }),
}));
jest.mock('../src/instance-scope/use-open-instance-drawer', () => ({
  useOpenInstanceDrawer: () => jest.fn(),
}));
jest.mock('../src/stories/use-story-node-filter', () => ({
  useStoryNodeFilter: () => ({ filter: { kind: 'all' }, setFilter: jest.fn() }),
}));

test('keeps the node scope button actionable while the node list is empty', async () => {
  const onPress = jest.fn();
  const screen = await render(<StoryNodeFilterHeaderButton onPress={onPress} />);

  expect(screen.getByText('All Nodes')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button'));
  expect(onPress).toHaveBeenCalledTimes(1);
});
