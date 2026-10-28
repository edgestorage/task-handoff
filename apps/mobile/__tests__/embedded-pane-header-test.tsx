import { render } from '@testing-library/react-native';

import { EmbeddedPaneHeaderOptions } from '../src/components/EmbeddedPaneHeader';

const mockSetOptions = jest.fn();
const headerRightItems = () => [{
  accessibilityLabel: 'More',
  icon: { name: 'ellipsis' as const, type: 'sfSymbol' as const },
  label: 'More',
  type: 'menu' as const,
  menu: { items: [], title: 'More' },
}];

jest.mock('expo-router', () => ({
  useNavigation: () => ({ setOptions: mockSetOptions }),
}));

beforeEach(() => {
  mockSetOptions.mockClear();
});

test('applies a dynamic title and header actions to the pane navigation', async () => {
  await render(<EmbeddedPaneHeaderOptions enabled headerRight="menu" headerRightItems={headerRightItems} title="Story title" />);

  expect(mockSetOptions).toHaveBeenCalledWith(expect.objectContaining({ title: 'Story title' }));
  const options = mockSetOptions.mock.calls.at(-1)?.[0];
  expect(options.headerRight()).toBe('menu');
  expect(options.unstable_headerRightItems()).toHaveLength(1);
});

test('clears inherited header actions when the pane becomes empty', async () => {
  await render(<EmbeddedPaneHeaderOptions enabled title="Story" />);

  expect(mockSetOptions).toHaveBeenCalledWith({
    headerRight: undefined,
    title: 'Story',
    unstable_headerRightItems: undefined,
  });
});
