import { act, render } from '@testing-library/react-native';

import InboxLayout from '../app/(tabs)/(main)/inbox/_layout';
import { mobileLightColors } from '../src/components/theme';
import { getAiSessionInboxViewPreferences, updateAiSessionInboxViewPreferences } from '../src/ai-sessions/inbox-view-preferences';

const mockHeaderItems: Array<Record<string, unknown>> = [];

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
      mockHeaderItems.splice(0, mockHeaderItems.length, ...items);
      return React.createElement(Text, { testID: 'header-items' }, JSON.stringify(items.map((item) => ({
        sharesBackground: item.sharesBackground,
        spacing: item.spacing,
        tintColor: item.tintColor,
        type: item.type,
      }))));
    },
  };
});

describe('<InboxLayout />', () => {
  beforeEach(() => {
    mockHeaderItems.length = 0;
    updateAiSessionInboxViewPreferences({ collapsedGroupKeys: [], groupBy: 'none', layout: 'cards', sortByStatus: false });
  });

  test('keeps create and options as separate native header buttons', async () => {
    const screen = await render(<InboxLayout />);

    expect(screen.getByTestId('header-items').props.children).toBe(JSON.stringify([
      { sharesBackground: false, tintColor: mobileLightColors.primary, type: 'button' },
      { spacing: 8, tintColor: undefined, type: 'spacing' },
      { sharesBackground: false, tintColor: mobileLightColors.primary, type: 'menu' },
    ]));
  });

  test('exposes card and list layout choices in the native options menu', async () => {
    await render(<InboxLayout />);

    const options = mockHeaderItems.find((item) => item.type === 'menu') as {
      menu: { items: Array<{ items: Array<{ label: string; onPress(): void; state: string }>; label: string }> };
    };
    const layoutMenu = options.menu.items.find((item) => item.label === 'View');
    expect(layoutMenu?.items.map((item) => [item.label, item.state])).toEqual([['Cards', 'on'], ['List', 'off']]);

    await act(async () => { layoutMenu!.items.find((item) => item.label === 'List')!.onPress(); });

    expect(getAiSessionInboxViewPreferences().layout).toBe('list');
  });
});
