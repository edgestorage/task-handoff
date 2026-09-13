import { fireEvent, render, waitFor } from '@testing-library/react-native';

import StoriesLayout from '../app/(tabs)/(main)/stories/_layout';
import StoriesRoute from '../app/(tabs)/(main)/stories/index';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { updateStoryViewPreferences } from '../src/stories/story-view-preferences';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({
  useMobileControlPlaneRuntime: jest.fn(),
}));

jest.mock('../src/stories/StoryInbox', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { StoryInbox: () => React.createElement(Text, null, 'Story inbox') };
});

jest.mock('../src/stories/StoryNodeFilterHeaderButton', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { StoryNodeFilterHeaderButton: () => React.createElement(Text, null, 'Story node scope') };
});

jest.mock('../src/components/PrimaryTabStack', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  type MockMenuEntry = { items?: MockMenuEntry[]; label?: string; multiselectable?: boolean; onPress?: () => void; state?: string; type: string };
  const actions = (items: MockMenuEntry[]): MockMenuEntry[] => items.flatMap((item) => item.items ? actions(item.items) : [item]);
  return { PrimaryTabStack: ({ headerRightItems, onAdd, scopeControl }: { headerRightItems?: () => { menu?: { items: MockMenuEntry[]; multiselectable?: boolean }; type: string }[]; onAdd?: () => void; scopeControl?: React.ReactNode }) => {
    const menu = headerRightItems?.().find((item) => item.type === 'menu')?.menu;
    return React.createElement(React.Fragment, null,
      React.createElement(Text, null, onAdd ? 'Story add enabled' : 'Story add disabled'),
      scopeControl,
      menu ? React.createElement(Text, { testID: 'native-menu-shape' }, JSON.stringify({ multiselectable: menu.multiselectable, submenus: menu.items.map((item) => ({ multiselectable: item.multiselectable, type: item.type })) })) : null,
      ...actions(menu?.items ?? []).map((action) => React.createElement(Pressable, { accessibilityLabel: `native-${action.label}`, key: action.label, onPress: action.onPress }, React.createElement(Text, null, `${action.label}:${action.state}`))),
    );
  } };
});

const mockRuntime = jest.mocked(useMobileControlPlaneRuntime);

beforeEach(() => {
  updateStoryViewPreferences({ manualKeys: [], sortMode: 'name', viewMode: 'compact' });
});

describe('<StoriesRoute />', () => {
  test('renders a stable unsupported page when the Control Plane lacks Story capability', async () => {
    mockRuntime.mockReturnValue({ storyCapability: false } as ReturnType<typeof useMobileControlPlaneRuntime>);
    const screen = await render(<StoriesRoute />);

    expect(screen.getByText('Stories are not supported by the current Control Plane.')).toBeTruthy();
    expect(screen.queryByText('Story inbox')).toBeNull();
  });

  test('renders the Story inbox when supported', async () => {
    mockRuntime.mockReturnValue({ storyCapability: true } as ReturnType<typeof useMobileControlPlaneRuntime>);
    const screen = await render(<StoriesRoute />);

    expect(screen.getByText('Story inbox')).toBeTruthy();
    expect(screen.queryByText('Stories are not supported by the current Control Plane.')).toBeNull();
  });
});

describe('<StoriesLayout />', () => {
  test('does not offer Story creation when the capability is unavailable', async () => {
    mockRuntime.mockReturnValue({ storyCapability: false } as ReturnType<typeof useMobileControlPlaneRuntime>);
    const screen = await render(<StoriesLayout />);

    expect(screen.getByText('Story add disabled')).toBeTruthy();
  });

  test('offers Story creation when the capability is available', async () => {
    mockRuntime.mockReturnValue({ storyCapability: true } as ReturnType<typeof useMobileControlPlaneRuntime>);
    const screen = await render(<StoriesLayout />);

    expect(screen.getByText('Story add enabled')).toBeTruthy();
    expect(screen.getByText('Story node scope')).toBeTruthy();
  });

  test('updates the native sort checkmark after one selection', async () => {
    mockRuntime.mockReturnValue({ storyCapability: true } as ReturnType<typeof useMobileControlPlaneRuntime>);
    const screen = await render(<StoriesLayout />);

    expect(JSON.parse(screen.getByTestId('native-menu-shape').props.children)).toEqual({
      multiselectable: true,
      submenus: [{ type: 'submenu' }, { type: 'submenu' }],
    });
    await fireEvent.press(screen.getByLabelText('native-Last AI Session'));

    await waitFor(() => expect(screen.getByText('Last AI Session:on')).toBeTruthy());
    expect(screen.getByText('Name:off')).toBeTruthy();
  });
});
