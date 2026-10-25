import { render } from '@testing-library/react-native';

import { PaneHeaderRestore } from '../src/master-detail/use-pane-header-restore';

const mockSetOptions = jest.fn();
const mockHeaderRight = () => null;
const mockHeaderRightItems = () => [];

jest.mock('expo-router', () => ({
  useNavigation: () => ({ setOptions: mockSetOptions }),
}));
jest.mock('../src/components/PrimaryTabStack', () => ({
  usePrimaryTabHeaderDefaults: () => ({
    headerRight: mockHeaderRight,
    headerRightItems: mockHeaderRightItems,
    title: 'AI Sessions',
  }),
}));

test('restores the tab header actions after a wide detail pane closes', async () => {
  const screen = await render(<PaneHeaderRestore pane />);

  expect(mockSetOptions).not.toHaveBeenCalled();
  await screen.rerender(<PaneHeaderRestore pane={false} />);

  expect(mockSetOptions).toHaveBeenCalledWith({
    headerRight: mockHeaderRight,
    unstable_headerRightItems: mockHeaderRightItems,
  });
});
