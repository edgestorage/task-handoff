import { render } from '@testing-library/react-native';

import InboxLayout from '../app/(tabs)/(main)/inbox/_layout';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@expo/ui/community/menu', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return { MenuView: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children) };
});
jest.mock('../src/instance-scope/use-instance-scope', () => ({
  useInstanceScope: () => ({ scope: { kind: 'all' } }),
}));
jest.mock('../src/components/PrimaryTabStack', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    PrimaryTabStack: ({ headerRightItems }: { headerRightItems: () => Array<Record<string, unknown>> }) => {
      const items = headerRightItems();
      return React.createElement(Text, { testID: 'header-items' }, JSON.stringify(items.map((item) => ({
        sharesBackground: item.sharesBackground,
        spacing: item.spacing,
        type: item.type,
      }))));
    },
  };
});

describe('<InboxLayout />', () => {
  test('keeps create and options as separate native header buttons', async () => {
    const screen = await render(<InboxLayout />);

    expect(screen.getByTestId('header-items').props.children).toBe(JSON.stringify([
      { sharesBackground: false, type: 'button' },
      { spacing: 8, type: 'spacing' },
      { sharesBackground: false, type: 'menu' },
    ]));
  });
});
